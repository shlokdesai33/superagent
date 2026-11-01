import type { Database } from 'bun:sqlite';
import type { Question, Step, TaskSummary } from '../protocol.ts';
import { type Daemon, dayStart } from './state.ts';

const MERGE_TASK_UPDATES_MS = 100;
const ENDED_TODAY_SHOWN = 200;
const ACTIVITY_MINUTES = 8;
const MINUTE_MS = 60_000;

export type TaskRow = {
	id: number;
	handle: string;
	title: string;
	state: 'active' | 'needs_you' | 'done' | 'failed' | 'stopped';
	waitingOn: string | null;
	workDir: string;
	repo: string | null;
	branch: string | null;
	report: string | null;
	originChannel: string | null;
	originThreadTitle: string | null;
	originOwnable: number | null;
	originAuthor: string | null;
	result: string | null;
	failure: string | null;
	dismissed: number;
	modelCalls: number;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
};

export const TASK_COLUMNS = `t.id, t.handle, t.title, t.state, t.waiting_on AS waitingOn,
	t.work_dir AS workDir, t.repo, t.branch, t.report, e.channel AS originChannel,
	th.title AS originThreadTitle, th.ownable AS originOwnable, e.author AS originAuthor,
	t.result, t.failure, t.dismissed, t.model_calls AS modelCalls, t.created_at AS createdAt,
	t.started_at AS startedAt, t.ended_at AS endedAt
	FROM tasks t
	LEFT JOIN events e ON e.id = t.origin_event_id
	LEFT JOIN threads th ON th.id = e.thread_id`;

export function taskRow(db: Database, id: number): TaskRow | null {
	return db
		.query<TaskRow, [number]>(`SELECT ${TASK_COLUMNS} WHERE t.id = ?`)
		.get(id);
}

export function taskByHandle(db: Database, handle: string): TaskRow | null {
	return db
		.query<TaskRow, [string]>(`SELECT ${TASK_COLUMNS} WHERE t.handle = ?`)
		.get(handle.trim().replace(/^@/, '').toLowerCase());
}

/** Whether the task has a model call or a command running right now. */
export function isWorking(daemon: Daemon, taskId: number): boolean {
	if ((daemon.workers.get(taskId)?.callSince ?? null) !== null) return true;
	for (const command of daemon.commands.values()) {
		if (command.taskId === taskId) return true;
	}
	return false;
}

/**
 * Tasks with a slot: a turn in progress, or a command still running. A task
 * holds its slot while a model call or command of its own runs.
 */
export function workingTasks(daemon: Daemon): number {
	const ids = new Set<number>();
	for (const live of daemon.workers.values()) {
		if (live.turn) ids.add(live.taskId);
	}
	for (const command of daemon.commands.values()) ids.add(command.taskId);
	return ids.size;
}

/** Lets tasks waiting for a working slot check again. */
export function slotsChanged(daemon: Daemon): void {
	for (const entry of daemon.slotQueue) entry.wake();
}

export function taskSummary(daemon: Daemon, row: TaskRow): TaskSummary {
	const { db } = daemon;
	const live = daemon.workers.get(row.id);
	const working = row.state === 'active' && isWorking(daemon, row.id);
	const status: TaskSummary['status'] =
		row.state === 'active' ? (working ? 'working' : 'waiting') : row.state;

	let now: TaskSummary['now'] = null;
	if (status === 'working') {
		const command = db
			.query<{ text: string; command: string | null; at: number }, [number]>(
				`SELECT text, command, started_at AS at FROM steps
				WHERE task_id = ? AND kind = 'command' AND status = 'running'
				ORDER BY id DESC LIMIT 1`,
			)
			.get(row.id);
		if (command) {
			now = {
				text: command.text,
				command: command.command,
				startedAt: command.at,
			};
		} else {
			const note = db
				.query<{ text: string }, [number]>(
					"SELECT text FROM steps WHERE task_id = ? AND kind = 'note' ORDER BY id DESC LIMIT 1",
				)
				.get(row.id);
			now = {
				text: note?.text ?? 'thinking',
				command: null,
				startedAt: live?.callSince ?? Date.now(),
			};
		}
	}

	const activityAt = Math.floor(Date.now() / MINUTE_MS) * MINUTE_MS;
	const windowStart = activityAt - (ACTIVITY_MINUTES - 1) * MINUTE_MS;
	const activity = Array.from({ length: ACTIVITY_MINUTES }, () => 0);
	for (const { at } of db
		.query<{ at: number }, [number, number]>(
			'SELECT started_at AS at FROM model_calls WHERE task_id = ? AND started_at >= ?',
		)
		.all(row.id, windowStart)) {
		const index = Math.floor((at - windowStart) / MINUTE_MS);
		if (index >= 0 && index < ACTIVITY_MINUTES) {
			activity[index] = (activity[index] ?? 0) + 1;
		}
	}

	const ownable = row.originOwnable === 1;
	return {
		handle: row.handle,
		title: row.title,
		status,
		waitingOn:
			status === 'waiting'
				? (live?.blockedOn ?? row.waitingOn ?? 'a message')
				: null,
		now,
		origin: {
			channel:
				row.originChannel === null || row.originChannel === 'internal'
					? 'console'
					: row.originChannel,
			place: ownable ? row.originThreadTitle : null,
			author: ownable ? row.originAuthor : null,
		},
		threads: db
			.query<
				{ id: string; channel: string; title: string; url: string | null },
				[number]
			>(
				`SELECT th.id, th.channel, th.title, th.url FROM task_threads tt
				JOIN threads th ON th.id = tt.thread_id WHERE tt.task_id = ? ORDER BY tt.since`,
			)
			.all(row.id),
		question: row.state === 'needs_you' ? openQuestion(db, row.id) : null,
		result:
			row.state === 'done' || row.state === 'stopped'
				? row.result
				: row.state === 'failed'
					? row.failure
					: null,
		dismissed: row.dismissed === 1,
		createdAt: row.createdAt,
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		activity,
		activityAt,
	};
}

