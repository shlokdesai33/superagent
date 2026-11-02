import type { Step, TaskDetail, TaskSummary } from '../protocol.ts';
import type { Seg } from './cells.ts';
import type { Draft } from './draft.ts';
import type { Section } from './model.ts';
import type { Theme } from './theme.ts';

export type Screen =
	| { name: 'home' }
	| { name: 'task'; handle: string }
	| { name: 'health' }
	| { name: 'keys'; back: Exclude<Screen, { name: 'keys' }> }
	| KeyScreen;

/**
 * Where you paste a Particle API key: on first run (`missing`), when Particle
 * rejected the saved one, or from health (`replace`). `text` is the key being
 * entered; it's drawn masked and never leaves this process except to Particle
 * and the key file.
 */
export type KeyScreen = {
	name: 'key';
	reason: 'missing' | 'rejected' | 'replace';
	back: Exclude<Screen, { name: 'key' }>;
	/** Where the key is saved. */
	keyFile: string;
	text: string;
	/** While Particle checks the key: when it started, and which attempt. */
	checking: { since: number; attempt: number } | null;
	error: { subject: string; detail: string | null } | null;
};

/** The input box, always focused: an empty `text` means nothing is typed. */
export type Typing = Draft & {
	mode: 'free' | 'answer';
	/** For answers: the task and its question. */
	handle: string | null;
	questionId: number | null;
};

export function emptyTyping(): Typing {
	return { mode: 'free', handle: null, questionId: null, text: '', cursor: 0 };
}

/** Something is typed: spaces alone count as nothing, as enter sends nothing. */
export function typed(ui: Ui): boolean {
	return ui.typing.text.trim() !== '';
}

/** Something is typed, or an answer is started. */
export function drafting(ui: Ui): boolean {
	return typed(ui) || ui.typing.mode === 'answer';
}

export type Toast = {
	glyph: '✓' | '✗' | '·';
	subject: string;
	detail: string | null;
	at: number;
	ms: number;
};

/** An event that went straight to a task, for its row's highlight. */
export type Arrival = { at: number; handle: string };

/** A row fading out of the section it left. */
export type Leaving = {
	task: TaskSummary;
	section: Section;
	index: number;
	at: number;
};

/** The header's status phrase, and when it last changed, for the cross-fade. */
export type StatusPhraseChange = {
	key: string;
	changedAt: number;
	previous: Seg[] | null;
};

/**
 * Home rows out of view: `above`, the selected item's top or its section
 * label; `below`, the rest of the selected item, or anything after the last.
 */
export type Overflow = { above: boolean; below: boolean };

export type DetailState = {
	state: 'loading' | 'ready' | 'missing';
	detail: TaskDetail | null;
	/** Diffs of edit steps, by step id. */
	diffs: Map<number, string | null>;
};

export type Ui = {
	theme: Theme;
	screen: Screen;
	/** The selected home item's key, kept across updates. */
	selected: string | null;
	selectedIndex: number;
	/**
	 * First body row shown, per screen. `free` while ↑/↓ scroll home through
	 * rows the selection doesn't reach: a tall item, or what's below the last.
	 */
	scroll: { home: number; page: number; free: boolean };
	/** From the last frame. */
	overflow: Overflow;
	/** From the last frame: where each row of the draft on screen starts. */
	draftRows: number[];
	typing: Typing;
	confirmStop: string | null;
	/** Ctrl-C was pressed once with a draft; a second press quits. */
	confirmQuit: boolean;
	toast: Toast | null;
	arrivals: Arrival[];
	leaving: Leaving[];
	/** When each NEEDS YOU item appeared, for its fade-in. */
	appeared: Map<string, number>;
	status: StatusPhraseChange;
	details: Map<string, DetailState>;
	/**
	 * The repository console messages name as the default for new tasks:
	 * `startedIn`, the one the UI was opened in, until tab changes it.
	 * `null` names none, as when the UI is opened outside a repository.
	 */
	repo: { startedIn: string | null; path: string | null };
};

/** Whether what's being typed goes to the Router, so the default repository applies. */
export function toRouter(ui: Ui): boolean {
	return (
		ui.typing.mode === 'free' &&
		ui.screen.name !== 'task' &&
		!/^\s*@/.test(ui.typing.text)
	);
}

export const FADE_MS = 320;

/** The steps a task view shows: the detail's, updated by newer feed lines. */
export function mergedSteps(
	detail: TaskDetail | null,
	feed: Map<number, { step: Step; seq: number }> | undefined,
): Step[] {
	const byId = new Map<number, Step>();
	for (const step of detail?.steps ?? []) byId.set(step.id, step);
	for (const { step, seq } of feed?.values() ?? []) {
		if (detail === null || seq > detail.seq) byId.set(step.id, step);
	}
	return [...byId.values()].toSorted((a, b) => a.id - b.id);
}
