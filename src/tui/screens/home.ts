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
	truncate,
	width,
	wrap,
} from '../cells.ts';
import { age, ago, duration } from '../format.ts';
import { type Live, type Section, sections } from '../model.ts';
import {
	BARS,
	MEASURE,
	blank,
	bracketed,
	chip,
	label,
	oneLine,
	origin,
	spinner,
} from '../parts.ts';
import { FADE_MS, type Ui } from '../state.ts';

const CONSOLE_SHOWN = 4;

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
): { lines: Line[]; animating: boolean } {
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

	if (all.done.length > 0 || leaving('done').length > 0) {
		section(() => {
			lines.push(label('DONE TODAY', all.done.length));
			lines.push(
				...withGhosts('done', all.done, (task, fade, ghost) => [
					doneRow(task, ctx, fade, ghost),
				]),
			);
		});
	}

	if (live.console.length > 0) {
		section(() => {
			lines.push(label('CONSOLE'));
			for (const message of live.console.slice(-CONSOLE_SHOWN)) {
				lines.push(...consoleRows(message, ctx));
				// An agent from before `held` sends neither field.
				const { held, pending } = live.router;
				if (held && pending?.includes(message.id)) {
					lines.push(...heldRows(held, ctx));
				}
			}
		});
	}

	if (lines.length === 0) {
		lines.push(
			{ segs: [{ t: 'Nothing is happening yet.', fg: 'fg' }] },
			{
				segs: [
					{
						t: 'Press / to ask for something.',
						fg: 'faint',
					},
				],
			},
		);
	}
	return { lines, animating };
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
	const shown =
		right && !right.some((seg) => seg.b) ? truncate(right, room) : right;
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
		selected
			? bracketed([['enter', 'health']])
			: [{ t: ago(ctx.now - problem.since), fg: 'faint' }],
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
			selected
				? bracketed([
						['enter', 'answer'],
						['o', 'open'],
						['s', 'stop'],
					])
				: origin(task.origin),
			fade,
			ghost,
		),
	];
	if (task.question) {
		const room = Math.min(MEASURE, ctx.content) - 4;
		const question = wrap(
			[{ t: oneLine(task.question.text), fg: 'fg', i: true }],
			room,
			2,
		);
		question.forEach((segs, index) => {
			lines.push(
				row(
					key,
					ctx,
					[{ t: index === 0 ? '  └ ' : '    ', fg: 'ghost' }, ...segs],
					undefined,
					fade,
					ghost,
				),
			);
		});
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
		selected
			? bracketed([
					['enter', 'open'],
					['s', 'dismiss'],
				])
			: [{ t: oneLine(task.result ?? 'failed'), fg: 'faint' }],
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
	const room = Math.min(MEASURE, ctx.content) - 9;
	const segs: Seg[] = [
		{ t: 'waiting · ', fg: 'faint' },
		{ t: oneLine(held.reason), fg: 'warn' },
	];
	if (held.until !== null) {
		segs.push({
			t: ` · tries again in ${duration(Math.max(0, held.until - ctx.now))}`,
			fg: 'faint',
		});
	}
	return wrap(segs, room, 2).map((line, index) => ({
		segs: [
			{ t: ' '.repeat(7) },
			{ t: index === 0 ? '└ ' : '  ', fg: 'ghost' },
			...line,
		],
	}));
}

function consoleRows(message: Message, ctx: Context): Line[] {
	const room = Math.min(MEASURE, ctx.content) - 7;
	const text = wrap([{ t: oneLine(message.text), fg: 'fg' }], room, 3);
	return text.map((segs, index) => ({
		segs: [
			index === 0
				? {
						t: fit(message.author, 7),
						fg: message.author === 'you' ? 'accent' : 'dim',
					}
				: { t: ' '.repeat(7) },
			...segs,
		],
	}));
}
