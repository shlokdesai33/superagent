import { mkdirSync } from 'node:fs';
import {
	DaemonUnreachable,
	fetchStepDiff,
	fetchTaskDetail,
	postAction,
} from '../client.ts';
import { dataPaths } from '../home.ts';
import { writeKeyFile } from '../keys.ts';
import { checkApiKey, looksLikeApiKey } from '../particle/client.ts';
import type {
	Action,
	ActionResult,
	FeedLine,
	Step,
	TaskDetail,
	TaskSummary,
} from '../protocol.ts';
import { connect } from './connection.ts';
import {
	backspace,
	clear,
	deleteForward,
	deleteWord,
	insert,
	left,
	right,
	vertical,
} from './draft.ts';
import type { InputEvent, KeyName } from './input.ts';
import {
	type Connection,
	type Item,
	MORE_KEY,
	type Model,
	apply,
	fromSnapshot,
	homeItems,
	linkOf,
	placeOf,
	sectionOf,
	stoppable,
} from './model.ts';
import { FRAME_MS } from './parts.ts';
import { repoChoices } from './repo.ts';
import {
	FADE_MS,
	type KeyScreen,
	type Toast,
	type Ui,
	doneShown,
	drafting,
	emptyTyping,
	mergedSteps,
	toRouter,
	typed,
} from './state.ts';
import type { Terminal } from './terminal.ts';
import { type Theme, backgroundFromOsc11 } from './theme.ts';
import { statusPhrase, view } from './view.ts';

const IDLE_MS = 500;
const TOAST_MS = 5_000;
const ERROR_TOAST_MS = 8_000;
const ARRIVAL_KEPT_MS = 1_000;
/** How long a toast waits for the feed to catch up with its action. */
const TOAST_WAIT_MS = 2_000;
const PAGE = 5;

type PendingToast = {
	toast: Omit<Toast, 'at'>;
	seq: number;
	generation: number;
	until: number;
};

export class App {
	private readonly model: Model;
	private readonly ui: Ui;
	private readonly terminal: Terminal;
	private pending: PendingToast[] = [];
	private timer: Timer | null = null;
	private soon = false;
	private closed = false;
	private readonly detailRequests = new Map<string, number>();
	/** The key problem the key screen last opened for, so it opens once per problem. */
	private keyPrompted: KeyScreen['reason'] | null = null;
	private keyAttempts = 0;
	/** The phrase on screen now, to fade out when it changes. */
	private lastPhrase = statusPhrase({
		connection: { state: 'connecting' },
		live: null,
	}).segs;
	private stop: () => void = () => {};
	private finish: () => void = () => {};
	readonly done: Promise<void>;

	constructor(terminal: Terminal, theme: Theme, startedIn: string | null) {
		this.terminal = terminal;
		this.model = {
			connection: { state: 'connecting' },
			live: null,
		};
		const now = Date.now();
		this.ui = {
			theme,
			screen: { name: 'home' },
			selected: null,
			selectedIndex: 0,
			scroll: { home: 0, page: 0, free: false },
			overflow: { above: false, below: false },
			done: { fits: null, expanded: false },
			draftRows: [0],
			typing: emptyTyping(),
			confirmStop: null,
			confirmQuit: false,
			toast: null,
			arrivals: [],
			leaving: [],
			appeared: new Map(),
			status: {
				key: statusPhrase(this.model).key,
				changedAt: now - FADE_MS,
				previous: null,
			},
			details: new Map(),
			repo: { startedIn, path: startedIn },
		};
		this.done = new Promise((resolve) => {
			this.finish = resolve;
		});
	}

	start(): void {
		this.terminal.listen((event) => this.onInput(event));
		this.terminal.onResize(() => {
			this.terminal.invalidate();
			this.frame();
		});
		this.stop = connect({
			line: (line) => this.onLine(line),
			connection: (connection) => this.onConnection(connection),
		});
		this.frame();
	}

	quit(): void {
		this.closed = true;
		this.stop();
		if (this.timer) clearTimeout(this.timer);
		this.finish();
	}

	// ---- feed ----

