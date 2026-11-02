import type { Problem } from '../protocol.ts';
import { stopCommand } from './commands.ts';
import { ingest } from './ingest.ts';
import { pauseTask } from './tasks.ts';
import { watchdogMs } from './scale.ts';
import { type Daemon, type Params, cut, dayStart, health } from './state.ts';
import { type Verdict, repeatedCalls, reviewTask } from './watchdog-review.ts';

const TICK_MS = watchdogMs(60_000);
// Recovery's own effects settle before anything is judged.
const START_TICKS = 2;
// A tick this late means the machine slept; ages are inflated for a while.
const WAKE_GAP_TICKS = 3;
const GRACE_TICKS = 2;
const FAILING_TICKS = 3;
const HUNG_CALL_MS = watchdogMs(35 * 60_000);
const PAST_DEADLINE_MS = watchdogMs(60_000);
const BATCH_STUCK_MS = watchdogMs(20 * 60_000);
const POLLER_LATE_WAITS = 3;
const REPLY_KICK_MS = watchdogMs(15 * 60_000);
const REPLY_LATE_MS = watchdogMs(60 * 60_000);
// Model calls without a single progress mark before a task is paused.
const BACKSTOP_CALLS = 150;
// A review: at this many calls since progress, or the same call this many
// times within at least `LOOP_MIN_CALLS` calls since progress.
const SPINNING_CALLS = 60;
const LOOP_REPEATS = 4;
const LOOP_MIN_CALLS = 8;
const REVIEWS_PER_DAY = 20;
const REVIEW_EVERY_MS = watchdogMs(30 * 60_000);
const QUIET_AFTER_PROGRESSING = 40;
const QUIET_AFTER_NOTE = 20;
const QUESTION_CHARS = 300;

/** A stored finding: one check's condition that holds, acted on once. */
export type Finding = {
	id: number;
	key: string;
	taskId: number | null;
	openedAt: number;
	stage: string | null;
	snoozeCalls: number | null;
	snoozeUntil: number | null;
};

/** What a check gets each tick. */
export type Round = {
	daemon: Daemon;
	now: number;
	tickMs: number;
	/** Marks a condition as holding this tick, opening its finding if it's new. */
	hold: (key: string, taskId?: number | null) => Finding;
	/** Shows the finding as a problem on the health screen. */
	report: (
		finding: Finding,
		kind: Problem['kind'],
		text: string,
		fix?: string | null,
	) => void;
	/** Records the action taken, so it's taken once. */
	stage: (finding: Finding, stage: string) => void;
	/** Awake time since `at`: wall time minus the sleeps the Watchdog saw. */
	since: (at: number) => number;
	/** How long the finding has held, in awake time. */
	age: (finding: Finding) => number;
};

/** A stretch the machine slept, as the Watchdog saw it from a late tick. */
type Sleep = { from: number; to: number };

// Enough to cover every age a check looks at.
const SLEEPS_KEPT = 50;

export type Check = {
	/** The prefix of its findings' keys. */
	name: string;
	/** Judges ages, so it's skipped while a sleep inflates them. */
	timed: boolean;
	run: (round: Round) => void;
};

export type Watchdog = { stop: () => Promise<void> };

const FINDING_COLUMNS = `id, key, task_id AS taskId, opened_at AS openedAt, stage,
	snooze_calls AS snoozeCalls, snooze_until AS snoozeUntil`;

/**
 * Runs the checks every minute until stopped. Each check runs alone, so a
 * broken one doesn't stop the others; what they find is in `watchdog_findings`.
 */
