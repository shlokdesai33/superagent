// End to end: GitHub through gh, and optional (GitHub build step 1). GitHub
// off without gh, off with gh logged out, on without a restart, a token gh
// replaced, a token GitHub rejects, and the token kept out of everything.
// Run with `bun run e2e`; it exits non-zero if a check fails.
import { execFileSync } from 'node:child_process';
import {
	chmodSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { FeedLine, Health } from '../src/protocol.ts';
import { startFakeGitHub } from './fake-github.ts';
import { startFakeParticle } from './fake-particle.ts';
import { startAgent } from './harness.ts';

type Channel = Health['channels'][number];
type TaskLine = Extract<FeedLine, { type: 'task' }>;

const fresh = (name: string) =>
	`gho_${name}${crypto.randomUUID().replaceAll('-', '')}`;
const FIRST = fresh('first');
const SECOND = fresh('second');
const THIRD = fresh('third');
const TOKENS = [FIRST, SECOND, THIRD];

// A fake gh: `gh auth token` prints the token file, if there is one.
const ghDir = mkdtempSync('/tmp/sa-gh-');
const gh = join(ghDir, 'gh');
const tokenFile = join(ghDir, 'token');
const GH_SCRIPT = `#!/bin/sh
if [ "$1" = auth ] && [ "$2" = token ] && [ -s "$FAKE_GH_TOKEN_FILE" ]; then
	cat "$FAKE_GH_TOKEN_FILE"
	exit 0
fi
echo "no oauth token found for github.com" >&2
exit 1
`;

// One repository whose origin is on GitHub, and one named in config that the
// account can't push to.
const repoDir = mkdtempSync('/tmp/sa-repo-');
execFileSync('git', ['init', '-q', repoDir]);
execFileSync('git', [
	'-C',
	repoDir,
	'remote',
	'add',
	'origin',
	'git@github.com:acme/app.git',
]);

const github = startFakeGitHub({
	login: 'shlok',
	token: FIRST,
	repos: { 'acme/app': { push: true }, 'acme/locked': { push: false } },
});

// The fake models: a Router that starts the task each console message asks
// for, and Workers that finish, or print what a leak would show and finish.
const kinds = new Map<string, 'off' | 'leak'>();
const particle = startFakeParticle((request) => {
	if (request.session === 'compaction') return { content: 'Summary.' };
	if (request.session === 'router') {
		if (request.fresh.includes('GH-OFF')) {
			return {
				calls: [
					{
						name: 'start_task',
						args: {
							title: 'Fix issue 7',
							instructions: 'Fix acme/app#7.',
							threads: ['github:acme/app#7'],
							repo: 'none',
						},
					},
					{
						name: 'start_task',
						args: {
							title: 'Console work',
							instructions: 'OFF-TASK: work without GitHub.',
							threads: [],
							repo: 'none',
						},
					},
				],
			};
		}
		if (request.fresh.includes('LEAK')) {
			return {
				calls: [
					{
						name: 'start_task',
						args: {
							title: 'Leak check',
							instructions: 'LEAK-TASK: print what a leak would show.',
							threads: [],
							repo: 'none',
						},
					},
				],
			};
		}
		return { content: 'Nothing to say.' };
	}

	const handle = request.handle ?? '';
	if (!kinds.has(handle)) {
		kinds.set(handle, request.fresh.includes('LEAK-TASK') ? 'leak' : 'off');
	}
	if (kinds.get(handle) === 'leak' && !request.called.includes('run')) {
		return {
			content: 'Checking what commands can see.',
			calls: [
				{ name: 'run', args: { command: 'echo "gh_token_len=${#GH_TOKEN}"' } },
				{ name: 'run', args: { command: '"$SUPERAGENT_GH" auth token' } },
				// The token in two writes, so it arrives split across chunks.
				{
					name: 'run',
					args: {
						command:
							't=$("$SUPERAGENT_GH" auth token); printf "split=%s" "${t:0:12}"; sleep 0.3; printf "%s\\n" "${t:12}"',
					},
				},
				{ name: 'run', args: { command: 'env; ps -eo args' } },
			],
		};
	}
	return {
		content: 'Done.',
		calls: [{ name: 'finish', args: { result: 'Done' } }],
	};
});

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (!ok) failures += 1;
	process.stdout.write(
		`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}\n`,
	);
}

