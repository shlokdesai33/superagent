import { Database } from 'bun:sqlite';
import { StartupError } from './setup.ts';

// Applied in order; `PRAGMA user_version` counts how many have run. Never edit
// one that has shipped: add a new one.
const MIGRATIONS = [
	`
CREATE TABLE meta (
	key   TEXT PRIMARY KEY,
	value TEXT NOT NULL
);

CREATE TABLE tasks (
	id               INTEGER PRIMARY KEY,
	handle           TEXT NOT NULL UNIQUE,
	title            TEXT NOT NULL,
	instructions     TEXT NOT NULL,
	state            TEXT NOT NULL,
	waiting_on       TEXT,
	origin_event_id  INTEGER REFERENCES events(id),
	repo             TEXT,
	work_dir         TEXT NOT NULL,
	branch           TEXT,
	result           TEXT,
	report           TEXT,
	failure          TEXT,
	dismissed        INTEGER NOT NULL DEFAULT 0,
	model_calls      INTEGER NOT NULL DEFAULT 0,
	created_at       INTEGER NOT NULL,
	started_at       INTEGER,
	ended_at         INTEGER,
	updated_at       INTEGER NOT NULL,
	last_progress_at INTEGER
);

CREATE TABLE threads (
	id            TEXT PRIMARY KEY,
	channel       TEXT NOT NULL,
	title         TEXT NOT NULL,
	url           TEXT,
	ownable       INTEGER NOT NULL DEFAULT 1,
	owner_task_id INTEGER REFERENCES tasks(id),
	created_at    INTEGER NOT NULL,
	last_event_at INTEGER
);

CREATE TABLE task_threads (
	task_id   INTEGER NOT NULL REFERENCES tasks(id),
	thread_id TEXT NOT NULL REFERENCES threads(id),
	since     INTEGER NOT NULL,
	PRIMARY KEY (task_id, thread_id)
);

CREATE TABLE router_batches (
	id         INTEGER PRIMARY KEY,
	state      TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	ended_at   INTEGER,
	summary    TEXT
);

CREATE TABLE events (
	id            INTEGER PRIMARY KEY,
	received_at   INTEGER NOT NULL,
	channel       TEXT NOT NULL,
	external_id   TEXT,
	thread_id     TEXT REFERENCES threads(id),
	kind          TEXT NOT NULL,
	author        TEXT NOT NULL,
	author_id     TEXT,
	is_bot        INTEGER NOT NULL DEFAULT 0,
	text          TEXT NOT NULL,
	data          TEXT,
	route         TEXT NOT NULL,
	task_id       INTEGER REFERENCES tasks(id),
	filter_reason TEXT,
	batch_id      INTEGER REFERENCES router_batches(id),
	consumed_at   INTEGER,
	UNIQUE (channel, external_id)
);
CREATE INDEX events_unconsumed ON events (route, task_id) WHERE consumed_at IS NULL;

CREATE TABLE messages (
	id             INTEGER PRIMARY KEY,
	at             INTEGER NOT NULL,
	channel        TEXT NOT NULL,
	thread_id      TEXT REFERENCES threads(id),
	task_id        INTEGER REFERENCES tasks(id),
	direction      TEXT NOT NULL,
	author         TEXT NOT NULL,
	text           TEXT NOT NULL,
	event_id       INTEGER REFERENCES events(id),
	batch_id       INTEGER REFERENCES router_batches(id),
	delivery       TEXT NOT NULL,
	delivery_error TEXT,
	attempts       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE questions (
	id              INTEGER PRIMARY KEY,
	task_id         INTEGER NOT NULL REFERENCES tasks(id),
	text            TEXT NOT NULL,
	context         TEXT,
	options         TEXT,
	state           TEXT NOT NULL,
	asked_at        INTEGER NOT NULL,
	answer          TEXT,
	answered_by     TEXT,
	answered_at     INTEGER,
	answer_event_id INTEGER REFERENCES events(id)
);

CREATE TABLE steps (
	id         INTEGER PRIMARY KEY,
	task_id    INTEGER NOT NULL REFERENCES tasks(id),
	kind       TEXT NOT NULL,
	text       TEXT NOT NULL,
	command    TEXT,
	status     TEXT NOT NULL,
	started_at INTEGER NOT NULL,
	ended_at   INTEGER,
	exit_code  INTEGER,
	pgid       INTEGER,
	additions  INTEGER,
	deletions  INTEGER,
	diff       TEXT
);

CREATE TABLE sessions (
	id                INTEGER PRIMARY KEY,
	kind              TEXT NOT NULL,
	task_id           INTEGER UNIQUE REFERENCES tasks(id),
	summary           TEXT,
	compacted_through INTEGER NOT NULL DEFAULT 0,
	created_at        INTEGER NOT NULL
);

CREATE TABLE session_items (
	session_id INTEGER NOT NULL REFERENCES sessions(id),
	seq        INTEGER NOT NULL,
	at         INTEGER NOT NULL,
	item       TEXT NOT NULL,
	PRIMARY KEY (session_id, seq)
);

CREATE TABLE model_calls (
	id                INTEGER PRIMARY KEY,
	session_id        INTEGER REFERENCES sessions(id),
	task_id           INTEGER REFERENCES tasks(id),
	purpose           TEXT NOT NULL,
	model             TEXT NOT NULL,
	effort            TEXT NOT NULL,
	started_at        INTEGER NOT NULL,
	ended_at          INTEGER,
	prompt_tokens     INTEGER,
	cached_tokens     INTEGER,
	completion_tokens INTEGER,
	reasoning_tokens  INTEGER,
	service_tier      TEXT,
	cost_usd          REAL,
	request_id        TEXT,
	error             TEXT
);
CREATE INDEX model_calls_by_time ON model_calls (started_at);
`,
	'ALTER TABLE model_calls DROP COLUMN model;',
	`
CREATE TABLE github_cursors (
	key        TEXT PRIMARY KEY,
	since      TEXT,
	etag       TEXT,
	updated_at INTEGER NOT NULL
);

CREATE TABLE github_items (
	thread_id  TEXT PRIMARY KEY REFERENCES threads(id),
	repo       TEXT NOT NULL,
	number     INTEGER NOT NULL,
	is_pr      INTEGER NOT NULL,
	title      TEXT NOT NULL,
	state      TEXT NOT NULL,
	head_sha   TEXT,
	ci_outcome TEXT,
	summary    TEXT,
	polled_at  INTEGER NOT NULL,
	updated_at TEXT NOT NULL
);
`,
	`
ALTER TABLE messages ADD COLUMN external_id TEXT;
ALTER TABLE messages ADD COLUMN reply_to INTEGER REFERENCES events(id);
`,
	'ALTER TABLE github_cursors ADD COLUMN page INTEGER;',
	`
CREATE TABLE watchdog_findings (
	id           INTEGER PRIMARY KEY,
	key          TEXT NOT NULL,
	task_id      INTEGER REFERENCES tasks(id),
	state        TEXT NOT NULL,
	opened_at    INTEGER NOT NULL,
	seen_at      INTEGER NOT NULL,
	resolved_at  INTEGER,
	problem_kind TEXT,
	text         TEXT,
	fix          TEXT,
	stage        TEXT,
	snooze_calls INTEGER,
	snooze_until INTEGER
);
CREATE UNIQUE INDEX watchdog_open ON watchdog_findings (key) WHERE state = 'open';
`,
	`
ALTER TABLE tasks ADD COLUMN progress_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE questions ADD COLUMN asked_by TEXT NOT NULL DEFAULT 'worker';
`,
];

