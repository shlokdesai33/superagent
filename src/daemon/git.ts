import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { Daemon } from './state.ts';

// Nothing a Worker planted in a repository runs on the host.
const SAFE_FLAGS = [
	'-c',
	'core.hooksPath=/dev/null',
	'-c',
	'core.fsmonitor=false',
];
const FETCH_TIMEOUT_MS = 60_000;
const GIT_TIMEOUT_MS = 30_000;
const MAX_DIFF_CHARS = 256 * 1024;
const WORKTREE_RETENTION_MS = 7 * 24 * 60 * 60_000;
const LOG_RETENTION_MS = 30 * 24 * 60 * 60_000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60_000;

export type GitResult = { code: number; stdout: string; stderr: string };

/**
 * Built from an allowlist, like Worker commands, so the Particle key can't
 * reach anything a repository's config makes git run (credential helpers,
 * `core.sshCommand`).
 */
function gitEnv(daemon: Daemon | null): Record<string, string> {
	const env: Record<string, string> = {
		PATH: daemon?.loginPath ?? Bun.env.PATH ?? '/usr/bin:/bin',
		HOME: homedir(),
		USER: userInfo().username,
		LANG: Bun.env.LANG || 'C.UTF-8',
		GIT_TERMINAL_PROMPT: '0',
	};
	if (Bun.env.SSH_AUTH_SOCK) env.SSH_AUTH_SOCK = Bun.env.SSH_AUTH_SOCK;
	return env;
}

/** Runs git with the safe flags. Never throws for a non-zero exit. */
export async function git(
	daemon: Daemon,
	args: string[],
	options: { cwd?: string; timeoutMs?: number } = {},
): Promise<GitResult> {
	const child = Bun.spawn(['git', ...SAFE_FLAGS, ...args], {
		cwd: options.cwd ?? daemon.paths.home,
		env: gitEnv(daemon),
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
export function repositoryRoot(dir: string): string | null {
	const result = Bun.spawnSync(
		['git', ...SAFE_FLAGS, 'rev-parse', '--show-toplevel'],
		{
			cwd: dir,
			env: gitEnv(null),
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'ignore',
			timeout: GIT_TIMEOUT_MS,
		},
	);
	const top = result.stdout.toString().trim();
	return result.exitCode === 0 && top !== '' ? top : null;
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
): Promise<string> {
	const path = repoPath(daemon, task.repo);
	return withRepoLock(path, async () => {
		const run = (args: string[], timeoutMs?: number) =>
			git(daemon, ['-C', path, ...args], timeoutMs ? { timeoutMs } : {});
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
		const diff = [...header, ...(body === -1 ? [] : lines.slice(body))].join(
			'\n',
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
 * Removes worktrees of tasks that ended over 7 days ago (their branches stay,
 * so committed work is kept) and command logs older than 30 days.
 */
export async function cleanUp(daemon: Daemon): Promise<void> {
	const now = Date.now();
	const ended = daemon.db
		.query<{ handle: string; repo: string; workDir: string }, [number]>(
			`SELECT handle, repo, work_dir AS workDir FROM tasks
			WHERE repo IS NOT NULL AND state IN ('done', 'failed', 'stopped') AND ended_at < ?`,
		)
		.all(now - WORKTREE_RETENTION_MS);
	for (const task of ended) {
		if (!existsSync(task.workDir)) continue;
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
		// oxlint-disable-next-line eslint/no-await-in-loop
		const removed = await withRepoLock(path, () =>
			git(daemon, ['-C', path, 'worktree', 'remove', '--force', task.workDir]),
		);
		daemon.log(removed.code === 0 ? 'info' : 'warn', 'worktree removed', {
			task: task.handle,
			path: task.workDir,
			...(removed.code === 0 ? {} : { error: firstLine(removed.stderr) }),
		});
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
