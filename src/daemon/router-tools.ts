import type { FunctionTool, ToolCall } from '../particle/types.ts';
import { ingest } from './ingest.ts';
import {
	type Daemon,
	MESSAGE_COLUMNS,
	type MessageRow,
	type Params,
	cut,
} from './state.ts';
import { publishTask, taskByHandle } from './task-feed.ts';
import { taskBranch } from './git.ts';
import {
	githubThreadState,
	prepareGitHubThread,
	repoOfThreads,
} from './github-threads.ts';
import { createTask, endTask, reopenTask } from './tasks.ts';
import {
	type Args,
	ToolError,
	integer,
	limitedString,
	optionalInteger,
	optionalString,
	optionalStrings,
	parseArgs,
	requiredInteger,
	requiredString,
	string,
	tool,
} from './tool-args.ts';

const CHAT_CHANNELS = new Set(['console', 'slack']);
const CHAT_WORD_LIMIT = 100;
const TITLE_CHARS = 80;
const TRIGGER_PAGE_CHARS = 8_000;
const THREAD_MESSAGES = 30;
const THREAD_MESSAGE_CHARS = 2_000;
const TASK_STEPS = 10;
const LIST_TASKS = 50;
const TASK_STATES = new Set([
	'active',
	'needs_you',
	'done',
	'failed',
	'stopped',
]);

export const ROUTER_TOOLS: FunctionTool[] = [
	tool(
		'reply',
		`Send a message to a thread. The only way to reach a person. In chat channels (the console) replies are at most ${CHAT_WORD_LIMIT} words.`,
		{
			thread: string("The thread's ID, such as console"),
			text: string('The message'),
			task: string('The handle of the task this reply is about, if any'),
		},
		['thread', 'text'],
	),
	tool(
		'start_task',
		'Start a task: a Worker that does the work, with its own working folder.',
		{
			title: string(`At most ${TITLE_CHARS} characters`),
			instructions: string('Everything the Worker needs to know'),
			threads: {
				type: 'array',
				items: { type: 'string' },
				description:
					'IDs of the threads the task takes over, such as github:acme/app#42 for a GitHub issue; the console stays with you',
			},
			repo: string(
				'A repository from the batch message, for code work; "none" for a scratch folder. Omitted: the only repository, or the one its GitHub threads are on',
			),
			event: integer(
				'The event the task comes from, 42 for #42; default: the latest in this batch',
			),
		},
		['title', 'instructions', 'threads'],
	),
	tool(
		'send_to_task',
		"Send a note to a task's Worker. Reopens the task if it had ended.",
		{
			handle: string('The task handle'),
			text: string('The note'),
			threads: {
				type: 'array',
				items: { type: 'string' },
				description:
					'More threads for the task to take over, such as github:acme/app#43',
			},
		},
		['handle', 'text'],
	),
	tool(
		'stop_task',
		'Stop a task and its commands.',
		{
			handle: string('The task handle'),
			reason: string('Why, for people'),
		},
		['handle', 'reason'],
	),
	tool(
		'read_trigger',
		`Read one event in full, in pages of ${TRIGGER_PAGE_CHARS.toLocaleString('en-US')} characters.`,
		{
			id: integer('The event number, 42 for #42'),
			from: integer('Character offset to start from; default 0'),
		},
		['id'],
	),
	tool(
		'read_thread',
		`Read the last ${THREAD_MESSAGES} messages of a thread, its owner and the tasks that followed it.`,
		{
			id: string("The thread's ID"),
			before: integer('Only messages with a lower ID, to page back'),
		},
		['id'],
	),
	tool(
		'read_task',
		`Read a task: state, threads, open question, last ${TASK_STEPS} steps, result and report.`,
		{ handle: string('The task handle') },
		['handle'],
	),
	tool(
		'list_tasks',
		`List tasks, newest first, at most ${LIST_TASKS}.`,
		{
			state: string(
				'Only tasks in this state: active, needs_you, done, failed or stopped',
			),
		},
		[],
	),
];

export type ToolOutcome = {
	/** The tool result for the transcript; errors start with `error:`. */
	result: string;
	/** Messages to publish once the transaction commits. */
	messages: MessageRow[];
	/** For the batch summary: `replied in console`, `started a9k3`. */
	action: string | null;
};

