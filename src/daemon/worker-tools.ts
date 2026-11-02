import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { FunctionTool, ToolCall } from '../particle/types.ts';
import { readOutput, runCommand, stopCommand, taskFolder } from './commands.ts';
import { editDiff } from './git.ts';
import { type Daemon, type Params, cut } from './state.ts';
import { openQuestion, publishStep, taskChanged } from './task-feed.ts';
import { askQuestion, endTask, toRouter } from './tasks.ts';
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

const DEFAULT_TIMEOUT_S = 1_800;
const OUTPUT_LINES = 400;
const FILE_LINES = 2_000;
const FILE_LINE_CHARS = 2_000;
const QUESTION_CHARS = 300;
const RESULT_CHARS = 80;
const WAITING_ON_CHARS = 80;
const STEP_TEXT_CHARS = 200;
const MAX_OPTIONS = 4;

export const WORKER_TOOLS: FunctionTool[] = [
	tool(
		'run',
		'Run a shell command (bash) in your working folder. Waits up to 30 s; a longer command keeps running in the background and its result arrives as a message.',
		{
			command: string('The command'),
			timeout_s: integer(
				`Seconds before it's stopped; default ${DEFAULT_TIMEOUT_S}`,
			),
		},
		['command'],
	),
	tool(
		'read_output',
		`Read up to ${OUTPUT_LINES} lines of a command's saved output.`,
		{
			step: integer('The step number of the command'),
			from_line: integer('First line to read, from 1; default 1'),
		},
		['step'],
	),
	tool(
		'stop_command',
		'Stop a command that is running in the background.',
		{ step: integer('The step number of the command') },
		['step'],
	),
	tool(
		'read_file',
		`Read a file in your working folder: up to ${FILE_LINES} numbered lines.`,
		{
			path: string('Relative to your working folder'),
			offset: integer('First line to read, from 1; default 1'),
			limit: integer(`How many lines; at most ${FILE_LINES}`),
		},
		['path'],
	),
	tool(
		'write_file',
		'Create or replace a file in your working folder.',
		{
			path: string('Relative to your working folder'),
			content: string('The whole new content'),
		},
		['path', 'content'],
	),
	tool(
		'edit_file',
		'Replace one exact occurrence of `old` with `new` in a file. Refused when `old` is missing or appears more than once.',
		{
			path: string('Relative to your working folder'),
			old: string(
				'The exact text to replace, with enough context to be unique',
			),
			new: string('The replacement'),
		},
		['path', 'old', 'new'],
	),
	tool(
		'ask',
		'Ask the operator a question when you need a decision. Ends your turn; the answer arrives as a message.',
		{
			question: string(`At most ${QUESTION_CHARS} characters`),
			context: string('Optional markdown with the background'),
			options: {
				type: 'array',
				items: { type: 'string' },
				description: `Up to ${MAX_OPTIONS} suggested answers`,
			},
		},
		['question'],
	),
	tool(
		'report',
		'Send a progress note to the Router, which decides whether people hear it ("PR opened").',
		{ text: string('The note') },
		['text'],
	),
	tool(
		'wait_for',
		'End your turn while you wait for something outside (CI, a review). Any new message wakes you.',
		{
			what: string(
				`What you're waiting on; at most ${WAITING_ON_CHARS} characters`,
			),
		},
		['what'],
	),
	tool(
		'release_thread',
		'Hand a thread back to the Router when you no longer need its messages.',
		{ thread: string("The thread's ID") },
		['thread'],
	),
	tool(
		'finish',
		'End the task as done. The Router tells people.',
		{
			result: string(`One line, at most ${RESULT_CHARS} characters`),
			report: string('Optional markdown report'),
		},
		['result'],
	),
];

export type WorkerTask = {
	id: number;
	handle: string;
	repo: string | null;
	workDir: string;
};

export type WorkerToolOutcome = {
	/** The tool result for the transcript; errors start with `error:`. */
	result: string;
	/** `ask`, `wait_for` and `finish` end the turn. */
	endsTurn: boolean;
};