	private onConnection(connection: Connection): void {
		const previous = this.model.connection;
		this.model.connection =
			connection.state === 'offline' && previous.state === 'offline'
				? { ...connection, since: previous.since }
				: connection;
		this.ui.arrivals = [];
		this.statusChanged();
		this.render();
	}

	private onLine(line: FeedLine): void {
		const now = Date.now();
		if (line.type === 'snapshot') {
			this.model.live = fromSnapshot(line.snapshot, line.seq, now);
			// Sequences restart with each connection: every new feed line is
			// newer than a detail read before it.
			for (const state of this.ui.details.values()) {
				if (state.detail) state.detail = { ...state.detail, seq: -1 };
			}
			this.ui.leaving = [];
			this.ui.appeared.clear();
			const { screen } = this.ui;
			if (screen.name === 'task') this.loadDetail(screen.handle);
		} else if (this.model.live) {
			const live = this.model.live;
			const problemsBefore = new Set(live.health.problems.map((p) => p.id));
			const before =
				line.type === 'task' ? live.tasks.get(line.task.handle) : undefined;
			const place = before ? placeOf(live, before) : null;
			const applied = apply(live, line, now);
			if (applied.kind === 'task') {
				// The report and the full steps arrive only with the detail, and a
				// task writes its report as it ends.
				const { screen } = this.ui;
				if (
					screen.name === 'task' &&
					screen.handle === applied.after.handle &&
					applied.before?.status !== applied.after.status
				) {
					this.loadDetail(applied.after.handle);
				}
				const after = sectionOf(applied.after, live.day.start);
				if (place && place.section !== after) {
					this.ui.leaving.push({
						task: before ?? applied.after,
						...place,
						at: now,
					});
				}
				if (after === 'needs' && place?.section !== 'needs') {
					this.ui.appeared.set(`task:${applied.after.handle}`, now);
				}
			} else if (
				applied.kind === 'routed' &&
				applied.event.destination.kind === 'task' &&
				this.ui.screen.name === 'home'
			) {
				this.ui.arrivals.push({
					at: now,
					handle: applied.event.destination.handle,
				});
			}
			if (line.type === 'health') {
				for (const problem of live.health.problems) {
					if (!problemsBefore.has(problem.id)) {
						this.ui.appeared.set(`problem:${problem.id}`, now);
					}
				}
			}
			if (line.type === 'step') this.maybeLoadDiff(line.taskHandle, line.step);
		}
		if (line.type === 'snapshot' || line.type === 'health') this.promptForKey();
		this.flushToasts(now);
		this.statusChanged();
		this.render();
	}

	private statusChanged(): void {
		const phrase = statusPhrase(this.model);
		if (phrase.key === this.ui.status.key) return;
		const previous = this.ui.status;
		const now = Date.now();
		this.ui.status = {
			key: phrase.key,
			changedAt: now,
			// Only a settled phrase fades out; mid-fade it's replaced at once.
			previous: now - previous.changedAt >= FADE_MS ? this.lastPhrase : null,
		};
		this.lastPhrase = phrase.segs;
	}

	// ---- Particle key ----

	/**
	 * Opens the key screen when the agent has no key, or Particle rejected the
	 * one in the key file: once per problem, so skipping it sticks until the
	 * problem clears and comes back. A rejected `PARTICLE_API_KEY` is left to
	 * health, since the file wouldn't be used. It opens even mid-draft; the
	 * draft is kept for when you leave it.
	 */
	private promptForKey(): void {
		const { live, connection } = this.model;
		if (live === null || connection.state !== 'live') return;
		const { model } = live.health;
		const need =
			model.key === 'missing'
				? 'missing'
				: model.key === 'file' && model.keyRejected
					? 'rejected'
					: null;
		if (need === null) {
			this.keyPrompted = null;
			return;
		}
		if (need === this.keyPrompted) return;
		this.keyPrompted = need;
		if (this.ui.screen.name !== 'key') this.openKeyScreen(need);
	}

	private openKeyScreen(reason: KeyScreen['reason']): void {
		const { screen } = this.ui;
		if (screen.name === 'key') return;
		this.ui.confirmStop = null;
		this.ui.confirmQuit = false;
		this.ui.screen = {
			name: 'key',
			reason,
			back: screen,
			keyFile: dataPaths().particleKey,
			text: '',
			checking: null,
			error: null,
		};
	}

