import type {
	Message,
	Problem,
	RouterState,
	TaskSummary,
} from '../../protocol.ts';
import {
	type Line,
	type Seg,
	fit,
	fitStart,
	hang,
	truncate,
	width,
} from '../cells.ts';
import { age, ago, duration } from '../format.ts';
import { type Live, MORE_KEY, type Section, sections } from '../model.ts';
import {
	BARS,
	MEASURE,
	blank,
	chip,
	label,
	oneLine,
	origin,
	paragraphs,
	rule,
	spinner,
} from '../parts.ts';
import { FADE_MS, type Ui } from '../state.ts';

/** DONE TODAY rows shown before its `+ N more`, when they fit. */
const DONE_FEW = 5;

type Context = {
	ui: Ui;
	/** Content columns: the terminal width less the margin. */
	content: number;
	/** The terminal is 100 columns or wider. */
	wide: boolean;
	now: number;
};

export function homeBody(
	live: Live,
	ui: Ui,
	content: number,
	wide: boolean,
	now: number,
	/** Body rows on screen. */
	height: number,
): { lines: Line[]; pinned: Line[]; doneFits: number; animating: boolean } {
	const ctx: Context = { ui, content, wide, now };
	const all = sections(live);
	const lines: Line[] = [];
	let animating = false;
	const section = (build: () => void) => {
		if (lines.length > 0) lines.push(blank());
		build();
	};
	const leaving = (name: Section) =>
		ui.leaving.filter(
			(entry) => entry.section === name && now - entry.at < FADE_MS,
		);
	const withGhosts = (
		name: Section,
		rows: TaskSummary[],
		render: (
			task: TaskSummary,
			fade: number | undefined,
			ghost: boolean,
		) => Line[],
	) => {
		const out: Line[][] = rows.map((task) => render(task, undefined, false));
		for (const entry of leaving(name).toSorted((a, b) => b.index - a.index)) {
			if (rows.some((task) => task.handle === entry.task.handle)) continue;
			const fade = 1 - (now - entry.at) / FADE_MS;
			out.splice(
				Math.min(entry.index, out.length),
				0,
				render(entry.task, fade, true),
			);
			animating = true;
		}
		return out.flat();
	};

	const needsCount = all.problems.length + all.failed.length + all.needs.length;
	const needsGhosts = leaving('needs').length;
	if (needsCount > 0 || needsGhosts > 0) {
		section(() => {
			lines.push(label('NEEDS YOU', needsCount));
			for (const problem of all.problems) {
				const key = `problem:${problem.id}`;
				const fade = fadeIn(ui, key, now);
				if (fade !== undefined) animating = true;
				lines.push(problemRow(problem, ctx, fade));
			}
			lines.push(
				...withGhosts(
					'needs',
					[...all.failed, ...all.needs],
					(task, fade, ghost) => {
						const key = `task:${task.handle}`;
						const shown = ghost ? fade : fadeIn(ui, key, now);
						if (shown !== undefined) animating = true;
						return task.status === 'needs_you'
							? needsRows(task, ctx, shown, ghost)
							: [failedRow(task, ctx, shown, ghost)];
					},
				),
			);
		});
	}

	const needsLength = lines.length;

	if (all.working.length > 0 || leaving('working').length > 0) {
		section(() => {
			lines.push(label('WORKING', all.working.length));
			lines.push(
				...withGhosts('working', all.working, (task, fade, ghost) => [
					workingRow(task, ctx, fade, ghost),
				]),
			);
		});
		if (all.working.some((task) => task.status === 'working')) animating = true;
	}

	// The console's latest exchange (your last message and what came after
	// it) always shows in full, NEEDS YOU keeps its label and first row, and
	// DONE TODAY folds to what's left.
	const blocks = live.console.map((message) => {
		const rows = consoleRows(message, ctx);
		// An agent from before `held` sends neither field.
		const { held, pending } = live.router;
		if (held && pending?.includes(message.id))
			rows.push(...heldRows(held, ctx));
		return rows;
	});
	const lastYou = live.console.findLastIndex(
		(message) => message.direction === 'in',
	);
	const exchange = blocks
		.slice(lastYou === -1 ? Math.max(0, blocks.length - 1) : lastYou)
		.flat();
	// Tasks keep a label and a row: NEEDS YOU's first, else WORKING's or
	// DONE TODAY's, so an exchange that fills the body still leaves them.
	const anyTasks = lines.length > 0 || all.done.length > 0;
	const reserve = needsLength > 0 ? Math.min(2, needsLength) : anyTasks ? 2 : 0;
	const consoleMin = Math.min(
		exchange.length,
		Math.max(0, height - 1 - reserve),
	);
	const taskRoom = Math.max(0, height - 1 - consoleMin);

	const doneFits = fitDone(
		all.done.length,
		taskRoom - (lines.length > 0 ? lines.length + 1 : 0) - 1,
	);
	if (all.done.length > 0 || leaving('done').length > 0) {
		const shown = ui.done.expanded ? all.done : all.done.slice(0, doneFits);
		const hidden = all.done.length - shown.length;
		section(() => {
			lines.push(label('DONE TODAY', all.done.length));
			lines.push(
				...withGhosts('done', shown, (task, fade, ghost) => [
					doneRow(task, ctx, fade, ghost),
				]),
			);
			if (hidden > 0) lines.push(moreRow(hidden, ctx));
		});
	}

	if (lines.length === 0 && live.console.length === 0) {
		lines.push({ segs: [{ t: 'No tasks yet.', fg: 'fg' }] });
	}

	// Taller than the body can hold, the exchange scrolls with the tasks, as
	// one list: ↓ past the last task reads on through it.
	if (consoleMin < exchange.length) {
		return {
			lines: [...lines, rule(content), ...exchange],
			pinned: [],
			doneFits,
			animating,
		};
	}

	// Older messages fill the rows the tasks leave, whole, newest first.
	const consoleRoom = Math.max(
		consoleMin,
		height - 1 - Math.min(lines.length, taskRoom),
	);
	let console = exchange;
	const older = blocks.slice(
		0,
		lastYou === -1 ? Math.max(0, blocks.length - 1) : lastYou,
	);
	for (const rows of older.toReversed()) {
		if (console.length + rows.length > consoleRoom) break;
		console = [...rows, ...console];
	}
	return {
		lines,
		pinned: [rule(content), ...console],
		doneFits,
		animating,
	};
}

