import { isAbsolute } from 'node:path';
import type { Action, ActionResult } from '../protocol.ts';
import { ingest } from './ingest.ts';
import { useRepository } from './repos.ts';
import type { Daemon, Params } from './state.ts';
import { taskByHandle } from './task-feed.ts';
import {
	endTask,
	ownedChatThreads,
	reopenTask,
	resumeTasks as resume,
	stopAndWait,
	toRouter,
} from './tasks.ts';

const REMEMBER_RESULTS_MS = 10 * 60_000;
const MAX_REQUEST_ID_LENGTH = 200;

const ACTION_TYPES: ReadonlySet<string> = new Set<Action['type']>([
	'send_console',
	'send_note',
	'answer_question',
	'stop_task',
	'resume_tasks',
]);

export type ActionOutcome =
	| { ok: true; result: ActionResult }
	| { ok: false; code: string; message: string };

/** Runs one `POST /v1/actions` body. A resent `requestId` gets its original result. */
export async function runAction(
	daemon: Daemon,
	body: unknown,
): Promise<ActionOutcome> {
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
			const repo = 'repo' in action ? action.repo : undefined;
			const cwd = 'cwd' in action ? action.cwd : undefined;
			if (typeof text !== 'string') return malformed('text must be a string');
			if (repo !== undefined && repo !== null && typeof repo !== 'string') {
				return malformed('repo must be a path or null');
			}
			if (cwd !== undefined && cwd !== null && typeof cwd !== 'string') {
				return malformed('cwd must be a path or null');
			}
			result = sendConsole(daemon, requestId, text, repo ?? null, cwd ?? null);
			break;
		}
		case 'send_note': {
			const handle = 'handle' in action ? action.handle : undefined;
			const text = 'text' in action ? action.text : undefined;
			if (typeof handle !== 'string' || typeof text !== 'string') {
				return malformed('handle and text must be strings');
			}
			result = sendNote(daemon, requestId, handle, text);
			break;
		}
		case 'answer_question': {
			const handle = 'handle' in action ? action.handle : undefined;
			const questionId = 'questionId' in action ? action.questionId : undefined;
			const text = 'text' in action ? action.text : undefined;
			if (
				typeof handle !== 'string' ||
				typeof questionId !== 'number' ||
				typeof text !== 'string'
			) {
				return malformed(
					'handle and text must be strings and questionId a number',
				);
			}
			result = await answerQuestion(
				daemon,
				requestId,
				handle,
				questionId,
				text,
			);
			break;
		}
		case 'stop_task': {
			const handle = 'handle' in action ? action.handle : undefined;
			if (typeof handle !== 'string') {
				return malformed('handle must be a string');
			}
			// Remembered before it finishes, so a resend doesn't stop twice.
			const pending = stopTask(daemon, handle);
			daemon.actionResults.set(requestId, {
				at: now,
				result: {
					ok: false,
					code: 'in_progress',
					subject: `Stopping ${handle}`,
					detail: null,
				},
			});
			result = await pending;
			break;
		}
		case 'resume_tasks': {
			const handles = 'handles' in action ? action.handles : undefined;
			if (
				handles !== null &&
				!(
					Array.isArray(handles) &&
					handles.every((handle) => typeof handle === 'string')
				)
			) {
				return malformed('handles must be a list of strings or null');
			}
			result = resumeTasks(daemon, handles);
			break;
		}
	}
	daemon.actionResults.set(requestId, { at: now, result });
	return { ok: true, result };
}

