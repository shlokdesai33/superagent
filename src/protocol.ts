// The wire contract between the daemon and its clients (the TUI, `status`).
// All times are epoch milliseconds.

// Bumped whenever a field older clients read changes or goes away: 2 dropped
// `machine.tools`, which a version 1 terminal UI crashed without.
export const PROTOCOL_VERSION = '2';
export const PROTOCOL_HEADER = 'Superagent-Protocol';

export type FeedLine =
	| { type: 'snapshot'; seq: number; snapshot: Snapshot }
	| { type: 'task'; seq: number; task: TaskSummary }
	| { type: 'step'; seq: number; taskHandle: string; step: Step }
	| { type: 'message'; seq: number; message: Message }
	| { type: 'routed'; seq: number; event: RoutedEvent }
	| { type: 'router'; seq: number; router: RouterState }
	| { type: 'usage'; seq: number; usage: Usage }
	| { type: 'health'; seq: number; health: Health }
	| { type: 'ping'; now: number };

export type FeedUpdate = Exclude<
	FeedLine,
	{ type: 'snapshot' } | { type: 'ping' }
>;

export type Snapshot = {
	now: number;
	agent: { id: string; version: string; pid: number; startedAt: number };
	/** Local midnight, and the IANA zone it's in. */
	day: { start: number; timeZone: string };
	tasks: TaskSummary[];
	/** The last 50, oldest first. */
	console: Message[];
	router: RouterState;
	usage: Usage;
	health: Health;
};

export type TaskSummary = {
	handle: string;
	title: string;
	status: 'working' | 'waiting' | 'needs_you' | 'done' | 'failed' | 'stopped';
	/** Set when status is `waiting`. */
	waitingOn: string | null;
	/** Set when status is `working`. */
	now: { text: string; command: string | null; startedAt: number } | null;
	/** `{ 'console', null, null }` or `{ 'github', '#142', 'alice' }`. */
	origin: { channel: string; place: string | null; author: string | null };
	threads: Array<{
		id: string;
		channel: string;
		title: string;
		url: string | null;
	}>;
	/** Set when status is `needs_you`. */
	question: Question | null;
	/** done: the result; failed: the failure; stopped: `stopped by you`. */
	result: string | null;
	dismissed: boolean;
	createdAt: number;
	startedAt: number | null;
	endedAt: number | null;
	/** 8 counts: model calls per minute, oldest first. */
	activity: number[];
	/** Start of the minute `activity[7]` covers. */
	activityAt: number;
};

export type Question = {
	id: number;
	text: string;
	/** Markdown, for the task view. */
	context: string | null;
	options: string[] | null;
	askedAt: number;
};

export type Step = {
	id: number;
	kind: 'command' | 'edit' | 'note';
	text: string;
	command: string | null;
	status: 'running' | 'ok' | 'failed' | 'stopped';
	startedAt: number;
	endedAt: number | null;
	exitCode: number | null;
	additions: number | null;
	deletions: number | null;
	hasDiff: boolean;
	hasOutput: boolean;
};

export type Message = {
	id: number;
	at: number;
	channel: string;
	threadId: string | null;
	/** Set for notes, answers and replies tied to a task. */
	taskHandle: string | null;
	direction: 'in' | 'out';
	author: string;
	text: string;
	truncated: boolean;
	delivery: 'delivered' | 'pending' | 'failed';
	/**
	 * Set for a message that went to a task's Worker: when the Worker took it
	 * into its next step, `null` until it has.
	 */
	worker: { readAt: number | null } | null;
};

export type RoutedEvent = {
	/** The event number, shown as #42. */
	id: number;
	at: number;
	channel: string;
	threadTitle: string | null;
	author: string;
	/** The first 80 characters. */
	preview: string;
	destination:
		| { kind: 'task'; handle: string }
		| { kind: 'router' }
		| { kind: 'filtered'; reason: string };
};

export type RouterState = {
	deciding: boolean;
	decidingSince: number | null;
	/** Events in the batch being decided. */
	batchSize: number;
	/** Events in the mailbox, to be decided together next. */
	waiting: number;
	last: { text: string; at: number } | null;
	/**
	 * Why the Router isn't deciding its waiting events: no Particle key, or a
	 * failure it's waiting out until `until` (`null`: until a key is saved).
	 */
	held: { reason: string; until: number | null } | null;
	/** Console messages still in the mailbox, the last 50, oldest first. */
	pending: number[];
};

