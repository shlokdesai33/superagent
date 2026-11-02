import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { release } from 'node:os';
import { isAbsolute } from 'node:path';
import type { DataPaths } from '../home.ts';
import { readKeyFile, writeKeyFile } from '../keys.ts';
import type { MachineFacts } from '../protocol.ts';
import type { Log } from './log.ts';

/** A setup problem the person fixes; its message is shown as is. */
export class StartupError extends Error {
	override name = 'StartupError';
}

// sun_path sizes, including the terminating NUL.
const SOCKET_PATH_LIMIT = process.platform === 'darwin' ? 104 : 108;

export function createDataFolder(paths: DataPaths): void {
	// Only you can read it: the key file and command logs hold API keys.
	mkdirSync(paths.home, { recursive: true, mode: 0o700 });
	chmodSync(paths.home, 0o700);
	if (Buffer.byteLength(paths.socket) >= SOCKET_PATH_LIMIT) {
		throw new StartupError(
			`The socket path ${paths.socket} is longer than this platform allows (${SOCKET_PATH_LIMIT - 1} bytes). Set SUPERAGENT_HOME to a shorter folder.`,
		);
	}
}

/** Creates `daemon.pid` exclusively, replacing it when its process is gone. */
export function takeLock(path: string): void {
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			writeFileSync(path, `${process.pid}\n`, { flag: 'wx' });
			return;
		} catch (error) {
			if (errorCode(error) !== 'EEXIST') throw error;
		}
		const pid = readPid(path);
		if (pid !== null && isAlive(pid)) {
			throw new StartupError(
				`Another agent is already running with this data folder (pid ${pid})`,
			);
		}
		rmSync(path, { force: true });
	}
	throw new StartupError(
		`Couldn't take the lock ${path}; another agent may be starting`,
	);
}

/** Removes `daemon.pid` if it is still ours. */
export function releaseLock(path: string): void {
	if (readPid(path) === process.pid) rmSync(path, { force: true });
}

function readPid(path: string): number | null {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch {
		return null;
	}
	const pid = Number(text.trim());
	return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// It exists but belongs to someone else.
		return errorCode(error) === 'EPERM';
	}
}

export type Config = {
	/** `githubRepo` (`owner/name`) overrides the GitHub name read from `origin`. */
	repos: Array<{ name: string; path: string; githubRepo?: string }>;
	maxWorkingTasks: number;
	/** `false` turns GitHub off even when gh is logged in. */
	github: boolean;
};

const DEFAULT_CONFIG: Config = {
	repos: [],
	maxWorkingTasks: 4,
	github: true,
};

/**
 * Moves `particleApiKey` from `config.json`, where earlier versions kept it,
 * to the key file. A key file that already holds a key keeps it. Returns the
 * moved key, so it's redacted even when it isn't the one in use.
 */
export function migrateConfigKey(paths: DataPaths, log: Log): string | null {
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(paths.config, 'utf8')) as unknown;
	} catch {
		// Missing or invalid; `loadConfig` creates or reports it.
		return null;
	}
	if (
		typeof value !== 'object' ||
		value === null ||
		Array.isArray(value) ||
		!('particleApiKey' in value)
	) {
		return null;
	}
	const { particleApiKey, ...rest } = value;
	if (particleApiKey !== null && typeof particleApiKey !== 'string') {
		throw new StartupError(`${paths.config}: particleApiKey must be a string`);
	}
	const key = particleApiKey?.trim() || null;
	const existing = readKeyFile(paths.particleKey);
	if (key !== null && existing === null) {
		writeKeyFile(paths.particleKey, key);
	}
	writeFileSync(paths.config, `${JSON.stringify(rest, null, '\t')}\n`, {
		mode: 0o600,
	});
	log(
		'info',
		key === null
			? 'removed an empty particleApiKey from config.json'
			: existing === null || existing === key
				? 'moved particleApiKey from config.json to the key file'
				: 'removed particleApiKey from config.json; the key file already had a different key, which stays',
		{ keyFile: paths.particleKey },
	);
	return key;
}