/** DONE TODAY rows that fit in `room` with their `+ N more`: at most a few, at least one. */
function fitDone(count: number, room: number): number {
	if (count <= Math.min(room, DONE_FEW + 1)) return count;
	return Math.max(1, Math.min(DONE_FEW, room - 1));
}

function moreRow(hidden: number, ctx: Context): Line {
	const selected = ctx.ui.selected === MORE_KEY;
	return {
		segs: [
			{ t: '+ ', fg: 'faint' },
			{ t: `${hidden} more`, fg: 'dim', b: selected },
		],
		key: MORE_KEY,
		...(selected ? { bg: 'surface' } : {}),
	};
}

function fadeIn(ui: Ui, key: string, now: number): number | undefined {
	const at = ui.appeared.get(key);
	if (at === undefined || now - at >= FADE_MS) return undefined;
	return Math.max(0, (now - at) / FADE_MS);
}

function row(
	key: string,
	ctx: Context,
	segs: Seg[],
	right: Seg[] | undefined,
	fade: number | undefined,
	ghost: boolean,
): Line {
	const selected = !ghost && ctx.ui.selected === key;
	// A long result or channel gives way to the title once both can't fit.
	const room = Math.max(
		ctx.content - width(segs) - 2,
		Math.floor(ctx.content / 2),
	);
	const shown = right ? truncate(right, room) : right;
	return {
		segs,
		...(shown ? { right: shown } : {}),
		...(selected ? { bg: 'surface' } : {}),
		...(fade === undefined ? {} : { fade }),
		...(ghost ? {} : { key }),
	};
}

function handleSeg(handle: string, selected: boolean): Seg {
	return { t: fit(handle, 6), fg: selected ? 'accent' : 'dim' };
}

function problemRow(
	problem: Problem,
	ctx: Context,
	fade: number | undefined,
): Line {
	const key = `problem:${problem.id}`;
	const selected = ctx.ui.selected === key;
	return row(
		key,
		ctx,
		[
			{ t: '! ', fg: 'warn', b: true },
			{ t: oneLine(problem.text), fg: 'fg', b: selected },
		],
		[{ t: ago(ctx.now - problem.since), fg: 'faint' }],
		fade,
		false,
	);
}

function needsRows(
	task: TaskSummary,
	ctx: Context,
	fade: number | undefined,
	ghost: boolean,
): Line[] {
	const key = `task:${task.handle}`;
	const selected = !ghost && ctx.ui.selected === key;
	const lines = [
		row(
			key,
			ctx,
			[
				{ t: '? ', fg: 'warn', b: true },
				handleSeg(task.handle, selected),
				{ t: oneLine(task.title), fg: 'fg', b: selected },
			],
			origin(task.origin),
			fade,
			ghost,
		),
	];
	if (task.question) {
		const question = hang(
			[{ t: '  └ ', fg: 'ghost' }],
			[{ t: paragraphs(task.question.text), fg: 'fg', i: true }],
			Math.min(MEASURE, ctx.content),
		);
		for (const { segs } of question) {
			lines.push(row(key, ctx, segs, undefined, fade, ghost));
		}
	}
	return lines;
}

function failedRow(
	task: TaskSummary,
	ctx: Context,
	fade: number | undefined,
	ghost: boolean,
): Line {
	const key = `task:${task.handle}`;
	const selected = !ghost && ctx.ui.selected === key;
	return row(
		key,
		ctx,
		[
			{ t: '✗ ', fg: 'err' },
			handleSeg(task.handle, selected),
			{ t: oneLine(task.title), fg: 'fg', b: selected },
		],
		[{ t: oneLine(task.result ?? 'failed'), fg: 'faint' }],
		fade,
		ghost,
	);
}