export function openQuestion(db: Database, taskId: number): Question | null {
	const row = db
		.query<
			{
				id: number;
				text: string;
				context: string | null;
				options: string | null;
				askedAt: number;
			},
			[number]
		>(
			`SELECT id, text, context, options, asked_at AS askedAt FROM questions
			WHERE task_id = ? AND state = 'open' ORDER BY id DESC LIMIT 1`,
		)
		.get(taskId);
	if (!row) return null;
	const options: unknown =
		row.options === null ? null : JSON.parse(row.options);
	return {
		id: row.id,
		text: row.text,
		context: row.context,
		options:
			Array.isArray(options) &&
			options.every((option) => typeof option === 'string')
				? options
				: null,
		askedAt: row.askedAt,
	};
}

/** Publishes the task's summary now, dropping any merged update. Returns its `seq`. */
export function publishTask(daemon: Daemon, taskId: number): number {
	daemon.taskUpdates.pending.delete(taskId);
	const row = taskRow(daemon.db, taskId);
	if (!row) return daemon.feed.seq;
	return daemon.feed.publish({ type: 'task', task: taskSummary(daemon, row) });
}

/** Publishes the task's summary within 100 ms, merged with other changes. */
export function taskChanged(daemon: Daemon, taskId: number): void {
	const updates = daemon.taskUpdates;
	updates.pending.add(taskId);
	if (updates.timer !== null) return;
	updates.timer = setTimeout(() => {
		updates.timer = null;
		for (const id of updates.pending) publishTask(daemon, id);
	}, MERGE_TASK_UPDATES_MS);
}

type StepRow = {
	id: number;
	taskId: number;
	kind: Step['kind'];
	text: string;
	command: string | null;
	status: Step['status'];
	startedAt: number;
	endedAt: number | null;
	exitCode: number | null;
	additions: number | null;
	deletions: number | null;
	hasDiff: number;
};

export const STEP_COLUMNS = `id, task_id AS taskId, kind, text, command, status,
	started_at AS startedAt, ended_at AS endedAt, exit_code AS exitCode, additions,
	deletions, diff IS NOT NULL AS hasDiff FROM steps`;

export function toStep(row: StepRow): Step {
	return {
		id: row.id,
		kind: row.kind,
		text: row.text,
		command: row.command,
		status: row.status,
		startedAt: row.startedAt,
		endedAt: row.endedAt,
		exitCode: row.exitCode,
		additions: row.additions,
		deletions: row.deletions,
		hasDiff: row.hasDiff === 1,
		hasOutput: row.kind === 'command',
	};
}

export function taskSteps(db: Database, taskId: number): Step[] {
	return db
		.query<StepRow, [number]>(
			`SELECT ${STEP_COLUMNS} WHERE task_id = ? ORDER BY id`,
		)
		.all(taskId)
		.map(toStep);
}

/** Publishes a step as it is now. Call after its transaction commits. */
export function publishStep(daemon: Daemon, stepId: number): number {
	const row = daemon.db
		.query<StepRow & { handle: string }, [number]>(
			`SELECT s.id, s.task_id AS taskId, s.kind, s.text, s.command, s.status,
				s.started_at AS startedAt, s.ended_at AS endedAt, s.exit_code AS exitCode,
				s.additions, s.deletions, s.diff IS NOT NULL AS hasDiff, t.handle
			FROM steps s JOIN tasks t ON t.id = s.task_id WHERE s.id = ?`,
		)
		.get(stepId);
	if (!row) return daemon.feed.seq;
	return daemon.feed.publish({
		type: 'step',
		taskHandle: row.handle,
		step: toStep(row),
	});
}

/** Every open or failed task, plus at most 200 that ended today. */
export function snapshotTasks(daemon: Daemon): TaskSummary[] {
	const today = dayStart(Date.now());
	return daemon.db
		.query<TaskRow, [number, number]>(
			`SELECT * FROM (
				SELECT ${TASK_COLUMNS}
				WHERE t.state IN ('active', 'needs_you') OR (t.state = 'failed' AND t.dismissed = 0)
				UNION ALL
				SELECT * FROM (
					SELECT ${TASK_COLUMNS}
					WHERE t.ended_at >= ? AND NOT (t.state = 'failed' AND t.dismissed = 0)
					ORDER BY t.ended_at DESC LIMIT ?
				)
			) ORDER BY createdAt`,
		)
		.all(today, ENDED_TODAY_SHOWN)
		.map((row) => taskSummary(daemon, row));
}

/** Re-sends tasks with recent model calls at each minute, so their activity moves on. */
export function startActivityTimer(daemon: Daemon): () => void {
	let timer: Timer;
	const schedule = () => {
		timer = setTimeout(
			() => {
				for (const { id } of daemon.db
					.query<{ id: number }, [number]>(
						'SELECT DISTINCT task_id AS id FROM model_calls WHERE task_id IS NOT NULL AND started_at >= ?',
					)
					.all(Date.now() - (ACTIVITY_MINUTES + 1) * MINUTE_MS)) {
					taskChanged(daemon, id);
				}
				schedule();
			},
			MINUTE_MS - (Date.now() % MINUTE_MS) + 50,
		);
	};
	schedule();
	return () => clearTimeout(timer);
}