/** Runs one Router tool call. Synchronous: call it inside the transaction that stores its result. */
export function runRouterTool(
	daemon: Daemon,
	batchId: number,
	call: ToolCall,
): ToolOutcome {
	const none = { messages: [], action: null };
	try {
		const args = parseArgs(call.function.arguments);
		switch (call.function.name) {
			case 'reply':
				return reply(daemon, batchId, args);
			case 'start_task':
				return startTask(daemon, batchId, args);
			case 'send_to_task':
				return sendToTask(daemon, args);
			case 'stop_task':
				return stopTask(daemon, args);
			case 'read_trigger':
				return { result: readTrigger(daemon, args), ...none };
			case 'read_thread':
				return { result: readThread(daemon, args), ...none };
			case 'read_task':
				return { result: readTask(daemon, args), ...none };
			case 'list_tasks':
				return { result: listTasks(daemon, args), ...none };
			default:
				throw new ToolError(
					`no tool ${JSON.stringify(call.function.name)}; use one of ${ROUTER_TOOLS.map((t) => t.function.name).join(', ')}`,
				);
		}
	} catch (error) {
		if (!(error instanceof ToolError)) throw error;
		return { result: `error: ${error.message}`, ...none };
	}
}

function startTask(daemon: Daemon, batchId: number, args: Args): ToolOutcome {
	const { db } = daemon;
	const title = limitedString(args, 'title', TITLE_CHARS);
	const instructions = requiredString(args, 'instructions').trim();
	const repo = optionalString(args, 'repo');
	const { threads, notes } = takeableThreads(
		daemon,
		optionalStrings(args, 'threads'),
		null,
	);

	const event = optionalInteger(args, 'event');
	let originEventId: number | null;
	if (event !== null) {
		if (
			!db
				.query<unknown, [number]>('SELECT 1 FROM events WHERE id = ?')
				.get(event)
		) {
			throw new ToolError(`no event #${event}`);
		}
		originEventId = event;
	} else {
		// The newest message from people in this batch, else its newest event.
		originEventId =
			db
				.query<{ id: number }, [number]>(
					`SELECT id FROM events WHERE batch_id = ?
					ORDER BY channel = 'internal', id DESC LIMIT 1`,
				)
				.get(batchId)?.id ?? null;
	}
	const repos = daemon.config.repos.map((entry) => entry.name);
	let chosen: string | null;
	if (repo === 'none') {
		chosen = null;
	} else if (repo !== null) {
		if (!repos.includes(repo)) {
			throw new ToolError(
				`no repository ${JSON.stringify(repo)}; use one of ${[...repos, 'none'].join(', ')}`,
			);
		}
		chosen = repo;
	} else if (repos.length > 1) {
		chosen = repoOfThreads(daemon, threads);
		if (chosen === null) {
			throw new ToolError(
				`several repositories are configured; pass repo: one of ${[...repos, 'none'].join(', ')}`,
			);
		}
	} else {
		chosen = repos[0] ?? null;
	}

	const { handle } = createTask(daemon, {
		title,
		instructions,
		threads,
		originEventId,
		repo: chosen,
	});
	if (chosen !== null) notes.push(`in ${chosen} on ${taskBranch(handle)}`);
	return {
		result: `started ${handle}${notes.length > 0 ? ` (${notes.join('; ')})` : ''}`,
		messages: [],
		action: `started ${handle}`,
	};
}

function sendToTask(daemon: Daemon, args: Args): ToolOutcome {
	const { db } = daemon;
	const handle = requiredString(args, 'handle');
	const text = requiredString(args, 'text').trim();
	const task = taskByHandle(db, handle);
	if (!task) throw new ToolError(`no task ${JSON.stringify(handle)}`);
	const { threads, notes } = takeableThreads(
		daemon,
		optionalStrings(args, 'threads'),
		task.id,
	);
	const ended = task.state !== 'active' && task.state !== 'needs_you';
	ingest(daemon, {
		channel: 'internal',
		externalId: null,
		thread: null,
		kind: 'note',
		author: { name: 'the Router', id: null, isBot: false, isSelf: false },
		text,
		mentionsAgent: false,
		taskId: task.id,
	});
	if (ended) reopenTask(daemon, task.id);
	if (threads.length > 0) {
		const at = Date.now();
		for (const id of threads) {
			db.query<unknown, [number, string]>(
				'UPDATE threads SET owner_task_id = ? WHERE id = ?',
			).run(task.id, id);
			db.query<unknown, [number, string, number]>(
				'INSERT OR IGNORE INTO task_threads (task_id, thread_id, since) VALUES (?, ?, ?)',
			).run(task.id, id, at);
		}
		publishTask(daemon, task.id);
		notes.push(`it now follows ${threads.join(', ')}`);
	}
	const sent = ended
		? `sent; ${task.handle} had ${task.state === 'done' ? 'finished' : task.state} and is reopened`
		: `sent; ${task.handle} reads it after its current step`;
	return {
		result: notes.length > 0 ? `${sent} (${notes.join('; ')})` : sent,
		messages: [],
		action: `sent a note to ${task.handle}`,
	};
}

