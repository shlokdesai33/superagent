// The Router's calls and tools run one after another by design.
/* oxlint-disable eslint/no-await-in-loop */
import type { Database } from 'bun:sqlite';
import type {
	AssistantMessage,
	ChatRequest,
	ToolCall,
} from '../particle/types.ts';
import { ModelError, callModel } from './model.ts';
import { ROUTER_TOOLS, runRouterTool } from './router-tools.ts';
import {
	type Item,
	appendItems,
	compact,
	lastPromptTokens,
	promptMessages,
	repairTranscript,
	repairTranscripts,
	routerSessionId,
	userItem,
} from './session.ts';
import {
	type Daemon,
	type MessageRow,
	type Params,
	cut,
	routerChanged,
	toMessage,
} from './state.ts';
import { TASK_COLUMNS, type TaskRow, taskSummary } from './task-feed.ts';

const EFFORT = 'high';
// Reasoning counts against this cap, and the Router thinks at `high`.
const MAX_COMPLETION_TOKENS = 16_000;
const BATCH_EVENTS = 20;
const MAX_CALLS_PER_BATCH = 10;
const COMPACT_AT_PROMPT_TOKENS = 200_000;
const ACCOUNT_RETRY_MS = 2 * 60_000;
const BACKOFF_MS = { base: 30_000, cap: 10 * 60_000 };
const EVENT_TEXT_CHARS = 2_000;
const CONTEXT_MESSAGES = 2;
const CONTEXT_CHARS = 200;
const OPEN_TASKS_SHOWN = 30;
const REPORT_CHARS = 500;

const CUT_OFF_NUDGE =
	'Your last response was cut off at the output limit. Finish deciding: call the tools you need, or end without tool calls to stay silent.';

const SYSTEM_PROMPT = `You are the Router of a local AI agent that works for one person, the operator. People reach the agent through channels, each with threads (conversations). The console, the operator's terminal, has one thread, \`console\`. Other threads have IDs such as \`script:support/77\`.

Each user message lists new events (#42 is event 42), oldest first, followed by the open tasks. Decide what each event needs, then act through your tools.

- You coordinate. You never do the work yourself, and you have no shell, files or network. Real work (code, research, writing, anything that takes more than a moment) goes to a task: start_task with clear instructions, or send_to_task to add to a task that's already on it.
- When a request comes from a thread other than the console, pass that thread to start_task so the task follows it; its later messages go straight to the task. Reply on the thread the people are in.
- People hear you only through reply. Your plain text is private notes that nobody reads.
- Stay silent when nothing needs saying: end without calling reply.
- Chat replies, including the console, are short (at most 100 words) and say what happens next: who is doing what, or what you need.
- Answer quick questions directly with reply when no work is needed.
- Workers' questions for console tasks are already shown to the operator; don't repeat them.
- Tasks report back as events (finished, failed, reported). Tell the people who asked when there's something they'd want to know, briefly.
- Old context isn't in front of you. Look it up with read_trigger, read_thread, read_task and list_tasks instead of guessing.
- Several events may arrive together, and more may arrive while you decide. Handle each one, and don't answer the same thing twice.
- When you're done, end your turn without tool calls.`;

/**
 * Before the loop starts: a batch left `running` by a crash becomes
 * `interrupted`, and its events go back to the mailbox. They keep its
 * `batch_id`, so the next batch can say which replies were already sent.
 */
export function recoverRouter(daemon: Daemon): void {
	const { db } = daemon;
	const recovered = db.transaction(() => {
		const batches = db
			.query<{ id: number }, []>(
				"SELECT id FROM router_batches WHERE state = 'running'",
			)
			.all();
		for (const { id } of batches) putBack(db, id);
		return { batches: batches.length, toolResults: repairTranscripts(db) };
	})();
	if (recovered.batches > 0 || recovered.toolResults > 0) {
		daemon.log('info', 'recovered the router', recovered);
	}
}

function putBack(db: Database, batchId: number): void {
	db.query<unknown, Params>(
		"UPDATE router_batches SET state = 'interrupted', ended_at = $at WHERE id = $id",
	).run({ at: Date.now(), id: batchId });
	db.query<unknown, [number]>(
		"UPDATE events SET consumed_at = NULL WHERE batch_id = ? AND route = 'router'",
	).run(batchId);
}

