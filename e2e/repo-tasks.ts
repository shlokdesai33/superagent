// End to end: with the terminal UI opened outside any repository, a message
// that names one starts a task that can write and commit in that
// repository's worktree, under the sandbox. A configured one is named by
// name, here configured by hand through a symlinked folder, as a synced
// Desktop can be; one the agent doesn't know yet is added first, found by
// its folder name in the terminal's folder, or given by absolute or ~ path.
// An unknown name that can't be found starts nothing, and the Router is told
// to ask for the path. A task with no repository works in its scratch
// folder, not the terminal's. The repositories are outside /tmp, which
// commands may always write. Run with `bun run e2e`; it exits non-zero if a
// check fails.
import { execFileSync } from 'node:child_process';
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FeedLine, TaskDetail, TaskSummary } from '../src/protocol.ts';
import { startFakeParticle } from './fake-particle.ts';
import { startAgent } from './harness.ts';
import { openTui } from './tui.ts';

type TaskLine = Extract<FeedLine, { type: 'task' }>;
type MessageLine = Extract<FeedLine, { type: 'message' }>;

const root = realpathSync(mkdtempSync('/var/tmp/sa-repo-tasks-'));
const home = join(root, 'home');
const synced = join(root, 'synced', 'Desktop');
const desktop = join(home, 'Desktop');
mkdirSync(synced, { recursive: true });
mkdirSync(home);
symlinkSync(synced, desktop);

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
const known = repository(join(synced, 'known'));
const byName = repository(join(synced, 'byname'));
const byPath = repository(join(root, 'elsewhere', 'bypath'));
const byTilde = repository(join(home, 'projects', 'bytilde'));

// A Worker that changes a file and commits it, then finishes with git's
// last line; a Router that starts a task in the repository a message names
// as "in <repo>, … (Xn)", and passes on start_task's error.
const COMMIT =
	"printf 'hi\\n' > note.txt && git add note.txt && git -c user.name=w -c user.email=w@example.com commit -qm note && git log --oneline -1";
const particle = startFakeParticle((request) => {
	if (request.session === 'compaction') return { content: 'Summary.' };
	if (request.session === 'worker') {
		if (!request.called.includes('run')) {
			return {
				content: 'Adding the note.',
				calls: [{ name: 'run', args: { command: COMMIT } }],
			};
		}
		const last = (request.results[0] ?? '').trim().split('\n').at(-1) ?? '';
		return { calls: [{ name: 'finish', args: { result: last.slice(0, 80) } }] };
	}
	const failed = request.results.find((result) => result.startsWith('error:'));
	if (failed) {
		return {
			calls: [{ name: 'reply', args: { thread: 'console', text: failed } }],
		};
	}
	const calls = [
		...request.fresh.matchAll(/^ {2}in (\S+), .*\(([A-Z]\d)\)$/gm),
	].map(([, repo, id]) => ({
		name: 'start_task',
		args: { title: `Task ${id}`, instructions: `Do ${id}.`, threads: [], repo },
	}));
	return calls.length > 0 ? { calls } : { content: 'Nothing to do.' };
});

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (!ok) failures += 1;
	process.stdout.write(
		`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}\n`,
	);
}