/** Reads `config.json`, writing the defaults when it doesn't exist. */
export function loadConfig(path: string): Config {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if (errorCode(error) !== 'ENOENT') throw error;
		const { github: _, ...defaults } = DEFAULT_CONFIG;
		writeFileSync(path, `${JSON.stringify(defaults, null, '\t')}\n`, {
			flag: 'wx',
			mode: 0o600,
		});
		return DEFAULT_CONFIG;
	}

	let value: unknown;
	try {
		value = JSON.parse(text) as unknown;
	} catch (error) {
		throw new StartupError(
			`${path} isn't valid JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const invalid = (what: string) => new StartupError(`${path}: ${what}`);
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw invalid('expected an object');
	}
	const raw: Record<string, unknown> = { ...value };

	const repos = raw.repos ?? [];
	if (
		!Array.isArray(repos) ||
		!repos.every(
			(repo: unknown) =>
				typeof repo === 'object' &&
				repo !== null &&
				'name' in repo &&
				typeof repo.name === 'string' &&
				'path' in repo &&
				typeof repo.path === 'string',
		)
	) {
		throw invalid('repos must be a list of { "name", "path" } objects');
	}
	const parsedRepos: Config['repos'] = repos.map(
		(repo: { name: string; path: string; githubRepo?: unknown }) => {
			if (repo.githubRepo === undefined) {
				return { name: repo.name, path: repo.path };
			}
			if (
				typeof repo.githubRepo !== 'string' ||
				!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo.githubRepo)
			) {
				throw invalid(`githubRepo of ${repo.name} must look like "owner/name"`);
			}
			return { name: repo.name, path: repo.path, githubRepo: repo.githubRepo };
		},
	);
	const names = new Set<string>();
	for (const repo of parsedRepos) {
		// The name becomes a folder under worktrees/.
		if (!/^[A-Za-z0-9._-]+$/.test(repo.name) || /^\.\.?$/.test(repo.name)) {
			throw invalid(
				`repository name ${JSON.stringify(repo.name)} may use only letters, digits, ".", "_" and "-"`,
			);
		}
		if (names.has(repo.name)) {
			throw invalid(`repository name ${repo.name} is used twice`);
		}
		names.add(repo.name);
		if (!isAbsolute(repo.path)) {
			throw invalid(`the path of ${repo.name} must be absolute`);
		}
	}
	const maxWorkingTasks = raw.maxWorkingTasks ?? DEFAULT_CONFIG.maxWorkingTasks;
	if (
		typeof maxWorkingTasks !== 'number' ||
		!Number.isInteger(maxWorkingTasks) ||
		maxWorkingTasks < 1
	) {
		throw invalid('maxWorkingTasks must be a whole number of at least 1');
	}
	const github = raw.github ?? DEFAULT_CONFIG.github;
	if (typeof github !== 'boolean') {
		throw invalid('github must be true or false');
	}
	return {
		repos: parsedRepos,
		maxWorkingTasks,
		github,
	};
}

/**
 * The OS and architecture. Fails without `bash`, which every command runs
 * in, or a working `git`, on `path`, the PATH commands and the daemon's git get.
 */
export function gatherMachineFacts(path: string): MachineFacts {
	if (Bun.which('bash', { PATH: path }) === null) {
		throw new StartupError(
			'The agent needs bash on PATH; install it and start again',
		);
	}
	if (!gitInstalled(path)) {
		const fix =
			process.platform === 'darwin'
				? 'xcode-select --install'
				: installCommand(['git']);
		throw new StartupError(
			`The agent needs git on PATH. Install it (${fix}) and start again`,
		);
	}
	return { os: osName(), arch: process.arch };
}

// On macOS it exists even without the Command Line Tools, as a stub that
// opens an install dialog and fails.
const MACOS_GIT_STUB = '/usr/bin/git';

function gitInstalled(path: string): boolean {
	const found = Bun.which('git', { PATH: path });
	if (found === null) return false;
	if (process.platform !== 'darwin' || found !== MACOS_GIT_STUB) return true;
	// `xcode-select -p` finds the developer tools without opening the dialog.
	return (
		Bun.spawnSync(['/usr/bin/xcode-select', '-p'], {
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'ignore',
		}).exitCode === 0
	);
}

function osName(): string {
	if (process.platform === 'darwin') {
		const name = swVers('-productName') || 'macOS';
		const version = swVers('-productVersion');
		return version ? `${name} ${version}` : name;
	}
	const fields = osRelease();
	const name =
		fields.get('PRETTY_NAME') ??
		[fields.get('NAME'), fields.get('VERSION_ID')].filter(Boolean).join(' ');
	return name || `Linux ${release()}`;
}

/** The command that installs `packages` on this Linux distribution. */
export function installCommand(packages: string[]): string {
	const fields = osRelease();
	const family = `${fields.get('ID') ?? ''} ${fields.get('ID_LIKE') ?? ''}`;
	const names = packages.join(' ');
	if (/\b(debian|ubuntu)\b/.test(family)) return `sudo apt install ${names}`;
	if (/\b(fedora|rhel|centos)\b/.test(family)) {
		return `sudo dnf install ${names}`;
	}
	if (/\barch\b/.test(family)) return `sudo pacman -S ${names}`;
	if (/\bsuse\b/.test(family)) return `sudo zypper install ${names}`;
	if (/\balpine\b/.test(family)) return `sudo apk add ${names}`;
	return `Install ${packages.join(', ')} with your package manager`;
}

/** The fields of `/etc/os-release`; empty when there's none. */
export function osRelease(): Map<string, string> {
	try {
		return new Map(
			readFileSync('/etc/os-release', 'utf8')
				.split('\n')
				.map((line) => line.match(/^([A-Z_]+)=("?)(.*)\2$/))
				.filter((match) => match !== null)
				.map((match): [string, string] => [match[1] ?? '', match[3] ?? '']),
		);
	} catch {
		return new Map();
	}
}

function swVers(flag: string): string {
	return Bun.spawnSync(['sw_vers', flag]).stdout.toString().trim();
}

function errorCode(error: unknown): unknown {
	return typeof error === 'object' && error !== null && 'code' in error
		? error.code
		: undefined;
}
