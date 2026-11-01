import { ingest } from './ingest.ts';
import type { Daemon } from './state.ts';

const MAX_TEXT_CHARS = 64 * 1024;

export type ScriptEventOutcome =
	| { ok: true; seq: number; duplicate: boolean }
	| { ok: false; message: string };

function bad(message: string): ScriptEventOutcome {
	return { ok: false, message };
}

/**
 * One `POST /v1/events` body (§4.6), injected as a message on the script
 * channel. The thread `key` becomes the thread ID `script:<key>`.
 */
export function scriptEvent(daemon: Daemon, body: unknown): ScriptEventOutcome {
	if (typeof body !== 'object' || body === null)
		return bad('expected an object');
	const value: Record<string, unknown> = { ...body };

	const { externalId, thread, author, text, mentionsAgent } = value;
	if (typeof externalId !== 'string' || externalId === '') {
		return bad('externalId must be a non-empty string');
	}
	if (typeof thread !== 'object' || thread === null) {
		return bad('thread must be { "key", "title", "url" }');
	}
	const threadFields: Record<string, unknown> = { ...thread };
	const { key, title } = threadFields;
	const url = threadFields.url ?? null;
	if (typeof key !== 'string' || key === '' || typeof title !== 'string') {
		return bad('thread.key and thread.title must be strings');
	}
	if (url !== null && typeof url !== 'string') {
		return bad('thread.url must be a string or null');
	}
	if (typeof author !== 'object' || author === null) {
		return bad('author must be { "id", "name", "isBot" }');
	}
	const authorFields: Record<string, unknown> = { ...author };
	const id = authorFields.id ?? null;
	const { name } = authorFields;
	const isBot = authorFields.isBot ?? false;
	// Not in §4.6's example; lets a test send the agent's own message back.
	const isSelf = authorFields.isSelf ?? false;
	if (
		typeof name !== 'string' ||
		name === '' ||
		(id !== null && typeof id !== 'string') ||
		typeof isBot !== 'boolean' ||
		typeof isSelf !== 'boolean'
	) {
		return bad(
			'author.name must be a string, author.id a string or null, isBot and isSelf booleans',
		);
	}
	if (typeof text !== 'string' || text.trim() === '') {
		return bad('text must be a non-empty string');
	}
	if (text.length > MAX_TEXT_CHARS) {
		return bad(`text is over ${MAX_TEXT_CHARS} characters`);
	}
	if (typeof mentionsAgent !== 'boolean') {
		return bad('mentionsAgent must be a boolean');
	}

	const seq = ingest(daemon, {
		channel: 'script',
		externalId,
		thread: { id: `script:${key}`, title, url, ownable: true },
		kind: 'message',
		author: { name, id, isBot, isSelf },
		text,
		mentionsAgent,
	});
	return seq === null
		? { ok: true, seq: daemon.feed.seq, duplicate: true }
		: { ok: true, seq, duplicate: false };
}
