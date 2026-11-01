import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { stopTaskCommands, taskFolder } from './commands.ts';
import { taskBranch, worktreePath } from './git.ts';
import { ingest } from './ingest.ts';
import type { Daemon, Params } from './state.ts';
import { publishTask, taskRow } from './task-feed.ts';

// Handles start with a letter so `@t97c` never reads as a number; neither
// part has look-alikes (i, l, o, 0, 1).
const HANDLE_FIRST = 'abcdefghjkmnpqrstuvwxyz';
const HANDLE_REST = 'abcdefghjkmnpqrstuvwxyz23456789';
const STOP_TIMEOUT_MS = 10_000;

function pick(alphabet: string): string {
	// Rejecting the top of the byte range keeps every character equally likely.
	const limit = 256 - (256 % alphabet.length);
	for (;;) {
		const [byte = 255] = crypto.getRandomValues(new Uint8Array(1));
		if (byte < limit) return alphabet[byte % alphabet.length] ?? 'a';
	}
}

function randomHandle(): string {
	return (
		pick(HANDLE_FIRST) +
		pick(HANDLE_REST) +
		pick(HANDLE_REST) +
		pick(HANDLE_REST)
	);
}

/** Creates the task and its Worker session, takes its threads, and starts its Worker. */
export function createTask(
	daemon: Daemon,
	input: {
		title: string;
		instructions: string;
		threads: string[];
		originEventId: number | null;
		/** A configured repository's name, or `null` for a scratch folder. */
		repo: string | null;
	},
): { id: number; handle: string } {
	const { db } = daemon;
	const at = Date.now();
	const created = db.transaction(() => {
		let handle = randomHandle();
		while (
			db
				.query<unknown, [string]>('SELECT 1 FROM tasks WHERE handle = ?')
				.get(handle)
		) {
			handle = randomHandle();
		}
		const id = Number(
			db
				.query<unknown, Params>(
					`INSERT INTO tasks (handle, title, instructions, state, origin_event_id, repo,
						work_dir, branch, created_at, updated_at)
					VALUES ($handle, $title, $instructions, 'active', $origin, $repo,
						$workDir, $branch, $at, $at)`,
				)
				.run({
					handle,
					title: input.title,
					instructions: input.instructions,
					origin: input.originEventId,
					repo: input.repo,
					// The Worker creates a worktree before its first model call.
					workDir:
						input.repo === null
							? join(taskFolder(daemon, handle), 'work')
							: worktreePath(daemon, input.repo, handle),
					branch: input.repo === null ? null : taskBranch(handle),
					at,
				}).lastInsertRowid,
		);
		db.query<unknown, [number, number]>(
			"INSERT INTO sessions (kind, task_id, created_at) VALUES ('worker', ?, ?)",
		).run(id, at);
		for (const thread of input.threads) {
			db.query<unknown, [number, string]>(
				'UPDATE threads SET owner_task_id = ? WHERE id = ?',
			).run(id, thread);
			db.query<unknown, [number, string, number]>(
				'INSERT OR IGNORE INTO task_threads (task_id, thread_id, since) VALUES (?, ?, ?)',
			).run(id, thread, at);
		}
		return { id, handle };
	})();
	const folder = taskFolder(daemon, created.handle);
	if (input.repo === null) mkdirSync(join(folder, 'work'), { recursive: true });
	mkdirSync(join(folder, 'tmp'), { recursive: true });
	publishTask(daemon, created.id);
	daemon.log('info', 'task started', {
		task: created.handle,
		title: input.title,
		origin: input.originEventId,
		repo: input.repo,
	});
	daemon.runWorker(created.id);
	return created;
}