export type RouterLoop = { stop(): Promise<void> };

/**
 * Runs the Router until stopped: sleeps until the mailbox has events, decides
 * them in batches, and keeps them in the mailbox while Particle fails.
 */
export function startRouter(daemon: Daemon): RouterLoop {
	const controller = new AbortController();
	const { signal } = controller;
	const sessionId = routerSessionId(daemon.db);
	const cacheKey = `router-${daemon.agent.id}`;
	let needsCompaction =
		lastPromptTokens(daemon.db, sessionId, 'router') > COMPACT_AT_PROMPT_TOKENS;
	let woken: (() => void) | null = null;
	daemon.router.wake = () => {
		woken?.();
		woken = null;
	};
	// `null` sleeps until woken. A timed sleep ignores wakes, so new events
	// don't cut a pause or backoff short.
	const sleep = (ms: number | null) =>
		new Promise<void>((resolve) => {
			const done = () => {
				if (timer) clearTimeout(timer);
				signal.removeEventListener('abort', done);
				resolve();
			};
			const timer = ms === null ? null : setTimeout(done, ms);
			if (ms === null) woken = done;
			signal.addEventListener('abort', done, { once: true });
		});

	const batch = async () => {
		const opened = openBatch(daemon);
		const { id: batchId } = opened;
		const actions: string[] = [];
		let pending: Item[] = [userItem(render(daemon, opened.events, true))];
		try {
			for (let call = 1; call <= MAX_CALLS_PER_BATCH; call++) {
				if (call > 1) {
					const drained = takeEvents(daemon.db, batchId, BATCH_EVENTS);
					if (drained.length > 0) {
						pending.push(userItem(render(daemon, drained, false)));
						if (daemon.router.batch) {
							daemon.router.batch.size += drained.length;
						}
						routerChanged(daemon);
						daemon.log('info', 'router took more events', {
							batch: batchId,
							events: drained.map((event) => event.id),
						});
					}
				}
				// A tool that threw left its call, and any after it, without results.
				const repaired = repairTranscript(
					daemon.db,
					sessionId,
					'not run: the agent hit an error',
				);
				if (repaired > 0) {
					daemon.log('info', 'repaired the router transcript', {
						toolResults: repaired,
					});
				}
				if (needsCompaction) {
					await compact(daemon, { sessionId, taskId: null, cacheKey, signal });
					needsCompaction = false;
				}

				const request: ChatRequest = {
					reasoning_effort: EFFORT,
					max_completion_tokens: MAX_COMPLETION_TOKENS,
					prompt_cache_key: cacheKey,
					tools: ROUTER_TOOLS,
					messages: [
						...promptMessages(daemon.db, sessionId, SYSTEM_PROMPT),
						...pending,
					],
				};
				const result = await callModel(daemon, {
					sessionId,
					taskId: null,
					purpose: 'router',
					request,
					signal,
				});
				needsCompaction =
					(result.usage?.prompt_tokens ?? 0) > COMPACT_AT_PROMPT_TOKENS;

				const calls = result.message.tool_calls ?? [];
				for (const [index, toolCall] of calls.entries()) {
					toolCall.id ||= `call_${batchId}_${call}_${index}`;
				}
				const assistant: AssistantMessage & { reasoning_content?: string } =
					calls.length > 0
						? {
								role: 'assistant',
								content: result.message.content,
								tool_calls: calls,
							}
						: { role: 'assistant', content: result.message.content };
				if (result.reasoning) assistant.reasoning_content = result.reasoning;
				// Input is stored with the response it produced, so a failed call
				// leaves nothing unanswered in the transcript.
				appendItems(daemon.db, sessionId, [...pending, assistant]);
				pending = [];

				if (calls.length === 0) {
					if (result.finishReason !== 'length') break;
					pending = [userItem(CUT_OFF_NUDGE)];
					continue;
				}
				for (const toolCall of calls) {
					const action = runTool(daemon, sessionId, batchId, toolCall);
					if (action !== null && !actions.includes(action))
						actions.push(action);
				}
			}
		} catch (error) {
			daemon.db.transaction(() => putBack(daemon.db, batchId))();
			daemon.router.batch = null;
			routerChanged(daemon);
			throw error;
		}

		const size = daemon.router.batch?.size ?? opened.events.length;
		const summary =
			actions.length > 0
				? actions.join(' · ')
				: `stayed silent on ${size} ${size === 1 ? 'event' : 'events'}`;
		daemon.db
			.query<unknown, Params>(
				"UPDATE router_batches SET state = 'done', ended_at = $at, summary = $summary WHERE id = $id",
			)
			.run({ at: Date.now(), summary, id: batchId });
		daemon.router.batch = null;
		routerChanged(daemon);
		daemon.log('info', 'router batch done', {
			batch: batchId,
			events: size,
			summary,
		});
	};

	const loop = (async () => {
		let failures = 0;
		while (!signal.aborted) {
			if (daemon.particle === null || mailboxSize(daemon.db) === 0) {
				await sleep(null);
				continue;
			}
			try {
				await batch();
				failures = 0;
			} catch (error) {
				if (signal.aborted) break;
				let delay: number;
				if (error instanceof ModelError && error.failure === 'account') {
					delay = ACCOUNT_RETRY_MS;
				} else {
					delay = Math.min(BACKOFF_MS.cap, BACKOFF_MS.base * 2 ** failures);
					failures += 1;
				}
				daemon.log(
					error instanceof ModelError ? 'warn' : 'error',
					'router batch put back',
					{
						error:
							error instanceof ModelError
								? error.message
								: error instanceof Error
									? (error.stack ?? error.message)
									: String(error),
						retryInSeconds: delay / 1000,
					},
				);
				await sleep(delay);
			}
		}
	})();

	return {
		async stop() {
			controller.abort();
			await loop;
		},
	};
}

