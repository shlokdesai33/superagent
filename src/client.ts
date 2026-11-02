import { dataPaths } from './home.ts';
import {
	type Action,
	type ActionResult,
	type FeedLine,
	PROTOCOL_HEADER,
	PROTOCOL_VERSION,
	type Snapshot,
	type TaskDetail,
} from './protocol.ts';

export const NOT_RUNNING = "superagent isn't running. Run `superagent start`.";
export const NOT_ANSWERING =
	"superagent is running but isn't answering. Run `superagent restart`.";

/**
 * - `not_running`: nothing listening on the socket.
 * - `rejected`: the daemon refused the protocol version.
 * - `not_answering`: it took the connection but sent nothing in time, as when
 *   it's frozen.
 */
export class DaemonUnreachable extends Error {
	override name = 'DaemonUnreachable';
	readonly kind: 'not_running' | 'rejected' | 'not_answering';
	/** The underlying failure, for people: `nothing listening on …/agent.sock (ENOENT)`. */
	readonly detail: string;

	constructor(
		kind: 'not_running' | 'rejected' | 'not_answering',
		message: string,
		detail: string,
	) {
		super(message);
		this.kind = kind;
		this.detail = detail;
	}
}

/** A request to the daemon. */
export async function daemonFetch(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const paths = dataPaths();
	const headers = new Headers(init.headers);
	headers.set(PROTOCOL_HEADER, PROTOCOL_VERSION);
	let response: Response;
	try {
		response = await fetch(`http://superagent${path}`, {
			...init,
			headers,
			unix: paths.socket,
		});
	} catch (error) {
		if (init.signal?.aborted) throw error;
		throw new DaemonUnreachable(
			'not_running',
			NOT_RUNNING,
			`nothing listening on ${paths.socket} (${errorName(error)})`,
		);
	}

	if (response.status === 400) {
		const text = await response.text();
		if (errorCode(text) === 'unsupported_protocol') {
			throw new DaemonUnreachable(
				'rejected',
				'The agent and this terminal are different versions',
				`HTTP 400 unsupported_protocol; this terminal speaks ${PROTOCOL_HEADER}: ${PROTOCOL_VERSION}`,
			);
		}
		return new Response(text, {
			status: response.status,
			headers: response.headers,
		});
	}
	return response;
}

/** Opens the feed, reads its first line and closes it. */
export async function readSnapshot(signal?: AbortSignal): Promise<Snapshot> {
	for await (const line of openFeed(signal)) {
		if (line.type !== 'snapshot') {
			throw new Error('The feed did not start with a snapshot');
		}
		return line.snapshot;
	}
	throw new Error('The feed ended before its snapshot');
}

/**
 * The feed's lines as they arrive, until it ends or `signal` aborts. The first
 * is always a snapshot.
 */
export async function* openFeed(
	signal?: AbortSignal,
): AsyncGenerator<FeedLine> {
	const response = await daemonFetch(
		'/v1/feed',
		signal ? { signal } : undefined,
	);
	if (!response.ok || response.body === null) {
		throw new Error(`The agent answered HTTP ${response.status}`);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffered = '';
	try {
		for (;;) {
			// Lines arrive one chunk at a time; each read waits for the next one.
			// oxlint-disable-next-line eslint/no-await-in-loop
			const { done, value } = await reader.read();
			if (done) return;
			buffered += decoder.decode(value, { stream: true });
			let end = buffered.indexOf('\n');
			while (end !== -1) {
				const text = buffered.slice(0, end);
				buffered = buffered.slice(end + 1);
				end = buffered.indexOf('\n');
				if (text.trim() === '') continue;
				const line: unknown = JSON.parse(text);
				if (!isFeedLine(line)) {
					throw new Error('The feed sent a line without a type');
				}
				yield line;
			}
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
}

/** Runs one action. Failures the user should see come back as `ok: false`. */
export async function postAction(action: Action): Promise<ActionResult> {
	const response = await daemonFetch('/v1/actions', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ requestId: crypto.randomUUID(), action }),
	});
	const text = await response.text();
	if (!response.ok) {
		return {
			ok: false,
			code: errorCode(text) ?? `http_${response.status}`,
			subject: 'The agent refused this',
			detail: errorMessage(text) ?? `HTTP ${response.status}`,
		};
	}
	const result: unknown = JSON.parse(text);
	if (!isActionResult(result)) {
		throw new Error('The agent sent an action result without ok');
	}
	return result;
}

/** One task's detail, or `null` when the agent has none for it. */
export async function fetchTaskDetail(
	handle: string,
): Promise<TaskDetail | null> {
	const response = await daemonFetch(`/v1/tasks/${encodeURIComponent(handle)}`);
	if (!response.ok) return null;
	const detail: unknown = await response.json();
	return isTaskDetail(detail) ? detail : null;
}

/** The unified diff of one edit step, or `null` when there is none. */
export async function fetchStepDiff(
	handle: string,
	stepId: number,
): Promise<string | null> {
	const response = await daemonFetch(
		`/v1/tasks/${encodeURIComponent(handle)}/steps/${stepId}/diff`,
	);
	return response.ok ? response.text() : null;
}

// The daemon is trusted to send the shape the protocol version promises.
function isFeedLine(line: unknown): line is FeedLine {
	return (
		typeof line === 'object' &&
		line !== null &&
		'type' in line &&
		typeof line.type === 'string'
	);
}

function isActionResult(value: unknown): value is ActionResult {
	return (
		typeof value === 'object' &&
		value !== null &&
		'ok' in value &&
		typeof value.ok === 'boolean' &&
		'subject' in value &&
		typeof value.subject === 'string'
	);
}

function isTaskDetail(value: unknown): value is TaskDetail {
	return (
		typeof value === 'object' &&
		value !== null &&
		'task' in value &&
		'steps' in value &&
		Array.isArray(value.steps) &&
		'conversation' in value &&
		Array.isArray(value.conversation)
	);
}

function errorName(error: unknown): string {
	if (typeof error === 'object' && error !== null && 'code' in error) {
		return String(error.code);
	}
	return error instanceof Error ? error.message : String(error);
}

function errorBody(text: string): { code: unknown; message: unknown } | null {
	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return null;
	}
	return typeof body === 'object' &&
		body !== null &&
		'error' in body &&
		typeof body.error === 'object' &&
		body.error !== null
		? {
				code: 'code' in body.error ? body.error.code : null,
				message: 'message' in body.error ? body.error.message : null,
			}
		: null;
}

function errorCode(text: string): string | null {
	const code = errorBody(text)?.code;
	return typeof code === 'string' ? code : null;
}

function errorMessage(text: string): string | null {
	const message = errorBody(text)?.message;
	return typeof message === 'string' ? message : null;
}
