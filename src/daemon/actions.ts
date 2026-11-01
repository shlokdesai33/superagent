import type { Action, ActionResult } from '../protocol.ts';
import { ingest } from './ingest.ts';
import type { Daemon } from './state.ts';

const REMEMBER_RESULTS_MS = 10 * 60_000;
const MAX_REQUEST_ID_LENGTH = 200;

const ACTION_TYPES: ReadonlySet<string> = new Set<Action['type']>([
	'send_console',
	'send_note',
	'answer_question',
	'stop_task',
	'resume_tasks',
	'act_observed',
	'ignore_observed',
]);

export type ActionOutcome =
	| { ok: true; result: ActionResult }
	| { ok: false; code: string; message: string };

/** Runs one `POST /v1/actions` body. A resent `requestId` gets its original result. */
export function runAction(daemon: Daemon, body: unknown): ActionOutcome {
	const now = Date.now();
	for (const [id, entry] of daemon.actionResults) {
		if (now - entry.at < REMEMBER_RESULTS_MS) break;
		daemon.actionResults.delete(id);
	}

	if (typeof body !== 'object' || body === null) {
		return malformed('expected { "requestId", "action" }');
	}
	const requestId = 'requestId' in body ? body.requestId : undefined;
	if (
		typeof requestId !== 'string' ||
		requestId === '' ||
		requestId.length > MAX_REQUEST_ID_LENGTH
	) {
		return malformed(
			`requestId must be a non-empty string of at most ${MAX_REQUEST_ID_LENGTH} characters`,
		);
	}
	const remembered = daemon.actionResults.get(requestId);
	if (remembered) return { ok: true, result: remembered.result };

	const action = 'action' in body ? body.action : undefined;
	if (
		typeof action !== 'object' ||
		action === null ||
		!('type' in action) ||
		typeof action.type !== 'string'
	) {
		return malformed('action must be an object with a type');
	}
	if (!isActionType(action.type)) {
		return {
			ok: false,
			code: 'unknown_action',
			message: `Unknown action type ${JSON.stringify(action.type)}`,
		};
	}

	let result: ActionResult;
	switch (action.type) {
		case 'send_console': {
			const text = 'text' in action ? action.text : undefined;
			if (typeof text !== 'string') return malformed('text must be a string');
			result = sendConsole(daemon, requestId, text);
			break;
		}
		case 'act_observed':
		case 'ignore_observed':
			result = notAvailable("observe mode isn't built");
			break;
		default:
			result = notAvailable("tasks aren't built yet");
	}
	daemon.actionResults.set(requestId, { at: now, result });
	return { ok: true, result };
}

function sendConsole(
	daemon: Daemon,
	requestId: string,
	text: string,
): ActionResult {
	if (text.trim() === '') {
		return {
			ok: false,
			code: 'empty',
			subject: 'Nothing to send',
			detail: 'type a message first',
		};
	}
	const seq = ingest(daemon, {
		channel: 'console',
		externalId: requestId,
		thread: { id: 'console', title: 'console', url: null, ownable: false },
		kind: 'message',
		author: { name: 'you', id: null, isBot: false, isSelf: false },
		text,
		mentionsAgent: true,
	});
	return {
		ok: true,
		seq: seq ?? daemon.feed.seq,
		subject: 'Sent',
		detail: 'the Router decides what to do',
	};
}

function notAvailable(detail: string): ActionResult {
	return {
		ok: false,
		code: 'not_available',
		subject: 'Not available yet',
		detail,
	};
}

function isActionType(type: string): type is Action['type'] {
	return ACTION_TYPES.has(type);
}

function malformed(message: string): ActionOutcome {
	return { ok: false, code: 'bad_request', message };
}
