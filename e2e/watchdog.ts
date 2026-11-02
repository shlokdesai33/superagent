// End to end: the Watchdog. Its checks run quietly when nothing is wrong and
// through a sleep; a Particle outage pauses tasks instead of failing them, and
// a free probe resumes them. After every scenario, the Watchdog must have
// taken no action it wasn't meant to. Run with `bun run e2e`; it exits
// non-zero if a check fails.
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedLine, TaskSummary } from '../src/protocol.ts';
import {
	type FakeReply,
	type FakeRequest,
	startFakeParticle,
} from './fake-particle.ts';
import { type Agent, startAgent } from './harness.ts';

type TaskLine = Extract<FeedLine, { type: 'task' }>;
type HealthLine = Extract<FeedLine, { type: 'health' }>;

// 60 ms ticks; the 2-minute probe runs every 120 ms.
const SCALE = '0.001';

// What each task's fake Worker does, by the task's title.
const workers: Record<string, (request: FakeRequest) => FakeReply> = {
	// Answers slowly, then finishes.
	slow: () => ({
		content: 'Done.',
		calls: [{ name: 'finish', args: { result: 'Done slowly' } }],
		delayMs: 3_600,
	}),
	// Read the same missing file forever, slowly enough that the quiet calls
	// after a verdict (20 after a note, 40 after progressing) outlast the 30
	// minutes (1.8 s) between a task's reviews, so the call counts decide.
	looper: () => ({
		content: 'Looking again.',
		calls: [{ name: 'read_file', args: { path: 'notes.txt' } }],
		delayMs: 100,
	}),
	// Loops until a review of it starts, then makes progress (an edit) and
	// waits, while the review is still running.
	recoverer: (request) =>
		!reviews.some((review) => review.handle === request.handle)
			? {
					content: 'Looking again.',
					calls: [{ name: 'read_file', args: { path: 'notes.txt' } }],
					delayMs: 20,
				}
			: request.called.includes('write_file')
				? {
						content: 'Waiting.',
						calls: [{ name: 'wait_for', args: { what: 'the operator' } }],
					}
				: {
						content: 'Writing it down.',
						calls: [
							{
								name: 'write_file',
								args: { path: 'notes.txt', content: 'found it\n' },
							},
						],
					},
	thinker: () => ({
		content: 'Thinking it over.',
		calls: [{ name: 'read_file', args: { path: 'notes.txt' } }],
		delayMs: 60,
	}),
	// Reads the same missing file forever: calls without progress.
	spinner: () => ({
		content: 'Looking again.',
		calls: [{ name: 'read_file', args: { path: 'notes.txt' } }],
	}),
	// Runs the same failing command forever: reruns aren't progress. It takes
	// a little time, so runs don't share a millisecond with the last mark.
	retester: () => ({
		content: 'Trying the test again.',
		calls: [{ name: 'run', args: { command: 'sleep 0.02; exit 1' } }],
	}),
	// Edits a file every call (progress), then finishes after 170 calls.
	editor: (request) =>
		request.called.length >= 170
			? {
					content: 'Done.',
					calls: [{ name: 'finish', args: { result: 'Edited 170 times' } }],
				}
			: {
					content: 'Editing.',
					calls: [
						{
							name: 'write_file',
							args: {
								path: 'progress.txt',
								content: `step ${request.called.length}\n`,
							},
						},
					],
				},
	// Starts a long, silent command, then waits on it.
	hanger: (request) =>
		request.called.includes('run')
			? {
					content: 'Waiting on it.',
					calls: [{ name: 'wait_for', args: { what: 'the command' } }],
				}
			: {
					content: 'Starting it.',
					calls: [
						{ name: 'run', args: { command: 'sleep 100', timeout_s: 1000 } },
					],
				},
	// Ends its turns without tool calls, even after the nudge.
	quitter: () => ({ content: "I think that's it." }),
	// Waits on CI, though it follows no thread that could tell it.
	ciwaiter: () => ({
		content: 'Waiting for CI.',
		calls: [{ name: 'wait_for', args: { what: 'CI' } }],
	}),
	// Finishes at once.
	quick: () => ({
		content: 'Done.',
		calls: [{ name: 'finish', args: { result: 'Done quickly' } }],
	}),
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
	// Waits for a note, then quietly waits again, telling the Router nothing.
	waiter: (request) => ({
		content: 'Waiting.',
		calls: [
			{
				name: 'wait_for',
				args: {
					what: request.fresh.includes('go on') ? 'another note' : 'a note',
				},
			},
		],
	}),
};

