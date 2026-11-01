import type { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	SandboxManager,
	type SandboxRuntimeConfig,
} from '@anthropic-ai/sandbox-runtime';
import type { DataPaths } from '../home.ts';
import { git } from './git.ts';
import { osRelease } from './setup.ts';
import type { Daemon } from './state.ts';

/** Whether Worker commands run in the sandbox, and if not, why and how to fix it. */
export type SandboxStatus =
	| { state: 'on' }
	| { state: 'unavailable'; text: string; fix: string | null; since: number };

/**
 * Who started the work. Every task is `requested` for now. Speculative work
 * (started by the agent with nobody watching) gets the registries only and
 * can't ask for more hosts; pass its kind here once it exists.
 */
export type WorkKind = 'requested' | 'speculative';

/** Reachable from every task's commands, over HTTPS only. */
export const REGISTRY_HOSTS = [
	'registry.npmjs.org',
	'registry.yarnpkg.com',
	'jsr.io',
	'pypi.org',
	'files.pythonhosted.org',
	'crates.io',
	'index.crates.io',
	'static.crates.io',
	'proxy.golang.org',
	'sum.golang.org',
	'rubygems.org',
	'index.rubygems.org',
	'repo.maven.apache.org',
];

// Outbound actions on these go through host-side tools with their own gates,
// so no task may reach them, whatever the operator allows.
const NEVER_DOMAINS = [
	'github.com',
	'gitlab.com',
	'bitbucket.org',
	'slack.com',
	'discord.com',
	'gmail.googleapis.com',
	'api.sendgrid.com',
	'api.mailgun.net',
];

// Readable toolchain folders in your home folder; the rest of it is hidden.
const TOOLCHAINS = [
	'.bun',
	'.cargo',
	'.rustup',
	'go',
	'.nvm',
	'.volta',
	'.fnm',
	'.local/share/fnm',
	'.pyenv',
	'.rbenv',
	'.asdf',
	'.local/share/mise',
	'.deno',
	'.sdkman',
	'.local/bin',
	'.local/lib',
];

// Hidden even inside a readable folder.
const CREDENTIALS = [
	'.ssh',
	'.aws',
	'.azure',
	'.config/gcloud',
	'.config/gh',
	'.docker',
	'.kube',
	'.gnupg',
	'.password-store',
	'.netrc',
	'.npmrc',
	'.yarnrc.yml',
	'.pypirc',
	'.git-credentials',
	'.config/git/credentials',
	'.gem/credentials',
	'.cargo/credentials',
	'.cargo/credentials.toml',
	'.terraform.d/credentials.tfrc.json',
	'.local/share/keyrings',
	'.mozilla',
	'.config/google-chrome',
	'.config/chromium',
	'Library/Keychains',
	'Library/Cookies',
	'Library/Application Support/Google/Chrome',
	'Library/Application Support/Firefox',
];

// bubblewrap and socat only from system folders, never from a PATH a task
// could have written to.
const SYSTEM_PATH = '/usr/bin:/bin:/usr/local/bin:/usr/sbin:/sbin';
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const PROBE_TIMEOUT_MS = 15_000;
const MAX_VIOLATIONS = 10;

// sandbox-runtime's seccomp helper and JVM agent run inside the sandbox, so
// they must stay readable when the folder it's installed in is hidden.
const VENDOR = fileURLToPath(
	new URL('../vendor', import.meta.resolve('@anthropic-ai/sandbox-runtime')),
);

const NETWORK = {
	allowedDomains: [],
	deniedDomains: NEVER_DOMAINS.flatMap((domain) => [domain, `*.${domain}`]),
};

/**
 * Starts the sandbox's proxies and runs one probe command through it. Never
 * throws: a sandbox that can't start is `unavailable`, with the fix, and
 * commands are refused until it's fixed and the agent restarted.
 */
