import type { Problem } from '../protocol.ts';
import { stopCommand } from './commands.ts';
import { watchdogMs } from './scale.ts';
import { type Daemon, type Params, health } from './state.ts';

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
export function startWatchdog(
	daemon: Daemon,
	checks: Check[] = CHECKS,
): Watchdog {
	const failing = new Map<string, number>();
	let timer: Timer | null = null;
	let lastTick = Date.now();
	let ticks = 0;
	let graceUntil = 0;
	const sleeps: Sleep[] = [];

	const tick = () => {
		const now = Date.now();
		ticks += 1;
		const gap = now - lastTick;
		if (ticks > 1 && gap > WAKE_GAP_TICKS * TICK_MS) {
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
	lastTick = Date.now() + (START_TICKS - 1) * TICK_MS;

	return {
		stop: async () => {
			if (timer) clearTimeout(timer);
			timer = null;
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

const CHECKS: Check[] = [workers, router, github, commands];

function minutes(ms: number): string {
	const total = Math.max(1, Math.round(ms / 60_000));
	return total < 60
		? `${total} min`
		: `${Math.floor(total / 60)} h ${total % 60} min`;
}
