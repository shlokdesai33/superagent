import type { Database } from 'bun:sqlite';
import { type GitHubApi, GitHubError, githubOff } from './github.ts';
import { ingest } from './ingest.ts';
import { redact } from './secrets.ts';
import { type Daemon, type Params, cut } from './state.ts';

const THREAD_ID = /^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9][0-9]*)$/;
/** Ends every comment the agent posts; it's how its own comments are recognized. */
export const MARKER = '<!-- superagent ';
const MAX_FOLLOWED = 20;
const INTRO_COMMENTS = 10;
const INTRO_CHARS = 2_000;

export function parseGitHubThread(
	id: string,
): { repo: string; number: number } | null {
	const match = id.match(THREAD_ID);
	return match?.[1] && match[2]
		? { repo: match[1], number: Number(match[2]) }
		: null;
}

/**
 * Makes a `github:owner/name#42` thread usable by a task: on a configured
 * repository, with its row created if it's new. Synchronous, so it runs
 * inside the Router tool's transaction. Returns the thread's ID as stored.
 */
export function prepareGitHubThread(
	daemon: Daemon,
	id: string,
): { ok: true; id: string } | { ok: false; error: string } {
	const off = githubOff(daemon);
	if (off !== null) return { ok: false, error: off };
	const parsed = parseGitHubThread(id);
	if (parsed === null) {
		return {
			ok: false,
			error: `${JSON.stringify(id)} isn't a GitHub thread; use github:owner/name#42`,
		};
	}
	const { repos } = daemon.github;
	const repo = repos.find(
		(entry) => entry.fullName.toLowerCase() === parsed.repo.toLowerCase(),
	);
	if (!repo) {
		return {
			ok: false,
			error:
				repos.length === 0
					? daemon.github.state === 'connecting'
						? 'GitHub is still connecting; try again in a minute'
						: 'no configured repository is on GitHub'
					: `${parsed.repo} isn't a configured repository; use one of ${repos.map((entry) => entry.fullName).join(', ')}`,
		};
	}
	const threadId = `github:${repo.fullName}#${parsed.number}`;
	daemon.db
		.query<unknown, Params>(
			`INSERT OR IGNORE INTO threads (id, channel, title, url, ownable, created_at)
			VALUES ($id, 'github', $title, $url, 1, $at)`,
		)
		.run({
			id: threadId,
			title: `${repos.length > 1 ? repo.name : ''}#${parsed.number}`,
			url: `https://github.com/${repo.fullName}/issues/${parsed.number}`,
			at: Date.now(),
		});
	return { ok: true, id: threadId };
}

/** The configured repository all these GitHub threads are on, if there's exactly one. */
export function repoOfThreads(daemon: Daemon, ids: string[]): string | null {
	const names = new Set(
		ids
			.map((id) => parseGitHubThread(id)?.repo.toLowerCase())
			.filter((repo) => repo !== undefined)
			.map(
				(repo) =>
					daemon.github.repos.find(
						(entry) => entry.fullName.toLowerCase() === repo,
					)?.name,
			),
	);
	const [only] = names;
	return names.size === 1 && only !== undefined ? only : null;
}

type ItemRow = {
	id: string;
	title: string;
	url: string | null;
	repo: string;
	number: number;
	isPr: number;
	state: string;
	itemTitle: string;
};

/**
 * For each GitHub thread the task owns that hasn't been fetched yet: the
 * issue and its last comments, for the Worker's next message. Their comment
 * cursor starts here, so these comments don't come again as events. `null`
 * when there's nothing new.
 */