function sendConsole(
	daemon: Daemon,
	requestId: string,
	text: string,
	repoPath: string | null,
	cwd: string | null,
): ActionResult {
	if (text.trim() === '') return empty();
	// Sending from a repository confirms it, so one the agent doesn't know yet
	// is added.
	const repo = repoPath === null ? null : useRepository(daemon, repoPath);
	const folder = cwd !== null && isAbsolute(cwd) ? cwd : null;
	if (repo?.ok === false) {
		return {
			ok: false,
			code: 'bad_repo',
			subject: 'Not sent',
			detail: `${repo.detail} · tab changes the repository`,
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
		...(repo || folder
			? {
					data: {
						...(repo ? { repo: repo.name } : {}),
						...(folder ? { cwd: folder } : {}),
					},
				}
			: {}),
	});
	return {
		ok: true,
		seq: seq ?? daemon.feed.seq,
		subject: 'Sent',
		detail: repo?.added ? `added ${repo.name}` : null,
	};
}

function sendNote(
	daemon: Daemon,
	requestId: string,
	handle: string,
	text: string,
): ActionResult {
	if (text.trim() === '') return empty();
	const task = taskByHandle(daemon.db, handle);
	if (!task) return unknownTask(handle);
	const ended = task.state !== 'active' && task.state !== 'needs_you';
	let seq =
		ingest(daemon, {
			channel: 'console',
			externalId: requestId,
			thread: null,
			kind: 'note',
			author: { name: 'you', id: null, isBot: false, isSelf: false },
			text,
			mentionsAgent: true,
			taskId: task.id,
		}) ?? daemon.feed.seq;
	if (ended) seq = reopenTask(daemon, task.id);
	return {
		ok: true,
		seq,
		subject: `Sent to ${task.handle}`,
		detail: ended ? 'it reopens' : null,
	};
}

async function answerQuestion(
	daemon: Daemon,
	requestId: string,
	handle: string,
	questionId: number,
	text: string,
): Promise<ActionResult> {
	const task = taskByHandle(daemon.db, handle);
	if (!task) return unknownTask(handle);
	const question = daemon.db
		.query<
			{
				state: string;
				answeredBy: string | null;
				answeredAt: number | null;
				askedBy: string;
				text: string;
			},
			[number, number]
		>(
			`SELECT state, answered_by AS answeredBy, answered_at AS answeredAt,
				asked_by AS askedBy, text
			FROM questions WHERE id = ? AND task_id = ?`,
		)
		.get(questionId, task.id);
	if (!question) {
		return {
			ok: false,
			code: 'unknown_question',
			subject: 'No such question',
			detail: null,
		};
	}
	if (question.state === 'answered') {
		// `answered_by` is `bob (slack)`.
		const match = question.answeredBy?.match(/^(.*) \((.*)\)$/);
		return {
			ok: false,
			code: 'already_answered',
			subject: 'Already answered',
			detail: `${match?.[1] ?? question.answeredBy ?? 'someone'} answered in ${match?.[2] ?? 'another channel'} at ${clock(question.answeredAt ?? Date.now())}`,
		};
	}
	if (question.state !== 'open') {
		return {
			ok: false,
			code: 'question_closed',
			subject: 'Question closed',
			detail: `${task.handle} ended`,
		};
	}
	if (text.trim() === '') return empty();
	if (question.askedBy === 'watchdog') {
		return answerWatchdog(daemon, requestId, task, questionId, {
			question: question.text,
			answer: text,
		});
	}
	const seq =
		ingest(daemon, {
			channel: 'console',
			externalId: requestId,
			thread: null,
			kind: 'answer',
			author: { name: 'you', id: null, isBot: false, isSelf: false },
			text,
			mentionsAgent: true,
			data: { questionId },
			taskId: task.id,
		}) ?? daemon.feed.seq;
	// People waiting on its other threads hear about it through the Router.
	if (ownedChatThreads(daemon, task.id).length > 0) {
		toRouter(daemon, 'question_answered', task.id, task.handle, text, {
			question: questionId,
		});
	}
	return {
		ok: true,
		seq,
		subject: `Answered ${task.handle}`,
		detail: null,
	};
}

/**
 * The Watchdog paused the task. `Stop` stops it; anything else lets it go on,
 * with a note telling the Worker why it was paused and what you said.
 */