	private onKeyInput(event: InputEvent, screen: KeyScreen): void {
		if (event.kind === 'key' && event.name === 'escape') {
			this.ui.screen = screen.back;
			return;
		}
		if (screen.checking !== null) return;
		const before = screen.text;
		if (event.kind === 'char') screen.text += event.ch.replaceAll(/\s/g, '');
		else if (event.kind === 'paste')
			screen.text += event.text.replaceAll(/\s/g, '');
		else if (event.kind === 'ctrl' && event.letter === 'u') screen.text = '';
		else if (event.kind === 'key' && event.name === 'backspace')
			screen.text = Array.from(screen.text).slice(0, -1).join('');
		else if (event.kind === 'key' && event.name === 'enter') {
			void this.saveKey(screen);
			return;
		}
		if (screen.text !== before) screen.error = null;
	}

	/**
	 * Checks the key with Particle's free `GET /models`, then writes the key
	 * file the agent watches. Nothing is saved unless Particle accepts it.
	 */
	private async saveKey(screen: KeyScreen): Promise<void> {
		const key = screen.text;
		const fail = (subject: string, detail: string | null, keep = false) => {
			if (!keep) screen.text = '';
			screen.error = { subject, detail };
		};
		if (key === '') {
			fail('Paste your key first', null);
			return;
		}
		if (!looksLikeApiKey(key)) {
			fail("That isn't a Particle API key", 'they start with pai-');
			return;
		}
		this.keyAttempts += 1;
		const attempt = this.keyAttempts;
		screen.checking = { since: Date.now(), attempt };
		screen.error = null;
		this.render();
		const baseUrl = Bun.env.PARTICLE_BASE_URL;
		const check = await checkApiKey(
			baseUrl ? { apiKey: key, baseUrl } : { apiKey: key },
		);
		// Left with esc, or a newer try, while Particle answered.
		if (this.ui.screen !== screen || screen.checking?.attempt !== attempt) {
			return;
		}
		screen.checking = null;
		if (check.result === 'rejected') {
			fail('Particle rejected this key', 'paste another');
		} else if (check.result === 'unchecked') {
			fail("Couldn't reach Particle", 'enter tries again', true);
		} else {
			const paths = dataPaths();
			try {
				mkdirSync(paths.home, { recursive: true, mode: 0o700 });
				writeKeyFile(screen.keyFile, key);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				fail(
					"Couldn't save the key",
					message.replaceAll(key, '[redacted]'),
					true,
				);
				this.render();
				return;
			}
			screen.text = '';
			this.ui.screen = screen.back;
			const env = this.model.live?.health.model.key === 'env';
			this.showToast({
				glyph: '✓',
				subject: 'Saved the key',
				detail: env ? 'PARTICLE_API_KEY overrides it' : null,
				ms: TOAST_MS,
			});
		}
		this.render();
	}

	// ---- task detail ----

	private loadDetail(handle: string): void {
		void this.fetchDetail(handle);
	}

	/**
	 * Only the latest request for a handle writes its result, and a failure
	 * keeps a detail already on screen.
	 */
	private async fetchDetail(handle: string): Promise<void> {
		const request = (this.detailRequests.get(handle) ?? 0) + 1;
		this.detailRequests.set(handle, request);
		const previous = this.ui.details.get(handle);
		const diffs = previous?.diffs ?? new Map<number, string | null>();
		this.ui.details.set(handle, {
			state: 'loading',
			detail: previous?.detail ?? null,
			diffs,
		});
		let detail: TaskDetail | null = null;
		try {
			detail = await fetchTaskDetail(handle);
		} catch {
			// The feed's steps and messages still fill the view.
		}
		if (this.detailRequests.get(handle) !== request) return;
		const shown = detail ?? this.ui.details.get(handle)?.detail ?? null;
		this.ui.details.set(handle, {
			state: shown ? 'ready' : 'missing',
			detail: shown,
			diffs,
		});
		for (const step of mergedSteps(shown, this.model.live?.steps.get(handle))) {
			this.maybeLoadDiff(handle, step);
		}
		this.render();
	}

