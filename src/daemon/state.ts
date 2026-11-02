import type { Database } from 'bun:sqlite';
import { realpathSync } from 'node:fs';
import type { DataPaths } from '../home.ts';
import { MODEL, type ParticleClient } from '../particle/client.ts';
import type {
	ActionResult,
	Health,
	KeySource,
	MachineFacts,
	Message,
	Problem,
	RouterState,
	Snapshot,
	Usage,
	Warning,
} from '../protocol.ts';
import type { Feed } from './feed.ts';
import type { GitHubClient, GitHubLive } from './github.ts';
import type { Log } from './log.ts';
import type { SandboxStatus } from './sandbox.ts';
import type { Config } from './setup.ts';

const CONSOLE_SNAPSHOT_MESSAGES = 50;
const FEED_MESSAGE_CHARS = 4_000;
const USAGE_INTERVAL_MS = 1_000;
const UNDELIVERED_MS = 24 * 60 * 60_000;

/** Everything the daemon's handlers share. One per process. */
export type Daemon = {
	db: Database;
	feed: Feed;
	log: Log;
	config: Config;
	/**
	 * Every key the agent has read, kept out of commands, the model, the feed
	 * and the log. Only grows, so a replaced key stays redacted.
	 */
	secrets: string[];
	agent: Snapshot['agent'];
	machine: MachineFacts;
	/** The last event time of each channel, for health. */
	channels: Map<string, number | null>;
	/** The GitHub channel's health; `off` unless gh is installed and logged in. */
	github: GitHubLive;
	/** GitHub's REST client, once the channel runs. */
	githubApi: GitHubClient | null;
	/** Tells the GitHub delivery loop a reply is waiting. */
	wakeDelivery: () => void;
	/** `POST /v1/events` is on (`--script-channel`), for tests. */
	scriptChannel: boolean;
	/** Action results by `requestId`, kept 10 minutes. */
	actionResults: Map<string, { at: number; result: ActionResult }>;
	usageTimer: Timer | null;
	/** `null` when there's no API key; the model stays paused. */
	particle: ParticleClient | null;
	/** The key `particle` uses, to notice when it changes. */
	particleKey: string | null;
	keySource: KeySource;
	/** The key file as last read, to notice it written again with the same key. */
	keyFileStamp: string | null;
	model: Omit<Health['model'], 'name' | 'key' | 'keyRejected'>;
	/** What fixes the model's failure, when the operator can. */
	modelFix: string | null;
	router: RouterLive;
	paths: DataPaths;
	/** Your login shell's PATH, for Worker commands. */
	loginPath: string;
	/** Commands are refused unless it's `on`. */
	sandbox: SandboxStatus;
	/** `user.name` and `user.email`, when git can't resolve them for commits. */
	missingIdentity: string[];
	/** Worker loops of active tasks, by task ID. */
	workers: Map<number, WorkerLive>;
	/** Commands still running, by step ID. */
	commands: Map<number, RunningCommand>;
	/**
	 * Starts the task's Worker loop if it's active, or wakes it. A `message`
	 * (from a person, not a command's end) also stops its wait on a foreground
	 * command and skips the rest of its turn's tool calls, so it reads the
	 * message next.
	 */
	runWorker: (taskId: number, options?: { message?: boolean }) => void;
	/** Tasks waiting for a working slot, first come first served. */
	slotQueue: Array<{ wake: () => void }>;
	/** Worker model calls in flight, and those waiting for one. */
	calls: { workers: number; waiters: Set<() => void> };
	/** Task summaries to publish, merged within 100 ms. */
	taskUpdates: { pending: Set<number>; timer: Timer | null };
	/** Set once shutdown starts, so ended loops aren't restarted. */
	stopping: boolean;
	watchdog: WatchdogLive;
};

/** What health shows of the Watchdog; its findings are in SQLite. */
export type WatchdogLive = {
	/** The last round of checks. */
	lastCheckAt: number | null;
};

