// End to end: thread ownership, direct delivery, filtering, release and
// reopen, a question answered on a thread (build step 5), and cleanup of an
// old task's temp folder. Run with `bun run e2e`; it exits non-zero if a
// check fails.
import { Database } from 'bun:sqlite';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedLine, RoutedEvent, TaskSummary } from '../src/protocol.ts';
import { startFakeParticle } from './fake-particle.ts';
import { type ScriptEvent, startAgent } from './harness.ts';

const SUPPORT = 'script:support/77';
const GENERAL = 'script:general/1';

type RoutedLine = Extract<FeedLine, { type: 'routed' }>;
type TaskLine = Extract<FeedLine, { type: 'task' }>;
type HealthLine = Extract<FeedLine, { type: 'health' }>;
type ThreadDetail = {
	thread: { owner: string | null; followedBy: string[] };
	messages: Array<{ author: string; direction: string; text: string }>;
};

// The fake models: a Router that starts one task for the support thread and
// replies on threads, and a Worker that asks, releases, waits and finishes.
const particle = startFakeParticle((request) => {
	if (request.session === 'compaction') return { content: 'Summary.' };
	if (request.session === 'router') {
		// Everything in one call is handled together: events can arrive
		// alongside tool results.
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const started = request.results
			.map((result) => result.match(/^started (\w{4})/)?.[1])
			.find(Boolean);
		if (started) {
			calls.push({
				name: 'reply',
				args: { thread: SUPPORT, text: `On it as ${started}.` },
			});
		}
		if (request.fresh.includes('please fix the export')) {
			calls.push({
				name: 'start_task',
				args: {
					title: 'Fix the export',
					instructions: 'Fix the export bug reported on the support thread.',
					threads: [SUPPORT],
					repo: 'none',
				},
			});
		}
		const asked = request.fresh.match(/task \w{4} asked · [^\n]*\n\s*(.*)/);
		if (asked) {
			calls.push({
				name: 'reply',
				args: { thread: SUPPORT, text: `The task asks: ${asked[1]}` },
			});
		}
		if (request.fresh.includes('hello agent')) {
			calls.push({ name: 'reply', args: { thread: GENERAL, text: 'Hello!' } });
		}
		return calls.length > 0 ? { calls } : { content: 'Nothing to say.' };
	}

	const { called, fresh } = request;
	if (!called.includes('ask')) {
		return {
			content: 'I need to know the browser.',
			calls: [
				{ name: 'ask', args: { question: 'Which browser shows the bug?' } },
			],
		};
	}
	if (fresh.includes('Safari') && !called.includes('release_thread')) {
		return {
			content: 'Safari it is. Handing the thread back while I work.',
			calls: [
				{ name: 'release_thread', args: { thread: SUPPORT } },
				{ name: 'wait_for', args: { what: 'a note from the operator' } },
			],
		};
	}
	if (fresh.includes('one more thing')) {
		return {
			content: 'Reopened; watching the thread again.',
			calls: [{ name: 'wait_for', args: { what: 'the thread' } }],
		};
	}
	return {
		content: 'Wrapping up.',
		calls: [{ name: 'finish', args: { result: 'Fixed the export in Safari' } }],
	};
});

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (!ok) failures += 1;
	process.stdout.write(
		`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}\n`,
	);
}

function where(destination: RoutedEvent['destination']): string {
	return destination.kind === 'task'
		? `task ${destination.handle}`
		: destination.kind === 'filtered'
			? `filtered: ${destination.reason}`
			: 'router';
}

// The daemon is trusted to send the shape it promises.
function isThreadDetail(value: unknown): value is ThreadDetail {
	return (
		typeof value === 'object' &&
		value !== null &&
		'thread' in value &&
		'messages' in value &&
		Array.isArray(value.messages)
	);
}

let counter = 0;
function scriptEvent(
	key: string,
	author: string,
	text: string,
	options: {
		mentions?: boolean;
		bot?: boolean;
		self?: boolean;
		id?: string;
	} = {},
): ScriptEvent {
	return {
		externalId: options.id ?? `evt-${++counter}`,
		thread: {
			key,
			title: key === 'support/77' ? '#support' : '#general',
			url: null,
		},
		author: {
			id: `u-${author}`,
			name: author,
			isBot: options.bot ?? false,
			isSelf: options.self ?? false,
		},
		text,
		mentionsAgent: options.mentions ?? false,
	};
}

const agent = await startAgent(particle.url);