const agent = await startAgent(particle.url, {
	env: {
		SUPERAGENT_GH: gh,
		FAKE_GH_TOKEN_FILE: tokenFile,
		SUPERAGENT_GITHUB_API_URL: github.url,
		SUPERAGENT_GITHUB_POLL_MS: '200',
		// gh could read its token from here; commands must not see it.
		GH_TOKEN: THIRD,
	},
	config: {
		maxWorkingTasks: 4,
		repos: [
			{ name: 'app', path: repoDir },
			{ name: 'locked', path: repoDir, githubRepo: 'acme/locked' },
		],
	},
});

/** The latest health on the feed. */
function latestHealth(): Health | null {
	for (const line of agent.lines.toReversed()) {
		if (line.type === 'health') return line.health;
		if (line.type === 'snapshot') return line.snapshot.health;
	}
	return null;
}

const githubChannel = (value: Health | null): Channel | null =>
	value?.channels.find((channel) => channel.name === 'github') ?? null;

const githubIs = async (
	what: string,
	done: (channel: Channel, value: Health) => boolean,
): Promise<Health> => {
	const found = await agent.until(
		what,
		async () => latestHealth(),
		(value) => {
			const channel = githubChannel(value);
			return value !== null && channel !== null && done(channel, value);
		},
	);
	if (found === null) throw new Error(`no health line for ${what}`);
	return found;
};

const githubProblems = (value: Health) =>
	value.problems.filter((problem) => problem.id.startsWith('github'));

const taskDone = (title: string) =>
	agent.waitFor(
		`${title} to finish`,
		(line): line is TaskLine =>
			line.type === 'task' &&
			line.task.title === title &&
			line.task.status === 'done',
	);

const describe = (value: Health | null) => {
	const channel = githubChannel(value);
	return channel ? `${channel.state}: ${channel.detail ?? ''}` : 'no github';
};

