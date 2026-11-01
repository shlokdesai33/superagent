import type { Database } from 'bun:sqlite';
import type {
	AssistantMessage,
	Message,
	ToolMessage,
	UserMessage,
} from '../particle/types.ts';
import { ModelError, callModel } from './model.ts';
import type { Daemon, Params } from './state.ts';

// Keep the newest items back to about this many tokens, at 4 characters each.
const KEEP_CHARS = 40_000 * 4;
const COMPACTION_MAX_TOKENS = 8_000;

const COMPACTION_PROMPT = `You compact the transcript of an AI agent's session so it can keep working with a smaller context. You get the previous summary, if any, and the part of the transcript being folded in. Write one summary that replaces both. Use these headings, and keep every detail that matters later; drop chatter:

- Goal
- Current state
- Decisions made, and why
- Files and commands that matter
- Open questions
- Commitments made to people
- IDs worth recalling later: events (#42), threads, and tasks (handles such as t97c)`;

/** A transcript entry, stored as JSON. `reasoning_content` is kept but never sent back. */
export type Item =
	| UserMessage
	| (AssistantMessage & { reasoning_content?: string })
	| ToolMessage;

export function userItem(content: string): UserMessage {
	return { role: 'user', content };
}

/** The Router's one session, created on first start. */
export function routerSessionId(db: Database): number {
	const existing = db
		.query<{ id: number }, []>(
			"SELECT id FROM sessions WHERE kind = 'router' ORDER BY id LIMIT 1",
		)
		.get();
	if (existing) return existing.id;
	return Number(
		db
			.query<unknown, [number]>(
				"INSERT INTO sessions (kind, created_at) VALUES ('router', ?)",
			)
			.run(Date.now()).lastInsertRowid,
	);
}

/** Appends items at the end of the transcript. */
export function appendItems(
	db: Database,
	sessionId: number,
	items: Item[],
): void {
	const at = Date.now();
	db.transaction(() => {
		let seq =
			db
				.query<{ seq: number }, [number]>(
					'SELECT COALESCE(MAX(seq), 0) AS seq FROM session_items WHERE session_id = ?',
				)
				.get(sessionId)?.seq ?? 0;
		const insert = db.query<unknown, Params>(
			'INSERT INTO session_items (session_id, seq, at, item) VALUES ($sessionId, $seq, $at, $item)',
		);
		for (const item of items) {
			seq += 1;
			insert.run({ sessionId, seq, at, item: JSON.stringify(item) });
		}
	})();
}

/**
 * The messages for the next call: the system prompt, the compaction summary if
 * there is one, then every item it doesn't cover.
 */
export function promptMessages(
	db: Database,
	sessionId: number,
	system: string,
): Message[] {
	const session = db
		.query<{ summary: string | null; through: number }, [number]>(
			'SELECT summary, compacted_through AS through FROM sessions WHERE id = ?',
		)
		.get(sessionId);
	const messages: Message[] = [{ role: 'system', content: system }];
	if (session?.summary) {
		messages.push(userItem(`Summary of earlier work:\n\n${session.summary}`));
	}
	for (const { item } of loadItems(db, sessionId, session?.through ?? 0)) {
		if (item.role === 'assistant') {
			const { reasoning_content: _, ...message } = item;
			messages.push(message);
		} else {
			messages.push(item);
		}
	}
	return messages;
}

function loadItems(
	db: Database,
	sessionId: number,
	after: number,
): Array<{ seq: number; item: Item; size: number }> {
	return db
		.query<{ seq: number; item: string }, [number, number]>(
			'SELECT seq, item FROM session_items WHERE session_id = ? AND seq > ? ORDER BY seq',
		)
		.all(sessionId, after)
		.map((row) => ({
			seq: row.seq,
			item: parseItem(row.item),
			size: row.item.length,
		}));
}

function parseItem(text: string): Item {
	const item: unknown = JSON.parse(text);
	if (!isItem(item)) throw new Error(`malformed session item: ${text}`);
	return item;
}

// Items are written only by the daemon, so the role is enough to tell them apart.
function isItem(value: unknown): value is Item {
	return (
		typeof value === 'object' &&
		value !== null &&
		'role' in value &&
		(value.role === 'user' ||
			value.role === 'assistant' ||
			value.role === 'tool')
	);
}

