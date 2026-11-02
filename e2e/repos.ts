// End to end: the terminal UI makes the repository it's opened in the default
// for tasks from its messages. Opened outside one, nothing changes; inside
// one, the repository is added and tasks start there unless the message names
// another; tab clears it. Run with `bun run e2e`; it exits non-zero if a
// check fails.
import { execFileSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FeedLine, TaskDetail, TaskSummary } from '../src/protocol.ts';
import { startFakeParticle } from './fake-particle.ts';
import { startAgent } from './harness.ts';
import { openTui } from './tui.ts';

type TaskLine = Extract<FeedLine, { type: 'task' }>;
type MessageLine = Extract<FeedLine, { type: 'message' }>;

const root = realpathSync(mkdtempSync('/tmp/sa-repos-'));
function repository(path: string): string {
	mkdirSync(join(path, 'src'), { recursive: true });
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
const linked = join(root, 'webapp-linked');
execFileSync('git', [
	'-C',
	webapp,
	'worktree',
	'add',
	'-q',
	'--detach',
	linked,
]);

// A Router that starts a task for each message, marked (R1), (R2)…, passing
// repo only when the message names one, and asks when start_task can't pick.
const particle = startFakeParticle((request) => {
	if (request.session === 'compaction') return { content: 'Summary.' };
	if (request.session === 'worker') {
		return { calls: [{ name: 'finish', args: { result: 'Done' } }] };
	}
	const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
	for (const [line, id] of request.fresh.matchAll(/^.*\((R\d)\)$/gm)) {
		calls.push({
			name: 'start_task',
			args: {
				title: `Task ${id}`,
				instructions: `Do ${id}.`,
				threads: [],
				...(line.includes('in other') ? { repo: 'other' } : {}),
			},
		});
	}
	if (request.results.some((result) => result.includes('several repos'))) {
		calls.push({
			name: 'reply',
			args: { thread: 'console', text: 'Which repository?' },
		});
	}
	return calls.length > 0 ? { calls } : { content: 'Nothing to do.' };
});

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (!ok) failures += 1;
	process.stdout.write(
		`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}\n`,
	);
}

// `other` is configured, so today's default for a task is that one repository.
const agent = await startAgent(particle.url, {
	config: { repos: [{ name: 'other', path: other }] },
});

const configRepos = (): Array<{ name: string; path: string }> => {
	const value: unknown = JSON.parse(
		readFileSync(join(agent.home, 'config.json'), 'utf8'),
	);
	return typeof value === 'object' &&
		value !== null &&
		'repos' in value &&
		Array.isArray(value.repos)
		? value.repos
		: [];
};
const task = async (id: string): Promise<TaskSummary> =>
	(
		await agent.waitFor(
			`task ${id}`,
			(line): line is TaskLine =>
				line.type === 'task' && line.task.title === `Task ${id}`,
		)
	).task;
// The daemon is trusted to send the shape it promises.
function isTaskDetail(value: unknown): value is TaskDetail {
	return typeof value === 'object' && value !== null && 'workDir' in value;
}
const detail = async (handle: string): Promise<TaskDetail> => {
	const value = await agent.get(`/v1/tasks/${handle}`);
	if (!isTaskDetail(value)) throw new Error(`not a task: ${handle}`);
	return value;
};
/** What the Router was shown for the message marked `id`. */
const routerSaw = async (id: string): Promise<string> => {
	const request = await agent.until(
		`the Router to see (${id})`,
		async () =>
			particle.requests.find(
				(r) => r.session === 'router' && r.fresh.includes(`(${id})`),
			),
		(found) => found !== undefined,
	);
	return request?.fresh ?? '';
};