	/** `diffs` holds a step's diff, or `null` while it loads. */
	private maybeLoadDiff(handle: string, step: Step): void {
		const { screen } = this.ui;
		if (screen.name !== 'task' || screen.handle !== handle) return;
		if (!step.hasDiff || step.status === 'running') return;
		const state = this.ui.details.get(handle);
		if (!state || state.diffs.has(step.id)) return;
		state.diffs.set(step.id, null);
		void this.fetchDiff(state.diffs, handle, step.id);
	}

	/** A failed or empty fetch is forgotten, so the next detail load retries it. */
	private async fetchDiff(
		diffs: Map<number, string | null>,
		handle: string,
		stepId: number,
	): Promise<void> {
		let diff: string | null = null;
		try {
			diff = await fetchStepDiff(handle, stepId);
		} catch {
			// Retried with the next detail load.
		}
		if (diff === null) diffs.delete(stepId);
		else diffs.set(stepId, diff);
		this.render();
	}

	// ---- actions and toasts ----

	private act(action: Action): void {
		void this.runAction(action);
	}

	private async runAction(action: Action): Promise<void> {
		let result: ActionResult;
		try {
			result = await postAction(action);
		} catch (error) {
			this.showToast({
				glyph: '✗',
				subject: "Couldn't reach the agent",
				detail: error instanceof DaemonUnreachable ? null : String(error),
				ms: ERROR_TOAST_MS,
			});
			return;
		}
		this.onResult(result);
	}

	private onResult(result: ActionResult): void {
		if (!result.ok) {
			this.showToast({
				glyph: '✗',
				subject: result.subject,
				detail: result.detail,
				ms: ERROR_TOAST_MS,
			});
			return;
		}
		const toast = {
			glyph: '✓' as const,
			subject: result.subject,
			detail: result.detail,
			ms: TOAST_MS,
		};
		const { connection, live } = this.model;
		if (connection.state === 'live' && live && live.seq < result.seq) {
			// Wait for the screen change, so the toast never arrives ahead of it.
			this.pending.push({
				toast,
				seq: result.seq,
				generation: connection.generation,
				until: Date.now() + TOAST_WAIT_MS,
			});
			this.render();
			return;
		}
		this.showToast(toast);
	}

	private flushToasts(now: number): void {
		const { connection, live } = this.model;
		const ready = this.pending.filter(
			(entry) =>
				now >= entry.until ||
				connection.state !== 'live' ||
				connection.generation !== entry.generation ||
				(live !== null && live.seq >= entry.seq),
		);
		if (ready.length === 0) return;
		this.pending = this.pending.filter((entry) => !ready.includes(entry));
		for (const entry of ready) this.showToast(entry.toast);
	}

	private showToast(toast: Omit<Toast, 'at'>): void {
		this.ui.toast = { ...toast, at: Date.now() };
		this.render();
	}

	// ---- input ----

	private onInput(event: InputEvent): void {
		if (event.kind === 'focus') {
			if (event.gained) this.terminal.queryBackground();
			return;
		}
		if (event.kind === 'background') {
			const background = backgroundFromOsc11(event.reply);
			const { bg } = this.ui.theme;
			if (
				background &&
				(background[0] !== bg[0] ||
					background[1] !== bg[1] ||
					background[2] !== bg[2])
			) {
				this.ui.theme = this.terminal.themeFor(background);
				this.terminal.invalidate();
				this.render();
			}
			return;
		}
		if (event.kind === 'attributes') return;
		const { screen } = this.ui;
		// The key screen takes every key for the key; the draft waits behind it.
		if (screen.name === 'key') {
			if (event.kind === 'ctrl' && event.letter === 'c') this.quit();
			else {
				this.onKeyInput(event, screen);
				this.render();
			}
			return;
		}
		if (event.kind === 'ctrl' && event.letter === 'c') {
			if (this.ui.confirmQuit || !drafting(this.ui)) {
				this.quit();
				return;
			}
			this.ui.confirmQuit = true;
			this.ui.confirmStop = null;
			this.render();
			return;
		}
		const escape = event.kind === 'key' && event.name === 'escape';
		// A pending question is cancelled by any other key, which still acts,
		// except esc, which only cancels.
		const asked = this.ui.confirmQuit || this.ui.confirmStop !== null;
		const stop = this.ui.confirmStop;
		this.ui.confirmQuit = false;
		this.ui.confirmStop = null;
		if (stop !== null && event.kind === 'ctrl' && event.letter === 'x') {
			this.act({ type: 'stop_task', handle: stop });
		} else if (!(asked && escape)) {
			this.onKey(event);
		}
		this.render();
	}

