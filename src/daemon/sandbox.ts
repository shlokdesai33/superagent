import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
	SandboxManager,
	type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import type { DataPaths } from '../home.ts';
import { git } from './git.ts';
import { installCommand } from './setup.ts';
import type { Daemon } from './state.ts';

/** Whether Worker commands run in the sandbox, and if not, why and how to fix it. */
export type SandboxStatus =
	| { state: 'on' }
	| { state: 'off'; cause: string; fix: string | null; since: number };

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const PROBE_TIMEOUT_MS = 15_000;

// The sandbox only keeps writes in place. sandbox-runtime filters the network
// whenever `allowedDomains` is set, so it's removed; Unix sockets (ssh-agent,
// Docker, commit signing) stay usable.
const NETWORK: SandboxRuntimeConfig['network'] = {
	allowedDomains: [],
	deniedDomains: [],
	allowAllUnixSockets: true,
};
Reflect.deleteProperty(NETWORK, 'allowedDomains');

/**
 * Starts the sandbox and runs one probe command through it. Never throws: a
 * sandbox that can't start is `off`, with the fix, and commands run
 * unsandboxed until it's fixed and the agent restarted.
 */
export async function startSandbox(
	paths: DataPaths,
	loginPath: string,
): Promise<SandboxStatus> {
	// sandbox-runtime resolves its built-in write denies (shell startup files,
	// .git/hooks) against the process's working folder, so the daemon works
	// from an empty folder of its own, wherever it was started.
	const cwd = join(paths.home, 'sandbox');
	mkdirSync(cwd, { recursive: true });
	process.chdir(cwd);

	if (process.platform === 'darwin') {
		if (!existsSync(SANDBOX_EXEC)) {
			return off(`${SANDBOX_EXEC} is missing`, null);
		}
	} else if (process.platform === 'linux') {
		// sandbox-runtime's own dependency check needs all three.
		const missing = [
			Bun.which('bwrap') ? null : 'bubblewrap',
			Bun.which('socat') ? null : 'socat',
			Bun.which('rg') ? null : 'ripgrep',
		].filter((name) => name !== null);
		if (missing.length > 0) {
			return off(
				`the sandbox needs ${listed(missing)}, which ${missing.length === 1 ? "isn't" : "aren't"} installed`,
				`${installCommand(missing)}, then restart the agent`,
			);
		}
	} else {
		return off(`${process.platform} has no supported sandbox`, null);
	}

	try {
		await SandboxManager.initialize({
			network: NETWORK,
			filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
		});
	} catch (error) {
		return off(
			`the sandbox couldn't start (${firstLine(error instanceof Error ? error.message : String(error))})`,
			null,
		);
	}
	const probe = await runProbe(loginPath);
	if (probe === null) return { state: 'on' };
	await SandboxManager.reset();
	const diagnosis =
		process.platform === 'darwin'
			? diagnoseMacProbe(probe)
			: diagnoseLinuxProbe(probe);
	return off(diagnosis.text, diagnosis.fix);
}

export async function stopSandbox(): Promise<void> {
	await SandboxManager.reset();
}

function off(text: string, fix: string | null): SandboxStatus {
	return {
		state: 'off',
		cause: text,
		fix,
		since: Date.now(),
	};
}

