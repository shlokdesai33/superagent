import {
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	statSync,
	truncateSync,
} from 'node:fs';
import { DaemonUnreachable, NOT_ANSWERING, readSnapshot } from './client.ts';
import { BACKGROUND_ENV, type DataPaths } from './home.ts';
import type { Snapshot } from './protocol.ts';

const ANSWER_WAIT_MS = 5_000;
const READY_WAIT_MS = 20_000;
const STOP_WAIT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export type StartResult =
	| { ok: true; started: boolean; snapshot: Snapshot }
	| { ok: false; cause: string; fix: string | null };

/**
 * The running agent's snapshot, or `null` when it isn't running. Throws
 * `not_answering` when it takes the connection but sends nothing for 5 s.
 */
export async function runningAgent(): Promise<Snapshot | null> {
	const signal = AbortSignal.timeout(ANSWER_WAIT_MS);
	try {
		return await readSnapshot(signal);
	} catch (error) {
		if (error instanceof DaemonUnreachable && error.kind === 'not_running') {
			return null;
		}
		if (signal.aborted) {
			throw new DaemonUnreachable(
				'not_answering',
				NOT_ANSWERING,
				`no answer on its socket within ${ANSWER_WAIT_MS / 1000} s`,
			);
		}
		throw error;
	}
}

/**
 * Starts the agent in the background unless it's running, and waits until it
 * answers. It runs in a session of its own, so it outlives this terminal, with
 * this terminal's environment, in the data folder.
 */
export async function startAgent(paths: DataPaths): Promise<StartResult> {
	const running = await runningAgent();
	if (running) return { ok: true, started: false, snapshot: running };

	mkdirSync(paths.home, { recursive: true, mode: 0o700 });
	const outputStart = fileSize(paths.output);
	const output = openSync(paths.output, 'a', 0o600);
	let child;
	try {
		child = Bun.spawn(daemonCommand(), {
			cwd: paths.home,
			env: { ...Bun.env, [BACKGROUND_ENV]: '1' },
			stdin: 'ignore',
			stdout: output,
			stderr: output,
			detached: true,
		});
	} finally {
		closeSync(output);
	}
	child.unref();

	const deadline = Date.now() + READY_WAIT_MS;
	while (Date.now() < deadline) {
		let snapshot: Snapshot | null = null;
		try {
			// oxlint-disable-next-line eslint/no-await-in-loop
			snapshot = await runningAgent();
		} catch (error) {
			// Listening but not answering yet: still starting, until the deadline.
			if (
				!(error instanceof DaemonUnreachable && error.kind === 'not_answering')
			)
				throw error;
		}
		if (snapshot) return { ok: true, started: true, snapshot };
		if (child.exitCode !== null || child.signalCode !== null) break;
		// oxlint-disable-next-line eslint/no-await-in-loop
		await Bun.sleep(100);
	}
	const said = newLines(paths.output, outputStart).at(-1);
	return {
		ok: false,
		cause: said ?? `It didn't answer within ${READY_WAIT_MS / 1000} s.`,
		fix: `More in ${paths.output}`,
	};
}

/** Stops the agent and waits for it to end. `false` when it wasn't running. */
export async function stopAgent(paths: DataPaths): Promise<boolean> {
	let pid: number;
	try {
		pid = Number(readFileSync(paths.pid, 'utf8').trim());
	} catch {
		return false;
	}
	if (!Number.isInteger(pid) || pid <= 0 || !alive(pid)) return false;
	process.kill(pid, 'SIGTERM');
	// A stopped agent (SIGSTOP, ctrl-z) only acts on SIGTERM once it continues.
	try {
		process.kill(pid, 'SIGCONT');
	} catch {
		// It already ended.
	}
	const deadline = Date.now() + STOP_WAIT_MS;
	while (alive(pid) && Date.now() < deadline) {
		// oxlint-disable-next-line eslint/no-await-in-loop
		await Bun.sleep(100);
	}
	if (alive(pid)) process.kill(pid, 'SIGKILL');
	return true;
}

/** Keeps output.log small; it's opened for appending, so truncating it is safe. */
export function trimOutput(paths: DataPaths): void {
	if (fileSize(paths.output) > MAX_OUTPUT_BYTES) {
		truncateSync(paths.output, 0);
	}
}

/** This executable running the agent: the binary itself, or Bun and the script from source. */
function daemonCommand(): string[] {
	return Bun.isStandaloneExecutable
		? [process.execPath, 'daemon']
		: [process.execPath, Bun.main, 'daemon'];
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}

function newLines(path: string, from: number): string[] {
	try {
		const bytes = readFileSync(path);
		return bytes
			.subarray(from <= bytes.length ? from : 0)
			.toString('utf8')
			.split('\n')
			.map((line) => line.trim())
			.filter((line) => line !== '');
	} catch {
		return [];
	}
}