/**
 * The threads a task can take over: ownable, and not another task's. A
 * `github:` thread is created when it's new. The console stays with the
 * Router, noted instead.
 */
function takeableThreads(
	daemon: Daemon,
	ids: string[],
	taskId: number | null,
): { threads: string[]; notes: string[] } {
	const threads: string[] = [];
	const notes: string[] = [];
	for (const requested of ids) {
		let id = requested;
		if (requested.startsWith('github:')) {
			const prepared = prepareGitHubThread(daemon, requested);
			if (!prepared.ok) throw new ToolError(prepared.error);
			({ id } = prepared);
		}
		const thread = daemon.db
			.query<
				{ ownable: number; ownerId: number | null; owner: string | null },
				[string]
			>(
				`SELECT th.ownable, th.owner_task_id AS ownerId, t.handle AS owner FROM threads th
				LEFT JOIN tasks t ON t.id = th.owner_task_id WHERE th.id = ?`,
			)
			.get(id);
		if (!thread) throw new ToolError(`no thread ${JSON.stringify(id)}`);
		if (thread.ownable === 0) {
			notes.push(`${id} stays with you`);
			continue;
		}
		if (thread.ownerId !== null && thread.ownerId !== taskId) {
			throw new ToolError(
				`thread ${id} is owned by task ${thread.owner ?? '?'}; use send_to_task ${thread.owner ?? ''} instead`,
			);
		}
		if (!threads.includes(id)) threads.push(id);
	}
	return { threads, notes };
}

function stopTask(daemon: Daemon, args: Args): ToolOutcome {
	const handle = requiredString(args, 'handle');
	const reason = requiredString(args, 'reason').trim();
	const task = taskByHandle(daemon.db, handle);
	if (!task) throw new ToolError(`no task ${JSON.stringify(handle)}`);
	if (
		!endTask(daemon, task.id, {
			state: 'stopped',
			result: cut(`stopped by the agent: ${reason}`, TITLE_CHARS),
			dismiss: false,
			tellRouter: false,
		})
	) {
		throw new ToolError(`${task.handle} already ended (${task.state})`);
	}
	return {
		result: `stopped ${task.handle}; its commands are being ended`,
		messages: [],
		action: `stopped ${task.handle}`,
	};
}

function reply(daemon: Daemon, batchId: number, args: Args): ToolOutcome {
	const { db } = daemon;
	const threadId = requiredString(args, 'thread');
	const text = requiredString(args, 'text').trim();
	const handle = optionalString(args, 'task');

	const thread = db
		.query<{ channel: string; title: string }, [string]>(
			'SELECT channel, title FROM threads WHERE id = ?',
		)
		.get(threadId);
	if (!thread) throw new ToolError(`no thread ${JSON.stringify(threadId)}`);
	if (thread.channel === 'github') {
		throw new ToolError(
			"not sent: replies on GitHub threads aren't available yet; tell the operator in the console instead",
		);
	}
	const words = text.split(/\s+/).length;
	if (CHAT_CHANNELS.has(thread.channel) && words > CHAT_WORD_LIMIT) {
		throw new ToolError(
			`not sent: the reply has ${words} words and ${thread.channel} replies are at most ${CHAT_WORD_LIMIT}. Shorten it and call reply again.`,
		);
	}
	const taskId =
		handle === null
			? null
			: (db
					.query<{ id: number }, [string]>(
						'SELECT id FROM tasks WHERE handle = ?',
					)
					.get(handle)?.id ?? null);
	if (handle !== null && taskId === null) {
		throw new ToolError(`no task ${JSON.stringify(handle)}`);
	}

	// Console and script threads are delivered by storing the message.
	const id = Number(
		db
			.query<unknown, Params>(
				`INSERT INTO messages (at, channel, thread_id, task_id, direction, author, text,
					batch_id, delivery, attempts)
				VALUES ($at, $channel, $threadId, $taskId, 'out', 'agent', $text,
					$batchId, 'delivered', 1)`,
			)
			.run({
				at: Date.now(),
				channel: thread.channel,
				threadId,
				taskId,
				text,
				batchId,
			}).lastInsertRowid,
	);
	db.query<unknown, [number, string]>(
		'UPDATE threads SET last_event_at = ? WHERE id = ?',
	).run(Date.now(), threadId);
	const message = db
		.query<MessageRow, [number]>(`SELECT ${MESSAGE_COLUMNS} WHERE m.id = ?`)
		.get(id);
	return {
		result: 'sent',
		messages: message ? [message] : [],
		action: `replied in ${thread.title}`,
	};
}