export async function startSandbox(
	paths: DataPaths,
	loginPath: string,
): Promise<SandboxStatus> {
	// sandbox-runtime resolves its built-in write denies (shell startup files,
	// editor folders, nested .git/hooks) against the process's working folder.
	// An empty folder of the agent's own keeps them, and the empty placeholder
	// files bubblewrap mounts them on, out of your checkout and the worktrees.
	const cwd = join(paths.home, 'sandbox');
	mkdirSync(cwd, { recursive: true, mode: 0o700 });
	process.chdir(cwd);

	let linux: Pick<SandboxRuntimeConfig, 'bwrapPath' | 'socatPath' | 'ripgrep'> =
		{};
	if (process.platform === 'darwin') {
		if (!existsSync(SANDBOX_EXEC)) {
			return unavailable(
				`${SANDBOX_EXEC} is missing, and macOS commands are sandboxed with it`,
				null,
			);
		}
	} else if (process.platform === 'linux') {
		const bwrap = Bun.which('bwrap', { PATH: SYSTEM_PATH });
		const socat = Bun.which('socat', { PATH: SYSTEM_PATH });
		const rg = Bun.which('rg', { PATH: loginPath }) ?? Bun.which('rg');
		const missing = [
			bwrap ? null : 'bubblewrap',
			socat ? null : 'socat',
			rg ? null : 'ripgrep',
		].filter((name) => name !== null);
		if (missing.length > 0 || !bwrap || !socat || !rg) {
			return unavailable(
				`the sandbox needs ${listed(missing)}, which ${missing.length === 1 ? "isn't" : "aren't"} installed`,
				`${installCommand(missing)}, then restart the agent`,
			);
		}
		if (statSync(bwrap).mode & 0o4000) {
			return unavailable(
				`${bwrap} is setuid root, and the agent won't run commands through a setuid bubblewrap`,
				`sudo chmod u-s ${bwrap}, then restart the agent`,
			);
		}
		linux = { bwrapPath: bwrap, socatPath: socat, ripgrep: { command: rg } };
	} else {
		return unavailable(`${process.platform} has no supported sandbox`, null);
	}

	try {
		await SandboxManager.initialize(
			{
				network: NETWORK,
				filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
				...linux,
			},
			undefined,
			// On Linux the monitor judges writes by this startup config, not each
			// command's, so it would report allowed writes as denied.
			process.platform === 'darwin',
		);
	} catch (error) {
		return unavailable(
			`the sandbox couldn't start (${firstLine(error instanceof Error ? error.message : String(error))})`,
			null,
		);
	}

	const probe = await runProbe(paths, loginPath);
	if (probe === null) return { state: 'on' };
	const diagnosis =
		process.platform === 'darwin'
			? diagnoseMacProbe(probe)
			: diagnoseLinuxProbe(probe);
	await SandboxManager.reset();
	return unavailable(diagnosis.text, diagnosis.fix);
}

function unavailable(text: string, fix: string | null): SandboxStatus {
	return {
		state: 'unavailable',
		text: `Commands are blocked: ${text}`,
		fix,
		since: Date.now(),
	};
}

export async function stopSandbox(): Promise<void> {
	await SandboxManager.reset();
}

