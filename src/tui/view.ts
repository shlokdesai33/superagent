import {
	type Cell,
	type Line,
	MARGIN,
	type Seg,
	paint,
	resolve,
	truncate,
	width,
	wrap,
} from './cells.ts';
import { clock, tokens } from './format.ts';
import {
	type Item,
	type Live,
	type Model,
	homeItems,
	linkOf,
	needsCount,
	problemCount,
	stoppable,
	workingCount,
} from './model.ts';
import { MEASURE, chip, figure, hint, rule, sep, spinner } from './parts.ts';
import { healthBody } from './screens/health.ts';
import { homeBody } from './screens/home.ts';
import { keysBody } from './screens/keys.ts';
import { taskBody } from './screens/task.ts';
import { FADE_MS, type Ui } from './state.ts';
import { type Rgb, type Theme, blend } from './theme.ts';

const MIN_COLUMNS = 40;
const MIN_ROWS = 12;
const FLASH_MS = 650;
const SWEEP_MS = 1_000;
const SWEEP_EVERY_MS = 3_000;

export type Frame = {
	rows: Cell[][];
	/** Something moves, so the next frame is due in 80 ms. */
	animating: boolean;
	/** The scroll offset used, to keep for the next frame. */
	scroll: number;
};

/** The whole screen, as rows of exactly `columns` cells. */
export function view(
	model: Model,
	ui: Ui,
	columns: number,
	rows: number,
	now: number,
): Frame {
	const { theme } = ui;
	if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
		const message: Line = {
			segs: [
				{
					t: `Needs at least ${MIN_COLUMNS} × ${MIN_ROWS}`,
					fg: 'faint',
				},
			],
		};
		return {
			rows: Array.from({ length: rows }, (_, y) =>
				paint(y === 0 ? message : { segs: [] }, theme, columns, theme.bg),
			),
			animating: false,
			scroll: 0,
		};
	}

	const content = columns - MARGIN;
	const { connection } = model;
	const live = connection.state === 'rejected' ? null : model.live;
	const stale = live !== null && connection.state !== 'live';
	// Stale data is shown as it was when it arrived: nothing moves.
	const dataNow = stale && live ? live.receivedAt : now;
	const home = ui.screen.name === 'home' && live !== null;
	let animating = false;

	const header = headerLine(model, ui, content, now);
	if (now - ui.status.changedAt < FADE_MS) animating = true;

	const body = bodyLines(model, ui, content, columns >= 100, dataNow);
	if (body.animating && !stale) animating = true;

	const footer: Line[] = [rule(content)];
	if (home && live) {
		const router = routerLine(live, dataNow, theme);
		if (live.router.deciding && !stale) animating = true;
		footer.push(router);
	}
	const toast = toastLine(ui, now);
	if (toast) {
		footer.push(toast.line);
		if (toast.fading) animating = true;
	}
	footer.push(inputLine(model, ui, content, now), {
		segs: hintLine(model, ui, content),
	});

	const bodyHeight = Math.max(0, rows - 2 - footer.length);
	const scroll = scrollFor(body.lines, ui, bodyHeight);
	const visible = body.lines.slice(scroll, scroll + bodyHeight);

	const screen: Line[] = [header, rule(content), ...visible];
	while (screen.length < 2 + bodyHeight) screen.push({ segs: [] });
	screen.push(...footer);

	const top = 2;
	const routerRow = top + bodyHeight + 1;
	// A task's rows fade from `flash` when an event goes straight to it.
	const flashes = new Map<number, number>();
	if (home && !stale) {
		for (const arrival of ui.arrivals) {
			const elapsed = now - arrival.at;
			if (elapsed >= FLASH_MS) continue;
			const key = `task:${arrival.handle}`;
			screen.forEach((line, y) => {
				if (line.key === key && y >= top && y < top + bodyHeight) {
					flashes.set(y, elapsed / FLASH_MS);
				}
			});
			animating = true;
		}
	}

	const painted = screen.map((line, y) => {
		const base = line.bg === undefined ? theme.bg : resolve(theme, line.bg);
		const flash = flashes.get(y);
		const rowBg = flash === undefined ? base : blend(theme.flash, base, flash);
		const cells = paint(line, theme, columns, rowBg);
		const inBody = y >= top && y < top + bodyHeight;
		return stale && (inBody || (home && y === routerRow))
			? cells.map((cell) => mute(cell, ui))
			: cells;
	});
	return { rows: painted, animating, scroll };
}

/** Stale data: every word in `faint`, the lines left as they are. */
function mute(cell: Cell, ui: Ui): Cell {
	const { theme } = ui;
	const keep =
		same(cell.fg, theme.ghost) ||
		same(cell.fg, theme.bg) ||
		same(cell.fg, theme.surface);
	return keep ? cell : { ...cell, fg: theme.faint };
}