function readTrigger(daemon: Daemon, args: Args): string {
	const id = requiredInteger(args, 'id');
	const from = optionalInteger(args, 'from') ?? 0;
	const event = daemon.db
		.query<
			{
				at: number;
				channel: string;
				threadId: string | null;
				kind: string;
				author: string;
				text: string;
				data: string | null;
				route: string;
				task: string | null;
				filterReason: string | null;
			},
			[number]
		>(
			`SELECT e.received_at AS at, e.channel, e.thread_id AS threadId, e.kind, e.author,
				e.text, e.data, e.route, t.handle AS task, e.filter_reason AS filterReason
			FROM events e LEFT JOIN tasks t ON t.id = e.task_id WHERE e.id = ?`,
		)
		.get(id);
	if (!event) throw new ToolError(`no event #${id}`);
	const page = event.text.slice(from, from + TRIGGER_PAGE_CHARS);
	const end = from + page.length;
	const route =
		event.route === 'task'
			? `task ${event.task ?? '?'}`
			: event.route === 'filtered'
				? `filtered (${event.filterReason ?? 'no reason'})`
				: 'router';
	const lines = [
		`#${id} · ${event.channel}${event.threadId ? ` · thread ${event.threadId}` : ''} · ${event.author} · ${event.kind} · ${new Date(event.at).toISOString()} · routed to ${route}`,
	];
	if (event.data) lines.push(`data: ${event.data}`);
	lines.push(
		`characters ${from.toLocaleString('en-US')}–${end.toLocaleString('en-US')} of ${event.text.length.toLocaleString('en-US')}`,
		'',
		page,
	);
	if (end < event.text.length) {
		lines.push('', `[more: read_trigger id=${id} from=${end}]`);
	}
	return lines.join('\n');
}

function readThread(daemon: Daemon, args: Args): string {
	const { db } = daemon;
	const id = requiredString(args, 'id');
	const before = optionalInteger(args, 'before');
	const thread = db
		.query<
			{
				channel: string;
				title: string;
				url: string | null;
				owner: string | null;
			},
			[string]
		>(
			`SELECT th.channel, th.title, th.url, t.handle AS owner
			FROM threads th LEFT JOIN tasks t ON t.id = th.owner_task_id WHERE th.id = ?`,
		)
		.get(id);
	if (!thread) throw new ToolError(`no thread ${JSON.stringify(id)}`);
	const followed = db
		.query<{ handle: string; state: string; title: string }, [string]>(
			`SELECT t.handle, t.state, t.title FROM task_threads tt
			JOIN tasks t ON t.id = tt.task_id WHERE tt.thread_id = ? ORDER BY tt.since`,
		)
		.all(id);
	const messages = db
		.query<
			{
				id: number;
				at: number;
				author: string;
				direction: string;
				text: string;
				taskHandle: string | null;
				eventId: number | null;
			},
			Params
		>(
			`SELECT m.id, m.at, m.author, m.direction, m.text, t.handle AS taskHandle,
				m.event_id AS eventId
			FROM messages m LEFT JOIN tasks t ON t.id = m.task_id
			WHERE m.thread_id = $id AND m.id < $before ORDER BY m.id DESC LIMIT $limit`,
		)
		.all({
			id,
			before: before ?? Number.MAX_SAFE_INTEGER,
			limit: THREAD_MESSAGES,
		})
		.toReversed();

	const lines = [
		`thread ${id} · ${thread.channel} · ${thread.title}${thread.url ? ` · ${thread.url}` : ''}`,
		`owner: ${thread.owner ?? 'none (the Router handles it)'}`,
		...(thread.channel === 'github'
			? [githubThreadState(db, id) ?? 'GitHub: not fetched yet']
			: []),
		`tasks that followed it: ${followed.length > 0 ? followed.map((t) => `${t.handle} (${t.state}) ${t.title}`).join('; ') : 'none'}`,
		'',
	];
	if (messages.length === 0) lines.push('no messages');
	for (const message of messages) {
		const text = cut(message.text, THREAD_MESSAGE_CHARS);
		const spill =
			text.length < message.text.length
				? ` [${text.length.toLocaleString('en-US')} of ${message.text.length.toLocaleString('en-US')} characters${message.eventId === null ? '' : `; read_trigger ${message.eventId} for the rest`}]`
				: '';
		lines.push(
			`m${message.id} · ${new Date(message.at).toISOString()} · ${message.author} (${message.direction})${message.taskHandle ? ` · task ${message.taskHandle}` : ''}${message.eventId === null ? '' : ` · #${message.eventId}`}`,
			`  ${text.replaceAll('\n', '\n  ')}${spill}`,
		);
	}
	const oldest = messages[0];
	if (oldest && messages.length === THREAD_MESSAGES) {
		lines.push('', `[older: read_thread id=${id} before=${oldest.id}]`);
	}
	return lines.join('\n');
}

