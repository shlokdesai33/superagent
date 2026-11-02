import type {
	FeedLine,
	Health,
	Message,
	Problem,
	RoutedEvent,
	RouterState,
	Snapshot,
	Step,
	TaskSummary,
	Usage,
} from '../protocol.ts';

const CONSOLE_KEPT = 200;
const PER_TASK_KEPT = 1000;

/** The latest state, built from the feed. */
export type Live = {
	agent: Snapshot['agent'];
	day: Snapshot['day'];
	tasks: Map<string, TaskSummary>;
	console: Message[];
	router: RouterState;
	usage: Usage;
	health: Health;
	/** Steps and messages from the feed, by task, with the `seq` they came at. */
	steps: Map<string, Map<number, { step: Step; seq: number }>>;
	messages: Map<string, Map<number, { message: Message; seq: number }>>;
	seq: number;
	/** When the last line arrived. */
	receivedAt: number;
};

export type Connection =
	| { state: 'connecting' }
	| { state: 'live'; generation: number }
	| { state: 'offline'; detail: string; since: number }
	| {
			state: 'rejected';
			message: string;
			detail: string;
	  };

export type Model = {
	connection: Connection;
	live: Live | null;
};

/** What a line changed, for motion. */
export type Applied =
	| { kind: 'snapshot' }
	| { kind: 'task'; before: TaskSummary | null; after: TaskSummary }
	| { kind: 'routed'; event: RoutedEvent }
	| { kind: 'other' };

export function fromSnapshot(
	snapshot: Snapshot,
	seq: number,
	now: number,
): Live {
	const live: Live = {
		agent: snapshot.agent,
		day: snapshot.day,
		tasks: new Map(snapshot.tasks.map((task) => [task.handle, task])),
		console: snapshot.console,
		router: snapshot.router,
		usage: snapshot.usage,
		health: snapshot.health,
		steps: new Map(),
		messages: new Map(),
		seq,
		receivedAt: now,
	};
	for (const message of snapshot.console) keepMessage(live, message, seq);
	return live;
}

/** Applies one update in place. */
export function apply(live: Live, line: FeedLine, now: number): Applied {
	live.receivedAt = now;
	if (line.type === 'ping' || line.type === 'snapshot')
		return { kind: 'other' };
	live.seq = line.seq;
	switch (line.type) {
		case 'task': {
			const before = live.tasks.get(line.task.handle) ?? null;
			live.tasks.set(line.task.handle, line.task);
			return { kind: 'task', before, after: line.task };
		}
		case 'step': {
			let steps = live.steps.get(line.taskHandle);
			if (!steps) {
				steps = new Map();
				live.steps.set(line.taskHandle, steps);
			}
			steps.set(line.step.id, { step: line.step, seq: line.seq });
			trimMap(steps, PER_TASK_KEPT);
			return { kind: 'other' };
		}
		case 'message': {
			const { message } = line;
			if (message.threadId === 'console') {
				const index = live.console.findIndex((m) => m.id === message.id);
				if (index === -1) live.console.push(message);
				else live.console[index] = message;
				if (live.console.length > CONSOLE_KEPT) {
					live.console.splice(0, live.console.length - CONSOLE_KEPT);
				}
			}
			keepMessage(live, message, line.seq);
			return { kind: 'other' };
		}
		case 'routed':
			return { kind: 'routed', event: line.event };
		case 'router':
			live.router = line.router;
			return { kind: 'other' };
		case 'usage':
			live.usage = line.usage;
			return { kind: 'other' };
		case 'health':
			live.health = line.health;
			return { kind: 'other' };
	}
}

/** Keeps a message for the task it's tied to and every task following its thread. */
function keepMessage(live: Live, message: Message, seq: number): void {
	const handles = new Set<string>();
	if (message.taskHandle !== null) handles.add(message.taskHandle);
	if (message.threadId !== null && message.threadId !== 'console') {
		for (const task of live.tasks.values()) {
			if (task.threads.some((thread) => thread.id === message.threadId)) {
				handles.add(task.handle);
			}
		}
	}
	for (const handle of handles) {
		let messages = live.messages.get(handle);
		if (!messages) {
			messages = new Map();
			live.messages.set(handle, messages);
		}
		messages.set(message.id, { message, seq });
		trimMap(messages, PER_TASK_KEPT);
	}
}

function trimMap<K, V>(map: Map<K, V>, keep: number): void {
	for (const key of map.keys()) {
		if (map.size <= keep) break;
		map.delete(key);
	}
}

export type Section = 'needs' | 'working' | 'done';

