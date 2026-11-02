import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';
import { ingest } from './ingest.ts';
import { sandboxCommand } from './sandbox.ts';
import { envWithoutSecrets, redact } from './secrets.ts';
import { type Daemon, type Params, type RunningCommand, cut } from './state.ts';
import {
	isWorking,
	publishStep,
	slotsChanged,
	taskChanged,
} from './task-feed.ts';

const WAIT_MS = 30_000;
const KILL_AFTER_MS = 5_000;
const MAX_LOG_BYTES = 10 * 1024 * 1024;
const RESULT_HEAD_LINES = 20;
const RESULT_TAIL_LINES = 100;
const RESULT_MAX_CHARS = 8 * 1024;
const STEP_TEXT_CHARS = 200;
const LOGIN_PATH_TIMEOUT_MS = 5_000;

/**
 * Your login shell's PATH, printed between markers so whatever the profile
 * prints can't corrupt it. `null` when the shell fails or takes over 5 s.
 */
export function captureLoginPath(): string | null {
	const shell = Bun.env.SHELL || '/bin/bash';
	try {
		const result = Bun.spawnSync(
			[shell, '-lc', 'printf "@@SA_PATH@@%s@@SA_END@@" "$PATH"'],
			{
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'ignore',
				timeout: LOGIN_PATH_TIMEOUT_MS,
			},
		);
		return (
			result.stdout.toString().match(/@@SA_PATH@@(.*?)@@SA_END@@/s)?.[1] || null
		);
	} catch {
		return null;
	}
}

export function taskFolder(daemon: Daemon, handle: string): string {
	return join(daemon.paths.home, 'tasks', handle);
}

export function commandLog(
	daemon: Daemon,
	handle: string,
	stepId: number,
): string {
	return join(taskFolder(daemon, handle), 'commands', `${stepId}.log`);
}

/**
 * The daemon's environment without the agent's keys, with your login PATH and
 * nothing that waits for a terminal.
 */
function commandEnv(daemon: Daemon, handle: string): Env {
	return {
		...envWithoutSecrets(daemon.secrets),
		PATH: daemon.loginPath,
		LANG: Bun.env.LANG || 'C.UTF-8',
		TERM: 'dumb',
		TMPDIR: join(taskFolder(daemon, handle), 'tmp'),
		PAGER: 'cat',
		GIT_PAGER: 'cat',
		GIT_TERMINAL_PROMPT: '0',
		// gh never prompts, and doesn't write its update check, which the
		// sandbox wouldn't allow; its stored login is only read.
		GH_PROMPT_DISABLED: '1',
		GH_NO_UPDATE_NOTIFIER: '1',
		GH_SPINNER_DISABLED: '1',
	};
}

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch {
		// Already gone.
	}
}

/**
 * Runs a command for `run`: waits up to 30 s, then leaves it in the
 * background, and its end arrives in the task's inbox as `command_done`.
 * Returns the tool result.
 */