export function startWatchdog(daemon: Daemon): Watchdog {
	const stopping = new AbortController();
	const inReview = new Map<number, Promise<void>>();
	const checks = [...CHECKS, reviews(stopping.signal, inReview)];
	const failing = new Map<string, number>();
	let timer: Timer | null = null;
	// When the previous tick ran; before the first, as if one ran a tick
	// before it's due, so a sleep during the start delay is seen too.
	let lastTick = Date.now() + (START_TICKS - 1) * TICK_MS;
	let ticks = 0;
	let graceUntil = 0;
	const sleeps: Sleep[] = [];

	const tick = () => {
		const now = Date.now();
		ticks += 1;
		const gap = now - lastTick;
		if (gap > WAKE_GAP_TICKS * TICK_MS) {
			daemon.log('info', 'watchdog saw the machine wake', {
				after: `${Math.round(gap / 1000)} s`,
			});
			graceUntil = ticks + GRACE_TICKS;
			// Timers stop while the machine sleeps, so this tick should have come
			// a tick after the last one; the rest was sleep, which no age counts.
			sleeps.push({ from: lastTick + TICK_MS, to: now });
			if (sleeps.length > SLEEPS_KEPT) sleeps.shift();
		}
		for (const check of checks) {
			if (check.timed && ticks <= graceUntil) continue;
			const held = new Set<string>();
			try {
				check.run(newRound(daemon, now, held, sleeps));
				resolve(daemon, `${check.name}:`, held, now);
				failing.delete(check.name);
			} catch (error) {
				const count = (failing.get(check.name) ?? 0) + 1;
				failing.set(check.name, count);
				daemon.log('warn', 'watchdog check failed', {
					check: check.name,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		const broken = new Set<string>();
		const meta = newRound(daemon, now, broken, sleeps);
		for (const [name, count] of failing) {
			if (count < FAILING_TICKS) continue;
			meta.report(
				meta.hold(`watchdog:${name}`),
				'agent',
				`Watchdog check ${name} keeps failing`,
				'see daemon.log',
			);
		}
		resolve(daemon, 'watchdog:', broken, now);
		daemon.watchdog.lastCheckAt = now;
		daemon.feed.publish({ type: 'health', health: health(daemon) });
		lastTick = Date.now();
	};

	const schedule = (ms: number) => {
		timer = setTimeout(() => {
			try {
				tick();
			} catch (error) {
				daemon.log('error', 'watchdog tick failed', {
					error: error instanceof Error ? error.message : String(error),
				});
			}
			schedule(TICK_MS);
		}, ms);
	};
	schedule(START_TICKS * TICK_MS);

	return {
		stop: async () => {
			if (timer) clearTimeout(timer);
			timer = null;
			stopping.abort();
			await Promise.all(inReview.values());
		},
	};
}

function newRound(
	daemon: Daemon,
	now: number,
	held: Set<string>,
	sleeps: Sleep[],
): Round {
	const { db } = daemon;
	const since = (at: number) => {
		let slept = 0;
		for (const sleep of sleeps) {
			slept += Math.max(0, Math.min(sleep.to, now) - Math.max(sleep.from, at));
		}
		return Math.max(0, now - at - slept);
	};
	return {
		daemon,
		now,
		tickMs: TICK_MS,
		hold: (key, taskId = null) => {
			held.add(key);
			const open = db
				.query<Finding, [string]>(
					`SELECT ${FINDING_COLUMNS} FROM watchdog_findings WHERE key = ? AND state = 'open'`,
				)
				.get(key);
			if (open) {
				db.query<unknown, [number, number]>(
					'UPDATE watchdog_findings SET seen_at = ? WHERE id = ?',
				).run(now, open.id);
				return open;
			}
			const id = Number(
				db
					.query<unknown, Params>(
						`INSERT INTO watchdog_findings (key, task_id, state, opened_at, seen_at)
						VALUES ($key, $taskId, 'open', $now, $now)`,
					)
					.run({ key, taskId, now }).lastInsertRowid,
			);
			return {
				id,
				key,
				taskId,
				openedAt: now,
				stage: null,
				snoozeCalls: null,
				snoozeUntil: null,
			};
		},
		report: (finding, kind, text, fix = null) => {
			db.query<unknown, Params>(
				`UPDATE watchdog_findings SET problem_kind = $kind, text = $text, fix = $fix
				WHERE id = $id`,
			).run({ kind, text, fix, id: finding.id });
		},
		stage: (finding, stage) => {
			finding.stage = stage;
			db.query<unknown, [string, number]>(
				'UPDATE watchdog_findings SET stage = ? WHERE id = ?',
			).run(stage, finding.id);
			daemon.log('info', 'watchdog acted', { finding: finding.key, stage });
		},
		since,
		age: (finding) => since(finding.openedAt),
	};
}

/** Resolves the open findings under `prefix` that didn't hold this tick. */
function resolve(
	daemon: Daemon,
	prefix: string,
	held: Set<string>,
	now: number,
): void {
	const { db } = daemon;
	for (const { id, key } of db
		.query<{ id: number; key: string }, [string]>(
			"SELECT id, key FROM watchdog_findings WHERE state = 'open' AND substr(key, 1, length(?1)) = ?1",
		)
		.all(prefix)) {
		if (held.has(key)) continue;
		db.query<unknown, [number, number]>(
			"UPDATE watchdog_findings SET state = 'resolved', resolved_at = ? WHERE id = ?",
		).run(now, id);
	}
}

/** Aborts a Worker loop; its `finally` starts a fresh one, which repairs the transcript. */
function restartWorker(daemon: Daemon, taskId: number): void {
	daemon.workers.get(taskId)?.controller.abort();
}

type ActiveTask = { id: number; handle: string; waitingOn: string | null };

function activeTasks(daemon: Daemon): ActiveTask[] {
	return daemon.db
		.query<ActiveTask, []>(
			"SELECT id, handle, waiting_on AS waitingOn FROM tasks WHERE state = 'active'",
		)
		.all();
}

/** Worker loops that are missing, missed a wake, or hang in a model call. */
const workers: Check = {
	name: 'workers',
	timed: true,
	run: (round) => {
		const { daemon, tickMs } = round;
		const { db } = daemon;
		for (const task of activeTasks(daemon)) {
			const live = daemon.workers.get(task.id);
			if (!live) {
				const finding = round.hold(`workers:${task.handle}:no-loop`, task.id);
				if (finding.stage === null) {
					daemon.runWorker(task.id);
					round.stage(finding, 'started');
				} else if (round.age(finding) >= 2 * tickMs) {
					round.report(
						finding,
						'task',
						`${task.handle}'s Worker won't start`,
						'see daemon.log',
					);
				}
				continue;
			}
			if (
				live.callSince !== null &&
				round.since(live.callSince) > HUNG_CALL_MS
			) {
				const finding = round.hold(`workers:${task.handle}:hung-call`, task.id);
				if (finding.stage === null) {
					restartWorker(daemon, task.id);
					round.stage(finding, 'restarted');
				}
				continue;
			}
			// Only a loop asleep with work waiting has missed a wake; one busy in
			// a tool or blocked on something it shows is fine. An asleep loop's
			// background command doesn't count: it's waiting, not working.
			if (!live.asleep || live.blockedOn !== null) continue;
			const inbox =
				db
					.query<{ count: number }, [number]>(
						"SELECT COUNT(*) AS count FROM events WHERE route = 'task' AND task_id = ? AND consumed_at IS NULL",
					)
					.get(task.id)?.count ?? 0;
			const lastRole = db
				.query<{ role: string }, [number]>(
					`SELECT json_extract(i.item, '$.role') AS role FROM session_items i
					JOIN sessions s ON s.id = i.session_id
					WHERE s.task_id = ? ORDER BY i.seq DESC LIMIT 1`,
				)
				.get(task.id)?.role;
			const owed =
				lastRole === undefined ||
				(lastRole === 'tool' && task.waitingOn === null);
			if (inbox === 0 && !owed) continue;
			const finding = round.hold(`workers:${task.handle}:stalled`, task.id);
			const age = round.age(finding);
			if (finding.stage === null && age >= 2 * tickMs) {
				live.wake();
				round.stage(finding, 'woke');
			} else if (finding.stage === 'woke' && age >= 3 * tickMs) {
				restartWorker(daemon, task.id);
				round.stage(finding, 'restarted');
			} else if (finding.stage === 'restarted' && age >= 4 * tickMs) {
				round.report(
					finding,
					'task',
					`${task.handle}'s Worker isn't taking its messages`,
					'see daemon.log',
				);
			}
		}
	},
};

/** The Router's mailbox not draining, or a batch that never ends. */
const router: Check = {
	name: 'router',
	timed: true,
	run: (round) => {
		const { daemon, tickMs } = round;
		const { batch, backoffUntil } = daemon.router;
		if (batch !== null && round.since(batch.since) > BATCH_STUCK_MS) {
			round.report(
				round.hold('router:batch'),
				'agent',
				`The Router has been deciding for ${minutes(round.since(batch.since))}`,
				'see daemon.log',
			);
		}
		if (
			batch !== null ||
			backoffUntil !== null ||
			daemon.particle === null ||
			daemon.model.state !== 'ok'
		) {
			return;
		}
		const oldest = daemon.db
			.query<{ at: number | null }, []>(
				"SELECT MIN(received_at) AS at FROM events WHERE route = 'router' AND consumed_at IS NULL",
			)
			.get()?.at;
		if (
			oldest === null ||
			oldest === undefined ||
			round.since(oldest) < 2 * tickMs
		) {
			return;
		}
		const finding = round.hold('router:stalled');
		if (finding.stage === null) {
			daemon.router.wake();
			round.stage(finding, 'woke');
		} else if (round.age(finding) >= tickMs) {
			round.report(
				finding,
				'agent',
				"The Router isn't taking its waiting events",
				'see daemon.log',
			);
		}
	},
};

/** The GitHub poller's loop and the reply delivery loop staying alive. */
const github: Check = {
	name: 'github',
	timed: true,
	run: (round) => {
		const { daemon, now, tickMs } = round;
		const api = daemon.githubApi;
		const { state } = daemon.github;
		if (api && (state === 'up' || state === 'connecting')) {
			const pulse = api.pulse();
			if (
				pulse.at !== null &&
				!pulse.rateLimited &&
				round.since(pulse.at) > POLLER_LATE_WAITS * pulse.waitMs
			) {
				const finding = round.hold('github:poller');
				if (finding.stage === null) {
					api.kick();
					round.stage(finding, 'kicked');
				} else if (round.age(finding) >= tickMs) {
					round.report(
						finding,
						'agent',
						'GitHub polling has stalled',
						'see daemon.log',
					);
				}
			}
		}
		if (state !== 'up') return;
		for (const reply of daemon.db
			.query<{ id: number; at: number; title: string }, [number]>(
				`SELECT m.id, m.at, th.title FROM messages m JOIN threads th ON th.id = m.thread_id
				WHERE m.channel = 'github' AND m.direction = 'out' AND m.delivery = 'pending'
					AND m.at < ?`,
			)
			.all(now - REPLY_KICK_MS)) {
			// Wall time is only a first cut; awake time decides.
			const waited = round.since(reply.at);
			if (waited < REPLY_KICK_MS) continue;
			const finding = round.hold(`github:reply:${reply.id}`);
			if (finding.stage === null) {
				daemon.wakeDelivery();
				round.stage(finding, 'kicked');
			}
			if (waited >= REPLY_LATE_MS) {
				round.report(
					finding,
					'undelivered',
					`A reply on ${reply.title} has waited ${minutes(waited)} to post`,
				);
			}
		}
	},
};

/** Commands still running past their own timeout, whose timer should have ended them. */
const commands: Check = {
	name: 'commands',
	timed: true,
	run: (round) => {
		const { daemon } = round;
		for (const command of daemon.commands.values()) {
			// Its timer counts awake time too, so a sleep doesn't make it late.
			if (
				round.since(command.startedAt) - command.timeoutMs <
				PAST_DEADLINE_MS
			) {
				continue;
			}
			const finding = round.hold(
				`commands:${command.stepId}:past-timeout`,
				command.taskId,
			);
			if (finding.stage !== null) continue;
			command.stopReason ??= 'timed out';
			void stopCommand(daemon, command.stepId);
			round.stage(finding, 'killed');
		}
	},
};

/**
 * Tasks spending model calls without progress. The backstop needs no model:
 * 150 calls without a single mark is a runaway, and you can let it go on.
 */
const runaway: Check = {
	name: 'runaway',
	timed: false,
	run: (round) => {
		const { daemon } = round;
		for (const task of daemon.db
			.query<{ id: number; handle: string; idle: number }, [number]>(
				`SELECT id, handle, model_calls - progress_calls AS idle FROM tasks
				WHERE state = 'active' AND model_calls - progress_calls >= ?`,
			)
			.all(BACKSTOP_CALLS)) {
			const finding = round.hold(`runaway:${task.handle}:backstop`, task.id);
			if (finding.stage !== null) continue;
			const paused = pauseTask(daemon, task.id, {
				text: `Watchdog: ${task.handle} has made ${task.idle} model calls without progress (no edits, new command results, questions or new input). It's paused. Continue or stop?`,
				context: `${task.idle} model calls since its last progress mark. Continue lets it go on and starts the count again; Stop stops the task.`,
			});
			if (paused) round.stage(finding, 'paused');
		}
	},
};

/**
 * Workers spending calls without progress, or repeating a call, get a model
 * review: is it getting anywhere? At most one per task at a time, one per
 * task per 30 minutes and 20 a day, and none while the model is unwell.
 */
function reviews(
	signal: AbortSignal,
	inReview: Map<number, Promise<void>>,
): Check {
	return {
		name: 'reviews',
		timed: false,
		run: (round) => {
			const { daemon, now } = round;
			const { db } = daemon;
			for (const task of db
				.query<
					{
						id: number;
						handle: string;
						title: string;
						instructions: string;
						calls: number;
						idle: number;
						since: number;
						progressCalls: number;
						progressAt: number | null;
					},
					[number]
				>(
					`SELECT id, handle, title, instructions, model_calls AS calls,
						model_calls - progress_calls AS idle,
						COALESCE(last_progress_at, created_at) AS since,
						progress_calls AS progressCalls, last_progress_at AS progressAt
					FROM tasks WHERE state = 'active' AND model_calls - progress_calls >= ?`,
				)
				.all(LOOP_MIN_CALLS)) {
				const loop = repeatedCalls(db, task.id, task.since).find(
					(entry) => entry.count >= LOOP_REPEATS,
				);
				if (task.idle < SPINNING_CALLS && !loop) continue;
				const finding = round.hold(`reviews:${task.handle}`, task.id);
				if (
					inReview.has(task.id) ||
					(finding.snoozeCalls !== null && task.calls < finding.snoozeCalls) ||
					(finding.snoozeUntil !== null && now < finding.snoozeUntil) ||
					daemon.particle === null ||
					daemon.model.state !== 'ok' ||
					// Reviews still in flight count, so one tick can't start past the cap.
					reviewsToday(daemon, now) + inReview.size >= REVIEWS_PER_DAY
				) {
					continue;
				}
				const trigger = loop
					? `the same ${loop.call.split(' ')[0] ?? 'tool'} call ${loop.count} times`
					: `${task.idle} calls since its last progress`;
				daemon.log('info', 'watchdog reviews a task', {
					task: task.handle,
					trigger,
				});
				const review = (async () => {
					const verdict = await reviewTask(daemon, task, trigger, signal);
					inReview.delete(task.id);
					if (signal.aborted) return;
					try {
						applyVerdict(daemon, finding.id, task, verdict);
					} catch (error) {
						daemon.log('warn', 'watchdog verdict failed', {
							task: task.handle,
							error: error instanceof Error ? error.message : String(error),
						});
					}
				})();
				inReview.set(task.id, review);
			}
		},
	};
}

function reviewsToday(daemon: Daemon, now: number): number {
	return (
		daemon.db
			.query<{ count: number }, [number]>(
				"SELECT COUNT(*) AS count FROM model_calls WHERE purpose = 'watchdog' AND started_at >= ?",
			)
			.get(dayStart(now))?.count ?? 0
	);
}

const VERDICT_WORDS: Record<
	Exclude<Verdict['verdict'], 'progressing'>,
	string
> = {
	stuck: 'stuck',
	looping: 'looping',
	off_goal: 'off the task',
};

/**
 * `progressing` is silent. The first other verdict in an episode is a note to
 * the Worker; the next pauses the task with a question. A verdict about an
 * episode that has ended is dropped: the task made progress, or stopped being
 * active, while the review ran. Its finding only resolves on the next tick.
 */
function applyVerdict(
	daemon: Daemon,
	findingId: number,
	task: {
		id: number;
		handle: string;
		progressCalls: number;
		progressAt: number | null;
	},
	verdict: Verdict | null,
): void {
	const { db } = daemon;
	const finding = db
		.query<{ state: string; stage: string | null }, [number]>(
			'SELECT state, stage FROM watchdog_findings WHERE id = ?',
		)
		.get(findingId);
	if (!finding || finding.state !== 'open') return;
	const current = db
		.query<
			{ state: string; progressCalls: number; progressAt: number | null },
			[number]
		>(
			`SELECT state, progress_calls AS progressCalls, last_progress_at AS progressAt
			FROM tasks WHERE id = ?`,
		)
		.get(task.id);
	if (
		!current ||
		current.state !== 'active' ||
		current.progressCalls !== task.progressCalls ||
		current.progressAt !== task.progressAt
	) {
		daemon.log('info', 'watchdog verdict dropped: the task moved on', {
			task: task.handle,
			verdict: verdict?.verdict ?? null,
		});
		return;
	}
	const now = Date.now();
	const calls =
		db
			.query<{ calls: number }, [number]>(
				'SELECT model_calls AS calls FROM tasks WHERE id = ?',
			)
			.get(task.id)?.calls ?? 0;
	const settle = (stage: string | null, quietCalls: number | null) => {
		db.query<unknown, Params>(
			`UPDATE watchdog_findings SET stage = COALESCE($stage, stage),
				snooze_calls = $snoozeCalls, snooze_until = $snoozeUntil WHERE id = $id`,
		).run({
			stage,
			snoozeCalls: quietCalls === null ? null : calls + quietCalls,
			snoozeUntil: now + REVIEW_EVERY_MS,
			id: findingId,
		});
	};
	if (verdict === null) {
		settle(null, null);
		return;
	}
	daemon.log('info', 'watchdog verdict', {
		task: task.handle,
		verdict: verdict.verdict,
		reason: verdict.reason,
	});
	if (verdict.verdict === 'progressing') {
		settle(null, QUIET_AFTER_PROGRESSING);
		return;
	}
	const word = VERDICT_WORDS[verdict.verdict];
	if (finding.stage !== 'noted') {
		ingest(daemon, {
			channel: 'console',
			externalId: null,
			thread: null,
			kind: 'note',
			author: { name: 'watchdog', id: null, isBot: false, isSelf: false },
			text: `The watchdog thinks you're ${word}: ${verdict.reason}\n\n${verdict.advice}`,
			mentionsAgent: false,
			taskId: task.id,
		});
		settle('noted', QUIET_AFTER_NOTE);
		return;
	}
	const paused = pauseTask(daemon, task.id, {
		text: cut(
			`Watchdog: ${task.handle} seems ${word}: ${verdict.reason} It's paused. Continue or stop?`,
			QUESTION_CHARS,
		),
		context: `**Why:** ${verdict.reason}\n\n**Advice it was given:** ${verdict.advice}`,
	});
	if (paused) settle('paused', null);
}

const CHECKS: Check[] = [workers, router, github, commands, runaway];

function minutes(ms: number): string {
	const total = Math.max(1, Math.round(ms / 60_000));
	return total < 60
		? `${total} min`
		: `${Math.floor(total / 60)} h ${total % 60} min`;
}
