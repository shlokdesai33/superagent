// End to end: Worker commands can't wait on input, and a message reaches a
// Worker whose command is still in the foreground. A prompt gets end of input
// at once, with no terminal to fall back on; an @ note to a task blocked on a
// silent command reaches its Worker within seconds, the command going on in
// the background under its own timeout, and the task view shows the note
// read; and a timeout ends a command whose helper left its process group.
// Run with `bun run e2e`; it exits non-zero if a check fails.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
	FeedLine,
	Health,
	TaskDetail,
	TaskSummary,
} from '../src/protocol.ts';
import {
	type FakeReply,
	type FakeRequest,
	startFakeParticle,
} from './fake-particle.ts';
import { startAgent } from './harness.ts';
import { openTui } from './tui.ts';

type TaskLine = Extract<FeedLine, { type: 'task' }>;
type StepLine = Extract<FeedLine, { type: 'step' }>;
type MessageLine = Extract<FeedLine, { type: 'message' }>;

const NOTE = 'are you stuck on chrome?';
// Asks like npx does, and gives up without an answer.
const PROMPT = `printf 'Need to install chrome. Ok to proceed? (y) '; read -r ok || { echo; echo 'no answer, not installing' >&2; exit 1; }`;
const PROBE = `tty=no; [ -t 0 ] && tty=stdin; (exec 3</dev/tty) 2>/dev/null && tty=yes; cat; echo "tty=$tty CI=$CI npm_config_yes=$npm_config_yes"`;
// Stands in for a browser that never returns.
const HANG = 'echo launching; sleep 60';
const HANG_TIMEOUT_S = 10;
// A helper that leaves the process group, like a daemon, and keeps the
// command's output open.
const ESCAPE = `setsid sh -c 'exec sleep 117' & sleep 60`;

const workers: Record<string, (request: FakeRequest) => FakeReply> = {
	prompter: (request) =>
		request.called.includes('run')
			? {
					content: 'Done.',
					calls: [{ name: 'finish', args: { result: 'Asked' } }],
				}
			: {
					content: 'Installing chrome.',
					calls: [
						{ name: 'run', args: { command: PROMPT } },
						{ name: 'run', args: { command: PROBE } },
					],
				},
	escaper: (request) =>
		request.called.includes('run')
			? {
					content: 'Done.',
					calls: [{ name: 'finish', args: { result: 'Escaped' } }],
				}
			: {
					content: 'Starting a daemon.',
					calls: [{ name: 'run', args: { command: ESCAPE, timeout_s: 2 } }],
				},
	blocker: (request) => {
		if (!request.called.includes('run')) {
			return {
				content: 'Launching chrome.',
				calls: [
					{
						name: 'run',
						args: { command: HANG, timeout_s: HANG_TIMEOUT_S },
					},
					{
						name: 'write_file',
						args: { path: 'after.txt', content: 'ran after\n' },
					},
				],
			};
		}
		if (request.fresh.includes('command finished')) {
			return {
				content: 'It timed out.',
				calls: [{ name: 'finish', args: { result: 'Saw the timeout' } }],
			};
		}
		return {
			content: 'Waiting on chrome.',
			calls: [{ name: 'wait_for', args: { what: 'the command' } }],
		};
	},
};

const titles = new Map<string, string>();
const particle = startFakeParticle((request) => {
	if (request.session === 'compaction') return { content: 'Summary.' };
	if (request.session === 'router') {
		const name = request.fresh.match(/please run (\w+)/)?.[1];
		if (!name) return { content: 'Nothing to say.' };
		return {
			calls: [
				{
					name: 'start_task',
					args: {
						title: name,
						instructions: `Run the ${name} scenario.`,
						threads: [],
						repo: 'none',
					},
				},
			],
		};
	}
	const handle = request.handle ?? '';
	const title =
		titles.get(handle) ??
		request.fresh.match(/You are the Worker for task \w+: (\w+)/)?.[1] ??
		'';
	titles.set(handle, title);
	const behave = workers[title];
	if (!behave) throw new Error(`no fake Worker for ${JSON.stringify(title)}`);
	return behave(request);
});

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (!ok) failures += 1;
	process.stdout.write(
		`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}\n`,
	);
}