/** `null` when `true` ran in the sandbox, else what it printed. */
async function runProbe(loginPath: string): Promise<string | null> {
	let wrapped: string;
	try {
		wrapped = await SandboxManager.wrapWithSandbox('true', '/bin/bash');
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	try {
		const child = Bun.spawn(['/bin/bash', '-c', wrapped], {
			env: { ...Bun.env, PATH: loginPath },
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'pipe',
			timeout: PROBE_TIMEOUT_MS,
		});
		const [stderr, code] = await Promise.all([
			new Response(child.stderr).text(),
			child.exited,
		]);
		return code === 0 ? null : stderr.trim() || `exit ${code}`;
	} finally {
		SandboxManager.cleanupAfterCommand();
	}
}

function diagnoseLinuxProbe(stderr: string): {
	text: string;
	fix: string | null;
} {
	const keep =
		' (add the setting to /etc/sysctl.d/ to keep it after a reboot), then restart the agent';
	if (sysctl('/proc/sys/kernel/unprivileged_userns_clone') === '0') {
		return {
			text: 'the kernel has unprivileged user namespaces turned off',
			fix: `sudo sysctl -w kernel.unprivileged_userns_clone=1${keep}`,
		};
	}
	if (sysctl('/proc/sys/user/max_user_namespaces') === '0') {
		return {
			text: 'the kernel allows no user namespaces (user.max_user_namespaces is 0)',
			fix: `sudo sysctl -w user.max_user_namespaces=15000${keep}`,
		};
	}
	// On by default since Ubuntu 23.10, so it's only the cause when bwrap has
	// no profile yet, or fails the way a namespace without capabilities does.
	if (
		sysctl('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1' &&
		(!bwrapProfileInstalled() ||
			/setting up uid map|RTM_NEWADDR|apparmor/i.test(stderr))
	) {
		// The profile Claude Code documents: it lets bwrap itself create user
		// namespaces, and leaves the commands it runs to the sandbox.
		return {
			text: "AppArmor doesn't let bubblewrap create user namespaces (Ubuntu 23.10 and later)",
			fix: "printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\\n  userns,\\n  include if exists <local/bwrap>\\n}\\n' | sudo tee /etc/apparmor.d/bwrap >/dev/null && sudo apparmor_parser -r /etc/apparmor.d/bwrap, then restart the agent",
		};
	}
	const container =
		existsSync('/.dockerenv') || existsSync('/run/.containerenv');
	return {
		text: `bubblewrap couldn't create the sandbox (${firstLine(stderr)})`,
		fix: container
			? 'Run the agent outside the container, or give the container unprivileged user namespaces, then restart the agent'
			: null,
	};
}

/** Whether an AppArmor profile for bwrap is loaded, or at least installed when the loaded list can't be read. */
function bwrapProfileInstalled(): boolean {
	const loaded = sysctl('/sys/kernel/security/apparmor/profiles');
	if (loaded !== null) return /^(bwrap|unpriv_bwrap) /m.test(loaded);
	return [
		'/etc/apparmor.d/bwrap',
		'/etc/apparmor.d/bwrap-userns-restrict',
	].some((path) => existsSync(path));
}

function sysctl(path: string): string | null {
	try {
		return readFileSync(path, 'utf8').trim();
	} catch {
		return null;
	}
}

function diagnoseMacProbe(stderr: string): {
	text: string;
	fix: string | null;
} {
	return {
		text: `sandbox-exec couldn't start (${firstLine(stderr)})`,
		// sandbox_apply fails this way inside another sandbox.
		fix: stderr.includes('Operation not permitted')
			? 'Start the agent from a normal terminal, not from inside another sandboxed app, then restart it'
			: null,
	};
}

// Package and tool caches in your home folder, so installs and builds work.
// Only ones that exist are writable, so no folder appears for a tool you
// don't use; ~/.cache, where most tools keep theirs, is created when missing.
const CACHES = [
	'.cache',
	'.npm',
	'.bun/install/cache',
	'.local/share/pnpm',
	'.yarn/berry',
	'go/pkg/mod',
	'.cargo/registry',
	'.cargo/git',
	'.m2/repository',
	'.gradle',
	...(process.platform === 'darwin' ? ['Library/Caches', 'Library/pnpm'] : []),
];

// Where you've moved a tool's cache, it's used instead, and created if needed.
const CACHE_ENV = [
	'XDG_CACHE_HOME',
	'npm_config_cache',
	'BUN_INSTALL_CACHE_DIR',
	'PNPM_HOME',
	'YARN_CACHE_FOLDER',
	'PIP_CACHE_DIR',
	'UV_CACHE_DIR',
	'GOMODCACHE',
	'GOCACHE',
];

const skippedCaches = new Set<string>();

/** The cache folders commands may write; a bad one is skipped, never fatal. */
function cacheFolders(daemon: Daemon): string[] {
	const home = homedir();
	const wanted: Array<{ path: string; create: boolean }> = [
		...CACHES.map((folder) => ({
			path: join(home, folder),
			create: folder === '.cache',
		})),
		...CACHE_ENV.map((name) => Bun.env[name])
			.filter((path): path is string => Boolean(path))
			.map((path) => ({ path, create: true })),
	];
	const folders: string[] = [];
	for (const { path, create } of wanted) {
		const problem = cacheProblem(path, create);
		if (problem === null) {
			folders.push(path);
		} else if (problem !== 'missing' && !skippedCaches.has(path)) {
			skippedCaches.add(path);
			daemon.log('warn', 'cache folder not writable by commands', {
				path,
				reason: problem,
			});
		}
	}
	return folders;
}

/** `null` when `path` is a usable folder, `missing` when it's absent and not ours to create. */
function cacheProblem(path: string, create: boolean): string | null {
	if (!isAbsolute(path)) return "it isn't an absolute path";
	let found;
	try {
		found = statSync(path, { throwIfNoEntry: false });
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	if (found) return found.isDirectory() ? null : "it isn't a folder";
	if (!create) return 'missing';
	try {
		mkdirSync(path, { recursive: true });
		return null;
	} catch (error) {
		return `couldn't create it (${error instanceof Error ? error.message : String(error)})`;
	}
}

/**
 * `command`, wrapped so it can write only in the task's working folder, its
 * temp folder, /tmp, the package and tool caches and, in a worktree, the
 * repository's git folder (so git works as usual). Call
 * `SandboxManager.cleanupAfterCommand()` once it has ended.
 */
export async function sandboxCommand(
	daemon: Daemon,
	task: { repo: string | null; workDir: string },
	tmpDir: string,
	command: string,
): Promise<string[]> {
	const gitDir =
		task.repo === null ? null : await repositoryGitDir(daemon, task.repo);
	// sandbox-runtime points TMPDIR at a folder shared by every command.
	const wrapped = await SandboxManager.wrapWithSandbox(
		`export TMPDIR='${tmpDir.replaceAll("'", "'\\''")}'\n${command}`,
		'/bin/bash',
		{
			filesystem: {
				denyRead: [],
				allowWrite: [
					task.workDir,
					tmpDir,
					'/tmp',
					...cacheFolders(daemon),
					...(gitDir ? [gitDir] : []),
				],
				denyWrite: [],
			},
		},
	);
	return ['/bin/bash', '-c', wrapped];
}

const gitDirs = new Map<string, string | null>();

/** The repository's shared git folder, where a worktree's commits go. */
async function repositoryGitDir(
	daemon: Daemon,
	repo: string,
): Promise<string | null> {
	const path = daemon.config.repos.find((entry) => entry.name === repo)?.path;
	if (path === undefined) return null;
	const known = gitDirs.get(path);
	if (known !== undefined) return known;
	const result = await git(daemon, [
		'-C',
		path,
		'rev-parse',
		'--git-common-dir',
	]);
	const dir = result.code === 0 ? resolve(path, result.stdout.trim()) : null;
	gitDirs.set(path, dir);
	return dir;
}

function listed(names: string[]): string {
	return names.length <= 1
		? (names[0] ?? '')
		: `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

function firstLine(text: string): string {
	return (
		text
			.split('\n')
			.map((line) => line.trim())
			.find((line) => line !== '') ?? 'no output'
	);
}
