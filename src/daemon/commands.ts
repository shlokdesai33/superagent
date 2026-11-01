import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { ingest } from './ingest.ts';
import { type SandboxedCommand, sandboxCommand } from './sandbox.ts';
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
 * Built from an allowlist, never copied from the daemon's environment, so the
 * Particle key and other secrets can't reach a command.
 */
function commandEnv(daemon: Daemon, handle: string): Record<string, string> {
	const tmp = join(taskFolder(daemon, handle), 'tmp');
	return {
		PATH: daemon.loginPath,
		HOME: homedir(),
		USER: userInfo().username,
		SHELL: Bun.env.SHELL || '/bin/bash',
		LANG: Bun.env.LANG || 'C.UTF-8',
		TERM: 'dumb',
		TMPDIR: tmp,
		PAGER: 'cat',
		GIT_PAGER: 'cat',
		GIT_TERMINAL_PROMPT: '0',
		// The sandbox keeps .git read-only, so git status mustn't try to lock it.
		GIT_OPTIONAL_LOCKS: '0',
		// The home folder is hidden or read-only in the sandbox; caches go in tmp.
		XDG_CACHE_HOME: join(tmp, 'cache'),
		npm_config_cache: join(tmp, 'cache', 'npm'),
		BUN_INSTALL_CACHE_DIR: join(tmp, 'cache', 'bun'),
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
	const { db, sandbox } = daemon;
	if (sandbox.state !== 'on') {
		return `error: commands can't run: ${sandbox.text}. The operator has to fix that and restart the agent; the file tools still work.`;
	}
	const startedAt = Date.now();
	mkdirSync(join(taskFolder(daemon, task.handle), 'commands'), {
		recursive: true,
	});
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
	let sandboxed: SandboxedCommand | null = null;
	try {
		sandboxed = await sandboxCommand(
			daemon,
			task,
			join(taskFolder(daemon, task.handle), 'tmp'),
			command,
			'requested',
		);
		child = spawn(
			sandboxed.argv,
			task.workDir,
			commandEnv(daemon, task.handle),
		);
	} catch (error) {
		sandboxed?.finish();
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
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		for await (const chunk of stream) {
			const room = MAX_LOG_BYTES - written;
			if (room <= 0) {
				truncated = true;
				continue;
			}
			const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
			truncated ||= part.length < chunk.length;
			await sink.write(part);
			written += part.length;
		}
	};

	entry.finished = (async () => {
		await Promise.all([pump(child.stdout), pump(child.stderr), child.exited]);
		clearTimeout(timeout);
		if (killTimer) clearTimeout(killTimer);
		if (truncated) await sink.write('\n[output cut at 10 MB]\n');
		await sink.end();
		const denied = sandboxed.finish();

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
			denied,
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

function spawn(argv: string[], cwd: string, env: Record<string, string>) {
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
		/** What the sandbox refused it. */
		denied: string[];
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
	const lines = readLog(commandLog(daemon, handle, stepId));
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
	const denied =
		run.denied.length === 0
			? []
			: [
					'The sandbox denied:',
					...run.denied.map((line) => `  ${line}`),
					...(run.denied.some((line) => line.includes('network-outbound'))
						? [
								'request_host asks the operator to let your commands reach a host.',
							]
						: []),
				];
	const text = [header, `$ ${run.command}`, ...denied, ...body].join('\n');
	return text.length > RESULT_MAX_CHARS
		? `${cut(text, RESULT_MAX_CHARS)}\n[cut at 8 KB; read_output step=${stepId} for the rest]`
		: text;
}

function readLog(path: string): string[] {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
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
	const lines = readLog(commandLog(daemon, handle, stepId));
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
