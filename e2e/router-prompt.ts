// End to end: what each Router call costs. A lone "hi" on an empty agent is
// one call under a token budget; every Router and Worker request starts with
// the same system prompt and tools, so Particle's prefix cache can serve them;
// a batch's open tasks aren't sent again in later batches; and cached tokens
// reach the usage feed. Run with `bun run e2e`; it exits non-zero if a check
// fails.
import type { FeedLine } from '../src/protocol.ts';
import type { ChatRequest } from '../src/particle/types.ts';
import { startFakeParticle } from './fake-particle.ts';
import { startAgent } from './harness.ts';

// At 4 characters a token, tool schemas included: 1,237 when set, down from
// 1,668 a call (and two calls) before the Router's prompt was trimmed.
const HI_BUDGET_TOKENS = 1_300;

type MessageLine = Extract<FeedLine, { type: 'message' }>;
type UsageLine = Extract<FeedLine, { type: 'usage' }>;
type TaskLine = Extract<FeedLine, { type: 'task' }>;
type RouterLine = Extract<FeedLine, { type: 'router' }>;

const particle = startFakeParticle((request) => {
	if (request.session === 'compaction') return { content: 'Summary.' };
	if (request.session === 'worker') {
		return request.called.includes('report')
			? { calls: [{ name: 'wait_for', args: { what: 'a note' } }] }
			: { calls: [{ name: 'report', args: { text: 'Halfway there.' } }] };
	}
	const started = request.results
		.map((result) => result.match(/^started (\w{4})/)?.[1])
		.find(Boolean);
	if (started) {
		return {
			calls: [
				{
					name: 'reply',
					args: { thread: 'console', text: `On it: ${started}.` },
				},
			],
		};
	}
	if (request.fresh.includes('start one')) {
		return {
			calls: [
				{
					name: 'start_task',
					args: {
						title: 'Task one',
						instructions: 'Do one.',
						threads: [],
						repo: 'none',
					},
				},
			],
		};
	}
	if (/^ {2}(hi|hi again)$/m.test(request.fresh)) {
		return {
			calls: [{ name: 'reply', args: { thread: 'console', text: 'Hi!' } }],
		};
	}
	return { content: '' };
});

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (!ok) failures += 1;
	process.stdout.write(
		`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}\n`,
	);
}

/** The part every call of a session should repeat byte for byte. */
function staticPrefix(body: ChatRequest): string {
	return JSON.stringify([body.tools, body.messages[0]]);
}

const routerCalls = () =>
	particle.requests.filter((request) => request.session === 'router');

const agent = await startAgent(particle.url);
const reply = (text: string) =>
	agent.waitFor(
		`the reply ${JSON.stringify(text)}`,
		(line): line is MessageLine =>
			line.type === 'message' &&
			line.message.direction === 'out' &&
			line.message.text === text,
	);
const settled = async () => {
	await agent.until(
		'the Router to finish',
		async () =>
			agent.lines.findLast((line): line is RouterLine => line.type === 'router')
				?.router,
		(router) =>
			router !== undefined && !router.deciding && router.waiting === 0,
	);
};