function workingRow(
	task: TaskSummary,
	ctx: Context,
	fade: number | undefined,
	ghost: boolean,
): Line {
	const key = `task:${task.handle}`;
	const selected = !ghost && ctx.ui.selected === key;
	const live = task.status === 'working';

	// spinner 2, handle 6, age 5, sparkline 8; the step column carries its own
	// spaces on either side.
	const available = Math.max(0, ctx.content - 21);
	let channelWidth = ctx.wide ? 18 : 14;
	if (available - channelWidth < 24) {
		channelWidth = Math.max(0, available - 24);
	}
	const rest = available - channelWidth;
	const titleWidth = Math.floor(rest / 2);
	const stepWidth = rest - titleWidth;

	const stepInner = Math.max(0, stepWidth - 2);
	const stepSegs: Seg[] =
		live && task.now?.command
			? [chip(truncateText(oneLine(task.now.command), stepInner - 2))]
			: [
					// One space where a chip has its padding, so the words line up.
					{
						t: ` ${
							live && task.now
								? oneLine(task.now.text)
								: `waiting on ${task.waitingOn ?? 'a message'}`
						}`,
						fg: 'faint',
					},
				];

	return row(
		key,
		ctx,
		[
			live
				? { t: `${spinner(ctx.now)} `, fg: 'accent' }
				: { t: '◌ ', fg: 'faint' },
			handleSeg(task.handle, selected),
			...pad([{ t: oneLine(task.title), fg: 'fg', b: selected }], titleWidth),
			...pad(origin(task.origin), channelWidth),
			{
				t: fitStart(age(ctx.now - (task.startedAt ?? task.createdAt)), 5),
				fg: 'faint',
			},
			{ t: ' ' },
			...pad(stepSegs, stepWidth - 1),
			...sparkline(task, ctx.now),
		],
		undefined,
		fade,
		ghost,
	);
}

function truncateText(text: string, room: number): string {
	return truncate([{ t: text }], Math.max(1, room))
		.map((seg) => seg.t)
		.join('');
}

/** Cut to leave one space, then padded to exactly `columns`. */
function pad(segs: Seg[], columns: number): Seg[] {
	if (columns <= 0) return [];
	const cut = truncate(segs, columns - 1);
	return [...cut, { t: ' '.repeat(Math.max(0, columns - width(cut))) }];
}

/** Model calls per minute over eight minutes, scaled to the task's own peak. */
function sparkline(task: TaskSummary, now: number): Seg[] {
	const shift = Math.max(0, Math.floor((now - task.activityAt) / 60_000));
	const values = [
		...task.activity.slice(shift),
		...Array<number>(shift).fill(0),
	].slice(-8);
	while (values.length < 8) values.unshift(0);
	const peak = Math.max(...values);
	const bars = values
		.map((value) =>
			peak === 0 ? BARS[0] : BARS[Math.round((value / peak) * 7)],
		)
		.join('');
	return [{ t: bars, fg: (values[7] ?? 0) > 0 ? 'accent' : 'ghost' }];
}

function doneRow(
	task: TaskSummary,
	ctx: Context,
	fade: number | undefined,
	ghost: boolean,
): Line {
	const key = `task:${task.handle}`;
	const selected = !ghost && ctx.ui.selected === key;
	const glyph: Seg =
		task.status === 'done'
			? { t: '✓ ', fg: 'ok' }
			: task.status === 'failed'
				? { t: '✗ ', fg: 'err' }
				: { t: '– ', fg: 'faint' };
	return row(
		key,
		ctx,
		[
			glyph,
			handleSeg(task.handle, selected),
			{ t: oneLine(task.title), fg: 'dim', b: selected },
		],
		task.result ? [{ t: oneLine(task.result), fg: 'faint' }] : undefined,
		fade,
		ghost,
	);
}

/** Why a console message is still waiting for the Router, under it. */
function heldRows(
	held: NonNullable<RouterState['held']>,
	ctx: Context,
): Line[] {
	const segs: Seg[] = [
		{ t: 'waiting · ', fg: 'faint' },
		{ t: paragraphs(held.reason), fg: 'warn' },
	];
	if (held.until !== null) {
		segs.push({
			t: ` · tries again in ${duration(Math.max(0, held.until - ctx.now))}`,
			fg: 'faint',
		});
	}
	return hang(
		[{ t: ' '.repeat(7) }, { t: '└ ', fg: 'ghost' }],
		segs,
		Math.min(MEASURE, ctx.content),
	);
}

function consoleRows(message: Message, ctx: Context): Line[] {
	return hang(
		[
			{
				t: fit(message.author, 7),
				fg: message.author === 'you' ? 'accent' : 'dim',
			},
		],
		[{ t: paragraphs(message.text), fg: 'fg' }],
		Math.min(MEASURE, ctx.content),
	);
}
