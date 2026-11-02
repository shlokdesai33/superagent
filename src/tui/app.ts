import {
	DaemonUnreachable,
	fetchStepDiff,
	fetchTaskDetail,
	postAction,
} from '../client.ts';
import type {
	Action,
	ActionResult,
	FeedLine,
	Step,
	TaskDetail,
	TaskSummary,
} from '../protocol.ts';
import { connect } from './connection.ts';
import type { InputEvent } from './input.ts';
import {
	type Connection,
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
	type Toast,
	type Ui,
	mergedSteps,
	toRouter,
} from './state.ts';
import type { Terminal } from './terminal.ts';
import { THEMES, type ThemeName, themeFromOsc11 } from './theme.ts';
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
	/** The phrase on screen now, to fade out when it changes. */
	private lastPhrase = statusPhrase({
		connection: { state: 'connecting' },
		live: null,
	}).segs;
	private stop: () => void = () => {};
	private finish: () => void = () => {};
	readonly done: Promise<void>;

	constructor(terminal: Terminal, theme: ThemeName, startedIn: string | null) {
		this.terminal = terminal;
		this.model = {
			connection: { state: 'connecting' },
			live: null,
		};
		const now = Date.now();
		this.ui = {
			theme: THEMES[terminal.depth][theme],
			screen: { name: 'home' },
			selected: null,
			selectedIndex: 0,
			scroll: { home: 0, page: 0 },
			typing: null,
			confirmStop: null,
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
			const name = themeFromOsc11(event.reply);
			if (name && name !== this.ui.theme.name) {
				this.ui.theme = THEMES[this.terminal.depth][name];
				this.terminal.invalidate();
				this.render();
			}
			return;
		}
		if (event.kind === 'attributes') return;
		if (event.kind === 'ctrl' && event.letter === 'c') {
			this.quit();
			return;
		}
		if (this.ui.typing) this.onTypingInput(event);
		else if (this.ui.confirmStop) {
			const handle = this.ui.confirmStop;
			this.ui.confirmStop = null;
			if (event.kind === 'char' && event.ch === 's')
				this.act({ type: 'stop_task', handle });
		} else this.onCommand(event);
		this.render();
	}

	private onTypingInput(event: InputEvent): void {
		const typing = this.ui.typing;
		if (!typing) return;
		if (event.kind === 'char') typing.text += event.ch;
		else if (event.kind === 'paste')
			typing.text += event.text.replaceAll(/\r\n|\r|\n|\t/g, ' ');
		else if (event.kind === 'ctrl' && event.letter === 'u') typing.text = '';
		else if (event.kind === 'key') {
			if (event.name === 'enter') this.send();
			else if (event.name === 'escape') this.ui.typing = null;
			else if (event.name === 'tab') this.nextRepo();
			else if (event.name === 'backspace') {
				const chars = [
					...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(
						typing.text,
					),
				];
				typing.text = chars
					.slice(0, -1)
					.map((part) => part.segment)
					.join('');
			}
		}
	}

	private send(): void {
		const typing = this.ui.typing;
		this.ui.typing = null;
		if (!typing) return;
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

	private startTyping(): void {
		this.ui.typing = { mode: 'free', handle: null, questionId: null, text: '' };
	}

	private answer(handle: string): boolean {
		const task = this.model.live?.tasks.get(handle);
		if (task?.status !== 'needs_you' || !task.question) return false;
		this.ui.typing = {
			mode: 'answer',
			handle,
			questionId: task.question.id,
			text: '',
		};
		return true;
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

	private onCommand(event: InputEvent): void {
		const ch = event.kind === 'char' ? event.ch : null;
		const key = event.kind === 'key' ? event.name : null;
		const { screen } = this.ui;

		if (ch === '/' || ch === 'i') {
			this.startTyping();
			return;
		}
		if (ch === '?') {
			if (screen.name === 'keys') this.ui.screen = screen.back;
			else this.ui.screen = { name: 'keys', back: screen };
			this.ui.scroll.page = 0;
			return;
		}
		if (ch === 'h') {
			this.ui.screen = { name: 'health' };
			this.ui.scroll.page = 0;
			return;
		}
		if (key === 'escape') {
			this.goHome();
			return;
		}
		if (ch === 'q') {
			if (screen.name === 'home') this.quit();
			else this.goHome();
			return;
		}

		const down =
			ch === 'j' || key === 'down' ? 1 : key === 'pagedown' ? PAGE : 0;
		const up = ch === 'k' || key === 'up' ? 1 : key === 'pageup' ? PAGE : 0;

		if (screen.name !== 'home') {
			if (down || up) {
				const step = down - up;
				this.ui.scroll.page = Math.max(0, this.ui.scroll.page + step);
			}
			if (screen.name === 'task') {
				const task = this.model.live?.tasks.get(screen.handle);
				if (key === 'enter') this.answer(screen.handle);
				if (ch === 'o' && task) this.openLink(task);
				if (ch === 's' && task && stoppable(task))
					this.ui.confirmStop = task.handle;
			}
			if (screen.name === 'health' && ch === 'r') {
				this.act({ type: 'resume_tasks', handles: null });
			}
			return;
		}

		const live = this.model.live;
		if (!live) return;
		const items = homeItems(live);
		this.syncSelection();
		if (down || up) {
			const index = Math.max(
				0,
				Math.min(items.length - 1, this.ui.selectedIndex + down - up),
			);
			this.ui.selectedIndex = index;
			this.ui.selected = items[index]?.key ?? null;
			return;
		}
		const item = items.find((entry) => entry.key === this.ui.selected);
		if (!item) return;
		if (key === 'enter') {
			if (item.kind === 'problem') this.ui.screen = { name: 'health' };
			else if (item.kind === 'task' && !this.answer(item.task.handle)) {
				this.openTask(item.task.handle);
			}
		} else if (ch === 'o' && item.kind === 'task') {
			this.openTask(item.task.handle);
		} else if (ch === 's' && item.kind === 'task' && stoppable(item.task)) {
			this.ui.confirmStop = item.task.handle;
		}
	}

	/** Keeps a selection on home: the same item, or the one now in its place. */
	private syncSelection(): void {
		const live = this.model.live;
		if (!live) return;
		const items = homeItems(live);
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
