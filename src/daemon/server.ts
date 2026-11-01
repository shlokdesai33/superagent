import { timingSafeEqual } from 'node:crypto';
import type { Server } from 'bun';
import {
	type ErrorBody,
	PROTOCOL_HEADER,
	PROTOCOL_VERSION,
	type TaskDetail,
} from '../protocol.ts';
import { runAction } from './actions.ts';
import { readOutput } from './commands.ts';
import {
	type Daemon,
	MESSAGE_COLUMNS,
	type MessageRow,
	toMessage,
} from './state.ts';
import {
	type TaskRow,
	taskByHandle,
	taskSteps,
	taskSummary,
} from './task-feed.ts';

const MAX_REQUEST_BYTES = 1024 * 1024;
const CONVERSATION_MESSAGES = 500;
const DETAIL_MESSAGE_CHARS = 64 * 1024;
const OUTPUT_LINES = 2_000;

/**
 * Listens on the Unix socket. `daemon` is read per request, so the server can
 * claim the socket before the rest of the daemon exists.
 */
export function listen(
	socket: string,
	daemon: () => Daemon,
): Server<undefined> {
	return Bun.serve({
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
					const outcome = await runAction(daemon(), body);
					return outcome.ok
						? Response.json(outcome.result)
						: error(400, outcome.code, outcome.message);
				}
			}

			const task = pathname.match(
				/^\/v1\/tasks\/([^/]+)(?:\/steps\/(\d+)\/(diff|output))?$/,
			);
			if (task) {
				if (request.method !== 'GET') return methodNotAllowed('GET');
				const [, handle = '', step, part] = task;
				const found = taskByHandle(daemon().db, decodeURIComponent(handle));
				if (!found) return error(404, 'unknown_task', `No task ${handle}`);
				if (step === undefined) {
					return Response.json(taskDetail(daemon(), found));
				}
				const from = Number(new URL(request.url).searchParams.get('from') ?? 1);
				const text =
					part === 'diff'
						? stepDiff(daemon(), found.id, Number(step))
						: stepOutput(
								daemon(),
								found,
								Number(step),
								Number.isFinite(from) ? from : 1,
							);
				return text === null
					? error(
							404,
							'not_found',
							`Step ${step} of ${found.handle} has no ${part}`,
						)
					: new Response(text, {
							headers: { 'Content-Type': 'text/plain; charset=utf-8' },
						});
			}
			return error(404, 'not_found', `No endpoint ${pathname}`);
		},
		error(failure) {
			daemon().log('error', 'request failed', {
				error: failure.stack ?? failure.message,
			});
			return error(500, 'internal', 'The agent hit an unexpected error');
		},
	});
}

/** `GET /v1/tasks/:handle`, read at the current feed `seq`. */
function taskDetail(daemon: Daemon, task: TaskRow): TaskDetail {
	return {
		seq: daemon.feed.seq,
		task: taskSummary(daemon, task),
		steps: taskSteps(daemon.db, task.id),
		conversation: daemon.db
			.query<MessageRow, [number, number, number]>(
				`SELECT * FROM (
					SELECT ${MESSAGE_COLUMNS}
					WHERE m.task_id = ?1
						OR m.thread_id IN (SELECT thread_id FROM task_threads WHERE task_id = ?2)
					ORDER BY m.id DESC LIMIT ?3
				) ORDER BY id`,
			)
			.all(task.id, task.id, CONVERSATION_MESSAGES)
			.map((row) => toMessage(row, DETAIL_MESSAGE_CHARS)),
		report: task.report,
		workDir: task.workDir,
		branch: task.branch,
	};
}

function stepDiff(
	daemon: Daemon,
	taskId: number,
	stepId: number,
): string | null {
	return (
		daemon.db
			.query<{ diff: string | null }, [number, number]>(
				'SELECT diff FROM steps WHERE id = ? AND task_id = ?',
			)
			.get(stepId, taskId)?.diff ?? null
	);
}

function stepOutput(
	daemon: Daemon,
	task: TaskRow,
	stepId: number,
	from: number,
): string | null {
	const command = daemon.db
		.query<unknown, [number, number]>(
			"SELECT 1 FROM steps WHERE id = ? AND task_id = ? AND kind = 'command'",
		)
		.get(stepId, task.id);
	if (!command) return null;
	const { lines } = readOutput(daemon, task.handle, stepId, from, OUTPUT_LINES);
	return lines.length > 0 ? `${lines.join('\n')}\n` : '';
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
