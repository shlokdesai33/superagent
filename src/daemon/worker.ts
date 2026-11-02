// A Worker's calls and tools run one after another by design.
/* oxlint-disable eslint/no-await-in-loop */
import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import type { ChatResult } from '../particle/client.ts';
import type { AssistantMessage, ToolCall } from '../particle/types.ts';
import { stopCommand } from './commands.ts';
import { prepareWorktree } from './git.ts';
import { ModelError, callModel, pausedOn } from './model.ts';
import {
	type Item,
	appendItems,
	compact,
	lastPromptTokens,
	promptMessages,
	repairTranscript,
	userItem,
} from './session.ts';
import { type Daemon, type Params, type WorkerLive, cut } from './state.ts';
import {
	type TaskRow,
	publishStep,
	slotsChanged,
	taskChanged,
	taskRow,
	workingTasks,
} from './task-feed.ts';
import { endTask } from './tasks.ts';
import { redact } from './secrets.ts';
import { WORKER_TOOLS, runWorkerTool } from './worker-tools.ts';

const EFFORT = 'high';
const MAX_COMPLETION_TOKENS = 32_000;
const COMPACT_AT_PROMPT_TOKENS = 300_000;
// A crude guard until the Watchdog exists.
const STEP_LIMIT = 500;
const ACCOUNT_RETRY_MS = 2 * 60_000;
const NOTE_CHARS = 200;
const SLOT = 'a free worker slot';
const NUDGE = 'Call finish, ask or wait_for to say what happens next.';

const PROMPT_START = `You are a Worker of a local AI agent. You carry out one task on the operator's machine with your tools. The Router, another model, gave you the task and talks to people for you.

- You never talk to people. Use report for progress the Router may want to pass on, and ask only when you need a decision from the operator.
- Before each batch of tool calls, write one short line saying what you found or what you're about to do. The operator sees it as a step.
- Commands run with bash in your working folder. run waits up to 30 seconds; a longer command keeps running in the background and its result arrives as a message, so you can keep working meanwhile.
`;

const PROMPT_END = `- File tools take paths relative to your working folder. write_file and edit_file only write inside it.
- New messages (notes from the operator or the Router, answers to your questions, finished commands) arrive between your steps. Take them into account.
- Every response ends with tool calls. When you're waiting on something outside, call wait_for. When the task is complete, call finish with a one-line result (at most 80 characters) and, if useful, a markdown report.`;

const SANDBOXED =
	"- Commands run in a sandbox that keeps their writes inside your working folder, $TMPDIR, /tmp, package and tool caches and, in a worktree, the repository's git folder, so git and package installs work as usual. Reads and the network are open.";

/** Fixed for the daemon's life, so it stays cached. */
function systemPrompt(daemon: Daemon): string {
	const sandbox =
		daemon.sandbox.state === 'on'
			? SANDBOXED
			: `- Commands run unsandboxed on this machine (${daemon.sandbox.cause}), so nothing stops a command from changing files elsewhere. Keep writes inside your working folder and $TMPDIR.`;
	return `${PROMPT_START}${sandbox}\n${PROMPT_END}`;
}

/** Makes `daemon.runWorker` start or wake Worker loops. */
export function installWorkers(daemon: Daemon): void {
	daemon.runWorker = (taskId) => runWorker(daemon, taskId);
}

/** Starts the loops of every active task, after recovery. */
export function startWorkers(daemon: Daemon): void {
	for (const { id } of daemon.db
		.query<{ id: number }, []>("SELECT id FROM tasks WHERE state = 'active'")
		.all()) {
		runWorker(daemon, id);
	}
}

/** On shutdown: aborts every Worker, stops every command, and waits for both. */
export async function stopWorkers(daemon: Daemon): Promise<void> {
	daemon.stopping = true;
	const loops = [...daemon.workers.values()].map((live) => {
		live.controller.abort();
		return live.loop;
	});
	await Promise.all([
		...loops,
		...[...daemon.commands.keys()].map((step) => stopCommand(daemon, step)),
	]);
}