// The daemon is trusted to send the shape it promises.
function isTaskDetail(value: unknown): value is TaskDetail {
	return (
		typeof value === 'object' &&
		value !== null &&
		'conversation' in value &&
		'workDir' in value
	);
}

function sandbox(): Health['sandbox'] | null {
	for (const line of agent.lines.toReversed()) {
		if (line.type === 'health') return line.health.sandbox;
		if (line.type === 'snapshot') return line.snapshot.health.sandbox;
	}
	return null;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** Kills the agent and starts it again, counting its socat bridges. */
async function crashAndRestart(): Promise<{
	bridges: number;
	left: number;
	after: number;
}> {
	const daemonPid = readFileSync(join(agent.home, 'daemon.pid'), 'utf8').trim();
	const pids = Bun.spawnSync(['pgrep', '-P', daemonPid, '-x', 'socat'])
		.stdout.toString()
		.trim()
		.split('\n')
		.filter(Boolean)
		.map(Number);
	await agent.crash();
	const left = pids.filter(alive).length;
	await agent.restart();
	await Bun.sleep(500);
	return { bridges: pids.length, left, after: pids.filter(alive).length };
}

const workerRequests = (handle: string) =>
	particle.requests.filter(
		(request) => request.session === 'worker' && request.handle === handle,
	);

const agent = await startAgent(particle.url);
const taskLine = async (what: string, match: (task: TaskSummary) => boolean) =>
	(
		await agent.waitFor(
			what,
			(line): line is TaskLine => line.type === 'task' && match(line.task),
		)
	).task;

try {
	// 1. A command that asks gets end of input at once, and so does `cat`.
	process.stdout.write('\nA prompt in a command\n');
	const startedAt = Date.now();
	await agent.action({ type: 'send_console', text: 'please run prompter' });
	const prompter = await taskLine(
		'the prompter finished',
		(task) => task.title === 'prompter' && task.status === 'done',
	);
	const [prompted, probed] = workerRequests(prompter.handle)[1]?.results ?? [];
	check(
		'a command that asks for input fails at once instead of waiting',
		Date.now() - startedAt < 10_000 &&
			(prompted ?? '').includes('exit 1') &&
			(prompted ?? '').includes('no answer, not installing'),
		prompted?.split('\n')[0],
	);
	check(
		'commands have no terminal, an empty stdin and a non-interactive environment',
		(probed ?? '').includes('exit 0') &&
			(probed ?? '').includes('\ntty=no CI=1 npm_config_yes=true'),
		probed,
	);

	// 2. An @ note while the Worker waits on a command that never ends.
	process.stdout.write('\nA note during a foreground command\n');
	await agent.action({ type: 'send_console', text: 'please run blocker' });
	const running = await agent.waitFor(
		'the blocker running its command',
		(line): line is StepLine =>
			line.type === 'step' &&
			line.step.command === HANG &&
			line.step.status === 'running',
	);
	const handle = running.taskHandle;
	const outside = mkdtempSync(join(tmpdir(), 'sa-outside-'));
	const tui = await openTui(agent.home, outside);
	try {
		// The working task is the first row, selected.
		await tui.waitFor('blocker');
		await tui.type('\r');
		await tui.waitFor('STEPS');
		await tui.type(`/${NOTE}`);
		const mark = tui.mark();
		const sentAt = Date.now();
		await tui.type('\r');
		await tui.waitFor(`Sent to ${handle}`, mark);
		const heard = await agent.until(
			'the Worker hearing the note',
			async () =>
				workerRequests(handle).find((request) => request.fresh.includes(NOTE)),
			(request) => request !== undefined,
		);
		const latency = Date.now() - sentAt;
		check(
			'the note reaches the Worker within seconds, not once the command ends',
			latency < 3_000,
			`${latency} ms`,
		);
		const [ran, skipped] = heard?.results ?? [];
		check(
			'its run result says the command went on in the background',
			(ran ?? '').includes(
				'a new message arrived, so it went on in the background',
			),
			ran,
		);
		check(
			'the rest of its turn waits for the note',
			(skipped ?? '').startsWith('not run: a new message arrived first'),
			skipped,
		);
		const read = await agent.waitFor(
			'the note shown read',
			(line): line is MessageLine =>
				line.type === 'message' &&
				line.message.text === NOTE &&
				(line.message.worker?.readAt ?? null) !== null,
		);
		check(
			'the note is published as read by the Worker',
			read.message.taskHandle === handle,
		);
		await tui.waitFor('read ', mark);
		check(
			'the task view shows the note read',
			/are you stuck on chrome\?.*read \d\d:\d\d/.test(tui.seen(mark)),
		);
	} finally {
		await tui.quit();
	}

	// 3. The command keeps its own timeout in the background.
	const done = await taskLine(
		'the blocker finished',
		(task) => task.handle === handle && task.status === 'done',
	);
	const ended = workerRequests(handle).find((request) =>
		request.fresh.includes('command finished'),
	);
	check(
		'the command is stopped at its own timeout, and the Worker told',
		done.result === 'Saw the timeout' &&
			(ended?.fresh ?? '').includes('timed out'),
	);
	const detail = await agent.get(`/v1/tasks/${handle}`);
	if (!isTaskDetail(detail)) throw new Error(`not a task detail: ${handle}`);
	check(
		'the task detail has the note read',
		detail.conversation.some(
			(message) =>
				message.text === NOTE && (message.worker?.readAt ?? null) !== null,
		),
	);
	check(
		'the call after the command was not run',
		!existsSync(join(detail.workDir, 'after.txt')),
	);

	// 4. Its timeout ends a command whose helper left the process group.
	process.stdout.write('\nA helper outside the process group\n');
	const escapeAt = Date.now();
	await agent.action({ type: 'send_console', text: 'please run escaper' });
	const escaper = await taskLine(
		'the escaper finished',
		(task) => task.title === 'escaper' && task.status === 'done',
	);
	const [escaped] = workerRequests(escaper.handle)[1]?.results ?? [];
	check(
		'the command ends at its timeout though its helper left the process group',
		Date.now() - escapeAt < 20_000 && (escaped ?? '').includes('timed out'),
		escaped?.split('\n')[0],
	);
	// bubblewrap ends everything in the sandbox with the command, the helper
	// too; unsandboxed, the helper outlives it and holds its output.
	if (sandbox() === 'on') {
		check(
			'in the sandbox, the helper ends with the command',
			Bun.spawnSync(['pgrep', '-f', 'sleep 117']).exitCode !== 0,
		);
	} else {
		check(
			'unsandboxed, its output says the helper may still run',
			(escaped ?? '').includes('outside its process group'),
			escaped,
		);
	}

	// 5. A crash leaves the sandbox's socat bridges running; the next start
	//    ends them, after Worker commands and before any.
	if (sandbox() === 'on' && process.platform === 'linux') {
		process.stdout.write('\nThe sandbox after a crash\n');
		for (const when of ['after commands ran', 'before any command']) {
			// oxlint-disable-next-line eslint/no-await-in-loop
			const { bridges, left, after } = await crashAndRestart();
			check(
				`the next start ends the socat bridges a crash ${when} left behind`,
				bridges > 0 && left === bridges && after === 0,
				`${bridges} bridges, ${left} left by the crash, ${after} after the restart`,
			);
		}
	}
} catch (error) {
	failures += 1;
	process.stdout.write(
		`✗ ${error instanceof Error ? error.message : String(error)}\n`,
	);
} finally {
	await agent.stop((home) => {
		const log = readFileSync(join(home, 'daemon.log'), 'utf8');
		check(
			'the log says why the command was left and the turn cut short',
			log.includes('command left running for a message') &&
				log.includes('worker turn cut short by a message'),
		);
	});
	particle.stop();
	Bun.spawnSync(['pkill', '-f', 'sleep 117']);
}

process.stdout.write(failures === 0 ? '\nall checks passed\n' : '\n');
process.exit(failures === 0 ? 0 : 1);