try {
	await agent.action({ type: 'send_console', text: 'hi' });
	await reply('Hi!');
	await settled();
	const hi = routerCalls();
	const [first] = hi;
	check(
		'a lone "hi" takes one Router call: a reply ends the turn',
		hi.length === 1,
		`${hi.length} calls`,
	);
	check(
		`a lone "hi" stays under ${HI_BUDGET_TOKENS.toLocaleString('en-US')} prompt tokens`,
		first !== undefined && first.promptTokens <= HI_BUDGET_TOKENS,
		`${first?.promptTokens ?? 'no'} tokens`,
	);
	check(
		'with no tasks or repositories, the batch message says nothing about them',
		first !== undefined &&
			!first.fresh.includes('Open tasks') &&
			!first.fresh.includes('Repositories'),
		first?.fresh.replaceAll('\n', ' | '),
	);

	await agent.action({ type: 'send_console', text: 'start one' });
	const task = await agent.waitFor(
		'the task',
		(line): line is TaskLine =>
			line.type === 'task' && line.task.title === 'Task one',
	);
	await reply(`On it: ${task.task.handle}.`);
	await agent.until(
		'the Worker to wait',
		async () =>
			particle.requests.filter((request) => request.session === 'worker')
				.length,
		(count) => count >= 2,
	);
	await settled();
	await agent.action({ type: 'send_console', text: 'hi again' });
	await reply('Hi!');
	await settled();

	const calls = routerCalls();
	const startCalls = calls.filter(
		(request) =>
			request.fresh.includes('start one') ||
			request.results.some((result) => result.startsWith('started ')),
	);
	const [, second] = startCalls;
	check(
		'start_task, then a reply with its handle: two calls',
		startCalls.length === 2,
		`${startCalls.length} calls`,
	);
	const prefix = first ? staticPrefix(first.body) : '';
	check(
		'every Router call starts with the same system prompt and tools',
		calls.length > 0 &&
			calls.every((request) => staticPrefix(request.body) === prefix),
	);
	check(
		"a batch's second call is served from the cache up to its new items",
		second !== undefined &&
			startCalls[0] !== undefined &&
			second.cachedTokens >= startCalls[0].promptTokens - 1,
		`${second?.cachedTokens ?? 'no'} of ${second?.promptTokens ?? 'no'} cached`,
	);
	const routerSystem = first?.body.messages[0]?.content;
	check(
		"the Router is told Workers' questions are the operator's to answer",
		typeof routerSystem === 'string' &&
			routerSystem.includes("don't repeat or answer them yourself"),
	);
	check(
		'the Router has tasks push or open a PR only when one is asked for',
		typeof routerSystem === 'string' &&
			routerSystem.includes(
				'Have a task push or open a PR only when the operator asked for one',
			),
	);
	const last = calls.at(-1);
	const prefixTokens = Math.floor(prefix.length / 4);
	check(
		"a new batch's first call reuses at least the system prompt and tools",
		last !== undefined && last.cachedTokens >= prefixTokens,
		`${last?.cachedTokens ?? 'no'} cached; the static part is about ${prefixTokens}`,
	);
	check(
		'the open tasks appear in the current batch only',
		last !== undefined &&
			last.fresh.includes(`${task.task.handle} `) &&
			last.body.messages.filter(
				(message) =>
					message.role === 'user' &&
					typeof message.content === 'string' &&
					message.content.includes('Open tasks'),
			).length === 1,
	);

	const worker = particle.requests.filter(
		(request) => request.session === 'worker',
	);
	const [workerFirst, workerSecond] = worker;
	check(
		"a Worker's next call is served from the cache up to its new items",
		workerFirst !== undefined &&
			workerSecond !== undefined &&
			staticPrefix(workerFirst.body) === staticPrefix(workerSecond.body) &&
			workerSecond.cachedTokens >= workerFirst.promptTokens - 1,
		`${workerSecond?.cachedTokens ?? 'no'} of ${workerSecond?.promptTokens ?? 'no'} cached`,
	);
	const workerSystem = workerFirst?.body.messages[0]?.content;
	check(
		'a Worker is told to push and open a PR only when one is asked for',
		typeof workerSystem === 'string' &&
			workerSystem.includes(
				'Push and open a PR only when your instructions ask for a PR or you follow a GitHub issue or PR; never push otherwise',
			),
	);

	const usage = await agent.waitFor(
		'usage with cached tokens',
		(line): line is UsageLine =>
			line.type === 'usage' && line.usage.cachedTokens > 0,
	);
	check(
		'the usage feed counts cached input tokens',
		usage.usage.cachedTokens > 0 &&
			usage.usage.cachedTokens < usage.usage.inputTokens,
		`${usage.usage.cachedTokens} of ${usage.usage.inputTokens}`,
	);
} catch (error) {
	failures += 1;
	process.stdout.write(
		`✗ ${error instanceof Error ? error.message : String(error)}\n`,
	);
} finally {
	await agent.stop();
	particle.stop();
}

process.stdout.write(
	failures === 0 ? '\nAll checks passed.\n' : `\n${failures} failed.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