function mailboxSize(db: Database): number {
	return (
		db
			.query<{ count: number }, []>(
				"SELECT COUNT(*) AS count FROM events WHERE route = 'router' AND consumed_at IS NULL",
			)
			.get()?.count ?? 0
	);
}

/** Runs one tool call and stores its result in one transaction, then publishes what it sent. */
function runTool(
	daemon: Daemon,
	sessionId: number,
	batchId: number,
	call: ToolCall,
): string | null {
	const outcome = daemon.db.transaction(() => {
		const ran = runRouterTool(daemon, batchId, call);
		appendItems(daemon.db, sessionId, [
			{ role: 'tool', tool_call_id: call.id, content: ran.result },
		]);
		return ran;
	})();
	daemon.log('info', 'router tool', {
		batch: batchId,
		tool: call.function.name,
		result: cut(outcome.result, 200),
	});
	for (const message of outcome.messages) publishMessage(daemon, message);
	return outcome.action;
}

function publishMessage(daemon: Daemon, message: MessageRow): void {
	daemon.feed.publish({ type: 'message', message: toMessage(message) });
}

type EventRow = {
	id: number;
	at: number;
	channel: string;
	threadId: string | null;
	threadTitle: string | null;
	ownable: number | null;
	owner: string | null;
	kind: string;
	author: string;
	text: string;
	task: string | null;
	data: string | null;
	/** The interrupted batch that took it before, if any. */
	batchId: number | null;
};

const EVENT_COLUMNS = `e.id, e.received_at AS at, e.channel, e.thread_id AS threadId,
	th.title AS threadTitle, th.ownable, o.handle AS owner, e.kind, e.author, e.text,
	t.handle AS task, e.data, e.batch_id AS batchId
	FROM events e
	LEFT JOIN threads th ON th.id = e.thread_id
	LEFT JOIN tasks o ON o.id = th.owner_task_id
	LEFT JOIN tasks t ON t.id = e.task_id`;

function openBatch(daemon: Daemon): { id: number; events: EventRow[] } {
	const { db } = daemon;
	const since = Date.now();
	const opened = db.transaction(() => {
		const id = Number(
			db
				.query<unknown, [number]>(
					"INSERT INTO router_batches (state, started_at) VALUES ('running', ?)",
				)
				.run(since).lastInsertRowid,
		);
		return { id, events: takeEvents(db, id, BATCH_EVENTS) };
	})();
	daemon.router.batch = { id: opened.id, since, size: opened.events.length };
	routerChanged(daemon);
	daemon.log('info', 'router batch opened', {
		batch: opened.id,
		events: opened.events.map((event) => event.id),
	});
	return opened;
}