/** `null` when `true` ran in the sandbox, else what it printed. */
async function runProbe(
	paths: DataPaths,
	loginPath: string,
): Promise<string | null> {
	let wrapped: string;
	try {
		wrapped = await SandboxManager.wrapWithSandbox('true', '/bin/bash', {
			network: NETWORK,
			filesystem: {
				denyRead: [homedir(), paths.home],
				allowRead: [VENDOR],
				allowWrite: [],
				denyWrite: [],
			},
		});
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	try {
		const child = Bun.spawn(['/bin/bash', '-c', wrapped], {
			env: { PATH: loginPath, HOME: homedir() },
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
	if (
		sysctl('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1'
	) {
		if (stderr.includes('apply-seccomp')) {
			// Ubuntu's bwrap-userns-restrict profile strips capabilities from
			// everything bwrap starts, and the seccomp helper needs a nested user
			// namespace. This reopens nested namespaces for every bwrap user.
			return {
				text: "AppArmor's bwrap-userns-restrict profile stops the sandbox's seccomp helper",
				fix: "echo 'priority=1 capability sys_admin,' | sudo tee /etc/apparmor.d/local/unpriv_bwrap && sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict, then restart the agent",
			};
		}
		return {
			text: "AppArmor doesn't let bubblewrap create user namespaces (Ubuntu 23.10 and later)",
			fix: "printf 'abi <abi/4.0>,\\ninclude <tunables/global>\\nprofile bwrap /usr/bin/bwrap flags=(unconfined) {\\n  userns,\\n  include if exists <local/bwrap>\\n}\\n' | sudo tee /etc/apparmor.d/bwrap && sudo apparmor_parser -r /etc/apparmor.d/bwrap, then restart the agent",
		};
	}
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
	const container =
		existsSync('/.dockerenv') || existsSync('/run/.containerenv');
	return {
		text: `bubblewrap couldn't create the sandbox (${firstLine(stderr)})`,
		fix: container
			? 'Run the agent outside the container, or give the container unprivileged user namespaces, then restart the agent'
			: null,
	};
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

function installCommand(packages: string[]): string {
	const release = osRelease();
	const family = `${release.get('ID') ?? ''} ${release.get('ID_LIKE') ?? ''}`;
	const names = packages.join(' ');
	if (/\b(debian|ubuntu)\b/.test(family)) return `sudo apt install ${names}`;
	if (/\b(fedora|rhel|centos)\b/.test(family)) {
		return `sudo dnf install ${names}`;
	}
	if (/\barch\b/.test(family)) return `sudo pacman -S ${names}`;
	if (/\bsuse\b/.test(family)) return `sudo zypper install ${names}`;
	if (/\balpine\b/.test(family)) return `sudo apk add ${names}`;
	return `Install ${listed(packages)} with your package manager`;
}

/** Hosts a task's commands may reach: the registries, plus what the operator allowed for requested work. */
export function allowedHosts(
	db: Database,
	taskId: number,
	kind: WorkKind,
): string[] {
	const registries = REGISTRY_HOSTS.map((host) => `${host}:443`);
	if (kind === 'speculative') return registries;
	return [...registries, ...grantedHosts(db, taskId)];
}

export function grantedHosts(db: Database, taskId: number): string[] {
	return db
		.query<{ host: string }, [number]>(
			'SELECT host FROM task_hosts WHERE task_id = ? ORDER BY granted_at',
		)
		.all(taskId)
		.map((row) => row.host);
}

/** Why `host` can't be asked for, or `null`. `host` is lower case. */
export function hostProblem(host: string, kind: WorkKind): string | null {
	if (kind === 'speculative') {
		return "work nobody asked for can't reach more hosts";
	}
	const match = host.match(
		/^((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?)(?::(\d{1,5}))?$/,
	);
	if (!match || host.length > 253 || Number(match[2] ?? 443) > 65_535) {
		return `${JSON.stringify(host)} isn't a host name such as registry.example.com or registry.example.com:8443`;
	}
	const name = match[1] ?? '';
	const never = NEVER_DOMAINS.find(
		(domain) => name === domain || name.endsWith(`.${domain}`),
	);
	if (never) {
		return `${never} is never reachable from commands; use your host-side tools (commit, push) or report what you need`;
	}
	if (REGISTRY_HOSTS.includes(name) && (match[2] ?? '443') === '443') {
		return `${name} is already reachable`;
	}
	return null;
}

export type SandboxedCommand = {
	argv: string[];
	/** Call once after the command has ended or failed to start: what the sandbox denied it. */
	finish: () => string[];
};

/**
 * Wraps a Worker command in the task's policy: it writes only in its working
 * folder and private temp folder; reads all but your home folder (except
 * toolchains), the data folder and your repositories' checkouts; never reads
 * credentials; and reaches only `allowedHosts`.
 */
export async function sandboxCommand(
	daemon: Daemon,
	task: { id: number; repo: string | null; workDir: string },
	tmpDir: string,
	command: string,
	kind: WorkKind,
): Promise<SandboxedCommand> {
	const home = homedir();
	const repoPaths = daemon.config.repos.map((repo) => repo.path);
	const credentials = CREDENTIALS.map((path) => join(home, path));
	// A read allowance at or inside a hidden folder would win over hiding it.
	const secret = [daemon.paths.home, ...credentials];
	const gitDir =
		task.repo === null ? null : await repositoryGitDir(daemon, task.repo);
	const readable = [
		VENDOR,
		task.workDir,
		tmpDir,
		...(gitDir === null ? [] : [gitDir]),
		...[
			...TOOLCHAINS.map((folder) => join(home, folder)),
			...daemon.loginPath.split(delimiter),
			...daemon.config.sandboxReadPaths,
		].filter(
			(path) =>
				isBelow(path, home) &&
				!secret.some((folder) => path === folder || isBelow(path, folder)) &&
				existsSync(path),
		),
	];
	const commandId = Buffer.from(
		crypto.getRandomValues(new Uint8Array(16)),
	).toString('base64url');
	// sandbox-runtime sets TMPDIR to a folder shared by every command.
	const wrapped = await SandboxManager.wrapWithSandbox(
		`export TMPDIR=${shellQuote(tmpDir)}\n${command}`,
		'/bin/bash',
		{
			network: NETWORK,
			filesystem: {
				denyRead: [home, daemon.paths.home, ...repoPaths, ...credentials],
				allowRead: readable,
				allowWrite: [task.workDir, tmpDir],
				denyWrite: [join(task.workDir, '.git')],
			},
		},
		undefined,
		{ commandId, commandText: command },
	);
	SandboxManager.registerCommandNetworkLists(commandId, {
		allowedDomains: allowedHosts(daemon.db, task.id, kind),
	});
	let finished = false;
	return {
		argv: ['/bin/bash', '-c', wrapped],
		finish: () => {
			if (finished) return [];
			finished = true;
			SandboxManager.unregisterCommandNetworkLists(commandId);
			SandboxManager.cleanupAfterCommand();
			const lines = SandboxManager.getSandboxViolationStore()
				.getViolationsForCommand(commandId)
				.map((violation) => violation.line);
			return [...new Set(lines)].slice(0, MAX_VIOLATIONS);
		},
	};
}

const gitDirs = new Map<string, string | null>();

/** The repository's shared git folder, which `git status` and `git diff` read from a worktree. */
async function repositoryGitDir(
	daemon: Daemon,
	repo: string,
): Promise<string | null> {
	const path = daemon.config.repos.find((entry) => entry.name === repo)?.path;
	if (path === undefined) return null;
	const known = gitDirs.get(path);
	if (known !== undefined) return known;
	// Asked of the repository itself, never of a worktree's `.git` file.
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

function isBelow(path: string, folder: string): boolean {
	const inside = relative(folder, path);
	return inside !== '' && !inside.startsWith(`..${sep}`) && inside !== '..';
}

function shellQuote(text: string): string {
	return `'${text.replaceAll("'", "'\\''")}'`;
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