/** Runs one Worker tool call. Problems with the call come back as `error: …`. */
export async function runWorkerTool(
	daemon: Daemon,
	task: WorkerTask,
	call: ToolCall,
): Promise<WorkerToolOutcome> {
	try {
		const args = parseArgs(call.function.arguments);
		switch (call.function.name) {
			case 'run': {
				const command = requiredString(args, 'command');
				const timeout = optionalInteger(args, 'timeout_s') ?? DEFAULT_TIMEOUT_S;
				if (timeout < 1) throw new ToolError('timeout_s must be at least 1');
				return done(await runCommand(daemon, task, command, timeout));
			}
			case 'read_output':
				return done(readOutputTool(daemon, task, args));
			case 'stop_command': {
				const step = commandStep(daemon, task, requiredInteger(args, 'step'));
				if (!daemon.commands.has(step)) {
					throw new ToolError(`step ${step} isn't running`);
				}
				await stopCommand(daemon, step);
				return done(`stopped step ${step}`);
			}
			case 'read_file':
				return done(readFile(task, args));
			case 'write_file': {
				const target = resolvePath(task.workDir, requiredString(args, 'path'));
				const content = args.content;
				if (typeof content !== 'string') {
					throw new ToolError('content must be a string');
				}
				const before = existsSync(target.absolute)
					? readFileSync(target.absolute, 'utf8')
					: null;
				mkdirSync(dirname(target.absolute), { recursive: true });
				writeFileSync(target.absolute, content);
				await editStep(daemon, task, target.relative, before, content);
				return done(
					`wrote ${target.relative} (${content.split('\n').length} lines)`,
				);
			}
			case 'edit_file':
				return done(await editFile(daemon, task, args));
			case 'ask': {
				const open = openQuestion(daemon.db, task.id);
				if (open) {
					throw new ToolError(
						`question ${open.id} is still open; wait for its answer`,
					);
				}
				const options = optionalStrings(args, 'options');
				if (options.length > MAX_OPTIONS) {
					throw new ToolError(`at most ${MAX_OPTIONS} options`);
				}
				const id = askQuestion(daemon, task.id, {
					text: limitedString(args, 'question', QUESTION_CHARS),
					context: optionalString(args, 'context'),
					options: options.length > 0 ? options : null,
				});
				return done(
					`asked as question ${id}; the answer will arrive as a message`,
					true,
				);
			}
			case 'report':
				toRouter(
					daemon,
					'task_report',
					task.id,
					task.handle,
					requiredString(args, 'text'),
				);
				return done('sent to the Router');
			case 'wait_for': {
				const what = limitedString(args, 'what', WAITING_ON_CHARS);
				daemon.db
					.query<unknown, [string, number, number]>(
						'UPDATE tasks SET waiting_on = ?, updated_at = ? WHERE id = ?',
					)
					.run(what, Date.now(), task.id);
				taskChanged(daemon, task.id);
				return done(`waiting on ${what}; any new message wakes you`, true);
			}
			case 'release_thread':
				return done(releaseThread(daemon, task, args));
			case 'finish': {
				const result = limitedString(args, 'result', RESULT_CHARS);
				endTask(daemon, task.id, {
					state: 'done',
					result,
					report: optionalString(args, 'report'),
				});
				return done('finished', true);
			}
			default:
				throw new ToolError(
					`no tool ${JSON.stringify(call.function.name)}; use one of ${WORKER_TOOLS.map((t) => t.function.name).join(', ')}`,
				);
		}
	} catch (error) {
		if (error instanceof ToolError) return done(`error: ${error.message}`);
		if (isFsError(error)) return done(`error: ${error.message}`);
		throw error;
	}
}

function done(result: string, endsTurn = false): WorkerToolOutcome {
	return { result, endsTurn };
}

function isFsError(error: unknown): error is Error & { code: string } {
	return (
		error instanceof Error &&
		'code' in error &&
		typeof error.code === 'string' &&
		/^E[A-Z]+$/.test(error.code)
	);
}

/** Resolves `path` against the working folder. */
function resolvePath(
	workDir: string,
	path: string,
): { absolute: string; relative: string } {
	const absolute = resolve(workDir, path);
	return { absolute, relative: relative(workDir, absolute) || '.' };
}

function readFile(task: WorkerTask, args: Args): string {
	const target = resolvePath(task.workDir, requiredString(args, 'path'));
	if (!existsSync(target.absolute)) {
		throw new ToolError(`${target.relative} doesn't exist`);
	}
	const text = readFileSync(target.absolute, 'utf8');
	if (text.slice(0, 8_000).includes('\0')) {
		throw new ToolError(`${target.relative} looks like a binary file`);
	}
	const lines = text.split('\n');
	if (lines.at(-1) === '') lines.pop();
	const offset = Math.max(1, optionalInteger(args, 'offset') ?? 1);
	const limit = Math.min(
		FILE_LINES,
		Math.max(1, optionalInteger(args, 'limit') ?? FILE_LINES),
	);
	const shown = lines.slice(offset - 1, offset - 1 + limit);
	const numbered = shown.map(
		(line, index) =>
			`${String(offset + index).padStart(6)}\t${cut(line, FILE_LINE_CHARS)}`,
	);
	const end = offset - 1 + shown.length;
	if (end < lines.length) {
		numbered.push(
			`[lines ${offset}–${end} of ${lines.length}; read_file offset=${end + 1} for more]`,
		);
	}
	return numbered.length > 0
		? numbered.join('\n')
		: `${target.relative} is empty`;
}