	private onKey(event: InputEvent): void {
		const { typing } = this.ui;
		if (event.kind === 'char') {
			if (event.ch === '?' && !drafting(this.ui)) this.toggleKeys();
			else insert(typing, event.ch);
		} else if (event.kind === 'paste') {
			insert(typing, event.text.replaceAll(/\r\n|\r|\n|\t/g, ' '));
		} else if (event.kind === 'ctrl') {
			this.onCtrl(event.letter);
		} else if (event.kind === 'key') {
			this.onNamedKey(event.name);
		}
	}

	private onNamedKey(name: KeyName): void {
		const { typing } = this.ui;
		// Spaces alone are nothing typed, here as in the box and the hint.
		const written = typed(this.ui);
		switch (name) {
			case 'enter':
				if (written) this.send();
				else {
					clear(typing);
					this.open();
				}
				break;
			case 'escape':
				if (written) clear(typing);
				else if (typing.mode === 'answer') this.ui.typing = emptyTyping();
				else {
					clear(typing);
					this.back();
				}
				break;
			case 'tab':
				this.nextRepo();
				break;
			case 'backspace':
				backspace(typing);
				break;
			case 'delete':
				deleteForward(typing);
				break;
			case 'left':
				left(typing);
				break;
			case 'right':
				right(typing);
				break;
			case 'home':
				typing.cursor = 0;
				break;
			case 'end':
				typing.cursor = typing.text.length;
				break;
			case 'up':
				if (written) vertical(typing, this.ui.draftRows, -1);
				else this.move(-1);
				break;
			case 'down':
				if (written) vertical(typing, this.ui.draftRows, 1);
				else this.move(1);
				break;
			case 'pageup':
				this.move(-PAGE);
				break;
			case 'pagedown':
				this.move(PAGE);
				break;
		}
	}

	/**
	 * Letters type, so actions are on ctrl chords that terminals pass through:
	 * not ctrl-s / ctrl-q (flow control), nor ctrl-h / ctrl-i / ctrl-m, which
	 * arrive as backspace, tab and enter.
	 */
	private onCtrl(letter: string): void {
		const { typing, screen } = this.ui;
		switch (letter) {
			case 'u':
				clear(typing);
				break;
			case 'w':
				deleteWord(typing);
				break;
			case 'a':
				typing.cursor = 0;
				break;
			case 'e':
				typing.cursor = typing.text.length;
				break;
			case 't':
				this.ui.screen = { name: 'health' };
				this.ui.scroll.page = 0;
				break;
			case 'o': {
				const task = this.focusedTask();
				if (task && screen.name === 'task') this.openLink(task);
				else if (task) this.openTask(task.handle);
				break;
			}
			case 'x': {
				const task = this.focusedTask();
				if (task && stoppable(task)) this.ui.confirmStop = task.handle;
				break;
			}
			case 'r':
				if (screen.name === 'health') {
					this.act({ type: 'resume_tasks', handles: null });
				}
				break;
			case 'k':
				if (screen.name === 'health') {
					this.openKeyScreen(
						this.model.live?.health.model.key === 'missing'
							? 'missing'
							: 'replace',
					);
				}
				break;
		}
	}

	private send(): void {
		const typing = this.ui.typing;
		this.ui.typing = emptyTyping();
		const text = typing.text.trim();
		if (text === '') return;
		if (
			typing.mode === 'answer' &&
			typing.handle !== null &&
			typing.questionId !== null
		) {
			this.act({
				type: 'answer_question',
				handle: typing.handle,
				questionId: typing.questionId,
				text,
			});
			return;
		}
		const mention = text.match(/^@(\S+)\s*([\s\S]*)$/);
		if (mention) {
			this.act({
				type: 'send_note',
				handle: mention[1] ?? '',
				text: mention[2] ?? '',
			});
			return;
		}
		const { screen, repo } = this.ui;
		if (screen.name === 'task') {
			this.act({ type: 'send_note', handle: screen.handle, text });
			return;
		}
		this.act({
			type: 'send_console',
			text,
			...(repo.path === null ? {} : { repo: repo.path }),
		});
	}