/** Since local midnight. Costs are estimates. */
export type Usage = {
	since: number;
	calls: number;
	/** Includes cached tokens. */
	inputTokens: number;
	cachedTokens: number;
	/** Includes reasoning tokens. */
	outputTokens: number;
	reasoningTokens: number;
	costUsd: number;
};

export type Health = {
	channels: Array<{
		name: string;
		/** `off`: an optional channel that isn't set up or is turned off; `detail` says what's missing. Never a problem. */
		state: 'up' | 'connecting' | 'down' | 'off';
		lastEventAt: number | null;
		detail: string | null;
	}>;
	model: {
		/** The only model the agent will ever support. */
		name: 'particle-1';
		state: 'ok' | 'paused' | 'error';
		detail: string | null;
		since: number | null;
		/** Where the Particle key comes from; never the key itself. */
		key: KeySource;
		/** Particle rejected the key in use; a new key resumes the model. */
		keyRejected: boolean;
	};
	/** Failed tasks are tasks, not problems. */
	problems: Problem[];
	/** Optional add-ons that are missing; the agent works without them. */
	warnings: Warning[];
	machine: MachineFacts;
	/** `off` comes with a `sandbox` warning: commands run unsandboxed. */
	sandbox: 'on' | 'off';
	watchdog: {
		/** The Watchdog's last round of checks; `null` before the first. */
		lastCheckAt: number | null;
		/** Its model calls since local midnight. */
		reviewsToday: number;
	};
	/** Where code tasks can work, from `config.json`, in its order. */
	repos: Repository[];
};

/** `path` has its symlinks resolved, like `git rev-parse --show-toplevel`. */
export type Repository = { name: string; path: string };

/** `env` is `PARTICLE_API_KEY`, `file` the `particle-key` file in the data folder. */
export type KeySource = 'env' | 'file' | 'missing';

export type MachineFacts = {
	os: string;
	arch: string;
};

export type Problem = {
	/** Stable, for fades: `model`, `undelivered:812`, `router:stalled`. */
	id: string;
	/** `task` and `agent` come from the Watchdog. */
	kind: 'model' | 'channel' | 'undelivered' | 'task' | 'agent';
	text: string;
	/** What to run or do to fix it, when the agent knows. */
	fix: string | null;
	since: number;
};

export type Warning = {
	/** Stable: `sandbox`, `git-identity`. */
	id: string;
	text: string;
	/** What to run or do to fix it. */
	fix: string | null;
	since: number;
};

/** `GET /v1/tasks/:handle`. */
export type TaskDetail = {
	/** The feed sequence this was read at. */
	seq: number;
	task: TaskSummary;
	/** All, oldest first. */
	steps: Step[];
	/** Every followed thread plus notes and answers, oldest first, the last 500. */
	conversation: Message[];
	/** Markdown. */
	report: string | null;
	workDir: string;
	branch: string | null;
};

/** `requestId` is unique per attempt; a resent request gets the original result. */
export type ActionRequest = { requestId: string; action: Action };

export type Action =
	| {
			type: 'send_console';
			text: string;
			/**
			 * The top of a git repository, where tasks the Router starts from this
			 * message work unless it names another. Added to `config.json` when
			 * it isn't there yet.
			 */
			repo?: string | null;
			/**
			 * The folder the terminal UI was opened in, where the Router looks for
			 * a repository the message names by folder name or relative path.
			 */
			cwd?: string | null;
	  }
	| { type: 'send_note'; handle: string; text: string }
	| {
			type: 'answer_question';
			handle: string;
			questionId: number;
			text: string;
	  }
	| { type: 'stop_task'; handle: string }
	/** `null`: every failed task. */
	| { type: 'resume_tasks'; handles: string[] | null };

/** Maps onto a toast: `✓ <subject> · <detail>`. */
export type ActionResult =
	| { ok: true; seq: number; subject: string; detail: string | null }
	| { ok: false; code: string; subject: string; detail: string | null };

export type ErrorBody = { error: { code: string; message: string } };
