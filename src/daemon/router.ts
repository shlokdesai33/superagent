// The Router's calls and tools run one after another by design.
/* oxlint-disable eslint/no-await-in-loop */
import type { Database } from 'bun:sqlite';
import type {
	AssistantMessage,
	ChatRequest,
	ToolCall,
} from '../particle/types.ts';
import { ACCOUNT_RETRY_MS, ModelError, callModel } from './model.ts';
import { defaultRepo, eventFolder } from './repos.ts';
import { ROUTER_TOOLS, runRouterTool } from './router-tools.ts';
import {
	type Item,
	appendItems,
	compact,
	lastPromptTokens,
	nextSeq,
	promptMessages,
	repairTranscript,
	repairTranscripts,
	routerSessionId,
	sendable,
	userItem,
} from './session.ts';
import {
	type Daemon,
	type MessageRow,
	type Params,
	cut,
	health,
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
const BACKOFF_MS = { base: 30_000, cap: 10 * 60_000 };
const EVENT_TEXT_CHARS = 2_000;
const CONTEXT_MESSAGES = 2;
const CONTEXT_CHARS = 200;
const OPEN_TASKS_SHOWN = 30;
const REPORT_CHARS = 500;

const CUT_OFF_NUDGE =
	'Your last response was cut off at the output limit. Finish deciding: call the tools you need, or end without tool calls to stay silent.';

const silentNudge = (events: number[], failed: boolean) =>
	`${events.map((id) => `#${id}`).join(', ')} ${events.length === 1 ? 'is a message' : 'are messages'} from the operator in the console, and they hear nothing unless you call reply. ${failed ? 'A tool call above failed: fix it and try again, or reply saying what went wrong. ' : ''}Start the work they asked for, or reply in the console with what happens next.`;

// Sent first on every call and never changed at runtime, with the tool
// schemas: Particle caches the prompt's prefix.
const SYSTEM_PROMPT = `You are the Router of a local AI agent working for one person, the operator. People reach it on threads: \`console\` is the operator's terminal; others look like \`script:support/77\` or \`github:acme/app#42\` (#42 to the operator).

Each user message lists new events (#42 is event 42), oldest first, then any open tasks and repositories. Handle each event with your tools.

- You coordinate and never do the work: you have no shell, files or network. Real work (code, research, writing, anything beyond a moment) goes to a task: start_task with clear instructions, or send_to_task for one already on it.
- For a request on a thread other than the console, including a GitHub issue or PR, give that thread to the task (start_task or send_to_task's threads); its later messages and changes then go straight to it.
- Have a task push or open a PR only when the operator asked for one or it follows a GitHub issue or PR.
- People hear you only through reply; your plain text is private. Reply on the thread the people are in.
- Stay silent when nothing needs saying, but a console message from the operator always needs a reply or a task. Answer quick questions directly.
- Replies are short and say what happens next: who is doing what, or what you need.
- Workers' questions on console tasks go to the operator, who already sees them and answers them: don't repeat or answer them yourself, and send a task only an answer the operator gave you.
- GitHub activity and task reports (finished, failed, reported) reach you as task events. Tell the operator in the console when they'd want to know; reply on GitHub when the people there should hear something, such as what was fixed or an answer to their question.
- Old context isn't in front of you: look it up with read_trigger, read_thread, read_task and list_tasks instead of guessing.
- More events may arrive while you decide. Handle each once.
- End your turn with no tool calls. A response whose only calls are replies also ends it, so make any other calls first or alongside.`;

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
		const wake = woken;
		woken = null;
		wake?.();
	};
	// `null` sleeps until woken. A timed sleep ignores wakes, so new events
	// don't cut a pause or backoff short, unless `endEarly` says to.
	const sleep = (ms: number | null, endEarly: (() => boolean) | null = null) =>
		new Promise<void>((resolve) => {
			const done = () => {
				if (timer) clearTimeout(timer);
				signal.removeEventListener('abort', done);
				if (woken === check) woken = null;
				resolve();
			};
			const check = () => {
				if (endEarly?.()) done();
				else woken = check;
			};
			const timer = ms === null ? null : setTimeout(done, ms);
			if (ms === null) woken = done;
			else if (endEarly) woken = check;
			signal.addEventListener('abort', done, { once: true });
		});

	const batch = async () => {
		const opened = openBatch(daemon);
		const { id: batchId } = opened;
		const actions: string[] = [];
		const currentFrom = nextSeq(daemon.db, sessionId);
		const failures: string[] = [];
		const fromConsole = consoleMessages(daemon.db, opened.events);
		let nudged = false;
		let callLimit = MAX_CALLS_PER_BATCH;
		let pending: Item[] = [];
		try {
			pending.push(render(daemon, opened.events, true));
			for (let call = 1; call <= callLimit; call++) {
				if (call > 1) {
					const drained = takeEvents(daemon.db, batchId, BATCH_EVENTS);
					if (drained.length > 0) {
						fromConsole.push(...consoleMessages(daemon.db, drained));
						pending.push(render(daemon, drained, false));
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
						...promptMessages(daemon.db, sessionId, SYSTEM_PROMPT, currentFrom),
						...pending.map((item) => sendable(item, true)),
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
					if (result.finishReason === 'length') {
						pending = [userItem(CUT_OFF_NUDGE)];
						continue;
					}
					// The operator asked for something; once, say silence isn't an
					// answer, with a call of its own even after the last allowed one.
					if (!nudged && actions.length === 0 && fromConsole.length > 0) {
						nudged = true;
						if (call === callLimit) callLimit += 1;
						daemon.log('info', 'router nudged to answer the console', {
							batch: batchId,
							events: fromConsole,
						});
						pending = [userItem(silentNudge(fromConsole, failures.length > 0))];
						continue;
					}
					break;
				}
				let onlyReplies = true;
				for (const toolCall of calls) {
					const ran = runTool(daemon, sessionId, batchId, toolCall);
					if (ran.action !== null && !actions.includes(ran.action))
						actions.push(ran.action);
					if (ran.failure !== null) failures.push(ran.failure);
					if (toolCall.function.name !== 'reply' || ran.failure !== null) {
						onlyReplies = false;
					}
				}
				// Saves a call that would only end the turn. Events that arrived
				// meanwhile start the next batch.
				if (onlyReplies) break;
			}
		} catch (error) {
			daemon.db.transaction(() => putBack(daemon.db, batchId))();
			daemon.router.batch = null;
			routerChanged(daemon);
			throw error;
		}

		const size = daemon.router.batch?.size ?? opened.events.length;
		const [lastFailure] = failures.slice(-1);
		const summary =
			actions.length > 0
				? actions.join(' · ')
				: `stayed silent on ${size} ${size === 1 ? 'event' : 'events'}${lastFailure ? ` · ${cut(lastFailure, 160)}` : ''}`;
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
				if (daemon.router.failing !== null) {
					daemon.router.failing = null;
					daemon.feed.publish({ type: 'health', health: health(daemon) });
				}
			} catch (error) {
				if (signal.aborted) break;
				const model = error instanceof ModelError ? error : null;
				let delay: number;
				if (model?.failure === 'account') {
					delay = ACCOUNT_RETRY_MS;
				} else {
					delay = Math.min(BACKOFF_MS.cap, BACKOFF_MS.base * 2 ** failures);
					failures += 1;
				}
				const message = error instanceof Error ? error.message : String(error);
				daemon.log(model ? 'warn' : 'error', 'router batch put back', {
					error:
						model?.message ??
						(error instanceof Error ? (error.stack ?? message) : message),
					retryInSeconds: delay / 1000,
				});
				// Particle's failures show in the model's health; anything else is
				// the agent's own, and shows as a problem until a batch succeeds.
				if (model === null) {
					daemon.router.failing = {
						error: message,
						since: daemon.router.failing?.since ?? Date.now(),
					};
					daemon.feed.publish({ type: 'health', health: health(daemon) });
				}
				daemon.router.heldBecause = model?.message ?? message;
				daemon.router.backoffUntil = Date.now() + delay;
				routerChanged(daemon);
				// After a transient failure, Particle leaving `error` (a call or the
				// probe) ends the backoff; after an account failure, a new key does.
				const key = daemon.particleKey;
				await sleep(
					delay,
					model?.failure === 'transient'
						? () => daemon.model.state !== 'error'
						: model?.failure === 'account'
							? () => daemon.particleKey !== key
							: null,
				);
				daemon.router.backoffUntil = null;
				daemon.router.heldBecause = null;
				routerChanged(daemon);
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

/**
 * A batch's console messages from the operator, by event number, leaving out
 * those an interrupted attempt already acted on: it may have answered them.
 */
function consoleMessages(db: Database, events: EventRow[]): number[] {
	return events
		.filter(
			(event) =>
				event.channel === 'console' &&
				event.kind === 'message' &&
				(event.batchId === null || !actedIn(db, event.batchId)),
		)
		.map((event) => event.id);
}

/** Whether a batch, or an interrupted one before it with the same events, replied or acted. */
function actedIn(db: Database, batchId: number): boolean {
	const row = db
		.query<{ summary: string | null }, [number]>(
			'SELECT summary FROM router_batches WHERE id = ?',
		)
		.get(batchId);
	return row !== null && row.summary !== null;
}

/**
 * Runs one tool call and stores its result in one transaction, then publishes
 * what it sent. `failure` is `start_task failed: …` for a call that errored.
 */
function runTool(
	daemon: Daemon,
	sessionId: number,
	batchId: number,
	call: ToolCall,
): { action: string | null; failure: string | null } {
	const outcome = daemon.db.transaction(() => {
		const ran = runRouterTool(daemon, batchId, call);
		appendItems(daemon.db, sessionId, [
			{ role: 'tool', tool_call_id: call.id, content: ran.result },
		]);
		// With the action itself, so an attempt interrupted after it (by a
		// crash or Particle) is known to have acted.
		if (ran.action !== null) {
			daemon.db
				.query<unknown, Params>(
					`UPDATE router_batches SET summary = COALESCE(summary || ' · ', '') || $action
					WHERE id = $id`,
				)
				.run({ action: ran.action, id: batchId });
		}
		return ran;
	})();
	daemon.log('info', 'router tool', {
		batch: batchId,
		tool: call.function.name,
		result: cut(outcome.result, 200),
	});
	for (const message of outcome.messages) publishMessage(daemon, message);
	return {
		action: outcome.action,
		failure: outcome.result.startsWith('error: ')
			? `${call.function.name} failed: ${outcome.result.slice('error: '.length)}`
			: null,
	};
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
		// What an interrupted attempt did carries over, in case this one is
		// interrupted too.
		const inherit = db.query<unknown, Params>(
			`UPDATE router_batches SET summary = COALESCE(summary,
				(SELECT summary FROM router_batches WHERE id = $earlier))
			WHERE id = $batchId`,
		);
		for (const earlier of new Set(events.map((event) => event.batchId))) {
			if (earlier !== null) inherit.run({ earlier, batchId });
		}
		return events;
	})();
}