/** What the Router loop is doing right now; the rest of its state is in SQLite. */
export type RouterLive = {
	/** The open batch, while the Router is deciding. */
	batch: { id: number; since: number; size: number } | null;
	/** When its backoff after a failure ends, while it's backing off. */
	backoffUntil: number | null;
	/** Why it's backing off, for the console messages it holds. */
	heldBecause: string | null;
	/** Its batches' error when it isn't Particle's, until a batch succeeds. */
	failing: { error: string; since: number } | null;
	/** Tells the Router loop the mailbox may have changed. */
	wake: () => void;
};

/** A Worker loop's live state; everything durable is in SQLite. */
export type WorkerLive = {
	taskId: number;
	handle: string;
	/** Aborted when the task stops or fails, and on shutdown. */
	controller: AbortController;
	wake: () => void;
	/** When its model call started, while one is running. */
	callSince: number | null;
	/** Sleeping until woken, with nothing to do as far as it knows. */
	asleep: boolean;
	/** Holds a working slot for the current turn. */
	turn: boolean;
	/** Why it can't go on: `a free worker slot`, `Particle (out of credits)`. */
	blockedOn: string | null;
	/** A message arrived since the loop last read its inbox. */
	heard: boolean;
	/** Resolves when the loop has exited. */
	loop: Promise<void>;
};

export type RunningCommand = {
	stepId: number;
	taskId: number;
	pgid: number;
	/** Set once `run` stops waiting; its end then arrives as `command_done`. */
	background: boolean;
	/** Makes `run` stop waiting now, for a message; a no-op once it has. */
	release: () => void;
	/** Call after SIGKILL to its group: output still open a second later isn't waited for. */
	killed: () => void;
	startedAt: number;
	/** Its `timeout_s`. */
	timeoutMs: number;
	/** Why it was ended early, if it was. */
	stopReason: 'stopped' | 'timed out' | null;
	/** Resolves with the tool result once the command has ended and its step is stored. */
	finished: Promise<string>;
};

/** Named parameters; `strict` mode binds `$name` placeholders from `name` keys. */
export type Params = [Record<string, string | number | null>];

export type MessageRow = {
	id: number;
	at: number;
	channel: string;
	threadId: string | null;
	taskHandle: string | null;
	direction: Message['direction'];
	author: string;
	text: string;
	delivery: Message['delivery'];
	toWorker: number;
	readAt: number | null;
};

export const MESSAGE_COLUMNS = `m.id, m.at, m.channel, m.thread_id AS threadId,
	t.handle AS taskHandle, m.direction, m.author, m.text, m.delivery,
	ev.route = 'task' AS toWorker, ev.consumed_at AS readAt
	FROM messages m LEFT JOIN tasks t ON t.id = m.task_id
	LEFT JOIN events ev ON ev.id = m.event_id`;

export function toMessage(
	row: MessageRow,
	limit: number = FEED_MESSAGE_CHARS,
): Message {
	const text = cut(row.text, limit);
	return {
		id: row.id,
		at: row.at,
		channel: row.channel,
		threadId: row.threadId,
		taskHandle: row.taskHandle,
		direction: row.direction,
		author: row.author,
		text,
		truncated: text.length < row.text.length,
		delivery: row.delivery,
		worker: row.toWorker === 1 ? { readAt: row.readAt } : null,
	};
}

export function consoleMessages(db: Database): Message[] {
	return db
		.query<MessageRow, [number]>(
			`SELECT ${MESSAGE_COLUMNS} WHERE m.thread_id = 'console' ORDER BY m.id DESC LIMIT ?`,
		)
		.all(CONSOLE_SNAPSHOT_MESSAGES)
		.toReversed()
		.map((row) => toMessage(row));
}