function runWorker(daemon: Daemon, taskId: number): void {
	if (daemon.stopping) return;
	const existing = daemon.workers.get(taskId);
	if (existing) {
		existing.wake();
		return;
	}
	const row = taskRow(daemon.db, taskId);
	if (!row || row.state !== 'active') return;

	const controller = new AbortController();
	let woken: (() => void) | null = null;
	const live: WorkerLive = {
		taskId,
		handle: row.handle,
		controller,
		wake: () => {
			woken?.();
			woken = null;
		},
		callSince: null,
		turn: false,
		blockedOn: null,
		loop: Promise.resolve(),
	};
	// `null` sleeps until woken; a timed sleep (a pause) ignores wakes.
	const sleep = (ms: number | null) =>
		new Promise<void>((resolve) => {
			const done = () => {
				if (timer) clearTimeout(timer);
				controller.signal.removeEventListener('abort', done);
				resolve();
			};
			const timer = ms === null ? null : setTimeout(done, ms);
			if (ms === null) woken = done;
			controller.signal.addEventListener('abort', done, { once: true });
		});

	daemon.workers.set(taskId, live);
	live.loop = workerLoop(daemon, live, sleep)
		.catch((error: unknown) => {
			const message = error instanceof Error ? error.message : String(error);
			daemon.log('error', 'worker crashed', {
				task: live.handle,
				error: error instanceof Error ? (error.stack ?? message) : message,
			});
			endTask(daemon, taskId, {
				state: 'failed',
				failure: `crashed: ${message}`,
			});
		})
		.finally(() => {
			if (daemon.workers.get(taskId) === live) daemon.workers.delete(taskId);
			if (live.turn) {
				live.turn = false;
				slotsChanged(daemon);
			}
			taskChanged(daemon, taskId);
			// Reopened while this loop was ending.
			if (taskRow(daemon.db, taskId)?.state === 'active') {
				runWorker(daemon, taskId);
			}
		});
}

