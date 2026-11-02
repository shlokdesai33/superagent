import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Repository } from '../protocol.ts';
import { gitSync } from './git.ts';
import { type Daemon, canonical, health } from './state.ts';

function configured(daemon: Daemon, path: string): string | null {
	return (
		daemon.config.repos.find((repo) => canonical(repo.path) === path)?.name ??
		null
	);
}

/**
 * The configured name of the repository whose top is `path`, adding it to
 * `config.json` when it isn't there yet.
 */
export function useRepository(
	daemon: Daemon,
	path: string,
): { ok: true; name: string; added: boolean } | { ok: false; detail: string } {
	if (!isAbsolute(path)) {
		return { ok: false, detail: `${path} isn't an absolute path` };
	}
	let top: string;
	try {
		top = realpathSync(path);
	} catch {
		return { ok: false, detail: `${path} doesn't exist` };
	}
	const known = configured(daemon, top);
	if (known !== null) return { ok: true, name: known, added: false };

	const found = gitSync(daemon, ['-C', top, 'rev-parse', '--show-toplevel']);
	if (found.code !== 0 || canonical(found.stdout.trim()) !== top) {
		return { ok: false, detail: `${path} isn't the top of a git repository` };
	}

	const name = freeName(daemon, top);
	const entry = { name, path: top };
	saveRepo(daemon.paths.config, entry);
	daemon.config.repos.push(entry);
	daemon.log('info', 'added a repository to config.json', {
		repo: name,
		path: top,
	});
	daemon.githubApi?.recheck();
	daemon.feed.publish({ type: 'health', health: health(daemon) });
	return { ok: true, name, added: true };
}

/**
 * The top of the repository `dir` is in, or `null`. In a linked worktree it's
 * the main one's, as for the terminal UI's default.
 */
function repositoryTop(daemon: Daemon, dir: string): string | null {
	const found = gitSync(daemon, [
		'-C',
		dir,
		'rev-parse',
		'--path-format=absolute',
		'--show-toplevel',
		'--git-common-dir',
	]);
	if (found.code !== 0) return null;
	const [top, common] = found.stdout.trim().split('\n');
	if (!top) return null;
	// A submodule's common dir is inside its superproject's `.git`.
	return canonical(
		common && basename(common) === '.git' ? dirname(common) : top,
	);
}

/**
 * A repository `start_task` names that isn't configured, added like one a
 * message is sent from: a path (absolute, `~/…`, or relative to the
 * operator's terminal folder `cwd`), or a folder name looked up in `cwd` and
 * next to the configured repositories. `detail` says what to do instead.
 */
export function addNamedRepository(
	daemon: Daemon,
	requested: string,
	cwd: string | null,
): { ok: true; name: string; added: boolean } | { ok: false; detail: string } {
	const names = daemon.config.repos.map((repo) => repo.name);
	const known =
		names.length > 0
			? `the configured ones are ${names.join(', ')}`
			: 'none are configured';
	const ask = `Don't start the task anywhere else: reply asking the operator for the repository's path, then call start_task with repo set to that path`;

	if (/^[~./]/.test(requested) || requested.includes('/')) {
		let path: string;
		if (requested === '~' || requested.startsWith('~/')) {
			path = join(homedir(), requested.slice(1));
		} else if (isAbsolute(requested)) {
			path = requested;
		} else if (cwd !== null) {
			path = resolve(cwd, requested);
		} else {
			return {
				ok: false,
				detail: `${requested} is a relative path and the event has no terminal folder to resolve it from; pass an absolute path`,
			};
		}
		if (!existsSync(path)) {
			return { ok: false, detail: `${path} doesn't exist. ${ask}` };
		}
		const top = repositoryTop(daemon, path);
		if (top === null) {
			return {
				ok: false,
				detail: `${path} isn't in a git repository. ${ask}`,
			};
		}
		return useRepository(daemon, top);
	}

	const folders = [
		...new Set(
			[
				...(cwd === null ? [] : [cwd]),
				...daemon.config.repos.map((repo) => dirname(canonical(repo.path))),
			].map(canonical),
		),
	];
	const found = [
		...new Set(
			folders
				.map((folder) => join(folder, requested))
				.filter((path) => existsSync(path))
				.map(canonical)
				.filter((path) => repositoryTop(daemon, path) === path),
		),
	];
	const [only] = found;
	if (only !== undefined && found.length === 1) {
		return useRepository(daemon, only);
	}
	if (found.length > 1) {
		return {
			ok: false,
			detail: `several git repositories are named ${requested}: ${found.join(', ')}; pass repo as the path of the one meant, or ask the operator`,
		};
	}
	return {
		ok: false,
		detail: `no repository ${JSON.stringify(requested)}: it isn't configured (${known}), and no git repository named ${requested} is in ${folders.length > 0 ? folders.join(' or ') : 'a folder I know'}. ${ask}`,
	};
}

/** The repository a console event names as the default for its tasks, from its `data`. */
export function defaultRepo(data: string | null): string | null {
	return dataString(data, 'repo');
}

/** The folder the operator's terminal UI was in when they sent a console event. */
export function eventFolder(data: string | null): string | null {
	return dataString(data, 'cwd');
}

function dataString(data: string | null, key: string): string | null {
	const value: unknown = data === null ? null : JSON.parse(data);
	if (typeof value !== 'object' || value === null || !(key in value)) {
		return null;
	}
	const field: unknown = Reflect.get(value, key);
	return typeof field === 'string' ? field : null;
}

/** Its folder's name, made config-safe, with `-2`, `-3`… when that's taken. */
function freeName(daemon: Daemon, path: string): string {
	const base = basename(path).replaceAll(/[^A-Za-z0-9._-]/g, '-');
	const stem = base === '' || /^\.\.?$/.test(base) ? 'repo' : base;
	const taken = new Set(daemon.config.repos.map((repo) => repo.name));
	let name = stem;
	for (let n = 2; taken.has(name); n++) name = `${stem}-${n}`;
	return name;
}

/** Appends to `repos` in `config.json`, keeping everything else in the file as it is. */
function saveRepo(path: string, entry: Repository): void {
	const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
	const raw: Record<string, unknown> =
		typeof value === 'object' && value !== null ? { ...value } : {};
	raw.repos = [...(Array.isArray(raw.repos) ? raw.repos : []), entry];
	writeFileSync(path, `${JSON.stringify(raw, null, '\t')}\n`, { mode: 0o600 });
}