/** Takes up to `limit` mailbox events, oldest first, into the batch. */
function takeEvents(db: Database, batchId: number, limit: number): EventRow[] {
	return db.transaction(() => {
		const events = db
			.query<EventRow, [number]>(
				`SELECT ${EVENT_COLUMNS} WHERE e.route = 'router' AND e.consumed_at IS NULL
				ORDER BY e.id LIMIT ?`,
			)
			.all(limit);
		const stamp = db.query<unknown, Params>(
			'UPDATE events SET batch_id = $batchId, consumed_at = $at WHERE id = $id',
		);
		const at = Date.now();
		for (const event of events) stamp.run({ batchId, at, id: event.id });
		return events;
	})();
}

/** The batch message (§5.4): the events, then the open tasks on the first one. */
function render(
	daemon: Daemon,
	events: EventRow[],
	withTasks: boolean,
): string {
	const { db } = daemon;
	const lines: string[] = [];
	const interrupted = [
		...new Set(
			events.flatMap((event) =>
				event.batchId === null ? [] : [event.batchId],
			),
		),
	];
	if (interrupted.length > 0) {
		const replies = db
			.query<{ at: number; thread: string | null; text: string }, []>(
				`SELECT m.at, th.title AS thread, m.text FROM messages m
				LEFT JOIN threads th ON th.id = m.thread_id
				WHERE m.direction = 'out' AND m.batch_id IN (${interrupted.join(', ')})
				ORDER BY m.id`,
			)
			.all();
		lines.push(
			'An earlier attempt to decide these was interrupted. Replies already sent:',
			...(replies.length > 0
				? replies.map(
						(reply) =>
							`  ${reply.thread ?? 'no thread'} · ${clock(reply.at)}: ${JSON.stringify(reply.text)}`,
					)
				: ['  none']),
			'',
		);
	}

	lines.push(
		`${events.length} new ${events.length === 1 ? 'event' : 'events'}`,
		'',
	);
	for (const event of events) {
		if (event.channel === 'internal' && event.task !== null) {
			lines.push(...taskEvent(event, event.task), '');
			continue;
		}
		lines.push(eventHeader(event));
		const text = cut(event.text, EVENT_TEXT_CHARS);
		const spill =
			text.length < event.text.length
				? ` [${text.length.toLocaleString('en-US')} of ${event.text.length.toLocaleString('en-US')} characters; read_trigger ${event.id} for the rest]`
				: '';
		lines.push(indent(`${text}${spill}`));
		const earlier = earlierMessages(db, event);
		if (earlier) lines.push(`  earlier in this thread: ${earlier}`);
		lines.push('');
	}

	if (withTasks) lines.push(...openTasks(daemon), repositories(daemon));
	return lines.join('\n').trimEnd();
}

function eventHeader(event: EventRow): string {
	const parts = [`#${event.id}`, event.channel];
	if (event.threadId !== null && event.threadId !== event.channel) {
		parts.push(
			`${event.threadTitle ?? event.threadId} (${event.threadId}, ${event.owner ? `owned by ${event.owner}` : 'no owner'})`,
		);
	}
	if (event.channel === 'internal') parts.push(event.kind);
	parts.push(
		event.task && event.channel === 'internal'
			? `task ${event.task}`
			: event.author,
	);
	parts.push(clock(event.at));
	return parts.join(' · ');
}

/**
 * Up to 2 messages before the event on its thread. Not for the console home
 * thread, whose history is the Router's own transcript.
 */
function earlierMessages(db: Database, event: EventRow): string | null {
	if (event.threadId === null || event.ownable !== 1) return null;
	const messages = db
		.query<{ author: string; at: number; text: string }, Params>(
			`SELECT author, at, text FROM messages
			WHERE thread_id = $threadId
				AND id < COALESCE((SELECT MIN(id) FROM messages WHERE event_id = $eventId), 9e18)
			ORDER BY id DESC LIMIT $limit`,
		)
		.all({
			threadId: event.threadId,
			eventId: event.id,
			limit: CONTEXT_MESSAGES,
		})
		.toReversed();
	if (messages.length === 0) return null;
	return messages
		.map(
			(message) =>
				`${message.author} ${clock(message.at)} ${JSON.stringify(cut(message.text.replaceAll(/\s+/g, ' '), CONTEXT_CHARS))}`,
		)
		.join(' · ');
}

