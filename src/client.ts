import { dataPaths } from './home.ts';
import {
	PROTOCOL_HEADER,
	PROTOCOL_VERSION,
	type Snapshot,
} from './protocol.ts';

/**
 * - `not_running`: no token file, or nothing listening on the socket.
 * - `rejected`: the daemon refused the token or the protocol version.
 */
export class DaemonUnreachable extends Error {
	override name = 'DaemonUnreachable';
	readonly kind: 'not_running' | 'rejected';

	constructor(kind: 'not_running' | 'rejected', message: string) {
		super(message);
		this.kind = kind;
	}
}

/** A request to the daemon, rereading the token file each time. */
export async function daemonFetch(
	path: string,
	init: RequestInit = {},
): Promise<Response> {
	const paths = dataPaths();
	const notRunning = `The agent isn't running in ${paths.home}. Start it with: superagent daemon`;
	let token: string;
	try {
		token = (await Bun.file(paths.token).text()).trim();
	} catch {
		throw new DaemonUnreachable('not_running', notRunning);
	}

	const headers = new Headers(init.headers);
	headers.set('Authorization', `Bearer ${token}`);
	headers.set(PROTOCOL_HEADER, PROTOCOL_VERSION);
	let response: Response;
	try {
		response = await fetch(`http://superagent${path}`, {
			...init,
			headers,
			unix: paths.socket,
		});
	} catch {
		throw new DaemonUnreachable('not_running', notRunning);
	}

	if (response.status === 401) {
		throw new DaemonUnreachable(
			'rejected',
			`The agent rejected the token in ${paths.token}`,
		);
	}
	if (response.status === 400) {
		const text = await response.text();
		if (errorCode(text) === 'unsupported_protocol') {
			throw new DaemonUnreachable(
				'rejected',
				'The agent and this terminal are different versions',
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
export async function readSnapshot(): Promise<Snapshot> {
	const response = await daemonFetch('/v1/feed');
	if (!response.ok || response.body === null) {
		throw new Error(`The agent answered HTTP ${response.status}`);
	}
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffered = '';
	try {
		for (;;) {
			// The snapshot arrives in chunks; each read waits for the next one.
			// oxlint-disable-next-line eslint/no-await-in-loop
			const { done, value } = await reader.read();
			if (done) throw new Error('The feed ended before its snapshot');
			buffered += decoder.decode(value, { stream: true });
			const end = buffered.indexOf('\n');
			if (end === -1) continue;
			const line: unknown = JSON.parse(buffered.slice(0, end));
			if (!isSnapshotLine(line)) {
				throw new Error('The feed did not start with a snapshot');
			}
			return line.snapshot;
		}
	} finally {
		await reader.cancel();
	}
}

// The daemon is trusted to send the shape the protocol version promises.
function isSnapshotLine(
	line: unknown,
): line is { type: 'snapshot'; snapshot: Snapshot } {
	return (
		typeof line === 'object' &&
		line !== null &&
		'type' in line &&
		line.type === 'snapshot' &&
		'snapshot' in line &&
		typeof line.snapshot === 'object' &&
		line.snapshot !== null
	);
}

function errorCode(text: string): string | null {
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
		body.error !== null &&
		'code' in body.error &&
		typeof body.error.code === 'string'
		? body.error.code
		: null;
}
