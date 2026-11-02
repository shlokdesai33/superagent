// End to end: a console message is never recorded and then silently left.
// While the Router can't decide it (no key, Particle refusing the account, or
// its own error), the message says why under it and the home screen lists the
// problem; when Particle answers again it's decided and the problem clears. A
// Router that ends without answering the operator is told to, once. Run with
// `bun run e2e`; it exits non-zero if a check fails.
import { Database } from 'bun:sqlite';
import { execFileSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FeedLine, Problem } from '../src/protocol.ts';
import { writeKeyFile } from '../src/keys.ts';
import { startFakeParticle } from './fake-particle.ts';
import { startAgent } from './harness.ts';
import { openTui } from './tui.ts';

type HealthLine = Extract<FeedLine, { type: 'health' }>;
type RouterLine = Extract<FeedLine, { type: 'router' }>;
type MessageLine = Extract<FeedLine, { type: 'message' }>;

const NUDGE =
	/^((?:#\d+(?:, )?)+) (?:is a message|are messages) from the operator/m;

// A Router that answers messages marked (OK…), stays silent on (QUIET) until
// told, and never answers (NEVER), whose start_task has no title. (SPLIT…)
// messages get start_task without event, then a question once told.
const marks = new Map<number, string>();
const particle = startFakeParticle((request) => {
	if (request.session === 'compaction') return { content: 'Summary.' };
	if (request.session !== 'router') {
		return { calls: [{ name: 'finish', args: { result: 'Done' } }] };
	}
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	for (const [, event, mark] of request.fresh.matchAll(
		/^#(\d+) · console\b.*\n.*\((\w+)\)$/gm,
	)) {
		if (event === undefined || mark === undefined) continue;
		marks.set(Number(event), mark);
		if (mark.startsWith('OK')) {
			calls.push({
				name: 'reply',
				args: { thread: 'console', text: `Got it (${mark}).` },
			});
		} else if (mark === 'NEVER') {
			calls.push({
				name: 'start_task',
				args: { instructions: 'Do it.', threads: [] },
			});
		} else if (mark.startsWith('SPLIT')) {
			calls.push({
				name: 'start_task',
				args: { title: `Task ${mark}`, instructions: 'Do it.', threads: [] },
			});
		}
	}
	const nudged = request.fresh.match(NUDGE)?.[1];
	for (const [, id] of nudged?.matchAll(/#(\d+)/g) ?? []) {
		const mark = marks.get(Number(id));
		if (mark === 'QUIET') {
			calls.push({
				name: 'reply',
				args: { thread: 'console', text: 'Sorry, on it (QUIET).' },
			});
		} else if (
			mark?.startsWith('SPLIT') &&
			request.fresh.includes('A tool call above failed') &&
			!calls.some((call) => call.name === 'reply')
		) {
			calls.push({
				name: 'reply',
				args: { thread: 'console', text: 'Which repository (SPLIT)?' },
			});
		}
	}
	return calls.length > 0 ? { calls } : { content: 'Nothing to say.' };
});

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (!ok) failures += 1;
	process.stdout.write(
		`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}\n`,
	);
}

const root = realpathSync(mkdtempSync('/tmp/sa-console-'));
function repository(path: string): string {
	mkdirSync(path, { recursive: true });
	execFileSync('git', ['init', '-q', path]);
	execFileSync('git', [
		'-C',
		path,
		'-c',
		'user.name=e2e',
		'-c',
		'user.email=e2e@example.com',
		'commit',
		'-q',
		'--allow-empty',
		'-m',
		'first',
	]);
	return path;
}
const webapp = repository(join(root, 'webapp'));
const other = repository(join(root, 'other'));
const outside = join(root, 'outside');
mkdirSync(outside);

// No key at first; account failures are retried every 1.5 s instead of 2 min.
const agent = await startAgent(particle.url, {
	env: { PARTICLE_API_KEY: '', SUPERAGENT_PARTICLE_RETRY_MS: '1500' },
});
const keyFile = join(agent.home, 'particle-key');

const after = (from: number) => (line: FeedLine) =>
	agent.lines.indexOf(line) >= from;
const modelProblem = (from: number, what: string, text: string) =>
	agent.waitFor(
		what,
		(line): line is HealthLine =>
			after(from)(line) &&
			line.type === 'health' &&
			line.health.problems.some(
				(problem) => problem.id === 'model' && problem.text.includes(text),
			),
	);
const problemOf = (line: HealthLine, id: string): Problem | undefined =>
	line.health.problems.find((problem) => problem.id === id);
const recovered = (from: number) =>
	agent.waitFor(
		'the model to be ok again',
		(line): line is HealthLine =>
			after(from)(line) &&
			line.type === 'health' &&
			line.health.model.state === 'ok' &&
			problemOf(line, 'model') === undefined,
	);
const reply = (text: string) =>
	agent.waitFor(
		`the reply "${text}"`,
		(line): line is MessageLine =>
			line.type === 'message' &&
			line.message.direction === 'out' &&
			line.message.text === text,
	);
const held = (from: number, reason: string) =>
	agent.waitFor(
		`the Router held: ${reason}`,
		(line): line is RouterLine =>
			after(from)(line) &&
			line.type === 'router' &&
			line.router.held?.reason.includes(reason) === true &&
			line.router.pending.length > 0,
	);

try {
	// 1. Without a key the message says why it waits, until a key is saved.
	const tui = await openTui(agent.home, outside);
	let from = agent.lines.length;
	let mark = tui.mark();
	await tui.type('/hello there (OK1)\r');
	await tui.waitFor('└ waiting · No Particle API key', mark);
	check('without a key, the message says it waits for one', true);
	const noKey = await held(from, 'No Particle API key');
	check(
		"without a key, there's no retry time: it goes on when a key is saved",
		noKey.router.held?.until === null,
	);
	from = agent.lines.length;
	mark = tui.mark();
	writeKeyFile(keyFile, 'pai-e2e');
	await reply('Got it (OK1).');
	await tui.waitFor('Got it (OK1).', mark);
	check('a saved key lets the Router answer it', true);

	// 2. Out of credit: a problem on the home screen with the reason and the
	//    retry, the reason under the message, and both gone after a retry
	//    that works.
	particle.account.refused = 402;
	from = agent.lines.length;
	mark = tui.mark();
	await tui.type('/fix the login bug (OK2)\r');
	const noCredit = await modelProblem(
		from,
		'the out-of-credit problem',
		'out of credit',
	);
	const problem = problemOf(noCredit, 'model');
	check(
		'out of credit is a problem that says so and that the agent retries',
		problem?.text ===
			'Particle account is out of credit · the agent retries every 2 minutes',
		problem?.text,
	);
	check(
		'its fix says where to add credit',
		problem?.fix?.includes('Billing page at https://platform.particle.ai') ===
			true,
		problem?.fix ?? 'no fix',
	);
	await tui.waitFor('! 1 problem', mark);
	await tui.waitFor(
		'! Particle account is out of credit · the agent retries',
		mark,
	);
	check('the home screen lists it under NEEDS YOU and in the header', true);
	await tui.waitFor(
		'└ waiting · Particle account is out of credit · tries again in',
		mark,
	);
	check('the waiting message says why and when it is tried again', true);
	const log = readFileSync(join(agent.home, 'daemon.log'), 'utf8');
	check(
		'the log names the failed call and its code',
		log.includes('"message":"model call failed"') &&
			log.includes('402 insufficient_credits'),
	);
	from = agent.lines.length;
	mark = tui.mark();
	particle.account.refused = null;
	await reply('Got it (OK2).');
	await recovered(from);
	check('once credit is added, the next retry answers the message', true);
	await tui.waitFor('● running', mark);
	check('and the problem clears from the home screen by itself', true);
	await tui.quit();

	// 3. A key without the scope, and a rejected key, are as clear.
	particle.account.refused = 403;
	from = agent.lines.length;
	await agent.action({ type: 'send_console', text: 'check scope (OK3)' });
	const noScope = problemOf(
		await modelProblem(from, 'the 403 problem', "isn't allowed"),
		'model',
	);
	check(
		'403 says the key may not use chat completions, and that it retries',
		noScope?.text ===
			"Particle's API key isn't allowed to use chat completions · the agent retries every 2 minutes" &&
			noScope.fix?.includes('superagent login particle') === true,
		noScope?.text,
	);
	from = agent.lines.length;
	particle.account.refused = null;
	await reply('Got it (OK3).');
	await recovered(from);

	particle.auth.rejected = true;
	from = agent.lines.length;
	await agent.action({ type: 'send_console', text: 'check key (OK4)' });
	const rejected = problemOf(
		await modelProblem(from, 'the 401 problem', 'rejected'),
		'model',
	);
	check(
		'401 says the key was rejected, how to fix it, and that it retries',
		rejected?.text ===
			'Particle rejected the API key · the agent retries every 2 minutes' &&
			rejected.fix?.includes('superagent login particle') === true,
		rejected?.text,
	);
	await held(from, 'Particle rejected the API key');
	from = agent.lines.length;
	particle.auth.rejected = false;
	await reply('Got it (OK4).');
	await recovered(from);

	// 4. Messages with different default repositories decided together: the
	//    Router's start_task fails, and it's told the operator heard nothing.
	particle.account.refused = 402;
	from = agent.lines.length;
	await agent.action({
		type: 'send_console',
		text: 'fix the signup form (SPLIT1)',
		repo: webapp,
	});
	await agent.action({
		type: 'send_console',
		text: 'bump the version (SPLIT2)',
		repo: other,
	});
	await held(from, 'out of credit');
	particle.account.refused = null;
	await reply('Which repository (SPLIT)?');
	check(
		"start_task's failure on different defaults reaches the Router",
		particle.requests.some((request) =>
			request.results.some((result) =>
				result.includes('different default repositories'),
			),
		),
	);
	check(
		'a Router that ends silent after a failed tool is told, and answers',
		particle.requests.some(
			(request) =>
				NUDGE.test(request.fresh) &&
				request.fresh.includes('A tool call above failed'),
		),
	);

	// 5. A Router that just stays silent is told once, and answers.
	await agent.action({ type: 'send_console', text: 'thoughts? (QUIET)' });
	await reply('Sorry, on it (QUIET).');
	check(
		'a console message the Router ignores gets a nudge, then a reply',
		true,
	);

	// 6. One it never answers says so on the Router line, with the failure.
	from = agent.lines.length;
	await agent.action({ type: 'send_console', text: 'do the thing (NEVER)' });
	const silent = await agent.waitFor(
		'the batch to end silent',
		(line): line is RouterLine =>
			after(from)(line) &&
			line.type === 'router' &&
			line.router.last?.text.startsWith('stayed silent') === true,
	);
	check(
		'a silent batch names the tool call that failed',
		silent.router.last?.text.includes('start_task failed:') === true,
		silent.router.last?.text,
	);

	// 7. The Router's own error (here a corrupt event) is a problem too,
	//    instead of a line in the log.
	const db = new Database(join(agent.home, 'state.db'));
	db.run('PRAGMA busy_timeout = 5000');
	db.run(
		`INSERT INTO events (received_at, channel, external_id, thread_id, kind, author,
			text, data, route)
		VALUES (?, 'console', 'corrupt', 'console', 'message', 'you', 'broken (OK5)', '{', 'router')`,
		[Date.now()],
	);
	db.close();
	from = agent.lines.length;
	await agent.action({ type: 'send_console', text: 'wake up (OK6)' });
	const broken = await agent.waitFor(
		'the Router failure problem',
		(line): line is HealthLine =>
			after(from)(line) &&
			line.type === 'health' &&
			problemOf(line, 'router:failing') !== undefined,
	);
	const failing = problemOf(broken, 'router:failing');
	check(
		"the Router's own failure shows as a problem with where to look",
		failing?.text.startsWith('The Router failed and retries with backoff:') ===
			true && failing.fix === 'superagent logs shows the error',
		failing?.text,
	);
	const waiting = await agent.waitFor(
		'the Router to hold the messages',
		(line): line is RouterLine =>
			after(from)(line) &&
			line.type === 'router' &&
			line.router.held !== null &&
			line.router.held.until !== null,
	);
	const reason = waiting.router.held?.reason ?? '';
	check(
		'the messages it holds say why',
		reason !== '' && failing?.text.endsWith(reason) === true,
		reason,
	);
} catch (error) {
	failures += 1;
	process.stdout.write(
		`✗ ${error instanceof Error ? error.message : String(error)}\n`,
	);
} finally {
	await agent.stop();
	particle.stop();
	rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
	failures === 0 ? '\nAll checks passed.\n' : `\n${failures} failed.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