function openTasks(daemon: Daemon): string[] {
	const tasks = daemon.db
		.query<TaskRow, [number]>(
			`SELECT ${TASK_COLUMNS} WHERE t.state IN ('active', 'needs_you') ORDER BY t.id LIMIT ?`,
		)
		.all(OPEN_TASKS_SHOWN + 1);
	if (tasks.length === 0) return ['Open tasks: none'];
	const total =
		daemon.db
			.query<{ count: number }, []>(
				"SELECT COUNT(*) AS count FROM tasks WHERE state IN ('active', 'needs_you')",
			)
			.get()?.count ?? tasks.length;
	const lines = [`Open tasks (${total}):`];
	for (const row of tasks.slice(0, OPEN_TASKS_SHOWN)) {
		const task = taskSummary(daemon, row);
		const status =
			task.status === 'waiting' && task.waitingOn
				? `waiting on ${task.waitingOn}`
				: task.status.replace('_', ' ');
		const follows =
			task.threads.length > 0
				? `follows ${task.threads.map((thread) => thread.id).join(', ')}`
				: task.origin.channel;
		lines.push(
			`  ${task.handle}  ${status.padEnd(9)}  ${task.title}  ${follows}`,
		);
	}
	if (total > OPEN_TASKS_SHOWN) {
		lines.push(`  … and ${total - OPEN_TASKS_SHOWN} more [list_tasks]`);
	}
	return lines;
}

/** Where code tasks can work; `start_task` takes one as `repo`. */
function repositories(daemon: Daemon): string {
	const { repos } = daemon.config;
	if (repos.length === 0) return 'Repositories: none configured';
	return `Repositories: ${repos.map((repo) => `${repo.name} (${repo.path})`).join(', ')}${repos.length === 1 ? '; start_task uses it unless you pass repo: "none"' : '; start_task needs repo'}`;
}

/** Worker reports are cut at 500 characters, with a pointer to the rest. */
function withPointer(text: string, pointer: string): string {
	const shown = cut(text, REPORT_CHARS);
	return shown.length < text.length
		? `${shown} [${text.length.toLocaleString('en-US')} characters; ${pointer}]`
		: shown;
}

/** A Worker's report to the Router: finished, failed, asked, reported. */
function taskEvent(event: EventRow, handle: string): string[] {
	const head = (what: string) =>
		`#${event.id} · task ${handle} ${what} · ${clock(event.at)}`;
	const data: unknown = event.data === null ? null : JSON.parse(event.data);
	const report =
		typeof data === 'object' &&
		data !== null &&
		'report' in data &&
		typeof data.report === 'string'
			? data.report
			: null;
	switch (event.kind) {
		case 'task_finished':
			return [
				head('finished'),
				indent(`result: ${cut(event.text.split('\n')[0] ?? '', 200)}`),
				...(report
					? [indent(`report: ${withPointer(report, `read_task ${handle}`)}`)]
					: []),
			];
		case 'task_failed':
			return [head('failed'), indent(event.text)];
		case 'task_stopped':
			return [head('was stopped by the operator'), indent(event.text)];
		case 'task_question':
			return [head('asked'), indent(event.text)];
		case 'task_report':
			return [
				head('reported'),
				indent(withPointer(event.text, `read_trigger ${event.id}`)),
			];
		case 'thread_released':
			return [head(`released ${event.text}`)];
		case 'question_answered':
			return [head('had its question answered'), indent(event.text)];
		default:
			return [
				head(event.kind),
				indent(withPointer(event.text, `read_trigger ${event.id}`)),
			];
	}
}

function indent(text: string): string {
	return text
		.split('\n')
		.map((line) => `  ${line}`)
		.join('\n');
}

function clock(at: number): string {
	return new Date(at).toTimeString().slice(0, 5);
}