/** Where a task shows on the home screen, or `null` when it doesn't. */
export function sectionOf(task: TaskSummary, dayStart: number): Section | null {
	switch (task.status) {
		case 'needs_you':
			return 'needs';
		case 'failed':
			return task.dismissed ? doneToday(task, dayStart) : 'needs';
		case 'working':
		case 'waiting':
			return 'working';
		case 'done':
		case 'stopped':
			return doneToday(task, dayStart);
	}
}

function doneToday(task: TaskSummary, dayStart: number): Section | null {
	return (task.endedAt ?? task.createdAt) >= dayStart ? 'done' : null;
}

export type Sections = {
	problems: Problem[];
	failed: TaskSummary[];
	needs: TaskSummary[];
	working: TaskSummary[];
	done: TaskSummary[];
};

export function sections(live: Live): Sections {
	const failed: TaskSummary[] = [];
	const needs: TaskSummary[] = [];
	const working: TaskSummary[] = [];
	const done: TaskSummary[] = [];
	for (const task of live.tasks.values()) {
		const section = sectionOf(task, live.day.start);
		if (section === 'needs') {
			(task.status === 'failed' ? failed : needs).push(task);
		} else if (section === 'working') working.push(task);
		else if (section === 'done') done.push(task);
	}
	failed.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
	needs.sort((a, b) => (a.question?.askedAt ?? 0) - (b.question?.askedAt ?? 0));
	working.sort((a, b) => a.createdAt - b.createdAt);
	done.sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
	return {
		problems: live.health.problems.toSorted((a, b) => a.since - b.since),
		failed,
		needs,
		working,
		done,
	};
}

/** The section a task's row is in, and its index there. */
export function placeOf(
	live: Live,
	task: TaskSummary,
): { section: Section; index: number } | null {
	const section = sectionOf(task, live.day.start);
	if (section === null) return null;
	const all = sections(live);
	const list =
		section === 'needs'
			? [...all.failed, ...all.needs]
			: section === 'working'
				? all.working
				: all.done;
	return {
		section,
		index: Math.max(
			0,
			list.findIndex((t) => t.handle === task.handle),
		),
	};
}

export type Item =
	| { key: string; kind: 'problem'; problem: Problem }
	| { key: string; kind: 'task'; task: TaskSummary }
	/** DONE TODAY's `+ N more` row, for the rows it hides. */
	| { key: string; kind: 'more'; hidden: number };

export const MORE_KEY = 'more:done';

/**
 * The home screen's selectable items, top to bottom. `doneShown`: how many
 * DONE TODAY rows home shows before its `+ N more` row; `null` for all.
 */
export function homeItems(live: Live, doneShown: number | null): Item[] {
	const all = sections(live);
	const done =
		doneShown === null ? all.done : all.done.slice(0, Math.max(1, doneShown));
	const hidden = all.done.length - done.length;
	return [
		...all.problems.map((problem): Item => ({
			key: `problem:${problem.id}`,
			kind: 'problem',
			problem,
		})),
		...[...all.failed, ...all.needs, ...all.working].map(taskItem),
		...done.map(taskItem),
		...(hidden > 0
			? [{ key: MORE_KEY, kind: 'more', hidden } satisfies Item]
			: []),
	];
}

function taskItem(task: TaskSummary): Item {
	return { key: `task:${task.handle}`, kind: 'task', task };
}

export function workingCount(live: Live): number {
	let count = 0;
	for (const task of live.tasks.values())
		if (task.status === 'working') count += 1;
	return count;
}

/** Problems in the header: health problems plus failed tasks not dismissed. */
export function problemCount(live: Live): number {
	let count = live.health.problems.length;
	for (const task of live.tasks.values()) {
		if (task.status === 'failed' && !task.dismissed) count += 1;
	}
	return count;
}

export function needsCount(live: Live): number {
	let count = 0;
	for (const task of live.tasks.values())
		if (task.status === 'needs_you') count += 1;
	return count;
}

/** Tasks `ctrl-x ctrl-x` can stop; on a failed task it dismisses. */
/** What `o` opens in a task view: its PR, else the last thread it follows with a link. */
export function linkOf(
	task: TaskSummary,
): { title: string; url: string } | null {
	const linked = task.threads.flatMap((thread) =>
		thread.url === null ? [] : [{ title: thread.title, url: thread.url }],
	);
	return (
		linked.findLast((thread) => thread.url.includes('/pull/')) ??
		linked.at(-1) ??
		null
	);
}

export function stoppable(task: TaskSummary): boolean {
	return (
		task.status === 'working' ||
		task.status === 'waiting' ||
		task.status === 'needs_you' ||
		(task.status === 'failed' && !task.dismissed)
	);
}