export function routerState(daemon: Daemon): RouterState {
	const { db } = daemon;
	const waiting =
		db
			.query<{ count: number }, []>(
				`SELECT COUNT(*) AS count FROM events WHERE route = 'router' AND consumed_at IS NULL`,
			)
			.get()?.count ?? 0;
	const last = db
		.query<{ text: string; at: number }, []>(
			`SELECT summary AS text, ended_at AS at FROM router_batches
			WHERE state = 'done' AND summary IS NOT NULL AND ended_at IS NOT NULL
			ORDER BY id DESC LIMIT 1`,
		)
		.get();
	const { batch } = daemon.router;
	const pending = db
		.query<{ id: number }, [number]>(
			`SELECT m.id FROM messages m JOIN events e ON e.id = m.event_id
			WHERE m.thread_id = 'console' AND e.route = 'router' AND e.consumed_at IS NULL
			ORDER BY m.id DESC LIMIT ?`,
		)
		.all(CONSOLE_SNAPSHOT_MESSAGES)
		.map((row) => row.id)
		.toReversed();
	return {
		deciding: batch !== null,
		decidingSince: batch?.since ?? null,
		batchSize: batch?.size ?? 0,
		waiting,
		last: last ?? null,
		held: batch === null ? held(daemon) : null,
		pending,
	};
}

/** Why the Router isn't deciding its waiting events, when something stops it. */
function held(daemon: Daemon): RouterState['held'] {
	const { router } = daemon;
	if (daemon.particle === null) {
		return {
			reason: daemon.model.detail ?? 'no Particle API key',
			until: null,
		};
	}
	if (router.backoffUntil === null) return null;
	return {
		reason: router.heldBecause ?? 'the Router hit an error',
		until: router.backoffUntil,
	};
}

/** Publishes the Router's state. Call after its transaction commits. */
export function routerChanged(daemon: Daemon): number {
	return daemon.feed.publish({ type: 'router', router: routerState(daemon) });
}

/** The model's detail while paused on a key Particle rejected. */
export const KEY_REJECTED = 'Particle rejected the API key';

/** Sets the model's health, publishing it when it changed. */
export function setModelHealth(
	daemon: Daemon,
	state: Health['model']['state'],
	detail: string | null,
	fix: string | null = null,
): void {
	const current = daemon.model;
	if (
		current.state === state &&
		current.detail === detail &&
		daemon.modelFix === fix
	) {
		return;
	}
	const recovered = current.state === 'error' && state !== 'error';
	daemon.model = {
		state,
		detail,
		since:
			state === 'ok'
				? null
				: current.state === state
					? current.since
					: Date.now(),
	};
	daemon.modelFix = fix;
	daemon.feed.publish({ type: 'health', health: health(daemon) });
	// Console messages without a key say why they wait.
	routerChanged(daemon);
	// Workers waiting out a Particle outage and the Router's backoff carry on:
	// with a working model, or into the account-error handling.
	if (recovered) {
		daemon.router.wake();
		for (const live of daemon.workers.values()) live.wake();
	}
}

export function usageSince(db: Database, since: number): Usage {
	// An aggregate without GROUP BY always returns exactly one row.
	const totals = db
		.query<Usage, [number]>(
			`SELECT ?1 AS since, COUNT(*) AS calls,
				COALESCE(SUM(prompt_tokens), 0) AS inputTokens,
				COALESCE(SUM(cached_tokens), 0) AS cachedTokens,
				COALESCE(SUM(completion_tokens), 0) AS outputTokens,
				COALESCE(SUM(reasoning_tokens), 0) AS reasoningTokens,
				COALESCE(SUM(cost_usd), 0) AS costUsd
			FROM model_calls WHERE started_at >= ?1`,
		)
		.get(since);
	if (totals === null) throw new Error('usage query returned no row');
	return totals;
}

/** Sends today's usage totals, at most once a second. Call after recording a model call. */
export function usageChanged(daemon: Daemon): void {
	if (daemon.usageTimer !== null) return;
	daemon.usageTimer = setTimeout(() => {
		daemon.usageTimer = null;
		daemon.feed.publish({
			type: 'usage',
			usage: usageSince(daemon.db, dayStart(Date.now())),
		});
	}, USAGE_INTERVAL_MS);
}