/**
 * The batch message (§5.4): the events, then on the first one the open tasks
 * and repositories, when there are any.
 */
function render(daemon: Daemon, events: EventRow[], withState: boolean): Item {
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
		const repo = defaultRepo(event.data);
		const folder = eventFolder(event.data);
		if (repo !== null) {
			lines.push(
				`  default repository: ${repo} (the operator's terminal is in it)`,
			);
		} else if (folder !== null) {
			lines.push(`  terminal folder: ${folder}`);
		}
		const earlier = earlierMessages(db, event);
		if (earlier) lines.push(`  earlier in this thread: ${earlier}`);
		lines.push('');
	}

	const content = lines.join('\n').trimEnd();
	if (!withState) return userItem(content);
	return userItem(
		content,
		[...openTasks(daemon), ...repositories(daemon)].join('\n'),
	);
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
	if (tasks.length === 0) return [];
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
				? `; follows ${task.threads.map((thread) => thread.id).join(', ')}`
				: task.origin.channel === 'console'
					? ''
					: `; from ${task.origin.channel}`;
		lines.push(`  ${task.handle} ${status}: ${task.title}${follows}`);
	}
	if (total > OPEN_TASKS_SHOWN) {
		lines.push(`  … and ${total - OPEN_TASKS_SHOWN} more [list_tasks]`);
	}
	return lines;
}

/** Where code tasks can work, by the names `start_task` takes as `repo`. */
function repositories(daemon: Daemon): string[] {
	const { repos } = daemon.config;
	if (repos.length === 0) return [];
	const onGitHub = daemon.github.repos;
	const line = `Repositories: ${repos
		.map((repo) => {
			const github = onGitHub.find((entry) => entry.name === repo.name);
			return github ? `${repo.name} (GitHub ${github.fullName})` : repo.name;
		})
		.join(', ')}`;
	const [only] = onGitHub;
	return onGitHub.length === 1 && only
		? [line, `#42 means github:${only.fullName}#42.`]
		: [line];
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
			return [head('asked the operator'), indent(event.text)];
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