const routed = (id: string) =>
	agent.waitFor(
		`event ${id} routed`,
		(line): line is RoutedLine =>
			line.type === 'routed' && line.event.preview.includes(id),
	);
const taskLine = async (match: (task: TaskSummary) => boolean) =>
	(
		await agent.waitFor(
			'a task line',
			(line): line is TaskLine => line.type === 'task' && match(line.task),
		)
	).task;
const thread = async (id: string): Promise<ThreadDetail> => {
	const detail = await agent.get(`/v1/threads/${encodeURIComponent(id)}`);
	if (!isThreadDetail(detail)) throw new Error(`not a thread: ${id}`);
	return detail;
};
const routerSaw = (text: string) =>
	particle.requests.some(
		(request) => request.session === 'router' && request.fresh.includes(text),
	);

try {
	// 1. An unowned, addressed message goes to the Router, which starts a task
	//    that owns the thread.
	await agent.event(
		scriptEvent(
			'support/77',
			'alice',
			'@superagent please fix the export (E1)',
			{
				mentions: true,
			},
		),
	);
	const e1 = await routed('E1');
	check(
		'an unowned, addressed event goes to the Router',
		e1.event.destination.kind === 'router',
		where(e1.event.destination),
	);
	const asking = await taskLine((task) => task.status === 'needs_you');
	const { handle } = asking;
	check(
		'the task it starts follows the thread',
		asking.threads.some((followed) => followed.id === SUPPORT),
		`task ${handle}`,
	);
	check(
		"the task's origin is the thread",
		asking.origin.place === '#support' && asking.origin.author === 'alice',
		JSON.stringify(asking.origin),
	);
	const owned = await agent.until(
		'the Router to relay the question',
		() => thread(SUPPORT),
		(detail) => detail.messages.some((m) => m.text.startsWith('The task asks')),
	);
	const replies = owned.messages
		.filter((message) => message.direction === 'out')
		.map((message) => message.text)
		.join(' | ');
	check('the task owns the thread', owned.thread.owner === handle);
	check(
		'the Router replied on the thread and relayed the question',
		replies ===
			`On it as ${handle}. | The task asks: Which browser shows the bug?`,
		replies,
	);

	// 2. A message on the owned thread goes straight to the Worker, even
	//    unaddressed, and answers its open question.
	await agent.event(scriptEvent('support/77', 'bob', 'Safari 18 (E2)'));
	const e2 = await routed('E2');
	check(
		'an event on an owned thread goes straight to its Worker',
		e2.event.destination.kind === 'task' &&
			e2.event.destination.handle === handle,
		where(e2.event.destination),
	);
	const answered = await taskLine(
		(task) => task.handle === handle && task.status !== 'needs_you',
	);
	check(
		'the message on the thread answered the open question',
		answered.question === null,
		`status ${answered.status}`,
	);
	const again = await agent.action({
		type: 'answer_question',
		handle,
		questionId: asking.question?.id ?? 0,
		text: 'Chrome',
	});
	check(
		'answering again shows who answered on the thread',
		!again.ok && (again.detail ?? '').startsWith('bob answered in script'),
		again.ok ? 'ok' : (again.detail ?? ''),
	);

	// 3. The Worker releases the thread, which goes back to the Router.
	const released = await agent.until(
		'the thread to be released',
		() => thread(SUPPORT),
		(detail) => detail.thread.owner === null,
	);
	check(
		'release_thread hands the thread back',
		released.thread.owner === null &&
			released.thread.followedBy.includes(handle),
	);
	check('the Router never saw the owned message', !routerSaw('(E2)'));
	await agent.event(
		scriptEvent('support/77', 'alice', '@superagent any update? (E3)', {
			mentions: true,
		}),
	);
	const e3 = await routed('E3');
	check(
		"after the release, the thread's messages go to the Router",
		e3.event.destination.kind === 'router',
		where(e3.event.destination),
	);

	// 4. The Fast Path filter, the agent's own message, and a duplicate.
	await agent.event(
		scriptEvent('general/1', 'ci-bot', '@superagent build failed (E4)', {
			mentions: true,
			bot: true,
		}),
	);
	await agent.event(
		scriptEvent('general/1', 'carol', 'lunch anyone? (E5)', {
			id: 'evt-lunch',
		}),
	);
	await agent.event(
		scriptEvent('general/1', 'superagent', 'Hello! (E6)', {
			self: true,
			mentions: true,
		}),
	);
	const duplicate = await agent.event(
		scriptEvent('general/1', 'carol', 'lunch anyone? (E5)', {
			id: 'evt-lunch',
		}),
	);
	await agent.event(
		scriptEvent('general/1', 'dave', '@superagent hello agent (E7)', {
			mentions: true,
		}),
	);
	const filtered = [
		['E4', 'bot message'],
		['E5', 'not addressed to the agent'],
		['E6', 'own message'],
	] as const;
	const filteredLines = await Promise.all(filtered.map(([id]) => routed(id)));
	for (const [index, [id, reason]] of filtered.entries()) {
		const destination = filteredLines[index]?.event.destination;
		check(
			`${id} is filtered: ${reason}`,
			destination?.kind === 'filtered' && destination.reason === reason,
			destination ? where(destination) : 'no line',
		);
	}
	check(
		'a repeated externalId is ignored',
		duplicate.duplicate &&
			agent.lines.filter(
				(line) => line.type === 'routed' && line.event.preview.includes('E5'),
			).length === 1,
	);
	const e7 = await routed('E7');
	check(
		'an addressed message on another thread goes to the Router',
		e7.event.destination.kind === 'router',
		where(e7.event.destination),
	);
	const general = await agent.until(
		'the reply on #general',
		() => thread(GENERAL),
		(detail) => detail.messages.some((m) => m.direction === 'out'),
	);
	check(
		'the Router replied on that thread',
		general.messages.at(-1)?.text === 'Hello!',
		general.messages.map((m) => `${m.author}: ${m.text}`).join(' | '),
	);

	// 5. Finish, then reopen: the task takes back its former thread.
	await agent.action({ type: 'send_note', handle, text: 'wrap up' });
	const done = await taskLine(
		(task) => task.handle === handle && task.status === 'done',
	);
	check(
		'the task finished and the thread stays with the Router',
		(await thread(SUPPORT)).thread.owner === null,
		done.result ?? '',
	);
	const reopen = await agent.action({
		type: 'send_note',
		handle,
		text: 'one more thing',
	});
	check(
		'a note reopens the task',
		reopen.ok && reopen.detail === 'it reopens',
		reopen.detail ?? '',
	);
	const reclaimed = await agent.until(
		'the thread to be taken back',
		() => thread(SUPPORT),
		(detail) => detail.thread.owner === handle,
	);
	check(
		'reopening takes back its former thread',
		reclaimed.thread.owner === handle,
	);
	await agent.event(scriptEvent('support/77', 'bob', 'also in Firefox (E8)'));
	const e8 = await routed('E8');
	check(
		"the taken-back thread's messages go straight to the Worker",
		e8.event.destination.kind === 'task' &&
			e8.event.destination.handle === handle,
		where(e8.event.destination),
	);

	const health = await agent.waitFor(
		'the script channel in health',
		(line): line is HealthLine =>
			line.type === 'health' &&
			line.health.channels.some(
				(channel) => channel.name === 'script' && channel.lastEventAt !== null,
			),
	);
	check(
		'health shows the script channel up',
		health.health.channels.some(
			(channel) => channel.name === 'script' && channel.state === 'up',
		),
	);

	// 6. Cleanup: a task that ended over 7 days ago loses its temp folder.
	const tmp = join(agent.home, 'tasks', handle, 'tmp');
	check('a task has its own temp folder', existsSync(tmp));
	// It may have finished already; either way it has ended.
	const stopped = await agent.action({ type: 'stop_task', handle });
	check(
		'the task has ended',
		stopped.ok || stopped.code === 'not_running',
		stopped.ok ? stopped.subject : stopped.code,
	);
	await agent.crash();
	const db = new Database(join(agent.home, 'state.db'));
	db.run('UPDATE tasks SET ended_at = ? WHERE handle = ?', [
		Date.now() - 8 * 24 * 60 * 60_000,
		handle,
	]);
	db.close();
	await agent.restart();
	await agent.until(
		"the old task's temp folder to be removed",
		async () => existsSync(tmp),
		(exists) => !exists,
	);
	check('cleanup removes the temp folder of a task ended 8 days ago', true);
} catch (error) {
	failures += 1;
	process.stdout.write(
		`✗ ${error instanceof Error ? error.message : String(error)}\n`,
	);
} finally {
	await agent.stop();
	particle.stop();
}

process.stdout.write(
	failures === 0 ? '\nAll checks passed.\n' : `\n${failures} failed.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