function same(a: Rgb, b: Rgb): boolean {
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

/** The header's status phrase, and a key that changes when it does. */
export function statusPhrase(model: Model): { key: string; segs: Seg[] } {
	const { connection, live } = model;
	if (connection.state === 'connecting') {
		return { key: 'connecting', segs: [{ t: '○ connecting', fg: 'faint' }] };
	}
	if (connection.state !== 'live' || live === null) {
		const segs: Seg[] = [{ t: '○ offline', fg: 'faint' }];
		if (live && connection.state === 'offline') {
			segs.push(sep, { t: `data from ${clock(live.receivedAt)}`, fg: 'faint' });
		}
		return { key: `offline:${segs.length}`, segs };
	}
	const problems = problemCount(live);
	if (problems > 0) {
		return {
			key: `problems:${problems}`,
			segs: [
				{
					t: `! ${problems} ${problems === 1 ? 'problem' : 'problems'}`,
					fg: 'warn',
					b: true,
				},
			],
		};
	}
	const needs = needsCount(live);
	if (needs > 0) {
		return {
			key: `needs:${needs}`,
			segs: [
				{ t: `● ${needs} ${needs === 1 ? 'needs' : 'need'} you`, fg: 'warn' },
			],
		};
	}
	return { key: 'calm', segs: [{ t: '● all calm', fg: 'ok' }] };
}

function faded(segs: Seg[], ui: Ui, amount: number): Seg[] {
	return segs.map((seg) => ({
		...seg,
		fg: blend(ui.theme.bg, resolve(ui.theme, seg.fg ?? 'fg'), amount),
	}));
}

function headerLine(model: Model, ui: Ui, content: number, now: number): Line {
	const left: Seg[] = [{ t: 'superagent', fg: 'fg', b: true }];
	const crumb: Seg = { t: '  ›  ', fg: 'ghost' };
	const { screen } = ui;
	if (screen.name === 'task') {
		const task = model.live?.tasks.get(screen.handle);
		left.push(crumb, { t: screen.handle, fg: 'dim' });
		if (task) left.push({ t: '  ' }, { t: task.title, fg: 'fg' });
	} else if (screen.name === 'health' || screen.name === 'keys') {
		left.push(crumb, { t: screen.name, fg: 'fg' });
	}

	let status = statusPhrase(model).segs;
	const since = now - ui.status.changedAt;
	if (since < FADE_MS) {
		const half = FADE_MS / 2;
		status =
			since < half && ui.status.previous
				? faded(ui.status.previous, ui, 1 - since / half)
				: faded(
						status,
						ui,
						ui.status.previous ? (since - half) / half : since / FADE_MS,
					);
	}

	const live = model.connection.state === 'live' ? model.live : null;
	const meta: Seg[][] = [];
	if (live) {
		const working = workingCount(live);
		if (working > 0) meta.push(figure(String(working), 'working'));
		const used = live.usage.inputTokens + live.usage.outputTokens;
		if (used > 0) meta.push(figure(tokens(used), 'tokens today'));
	}
	meta.push([
		{ t: '?', fg: 'dim', b: true },
		{ t: ' keys', fg: 'faint' },
	]);

	const compose = (parts: Seg[][]): Seg[] =>
		parts.length === 0
			? status
			: [
					...status,
					{ t: '   ' },
					...parts.flatMap((part, index) => [
						...(index > 0 ? [sep] : []),
						...part,
					]),
				];
	// The breadcrumb wins over the usage, then the working count; `? keys`
	// goes only when the breadcrumb would still be cut short.
	let right = compose(meta);
	const fits = (minimum: number) =>
		width(right) + 2 + Math.min(width(left), minimum) <= content;
	while (!fits(Infinity) && meta.length > 1) {
		meta.splice(meta.length - 2, 1);
		right = compose(meta);
	}
	if (!fits(24) && meta.length > 0) {
		meta.length = 0;
		right = compose(meta);
	}
	return { segs: left, right };
}

function bodyLines(
	model: Model,
	ui: Ui,
	content: number,
	wide: boolean,
	now: number,
): { lines: Line[]; animating: boolean } {
	const { connection } = model;
	const measure = Math.min(MEASURE, content);
	const prose = (segs: Seg[]): Line[] =>
		wrap(segs, measure).map((line) => ({ segs: line }));
	if (connection.state === 'rejected') {
		return {
			lines: [
				{ segs: [] },
				...prose([
					{
						t: 'The agent and this terminal are different versions',
						fg: 'fg',
						b: true,
					},
				]),
				...prose([
					{
						t: 'Run the same superagent for both; this screen reconnects by itself.',
						fg: 'faint',
					},
				]),
				...prose([{ t: connection.detail, fg: 'dim' }]),
			],
			animating: false,
		};
	}
	const live = model.live;
	if (live === null) {
		if (connection.state === 'offline') {
			return {
				lines: [
					{ segs: [] },
					...prose([{ t: "Can't reach the agent", fg: 'fg', b: true }]),
					...prose([
						{ t: 'Start it with ', fg: 'faint' },
						chip('superagent daemon'),
						{ t: ' · this screen reconnects by itself', fg: 'faint' },
					]),
					...prose([
						{ t: `${connection.detail} · retrying every 1.5 s`, fg: 'dim' },
					]),
				],
				animating: false,
			};
		}
		return {
			lines: [{ segs: [{ t: 'Connecting to the agent…', fg: 'faint' }] }],
			animating: false,
		};
	}
	switch (ui.screen.name) {
		case 'home':
			return homeBody(live, ui, content, wide, now);
		case 'task':
			return taskBody(live, ui, ui.screen.handle, content, now);
		case 'health':
			return { lines: healthBody(live, content, now), animating: false };
		case 'keys':
			return { lines: keysBody(), animating: false };
	}
}

function scrollFor(lines: Line[], ui: Ui, height: number): number {
	const max = Math.max(0, lines.length - height);
	if (ui.screen.name !== 'home')
		return Math.min(Math.max(0, ui.scroll.page), max);
	let offset = Math.min(ui.scroll.home, max);
	const key = ui.selected;
	if (key !== null) {
		const first = lines.findIndex((line) => line.key === key);
		if (first !== -1) {
			let last = first;
			while (lines[last + 1]?.key === key) last += 1;
			// Keep the section label in view above the first item of a section.
			const from =
				first > 0 &&
				lines[first - 1]?.key === undefined &&
				lines[first - 1]?.segs.length
					? first - 1
					: first;
			if (from < offset) offset = from;
			if (last >= offset + height) offset = last - height + 1;
		}
	}
	return Math.max(0, Math.min(offset, max));
}

function routerLine(live: Live, now: number, theme: Theme): Line {
	const { router } = live;
	const segs: Seg[] = [
		{ t: '◇ ', fg: router.deciding ? 'accent' : 'dim' },
		{ t: 'router  ', fg: 'dim' },
	];
	if (router.deciding) {
		segs.push(
			{ t: `${spinner(now)} `, fg: 'accent' },
			...sweep('deciding', now - (router.decidingSince ?? now), theme),
		);
		if (router.waiting > 0) {
			segs.push(
				sep,
				{ t: String(router.waiting), fg: 'fg' },
				{ t: " more waiting, they'll be decided together", fg: 'faint' },
			);
		} else if (router.batchSize > 1) {
			segs.push(
				sep,
				{ t: String(router.batchSize), fg: 'fg' },
				{ t: ' events in one call', fg: 'faint' },
			);
		}
	} else {
		segs.push({
			t: router.last ? `last: ${router.last.text}` : 'last: nothing yet',
			fg: 'faint',
		});
		if (router.waiting > 0) {
			segs.push(
				sep,
				{ t: String(router.waiting), fg: 'fg' },
				{ t: ' waiting', fg: 'faint' },
			);
		}
	}
	return { segs };
}

/** A 3-cell band, `dim` to `fg` and back, across the word for 1 s every 3 s. */
function sweep(word: string, elapsed: number, theme: Theme): Seg[] {
	const phase = elapsed % SWEEP_EVERY_MS;
	const center =
		phase < SWEEP_MS ? -2 + (phase / SWEEP_MS) * (word.length + 4) : -99;
	return Array.from(word, (ch, index) => ({
		t: ch,
		fg: blend(theme.dim, theme.fg, 1 - Math.abs(index - center) / 1.5),
	}));
}

function toastLine(
	ui: Ui,
	now: number,
): { line: Line; fading: boolean } | null {
	const { toast } = ui;
	if (!toast) return null;
	const elapsed = now - toast.at;
	if (elapsed >= toast.ms) return null;
	const fadeIn = elapsed / FADE_MS;
	const fadeOut = (toast.ms - elapsed) / FADE_MS;
	const fade = Math.min(1, fadeIn, fadeOut);
	return {
		line: {
			segs: [
				{
					t: `${toast.glyph} `,
					fg:
						toast.glyph === '✓' ? 'ok' : toast.glyph === '✗' ? 'err' : 'faint',
				},
				{ t: toast.subject, fg: 'fg' },
				...(toast.detail
					? [sep, { t: toast.detail, fg: 'faint' } satisfies Seg]
					: []),
			],
			fade,
		},
		fading: fade < 1,
	};
}

/** Where typed words go, shown before sending. */
export function destination(ui: Ui): string {
	const { typing, screen } = ui;
	if (typing?.mode === 'answer')
		return `answers ${typing.handle ?? 'the'}'s question`;
	const mention = typing?.text.match(/^@(\S*)/);
	if (mention)
		return mention[1] ? `straight to ${mention[1]}` : 'straight to a task';
	if (screen.name === 'task') return `straight to ${screen.handle}`;
	return 'the Router decides what to do';
}

function inputLine(model: Model, ui: Ui, content: number, now: number): Line {
	const offline = model.connection.state !== 'live';
	const preview: Seg[] = [
		{ t: '→ ', fg: 'accent' },
		{ t: destination(ui), fg: 'faint' },
	];
	if (ui.typing) {
		const text = ui.typing.text.replaceAll(/\s/g, ' ');
		const room = Math.max(4, content - 2 - 1 - width(preview) - 2);
		const shown = tail(text, room);
		return {
			segs: [
				{ t: '› ', fg: 'accent' },
				{ t: shown, fg: 'fg' },
				{ t: Math.floor(now / 500) % 2 === 0 ? '▏' : ' ', fg: 'accent' },
			],
			right: preview,
			bg: 'surface',
		};
	}
	const placeholder = offline
		? 'the agent is offline'
		: ui.screen.name === 'task'
			? 'press / to write to this task'
			: 'press / to ask, or start with @ to message a task';
	return {
		segs: [
			{ t: '› ', fg: offline ? 'faint' : 'accent' },
			{ t: placeholder, fg: 'faint', i: true },
		],
		...(ui.screen.name === 'task' && !offline ? { right: preview } : {}),
	};
}

/** The end of `text` that fits in `room` columns. */
function tail(text: string, room: number): string {
	if (width(text) <= room) return text;
	const chars = Array.from(text);
	let used = 0;
	let start = chars.length;
	while (start > 0) {
		const next = width(chars[start - 1] ?? '');
		if (used + next > room - 1) break;
		used += next;
		start -= 1;
	}
	return `…${chars.slice(start).join('')}`;
}

function hintLine(model: Model, ui: Ui, content: number): Seg[] {
	if (ui.typing) {
		return hint([
			['enter', 'send'],
			['esc', 'cancel'],
		]);
	}
	if (ui.confirmStop) {
		const task = model.live?.tasks.get(ui.confirmStop);
		return [
			{ t: 'press ', fg: 'faint' },
			{ t: 's', fg: 'dim', b: true },
			{
				t: ` again to ${task?.status === 'failed' ? 'dismiss' : 'stop'} ${ui.confirmStop}`,
				fg: 'faint',
			},
			sep,
			{ t: 'any other key cancels', fg: 'faint' },
		];
	}
	const live = model.live;
	if (live === null || model.connection.state === 'rejected') {
		return hint([
			['?', 'keys'],
			['q', 'quit'],
		]);
	}
	const { screen } = ui;
	if (screen.name === 'task') {
		const task = live.tasks.get(screen.handle);
		const pairs: Array<[string, string]> = [['/', 'write']];
		if (task?.status === 'needs_you') pairs.push(['enter', 'answer']);
		const link = task ? linkOf(task) : null;
		if (link) pairs.push(['o', `open ${link.title}`]);
		if (task && stoppable(task))
			pairs.push(['s s', task.status === 'failed' ? 'dismiss' : 'stop']);
		pairs.push(['esc', 'back']);
		return fitHint(pairs, content, ['s s']);
	}
	if (screen.name === 'health') {
		const failed = [...live.tasks.values()].some(
			(task) => task.status === 'failed' && !task.dismissed,
		);
		return hint([
			...(failed ? [['r', 'resume failed'] satisfies [string, string]] : []),
			['esc', 'back'],
			['?', 'keys'],
		]);
	}
	if (screen.name === 'keys') return hint([['esc', 'back']]);

	const items = homeItems(live);
	const selected: Item | undefined = items.find(
		(item) => item.key === ui.selected,
	);
	const pairs: Array<[string, string]> = [];
	if (items.length > 1) pairs.push(['j/k', 'move']);
	if (selected?.kind === 'problem') pairs.push(['enter', 'health']);
	else if (selected?.kind === 'task') {
		pairs.push([
			'enter',
			selected.task.status === 'needs_you' ? 'answer' : 'open',
		]);
	}
	pairs.push(['/', 'write']);
	if (selected?.kind === 'task' && stoppable(selected.task))
		pairs.push(['s s', selected.task.status === 'failed' ? 'dismiss' : 'stop']);
	pairs.push(['h', 'health'], ['?', 'keys'], ['q', 'quit']);
	return fitHint(pairs, content, ['q', 's s', 'h', 'j/k']);
}

/** Drops the hints named in `drop`, in order, until the rest fit. */
function fitHint(
	pairs: Array<[string, string]>,
	content: number,
	drop: string[],
): Seg[] {
	let list = pairs;
	for (const key of drop) {
		if (width(hint(list)) <= content) break;
		list = list.filter(([k]) => k !== key);
	}
	return truncate(hint(list), content);
}
