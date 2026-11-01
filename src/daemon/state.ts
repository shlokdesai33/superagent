import type { Database } from 'bun:sqlite';
import { MODEL, type ParticleClient } from '../particle/client.ts';
import type {
	ActionResult,
	Health,
	MachineFacts,
	Message,
	RouterState,
	Snapshot,
	Usage,
} from '../protocol.ts';
import type { Feed } from './feed.ts';
import type { Log } from './log.ts';
import type { Config } from './setup.ts';

const CONSOLE_SNAPSHOT_MESSAGES = 50;
const FEED_MESSAGE_CHARS = 4_000;
const USAGE_INTERVAL_MS = 1_000;

/** Everything the daemon's handlers share. One per process. */
export type Daemon = {
	db: Database;
	feed: Feed;
	log: Log;
	/** The API token every request must send. */
	token: string;
	config: Config;
	agent: Snapshot['agent'];
	machine: MachineFacts;
	/** The last event time of each channel, for health. */
	channels: Map<string, number | null>;
	/** Action results by `requestId`, kept 10 minutes. */
	actionResults: Map<string, { at: number; result: ActionResult }>;
	usageTimer: Timer | null;
	/** `null` when there's no API key; the model stays paused. */
	particle: ParticleClient | null;
	model: Omit<Health['model'], 'name'>;
	router: RouterLive;
};

/** What the Router loop is doing right now; the rest of its state is in SQLite. */
export type RouterLive = {
	/** The open batch, while the Router is deciding. */
	batch: { id: number; since: number; size: number } | null;
	/** Tells the Router loop the mailbox may have changed. */
	wake: () => void;
};

export function buildSnapshot(daemon: Daemon): Snapshot {
	const now = Date.now();
	const start = dayStart(now);
	return {
		now,
		agent: daemon.agent,
		day: {
			start,
			timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
		},
		tasks: [],
		console: consoleMessages(daemon.db),
		router: routerState(daemon),
		usage: usageSince(daemon.db, start),
		health: health(daemon),
		observed: [],
	};
}

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
};

export const MESSAGE_COLUMNS = `m.id, m.at, m.channel, m.thread_id AS threadId,
	t.handle AS taskHandle, m.direction, m.author, m.text, m.delivery
	FROM messages m LEFT JOIN tasks t ON t.id = m.task_id`;

export function toMessage(row: MessageRow): Message {
	const text = cut(row.text, FEED_MESSAGE_CHARS);
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
	};
}

function consoleMessages(db: Database): Message[] {
	return db
		.query<MessageRow, [number]>(
			`SELECT ${MESSAGE_COLUMNS} WHERE m.thread_id = 'console' ORDER BY m.id DESC LIMIT ?`,
		)
		.all(CONSOLE_SNAPSHOT_MESSAGES)
		.toReversed()
		.map(toMessage);
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
	return {
		deciding: batch !== null,
		decidingSince: batch?.since ?? null,
		batchSize: batch?.size ?? 0,
		waiting,
		last: last ?? null,
	};
}

/** Publishes the Router's state. Call after its transaction commits. */
export function routerChanged(daemon: Daemon): number {
	return daemon.feed.publish({ type: 'router', router: routerState(daemon) });
}

/** Sets the model's health, publishing it when it changed. */
export function setModelHealth(
	daemon: Daemon,
	state: Health['model']['state'],
	detail: string | null,
): void {
	const current = daemon.model;
	if (current.state === state && current.detail === detail) return;
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
	daemon.feed.publish({ type: 'health', health: health(daemon) });
}

function usageSince(db: Database, since: number): Usage {
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
	return {
		channels: [...daemon.channels].map(([name, lastEventAt]) => ({
			name,
			state: 'up',
			lastEventAt,
			detail: null,
		})),
		model: { name: MODEL, ...daemon.model },
		problems:
			daemon.model.state === 'ok'
				? []
				: [
						{
							id: 'model',
							kind: 'model',
							text: daemon.model.detail ?? 'Particle is unavailable',
							since: daemon.model.since ?? Date.now(),
						},
					],
		machine: daemon.machine,
		proactive: 'off',
		sandbox: 'off',
	};
}

function dayStart(now: number): number {
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
