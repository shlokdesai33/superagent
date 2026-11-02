import { type GitHubApi, GitHubError } from './github.ts';
import { MARKER, parseGitHubThread, signOff } from './github-threads.ts';
import { redact } from './secrets.ts';
import {
	type Daemon,
	MESSAGE_COLUMNS,
	type MessageRow,
	cut,
	health,
	toMessage,
} from './state.ts';

const MAX_ATTEMPTS = 10;
const MAX_BACKOFF_MS = 10 * 60_000;
const QUOTE_LINES = 5;
const QUOTE_CHARS = 300;
// GitHub answers these for a comment that can never be posted.
const PERMANENT = new Set([404, 410, 422]);

type Pending = {
	id: number;
	at: number;
	threadId: string;
	text: string;
	attempts: number;
	replyTo: number | null;
	handle: string | null;
};

export type Delivery = {
	/** Look for pending GitHub replies now. */
	wake: () => void;
	stop: () => Promise<void>;
};

/**
 * Posts the Router's GitHub replies, oldest first, one at a time, while
 * GitHub is up. Each body ends with the sign-off and the hidden marker. A
 * reply that may already have been posted (it was attempted before) is
 * looked for by its marker first, so a crash mid-request never posts twice.
 */
export function startDelivery(
	daemon: Daemon,
	api: GitHubApi,
	/** The first retry's wait, doubling to 10 minutes. */
	retryMs: number,
): Delivery {
	const notBefore = new Map<number, number>();
	const stopping = new AbortController();
	let wakeUp: (() => void) | null = null;
	let timer: Timer | null = null;

	const wake = () => {
		const resolve = wakeUp;
		wakeUp = null;
		resolve?.();
	};

	const drain = async () => {
		while (!stopping.signal.aborted && daemon.github.state === 'up') {
			const pending = nextPending(daemon, notBefore);
			if (pending === null) return;
			// oxlint-disable-next-line eslint/no-await-in-loop
			await deliver(pending);
		}
	};

	const deliver = async (message: Pending) => {
		const thread = parseGitHubThread(message.threadId);
		if (thread === null) {
			fail(message, `${message.threadId} isn't a GitHub thread`);
			return;
		}
		const target = replyTarget(daemon, message);
		try {
			if (message.attempts > 0) {
				const posted = await findPosted(api, thread, target, message);
				if (posted !== null) {
					delivered(message, posted);
					return;
				}
			}
			daemon.db
				.query<unknown, [number]>(
					'UPDATE messages SET attempts = attempts + 1 WHERE id = ?',
				)
				.run(message.id);
			const response = await api.request(
				'POST',
				target.kind === 'review'
					? `/repos/${thread.repo}/pulls/${thread.number}/comments/${target.id}/replies`
					: `/repos/${thread.repo}/issues/${thread.number}/comments`,
				{ body: { body: githubBody(daemon, message, target) } },
			);
			delivered(message, idOf(response.body));
		} catch (error) {
			if (!(error instanceof GitHubError)) throw error;
			const attempts = message.attempts + 1;
			if (
				(error.status !== null && PERMANENT.has(error.status)) ||
				attempts >= MAX_ATTEMPTS
			) {
				fail(message, error.message);
				return;
			}
			// A rejected token or a rate limit waits for GitHub; anything else backs off.
			notBefore.set(
				message.id,
				Date.now() + Math.min(retryMs * 2 ** (attempts - 1), MAX_BACKOFF_MS),
			);
			daemon.log('warn', 'github reply not delivered yet', {
				message: message.id,
				thread: message.threadId,
				attempts,
				error: error.message,
			});
		}
	};

	const delivered = (message: Pending, externalId: string | null) => {
		notBefore.delete(message.id);
		daemon.db
			.query<unknown, [string | null, number]>(
				`UPDATE messages SET delivery = 'delivered', external_id = ?, delivery_error = NULL
				WHERE id = ?`,
			)
			.run(externalId, message.id);
		daemon.log('info', 'github reply delivered', {
			message: message.id,
			thread: message.threadId,
			comment: externalId,
		});
		publishMessage(daemon, message.id);
	};

	const fail = (message: Pending, reason: string) => {
		notBefore.delete(message.id);
		daemon.db
			.query<unknown, [string, number]>(
				"UPDATE messages SET delivery = 'failed', delivery_error = ? WHERE id = ?",
			)
			.run(reason, message.id);
		daemon.log('warn', 'github reply failed', {
			message: message.id,
			thread: message.threadId,
			error: reason,
		});
		publishMessage(daemon, message.id);
		daemon.feed.publish({ type: 'health', health: health(daemon) });
	};

	const loop = (async () => {
		while (!stopping.signal.aborted) {
			// oxlint-disable-next-line eslint/no-await-in-loop
			await drain();
			if (stopping.signal.aborted) break;
			const next = Math.min(...notBefore.values());
			// oxlint-disable-next-line eslint/no-await-in-loop
			await new Promise<void>((resolve) => {
				wakeUp = resolve;
				if (Number.isFinite(next)) {
					timer = setTimeout(wake, Math.max(0, next - Date.now()));
				}
			});
			if (timer) clearTimeout(timer);
			timer = null;
		}
	})();

	return {
		wake: () => {
			// After the caller's transaction commits.
			setTimeout(wake, 0);
		},
		stop: async () => {
			stopping.abort();
			wake();
			await loop;
		},
	};
}