// Spelled through the symlink, as written by hand.
const agent = await startAgent(particle.url, {
	config: { repos: [{ name: 'known', path: join(desktop, 'known') }] },
	env: { HOME: home },
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
// The daemon is trusted to send the shape it promises.
function isTaskDetail(value: unknown): value is TaskDetail {
	return typeof value === 'object' && value !== null && 'workDir' in value;
}
const detail = async (handle: string): Promise<TaskDetail> => {
	const value = await agent.get(`/v1/tasks/${handle}`);
	if (!isTaskDetail(value)) throw new Error(`not a task: ${handle}`);
	return value;
};
const ended = async (id: string): Promise<TaskSummary> =>
	(
		await agent.waitFor(
			`task ${id} to end`,
			(line): line is TaskLine =>
				line.type === 'task' &&
				line.task.title === `Task ${id}` &&
				(line.task.status === 'done' || line.task.status === 'failed'),
		)
	).task;
const branchTip = (repo: string, handle: string): string => {
	try {
		return execFileSync(
			'git',
			['-C', repo, 'log', '-1', '--format=%s', `superagent/${handle}`],
			{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
		).trim();
	} catch {
		return 'no branch';
	}
};

/** Sends "in <repo>, …", then checks its task committed in `path`. */
async function commitsIn(
	label: string,
	named: string,
	id: string,
	path: string,
): Promise<TaskSummary> {
	await tui.type(`in ${named}, add a note (${id})\r`);
	const task = await ended(id);
	check(
		`${label}: the task's command writes and commits in its worktree`,
		task.status === 'done' && /^[0-9a-f]+ note$/.test(task.result ?? ''),
		task.result ?? task.status,
	);
	check(
		`${label}: the commit is on its branch in ${named}`,
		branchTip(path, task.handle) === 'note',
		branchTip(path, task.handle),
	);
	return task;
}

const tui = await openTui(agent.home, desktop);
try {
	const health = agent.lines.findLast(
		(line) => line.type === 'health' || line.type === 'snapshot',
	);
	const sandbox =
		health?.type === 'health'
			? health.health.sandbox
			: health?.type === 'snapshot'
				? health.snapshot.health.sandbox
				: null;
	if (sandbox !== 'on') {
		process.stdout.write(
			"- the sandbox isn't on here, so these checks don't test its write roots\n",
		);
	}
	check(
		'opened outside a repository, the UI names none for new tasks',
		!tui.seen().includes('new tasks in'),
	);

	// (a) A configured repository, spelled through a symlinked folder.
	const a = await commitsIn('a configured repository', 'known', 'A1', known);
	check(
		"(a) the sandbox's write roots are real paths, not the symlinked spelling",
		readFileSync(join(agent.home, 'daemon.log'), 'utf8')
			.split('\n')
			.some(
				(line) =>
					line.includes('"sandbox write roots"') &&
					line.includes(`"task":"${a.handle}"`) &&
					line.includes(`"${join(known, '.git')}"`) &&
					!line.includes(desktop),
			),
	);
	check(
		'(a) the Router is told the terminal folder',
		particle.requests.some(
			(request) =>
				request.session === 'router' &&
				request.fresh.includes('(A1)') &&
				request.fresh.includes(`terminal folder: ${synced}`),
		),
	);

	// (b) One the agent doesn't know, by its folder name in the terminal's.
	await commitsIn('an unknown repository by name', 'byname', 'B1', byName);
	// (c) By absolute path, and by ~ path.
	await commitsIn('an unknown repository by path', byPath, 'C1', byPath);
	await commitsIn(
		'an unknown repository by ~ path',
		'~/projects/bytilde',
		'C2',
		byTilde,
	);
	const added = configRepos();
	check(
		'each is added to config.json by its real path, as sending from it does',
		added.length === 4 &&
			added[1]?.name === 'byname' &&
			added[1].path === byName &&
			added[2]?.name === 'bypath' &&
			added[2].path === byPath &&
			added[3]?.name === 'bytilde' &&
			added[3].path === byTilde,
		JSON.stringify(added),
	);
	check(
		"start_task's result says it added the repository",
		particle.requests.some((request) =>
			request.results.some((result) =>
				result.includes('added bypath to config.json'),
			),
		),
	);

	// (d) A name that's neither configured nor found starts nothing.
	await tui.type('in ghost, add a note (D1)\r');
	const reply = await agent.waitFor(
		'the Router to pass on why',
		(line): line is MessageLine =>
			line.type === 'message' && line.message.text.includes('"ghost"'),
	);
	check(
		'(d) an unknown name starts no task',
		!agent.lines.some(
			(line) => line.type === 'task' && line.task.title === 'Task D1',
		),
	);
	check(
		'(d) start_task says where it looked and to ask for the path',
		reply.message.text.includes(synced) &&
			reply.message.text.includes('asking the operator for the') &&
			reply.message.text.includes('path'),
		reply.message.text,
	);
	check('(d) nothing is added to config.json', configRepos().length === 4);

	// No repository: its scratch folder, never the terminal's.
	await tui.type('in none, add a note (N1)\r');
	const n = await ended('N1');
	const scratch = (await detail(n.handle)).workDir;
	check(
		'a task with no repository works in its scratch folder, not the terminal folder',
		scratch === join(agent.home, 'tasks', n.handle, 'work'),
		scratch,
	);
} catch (error) {
	failures += 1;
	process.stdout.write(
		`✗ ${error instanceof Error ? error.message : String(error)}\n`,
	);
} finally {
	await tui.quit();
	await agent.stop();
	particle.stop();
	rmSync(root, { recursive: true, force: true });
}

process.stdout.write(
	failures === 0 ? '\nAll checks passed.\n' : `\n${failures} failed.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