try {
	// 1. Opened outside a repository: no default, as before.
	let tui = await openTui(agent.home, outside);
	check(
		'outside a repository, the UI names no repository for new tasks',
		!tui.seen().includes('new tasks in'),
	);
	await tui.type('/tidy my notes (R1)');
	await tui.waitFor('→ the Router decides what to do');
	check(
		'outside a repository, tab has nothing to change',
		!tui.seen().includes('tab change repo'),
	);
	let mark = tui.mark();
	await tui.type('\r');
	await tui.waitFor('✓ Sent', mark);
	await tui.quit();
	const r1 = await task('R1');
	check(
		'outside, the Router sees no default repository',
		!(await routerSaw('R1')).includes('default repository:'),
	);
	check(
		'outside, the task goes where it would today: the only repository',
		(await detail(r1.handle)).workDir.includes('/worktrees/other/'),
		(await detail(r1.handle)).workDir,
	);

	// 2. Opened in a subfolder of a repository the agent doesn't know yet.
	tui = await openTui(agent.home, join(webapp, 'src'));
	await tui.waitFor('new tasks in webapp');
	check('inside a repository, the UI names it for new tasks', true);
	mark = tui.mark();
	await tui.type('/fix the login bug (R2)');
	await tui.waitFor('→ the Router decides · new tasks in webapp', mark);
	check(
		'while typing, the preview says where new tasks go, and tab can change it',
		tui.seen(mark).includes('tab change repo'),
	);
	mark = tui.mark();
	await tui.type('\r');
	await tui.waitFor("added webapp to the agent's repositories", mark);
	check('sending from it adds the repository, and the toast says so', true);
	const added = configRepos();
	check(
		'config.json lists it after the configured one',
		added.length === 2 &&
			added[0]?.name === 'other' &&
			added[1]?.name === 'webapp' &&
			added[1].path === webapp,
		JSON.stringify(added),
	);
	check(
		'the Router sees it as the default repository',
		(await routerSaw('R2')).includes('default repository: webapp'),
	);
	const r2 = await task('R2');
	const r2Detail = await detail(r2.handle);
	check(
		'the task works in it, on its own branch',
		r2Detail.workDir.includes('/worktrees/webapp/') &&
			r2Detail.branch === `superagent/${r2.handle}`,
		`${r2Detail.workDir} on ${r2Detail.branch ?? 'no branch'}`,
	);

	// 3. A message that names another repository goes there.
	await tui.type('/in other: bump the version (R3)\r');
	const r3 = await task('R3');
	check(
		'a message naming another repository starts its task there',
		(await detail(r3.handle)).workDir.includes('/worktrees/other/'),
		(await detail(r3.handle)).workDir,
	);

	// 4. A message to a task ignores the default.
	await tui.type('/');
	mark = tui.mark();
	await tui.type(`@${r2.handle} also check Safari`);
	await tui.waitFor(`→ straight to ${r2.handle}`, mark);
	check(
		'a message to a task names no repository',
		!tui.seen(mark).includes('new tasks in webapp') &&
			!tui.seen(mark).includes('tab change repo'),
	);
	await tui.type('\x1b');

	// 5. Tab steps to the agent's other repository, then to none.
	mark = tui.mark();
	await tui.type('/draft release notes (R4)\t');
	await tui.waitFor('→ the Router decides · new tasks in other', mark);
	check('tab changes the default to another repository', true);
	mark = tui.mark();
	await tui.type('\t');
	await tui.waitFor('→ the Router decides what to do', mark);
	check('tab again clears it', true);
	await tui.type('\r');
	await agent.waitFor(
		'the Router to ask which repository',
		(line): line is MessageLine =>
			line.type === 'message' && line.message.text === 'Which repository?',
	);
	check(
		'cleared, the Router sees no default repository',
		!(await routerSaw('R4')).includes('default repository:'),
	);
	check(
		'cleared, start_task needs a repository as it does today with several',
		!agent.lines.some(
			(line) => line.type === 'task' && line.task.title === 'Task R4',
		),
	);
	mark = tui.mark();
	await tui.type('/');
	await tui.waitFor('→ the Router decides what to do', mark);
	check(
		'the cleared default stays cleared for the session',
		!tui.seen(mark).includes('new tasks in'),
	);
	await tui.type('\x1b');
	await tui.quit();
	check('config.json is unchanged by these', configRepos().length === 2);

	// 6. A linked worktree counts as its main repository.
	tui = await openTui(agent.home, linked);
	await tui.waitFor('new tasks in webapp');
	check('in a linked worktree, new tasks go to its main repository', true);
	await tui.quit();
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
