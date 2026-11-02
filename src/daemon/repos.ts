import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute } from 'node:path';
import type { Repository } from '../protocol.ts';
import { git } from './git.ts';
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
export async function useRepository(
	daemon: Daemon,
	path: string,
): Promise<
	{ ok: true; name: string; added: boolean } | { ok: false; detail: string }
> {
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

	const found = await git(daemon, ['-C', top, 'rev-parse', '--show-toplevel']);
	if (found.code !== 0 || canonical(found.stdout.trim()) !== top) {
		return { ok: false, detail: `${path} isn't the top of a git repository` };
	}
	// Another send may have added it while git ran.
	const added = configured(daemon, top);
	if (added !== null) return { ok: true, name: added, added: false };

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

/** The repository a console event names as the default for its tasks, from its `data`. */
export function defaultRepo(data: string | null): string | null {
	const value: unknown = data === null ? null : JSON.parse(data);
	return typeof value === 'object' &&
		value !== null &&
		'repo' in value &&
		typeof value.repo === 'string'
		? value.repo
		: null;
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