export async function githubIntros(
	daemon: Daemon,
	taskId: number,
): Promise<string | null> {
	const { db } = daemon;
	const threads = db
		.query<{ id: string }, [number]>(
			`SELECT th.id FROM threads th LEFT JOIN github_items gi ON gi.thread_id = th.id
			WHERE th.owner_task_id = ? AND th.channel = 'github' AND gi.thread_id IS NULL
			ORDER BY th.created_at`,
		)
		.all(taskId);
	if (threads.length === 0) return null;
	const api = daemon.githubApi;
	const parts: string[] = [];
	for (const { id } of threads) {
		const parsed = parseGitHubThread(id);
		if (parsed === null) continue;
		if (api === null || daemon.github.state !== 'up') {
			parts.push(
				`You follow ${id}, but GitHub is ${daemon.github.state} (${daemon.github.detail ?? ''}), so it couldn't be fetched yet. It's tried again before your next step.`,
			);
			continue;
		}
		const path = `/repos/${parsed.repo}/issues/${parsed.number}`;
		let issue: unknown;
		let comments: unknown[];
		let etag: string | null;
		try {
			// oxlint-disable-next-line eslint/no-await-in-loop
			const response = await api.request('GET', path);
			issue = response.body;
			({ etag } = response);
			// oxlint-disable-next-line eslint/no-await-in-loop
			comments = (await api.pages(`${path}/comments?per_page=100`)).items;
		} catch (error) {
			if (error instanceof GitHubError && error.status === 404) {
				db.query<unknown, [string, number]>(
					'UPDATE threads SET owner_task_id = NULL WHERE id = ? AND owner_task_id = ?',
				).run(id, taskId);
				parts.push(
					`${parsed.repo}#${parsed.number} doesn't exist on GitHub, or your gh login can't see it, so you no longer follow ${id}.`,
				);
				continue;
			}
			parts.push(
				`You follow ${id}, but it couldn't be fetched (${error instanceof Error ? error.message : String(error)}). It's tried again before your next step.`,
			);
			continue;
		}
		const at = Date.now();
		const title = text(issue, 'title');
		const isPr = field(issue, 'pull_request') !== null;
		const newest = comments.reduce<string>(
			(latest, comment) => {
				const updated = text(comment, 'updated_at');
				return updated > latest ? updated : latest;
			},
			text(issue, 'created_at'),
		);
		db.transaction(() => {
			db.query<unknown, Params>(
				`INSERT INTO github_items (thread_id, repo, number, is_pr, title, state, polled_at, updated_at)
				VALUES ($id, $repo, $number, $isPr, $title, $state, $at, $updated)`,
			).run({
				id,
				repo: parsed.repo,
				number: parsed.number,
				isPr: isPr ? 1 : 0,
				title,
				state: itemState(issue),
				at,
				updated: text(issue, 'updated_at'),
			});
			saveCursor(db, `${id}:item`, null, etag);
			saveCursor(db, `${id}:comments`, newest, null);
			// Already in the Worker's message: recorded so polling skips them.
			for (const comment of comments) {
				db.query<unknown, Params>(
					`INSERT OR IGNORE INTO events (received_at, channel, external_id, thread_id, kind, author,
						text, route, filter_reason, consumed_at)
					VALUES ($at, 'github', $externalId, $thread, 'message', $author, $text, 'filtered',
						'shown when the task took the thread', $at)`,
				).run({
					at,
					externalId: `issue-comment:${idOf(field(comment, 'id')) ?? '?'}`,
					thread: id,
					author: login(comment),
					text: redact(daemon.secrets, text(comment, 'body')),
				});
			}
		})();
		parts.push(introText(daemon, id, parsed, issue, comments));
	}
	return parts.length > 0 ? parts.join('\n\n') : null;
}

function introText(
	daemon: Daemon,
	id: string,
	parsed: { repo: string; number: number },
	issue: unknown,
	comments: unknown[],
): string {
	const labels = field(issue, 'labels');
	const labelNames = Array.isArray(labels)
		? labels.map((label) => text(label, 'name')).filter(Boolean)
		: [];
	const shown = comments.slice(-INTRO_COMMENTS);
	const kind = field(issue, 'pull_request') === null ? 'issue' : 'PR';
	const lines = [
		`GitHub ${kind} ${parsed.repo}#${parsed.number} (thread ${id}): ${text(issue, 'title')}`,
		[
			itemState(issue),
			labelNames.length > 0 ? `labels: ${labelNames.join(', ')}` : null,
			`opened by ${login(issue)}`,
			text(issue, 'html_url'),
		]
			.filter(Boolean)
			.join(' · '),
		'',
		clip(daemon, text(issue, 'body')) || '(no description)',
	];
	if (shown.length > 0) {
		lines.push(
			'',
			comments.length > shown.length
				? `The last ${shown.length} of ${comments.length} comments:`
				: `Comments (${shown.length}):`,
		);
		for (const comment of shown) {
			lines.push(
				`${login(comment)}${isBot(comment) ? ' (bot)' : ''} · ${text(comment, 'created_at')}:`,
				clip(daemon, text(comment, 'body'))
					.split('\n')
					.map((line) => `  ${line}`)
					.join('\n'),
			);
		}
	}
	lines.push('', 'New comments and changes on it come to you.');
	return lines.join('\n');
}

