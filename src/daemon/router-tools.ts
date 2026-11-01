import type { FunctionTool, JsonObject, ToolCall } from '../particle/types.ts';
import {
	type Daemon,
	MESSAGE_COLUMNS,
	type MessageRow,
	type Params,
	cut,
} from './state.ts';

const CHAT_CHANNELS = new Set(['console', 'slack']);
const CHAT_WORD_LIMIT = 100;
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
const TASKS_NOT_AVAILABLE =
	"error: not available: tasks aren't built in this version of the agent yet";

const string = (description: string) => ({ type: 'string', description });
const integer = (description: string) => ({ type: 'integer', description });

function tool(
	name: string,
	description: string,
	properties: Record<string, JsonObject>,
	required: string[],
): FunctionTool {
	return {
		type: 'function',
		function: {
			name,
			description,
			parameters: { type: 'object', properties, required },
		},
	};
}

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
			title: string('At most 80 characters'),
			instructions: string('Everything the Worker needs to know'),
			threads: {
				type: 'array',
				items: { type: 'string' },
				description: 'IDs of the threads the task takes over',
			},
			repo: string('Repository name, required when several are configured'),
		},
		['title', 'instructions', 'threads'],
	),
	tool(
		'send_to_task',
		"Send a note to a task's Worker. Reopens the task if it had ended.",
		{ handle: string('The task handle'), text: string('The note') },
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
	/** For the batch summary: `replied in console`. */
	action: string | null;
};

class ToolError extends Error {
	override name = 'ToolError';
}

type Args = Record<string, unknown>;

/** Runs one Router tool call. Synchronous: call it inside the transaction that stores its result. */
export function runRouterTool(
	daemon: Daemon,
	batchId: number,
	call: ToolCall,
): ToolOutcome {
	const none = { messages: [], action: null };
	let args: Args;
	try {
		const parsed: unknown = JSON.parse(call.function.arguments || '{}');
		if (
			typeof parsed !== 'object' ||
			parsed === null ||
			Array.isArray(parsed)
		) {
			throw new ToolError('arguments must be a JSON object');
		}
		args = { ...parsed };
	} catch (error) {
		return {
			result: `error: ${error instanceof ToolError ? error.message : "arguments aren't valid JSON"}`,
			...none,
		};
	}

	try {
		switch (call.function.name) {
			case 'reply':
				return reply(daemon, batchId, args);
			case 'start_task':
			case 'send_to_task':
			case 'stop_task':
				return { result: TASKS_NOT_AVAILABLE, ...none };
			case 'read_trigger':
				return { result: readTrigger(daemon, args), ...none };
			case 'read_thread':
				return { result: readThread(daemon, args), ...none };
			case 'read_task':
				return { result: readTask(daemon, args), ...none };
			case 'list_tasks':
				return { result: listTasks(daemon, args), ...none };
			default:
				return {
					result: `error: no tool ${JSON.stringify(call.function.name)}; use one of ${ROUTER_TOOLS.map((t) => t.function.name).join(', ')}`,
					...none,
				};
		}
	} catch (error) {
		if (!(error instanceof ToolError)) throw error;
		return { result: `error: ${error.message}`, ...none };
	}
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

function requiredString(args: Args, name: string): string {
	const value = args[name];
	if (typeof value !== 'string' || value.trim() === '') {
		throw new ToolError(`${name} must be a non-empty string`);
	}
	return value;
}

function optionalString(args: Args, name: string): string | null {
	const value = args[name];
	if (value === undefined || value === null || value === '') return null;
	if (typeof value !== 'string')
		throw new ToolError(`${name} must be a string`);
	return value;
}

// Models often send numbers as strings, or event numbers as `#42`.
function optionalInteger(args: Args, name: string): number | null {
	const value = args[name];
	if (value === undefined || value === null || value === '') return null;
	const number =
		typeof value === 'string' && /^#?\d+$/.test(value.trim())
			? Number(value.trim().replace('#', ''))
			: value;
	if (
		typeof number !== 'number' ||
		!Number.isSafeInteger(number) ||
		number < 0
	) {
		throw new ToolError(`${name} must be a whole number`);
	}
	return number;
}

function requiredInteger(args: Args, name: string): number {
	const value = optionalInteger(args, name);
	if (value === null) throw new ToolError(`${name} is required`);
	return value;
}