async function editFile(
	daemon: Daemon,
	task: WorkerTask,
	args: Args,
): Promise<string> {
	const target = resolvePath(task.workDir, requiredString(args, 'path'));
	const old = requiredString(args, 'old');
	const replacement = args.new;
	if (typeof replacement !== 'string') {
		throw new ToolError('new must be a string');
	}
	if (!existsSync(target.absolute)) {
		throw new ToolError(`${target.relative} doesn't exist; use write_file`);
	}
	const text = readFileSync(target.absolute, 'utf8');
	const count = text.split(old).length - 1;
	if (count === 0)
		throw new ToolError(`old text not found in ${target.relative}`);
	if (count > 1) {
		throw new ToolError(
			`old text appears ${count} times in ${target.relative}; include more context so it's unique`,
		);
	}
	const after = text.replace(old, () => replacement);
	writeFileSync(target.absolute, after);
	await editStep(daemon, task, target.relative, text, after);
	return `edited ${target.relative}`;
}

/** An edit step with its unified diff and line counts. */
async function editStep(
	daemon: Daemon,
	task: WorkerTask,
	path: string,
	before: string | null,
	after: string,
): Promise<void> {
	const at = Date.now();
	const change = await editDiff(
		daemon,
		join(taskFolder(daemon, task.handle), 'tmp'),
		path,
		before,
		after,
	);
	const id = Number(
		daemon.db
			.query<unknown, Params>(
				`INSERT INTO steps (task_id, kind, text, status, started_at, ended_at, additions,
					deletions, diff)
				VALUES ($taskId, 'edit', $text, 'ok', $at, $endedAt, $additions, $deletions, $diff)`,
			)
			.run({
				taskId: task.id,
				text: cut(`Edited ${path}`, STEP_TEXT_CHARS),
				at,
				endedAt: Date.now(),
				...change,
			}).lastInsertRowid,
	);
	daemon.db
		.query<unknown, [number, number]>(
			'UPDATE tasks SET last_progress_at = ? WHERE id = ?',
		)
		.run(at, task.id);
	publishStep(daemon, id);
}

/** The step number, if it's one of this task's commands. */
function commandStep(daemon: Daemon, task: WorkerTask, step: number): number {
	const found = daemon.db
		.query<unknown, [number, number]>(
			"SELECT 1 FROM steps WHERE id = ? AND task_id = ? AND kind = 'command'",
		)
		.get(step, task.id);
	if (!found) throw new ToolError(`step ${step} isn't one of your commands`);
	return step;
}

function readOutputTool(daemon: Daemon, task: WorkerTask, args: Args): string {
	const step = commandStep(daemon, task, requiredInteger(args, 'step'));
	const from = Math.max(1, optionalInteger(args, 'from_line') ?? 1);
	const { lines, total } = readOutput(
		daemon,
		task.handle,
		step,
		from,
		OUTPUT_LINES,
	);
	const end = from - 1 + lines.length;
	const running = daemon.commands.has(step) ? ' (still running)' : '';
	return [
		`step ${step}: lines ${lines.length > 0 ? `${from}–${end}` : 'none'} of ${total}${running}`,
		...lines,
		...(end < total
			? [`[read_output step=${step} from_line=${end + 1} for more]`]
			: []),
	].join('\n');
}

function releaseThread(daemon: Daemon, task: WorkerTask, args: Args): string {
	const thread = requiredString(args, 'thread');
	const released = daemon.db
		.query<unknown, [string, number]>(
			'UPDATE threads SET owner_task_id = NULL WHERE id = ? AND owner_task_id = ?',
		)
		.run(thread, task.id).changes;
	if (released === 0) throw new ToolError(`you don't own thread ${thread}`);
	taskChanged(daemon, task.id);
	toRouter(daemon, 'thread_released', task.id, task.handle, thread, { thread });
	return `released ${thread}; the Router handles it now`;
}