/**
 * One round of polling: for each followed thread, its state and new
 * comments, as events for the owning task.
 */
export async function pollFollowed(
	daemon: Daemon,
	api: GitHubApi,
): Promise<void> {
	const rows = daemon.db
		.query<ItemRow, [number]>(
			`SELECT th.id, th.title, th.url, gi.repo, gi.number, gi.is_pr AS isPr, gi.state,
				gi.title AS itemTitle
			FROM threads th JOIN github_items gi ON gi.thread_id = th.id
			WHERE th.channel = 'github' AND th.owner_task_id IS NOT NULL
			ORDER BY COALESCE(th.last_event_at, th.created_at) DESC LIMIT ?`,
		)
		.all(MAX_FOLLOWED);
	for (const row of rows) {
		try {
			// oxlint-disable-next-line eslint/no-await-in-loop
			await pollItem(daemon, api, row);
			// oxlint-disable-next-line eslint/no-await-in-loop
			await pollComments(daemon, api, row);
		} catch (error) {
			if (!(error instanceof GitHubError) || error.status !== 404) {
				throw error;
			}
			daemon.log('warn', 'followed GitHub item not found', {
				thread: row.id,
			});
		}
		daemon.db
			.query<unknown, [number, string]>(
				'UPDATE github_items SET polled_at = ? WHERE thread_id = ?',
			)
			.run(Date.now(), row.id);
	}
}

async function pollItem(
	daemon: Daemon,
	api: GitHubApi,
	row: ItemRow,
): Promise<void> {
	const key = `${row.id}:item`;
	const cursor = loadCursor(daemon.db, key);
	const response = await api.request(
		'GET',
		`/repos/${row.repo}/issues/${row.number}`,
		{ etag: cursor?.etag ?? null },
	);
	if (response.status === 304) return;
	const issue = response.body;
	const state = itemState(issue);
	const updated = text(issue, 'updated_at');
	if (state !== row.state) {
		const name = `#${row.number}`;
		const change =
			state === 'merged'
				? {
						externalId: `merged:${row.repo}#${row.number}`,
						author: 'GitHub',
						text: `${name} was merged`,
					}
				: state === 'closed'
					? {
							externalId: `closed:${row.repo}#${row.number}:${text(issue, 'closed_at')}`,
							author: login(field(issue, 'closed_by')) || 'GitHub',
							text: `${name} was closed by ${login(field(issue, 'closed_by')) || 'someone'}`,
						}
					: {
							externalId: `reopened:${row.repo}#${row.number}:${updated}`,
							author: 'GitHub',
							text: `${name} was reopened`,
						};
		ingest(daemon, {
			channel: 'github',
			externalId: change.externalId,
			thread: { id: row.id, title: row.title, url: row.url, ownable: true },
			kind: 'activity',
			author: { name: change.author, id: null, isBot: false, isSelf: false },
			text: change.text,
			mentionsAgent: false,
			data: eventData(row, text(issue, 'html_url'), Date.parse(updated)),
		});
	}
	daemon.db
		.query<unknown, Params>(
			`UPDATE github_items SET state = $state, title = $title, updated_at = $updated
			WHERE thread_id = $id`,
		)
		.run({ id: row.id, state, title: text(issue, 'title'), updated });
	saveCursor(daemon.db, key, null, response.etag);
}

