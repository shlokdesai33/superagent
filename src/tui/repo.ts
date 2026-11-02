import { realpathSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Repository } from '../protocol.ts';

/**
 * What tab steps through while writing to the Router: the repository the UI
 * was opened in, the agent's others, then none. Empty outside a repository.
 */
export function repoChoices(
	startedIn: string | null,
	repos: Repository[],
): Array<string | null> {
	if (startedIn === null) return [];
	return [
		startedIn,
		...repos.map((repo) => repo.path).filter((path) => path !== startedIn),
		null,
	];
}

/** The agent's name for the repository, or its folder's before it's added. */
export function repoName(path: string, repos: Repository[]): string {
	return repos.find((repo) => repo.path === path)?.name ?? basename(path);
}

/**
 * The top of the git repository `dir` is in, or `null`. In a linked worktree
 * it's the main one's, since tasks get worktrees of their own.
 */
export function repositoryAt(dir: string): string | null {
	let result: Bun.SyncSubprocess<'pipe', 'ignore'>;
	try {
		result = Bun.spawnSync(
			[
				'git',
				'rev-parse',
				'--path-format=absolute',
				'--show-toplevel',
				'--git-common-dir',
			],
			{
				cwd: dir,
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'ignore',
				timeout: 5_000,
			},
		);
	} catch {
		// No git: nothing to default to.
		return null;
	}
	if (result.exitCode !== 0) return null;
	const [top, common] = result.stdout.toString().trim().split('\n');
	if (!top) return null;
	// A submodule's common dir is inside its superproject's `.git`.
	const repo = common && basename(common) === '.git' ? dirname(common) : top;
	try {
		return realpathSync(repo);
	} catch {
		return repo;
	}
}