	/** Tab while writing to the Router: the next default repository, or none. */
	private nextRepo(): void {
		if (!toRouter(this.ui)) return;
		const { repo } = this.ui;
		const choices = repoChoices(
			repo.startedIn,
			this.model.live?.health.repos ?? [],
		);
		if (choices.length === 0) return;
		const index = choices.indexOf(repo.path);
		repo.path = choices[(index + 1) % choices.length] ?? null;
	}

	private answer(handle: string): boolean {
		const task = this.model.live?.tasks.get(handle);
		if (task?.status !== 'needs_you' || !task.question) return false;
		this.ui.typing = {
			mode: 'answer',
			handle,
			questionId: task.question.id,
			text: '',
			cursor: 0,
		};
		return true;
	}

	/** Enter with nothing typed: answer, open the task, or health for a problem. */
	private open(): void {
		if (this.ui.typing.mode === 'answer') return;
		const { screen } = this.ui;
		if (screen.name === 'task') {
			this.answer(screen.handle);
			return;
		}
		if (screen.name !== 'home') return;
		const item = this.selectedItem();
		if (item?.kind === 'more') {
			this.expandDone();
		} else if (item?.kind === 'problem') {
			this.ui.screen = { name: 'health' };
			this.ui.scroll.page = 0;
		} else if (item?.kind === 'task' && !this.answer(item.task.handle)) {
			this.openTask(item.task.handle);
		}
	}

	/** The task open in the task view, or selected on home. */
	private focusedTask(): TaskSummary | null {
		const { screen } = this.ui;
		if (screen.name === 'task') {
			return this.model.live?.tasks.get(screen.handle) ?? null;
		}
		if (screen.name !== 'home') return null;
		const item = this.selectedItem();
		return item?.kind === 'task' ? item.task : null;
	}

	private selectedItem(): Item | null {
		const live = this.model.live;
		if (!live) return null;
		this.syncSelection();
		return (
			homeItems(live, doneShown(this.ui)).find(
				(item) => item.key === this.ui.selected,
			) ?? null
		);
	}

	/** Moves the selection on home; scrolls the other screens. */
	private move(step: number): void {
		if (this.ui.screen.name !== 'home') {
			this.ui.scroll.page = Math.max(0, this.ui.scroll.page + step);
			return;
		}
		const live = this.model.live;
		if (!live) return;
		const items = homeItems(live, doneShown(this.ui));
		this.syncSelection();
		const { scroll, overflow } = this.ui;
		if (step > 0 && overflow.below) {
			scroll.free = true;
			scroll.home += step;
			return;
		}
		if (step < 0 && overflow.above && (scroll.free || items.length === 0)) {
			scroll.home = Math.max(0, scroll.home + step);
			return;
		}
		scroll.free = false;
		const index = Math.max(
			0,
			Math.min(items.length - 1, this.ui.selectedIndex + step),
		);
		this.ui.selectedIndex = index;
		this.ui.selected = items[index]?.key ?? null;
	}

	private toggleKeys(): void {
		const { screen } = this.ui;
		this.ui.screen =
			screen.name === 'keys' ? screen.back : { name: 'keys', back: screen };
		this.ui.scroll.page = 0;
	}

	/** `+ N more`: every DONE row, the selection on the first it hid. */
	private expandDone(): void {
		const live = this.model.live;
		if (!live) return;
		this.ui.done.expanded = true;
		const first = homeItems(live, null)[this.ui.selectedIndex];
		if (first) this.ui.selected = first.key;
		this.ui.scroll.free = false;
	}

	/**
	 * Esc with nothing typed: DONE folds back to `+ N more`, and the keys
	 * screen goes back where it came from.
	 */
	private back(): void {
		const { screen } = this.ui;
		if (screen.name === 'home' && this.ui.done.expanded) {
			this.ui.done.expanded = false;
			this.ui.selected = MORE_KEY;
			this.ui.scroll.free = false;
			return;
		}
		if (screen.name === 'keys') {
			this.ui.screen = screen.back;
			this.ui.scroll.page = 0;
		} else this.goHome();
	}