async function workerLoop(
	daemon: Daemon,
	live: WorkerLive,
	sleep: (ms: number | null) => Promise<void>,
): Promise<void> {
	const { db } = daemon;
	const { signal } = live.controller;
	const sessionId = workerSessionId(db, live.taskId);
	const cacheKey = `task-${live.handle}`;
	let nudge = false;
	let nudged = false;
	let needsCompaction =
		lastPromptTokens(db, sessionId, 'worker') > COMPACT_AT_PROMPT_TOKENS;
	let worktreeChecked = false;

	while (!signal.aborted) {
		const task = taskRow(db, live.taskId);
		if (!task || task.state !== 'active') return;
		// A tool that threw, or a stop, can leave calls without results.
		repairTranscript(db, sessionId, 'not run: the agent hit an error');
		const first = lastRole(db, sessionId) === null;
		const inbox = inboxEvents(db, live.taskId);
		// After wait_for, only a new message is a reason to go on.
		const owed = task.waitingOn === null && lastRole(db, sessionId) === 'tool';
		if (!first && inbox.length === 0 && !owed && !nudge) {
			await sleep(null);
			continue;
		}
		if (daemon.particle === null) {
			setBlocked(daemon, live, 'Particle (no API key)');
			await sleep(null);
			continue;
		}
		if (task.modelCalls >= STEP_LIMIT) {
			endTask(daemon, live.taskId, {
				state: 'failed',
				failure: `hit the step limit (${STEP_LIMIT} model calls)`,
			});
			return;
		}
		let worktreeNote: string | null = null;
		if (task.repo === null) {
			mkdirSync(task.workDir, { recursive: true });
		} else if (!worktreeChecked || !existsSync(task.workDir)) {
			// Checked under the repository's lock once per loop, so a cleanup
			// removal in progress finishes first. Missing when new, or removed
			// while the task was ended.
			setBlocked(daemon, live, 'its git worktree');
			try {
				worktreeNote = await prepareWorktree(daemon, {
					handle: task.handle,
					repo: task.repo,
					workDir: task.workDir,
				});
			} catch (error) {
				endTask(daemon, live.taskId, {
					state: 'failed',
					failure: `couldn't create its git worktree: ${error instanceof Error ? error.message : String(error)}`,
				});
				return;
			}
			setBlocked(daemon, live, null);
			worktreeChecked = true;
			if (worktreeNote !== null) {
				daemon.log('info', 'worktree ready', {
					task: task.handle,
					path: task.workDir,
					note: worktreeNote,
				});
			}
			if (signal.aborted) return;
		}
		if (!(await takeSlot(daemon, live))) return;

		try {
			const input = [
				first ? brief(daemon, task, worktreeNote) : worktreeNote,
				inbox.length > 0 ? renderInbox(inbox) : null,
				nudge ? NUDGE : null,
			].filter((part) => part !== null);
			const pending: Item[] =
				input.length > 0 ? [userItem(input.join('\n\n'))] : [];

			live.callSince = Date.now();
			taskChanged(daemon, live.taskId);
			let result: ChatResult | null = null;
			let failure: unknown = null;
			try {
				if (needsCompaction) {
					await compact(daemon, {
						sessionId,
						taskId: live.taskId,
						cacheKey,
						signal,
					});
					needsCompaction = false;
				}
				result = await callModel(daemon, {
					sessionId,
					taskId: live.taskId,
					purpose: 'worker',
					signal,
					request: {
						reasoning_effort: EFFORT,
						max_completion_tokens: MAX_COMPLETION_TOKENS,
						prompt_cache_key: cacheKey,
						tools: WORKER_TOOLS,
						messages: [
							...promptMessages(db, sessionId, systemPrompt(daemon)),
							...pending,
						],
					},
				});
			} catch (error) {
				failure = error;
			}
			live.callSince = null;
			taskChanged(daemon, live.taskId);
			if (result === null) {
				if (signal.aborted) return;
				if (failure instanceof ModelError && failure.failure === 'account') {
					// Fixed by the operator, not the task: pause instead of failing.
					setBlocked(daemon, live, pausedOn(failure));
					releaseTurn(daemon, live);
					await sleep(ACCOUNT_RETRY_MS);
					continue;
				}
				endTask(daemon, live.taskId, {
					state: 'failed',
					failure:
						failure instanceof ModelError
							? failure.message
							: `crashed: ${failure instanceof Error ? failure.message : String(failure)}`,
				});
				return;
			}
			setBlocked(daemon, live, null);
			needsCompaction =
				(result.usage?.prompt_tokens ?? 0) > COMPACT_AT_PROMPT_TOKENS;

			const calls = result.message.tool_calls ?? [];
			const callNumber = task.modelCalls + 1;
			for (const [index, call] of calls.entries()) {
				call.id ||= `call_${live.handle}_${callNumber}_${index}`;
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
			// The input and its response are stored together, and the inbox counts
			// as consumed only then, so a failed call loses nothing.
			db.transaction(() => {
				appendItems(db, sessionId, [...pending, assistant]);
				const consumed = db.query<unknown, [number, number]>(
					'UPDATE events SET consumed_at = ? WHERE id = ?',
				);
				const at = Date.now();
				for (const event of inbox) consumed.run(at, event.id);
				db.query<unknown, Params>(
					`UPDATE tasks SET model_calls = model_calls + 1,
						started_at = COALESCE(started_at, $at), updated_at = $at,
						waiting_on = CASE WHEN $consumed > 0 THEN NULL ELSE waiting_on END
					WHERE id = $id`,
				).run({ at, consumed: inbox.length, id: live.taskId });
			})();

			const text = result.message.content?.trim();
			if (text && calls.length > 0) noteStep(daemon, live.taskId, text);
			if (calls.length === 0) {
				// One nudge; after that it waits for a message.
				nudge = !nudged;
				nudged = true;
				continue;
			}
			nudge = false;
			nudged = false;
			await runTools(daemon, live, sessionId, task, calls);
		} finally {
			releaseTurn(daemon, live);
		}
	}
}

async function runTools(
	daemon: Daemon,
	live: WorkerLive,
	sessionId: number,
	task: TaskRow,
	calls: ToolCall[],
): Promise<void> {
	const { db } = daemon;
	for (const [index, call] of calls.entries()) {
		if (live.controller.signal.aborted) return;
		const outcome = await runWorkerTool(
			daemon,
			{
				id: task.id,
				handle: task.handle,
				repo: task.repo,
				workDir: task.workDir,
			},
			call,
		);
		// A file the Worker reads can hold a key; the model never sees it.
		const result = redact(daemon.secrets, outcome.result);
		appendItems(db, sessionId, [
			{ role: 'tool', tool_call_id: call.id, content: result },
		]);
		daemon.log('info', 'worker tool', {
			task: task.handle,
			tool: call.function.name,
			result: cut(result.split('\n')[0] ?? '', 160),
		});
		// `ask`, `wait_for` and `finish` end the turn; later calls are answered
		// so the transcript stays valid.
		if (outcome.endsTurn) {
			const reason =
				call.function.name === 'finish'
					? 'not run: the task finished'
					: `not run: ${call.function.name} ended your turn`;
			appendItems(
				db,
				sessionId,
				calls.slice(index + 1).map((rest) => ({
					role: 'tool',
					tool_call_id: rest.id,
					content: reason,
				})),
			);
			return;
		}
	}
}

/**
 * Waits until the task may work: at most `maxWorkingTasks` hold a slot at
 * once. A task with a running command already holds one. `false` if aborted.
 */
async function takeSlot(daemon: Daemon, live: WorkerLive): Promise<boolean> {
	const { signal } = live.controller;
	const queue = daemon.slotQueue;
	const free = () => workingTasks(daemon) < daemon.config.maxWorkingTasks;
	const holdsOne = [...daemon.commands.values()].some(
		(command) => command.taskId === live.taskId,
	);
	// First come, first served: a task coming back for its next turn queues
	// behind tasks that are already waiting.
	if (holdsOne || (queue.length === 0 && free())) {
		live.turn = true;
		return true;
	}
	const entry = { wake: () => {} };
	queue.push(entry);
	setBlocked(daemon, live, SLOT);
	while (queue[0] !== entry || !free()) {
		await new Promise<void>((resolve) => {
			const done = () => {
				signal.removeEventListener('abort', done);
				resolve();
			};
			entry.wake = done;
			signal.addEventListener('abort', done, { once: true });
		});
		if (signal.aborted) {
			queue.splice(queue.indexOf(entry), 1);
			slotsChanged(daemon);
			return false;
		}
	}
	queue.shift();
	setBlocked(daemon, live, null);
	live.turn = true;
	// The next in line may fit too.
	slotsChanged(daemon);
	return true;
}

function releaseTurn(daemon: Daemon, live: WorkerLive): void {
	if (!live.turn) return;
	live.turn = false;
	slotsChanged(daemon);
}

function setBlocked(
	daemon: Daemon,
	live: WorkerLive,
	blockedOn: string | null,
): void {
	if (live.blockedOn === blockedOn) return;
	live.blockedOn = blockedOn;
	taskChanged(daemon, live.taskId);
}

function workerSessionId(db: Database, taskId: number): number {
	const session = db
		.query<{ id: number }, [number]>(
			'SELECT id FROM sessions WHERE task_id = ?',
		)
		.get(taskId);
	if (session) return session.id;
	return Number(
		db
			.query<unknown, [number, number]>(
				"INSERT INTO sessions (kind, task_id, created_at) VALUES ('worker', ?, ?)",
			)
			.run(taskId, Date.now()).lastInsertRowid,
	);
}

function lastRole(db: Database, sessionId: number): string | null {
	return (
		db
			.query<{ role: string }, [number]>(
				`SELECT json_extract(item, '$.role') AS role FROM session_items
				WHERE session_id = ? ORDER BY seq DESC LIMIT 1`,
			)
			.get(sessionId)?.role ?? null
	);
}

/** The step a response's visible text becomes: its first line, from the previous step's end to now. */
function noteStep(daemon: Daemon, taskId: number, text: string): void {
	const { db } = daemon;
	const now = Date.now();
	const previous =
		db
			.query<{ at: number | null }, [number]>(
				`SELECT MAX(COALESCE(ended_at, started_at)) AS at FROM steps WHERE task_id = ?`,
			)
			.get(taskId)?.at ??
		db
			.query<{ at: number | null }, [number]>(
				'SELECT started_at AS at FROM tasks WHERE id = ?',
			)
			.get(taskId)?.at ??
		now;
	const line = text.split('\n').find((part) => part.trim() !== '') ?? text;
	const id = Number(
		db
			.query<unknown, Params>(
				`INSERT INTO steps (task_id, kind, text, status, started_at, ended_at)
				VALUES ($taskId, 'note', $text, 'ok', $startedAt, $now)`,
			)
			.run({
				taskId,
				text: cut(line.trim(), NOTE_CHARS),
				startedAt: Math.min(previous, now),
				now,
			}).lastInsertRowid,
	);
	db.query<unknown, [number, number]>(
		'UPDATE tasks SET last_progress_at = ? WHERE id = ?',
	).run(now, taskId);
	publishStep(daemon, id);
}

type InboxEvent = {
	id: number;
	at: number;
	channel: string;
	threadTitle: string | null;
	kind: string;
	author: string;
	text: string;
};

function inboxEvents(db: Database, taskId: number): InboxEvent[] {
	return db
		.query<InboxEvent, [number]>(
			`SELECT e.id, e.received_at AS at, e.channel, th.title AS threadTitle, e.kind,
				e.author, e.text
			FROM events e LEFT JOIN threads th ON th.id = e.thread_id
			WHERE e.route = 'task' AND e.task_id = ? AND e.consumed_at IS NULL
			ORDER BY e.id`,
		)
		.all(taskId);
}

// Shown in full: Workers have no read_trigger, and command results are
// already cut to 8 KB at the source.
function renderInbox(events: InboxEvent[]): string {
	const lines = ['New since your last step:', ''];
	for (const event of events) {
		const what =
			event.kind === 'note'
				? `note from ${event.author}`
				: event.kind === 'answer'
					? `answer from ${event.author} to your question`
					: event.kind === 'command_done'
						? 'command finished'
						: [event.channel, event.threadTitle, event.author]
								.filter(Boolean)
								.join(' · ');
		lines.push(
			`#${event.id} · ${what} · ${clock(event.at)}`,
			event.text
				.split('\n')
				.map((line) => `  ${line}`)
				.join('\n'),
			'',
		);
	}
	return lines.join('\n').trimEnd();
}

/** The Worker's first message: the task, where it came from, and where it works. */
function brief(
	daemon: Daemon,
	task: TaskRow,
	worktreeNote: string | null,
): string {
	const { db } = daemon;
	const details = db
		.query<
			{
				instructions: string;
				originId: number | null;
				at: number | null;
				channel: string | null;
				author: string | null;
				text: string | null;
			},
			[number]
		>(
			`SELECT t.instructions, e.id AS originId, e.received_at AS at, e.channel, e.author, e.text
			FROM tasks t LEFT JOIN events e ON e.id = t.origin_event_id WHERE t.id = ?`,
		)
		.get(task.id);
	const threads = db
		.query<{ id: string; title: string }, [number]>(
			`SELECT th.id, th.title FROM task_threads tt JOIN threads th ON th.id = tt.thread_id
			WHERE tt.task_id = ?`,
		)
		.all(task.id);
	const tools = Object.entries(daemon.machine.tools);
	const parts = [
		`You are the Worker for task ${task.handle}: ${task.title}`,
		`Instructions from the Router:\n${details?.instructions ?? ''}`,
	];
	if (details && details.originId !== null && details.text !== null) {
		parts.push(
			`It came from event #${details.originId} (${details.channel} · ${details.author} · ${clock(details.at ?? Date.now())}), in full:\n${details.text}`,
		);
	}
	parts.push(
		threads.length > 0
			? `Threads you follow: ${threads.map((thread) => `${thread.id} (${thread.title})`).join(', ')}. Their new messages come to you.`
			: 'You follow no threads; the Router speaks to people for you.',
		task.repo === null
			? `Working folder: ${task.workDir}. It's a scratch folder for this task, not a repository.`
			: `Working folder: ${task.workDir}. It's a git worktree of the ${task.repo} repository (${daemon.config.repos.find((repo) => repo.name === task.repo)?.path ?? 'no longer in config.json'}) on your own branch, ${task.branch ?? ''}; commit your work there.${worktreeNote ? ` ${worktreeNote}` : ''}`,
		`Machine: ${daemon.machine.os} · ${daemon.machine.arch} · on PATH: ${tools
			.filter(([, found]) => found)
			.map(([name]) => name)
			.join(', ')} · missing: ${tools
			.filter(([, found]) => !found)
			.map(([name]) => name)
			.join(', ')}`,
	);
	return parts.join('\n\n');
}

function clock(at: number): string {
	return new Date(at).toTimeString().slice(0, 5);
}