/** Makes an ended task active again and gives it back its threads that are still unowned. */
export function reopenTask(daemon: Daemon, taskId: number): number {
	const { db } = daemon;
	db.transaction(() => {
		db.query<unknown, [number, number]>(
			`UPDATE tasks SET state = 'active', ended_at = NULL, result = NULL, failure = NULL,
				dismissed = 0, waiting_on = NULL, updated_at = ?
			WHERE id = ? AND state IN ('done', 'failed', 'stopped')`,
		).run(Date.now(), taskId);
		db.query<unknown, [number, number]>(
			`UPDATE threads SET owner_task_id = ?
			WHERE owner_task_id IS NULL AND id IN (SELECT thread_id FROM task_threads WHERE task_id = ?)`,
		).run(taskId, taskId);
	})();
	const seq = publishTask(daemon, taskId);
	daemon.log('info', 'task reopened', { task: taskId });
	daemon.runWorker(taskId);
	return seq;
}

export type TaskOutcome =
	| { state: 'done'; result: string; report: string | null }
	| { state: 'failed'; failure: string }
	| {
			state: 'stopped';
			result: string;
			/** Dismissing a failed task is a stop. */
			dismiss: boolean;
			/** Whether people on its threads may need to hear (not when the Router stopped it). */
			tellRouter: boolean;
	  };

/**
 * Ends a task: stores the outcome, cancels its question, releases its threads,
 * aborts its Worker and stops its commands, then tells the Router. Returns
 * `false` when the task had already ended.
 */
export function endTask(
	daemon: Daemon,
	taskId: number,
	outcome: TaskOutcome,
): boolean {
	const { db } = daemon;
	const at = Date.now();
	const ended = db.transaction(() => {
		const row = taskRow(db, taskId);
		if (!row) return null;
		const open = row.state === 'active' || row.state === 'needs_you';
		const dismissing =
			outcome.state === 'stopped' &&
			outcome.dismiss &&
			row.state === 'failed' &&
			row.dismissed === 0;
		if (!open && !dismissing) return null;
		const chatThreads = ownedChatThreads(daemon, taskId);
		db.query<unknown, Params>(
			`UPDATE tasks SET state = $state, ended_at = $at, updated_at = $at, waiting_on = NULL,
				result = $result, failure = $failure, report = COALESCE($report, report),
				dismissed = $dismissed, last_progress_at = $progress
			WHERE id = $id`,
		).run({
			state: outcome.state,
			at,
			result: outcome.state === 'failed' ? null : outcome.result,
			failure:
				outcome.state === 'failed'
					? outcome.failure
					: dismissing
						? row.failure
						: null,
			report: outcome.state === 'done' ? outcome.report : null,
			dismissed: dismissing ? 1 : 0,
			progress: outcome.state === 'done' ? at : null,
			id: taskId,
		});
		db.query<unknown, [number, number]>(
			"UPDATE questions SET state = 'cancelled', answered_at = ? WHERE task_id = ? AND state = 'open'",
		).run(at, taskId);
		db.query<unknown, [number]>(
			'UPDATE threads SET owner_task_id = NULL WHERE owner_task_id = ?',
		).run(taskId);
		return { handle: row.handle, chatThreads };
	})();
	if (ended === null) return false;

	daemon.workers.get(taskId)?.controller.abort();
	void stopTaskCommands(daemon, taskId);
	publishTask(daemon, taskId);
	daemon.log('info', `task ${outcome.state}`, {
		task: ended.handle,
		...(outcome.state === 'failed'
			? { failure: outcome.failure }
			: { result: outcome.result }),
	});

	if (outcome.state === 'done') {
		toRouter(daemon, 'task_finished', taskId, ended.handle, outcome.result, {
			result: outcome.result,
			report: outcome.report,
		});
	} else if (outcome.state === 'failed') {
		toRouter(daemon, 'task_failed', taskId, ended.handle, outcome.failure);
	} else if (outcome.tellRouter && ended.chatThreads.length > 0) {
		toRouter(daemon, 'task_stopped', taskId, ended.handle, outcome.result, {
			threads: ended.chatThreads,
		});
	}
	return true;
}

/**
 * Stops a task and waits until its Worker loop and every command have exited.
 * `false` when that took over 10 s or the task had already ended.
 */
