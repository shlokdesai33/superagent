#!/usr/bin/env bun
import { closeSync, mkdirSync, openSync, readSync, statSync } from 'node:fs';
import packageJson from '../package.json' with { type: 'json' };
import {
	type StartResult,
	runningAgent,
	startAgent,
	stopAgent,
	trimOutput,
} from './background.ts';
import { DaemonUnreachable, NOT_RUNNING } from './client.ts';
import { runDaemon } from './daemon/main.ts';
import { StartupError } from './daemon/setup.ts';
import { BACKGROUND_ENV, dataPaths } from './home.ts';
import { writeKeyFile } from './keys.ts';
import {
	API_KEY_ENV,
	checkApiKey,
	looksLikeApiKey,
} from './particle/client.ts';
import type { Snapshot } from './protocol.ts';
import { Cancelled, readSecret } from './read-secret.ts';
import { formatStatus } from './status.ts';
import { runTui } from './tui/main.ts';

const usage = `Usage: superagent [command] [options]

superagent works in a background agent that keeps running when you close the
terminal UI, until you stop it or restart the computer.

Commands:
  (none)          Open the terminal UI, starting the background agent first if
                  it isn't running; prints the status when not in a terminal
  start           Start the background agent
  stop            Stop it; working tasks pause and resume on the next start
  restart         Stop it and start it again
  status          Print whether it's running, its tasks and its health
  logs            Print its log; --follow keeps printing new lines
  login particle  Ask for your Particle API key, check it and save it
  daemon          Run the agent in this terminal instead, until Ctrl-C

Options:
  --json            With status: print the raw snapshot JSON
  -f, --follow      With logs: keep printing new lines until Ctrl-C
  --script-channel  With daemon: accept test events on POST /v1/events
  -h, --help        Show this help
  -v, --version     Show the version

The data folder is $SUPERAGENT_HOME, or ~/.superagent.`;

const LOG_LINES = 100;

const [command, ...rest] = Bun.argv.slice(2);

try {
	await main();
} catch (error) {
	if (!(error instanceof DaemonUnreachable)) throw error;
	console.error(
		error.kind === 'rejected'
			? 'superagent is running a different version. Run `superagent restart`.'
			: error.message,
	);
	process.exitCode = 1;
}

async function main(): Promise<void> {
	switch (command) {
		case undefined:
			if (process.stdin.isTTY && process.stdout.isTTY) await terminalUi();
			else await status(false);
			break;
		case '-h':
		case '--help':
			if (rest.length > 0) fail(`Unexpected argument: ${rest[0]}`);
			else console.log(usage);
			break;
		case '-v':
		case '--version':
			if (rest.length > 0) fail(`Unexpected argument: ${rest[0]}`);
			else console.log(packageJson.version);
			break;
		case 'start':
			if (rest.length > 0) fail(`Unexpected argument: ${rest[0]}`);
			else await start();
			break;
		case 'stop':
			if (rest.length > 0) fail(`Unexpected argument: ${rest[0]}`);
			else await stop();
			break;
		case 'restart':
			if (rest.length > 0) fail(`Unexpected argument: ${rest[0]}`);
			else {
				await stop();
				await start();
			}
			break;
		case 'status': {
			const unexpected = rest.find((arg) => arg !== '--json');
			if (unexpected !== undefined) fail(`Unexpected argument: ${unexpected}`);
			else await status(rest.includes('--json'));
			break;
		}
		case 'logs': {
			const unexpected = rest.find((arg) => arg !== '-f' && arg !== '--follow');
			if (unexpected !== undefined) fail(`Unexpected argument: ${unexpected}`);
			else await logs(rest.length > 0);
			break;
		}
		// Never echo the arguments: one may be a key typed in by mistake.
		case 'login':
			if (rest[0] !== 'particle') fail('Usage: superagent login particle');
			else if (rest.length > 1) {
				fail(
					'superagent login particle takes no arguments; it asks for the key',
				);
			} else await loginParticle();
			break;
		case 'daemon': {
			const unexpected = rest.find((arg) => arg !== '--script-channel');
			if (unexpected !== undefined) fail(`Unexpected argument: ${unexpected}`);
			else await daemon(rest.includes('--script-channel'));
			break;
		}
		default:
			fail(`Unknown command: ${command}`);
	}
}

async function terminalUi(): Promise<void> {
	const started = await startAgent(dataPaths());
	if (!started.ok) {
		printStartFailure(started);
		return;
	}
	await runTui();
	const snapshot = await runningAgent();
	if (snapshot) {
		console.log(
			`superagent is still running in the background · ${working(snapshot)} · \`superagent stop\` stops it`,
		);
	}
}

async function start(): Promise<void> {
	const started = await startAgent(dataPaths());
	if (!started.ok) {
		printStartFailure(started);
		return;
	}
	const { pid } = started.snapshot.agent;
	console.log(
		started.started
			? `Started superagent in the background (pid ${pid}) · ${working(started.snapshot)}`
			: `superagent is already running (pid ${pid}) · ${working(started.snapshot)}`,
	);
}

async function stop(): Promise<void> {
	const paths = dataPaths();
	let snapshot: Snapshot | null = null;
	try {
		snapshot = await runningAgent();
	} catch (error) {
		// Another version still answers, and stops like any other.
		if (!(error instanceof DaemonUnreachable)) throw error;
	}
	const count = snapshot ? workingCount(snapshot) : 0;
	if (!(await stopAgent(paths))) {
		console.log("superagent isn't running.");
		return;
	}
	console.log(
		count === 0
			? 'Stopped superagent.'
			: `Stopped superagent. ${count === 1 ? '1 working task is paused and resumes' : `${count} working tasks are paused and resume`} on the next start.`,
	);
}