function nextPending(
	daemon: Daemon,
	notBefore: Map<number, number>,
): Pending | null {
	const now = Date.now();
	const rows = daemon.db
		.query<Pending, []>(
			`SELECT m.id, m.at, m.thread_id AS threadId, m.text, m.attempts,
				m.reply_to AS replyTo, t.handle
			FROM messages m LEFT JOIN tasks t ON t.id = m.task_id
			WHERE m.channel = 'github' AND m.direction = 'out' AND m.delivery = 'pending'
			ORDER BY m.id`,
		)
		.all();
	return rows.find((row) => (notBefore.get(row.id) ?? 0) <= now) ?? null;
}

type Target =
	| { kind: 'issue' }
	| { kind: 'review'; id: string }
	| { kind: 'quote'; author: string; text: string };

/** Where a reply goes: a review comment's thread, or the conversation, quoting what it answers. */
function replyTarget(daemon: Daemon, message: Pending): Target {
	if (message.replyTo === null) return { kind: 'issue' };
	const event = daemon.db
		.query<{ author: string; text: string; data: string | null }, [number]>(
			'SELECT author, text, data FROM events WHERE id = ?',
		)
		.get(message.replyTo);
	if (!event) return { kind: 'issue' };
	const data: unknown = event.data === null ? null : JSON.parse(event.data);
	const review =
		typeof data === 'object' && data !== null && 'reviewComment' in data
			? data.reviewComment
			: null;
	if (typeof review === 'number' || typeof review === 'string') {
		return { kind: 'review', id: String(review) };
	}
	return { kind: 'quote', author: event.author, text: event.text };
}

/** The comment as posted: the reply, the sign-off and the marker that marks it as the agent's. */
export function githubBody(
	daemon: Daemon,
	message: { id: number; text: string; handle: string | null },
	target: Target,
): string {
	const parts: string[] = [];
	if (target.kind === 'quote') {
		const lines = cut(target.text, QUOTE_CHARS)
			.split('\n')
			.slice(0, QUOTE_LINES)
			.map((line) => `> ${line}`);
		parts.push(`> **@${target.author}**:\n${lines.join('\n')}`);
	}
	parts.push(redact(daemon.secrets, message.text));
	parts.push(signOff(daemon, message.handle, `m${message.id}`));
	return parts.join('\n\n');
}

/** The ID of a comment already posted for this message, found by its marker. */
async function findPosted(
	api: GitHubApi,
	thread: { repo: string; number: number },
	target: Target,
	message: Pending,
): Promise<string | null> {
	// A minute of slack for clocks; the marker makes the match exact.
	const since = new Date(message.at - 60_000).toISOString();
	const listing =
		target.kind === 'review'
			? `/repos/${thread.repo}/pulls/${thread.number}/comments`
			: `/repos/${thread.repo}/issues/${thread.number}/comments`;
	const { items } = await api.pages(
		`${listing}?since=${encodeURIComponent(since)}&per_page=100`,
	);
	const marker = `${MARKER}m${message.id} -->`;
	for (const item of items) {
		if (
			typeof item === 'object' &&
			item !== null &&
			'body' in item &&
			typeof item.body === 'string' &&
			item.body.includes(marker)
		) {
			return idOf(item);
		}
	}
	return null;
}

function idOf(value: unknown): string | null {
	if (typeof value !== 'object' || value === null || !('id' in value)) {
		return null;
	}
	return typeof value.id === 'number' || typeof value.id === 'string'
		? String(value.id)
		: null;
}

function publishMessage(daemon: Daemon, id: number): void {
	const row = daemon.db
		.query<MessageRow, [number]>(`SELECT ${MESSAGE_COLUMNS} WHERE m.id = ?`)
		.get(id);
	if (row) daemon.feed.publish({ type: 'message', message: toMessage(row) });
}
