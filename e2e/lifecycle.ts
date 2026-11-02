// End to end: the background agent's commands as a user runs them,
// `superagent start`, `status` and `stop`, on an isolated data folder. Run
// with `bun run e2e`; it exits non-zero if a check fails.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startAgent } from '../src/background.ts';
import { dataPaths } from '../src/home.ts';
import { startFakeParticle } from './fake-particle.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');

// startAgent starts its own script with `daemon`, so called from here it
// starts this one: a stand-in agent that takes connections on its socket and
// never answers, like an agent still starting up.
if (Bun.argv[2] === 'daemon') {
	const folder = Bun.env.SUPERAGENT_HOME ?? '';
	writeFileSync(join(folder, 'daemon.pid'), `${process.pid}\n`);
	Bun.listen({
		unix: join(folder, 'agent.sock'),
		socket: { data() {} },
	});
	process.stderr.write('stand-in agent: listening, never answering\n');
	await new Promise(() => {});
}

const particle = startFakeParticle(() => ({ content: 'Nothing to do.' }));
// Short, to stay under the socket path limit.
const home = mkdtempSync('/tmp/sa-');
const env = {
	...Bun.env,
	SUPERAGENT_HOME: home,
	PARTICLE_BASE_URL: particle.url,
	PARTICLE_API_KEY: 'pai-e2e',
	SUPERAGENT_GH: join(home, 'no-gh'),
};

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (!ok) failures += 1;
	process.stdout.write(
		`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}\n`,
	);
}

type Run = { code: number | null; out: string; ms: number };

/** Runs `superagent <args>`, killing it after `limitMs`. */
async function superagent(args: string[], limitMs = 20_000): Promise<Run> {
	const SUPERAGENT = Bun.env.SUPERAGENT_BIN
		? [Bun.env.SUPERAGENT_BIN]
		: ['bun', CLI];
	const started = Date.now();
	const child = Bun.spawn([...SUPERAGENT, ...args], {
		env,
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const timer = setTimeout(() => child.kill('SIGKILL'), limitMs);
	const [stdout, stderr] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearTimeout(timer);
	return {
		code: child.signalCode === null ? child.exitCode : null,
		out: (stdout + stderr).trim(),
		ms: Date.now() - started,
	};
}

function agentPid(): number {
	return Number(readFileSync(join(home, 'daemon.pid'), 'utf8').trim());
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

try {
	process.stdout.write('\nStart, status and stop\n');
	const before = await superagent(['status']);
	check(
		"status with no agent says it isn't running",
		before.code === 1 && before.out.includes("superagent isn't running"),
		before.out,
	);
	const started = await superagent(['start']);
	check(
		'start starts it in the background',
		started.code === 0 && started.out.startsWith('Started superagent'),
		started.out,
	);
	const again = await superagent(['start']);
	check(
		'start again says it is already running',
		again.code === 0 && again.out.startsWith('superagent is already running'),
		again.out,
	);
	const status = await superagent(['status']);
	check(
		'status describes it',
		status.code === 0 && status.out.startsWith('Agent running'),
		status.out.split('\n')[0],
	);

	process.stdout.write('\nA frozen agent, as after SIGSTOP\n');
	const frozen = agentPid();
	process.kill(frozen, 'SIGSTOP');
	const stuck = await superagent(['status']);
	check(
		"status says it isn't answering instead of waiting forever",
		stuck.code === 1 && stuck.out.includes("isn't answering"),
		`${stuck.out || 'killed'} · ${stuck.ms} ms`,
	);
	const stopped = await superagent(['stop']);
	check(
		'stop still stops it',
		stopped.code === 0 &&
			stopped.out.startsWith('Stopped superagent') &&
			!alive(frozen),
		`${stopped.out || 'killed'} · ${stopped.ms} ms`,
	);
	check(
		'it shut down cleanly rather than being killed',
		readFileSync(join(home, 'daemon.log'), 'utf8').includes('"stopping"'),
	);
	const after = await superagent(['stop']);
	check(
		"stop again says it isn't running",
		after.code === 0 && after.out === "superagent isn't running.",
		after.out,
	);

	process.stdout.write('\nAn agent that listens but never answers\n');
	const slowHome = mkdtempSync('/tmp/sa-');
	const saved = Bun.env.SUPERAGENT_HOME;
	Bun.env.SUPERAGENT_HOME = slowHome;
	const waitStarted = Date.now();
	let outcome: string;
	try {
		const result = await startAgent(dataPaths());
		outcome = result.ok ? 'started' : result.cause;
	} catch (error) {
		outcome = `threw: ${error instanceof Error ? error.message : String(error)}`;
	} finally {
		if (saved === undefined) delete Bun.env.SUPERAGENT_HOME;
		else Bun.env.SUPERAGENT_HOME = saved;
	}
	const waited = Date.now() - waitStarted;
	check(
		'start keeps waiting for the full 20 s, then says what it printed',
		outcome === 'stand-in agent: listening, never answering' &&
			waited >= 19_000,
		`${outcome} · ${waited} ms`,
	);
	try {
		process.kill(
			Number(readFileSync(join(slowHome, 'daemon.pid'), 'utf8').trim()),
			'SIGKILL',
		);
	} catch {
		// It never started.
	}
	rmSync(slowHome, { recursive: true, force: true });
} finally {
	try {
		const pid = agentPid();
		process.kill(pid, 'SIGCONT');
		process.kill(pid, 'SIGKILL');
	} catch {
		// Not running.
	}
	particle.stop();
	if (!Bun.env.E2E_KEEP) rmSync(home, { recursive: true, force: true });
}

process.stdout.write(
	failures === 0 ? '\nAll checks passed.\n' : `\n${failures} checks failed.\n`,
);
process.exit(failures === 0 ? 0 : 1);
