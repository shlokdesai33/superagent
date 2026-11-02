import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { envWithoutSecrets, redact } from './secrets.ts';
import type { Daemon } from './state.ts';

const FETCH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 30_000;
const MAX_DIFF_CHARS = 256 * 1024;
const WORKTREE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const LOG_RETENTION_MS = 30 * 24 * 60 * 60_000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;

export type GitResult = { code: number; stdout: string; stderr: string };

/**
 * The daemon's environment without the agent's keys, since a repository's
 * hooks and config run with it. With your login PATH and no credential prompts.
 */
function gitEnv(
	loginPath: string,
	secrets: string[],
): Record<string, string | undefined> {
	return {
		...envWithoutSecrets(secrets),
		PATH: loginPath,
		GIT_TERMINAL_PROMPT: '0',
	};
}

/** Runs git. Never throws for a non-zero exit. */
export async function git(
	daemon: Daemon,
	args: string[],
	options: {
		cwd?: string;
		timeoutMs?: number;
		env?: Record<string, string>;
	} = {},
): Promise<GitResult> {
	const child = Bun.spawn(['git', ...args], {
		cwd: options.cwd ?? daemon.paths.home,
		env: { ...gitEnv(daemon.loginPath, daemon.secrets), ...options.env },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
		timeout: options.timeoutMs ?? GIT_TIMEOUT_MS,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

function firstLine(text: string): string {
	return text.trim().split('\n')[0] ?? '';
}

/** The top of the git repository containing `dir`, or `null`. */
/** `path` is the login PATH, the one the startup check found git on. */
export function repositoryRoot(
	dir: string,
	path: string,
	secrets: string[],
): string | null {
	const result = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], {
		cwd: dir,
		env: gitEnv(path, secrets),
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'ignore',
		timeout: GIT_TIMEOUT_MS,
	});
	const top = result.stdout.toString().trim();
	return result.exitCode === 0 && top !== '' ? top : null;
}

/**
 * Which of `user.name` and `user.email` git can't resolve for a commit, in
 * any of `repos` (your global config when there are none). Worker commits
 * fail without them.
 */
export function missingIdentity(
	path: string,
	secrets: string[],
	repos: string[],
): string[] {
	const env = gitEnv(path, secrets);
	const places = repos.filter((repo) => existsSync(repo));
	return ['name', 'email']
		.filter((field) => {
			const upper = field.toUpperCase();
			if (env[`GIT_AUTHOR_${upper}`] && env[`GIT_COMMITTER_${upper}`]) {
				return false;
			}
			const read = (dir: string | null) =>
				Bun.spawnSync(
					['git', ...(dir ? ['-C', dir] : []), 'config', `user.${field}`],
					{
						cwd: homedir(),
						env,
						stdin: 'ignore',
						stdout: 'pipe',
						stderr: 'ignore',
						timeout: GIT_TIMEOUT_MS,
					},
				)
					.stdout.toString()
					.trim();
			return places.length === 0
				? read(null) === ''
				: places.some((dir) => read(dir) === '');
		})
		.map((field) => `user.${field}`);
}

/** A config-safe repository name from its folder name. */
export function repositoryName(path: string): string {
	return basename(path).replaceAll(/[^A-Za-z0-9._-]/g, '-') || 'repo';
}

export function worktreePath(
	daemon: Daemon,
	repo: string,
	handle: string,
): string {
	return join(daemon.paths.home, 'worktrees', repo, handle);
}

export function taskBranch(handle: string): string {
	return `superagent/${handle}`;
}

function repoPath(daemon: Daemon, repo: string): string {
	const found = daemon.config.repos.find((entry) => entry.name === repo);
	if (!found) throw new Error(`repository ${repo} isn't in config.json`);
	return found.path;
}

// Worktree changes in one repository run one at a time.
const repoLocks = new Map<string, Promise<unknown>>();

function withRepoLock<T>(path: string, run: () => Promise<T>): Promise<T> {
	const previous = repoLocks.get(path) ?? Promise.resolve();
	const next = previous.catch(() => {}).then(run);
	repoLocks.set(path, next);
	return next;
}

/**
 * Creates the task's worktree on `superagent/<handle>` if it's missing: from
 * `origin/<default branch>` after a fetch, else from the repository's HEAD.
 * A branch left from an earlier worktree is reused. Returns a line for the
 * Worker saying where its branch starts.
 */
export function prepareWorktree(
	daemon: Daemon,
	task: { handle: string; repo: string; workDir: string },
): Promise<string | null> {
	const found = daemon.config.repos.find((entry) => entry.name === task.repo);
	if (!found) {
		// Cleanup keeps worktrees of repositories it doesn't know, so there's no
		// removal to wait for.
		return existsSync(task.workDir)
			? Promise.resolve(null)
			: Promise.reject(
					new Error(`repository ${task.repo} isn't in config.json`),
				);
	}
	const path = found.path;
	return withRepoLock(path, async () => {
		const run = (args: string[], timeoutMs?: number) =>
			git(daemon, ['-C', path, ...args], timeoutMs ? { timeoutMs } : {});
		// Checked under the lock, so a removal by cleanup has finished.
		if (existsSync(task.workDir)) return null;
		if (!existsSync(path)) {
			throw new Error(`${path} doesn't exist`);
		}
		await run(['worktree', 'prune']);
		const branch = taskBranch(task.handle);
		mkdirSync(dirname(task.workDir), { recursive: true });

		const existing = await run([
			'rev-parse',
			'--verify',
			'--quiet',
			`refs/heads/${branch}`,
		]);
		if (existing.code === 0) {
			const added = await run(['worktree', 'add', task.workDir, branch]);
			if (added.code !== 0) throw new Error(firstLine(added.stderr));
			return `Your worktree was re-created on your existing branch ${branch}.`;
		}

		const base = await chooseBase(daemon, path);
		const added = await run([
			'worktree',
			'add',
			'-b',
			branch,
			task.workDir,
			base.ref,
		]);
		if (added.code !== 0) throw new Error(firstLine(added.stderr));
		return base.note;
	});
}

async function chooseBase(
	daemon: Daemon,
	path: string,
): Promise<{ ref: string; note: string }> {
	const run = (args: string[], timeoutMs?: number) =>
		git(daemon, ['-C', path, ...args], timeoutMs ? { timeoutMs } : {});
	const head = async (why: string) => {
		const sha = firstLine((await run(['rev-parse', '--short', 'HEAD'])).stdout);
		return {
			ref: 'HEAD',
			note: `${why}, so your branch starts from the repository's current HEAD (${sha || 'unknown'}).`,
		};
	};

	if ((await run(['remote', 'get-url', 'origin'])).code !== 0) {
		return head('The repository has no origin remote');
	}
	let branch = firstLine(
		(await run(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).stdout,
	).replace(/^origin\//, '');
	if (!branch) {
		for (const candidate of ['main', 'master']) {
			// oxlint-disable-next-line eslint/no-await-in-loop
			const found = await run([
				'rev-parse',
				'--verify',
				'--quiet',
				`refs/remotes/origin/${candidate}`,
			]);
			if (found.code === 0) {
				branch = candidate;
				break;
			}
		}
	}
	if (!branch) return head("Couldn't tell origin's default branch");

	const fetched = await run(['fetch', 'origin', branch], FETCH_TIMEOUT_MS);
	if (fetched.code !== 0) {
		return head(
			`git fetch origin ${branch} failed (${firstLine(fetched.stderr) || `exit ${fetched.code}`})`,
		);
	}
	const sha = firstLine(
		(await run(['rev-parse', '--short', `origin/${branch}`])).stdout,
	);
	return {
		ref: `origin/${branch}`,
		note: `Your branch starts from origin/${branch} at ${sha}, fetched just now.`,
	};
}

/**
 * The change one edit made, from `git diff --no-index` on the old and new
 * contents. `before` is `null` for a new file. Counts are `null` for binary
 * files.
 */
export async function editDiff(
	daemon: Daemon,
	tmpDir: string,
	path: string,
	before: string | null,
	after: string,
): Promise<{
	additions: number | null;
	deletions: number | null;
	diff: string | null;
}> {
	mkdirSync(tmpDir, { recursive: true });
	const dir = mkdtempSync(join(tmpDir, 'diff-'));
	try {
		writeFileSync(join(dir, 'after'), after);
		if (before !== null) writeFileSync(join(dir, 'before'), before);
		const old = before === null ? '/dev/null' : 'before';
		const args = ['diff', '--no-index', '--no-color', '--no-ext-diff'];
		const [numstat, patch] = await Promise.all([
			git(daemon, [...args, '--numstat', old, 'after'], { cwd: dir }),
			git(daemon, [...args, old, 'after'], { cwd: dir }),
		]);
		// Exit 1 means the files differ.
		if (numstat.code > 1 || patch.code > 1) {
			daemon.log('warn', 'edit diff failed', {
				error: firstLine(numstat.stderr || patch.stderr),
			});
			return { additions: null, deletions: null, diff: null };
		}
		if (patch.code === 0) return { additions: 0, deletions: 0, diff: null };
		const counts = numstat.stdout.match(/^(\d+|-)\t(\d+|-)\t/);
		const lines = patch.stdout.split('\n');
		const body = lines.findIndex((line) => line.startsWith('@@'));
		const header = (body === -1 ? lines : lines.slice(0, body)).map((line) =>
			line
				.replace(/^(diff --git )a\/\S+ b\/\S+$/, `$1a/${path} b/${path}`)
				.replace(/^--- a\/before$/, `--- a/${path}`)
				.replace(/^\+\+\+ b\/after$/, `+++ b/${path}`),
		);
		// The diff is shown in the TUI, and an edited file can hold a key.
		const diff = redact(
			daemon.secrets,
			[...header, ...(body === -1 ? [] : lines.slice(body))].join('\n'),
		);
		return {
			additions: counts?.[1] && counts[1] !== '-' ? Number(counts[1]) : null,
			deletions: counts?.[2] && counts[2] !== '-' ? Number(counts[2]) : null,
			diff:
				diff.length > MAX_DIFF_CHARS
					? `${diff.slice(0, MAX_DIFF_CHARS)}\n[diff cut at 256 KB]\n`
					: diff,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * Removes worktrees and temp folders of tasks that ended over 7 days ago
 * (their branches stay, so committed work is kept) and command logs older
 * than 30 days.
 */
export async function cleanUp(daemon: Daemon): Promise<void> {
	const now = Date.now();
	const cutoff = now - WORKTREE_RETENTION_MS;
	const candidates = daemon.db
		.query<{ id: number; handle: string; repo: string }, [number]>(
			`SELECT id, handle, repo FROM tasks
			WHERE repo IS NOT NULL AND state IN ('done', 'failed', 'stopped') AND ended_at < ?`,
		)
		.all(cutoff);
	for (const task of candidates) {
		let path: string;
		try {
			path = repoPath(daemon, task.repo);
		} catch {
			daemon.log('warn', 'worktree of an unknown repository kept', {
				task: task.handle,
				repo: task.repo,
			});
			continue;
		}
		// Under the lock worktree creation uses, so a reopened task's Worker
		// waits for this and then re-creates its worktree from the branch.
		// oxlint-disable-next-line eslint/no-await-in-loop
		await withRepoLock(path, () =>
			removeOldWorktree(daemon, task.id, path, cutoff),
		);
	}

	// Saving a worktree uses the task's temp folder, so it goes after them.
	let removedTmp = 0;
	for (const task of daemon.db
		.query<{ id: number; handle: string }, [number]>(
			`SELECT id, handle FROM tasks
			WHERE state IN ('done', 'failed', 'stopped') AND ended_at < ?`,
		)
		.all(cutoff)) {
		const tmp = join(daemon.paths.home, 'tasks', task.handle, 'tmp');
		// Synchronous from the query on, so no task is reopened in between;
		// a reopened task's commands re-create the folder anyway.
		if (!daemon.workers.has(task.id) && existsSync(tmp)) {
			rmSync(tmp, { recursive: true, force: true });
			removedTmp += 1;
		}
	}
	if (removedTmp > 0) {
		daemon.log('info', 'old task temp folders removed', { count: removedTmp });
	}

	const tasksDir = join(daemon.paths.home, 'tasks');
	let removedLogs = 0;
	for (const handle of existsSync(tasksDir) ? readdirSync(tasksDir) : []) {
		const commands = join(tasksDir, handle, 'commands');
		if (!existsSync(commands)) continue;
		for (const name of readdirSync(commands)) {
			const file = join(commands, name);
			if (statSync(file).mtimeMs < now - LOG_RETENTION_MS) {
				rmSync(file, { force: true });
				removedLogs += 1;
			}
		}
	}
	if (removedLogs > 0) {
		daemon.log('info', 'old command logs removed', { count: removedLogs });
	}
}

/** Whether the task is still ended before `cutoff`, with no Worker running; read fresh each time. */
function stillOld(
	daemon: Daemon,
	taskId: number,
	cutoff: number,
): string | null {
	if (daemon.workers.has(taskId)) return null;
	const task = daemon.db
		.query<
			{ state: string; endedAt: number | null; workDir: string },
			[number]
		>(
			'SELECT state, ended_at AS endedAt, work_dir AS workDir FROM tasks WHERE id = ?',
		)
		.get(taskId);
	if (
		!task ||
		!['done', 'failed', 'stopped'].includes(task.state) ||
		task.endedAt === null ||
		task.endedAt >= cutoff ||
		!existsSync(task.workDir)
	) {
		return null;
	}
	return task.workDir;
}

/**
 * Removes one old worktree, after saving everything in it onto its task's
 * branch. A worktree whose save didn't land on that branch is kept.
 */
async function removeOldWorktree(
	daemon: Daemon,
	taskId: number,
	repo: string,
	cutoff: number,
): Promise<void> {
	let workDir = stillOld(daemon, taskId, cutoff);
	if (workDir === null) return;
	const handle = basename(workDir);
	const saved = await saveToBranch(daemon, workDir, handle);
	if (!saved.ok) {
		daemon.log('warn', 'worktree kept', {
			task: handle,
			path: workDir,
			reason: saved.reason,
		});
		return;
	}
	if (saved.commit !== null) {
		daemon.log('info', 'uncommitted work saved', {
			task: handle,
			branch: taskBranch(handle),
			commit: saved.commit.slice(0, 7),
		});
	}
	// Reopened while the save ran: keep it.
	workDir = stillOld(daemon, taskId, cutoff);
	if (workDir === null) return;
	let removed = await git(daemon, ['-C', repo, 'worktree', 'remove', workDir]);
	// Its branch now holds everything in it, so forcing past a HEAD or index
	// that differs loses nothing.
	if (removed.code !== 0) {
		removed = await git(daemon, [
			'-C',
			repo,
			'worktree',
			'remove',
			'--force',
			workDir,
		]);
	}
	daemon.log(
		removed.code === 0 ? 'info' : 'warn',
		removed.code === 0 ? 'worktree removed' : 'worktree kept',
		{
			task: handle,
			path: workDir,
			...(removed.code === 0 ? {} : { error: firstLine(removed.stderr) }),
		},
	);
}

/**
 * Commits a snapshot of the worktree onto `refs/heads/superagent/<handle>`,
 * whatever the worktree has checked out, without touching its own index.
 * Succeeds only when the branch's tree then equals the snapshot; `commit` is
 * `null` when the branch already held it.
 */
async function saveToBranch(
	daemon: Daemon,
	workDir: string,
	handle: string,
): Promise<
	{ ok: true; commit: string | null } | { ok: false; reason: string }
> {
	const ref = `refs/heads/${taskBranch(handle)}`;
	const run = (args: string[], env?: Record<string, string>) =>
		git(daemon, ['-C', workDir, ...args], env ? { env } : {});
	const tip = await run([
		'rev-parse',
		'--verify',
		'--quiet',
		`${ref}^{commit}`,
	]);
	if (tip.code !== 0) return { ok: false, reason: `${ref} doesn't exist` };
	const parent = tip.stdout.trim();

	const tmp = join(daemon.paths.home, 'tasks', handle, 'tmp');
	mkdirSync(tmp, { recursive: true });
	const scratch = mkdtempSync(join(tmp, 'save-'));
	try {
		// A temporary index from the checkout, so files tracked despite
		// .gitignore stay in the snapshot.
		const env = { GIT_INDEX_FILE: join(scratch, 'index') };
		for (const args of [
			['read-tree', 'HEAD'],
			['add', '-A'],
		]) {
			// oxlint-disable-next-line eslint/no-await-in-loop
			const step = await run(args, env);
			if (step.code !== 0) {
				return {
					ok: false,
					reason: `git ${args[0]}: ${firstLine(step.stderr)}`,
				};
			}
		}
		const tree = await run(['write-tree'], env);
		if (tree.code !== 0) {
			return { ok: false, reason: `git write-tree: ${firstLine(tree.stderr)}` };
		}
		const snapshot = tree.stdout.trim();
		const branchTree = async () =>
			(await run(['rev-parse', `${ref}^{tree}`])).stdout.trim();
		if ((await branchTree()) === snapshot) return { ok: true, commit: null };

		const commit = await run([
			// A signing requirement in the user's config would fail the save.
			'-c',
			'commit.gpgsign=false',
			'-c',
			'user.name=superagent',
			'-c',
			'user.email=superagent@localhost',
			'commit-tree',
			'--no-gpg-sign',
			'-p',
			parent,
			'-m',
			'superagent: save uncommitted work before removing the worktree',
			snapshot,
		]);
		if (commit.code !== 0) {
			return {
				ok: false,
				reason: `git commit-tree: ${firstLine(commit.stderr)}`,
			};
		}
		const sha = commit.stdout.trim();
		const moved = await run([
			'update-ref',
			'-m',
			'superagent: save before removing the worktree',
			ref,
			sha,
			parent,
		]);
		if (moved.code !== 0) {
			return {
				ok: false,
				reason: `git update-ref: ${firstLine(moved.stderr)}`,
			};
		}
		if ((await branchTree()) !== snapshot) {
			return { ok: false, reason: `${ref} doesn't hold the saved snapshot` };
		}
		return { ok: true, commit: sha };
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}

/** Cleans up now and then daily. The returned function stops it and waits for a run in progress. */
export function startCleanup(daemon: Daemon): () => Promise<void> {
	let running: Promise<void> = Promise.resolve();
	const run = () => {
		running = cleanUp(daemon).catch((error: unknown) => {
			daemon.log('warn', 'cleanup failed', {
				error: error instanceof Error ? error.message : String(error),
			});
		});
	};
	run();
	const timer = setInterval(run, CLEANUP_INTERVAL_MS);
	return async () => {
		clearInterval(timer);
		await running;
	};
}