export async function runCommand(
	daemon: Daemon,
	task: { id: number; handle: string; repo: string | null; workDir: string },
	command: string,
	timeoutSeconds: number,
): Promise<string> {
	const { db } = daemon;
	const sandboxed = daemon.sandbox.state === 'on';
	const startedAt = Date.now();
	const folder = taskFolder(daemon, task.handle);
	mkdirSync(join(folder, 'commands'), { recursive: true });
	// Its TMPDIR and a sandbox write root; older tasks may not have it.
	const tmp = join(folder, 'tmp');
	mkdirSync(tmp, { recursive: true });
	const stepId = Number(
		db
			.query<unknown, Params>(
				`INSERT INTO steps (task_id, kind, text, command, status, started_at)
				VALUES ($taskId, 'command', $text, $command, 'running', $at)`,
			)
			.run({
				taskId: task.id,
				text: cut(command.replaceAll(/\s+/g, ' ').trim(), STEP_TEXT_CHARS),
				command,
				at: startedAt,
			}).lastInsertRowid,
	);
	const path = commandLog(daemon, task.handle, stepId);

	let child: ReturnType<typeof spawn>;
	let wrapped = false;
	try {
		const argv = sandboxed
			? await sandboxCommand(daemon, task, tmp, command)
			: ['/bin/bash', '-c', command];
		wrapped = sandboxed;
		child = spawn(argv, task.workDir, commandEnv(daemon, task.handle));
	} catch (error) {
		if (wrapped) SandboxManager.cleanupAfterCommand();
		const message = error instanceof Error ? error.message : String(error);
		appendFileSync(path, `[couldn't start: ${message}]\n`);
		db.query<unknown, [number, number]>(
			"UPDATE steps SET status = 'failed', ended_at = ? WHERE id = ?",
		).run(Date.now(), stepId);
		publishStep(daemon, stepId);
		return `error: couldn't start the command: ${message}`;
	}
	const pgid = child.pid;
	db.query<unknown, [number, number]>(
		'UPDATE steps SET pgid = ? WHERE id = ?',
	).run(pgid, stepId);
	db.query<unknown, [number, number]>(
		'UPDATE tasks SET last_progress_at = ? WHERE id = ?',
	).run(startedAt, task.id);

	const entry: RunningCommand = {
		stepId,
		taskId: task.id,
		pgid,
		background: false,
		deadline: startedAt + timeoutSeconds * 1000,
		stopReason: null,
		finished: Promise.resolve(''),
	};
	daemon.commands.set(stepId, entry);
	publishStep(daemon, stepId);
	taskChanged(daemon, task.id);

	let killTimer: Timer | null = null;
	const timeout = setTimeout(() => {
		entry.stopReason ??= 'timed out';
		signalGroup(pgid, 'SIGTERM');
		killTimer = setTimeout(() => signalGroup(pgid, 'SIGKILL'), KILL_AFTER_MS);
	}, timeoutSeconds * 1000);

	const sink = Bun.file(path).writer();
	let written = 0;
	let truncated = false;
	const write = async (text: string) => {
		const bytes = Buffer.from(text);
		const room = MAX_LOG_BYTES - written;
		if (room <= 0) {
			truncated ||= bytes.length > 0;
			return;
		}
		const part = bytes.length > room ? bytes.subarray(0, room) : bytes;
		truncated ||= part.length < bytes.length;
		await sink.write(part);
		written += part.length;
	};
	// The log file holds output with the agent's keys already redacted.
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		let held = '';
		for await (const chunk of stream) {
			const text = held + decoder.decode(chunk, { stream: true });
			const end = safeCut(daemon.secrets, text);
			held = text.slice(end);
			await write(redact(daemon.secrets, text.slice(0, end)));
		}
		await write(redact(daemon.secrets, held + decoder.decode()));
	};

	entry.finished = (async () => {
		await Promise.all([pump(child.stdout), pump(child.stderr), child.exited]);
		if (sandboxed) SandboxManager.cleanupAfterCommand();
		clearTimeout(timeout);
		if (killTimer) clearTimeout(killTimer);
		if (truncated) await sink.write('\n[output cut at 10 MB]\n');
		await sink.end();

		const exitCode = child.exitCode;
		const status =
			entry.stopReason === 'stopped'
				? 'stopped'
				: entry.stopReason === 'timed out' || exitCode !== 0
					? 'failed'
					: 'ok';
		const endedAt = Date.now();
		db.query<unknown, Params>(
			`UPDATE steps SET status = $status, ended_at = $endedAt, exit_code = $exitCode, pgid = NULL
			WHERE id = $id`,
		).run({ status, endedAt, exitCode, id: stepId });
		daemon.commands.delete(stepId);
		publishStep(daemon, stepId);
		taskChanged(daemon, task.id);
		if (!isWorking(daemon, task.id)) slotsChanged(daemon);

		const result = describeResult(daemon, task.handle, stepId, {
			command,
			exitCode,
			signal: child.signalCode === null ? null : String(child.signalCode),
			stopReason: entry.stopReason,
			ms: endedAt - startedAt,
		});
		if (entry.background) {
			ingest(daemon, {
				channel: 'internal',
				externalId: null,
				thread: null,
				kind: 'command_done',
				author: { name: 'command', id: null, isBot: false, isSelf: false },
				text: result,
				mentionsAgent: false,
				data: { step: stepId, exitCode },
				taskId: task.id,
			});
		}
		return result;
	})();

	let waitTimer: Timer | null = null;
	const finishedInTime = await Promise.race([
		entry.finished.then(() => true),
		new Promise<false>((resolve) => {
			waitTimer = setTimeout(() => resolve(false), WAIT_MS);
		}),
	]);
	if (waitTimer) clearTimeout(waitTimer);
	if (finishedInTime) return entry.finished;
	entry.background = true;
	return `still running as step ${stepId}; its result will arrive as a message. Use read_output to look at it meanwhile, or stop_command to end it.`;
}

/**
 * Where streamed output can be cut so that no key, whole or still arriving,
 * straddles the cut: the last `longest - 1` characters are held back, and the
 * cut moves to the start of any key that would cross it.
 */
function safeCut(secrets: string[], text: string): number {
	const longest = Math.max(0, ...secrets.map((secret) => secret.length));
	if (longest === 0) return text.length;
	let at = Math.max(0, text.length - (longest - 1));
	// Keys can't overlap themselves much; a chain longer than this is noise.
	const floor = Math.max(0, at - 2 * longest);
	const crosses = (start: number, end: number) =>
		secrets.some(
			(secret) =>
				start + secret.length > end &&
				secret.startsWith(text.slice(start, start + secret.length)),
		);
	for (let moved = true; moved;) {
		moved = false;
		for (let start = Math.max(floor, at - longest + 1); start < at; start++) {
			if (crosses(start, at)) {
				at = start;
				moved = true;
				break;
			}
		}
	}
	return at;
}

type Env = Record<string, string | undefined>;