/** After a restart, `repairTranscript` for every session. */
export function repairTranscripts(db: Database): number {
	let repaired = 0;
	for (const { id } of db
		.query<{ id: number }, []>('SELECT id FROM sessions')
		.all()) {
		repaired += repairTranscript(db, id, 'not run: the agent restarted');
	}
	return repaired;
}

/**
 * A transcript that ends in tool calls without results gets `content` as the
 * result of each, so the next call is valid. Returns how many it added.
 */
export function repairTranscript(
	db: Database,
	sessionId: number,
	content: string,
): number {
	const last = db
		.query<{ seq: number; item: string }, [number]>(
			`SELECT seq, item FROM session_items
			WHERE session_id = ? AND json_extract(item, '$.role') = 'assistant'
			ORDER BY seq DESC LIMIT 1`,
		)
		.get(sessionId);
	if (!last) return 0;
	const assistant = parseItem(last.item);
	const calls =
		assistant.role === 'assistant' ? (assistant.tool_calls ?? []) : [];
	const answered = new Set(
		loadItems(db, sessionId, last.seq).map(({ item }) =>
			item.role === 'tool' ? item.tool_call_id : null,
		),
	);
	const missing: ToolMessage[] = calls
		.filter((call) => !answered.has(call.id))
		.map((call) => ({ role: 'tool', tool_call_id: call.id, content }));
	if (missing.length > 0) appendItems(db, sessionId, missing);
	return missing.length;
}

/**
 * Folds the older part of the transcript into the summary, keeping the newest
 * items back to about 40,000 tokens. The cut never separates a tool call from
 * its results. Items are never deleted.
 */
export async function compact(
	daemon: Daemon,
	options: {
		sessionId: number;
		taskId: number | null;
		cacheKey: string;
		signal: AbortSignal;
	},
): Promise<void> {
	const { db } = daemon;
	const session = db
		.query<{ summary: string | null; through: number }, [number]>(
			'SELECT summary, compacted_through AS through FROM sessions WHERE id = ?',
		)
		.get(options.sessionId);
	if (!session) throw new Error(`no session ${options.sessionId}`);
	const all = loadItems(db, options.sessionId, session.through);

	let kept = all.length;
	let chars = 0;
	while (kept > 0 && chars < KEEP_CHARS) {
		kept -= 1;
		chars += all[kept]?.size ?? 0;
	}
	while (kept > 0 && all[kept]?.item.role === 'tool') kept -= 1;
	const folded = all.slice(0, kept);
	const through = folded.at(-1)?.seq;
	if (through === undefined) return;

	const result = await callModel(daemon, {
		sessionId: options.sessionId,
		taskId: options.taskId,
		purpose: 'compaction',
		signal: options.signal,
		request: {
			model: 'particle-1',
			reasoning_effort: 'low',
			max_completion_tokens: COMPACTION_MAX_TOKENS,
			prompt_cache_key: options.cacheKey,
			messages: [
				{ role: 'system', content: COMPACTION_PROMPT },
				userItem(
					[
						`Previous summary:\n\n${session.summary ?? '(none)'}`,
						`Transcript to fold in (${folded.length} items):`,
						...folded.map(({ item }) => renderItem(item)),
					].join('\n\n'),
				),
			],
		},
	});
	const summary = result.message.content?.trim();
	if (!summary) {
		throw new ModelError('Particle returned an empty summary', 'transient');
	}
	db.query<unknown, Params>(
		'UPDATE sessions SET summary = $summary, compacted_through = $through WHERE id = $id',
	).run({ summary, through, id: options.sessionId });
	daemon.log('info', 'session compacted', {
		session: options.sessionId,
		folded: folded.length,
		kept: all.length - folded.length,
		through,
	});
}

function renderItem(item: Item): string {
	switch (item.role) {
		case 'user':
			return `[user]\n${
				typeof item.content === 'string'
					? item.content
					: item.content
							.map((part) => (part.type === 'text' ? part.text : '[image]'))
							.join('\n')
			}`;
		case 'assistant':
			return [
				'[assistant]',
				item.content ?? '',
				...(item.tool_calls ?? []).map(
					(call) => `-> ${call.function.name} ${call.function.arguments}`,
				),
			]
				.filter(Boolean)
				.join('\n');
		case 'tool':
			return `[tool result]\n${item.content}`;
	}
}