export function health(daemon: Daemon): Health {
	const problems: Problem[] = [];
	if (daemon.model.state !== 'ok') {
		problems.push({
			id: 'model',
			kind: 'model',
			text: daemon.model.detail ?? 'Particle is unavailable',
			fix: daemon.modelFix,
			since: daemon.model.since ?? Date.now(),
		});
	}
	const { failing } = daemon.router;
	if (failing !== null) {
		problems.push({
			id: 'router:failing',
			kind: 'agent',
			text: `The Router failed: ${cut(failing.error.replaceAll(/\s+/g, ' '), 200)}`,
			fix: 'superagent logs shows the error',
			since: failing.since,
		});
	}
	const warnings: Warning[] = [];
	const { sandbox } = daemon;
	if (sandbox.state === 'off') {
		warnings.push({
			id: 'sandbox',
			text: `Commands run unsandboxed: ${sandbox.cause}`,
			fix: sandbox.fix,
			since: sandbox.since,
		});
	}
	problems.push(...daemon.github.problems);
	// GitHub replies that couldn't be posted, for a day.
	for (const failed of daemon.db
		.query<
			{ id: number; at: number; title: string; error: string | null },
			[number]
		>(
			`SELECT m.id, m.at, th.title, m.delivery_error AS error FROM messages m
			JOIN threads th ON th.id = m.thread_id
			WHERE m.channel = 'github' AND m.delivery = 'failed' AND m.at > ?`,
		)
		.all(Date.now() - UNDELIVERED_MS)) {
		problems.push({
			id: `undelivered:${failed.id}`,
			kind: 'undelivered',
			text: `Couldn't comment on ${failed.title}: ${failed.error ?? 'unknown error'}`,
			fix: null,
			since: failed.at,
		});
	}
	// Open Watchdog findings that report.
	for (const finding of daemon.db
		.query<
			{
				key: string;
				kind: Problem['kind'];
				text: string;
				fix: string | null;
				since: number;
			},
			[]
		>(
			`SELECT key, problem_kind AS kind, text, fix, opened_at AS since
			FROM watchdog_findings
			WHERE state = 'open' AND problem_kind IS NOT NULL AND text IS NOT NULL
			ORDER BY id`,
		)
		.all()) {
		problems.push({
			id: finding.key,
			kind: finding.kind,
			text: finding.text,
			fix: finding.fix,
			since: finding.since,
		});
	}
	if (daemon.missingIdentity.length > 0) {
		warnings.push({
			id: 'git-identity',
			text: `git has no ${daemon.missingIdentity.join(' or ')} set, so Worker commits will fail`,
			fix: `${daemon.missingIdentity
				.map((key) =>
					key === 'user.name'
						? 'git config --global user.name "Your Name"'
						: 'git config --global user.email "you@example.com"',
				)
				.join(' && ')}, then restart the agent`,
			since: daemon.agent.startedAt,
		});
	}
	return {
		channels: [
			...[...daemon.channels]
				.filter(([name]) => name !== 'github')
				.map(([name, lastEventAt]) => ({
					name,
					state: 'up' as const,
					lastEventAt,
					detail: null,
				})),
			{
				name: 'github',
				state: daemon.github.state,
				lastEventAt: daemon.channels.get('github') ?? null,
				detail: daemon.github.detail,
			},
		],
		model: {
			name: MODEL,
			...daemon.model,
			key: daemon.keySource,
			keyRejected:
				daemon.model.state === 'paused' && daemon.model.detail === KEY_REJECTED,
		},
		problems,
		warnings,
		machine: daemon.machine,
		sandbox: sandbox.state,
		watchdog: {
			lastCheckAt: daemon.watchdog.lastCheckAt,
			reviewsToday:
				daemon.db
					.query<{ count: number }, [number]>(
						"SELECT COUNT(*) AS count FROM model_calls WHERE purpose = 'watchdog' AND started_at >= ?",
					)
					.get(dayStart(Date.now()))?.count ?? 0,
		},
		repos: daemon.config.repos.map((repo) => ({
			name: repo.name,
			path: canonical(repo.path),
		})),
	};
}

/** `path` with its symlinks resolved, or as given when it doesn't exist. */
export function canonical(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export function dayStart(now: number): number {
	const day = new Date(now);
	day.setHours(0, 0, 0, 0);
	return day.getTime();
}

/** The first `length` UTF-16 units of `text`, without splitting a surrogate pair. */
export function cut(text: string, length: number): string {
	if (text.length <= length) return text;
	const code = text.charCodeAt(length - 1);
	return text.slice(0, code >= 0xd800 && code <= 0xdbff ? length - 1 : length);
}