export async function stopAndWait(
	daemon: Daemon,
	taskId: number,
	outcome: Extract<TaskOutcome, { state: 'stopped' }>,
): Promise<boolean> {
	const loop = daemon.workers.get(taskId)?.loop ?? Promise.resolve();
	if (!endTask(daemon, taskId, outcome)) return false;
	let timer: Timer | null = null;
	const exited = await Promise.race([
		Promise.all([loop, stopTaskCommands(daemon, taskId)]).then(() => true),
		new Promise<false>((resolve) => {
			timer = setTimeout(() => resolve(false), STOP_TIMEOUT_MS);
		}),
	]);
	if (timer) clearTimeout(timer);
	return exited;
}

/** Opens a question; the task needs you until it's answered. */
export function askQuestion(
	daemon: Daemon,
	taskId: number,
	question: {
		text: string;
		context: string | null;
		options: string[] | null;
		/** The host the task's commands may reach if the operator allows it. */
		host?: string;
	},
): number {
	const { db } = daemon;
	const at = Date.now();
	const id = db.transaction(() => {
		const questionId = Number(
			db
				.query<unknown, Params>(
					`INSERT INTO questions (task_id, text, context, options, state, asked_at, host)
					VALUES ($taskId, $text, $context, $options, 'open', $at, $host)`,
				)
				.run({
					taskId,
					text: question.text,
					context: question.context,
					options: question.options ? JSON.stringify(question.options) : null,
					at,
					host: question.host ?? null,
				}).lastInsertRowid,
		);
		db.query<unknown, [number, number]>(
			`UPDATE tasks SET state = 'needs_you', waiting_on = NULL, last_progress_at = ?1,
				updated_at = ?1 WHERE id = ?2`,
		).run(at, taskId);
		return questionId;
	})();
	publishTask(daemon, taskId);
	// Console-only tasks: the TUI's NEEDS YOU section is enough.
	const row = taskRow(db, taskId);
	if (row && ownedChatThreads(daemon, taskId).length > 0) {
		toRouter(daemon, 'task_question', taskId, row.handle, question.text, {
			question: id,
		});
	}
	return id;
}

/** Sets failed tasks back to active, telling each Worker why it stopped. */
export function resumeTasks(
	daemon: Daemon,
	handles: string[] | null,
): string[] {
	const failed = daemon.db
		.query<{ id: number; handle: string; failure: string | null }, []>(
			"SELECT id, handle, failure FROM tasks WHERE state = 'failed' AND dismissed = 0 ORDER BY id",
		)
		.all()
		.filter((task) => handles === null || handles.includes(task.handle));
	for (const task of failed) {
		ingest(daemon, {
			channel: 'internal',
			externalId: null,
			thread: null,
			kind: 'note',
			author: { name: 'agent', id: null, isBot: false, isSelf: false },
			text: `You were interrupted: ${task.failure ?? 'the task failed'}. Continue from where you were.`,
			mentionsAgent: false,
			taskId: task.id,
		});
		reopenTask(daemon, task.id);
	}
	return failed.map((task) => task.handle);
}

/** Threads the task owns outside the console, whose people may be waiting on it. */
export function ownedChatThreads(daemon: Daemon, taskId: number): string[] {
	return daemon.db
		.query<{ id: string }, [number]>(
			"SELECT id FROM threads WHERE owner_task_id = ? AND channel != 'console'",
		)
		.all(taskId)
		.map((thread) => thread.id);
}

/** An internal event from a task to the Router's mailbox. */
export function toRouter(
	daemon: Daemon,
	kind: string,
	taskId: number,
	handle: string,
	text: string,
	data?: Record<string, unknown>,
): void {
	ingest(daemon, {
		channel: 'internal',
		externalId: null,
		thread: null,
		kind,
		author: { name: `task ${handle}`, id: null, isBot: false, isSelf: false },
		text,
		mentionsAgent: false,
		...(data ? { data } : {}),
		taskId,
	});
}