function spawn(argv: string[], cwd: string, env: Env) {
	// `detached` makes the shell a process-group leader, so stopping the group
	// ends everything the command started.
	return Bun.spawn(argv, {
		cwd,
		env,
		detached: true,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
}

function describeResult(
	daemon: Daemon,
	handle: string,
	stepId: number,
	run: {
		command: string;
		exitCode: number | null;
		signal: string | null;
		stopReason: RunningCommand['stopReason'];
		ms: number;
	},
): string {
	const outcome =
		run.stopReason === 'timed out'
			? 'timed out'
			: run.stopReason === 'stopped'
				? 'stopped'
				: run.exitCode === null
					? `ended by ${run.signal ?? 'a signal'}`
					: `exit ${run.exitCode}`;
	const lines = readLog(daemon, commandLog(daemon, handle, stepId));
	const header = `step ${stepId} · ${outcome} · ${(run.ms / 1000).toFixed(1)} s · ${lines.length} ${lines.length === 1 ? 'line' : 'lines'} of output`;
	let body: string[];
	if (lines.length <= RESULT_HEAD_LINES + RESULT_TAIL_LINES) {
		body = lines;
	} else {
		body = [
			...lines.slice(0, RESULT_HEAD_LINES),
			`[… ${lines.length - RESULT_HEAD_LINES - RESULT_TAIL_LINES} lines not shown; read_output step=${stepId} from_line=${RESULT_HEAD_LINES + 1} …]`,
			...lines.slice(-RESULT_TAIL_LINES),
		];
	}
	const text = [header, `$ ${run.command}`, ...body].join('\n');
	return text.length > RESULT_MAX_CHARS
		? `${cut(text, RESULT_MAX_CHARS)}\n[cut at 8 KB; read_output step=${stepId} for the rest]`
		: text;
}

/** A command's output with the agent's keys redacted, since a command can print them. */
function readLog(daemon: Daemon, path: string): string[] {
	let text: string;
	try {
		text = redact(daemon.secrets, readFileSync(path, 'utf8'));
	} catch {
		return [];
	}
	if (text === '') return [];
	const lines = text.split('\n');
	if (lines.at(-1) === '') lines.pop();
	return lines;
}

/** Up to `count` lines of a command's saved output, from line `from` (1-based). */
export function readOutput(
	daemon: Daemon,
	handle: string,
	stepId: number,
	from: number,
	count: number,
): { lines: string[]; total: number } {
	const lines = readLog(daemon, commandLog(daemon, handle, stepId));
	const start = Math.max(1, from) - 1;
	return { lines: lines.slice(start, start + count), total: lines.length };
}

/** Ends a running command's process group: SIGTERM, then SIGKILL after 5 s. */
export async function stopCommand(
	daemon: Daemon,
	stepId: number,
	reason: 'stopped' = 'stopped',
): Promise<void> {
	const entry = daemon.commands.get(stepId);
	if (!entry) return;
	entry.stopReason ??= reason;
	signalGroup(entry.pgid, 'SIGTERM');
	const kill = setTimeout(
		() => signalGroup(entry.pgid, 'SIGKILL'),
		KILL_AFTER_MS,
	);
	await entry.finished.catch(() => '');
	clearTimeout(kill);
}

export async function stopTaskCommands(
	daemon: Daemon,
	taskId: number,
): Promise<void> {
	await Promise.all(
		[...daemon.commands.values()]
			.filter((entry) => entry.taskId === taskId)
			.map((entry) => stopCommand(daemon, entry.stepId)),
	);
}

/**
 * On start: a command still marked running was cut off by the crash. Its
 * process group is killed if it survived, its step becomes `stopped`, and a
 * `command_done` tells its Worker so it can run it again.
 */
export function recoverCommands(daemon: Daemon): number {
	const { db } = daemon;
	const steps = db
		.query<
			{
				id: number;
				taskId: number;
				handle: string;
				command: string | null;
				pgid: number | null;
			},
			[]
		>(
			`SELECT s.id, s.task_id AS taskId, t.handle, s.command, s.pgid FROM steps s
			JOIN tasks t ON t.id = s.task_id WHERE s.status = 'running'`,
		)
		.all();
	for (const step of steps) {
		if (step.pgid !== null) signalGroup(step.pgid, 'SIGKILL');
		db.query<unknown, [number, number]>(
			"UPDATE steps SET status = 'stopped', ended_at = ?, pgid = NULL WHERE id = ?",
		).run(Date.now(), step.id);
		try {
			appendFileSync(
				commandLog(daemon, step.handle, step.id),
				'\n[interrupted by a restart]\n',
			);
		} catch {
			// The log folder is gone; the step still records what happened.
		}
		ingest(daemon, {
			channel: 'internal',
			externalId: null,
			thread: null,
			kind: 'command_done',
			author: { name: 'command', id: null, isBot: false, isSelf: false },
			text: `step ${step.id} · stopped: interrupted by a restart\n$ ${step.command ?? ''}\nRun it again if you still need it.`,
			mentionsAgent: false,
			data: { step: step.id, exitCode: null },
			taskId: step.taskId,
		});
	}
	return steps.length;
}
