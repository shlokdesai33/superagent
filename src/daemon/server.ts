import { timingSafeEqual } from 'node:crypto';
import type { Server } from 'bun';
import {
	type ErrorBody,
	PROTOCOL_HEADER,
	PROTOCOL_VERSION,
} from '../protocol.ts';
import { runAction } from './actions.ts';
import type { Daemon } from './state.ts';

const MAX_REQUEST_BYTES = 1024 * 1024;
// Twice the feed's ping interval; any line sent resets it. Bun's default of
// 10 s would cut the feed between pings, and on Bun 1.4.4 `server.timeout(req,
// 0)` doesn't lift it on a Unix socket (it does on TCP).
const IDLE_TIMEOUT_S = 30;

/**
 * Listens on the Unix socket. `daemon` is read per request, so the server can
 * claim the socket before the rest of the daemon exists.
 */
export function listen(
	socket: string,
	daemon: () => Daemon,
): Server<undefined> {
	const options: Bun.Serve.Options<undefined, never> = {
		unix: socket,
		maxRequestBodySize: MAX_REQUEST_BYTES,
		async fetch(request) {
			const rejected = checkHeaders(request, daemon().token);
			if (rejected) return rejected;

			const { pathname } = new URL(request.url);
			switch (pathname) {
				case '/v1/feed':
					if (request.method !== 'GET') return methodNotAllowed('GET');
					return new Response(daemon().feed.open(), {
						headers: {
							'Content-Type': 'application/x-ndjson',
							'Cache-Control': 'no-store',
						},
					});
				case '/v1/actions': {
					if (request.method !== 'POST') return methodNotAllowed('POST');
					let body: unknown;
					try {
						body = await request.json();
					} catch {
						return error(400, 'bad_request', 'The body must be JSON');
					}
					const outcome = runAction(daemon(), body);
					return outcome.ok
						? Response.json(outcome.result)
						: error(400, outcome.code, outcome.message);
				}
				default:
					return error(404, 'not_found', `No endpoint ${pathname}`);
			}
		},
		error(failure) {
			daemon().log('error', 'request failed', {
				error: failure.stack ?? failure.message,
			});
			return error(500, 'internal', 'The agent hit an unexpected error');
		},
	};
	// Bun's types allow `idleTimeout` only on TCP servers, but Bun applies it to
	// Unix sockets too.
	Reflect.set(options, 'idleTimeout', IDLE_TIMEOUT_S);
	return Bun.serve(options);
}

function checkHeaders(request: Request, token: string): Response | null {
	const sent = request.headers
		.get('authorization')
		?.match(/^Bearer (.+)$/)?.[1];
	if (sent === undefined || !sameSecret(sent, token)) {
		return error(401, 'bad_token', 'Missing or wrong token');
	}
	if (request.headers.get(PROTOCOL_HEADER) !== PROTOCOL_VERSION) {
		return error(
			400,
			'unsupported_protocol',
			`This agent speaks ${PROTOCOL_HEADER}: ${PROTOCOL_VERSION}`,
		);
	}
	return null;
}

function sameSecret(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

function methodNotAllowed(allowed: string): Response {
	const response = error(405, 'method_not_allowed', `Use ${allowed}`);
	response.headers.set('Allow', allowed);
	return response;
}

function error(status: number, code: string, message: string): Response {
	const body: ErrorBody = { error: { code, message } };
	return Response.json(body, { status });
}