// Letters and digits without look-alikes (no i, l, o, 0 or 1).
const ID_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

export function openDatabase(path: string): Database {
	const db = new Database(path, { create: true, strict: true });
	db.run('PRAGMA journal_mode = WAL');
	db.run('PRAGMA synchronous = NORMAL');
	db.run('PRAGMA foreign_keys = ON');
	db.run('PRAGMA busy_timeout = 5000');

	const applied =
		db.query<{ user_version: number }, []>('PRAGMA user_version').get()
			?.user_version ?? 0;
	if (applied > MIGRATIONS.length) {
		db.close();
		throw new StartupError(
			`${path} was written by a newer version of the agent (schema ${applied}, this version knows ${MIGRATIONS.length})`,
		);
	}
	for (const [index, sql] of MIGRATIONS.entries()) {
		if (index < applied) continue;
		db.transaction(() => {
			db.run(sql);
			db.run(`PRAGMA user_version = ${index + 1}`);
		})();
	}
	return db;
}

/** Reads the agent ID from `meta`, creating it on first start. */
export function loadAgentId(db: Database): string {
	const existing = db
		.query<{ value: string }, [string]>('SELECT value FROM meta WHERE key = ?')
		.get('agent_id');
	if (existing) return existing.value;
	const id = `ag_${randomId(8)}`;
	const insert = db.query<unknown, [string, string]>(
		'INSERT INTO meta (key, value) VALUES (?, ?)',
	);
	db.transaction(() => {
		insert.run('agent_id', id);
		insert.run('created_at', String(Date.now()));
	})();
	return id;
}

function randomId(length: number): string {
	// Rejecting the top of the byte range keeps every character equally likely.
	const limit = 256 - (256 % ID_ALPHABET.length);
	let id = '';
	while (id.length < length) {
		for (const byte of crypto.getRandomValues(new Uint8Array(length))) {
			if (byte < limit && id.length < length) {
				id += ID_ALPHABET[byte % ID_ALPHABET.length];
			}
		}
	}
	return id;
}