async function daemon(scriptChannel: boolean): Promise<void> {
	const paths = dataPaths();
	if (Bun.env[BACKGROUND_ENV]) trimOutput(paths);
	try {
		await runDaemon({ scriptChannel });
	} catch (error) {
		if (!(error instanceof StartupError)) throw error;
		console.error(error.message);
		process.exitCode = 1;
	}
}

async function status(json: boolean): Promise<void> {
	const snapshot = await runningAgent();
	if (!snapshot) {
		console.error(NOT_RUNNING);
		process.exitCode = 1;
		return;
	}
	console.log(
		json
			? JSON.stringify(snapshot, null, 2)
			: formatStatus(snapshot, dataPaths()),
	);
}

function printStartFailure(started: Exclude<StartResult, { ok: true }>): void {
	console.error(`superagent couldn't start. ${started.cause}`);
	if (started.fix) console.error(started.fix);
	process.exitCode = 1;
}

function workingCount(snapshot: Snapshot): number {
	return snapshot.tasks.filter((task) => task.status === 'working').length;
}

function working(snapshot: Snapshot): string {
	const count = workingCount(snapshot);
	return count === 1 ? '1 task working' : `${count} tasks working`;
}

/** The log's last lines, readable, then new ones as they come with `follow`. */
async function logs(follow: boolean): Promise<void> {
	const path = dataPaths().log;
	let offset = 0;
	let pending = '';
	const read = (): void => {
		let size: number;
		try {
			size = statSync(path).size;
		} catch {
			return;
		}
		// The log starts over at 10 MB.
		if (size < offset) offset = 0;
		if (size === offset) return;
		const file = openSync(path, 'r');
		try {
			const bytes = Buffer.alloc(size - offset);
			readSync(file, bytes, 0, bytes.length, offset);
			offset = size;
			const lines = (pending + bytes.toString('utf8')).split('\n');
			pending = lines.pop() ?? '';
			for (const line of lines) {
				if (line.trim() !== '') console.log(readableLogLine(line));
			}
		} finally {
			closeSync(file);
		}
	};
	try {
		const size = statSync(path).size;
		// Start a little before the last lines, which are all that's shown.
		offset = Math.max(0, size - LOG_LINES * 400);
	} catch {
		if (!follow) {
			console.error(`There's no log yet at ${path}`);
			process.exitCode = 1;
			return;
		}
	}
	if (offset > 0) {
		// Skip to the first whole line.
		const file = openSync(path, 'r');
		const probe = Buffer.alloc(4096);
		const length = readSync(file, probe, 0, probe.length, offset);
		closeSync(file);
		const newline = probe.subarray(0, length).indexOf('\n');
		offset += newline + 1;
	}
	read();
	if (!follow) return;
	for (;;) {
		// oxlint-disable-next-line eslint/no-await-in-loop
		await Bun.sleep(500);
		read();
	}
}

/** `MM-DD HH:MM:SS level message key=value`, from one JSON log line. */
function readableLogLine(line: string): string {
	let entry: unknown;
	try {
		entry = JSON.parse(line);
	} catch {
		return line;
	}
	if (typeof entry !== 'object' || entry === null) return line;
	const fields = Object.fromEntries(Object.entries(entry));
	const { at, level, message } = fields;
	delete fields.at;
	delete fields.level;
	delete fields.message;
	const when = typeof at === 'string' ? new Date(at) : null;
	const stamp =
		when && !Number.isNaN(when.getTime())
			? `${String(when.getMonth() + 1).padStart(2, '0')}-${String(when.getDate()).padStart(2, '0')} ${when.toTimeString().slice(0, 8)}`
			: '';
	const details = Object.entries(fields)
		.map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
		.join('');
	return `${stamp} ${String(level).padEnd(5)} ${String(message)}${details}`;
}

async function loginParticle(): Promise<void> {
	let key: string;
	try {
		key = await readSecret('Particle API key (input hidden): ');
	} catch (error) {
		if (!(error instanceof Cancelled)) throw error;
		process.exitCode = 130;
		return;
	}
	if (!looksLikeApiKey(key)) {
		console.error(
			key === ''
				? 'No key given; nothing saved.'
				: "That isn't a Particle API key (they start with pai-); nothing saved.",
		);
		process.exitCode = 1;
		return;
	}
	const baseUrl = Bun.env.PARTICLE_BASE_URL;
	const check = await checkApiKey(
		baseUrl ? { apiKey: key, baseUrl } : { apiKey: key },
	);
	if (check.result === 'rejected') {
		console.error('Particle rejected this key; nothing saved.');
		process.exitCode = 1;
		return;
	}
	const paths = dataPaths();
	mkdirSync(paths.home, { recursive: true, mode: 0o700 });
	writeKeyFile(paths.particleKey, key);
	console.log(
		check.result === 'valid'
			? `Particle accepted the key. Saved it to ${paths.particleKey}`
			: `Couldn't check the key with Particle (${check.problem}). Saved it to ${paths.particleKey}`,
	);
	console.log(
		Bun.env[API_KEY_ENV]
			? `${API_KEY_ENV} is set here and overrides the file while it is.`
			: 'A running agent picks it up within a few seconds.',
	);
}

function fail(message: string): void {
	console.error(`${message}\n\n${usage}`);
	process.exitCode = 1;
}