function readTask(daemon: Daemon, args: Args): string {
	const { db } = daemon;
	const handle = requiredString(args, 'handle');
	const task = db
		.query<
			{
				id: number;
				title: string;
				state: string;
				waitingOn: string | null;
				repo: string | null;
				branch: string | null;
				result: string | null;
				report: string | null;
				failure: string | null;
				createdAt: number;
				endedAt: number | null;
			},
			[string]
		>(
			`SELECT id, title, state, waiting_on AS waitingOn, repo, branch, result, report,
				failure, created_at AS createdAt, ended_at AS endedAt
			FROM tasks WHERE handle = ?`,
		)
		.get(handle);
	if (!task) throw new ToolError(`no task ${JSON.stringify(handle)}`);
	const threads = db
		.query<{ id: string; owned: number }, [number]>(
			`SELECT th.id, th.owner_task_id = tt.task_id AS owned FROM task_threads tt
			JOIN threads th ON th.id = tt.thread_id WHERE tt.task_id = ? ORDER BY tt.since`,
		)
		.all(task.id);
	const question = db
		.query<{ id: number; text: string; options: string | null }, [number]>(
			`SELECT id, text, options FROM questions
			WHERE task_id = ? AND state = 'open' ORDER BY id DESC LIMIT 1`,
		)
		.get(task.id);
	const steps = db
		.query<
			{ kind: string; text: string; status: string; exitCode: number | null },
			[number, number]
		>(
			`SELECT kind, text, status, exit_code AS exitCode FROM steps
			WHERE task_id = ? ORDER BY id DESC LIMIT ?`,
		)
		.all(task.id, TASK_STEPS)
		.toReversed();

	const lines = [
		`${handle} · ${task.state}${task.waitingOn ? ` (waiting on ${task.waitingOn})` : ''} · ${task.title}`,
		`created ${new Date(task.createdAt).toISOString()}${task.endedAt ? ` · ended ${new Date(task.endedAt).toISOString()}` : ''}${task.repo ? ` · repo ${task.repo}` : ''}${task.branch ? ` · branch ${task.branch}` : ''}`,
		`threads: ${threads.length > 0 ? threads.map((t) => `${t.id}${t.owned ? ' (owned)' : ''}`).join(', ') : 'none'}`,
		`open question: ${question ? `${question.text}${question.options ? ` options ${question.options}` : ''}` : 'none'}`,
	];
	if (task.result) lines.push(`result: ${task.result}`);
	if (task.failure) lines.push(`failure: ${task.failure}`);
	lines.push(
		'',
		`last ${steps.length} steps:`,
		...steps.map(
			(step) =>
				`  ${step.kind} · ${step.status}${step.exitCode === null ? '' : ` (exit ${step.exitCode})`} · ${step.text}`,
		),
	);
	if (task.report) lines.push('', 'report:', task.report);
	return lines.join('\n');
}

function listTasks(daemon: Daemon, args: Args): string {
	const state = optionalString(args, 'state');
	if (state !== null && !TASK_STATES.has(state)) {
		throw new ToolError(`state must be one of ${[...TASK_STATES].join(', ')}`);
	}
	const tasks = daemon.db
		.query<
			{ handle: string; title: string; state: string; threads: string | null },
			Params
		>(
			`SELECT t.handle, t.title, t.state,
				(SELECT GROUP_CONCAT(thread_id, ', ') FROM task_threads WHERE task_id = t.id) AS threads
			FROM tasks t WHERE $state IS NULL OR t.state = $state
			ORDER BY t.id DESC LIMIT $limit`,
		)
		.all({ state, limit: LIST_TASKS });
	if (tasks.length === 0) return state ? `no ${state} tasks` : 'no tasks yet';
	return tasks
		.map(
			(task) =>
				`${task.handle}  ${task.state.padEnd(9)}  ${task.title}${task.threads ? `  follows ${task.threads}` : ''}`,
		)
		.join('\n');
}