	private openTask(handle: string): void {
		this.ui.screen = { name: 'task', handle };
		this.ui.scroll.page = 0;
		this.loadDetail(handle);
	}

	/** Opens the task's PR or issue in your browser. */
	private openLink(task: TaskSummary): void {
		const link = linkOf(task);
		if (link === null) {
			this.showToast({
				glyph: '✗',
				subject: 'Nothing to open',
				detail: `${task.handle} has no PR or issue`,
				ms: ERROR_TOAST_MS,
			});
			return;
		}
		const opener = process.platform === 'darwin' ? 'open' : 'xdg-open';
		if (Bun.which(opener) === null) {
			this.showToast({
				glyph: '✗',
				subject: `Couldn't open ${link.title}`,
				detail: `${opener} isn't installed · ${link.url}`,
				ms: ERROR_TOAST_MS,
			});
			return;
		}
		Bun.spawn([opener, link.url], {
			stdin: 'ignore',
			stdout: 'ignore',
			stderr: 'ignore',
		}).unref();
		this.showToast({
			glyph: '✓',
			subject: `Opened ${link.title}`,
			detail: null,
			ms: TOAST_MS,
		});
	}

	private goHome(): void {
		this.ui.screen = { name: 'home' };
		this.ui.scroll.page = 0;
	}

	/** Keeps a selection on home: the same item, or the one now in its place. */
	private syncSelection(): void {
		const live = this.model.live;
		if (!live) return;
		const items = homeItems(live, doneShown(this.ui));
		if (items.length === 0) {
			this.ui.selected = null;
			this.ui.selectedIndex = 0;
			return;
		}
		const index = items.findIndex((item) => item.key === this.ui.selected);
		if (index !== -1) {
			this.ui.selectedIndex = index;
			return;
		}
		const fallback = Math.min(this.ui.selectedIndex, items.length - 1);
		this.ui.selectedIndex = fallback;
		this.ui.selected = items[fallback]?.key ?? null;
	}

	// ---- frames ----

	/** Paints soon, coalescing bursts of feed lines and keys into one frame. */
	private render(): void {
		if (this.soon) return;
		this.soon = true;
		setTimeout(() => {
			this.soon = false;
			this.frame();
		}, 0);
	}

	private frame(): void {
		if (this.timer) clearTimeout(this.timer);
		if (this.closed) return;
		const now = Date.now();
		this.flushToasts(now);
		this.prune(now);
		this.syncSelection();
		const output = view(
			this.model,
			this.ui,
			this.terminal.columns,
			this.terminal.rows,
			now,
		);
		if (this.ui.screen.name === 'home') this.ui.scroll.home = output.scroll;
		else this.ui.scroll.page = output.scroll;
		this.ui.overflow = output.overflow;
		if (output.doneFits !== null) this.ui.done.fits = output.doneFits;
		this.ui.draftRows = output.draftRows;
		this.terminal.draw(output.rows);

		let next = output.animating ? FRAME_MS : IDLE_MS - (now % IDLE_MS);
		const { toast } = this.ui;
		if (toast) {
			const fadeOutAt = toast.at + toast.ms - FADE_MS;
			if (fadeOutAt > now) next = Math.min(next, fadeOutAt - now);
			else next = FRAME_MS;
		}
		const wait = this.pending.map((entry) => entry.until - now);
		if (wait.length > 0)
			next = Math.min(next, Math.max(FRAME_MS, Math.min(...wait)));
		this.timer = setTimeout(() => this.frame(), Math.max(1, next));
	}

	private prune(now: number): void {
		this.ui.arrivals = this.ui.arrivals.filter(
			(arrival) => now - arrival.at < ARRIVAL_KEPT_MS,
		);
		this.ui.leaving = this.ui.leaving.filter(
			(entry) => now - entry.at < FADE_MS,
		);
		for (const [key, at] of this.ui.appeared) {
			if (now - at >= FADE_MS) this.ui.appeared.delete(key);
		}
		if (this.ui.toast && now - this.ui.toast.at >= this.ui.toast.ms)
			this.ui.toast = null;
	}
}