async function answerWatchdog(
	daemon: Daemon,
	requestId: string,
	task: { id: number; handle: string },
	questionId: number,
	reply: { question: string; answer: string },
): Promise<ActionResult> {
	const answer = reply.answer.trim();
	if (answer.toLowerCase() === 'stop') {
		daemon.db
			.query<unknown, Params>(
				`UPDATE questions SET state = 'answered', answer = $answer,
					answered_by = 'you (console)', answered_at = $at
				WHERE id = $id AND state = 'open'`,
			)
			.run({ answer, at: Date.now(), id: questionId });
		return stopTask(daemon, task.handle);
	}
	const why = reply.question.replace(/^Watchdog:\s*/, '');
	const note = [
		`The operator let you continue after the watchdog paused you. It said: ${why}`,
		answer.toLowerCase() === 'continue' ? null : `The operator adds: ${answer}`,
	]
		.filter((line) => line !== null)
		.join('\n\n');
	// A note from the operator answers the question and makes the task active.
	const seq =
		ingest(daemon, {
			channel: 'console',
			externalId: requestId,
			thread: null,
			kind: 'note',
			author: { name: 'you', id: null, isBot: false, isSelf: false },
			text: note,
			mentionsAgent: true,
			taskId: task.id,
		}) ?? daemon.feed.seq;
	return {
		ok: true,
		seq,
		subject: `Answered ${task.handle}`,
		detail: null,
	};
}

async function stopTask(daemon: Daemon, handle: string): Promise<ActionResult> {
	const task = taskByHandle(daemon.db, handle);
	if (!task) return unknownTask(handle);
	if (task.state === 'active' || task.state === 'needs_you') {
		const stopped = await stopAndWait(daemon, task.id, {
			state: 'stopped',
			result: 'stopped by you',
			dismiss: false,
			tellRouter: true,
		});
		return stopped
			? {
					ok: true,
					seq: daemon.feed.seq,
					subject: `Stopped ${task.handle}`,
					detail: null,
				}
			: {
					ok: false,
					code: 'timeout',
					subject: `Couldn't stop ${task.handle}`,
					detail: "the agent didn't confirm within 10 s",
				};
	}
	// Dismissing a failed task is a stop.
	if (
		task.state === 'failed' &&
		task.dismissed === 0 &&
		endTask(daemon, task.id, {
			state: 'stopped',
			result: 'stopped by you',
			dismiss: true,
			tellRouter: false,
		})
	) {
		return {
			ok: true,
			seq: daemon.feed.seq,
			subject: `Dismissed ${task.handle}`,
			detail: null,
		};
	}
	return {
		ok: false,
		code: 'not_running',
		subject: `${task.handle} already ended`,
		detail: `it was ${task.dismissed === 1 ? 'dismissed' : task.state} at ${clock(task.endedAt ?? Date.now())}`,
	};
}

function resumeTasks(daemon: Daemon, handles: string[] | null): ActionResult {
	const resumed = resume(
		daemon,
		handles === null
			? null
			: handles.map((handle) => handle.trim().replace(/^@/, '').toLowerCase()),
	);
	if (resumed.length === 0) {
		return {
			ok: false,
			code: 'nothing_failed',
			subject: 'No failed tasks',
			detail: null,
		};
	}
	return {
		ok: true,
		seq: daemon.feed.seq,
		subject: `Resumed ${resumed.length} ${resumed.length === 1 ? 'task' : 'tasks'}`,
		detail: resumed.join(', '),
	};
}

function empty(): ActionResult {
	return {
		ok: false,
		code: 'empty',
		subject: 'Nothing to send',
		detail: null,
	};
}

function unknownTask(handle: string): ActionResult {
	return {
		ok: false,
		code: 'unknown_task',
		subject: `No task ${handle}`,
		detail: null,
	};
}

function clock(at: number): string {
	return new Date(at).toTimeString().slice(0, 5);
}

function isActionType(type: string): type is Action['type'] {
	return ACTION_TYPES.has(type);
}

function malformed(message: string): ActionOutcome {
	return { ok: false, code: 'bad_request', message };
}