const controls = { outage: false, breakRouter: 0 };
const titles = new Map<string, string>();

// The Router starts a task titled `<name>` for `please run <name>`, and stays
// silent otherwise; each Worker follows its title's behavior.
// The fake reviewer's verdict for each task, by title; `progressing` otherwise.
const verdicts: Record<
	string,
	{ verdict: string; reason: string; advice: string }
> = {
	recoverer: {
		verdict: 'looping',
		reason: 'It reads the same missing file again and again.',
		advice: 'Stop reading notes.txt.',
	},
	looper: {
		verdict: 'looping',
		reason: 'It reads the same missing file again and again.',
		advice: 'Stop reading notes.txt: create it, or ask the operator.',
	},
};
// How long the fake reviewer takes, by title.
const reviewDelays: Record<string, number> = { recoverer: 100 };
// Every review the fake reviewer answered, with the Worker's calls by then.
const reviews: Array<{
	handle: string;
	title: string;
	workerCalls: number;
	input: string;
}> = [];

const particle = startFakeParticle((request) => {
	if (request.session === 'compaction') return { content: 'Summary.' };
	if (request.session === 'watchdog') {
		const [, handle = '', title = ''] =
			request.fresh.match(/^Task (\w+): (\w+)/) ?? [];
		reviews.push({
			handle,
			title,
			workerCalls: workerCalls(handle),
			input: request.fresh,
		});
		return {
			delayMs: reviewDelays[title] ?? 0,
			calls: [
				{
					name: 'verdict',
					args: verdicts[title] ?? {
						verdict: 'progressing',
						reason: 'Each step tries something new.',
						advice: 'Keep going.',
					},
				},
			],
		};
	}
	if (request.session === 'router') {
		if (controls.breakRouter > 0) {
			controls.breakRouter -= 1;
			return { broken: true };
		}
		const name = request.fresh.match(/please run (\w+)/)?.[1];
		if (!name) return { content: 'Nothing to say.' };
		// Asked on a script thread: the task follows it.
		const thread = request.fresh.match(/\((script:[^,]+), no owner\)/)?.[1];
		return {
			calls: [
				{
					name: 'start_task',
					args: {
						title: name,
						instructions: `Run the ${name} scenario.`,
						threads: thread ? [thread] : [],
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
	options: {
		/** Findings that may act or report here, by key. */
		allowed?: RegExp;
		scale?: string;
		/** Written as `config.json`. */
		config?: Record<string, unknown>;
	} = {},
): Promise<void> {
	const { allowed = null, scale = SCALE, config } = options;
	process.stdout.write(`\n${name}\n`);
	const agent = await startAgent(particle.url, {
		env: { SUPERAGENT_WATCHDOG_SCALE: scale },
		...(config ? { config } : {}),
	});
	try {
		await body(agent);
	} catch (error) {
		failures += 1;
		process.stdout.write(
			`✗ ${error instanceof Error ? error.message : String(error)}\n`,
		);
	} finally {
		await agent.stop((home) => {
			const db = new Database(join(home, 'state.db'), { readonly: true });
			const acted = db
				.query<{ key: string; stage: string | null; kind: string | null }, []>(
					`SELECT key, stage, problem_kind AS kind FROM watchdog_findings
					WHERE stage IS NOT NULL OR problem_kind IS NOT NULL`,
				)
				.all()
				.filter((finding) => !allowed?.test(finding.key));
			db.close();
			check(
				allowed
					? 'the Watchdog took no other action and reported nothing'
					: 'the Watchdog took no action and reported nothing',
				acted.length === 0,
				acted
					.map((finding) => `${finding.key}: ${finding.stage ?? finding.kind}`)
					.join(', '),
			);
		});
	}
}

type TaskDetail = {
	task: TaskSummary;
	conversation: Array<{ author: string; text: string }>;
};

// The daemon is trusted to send the shape it promises.
function isTaskDetail(value: unknown): value is TaskDetail {
	return (
		typeof value === 'object' &&
		value !== null &&
		'task' in value &&
		'conversation' in value
	);
}

async function taskDetail(agent: Agent, handle: string): Promise<TaskDetail> {
	const detail = await agent.get(`/v1/tasks/${handle}`);
	if (!isTaskDetail(detail)) throw new Error(`not a task detail: ${handle}`);
	return detail;
}

/** Problems from the latest health line, by ID. */
function problems(
	agent: Agent,
): Map<string, { text: string; fix: string | null }> {
	const health = agent.lines.findLast(
		(line): line is HealthLine => line.type === 'health',
	)?.health;
	return new Map(
		(health?.problems ?? []).map((problem) => [
			problem.id,
			{ text: problem.text, fix: problem.fix },
		]),
	);
}

const problemFor = (agent: Agent, prefix: string, suffix: string) =>
	[...problems(agent)].find(
		([id]) => id.startsWith(prefix) && id.endsWith(suffix),
	)?.[1];

const watchdogLines = (agent: Agent) =>
	agent.lines.filter(
		(line): line is HealthLine =>
			line.type === 'health' && line.health.watchdog.lastCheckAt !== null,
	);

try {
	await scenario('Quiet', async (agent) => {
		await agent.action({ type: 'send_console', text: 'please run quick' });
		const done = await taskLine(
			agent,
			'the quick task finishing',
			(task) => task.title === 'quick' && task.status === 'done',
		);
		check('a task runs to the end', done.result === 'Done quickly');
		await agent.until(
			'the Watchdog to check a few times',
			async () => watchdogLines(agent).length,
			(count) => count >= 5,
		);
		const checks = watchdogLines(agent).map(
			(line) => line.health.watchdog.lastCheckAt ?? 0,
		);
		check(
			'health shows the Watchdog checking, again and again',
			checks.every((at, index) => index === 0 || at > (checks[index - 1] ?? 0)),
			`${checks.length} checks`,
		);
		check(
			'with nothing wrong, the Watchdog makes no model calls',
			!particle.requests.some((request) => request.session === 'watchdog'),
		);
		const last = watchdogLines(agent).at(-1)?.health;
		check(
			'no Watchdog problems and no reviews',
			last !== undefined &&
				!last.problems.some(
					(problem) => problem.kind === 'task' || problem.kind === 'agent',
				) &&
				last.watchdog.reviewsToday === 0,
		);
	});

	await scenario('A sleep before the first check', async (agent) => {
		// The first check runs 2 ticks (120 ms) after start; stop the daemon
		// before it, when the harness is quick enough to.
		if (watchdogLines(agent).length > 0) {
			process.stdout.write(
				'- skipped: the first check ran before the daemon could be stopped\n',
			);
			return;
		}
		agent.signal('SIGSTOP');
		await Bun.sleep(600);
		agent.signal('SIGCONT');
		await agent.until(
			'the wake in the log',
			async () => readFileSync(join(agent.home, 'daemon.log'), 'utf8'),
			(log) => log.includes('watchdog saw the machine wake'),
		);
		check('a sleep during the start delay is seen and subtracted', true);
	});

	await scenario('Sleep', async (agent) => {
		await agent.action({ type: 'send_console', text: 'please run waiter' });
		await taskLine(
			agent,
			'the waiter waiting for a note',
			(task) => task.title === 'waiter' && task.waitingOn === 'a note',
		);
		await agent.until(
			'the Watchdog to check',
			async () => watchdogLines(agent).length,
			(count) => count >= 2,
		);
		agent.signal('SIGSTOP');
		await Bun.sleep(600);
		agent.signal('SIGCONT');
		await agent.until(
			'the wake in the log',
			async () => readFileSync(join(agent.home, 'daemon.log'), 'utf8'),
			(log) => log.includes('watchdog saw the machine wake'),
		);
		const after = watchdogLines(agent).length;
		await agent.until(
			'the Watchdog to check after the wake',
			async () => watchdogLines(agent).length,
			(count) => count >= after + 4,
		);
		check('the Watchdog notices the wake and carries on checking', true);
	});

	await scenario('A sleep in the middle of a model call', async (agent) => {
		// A hung call is 35 minutes of awake time, 2.1 s here. The call takes
		// 3.6 s of wall time, 3 s of it with the daemon stopped: only 0.6 s
		// awake, so it isn't hung.
		await agent.action({ type: 'send_console', text: 'please run slow' });
		await agent.until(
			"the slow task's model call",
			async () =>
				particle.requests.some(
					(request) =>
						request.session === 'worker' &&
						titles.get(request.handle ?? '') === 'slow',
				),
			(asked) => asked,
		);
		agent.signal('SIGSTOP');
		await Bun.sleep(3_000);
		agent.signal('SIGCONT');
		const done = await taskLine(
			agent,
			'the slow task finishing',
			(task) => task.title === 'slow' && task.status === 'done',
		);
		const calls = particle.requests.filter(
			(request) =>
				request.session === 'worker' &&
				titles.get(request.handle ?? '') === 'slow',
		).length;
		check(
			'the call that spanned the sleep was left to finish, not restarted',
			done.result === 'Done slowly' && calls === 1,
			`${calls} ${calls === 1 ? 'call' : 'calls'}`,
		);
	});

	await scenario(
		'A runaway task is paused, across a crash',
		async (agent) => {
			await agent.action({ type: 'send_console', text: 'please run spinner' });
			const paused = await taskLine(
				agent,
				'the spinner paused with a question',
				(task) => task.title === 'spinner' && task.status === 'needs_you',
			);
			const { handle } = paused;
			const question = paused.question;
			check(
				'after 150 calls without progress, the task asks you whether to go on',
				question !== null &&
					question.text.startsWith('Watchdog:') &&
					JSON.stringify(question.options) === '["Continue","Stop"]',
				question?.text ?? 'no question',
			);
			// The check runs each tick, so a fast fake Worker overshoots a little.
			const atPause = workerCalls(handle);
			check(
				'it took at least 150 model calls',
				atPause >= 150,
				`${atPause} calls`,
			);
			check(
				"the Router isn't told: people on threads don't hear about pauses",
				!particle.requests.some(
					(request) =>
						request.session === 'router' &&
						request.fresh.includes(`task ${handle}`),
				),
			);

			await agent.crash();
			await agent.restart();
			const before = watchdogLines(agent).length;
			await agent.until(
				'a few checks after the restart',
				async () => watchdogLines(agent).length,
				(count) => count >= before + 4,
			);
			const detail = await taskDetail(agent, handle);
			check(
				'after a crash, the same question is still open and no second one was asked',
				detail.task.status === 'needs_you' &&
					detail.task.question?.id === question?.id,
				`question ${detail.task.question?.id ?? 'none'}`,
			);
			check(
				'while paused, the Worker makes no calls',
				workerCalls(handle) === atPause,
				`${workerCalls(handle)} calls`,
			);

			const answered = await agent.action({
				type: 'answer_question',
				handle,
				questionId: question?.id ?? 0,
				text: 'Continue',
			});
			check('Continue is accepted', answered.ok);
			await agent.until(
				'the Worker to hear why it was paused',
				async () =>
					particle.requests.some(
						(request) =>
							request.handle === handle &&
							request.fresh.includes('The operator let you continue'),
					),
				(heard) => heard,
			);
			check('the Worker carries on and is told why it was paused', true);

			const again = await taskLine(
				agent,
				'the spinner paused a second time',
				(task) =>
					task.handle === handle &&
					task.status === 'needs_you' &&
					task.question !== null &&
					task.question.id !== question?.id,
			);
			check(
				'Continue starts the count again: the next pause comes 150 calls later',
				workerCalls(handle) - atPause >= 150,
				`${workerCalls(handle) - atPause} more calls`,
			);
			await agent.action({
				type: 'answer_question',
				handle,
				questionId: again.question?.id ?? 0,
				text: 'stop',
			});
			const stopped = await taskLine(
				agent,
				'the spinner stopped',
				(task) => task.handle === handle && task.status === 'stopped',
			);
			check('Stop stops the task', stopped.result === 'stopped by you');
		},
		{ allowed: /^runaway:/ },
	);

	await scenario(
		'Only you answer the Watchdog',
		async (agent) => {
			await agent.event({
				externalId: 'ask-1',
				thread: { key: 'support/1', title: '#support', url: null },
				author: { id: 'u-bob', name: 'bob', isBot: false },
				text: '@superagent please run spinner',
				mentionsAgent: true,
			});
			const paused = await taskLine(
				agent,
				'the spinner paused',
				(task) =>
					task.title === 'spinner' &&
					task.status === 'needs_you' &&
					task.threads.some((thread) => thread.id === 'script:support/1'),
			);
			await agent.event({
				externalId: 'reply-1',
				thread: { key: 'support/1', title: '#support', url: null },
				author: { id: 'u-bob', name: 'bob', isBot: false },
				text: 'sure, keep going',
				mentionsAgent: false,
			});
			await Bun.sleep(300);
			const detail = await taskDetail(agent, paused.handle);
			check(
				"a comment on the task's thread doesn't answer the Watchdog's question",
				detail.task.status === 'needs_you' &&
					detail.task.question?.id === paused.question?.id,
				detail.task.status,
			);
			await agent.action({
				type: 'send_note',
				handle: paused.handle,
				text: 'try something else',
			});
			const going = await taskLine(
				agent,
				'the spinner going again',
				(task) =>
					task.handle === paused.handle &&
					(task.status === 'working' || task.status === 'waiting'),
			);
			check('your note does, and the task goes on', going.question === null);
			await agent.action({ type: 'stop_task', handle: paused.handle });
		},
		{ allowed: /^runaway:/ },
	);

	await scenario(
		'Rerunning the same failing command',
		async (agent) => {
			await agent.action({ type: 'send_console', text: 'please run retester' });
			const paused = await taskLine(
				agent,
				'the retester paused',
				(task) => task.title === 'retester' && task.status === 'needs_you',
			);
			check(
				'rerunning a command to the same failure is not progress: the backstop pauses it',
				paused.question?.text.startsWith('Watchdog:') === true &&
					workerCalls(paused.handle) >= 150,
				`${workerCalls(paused.handle)} calls`,
			);
			await agent.action({ type: 'stop_task', handle: paused.handle });
		},
		{ allowed: /^runaway:/ },
	);

	await scenario("An upgrade doesn't pause busy tasks", async (agent) => {
		await agent.action({ type: 'send_console', text: 'please run waiter' });
		const waiting = await taskLine(
			agent,
			'the waiter waiting for a note',
			(task) => task.title === 'waiter' && task.waitingOn === 'a note',
		);
		// As if the task had made 200 calls under the version before progress
		// was tracked: roll back the migration that added it.
		await agent.crash();
		const db = new Database(join(agent.home, 'state.db'));
		const version =
			db.query<{ user_version: number }, []>('PRAGMA user_version').get()
				?.user_version ?? 0;
		db.run('UPDATE tasks SET model_calls = 200 WHERE handle = ?', [
			waiting.handle,
		]);
		db.run('ALTER TABLE tasks DROP COLUMN progress_calls');
		db.run('ALTER TABLE questions DROP COLUMN asked_by');
		db.run(`PRAGMA user_version = ${version - 1}`);
		db.close();
		await agent.restart();
		const before = watchdogLines(agent).length;
		await agent.until(
			'a few checks after the upgrade',
			async () => watchdogLines(agent).length,
			(count) => count >= before + 4,
		);
		const detail = await taskDetail(agent, waiting.handle);
		check(
			"a task with 200 calls before the upgrade isn't paused after it",
			detail.task.status === 'waiting',
			detail.task.status,
		);
	});

	await scenario(
		'A looping Worker is told, then paused',
		async (agent) => {
			await agent.action({ type: 'send_console', text: 'please run looper' });
			const paused = await taskLine(
				agent,
				'the looper paused',
				(task) => task.title === 'looper' && task.status === 'needs_you',
			);
			const mine = reviews.filter((review) => review.handle === paused.handle);
			const [first, second] = mine;
			check(
				'after 4 repeats of the same call, one review sees the task and the repeated call',
				first !== undefined &&
					first.workerCalls < 20 &&
					first.input.includes('looper') &&
					first.input.includes('read_file'),
				`at ${first?.workerCalls ?? '?'} calls`,
			);
			check(
				'its first verdict reaches the Worker as a note',
				particle.requests.some(
					(request) =>
						request.handle === paused.handle &&
						request.fresh.includes('note from watchdog') &&
						request.fresh.includes('Stop reading notes.txt'),
				),
			);
			check(
				'a second review, at least 20 calls later, pauses it',
				mine.length === 2 &&
					second !== undefined &&
					first !== undefined &&
					second.workerCalls - first.workerCalls >= 20,
				`${mine.length} reviews`,
			);
			check(
				"the pause says why, not the backstop's count",
				paused.question?.text.startsWith('Watchdog:') === true &&
					paused.question.text.includes('reads the same missing file'),
				paused.question?.text ?? '',
			);
			const counted = await agent.until(
				'health to count both reviews',
				async () =>
					watchdogLines(agent).at(-1)?.health.watchdog.reviewsToday ?? 0,
				(count) => count >= 2,
			);
			check('health counts the reviews', counted >= 2, `${counted} today`);
			await agent.action({ type: 'stop_task', handle: paused.handle });
		},
		{ allowed: /^reviews:/ },
	);

	await scenario(
		'A verdict about an episode that ended is dropped',
		async (agent) => {
			await agent.action({
				type: 'send_console',
				text: 'please run recoverer',
			});
			const waiting = await taskLine(
				agent,
				'the recoverer waiting after its edit',
				(task) =>
					task.title === 'recoverer' && task.waitingOn === 'the operator',
			);
			await agent.until(
				'the verdict to arrive and be dropped',
				async () => readFileSync(join(agent.home, 'daemon.log'), 'utf8'),
				(log) => log.includes('watchdog verdict dropped'),
			);
			await Bun.sleep(300);
			check(
				'a Worker that made progress during its review hears nothing about it',
				!particle.requests.some(
					(request) =>
						request.handle === waiting.handle &&
						request.fresh.includes('watchdog'),
				),
			);
			await agent.action({ type: 'stop_task', handle: waiting.handle });
		},
		// 300 ms ticks: the review (100 ms) ends well before the next tick, when
		// the finding itself would resolve.
		{ scale: '0.005' },
	);

	await scenario('A progressing verdict is silent', async (agent) => {
		await agent.action({ type: 'send_console', text: 'please run thinker' });
		const { handle } = await taskLine(
			agent,
			'the thinker working',
			(task) => task.title === 'thinker',
		);
		await agent.until(
			'two reviews',
			async () => reviews.filter((review) => review.handle === handle),
			(mine) => mine.length >= 2,
		);
		const [first, second] = reviews.filter(
			(review) => review.handle === handle,
		);
		check(
			'after `progressing`, no review for 40 more calls',
			first !== undefined &&
				second !== undefined &&
				second.workerCalls - first.workerCalls >= 40,
			`${(second?.workerCalls ?? 0) - (first?.workerCalls ?? 0)} calls apart`,
		);
		check(
			'and the Worker hears nothing from the Watchdog',
			!particle.requests.some(
				(request) =>
					request.handle === handle && request.fresh.includes('watchdog'),
			),
		);
		await agent.action({ type: 'stop_task', handle });
	});

	await scenario('Edits are progress', async (agent) => {
		await agent.action({ type: 'send_console', text: 'please run editor' });
		const done = await taskLine(
			agent,
			'the editor finishing',
			(task) => task.title === 'editor' && task.status === 'done',
		);
		check(
			'a Worker that keeps editing makes 170 calls without being paused',
			done.result === 'Edited 170 times',
		);
	});

	await scenario(
		'A command that hangs',
		async (agent) => {
			await agent.action({ type: 'send_console', text: 'please run hanger' });
			const { handle } = await taskLine(
				agent,
				'the hanger running its command',
				(task) => task.title === 'hanger' && task.now?.command === 'sleep 100',
			);
			const noted = await agent.until(
				"the Watchdog's note about the silent command",
				async () =>
					(await taskDetail(agent, handle)).conversation.filter(
						(message) =>
							message.author === 'watchdog' &&
							message.text.includes('has printed nothing'),
					),
				(notes) => notes.length > 0,
			);
			check(
				'a command silent for 15 minutes gets its Worker a note',
				noted[0]?.text.includes('stop_command') === true,
				noted[0]?.text ?? '',
			);
			const long = await agent.until(
				'the long command in health',
				async () => problemFor(agent, 'commands:', ':long'),
				(problem) => problem !== undefined,
			);
			check(
				'a command running for 2 hours is a problem',
				long?.text.includes('sleep 100') === true &&
					long.fix?.includes(`@${handle}`) === true,
				long?.text ?? '',
			);
			const notes = (await taskDetail(agent, handle)).conversation.filter(
				(message) => message.author === 'watchdog',
			).length;
			check('the silent command gets one note, not one per tick', notes === 1);
			await agent.action({ type: 'stop_task', handle });
			await agent.until(
				'the problem to clear',
				async () => problemFor(agent, 'commands:', ':long'),
				(problem) => problem === undefined,
			);
			check('the problem clears once the command ends', true);
		},
		{ allowed: /^commands:/ },
	);

	await scenario(
		'Tasks that will never move on',
		async (agent) => {
			await agent.action({ type: 'send_console', text: 'please run quitter' });
			await agent.action({ type: 'send_console', text: 'please run ciwaiter' });
			const idle = await agent.until(
				'the idle task in health',
				async () => problemFor(agent, 'waits:', ':idle'),
				(problem) => problem !== undefined,
			);
			check(
				'a task that ended its turns without finishing or asking is a problem',
				idle?.text.endsWith('stopped without finishing or asking') === true,
				idle?.text ?? '',
			);
			const nothing = await agent.until(
				'the task waiting on nothing in health',
				async () => problemFor(agent, 'waits:', ':nothing'),
				(problem) => problem !== undefined,
			);
			check(
				'a task waiting on something nothing can deliver is a problem',
				nothing?.text.includes('waits on "CI" but nothing will tell it') ===
					true,
				nothing?.text ?? '',
			);
			const handles = new Set(
				agent.lines.flatMap((line) =>
					line.type === 'task' ? [line.task.handle] : [],
				),
			);
			check(
				'neither is woken: the Watchdog only reports them',
				!particle.requests.some(
					(request) =>
						handles.has(request.handle ?? '') &&
						request.fresh.includes('watchdog'),
				),
			);
			for (const task of agent.lines.flatMap((line) =>
				line.type === 'task' ? [line.task.handle] : [],
			)) {
				// oxlint-disable-next-line eslint/no-await-in-loop
				await agent.action({ type: 'stop_task', handle: task });
			}
		},
		{ allowed: /^waits:/ },
	);

	await scenario(
		'Waiting for a worker slot',
		async (agent) => {
			await agent.action({ type: 'send_console', text: 'please run hanger' });
			await taskLine(
				agent,
				'the hanger running its command',
				(task) => task.title === 'hanger' && task.now?.command === 'sleep 100',
			);
			await agent.action({ type: 'send_console', text: 'please run quick' });
			const slot = await agent.until(
				'the slot wait in health',
				async () => problemFor(agent, 'waits:', ':slot'),
				(problem) => problem !== undefined,
			);
			check(
				'a task waiting 30 minutes for a slot is a problem naming what holds it',
				slot?.text.includes('for a worker slot') === true &&
					slot.fix?.includes('sleep 100') === true,
				`${slot?.text ?? ''} · ${slot?.fix ?? ''}`,
			);
			for (const task of agent.lines.flatMap((line) =>
				line.type === 'task' ? [line.task.handle] : [],
			)) {
				// oxlint-disable-next-line eslint/no-await-in-loop
				await agent.action({ type: 'stop_task', handle: task });
			}
		},
		{ allowed: /^(waits|commands):/, config: { maxWorkingTasks: 1 } },
	);

	await scenario(
		'A crash loop',
		async (agent) => {
			const restart = async () => {
				await agent.crash();
				await agent.restart();
				const before = watchdogLines(agent).length;
				await agent.until(
					'a few checks after the restart',
					async () => watchdogLines(agent).length,
					(count) => count >= before + 3,
				);
			};
			await restart();
			await restart();
			check(
				'two crashes in an hour are not yet a loop',
				problemFor(agent, 'crashes:', 'loop') === undefined,
			);
			await restart();
			const loop = problemFor(agent, 'crashes:', 'loop');
			check(
				'three crashes in an hour are a problem',
				loop?.text === 'The agent crashed 3 times in the last hour',
				loop?.text ?? 'no problem',
			);
		},
		{ allowed: /^crashes:/ },
	);

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

	await scenario('Any successful call wakes paused Workers', async (agent) => {
		// The probe never succeeds here; only the Router's call can wake it.
		particle.models.available = false;
		controls.outage = true;
		await agent.action({ type: 'send_console', text: 'please run outage' });
		const paused = await taskLine(
			agent,
			'the task waiting on Particle',
			(task) =>
				task.title === 'outage' && task.waitingOn === 'Particle (unreachable)',
		);
		controls.outage = false;
		await agent.action({ type: 'send_console', text: 'hello' });
		const done = await taskLine(
			agent,
			'the task finishing',
			(task) => task.handle === paused.handle && task.status === 'done',
		);
		check(
			"the Router's successful call wakes a Worker waiting on Particle",
			done.result === 'Done after the outage',
			done.result ?? '',
		);
	});

	await scenario(
		"A Worker's successful call ends the Router's backoff",
		async (agent) => {
			particle.models.available = false;
			await agent.action({ type: 'send_console', text: 'please run waiter' });
			const waiting = await taskLine(
				agent,
				'the waiter waiting for a note',
				(task) => task.title === 'waiter' && task.waitingOn === 'a note',
			);
			controls.breakRouter = 1;
			const before = particle.requests.length;
			await agent.action({ type: 'send_console', text: 'hello again' });
			await agent.waitFor(
				'the model in error',
				(line): line is HealthLine =>
					line.type === 'health' && line.health.model.state === 'error',
			);
			const failedAt = Date.now();
			await agent.action({
				type: 'send_note',
				handle: waiting.handle,
				text: 'go on',
			});
			await agent.until(
				'the Router to decide again',
				async () =>
					particle.requests
						.slice(before)
						.filter((request) => request.session === 'router').length,
				(count) => count >= 2,
			);
			check(
				"the Worker's call ends the Router's 30-second backoff",
				Date.now() - failedAt < 10_000,
				`${((Date.now() - failedAt) / 1000).toFixed(1)} s`,
			);
		},
	);

	await scenario('A key rejected during an outage', async (agent) => {
		particle.models.available = false;
		controls.outage = true;
		await agent.action({ type: 'send_console', text: 'please run outage' });
		const paused = await taskLine(
			agent,
			'the task waiting on Particle',
			(task) =>
				task.title === 'outage' && task.waitingOn === 'Particle (unreachable)',
		);
		particle.auth.rejected = true;
		try {
			const rejected = await taskLine(
				agent,
				'the task waiting on the rejected key',
				(task) =>
					task.handle === paused.handle &&
					task.waitingOn === 'Particle (API key rejected)',
			);
			check(
				'a 401 from the probe moves the waiting task to the rejected-key pause',
				rejected.status === 'waiting',
			);
		} finally {
			particle.auth.rejected = false;
			controls.outage = false;
		}
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
	process.stdout.write('\nReviews\n');
	const leaked = particle.requests.filter(
		(request) =>
			request.session === 'watchdog' &&
			JSON.stringify(request.body).includes('pai-e2e'),
	).length;
	check(
		'no review request holds the Particle key',
		reviews.length > 0 && leaked === 0,
		`${reviews.length} reviews`,
	);
} finally {
	particle.stop();
}

process.stdout.write(
	failures === 0 ? '\nAll checks passed.\n' : `\n${failures} failed.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
