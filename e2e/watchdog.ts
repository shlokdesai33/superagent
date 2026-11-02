// End to end: the Watchdog. A Particle outage pauses tasks instead of failing
// them, and a free probe resumes them. Run with `bun run e2e`; it exits
// non-zero if a check fails.
import type { FeedLine, TaskSummary } from '../src/protocol.ts';
import { type FakeReply, startFakeParticle } from './fake-particle.ts';
import { type Agent, startAgent } from './harness.ts';

type TaskLine = Extract<FeedLine, { type: 'task' }>;
type HealthLine = Extract<FeedLine, { type: 'health' }>;

// 60 ms ticks; the 2-minute probe runs every 120 ms.
const SCALE = '0.001';

// What each task's fake Worker does, by the task's title.
const workers: Record<string, (called: string[]) => FakeReply> = {
	// Breaks while `outage` is on, then finishes.
	outage: () =>
		controls.outage
			? { broken: true }
			: {
					content: 'Done.',
					calls: [
						{ name: 'finish', args: { result: 'Done after the outage' } },
					],
				},
	// Every response breaks, though Particle itself answers.
	flaky: () => ({ broken: true }),
};

const controls = { outage: false, breakRouter: 0 };
const titles = new Map<string, string>();

// The Router starts a task titled `<name>` for `please run <name>`, and stays
// silent otherwise; each Worker follows its title's behavior.
const particle = startFakeParticle((request) => {
	if (request.session === 'compaction') return { content: 'Summary.' };
	if (request.session === 'router') {
		if (controls.breakRouter > 0) {
			controls.breakRouter -= 1;
			return { broken: true };
		}
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
	return behave(request.called);
});

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (!ok) failures += 1;
	process.stdout.write(
		`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}\n`,
	);
}

const workerCalls = (handle: string) =>
	particle.requests.filter(
		(request) => request.session === 'worker' && request.handle === handle,
	).length;

async function taskLine(
	agent: Agent,
	what: string,
	match: (task: TaskSummary) => boolean,
): Promise<TaskSummary> {
	return (
		await agent.waitFor(
			what,
			(line): line is TaskLine => line.type === 'task' && match(line.task),
		)
	).task;
}

/** Runs `body` against a fresh daemon, always stopping it. */
async function scenario(
	name: string,
	body: (agent: Agent) => Promise<void>,
): Promise<void> {
	process.stdout.write(`\n${name}\n`);
	const agent = await startAgent(particle.url, {
		env: { SUPERAGENT_WATCHDOG_SCALE: SCALE },
	});
	try {
		await body(agent);
	} catch (error) {
		failures += 1;
		process.stdout.write(
			`✗ ${error instanceof Error ? error.message : String(error)}\n`,
		);
	} finally {
		await agent.stop();
	}
}

try {
	await scenario('Particle outage', async (agent) => {
		controls.outage = true;
		particle.models.available = false;
		await agent.action({ type: 'send_console', text: 'please run outage' });
		const paused = await taskLine(
			agent,
			'the task waiting on Particle',
			(task) =>
				task.title === 'outage' &&
				task.status === 'waiting' &&
				task.waitingOn === 'Particle (unreachable)',
		);
		const { handle } = paused;
		check('a transient failure makes the task wait, not fail', true, handle);
		const down = await agent.waitFor(
			'the model in error',
			(line): line is HealthLine =>
				line.type === 'health' && line.health.model.state === 'error',
		);
		check(
			'health shows the model failing',
			down.health.model.state === 'error',
			down.health.model.detail ?? '',
		);
		const probes = particle.models.requests;
		await agent.until(
			'the probe to ask twice',
			async () => particle.models.requests,
			(count) => count >= probes + 2,
		);
		check(
			"while Particle is down, the Worker doesn't retry",
			workerCalls(handle) === 1,
			`${workerCalls(handle)} calls`,
		);

		controls.outage = false;
		particle.models.available = true;
		const done = await taskLine(
			agent,
			'the task finishing',
			(task) => task.handle === handle && task.status === 'done',
		);
		check(
			'once the probe gets an answer, the task carries on and finishes',
			done.result === 'Done after the outage',
			done.result ?? '',
		);
		const up = agent.lines.findLast(
			(line): line is HealthLine => line.type === 'health',
		);
		check('the model is healthy again', up?.health.model.state === 'ok');
	});

	await scenario("The probe ends the Router's backoff", async (agent) => {
		particle.models.available = false;
		controls.breakRouter = 1;
		const before = particle.requests.length;
		const started = Date.now();
		await agent.action({ type: 'send_console', text: 'please run outage' });
		await agent.waitFor(
			'the model in error',
			(line): line is HealthLine =>
				line.type === 'health' && line.health.model.state === 'error',
		);
		// A new event during the outage doesn't end the backoff, and doesn't
		// stop the probe from ending it later.
		await agent.action({ type: 'send_console', text: 'still there?' });
		await Bun.sleep(300);
		particle.models.available = true;
		const task = await taskLine(
			agent,
			'the Router starting the task',
			(summary) => summary.title === 'outage',
		);
		const routerCalls = particle.requests
			.slice(before)
			.filter((request) => request.session === 'router').length;
		check(
			'the Router decides again well before its 30-second backoff ends',
			routerCalls >= 2 && task.createdAt - started < 10_000,
			`${routerCalls} Router calls · ${((task.createdAt - started) / 1000).toFixed(1)} s`,
		);
	});

	await scenario('A request that keeps failing', async (agent) => {
		particle.models.available = true;
		await agent.action({ type: 'send_console', text: 'please run flaky' });
		const failed = await taskLine(
			agent,
			'the flaky task failing',
			(task) => task.title === 'flaky' && task.status === 'failed',
		);
		check(
			'a task fails after 3 transient failures while Particle answers',
			workerCalls(failed.handle) === 3,
			`${workerCalls(failed.handle)} calls · ${failed.result ?? ''}`,
		);
	});
} finally {
	particle.stop();
}

process.stdout.write(
	failures === 0 ? '\nAll checks passed.\n' : `\n${failures} failed.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