try {
	// 0. No gh: GitHub is off, not a problem, and console work still runs.
	const missing = await githubIs(
		'GitHub off without gh',
		(channel) =>
			channel.state === 'off' &&
			(channel.detail ?? '').includes("gh isn't installed"),
	);
	check(
		'without gh, GitHub is off and says how to enable it',
		true,
		describe(missing),
	);
	check(
		'GitHub being off is not a problem',
		githubProblems(missing).length === 0,
	);
	await agent.action({ type: 'send_console', text: 'GH-OFF fix issue #7' });
	const offTask = await taskDone('Console work');
	check(
		'a console task runs to the end with GitHub off',
		true,
		offTask.task.handle,
	);
	const routerResults = particle.requests
		.filter((request) => request.session === 'router')
		.flatMap((request) => request.results);
	check(
		'start_task with a github: thread says GitHub is off',
		routerResults.some((result) => result.startsWith('error: GitHub is off')),
		routerResults.find((result) => result.startsWith('error:')) ?? 'no error',
	);

	// 1. gh installed but logged out, then logged in: on without a restart.
	writeFileSync(gh, GH_SCRIPT);
	chmodSync(gh, 0o755);
	const loggedOut = await githubIs(
		'GitHub off with gh logged out',
		(channel) =>
			channel.state === 'off' &&
			(channel.detail ?? '').includes("gh isn't logged in"),
	);
	check(
		'with gh logged out, GitHub is off and says to run gh auth login',
		true,
		describe(loggedOut),
	);
	writeFileSync(tokenFile, `${FIRST}\n`);
	const on = await githubIs('GitHub up', (channel) => channel.state === 'up');
	check(
		'logging in to gh turns GitHub on without a restart',
		(githubChannel(on)?.detail ?? '').includes('@shlok via gh · 2 repos'),
		describe(on),
	);
	const problems = githubProblems(on).map((problem) => problem.id);
	check(
		'a repository you can push to is fine, and one you can’t is a problem',
		problems.includes('github-push:acme/locked') &&
			!problems.includes('github-push:acme/app'),
		problems.join(', '),
	);
	check(
		'the GitHub name comes from origin or githubRepo',
		github.requests.some((request) => request.path === '/repos/acme/app') &&
			github.requests.some((request) => request.path === '/repos/acme/locked'),
	);

	// 10. gh gets a new token: the daemon re-reads it on the 401 and carries on.
	const before = agent.lines.length;
	github.setToken(SECOND);
	writeFileSync(tokenFile, `${SECOND}\n`);
	await agent.until(
		'a request with the new token',
		async () => github.requests,
		(requests) =>
			requests.some(
				(request) =>
					request.auth === `Bearer ${SECOND}` && request.status === 200,
			),
	);
	await Bun.sleep(500);
	const wentDown = agent.lines
		.slice(before)
		.some(
			(line) =>
				line.type === 'health' && githubChannel(line.health)?.state === 'down',
		);
	check(
		'a token gh replaced is picked up on the 401 without going down',
		!wentDown && githubChannel(latestHealth())?.state === 'up',
		describe(latestHealth()),
	);

	// GitHub rejects the token gh has: down with a problem, until gh has a
	// working one.
	github.setToken(THIRD);
	const rejected = await githubIs(
		'GitHub down',
		(channel) => channel.state === 'down',
	);
	check(
		'a rejected token is a problem, with the fix',
		githubProblems(rejected).some(
			(problem) =>
				problem.id === 'github' &&
				problem.text === 'GitHub rejected your gh token' &&
				problem.fix === 'gh auth login',
		),
		describe(rejected),
	);
	writeFileSync(tokenFile, `${THIRD}\n`);
	const back = await githubIs(
		'GitHub back up',
		(channel, value) =>
			channel.state === 'up' &&
			!githubProblems(value).some((problem) => problem.id === 'github'),
	);
	check('a working token from gh brings it back', true, describe(back));

	// Leaks: what Worker commands see and print.
	if (latestHealth()?.sandbox === 'on') {
		await agent.action({ type: 'send_console', text: 'LEAK check please' });
		const leak = await taskDone('Leak check');
		const results = particle.requests
			.filter(
				(request) =>
					request.session === 'worker' && request.handle === leak.task.handle,
			)
			.flatMap((request) => request.results);
		check(
			"a GH_TOKEN holding the token doesn't reach commands",
			results.some((result) => result.includes('gh_token_len=0')),
		);
		check(
			'a token printed in two pieces is redacted whole',
			results.some((result) => result.includes('split=[redacted]')),
		);
		check(
			'gh auth token in a command shows [redacted]',
			results.some(
				(result) =>
					result.includes('auth token') && result.includes('[redacted]'),
			),
		);
	} else {
		process.stdout.write(
			'- skipped the command checks: the sandbox is unavailable, so commands are refused\n',
		);
	}
} catch (error) {
	failures += 1;
	process.stdout.write(
		`✗ ${error instanceof Error ? error.message : String(error)}\n`,
	);
} finally {
	const contains = (text: string) =>
		TOKENS.some((token) => text.includes(token));
	await agent.stop((home) => {
		const leaked = files(home).filter((path) =>
			TOKENS.some((token) => readFileSync(path).includes(token)),
		);
		check(
			'no file in the data folder holds a token',
			leaked.length === 0,
			leaked.join(', '),
		);
		const redactedLog = files(join(home, 'tasks')).some(
			(path) =>
				path.includes('/commands/') &&
				readFileSync(path, 'utf8').includes('[redacted]'),
		);
		check(
			'command logs on disk hold [redacted] where a token was printed',
			redactedLog || latestHealth()?.sandbox !== 'on',
		);
	});
	check('no feed line holds a token', !contains(JSON.stringify(agent.lines)));
	check(
		'no request to the model holds a token',
		!contains(JSON.stringify(particle.requests.map((request) => request.body))),
	);
	check(
		'GitHub saw the token only in Authorization headers',
		!github.requests.some(
			(request) => contains(request.path) || contains(request.body),
		),
	);
	particle.stop();
	github.stop();
	rmSync(ghDir, { recursive: true, force: true });
	rmSync(repoDir, { recursive: true, force: true });
}

/** Every file under `dir`. */
function files(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}
	return names.flatMap((name) => {
		const path = join(dir, name);
		const stat = statSync(path, { throwIfNoEntry: false });
		if (!stat) return [];
		return stat.isDirectory() ? files(path) : stat.isFile() ? [path] : [];
	});
}

process.stdout.write(
	failures === 0 ? '\nAll checks passed.\n' : `\n${failures} failed.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
