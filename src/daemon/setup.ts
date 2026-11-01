import {
	chmodSync,
	mkdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { release } from 'node:os';
import type { DataPaths } from '../home.ts';
import type { MachineFacts } from '../protocol.ts';

/** A setup problem the person fixes; its message is shown as is. */
export class StartupError extends Error {
	override name = 'StartupError';
}

// sun_path sizes, including the terminating NUL.
const SOCKET_PATH_LIMIT = process.platform === 'darwin' ? 104 : 108;

const MACHINE_TOOLS = [
	'git',
	'gh',
	'rg',
	'jq',
	'bun',
	'node',
	'python3',
	'docker',
	'bwrap',
	'socat',
];

export function createDataFolder(paths: DataPaths): void {
	mkdirSync(paths.home, { recursive: true, mode: 0o700 });
	// The folder's mode is the real access boundary, so tighten an existing one.
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
	particleApiKey: string | null;
	repos: Array<{ name: string; path: string }>;
	maxWorkingTasks: number;
};

const DEFAULT_CONFIG: Config = {
	particleApiKey: null,
	repos: [],
	maxWorkingTasks: 4,
};

/** Reads `config.json`, writing the defaults when it doesn't exist. */
export function loadConfig(path: string): Config {
	let text: string;
	try {
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if (errorCode(error) !== 'ENOENT') throw error;
		const { particleApiKey: _, ...defaults } = DEFAULT_CONFIG;
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

	const particleApiKey = raw.particleApiKey ?? null;
	if (particleApiKey !== null && typeof particleApiKey !== 'string') {
		throw invalid('particleApiKey must be a string');
	}
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
	const maxWorkingTasks = raw.maxWorkingTasks ?? DEFAULT_CONFIG.maxWorkingTasks;
	if (
		typeof maxWorkingTasks !== 'number' ||
		!Number.isInteger(maxWorkingTasks) ||
		maxWorkingTasks < 1
	) {
		throw invalid('maxWorkingTasks must be a whole number of at least 1');
	}
	return {
		particleApiKey,
		repos: repos.map((repo: { name: string; path: string }) => ({
			name: repo.name,
			path: repo.path,
		})),
		maxWorkingTasks,
	};
}

/** Reads `token`, creating 32 random bytes (base64url) when it's missing or empty. */
export function loadToken(path: string): string {
	try {
		const token = readFileSync(path, 'utf8').trim();
		if (token !== '') return token;
	} catch (error) {
		if (errorCode(error) !== 'ENOENT') throw error;
	}
	const token = Buffer.from(
		crypto.getRandomValues(new Uint8Array(32)),
	).toString('base64url');
	rmSync(path, { force: true });
	writeFileSync(path, `${token}\n`, { flag: 'wx', mode: 0o600 });
	return token;
}

/** Fails when `git` or `bash` is missing, since Workers can't run without them. */
export function gatherMachineFacts(): MachineFacts {
	const missing = ['git', 'bash'].filter((tool) => Bun.which(tool) === null);
	if (missing.length > 0) {
		throw new StartupError(
			`The agent needs ${missing.join(' and ')} on PATH; install ${missing.length > 1 ? 'them' : 'it'} and start again`,
		);
	}
	return {
		os: osName(),
		arch: process.arch,
		tools: Object.fromEntries(
			MACHINE_TOOLS.map((tool) => [tool, Bun.which(tool) !== null]),
		),
	};
}

function osName(): string {
	if (process.platform === 'darwin') {
		const name = swVers('-productName') || 'macOS';
		const version = swVers('-productVersion');
		return version ? `${name} ${version}` : name;
	}
	try {
		const fields = new Map(
			readFileSync('/etc/os-release', 'utf8')
				.split('\n')
				.map((line) => line.match(/^([A-Z_]+)=("?)(.*)\2$/))
				.filter((match) => match !== null)
				.map((match) => [match[1], match[3]]),
		);
		const name =
			fields.get('PRETTY_NAME') ??
			[fields.get('NAME'), fields.get('VERSION_ID')].filter(Boolean).join(' ');
		if (name) return name;
	} catch {
		// No os-release; fall back to the kernel.
	}
	return `Linux ${release()}`;
}

function swVers(flag: string): string {
	return Bun.spawnSync(['sw_vers', flag]).stdout.toString().trim();
}

function errorCode(error: unknown): unknown {
	return typeof error === 'object' && error !== null && 'code' in error
		? error.code
		: undefined;
}
