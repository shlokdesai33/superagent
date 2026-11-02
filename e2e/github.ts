// End to end: GitHub through gh, and optional (GitHub build steps 1 and 2).
// GitHub off without gh, off with gh logged out, on without a restart, a
// token gh replaced, a token GitHub rejects; an issue handed to a task from
// the console, its comments and closing delivered to the task, sleep and
// catching up; and the token kept out of everything.
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
type RoutedLine = Extract<FeedLine, { type: 'routed' }>;

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
	'-c',
	'user.name=e2e',
	'-c',
	'user.email=e2e@example.com',
	'commit',
	'-q',
	'--allow-empty',
	'-m',
	'start',
]);
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
// for, and Workers that finish, wait on an issue until it's closed, or print
// what a leak would show and finish.
const kinds = new Map<string, 'off' | 'leak' | 'issue'>();
let issueHandle: string | null = null;
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
		const started = request.results
			.map((result) => result.match(/^started (\w{4})/)?.[1])
			.find(Boolean);
		if (
			started &&
			issueHandle === null &&
			request.results.some((r) => r.includes('in app on'))
		) {
			issueHandle = started;
		}
		// After a crash, a real Router doesn't repeat replies it already sent.
		if (request.fresh.includes('An earlier attempt to decide these')) {
			return { content: 'Already handled.' };
		}
		const replyTo = request.fresh.match(/REPLYTO(\d*) (\d+) (.+)/);
		if (replyTo?.[2] && replyTo[3]) {
			return {
				calls: [
					{
						name: 'reply',
						args: {
							thread: `github:acme/app#${replyTo[1] || '7'}`,
							text: replyTo[3],
							reply_to: Number(replyTo[2]),
						},
					},
				],
			};
		}
		if (request.fresh.includes('READ8')) {
			return {
				calls: [{ name: 'read_thread', args: { id: 'github:acme/app#8' } }],
			};
		}
		if (request.fresh.includes('REPLYLONG')) {
			return {
				calls: [
					{
						name: 'reply',
						args: {
							thread: 'github:acme/app#7',
							text: Array.from({ length: 301 }, () => 'word').join(' '),
						},
					},
				],
			};
		}
		const replyOn = request.fresh.match(/REPLY(\d+) (.+)/);
		if (replyOn?.[1] && replyOn[2]) {
			return {
				calls: [
					{
						name: 'reply',
						args: {
							thread: `github:acme/app#${replyOn[1]}`,
							text: replyOn[2],
							...(issueHandle ? { task: issueHandle } : {}),
						},
					},
				],
			};
		}
		if (request.fresh.includes('ISSUE fix')) {
			return {
				calls: [
					{
						name: 'start_task',
						args: {
							title: 'Fix issue 7',
							instructions: 'ISSUE-TASK: fix acme/app#7.',
							threads: ['github:acme/app#7'],
						},
					},
				],
			};
		}
		if (request.fresh.includes('ALSO10') && issueHandle !== null) {
			return {
				calls: [
					{ name: 'read_thread', args: { id: 'github:acme/app#7' } },
					{
						name: 'send_to_task',
						args: {
							handle: issueHandle,
							text: 'Also handle #10.',
							threads: ['github:acme/app#10'],
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
		kinds.set(
			handle,
			request.fresh.includes('LEAK-TASK')
				? 'leak'
				: request.fresh.includes('ISSUE-TASK')
					? 'issue'
					: 'off',
		);
	}
	if (kinds.get(handle) === 'issue') {
		// Finishes when the issue closes or its PR merges; finishing while the
		// PR is open is refused, and then it waits.
		const refused = request.results.some((result) =>
			result.includes('is still open'),
		);
		const ending =
			request.fresh.includes('was merged') ||
			request.fresh.includes('was closed by');
		if (refused || !ending) {
			return {
				content: 'Waiting.',
				calls: [{ name: 'wait_for', args: { what: 'the issue and its PR' } }],
			};
		}
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

type ThreadDetail = {
	messages: Array<{
		direction: string;
		text: string;
		delivery: string;
	}>;
};

// The daemon is trusted to send the shape it promises.
function isThreadDetail(value: unknown): value is ThreadDetail {
	return (
		typeof value === 'object' &&
		value !== null &&
		'messages' in value &&
		Array.isArray(value.messages)
	);
}

const threadDetail = async (id: string): Promise<ThreadDetail> => {
	const detail = await agent.get(`/v1/threads/${encodeURIComponent(id)}`);
	if (!isThreadDetail(detail)) throw new Error(`not a thread: ${id}`);
	return detail;
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

	// 2. An issue handed to a task from the console.
	github.openIssue('acme/app', 7, {
		title: 'Export crashes in Safari',
		body: 'ISSUE-7-BODY: exporting a report crashes Safari 18.',
		by: 'alice',
		labels: ['bug'],
	});
	github.comment('acme/app', 7, {
		by: 'bob',
		body: 'EARLY-COMMENT: same here',
	});
	github.openIssue('acme/app', 9, {
		title: 'Unrelated',
		body: 'Nobody asked the agent about this.',
		by: 'carol',
	});
	github.openIssue('acme/app', 10, {
		title: 'Export is slow',
		body: 'ISSUE-10-BODY: exports take a minute.',
		by: 'alice',
	});
	await agent.action({ type: 'send_console', text: 'ISSUE fix issue #7' });
	const issueTask = (
		await agent.waitFor(
			'the issue task',
			(line): line is TaskLine =>
				line.type === 'task' &&
				line.task.title === 'Fix issue 7' &&
				line.task.threads.some((thread) => thread.id === 'github:acme/app#7'),
		)
	).task;
	const { handle } = issueTask;
	check(
		'a console request starts a task that follows the GitHub issue',
		issueTask.threads.some(
			(thread) =>
				thread.id === 'github:acme/app#7' &&
				thread.title === 'app#7' &&
				thread.url === 'https://github.com/acme/app/issues/7',
		),
		JSON.stringify(issueTask.threads),
	);
	const workerSaw = (text: string) =>
		agent.until(
			`the Worker to see ${text}`,
			async () =>
				particle.requests.filter(
					(request) =>
						request.session === 'worker' &&
						request.handle === handle &&
						request.fresh.includes(text),
				),
			(found) => found.length > 0,
		);
	const first = (await workerSaw('ISSUE-7-BODY'))[0];
	check(
		"the Worker's first message has the issue and its comments",
		first !== undefined &&
			first.fresh.includes('EARLY-COMMENT') &&
			first.fresh.includes('labels: bug'),
	);
	const taskDetail = await agent.get(`/v1/tasks/${handle}`);
	check(
		"the task works in the issue's repository",
		JSON.stringify(taskDetail).includes('"branch":"superagent/'),
	);
	await agent.until(
		'polling of #7',
		async () => github.requests,
		(requests) =>
			requests.some((request) =>
				request.path.startsWith('/repos/acme/app/issues/7/comments?since='),
			),
	);

	const routed = (marker: string) =>
		agent.waitFor(
			`${marker} routed`,
			(line): line is RoutedLine =>
				line.type === 'routed' && line.event.preview.includes(marker),
		);
	github.comment('acme/app', 7, { by: 'alice', body: 'LATER-COMMENT (C1)' });
	const c1 = await routed('C1');
	check(
		"a comment on the followed issue goes straight to the task's Worker",
		c1.event.destination.kind === 'task' &&
			c1.event.destination.handle === handle,
		JSON.stringify(c1.event.destination),
	);
	await workerSaw('LATER-COMMENT');
	github.comment('acme/app', 7, {
		by: 'shlok',
		body: 'Posted by the agent (C2)\n\n<!-- superagent m1 -->',
	});
	const c2 = await routed('C2');
	check(
		"the agent's own comment, by its marker, is filtered",
		c2.event.destination.kind === 'filtered' &&
			c2.event.destination.reason === 'own message',
		JSON.stringify(c2.event.destination),
	);
	github.comment('acme/app', 7, {
		by: 'bugbot',
		body: 'BOT-REVIEW (C3)',
		bot: true,
	});
	await workerSaw('bugbot (bot)');
	check("a bot's comment reaches the task, marked as a bot", true);

	// Another issue handed to the running task.
	await agent.action({ type: 'send_console', text: 'ALSO10 take #10 too' });
	await workerSaw('ISSUE-10-BODY');
	check('send_to_task hands the task another issue', true);
	const threadRead = particle.requests
		.filter((request) => request.session === 'router')
		.flatMap((request) => request.results)
		.find((result) => result.startsWith('thread github:acme/app#7'));
	check(
		"read_thread shows the issue's last polled state",
		(threadRead ?? '').includes(
			'GitHub issue · open · "Export crashes in Safari" · as of',
		),
		threadRead?.split('\n')[2] ?? 'no read_thread',
	);

	// 3. Replies out: signed, marked, delivered, and recognized when they come back.
	const commentsWith = (n: number, text: string) =>
		github
			.comments('acme/app', n)
			.filter((comment) => comment.body.includes(text));
	const postsWith = (n: number, text: string) =>
		github.requests.filter(
			(request) =>
				request.method === 'POST' &&
				request.path === `/repos/acme/app/issues/${n}/comments` &&
				request.body.includes(text),
		);
	const delivery = async (n: number, text: string) => {
		const found = await agent.until(
			`the reply ${text} to settle`,
			async () => threadDetail(`github:acme/app#${n}`),
			(detail) =>
				detail.messages.some(
					(message) =>
						message.direction === 'out' &&
						message.text.includes(text) &&
						message.delivery !== 'pending',
				),
		);
		return found.messages.find((message) => message.text.includes(text))
			?.delivery;
	};
	await agent.action({
		type: 'send_console',
		text: 'REPLY7 R1 Working on it.',
	});
	check(
		'a Router reply on GitHub is delivered',
		(await delivery(7, 'R1 Working on it.')) === 'delivered',
	);
	const r1 = commentsWith(7, 'R1 Working on it.');
	check(
		'it is posted once, signed, with the hidden marker',
		r1.length === 1 &&
			(r1[0]?.body ?? '').includes(
				`<sub>Posted by superagent for @shlok · task ${handle}</sub>`,
			) &&
			/<!-- superagent m\d+ -->$/.test(r1[0]?.body ?? ''),
		r1[0]?.body.split('\n').slice(-2).join(' | ') ?? 'not posted',
	);
	const r1Back = await agent.waitFor(
		'R1 polled back',
		(line): line is RoutedLine =>
			line.type === 'routed' &&
			line.event.channel === 'github' &&
			line.event.preview.startsWith('R1 Working'),
	);
	check(
		'when polling brings it back, it is filtered as the agent’s own',
		r1Back.event.destination.kind === 'filtered' &&
			r1Back.event.destination.reason === 'own message',
	);

	await agent.action({
		type: 'send_console',
		text: `REPLYTO ${c1.event.id} R2 Thanks, that's fixed now.`,
	});
	await delivery(7, 'R2 Thanks');
	check(
		'reply_to on a comment quotes it',
		(commentsWith(7, 'R2 Thanks')[0]?.body ?? '').startsWith(
			'> **@alice**:\n> LATER-COMMENT (C1)',
		),
	);

	await agent.action({ type: 'send_console', text: 'REPLYLONG please' });
	await agent.until(
		'the long reply to be refused',
		async () =>
			particle.requests
				.filter((request) => request.session === 'router')
				.flatMap((request) => request.results),
		(results) => results.some((result) => result.includes('at most 300')),
	);
	check('a GitHub reply over 300 words is refused', true);

	github.failNextWrites(1, 502);
	await agent.action({ type: 'send_console', text: 'REPLY7 R3 Retried.' });
	check(
		'a reply that hit a 502 is retried and delivered',
		(await delivery(7, 'R3 Retried.')) === 'delivered',
	);
	check(
		'after checking for its marker, it is posted only once',
		commentsWith(7, 'R3 Retried.').length === 1 &&
			postsWith(7, 'R3 Retried.').length === 2,
		`${postsWith(7, 'R3 Retried.').length} posts`,
	);

	github.lockIssue('acme/app', 10);
	await agent.action({ type: 'send_console', text: 'REPLY10 R4 Locked out.' });
	check(
		'a reply GitHub refuses for good fails',
		(await delivery(10, 'R4 Locked out.')) === 'failed',
	);
	const undelivered = await agent.until(
		'the undelivered problem',
		async () => latestHealth(),
		(value) =>
			value?.problems.some((problem) =>
				problem.id.startsWith('undelivered:'),
			) ?? false,
	);
	check(
		'it is a problem saying why',
		undelivered?.problems.some((problem) =>
			problem.text.startsWith(
				"Couldn't comment on app#10: GitHub answered 422 to POST /repos/acme/app/issues/10/comments: Unable to create comment because issue is locked.",
			),
		) ?? false,
		undelivered?.problems.find((problem) =>
			problem.id.startsWith('undelivered:'),
		)?.text,
	);

	// 7. Asleep: comments posted meanwhile arrive once each, in order, labeled late.
	const beforeSleep = agent.lines.length;
	agent.signal('SIGSTOP');
	for (const n of [1, 2, 3]) {
		github.comment('acme/app', 7, {
			by: 'alice',
			body: `LATE-${n} while you slept`,
			postedAgoMs: 10 * 60_000,
		});
	}
	await Bun.sleep(1_500);
	agent.signal('SIGCONT');
	await routed('LATE-3');
	const late = agent.lines
		.filter(
			(line): line is RoutedLine =>
				line.type === 'routed' && line.event.preview.startsWith('LATE-'),
		)
		.map((line) => line.event.preview.slice(0, 6));
	check(
		'comments posted while asleep arrive once each, in order',
		late.join(',') === 'LATE-1,LATE-2,LATE-3',
		late.join(','),
	);
	const lateMessage = await workerSaw('LATE-3');
	check(
		'they are labeled as late',
		lateMessage.some((request) =>
			request.fresh.includes('(the agent was asleep or offline)'),
		),
	);
	check(
		'waking up shows GitHub catching up',
		agent.lines
			.slice(beforeSleep)
			.some(
				(line) =>
					line.type === 'health' &&
					githubChannel(line.health)?.detail === 'catching up after sleep',
			),
	);

	// 8. A crash mid-delivery: the comment lands, the daemon dies before it
	// hears so, and on restart it finds its marker instead of posting again.
	const held = github.holdNextWrite();
	await agent.action({
		type: 'send_console',
		text: 'REPLY7 R5 Posted across a crash.',
	});
	await held.arrived;
	await agent.crash();
	held.release();
	await agent.until(
		'the held comment to land',
		async () => commentsWith(7, 'R5 Posted across a crash.'),
		(found) => found.length === 1,
	);
	await agent.restart();
	check(
		'after the restart, the reply is marked delivered',
		(await delivery(7, 'R5 Posted across a crash.')) === 'delivered',
	);
	await Bun.sleep(500);
	check(
		'and it was posted exactly once',
		commentsWith(7, 'R5 Posted across a crash.').length === 1 &&
			postsWith(7, 'R5 Posted across a crash.').length === 1,
		`${commentsWith(7, 'R5 Posted across a crash.').length} comments, ${postsWith(7, 'R5 Posted across a crash.').length} posts`,
	);

	// 4. The task's PR: found by its branch, signed, and followed.
	github.openPr('acme/app', 8, {
		title: 'Fix the Safari export',
		body: 'Fixes #7.',
		by: 'shlok',
		head: `superagent/${handle}`,
	});
	github.openPr('acme/app', 11, {
		title: 'Not the agent’s',
		body: 'From another branch.',
		by: 'carol',
		head: 'carol/other',
	});
	await workerSaw('You now follow github:acme/app#8');
	check(
		"the daemon finds the task's PR by its branch and tells the Worker",
		true,
	);
	const withPr = await agent.waitFor(
		'the task to follow its PR',
		(line): line is TaskLine =>
			line.type === 'task' &&
			line.task.handle === handle &&
			line.task.threads.some((followed) => followed.id === 'github:acme/app#8'),
	);
	check(
		'the PR is one of the task’s threads',
		withPr.task.threads.some(
			(followed) =>
				followed.title === 'app#8' &&
				followed.url === 'https://github.com/acme/app/pull/8',
		),
		JSON.stringify(withPr.task.threads.map((followed) => followed.title)),
	);
	const signed = await agent.until(
		'the PR to be signed',
		async () => github.prBody('acme/app', 8),
		(body) => body.includes('<!-- superagent t'),
	);
	check(
		'the PR body gains the sign-off and marker, after what the Worker wrote',
		signed.startsWith('Fixes #7.\n\n') &&
			signed.includes(
				`<sub>Posted by superagent for @shlok · task ${handle}</sub>`,
			),
		signed.split('\n').at(-2) ?? '',
	);
	check(
		'a PR from another branch is never followed',
		!github.requests.some((request) =>
			request.path.startsWith('/repos/acme/app/pulls/11'),
		),
	);

	// 5. Review comments, reviews, and a reply in a review thread.
	const reviewCommentId = github.reviewComment('acme/app', 8, {
		by: 'shlok',
		body: 'RC1 rename this',
		path: 'src/export.ts',
		line: 42,
	});
	const rc1 = await routed('RC1');
	check(
		"a review comment goes straight to the task's Worker, with its line",
		rc1.event.destination.kind === 'task' &&
			rc1.event.destination.handle === handle &&
			rc1.event.preview.startsWith('src/export.ts:42: RC1'),
		rc1.event.preview,
	);
	github.review('acme/app', 8, {
		by: 'bugbot',
		bot: true,
		state: 'COMMENTED',
		body: 'RV1 possible null dereference',
	});
	const botReview = await workerSaw('Review (commented): RV1');
	check(
		"a bot's review reaches the task, marked as a bot",
		botReview.some((request) => request.fresh.includes('bugbot (bot)')),
	);
	github.review('acme/app', 8, { by: 'alice', state: 'APPROVED' });
	await workerSaw('alice approved #8');
	check('an approval without a body is an activity for the task', true);

	await agent.action({
		type: 'send_console',
		text: `REPLYTO8 ${rc1.event.id} RR1 Renamed it.`,
	});
	check(
		'reply_to on a review comment is delivered',
		(await delivery(8, 'RR1 Renamed it.')) === 'delivered',
	);
	const threaded = github
		.reviewComments('acme/app', 8)
		.filter((comment) => comment.body.includes('RR1 Renamed it.'));
	check(
		'it is posted once, in that review thread, signed and marked',
		threaded.length === 1 &&
			threaded[0]?.inReplyTo === reviewCommentId &&
			/<!-- superagent m\d+ -->$/.test(threaded[0]?.body ?? ''),
		JSON.stringify(threaded.map((comment) => comment.inReplyTo)),
	);
	const rr1Back = await agent.waitFor(
		'RR1 polled back',
		(line): line is RoutedLine =>
			line.type === 'routed' &&
			line.event.channel === 'github' &&
			line.event.preview.includes('RR1 Renamed'),
	);
	check(
		'it comes back as a review comment and is filtered as the agent’s own',
		rr1Back.event.destination.kind === 'filtered' &&
			rr1Back.event.destination.reason === 'own message',
	);
	await agent.action({ type: 'send_console', text: 'READ8 please' });
	const prRead = await agent.until(
		'read_thread on the PR',
		async () =>
			particle.requests
				.filter((request) => request.session === 'router')
				.flatMap((request) => request.results)
				.find((result) => result.startsWith('thread github:acme/app#8')),
		(result) => result !== undefined,
	);
	check(
		"read_thread shows the PR's state and reviews",
		(prRead ?? '').includes('GitHub PR · open · "Fix the Safari export"') &&
			(prRead ?? '').includes('reviews: alice approved'),
		prRead?.split('\n')[2] ?? '',
	);

	// Closing the issue doesn't end the task while its PR is open; the merge does.
	github.closeIssue('acme/app', 7, 'alice');
	await agent.until(
		'finishing to be refused',
		async () =>
			particle.requests
				.filter(
					(request) =>
						request.session === 'worker' && request.handle === handle,
				)
				.flatMap((request) => request.results),
		(results) => results.some((result) => result.includes('is still open')),
	);
	check("a task can't finish while its PR is open", true);
	github.merge('acme/app', 8, 'shlok');
	await workerSaw('#8 was merged by shlok');
	await taskDone('Fix issue 7');
	check('the merge reaches the task, which then finishes', true);
	const timeline = await agent.get(
		`/v1/threads/${encodeURIComponent('github:acme/app#7')}`,
	);
	check(
		"closing reaches the task and is in the thread's timeline",
		JSON.stringify(timeline).includes('#7 was closed by alice'),
	);
	const polls = () =>
		github.requests.filter(
			(request) =>
				request.path.startsWith('/repos/acme/app/issues/7') ||
				request.path.startsWith('/repos/acme/app/issues/8') ||
				request.path.startsWith('/repos/acme/app/pulls/8'),
		).length;
	await Bun.sleep(500);
	const settled = polls();
	await Bun.sleep(1_000);
	check(
		'after the task ends, its issue and PR are no longer polled',
		polls() === settled,
		`${polls() - settled} more requests`,
	);
	check(
		'an issue no task follows is never requested',
		!github.requests.some((request) =>
			request.path.startsWith('/repos/acme/app/issues/9'),
		),
	);

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
			'commands run gh so it never prompts or writes its update check',
			results.some(
				(result) =>
					result.includes('GH_PROMPT_DISABLED=1') &&
					result.includes('GH_NO_UPDATE_NOTIFIER=1'),
			),
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