async function pollComments(
	daemon: Daemon,
	api: GitHubApi,
	row: ItemRow,
): Promise<void> {
	const key = `${row.id}:comments`;
	const cursor = loadCursor(daemon.db, key);
	const since = cursor?.since ?? new Date().toISOString();
	const { items, etag, notModified } = await api.pages(
		`/repos/${row.repo}/issues/${row.number}/comments?since=${encodeURIComponent(since)}&per_page=100`,
		cursor?.etag ?? null,
	);
	if (notModified) return;
	let newest = since;
	const comments = items.toSorted(
		(a, b) =>
			text(a, 'updated_at').localeCompare(text(b, 'updated_at')) ||
			Number(field(a, 'id')) - Number(field(b, 'id')),
	);
	for (const comment of comments) {
		const updated = text(comment, 'updated_at');
		if (updated > newest) newest = updated;
		const body = text(comment, 'body');
		const userId = idOf(field(field(comment, 'user'), 'id'));
		ingest(daemon, {
			channel: 'github',
			externalId: `issue-comment:${idOf(field(comment, 'id')) ?? '?'}`,
			thread: { id: row.id, title: row.title, url: row.url, ownable: true },
			kind: 'message',
			author: {
				name: login(comment) || 'someone',
				id: userId,
				isBot: isBot(comment),
				isSelf: body.includes(MARKER),
			},
			text: redact(daemon.secrets, body) || '(empty comment)',
			mentionsAgent: false,
			data: {
				...eventData(
					row,
					text(comment, 'html_url'),
					Date.parse(text(comment, 'created_at')),
				),
				comment: field(comment, 'id'),
			},
		});
	}
	// A new `since` is a new URL, whose ETag isn't known yet.
	saveCursor(daemon.db, key, newest, newest === since ? etag : null);
}

function eventData(
	row: ItemRow,
	url: string,
	postedAt: number,
): Record<string, unknown> {
	return {
		repo: row.repo,
		number: row.number,
		isPr: row.isPr === 1,
		itemTitle: row.itemTitle,
		url,
		postedAt: Number.isFinite(postedAt) ? postedAt : null,
	};
}

/** What the Router's `read_thread` adds for a GitHub thread: the last polled state. */
export function githubThreadState(
	db: Database,
	threadId: string,
): string | null {
	const item = db
		.query<
			{ isPr: number; title: string; state: string; polledAt: number },
			[string]
		>(
			`SELECT is_pr AS isPr, title, state, polled_at AS polledAt FROM github_items
			WHERE thread_id = ?`,
		)
		.get(threadId);
	if (!item) return null;
	const seconds = Math.max(0, Math.round((Date.now() - item.polledAt) / 1000));
	return `GitHub ${item.isPr ? 'PR' : 'issue'} · ${item.state} · ${JSON.stringify(item.title)} · as of ${seconds} s ago`;
}

function loadCursor(
	db: Database,
	key: string,
): { since: string | null; etag: string | null } | null {
	return db
		.query<{ since: string | null; etag: string | null }, [string]>(
			'SELECT since, etag FROM github_cursors WHERE key = ?',
		)
		.get(key);
}

function saveCursor(
	db: Database,
	key: string,
	since: string | null,
	etag: string | null,
): void {
	db.query<unknown, Params>(
		`INSERT INTO github_cursors (key, since, etag, updated_at) VALUES ($key, $since, $etag, $at)
		ON CONFLICT (key) DO UPDATE SET since = excluded.since, etag = excluded.etag,
			updated_at = excluded.updated_at`,
	).run({ key, since, etag, at: Date.now() });
}

function itemState(issue: unknown): string {
	if (field(field(issue, 'pull_request'), 'merged_at') !== null) {
		return 'merged';
	}
	return text(issue, 'state') === 'closed' ? 'closed' : 'open';
}

function clip(daemon: Daemon, value: string): string {
	const shown = cut(redact(daemon.secrets, value), INTRO_CHARS);
	return shown.length < value.length ? `${shown} […]` : shown;
}

function login(value: unknown): string {
	const user = field(value, 'user') ?? value;
	return text(user, 'login');
}

function isBot(comment: unknown): boolean {
	return text(field(comment, 'user'), 'type') === 'Bot';
}

function idOf(value: unknown): string | null {
	return typeof value === 'number' || typeof value === 'string'
		? String(value)
		: null;
}

function text(value: unknown, key: string): string {
	const found = field(value, key);
	return typeof found === 'string' ? found : '';
}

/** A property of a JSON value, or `null`. */
function field(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null || !(key in value)) {
		return null;
	}
	const record: Record<string, unknown> = { ...value };
	return record[key] ?? null;
}
