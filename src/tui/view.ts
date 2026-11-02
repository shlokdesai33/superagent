import {
	type Cell,
	type Line,
	MARGIN,
	type Seg,
	hang,
	paint,
	resolve,
	truncate,
	width,
	wrap,
} from './cells.ts';
import { clock, plural, tokens } from './format.ts';
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
import {
	MEASURE,
	chip,
	figure,
	hint,
	paragraphs,
	rule,
	sep,
	spinner,
} from './parts.ts';
import { healthBody } from './screens/health.ts';
import { homeBody } from './screens/home.ts';
import { keysBody } from './screens/keys.ts';
import { taskBody } from './screens/task.ts';
import { repoChoices, repoName } from './repo.ts';
import { FADE_MS, type Overflow, type Ui, toRouter } from './state.ts';
import { type Rgb, type Theme, blend } from './theme.ts';

const MIN_COLUMNS = 40;
/** Columns left to type in before the destination preview drops the Router. */
const MIN_TYPING = 40;
/** Columns a draft needs beside the preview to start on its row. */
const MIN_BESIDE_PREVIEW = 12;
const MIN_ROWS = 12;
/** Body rows kept when the composer and a toast grow. */
const MIN_BODY = 3;
const FLASH_MS = 650;
const SWEEP_MS = 1_000;
const SWEEP_EVERY_MS = 3_000;

export type Frame = {
	rows: Cell[][];
	/** Something moves, so the next frame is due in 80 ms. */
	animating: boolean;
	/** The scroll offset used, to keep for the next frame. */
	scroll: number;
	/** Home rows hidden around the selection, for the next j/k. */
	overflow: Overflow;
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
			overflow: { above: false, below: false },
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

	const footer: Line[] = [rule(content)];
	let routerRows = 0;
	if (home && live) {
		const router = routerLines(live, dataNow, theme, content);
		if (live.router.deciding && !stale) animating = true;
		footer.push(...router);
		routerRows = router.length;
	}
	// The composer and the toast grow with their text, leaving the body a
	// few rows; past that, the composer shows its end and the toast is cut.
	const spare = Math.max(1, rows - 2 - footer.length - 1 - MIN_BODY);
	const input = inputLines(
		model,
		ui,
		content,
		Math.max(2, Math.min(Math.floor(rows / 2), spare)),
		now,
	);
	const toast = toastLines(
		ui,
		now,
		content,
		Math.max(1, Math.min(Math.floor(rows / 3), spare - input.length)),
	);
	if (toast) {
		footer.push(...toast.lines);
		if (toast.fading) animating = true;
	}
	footer.push(...input, { segs: hintLine(model, ui, content) });

	const bodyHeight = Math.max(0, rows - 2 - footer.length);
	const titleCut =
		ui.screen.name === 'task' &&
		width(header.segs) + (header.right ? width(header.right) + 2 : 0) > content;
	const body = bodyLines(model, ui, {
		content,
		wide: columns >= 100,
		now: dataNow,
		height: bodyHeight,
		titleCut,
	});
	if (body.animating && !stale) animating = true;

	const { scroll, overflow } = scrollFor(body.lines, ui, bodyHeight);
	const visible = body.lines.slice(scroll, scroll + bodyHeight);

	const screen: Line[] = [header, rule(content), ...visible];
	while (screen.length < 2 + bodyHeight) screen.push({ segs: [] });
	screen.push(...footer);

	const top = 2;
	const routerFrom = top + bodyHeight + 1;
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
		const inRouter = y >= routerFrom && y < routerFrom + routerRows;
		return stale && (inBody || inRouter)
			? cells.map((cell) => mute(cell, ui))
			: cells;
	});
	return { rows: painted, animating, scroll, overflow };
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
		const segs: Seg[] = [{ t: '○ not running', fg: 'faint' }];
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
	return { key: 'calm', segs: [{ t: '● running', fg: 'ok' }] };
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
		meta.push(figure(String(workingCount(live)), 'working'));
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

type BodyLayout = {
	content: number;
	/** 100 columns or wider. */
	wide: boolean;
	now: number;
	/** Body rows on screen. */
	height: number;
	/** The header cut the task's title short. */
	titleCut: boolean;
};

function bodyLines(
	model: Model,
	ui: Ui,
	{ content, wide, now, height, titleCut }: BodyLayout,
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
					...prose([{ t: "superagent isn't running", fg: 'fg', b: true }]),
					...prose([
						{ t: 'Start it with ', fg: 'faint' },
						chip('superagent start'),
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
			lines: [{ segs: [{ t: 'Connecting to superagent…', fg: 'faint' }] }],
			animating: false,
		};
	}
	switch (ui.screen.name) {
		case 'home':
			return homeBody(live, ui, content, wide, now, height);
		case 'task':
			return taskBody(live, ui, ui.screen.handle, content, now, titleCut);
		case 'health':
			return { lines: healthBody(live, content, now), animating: false };
		case 'keys':
			return { lines: keysBody(content), animating: false };
	}
}

/**
 * Home keeps the selection in view, its top first when it's taller than the
 * screen, until j/k scroll on through rows it hides (`ui.scroll.free`).
 */
function scrollFor(
	lines: Line[],
	ui: Ui,
	height: number,
): { scroll: number; overflow: Overflow } {
	const max = Math.max(0, lines.length - height);
	const clamp = (offset: number) => Math.max(0, Math.min(offset, max));
	if (ui.screen.name !== 'home') {
		return {
			scroll: clamp(ui.scroll.page),
			overflow: { above: false, below: false },
		};
	}
	let offset = clamp(ui.scroll.home);
	const key = ui.selected;
	const first = key === null ? -1 : lines.findIndex((line) => line.key === key);
	if (first === -1) {
		return {
			scroll: offset,
			overflow: { above: offset > 0, below: offset + height < lines.length },
		};
	}
	let last = first;
	while (lines[last + 1]?.key === key) last += 1;
	// Keep the section label in view above the first item of a section.
	const from =
		first > 0 &&
		lines[first - 1]?.key === undefined &&
		lines[first - 1]?.segs.length
			? first - 1
			: first;
	if (!ui.scroll.free) {
		if (last >= offset + height) offset = last - height + 1;
		if (from < offset) offset = from;
		offset = clamp(offset);
	}
	const lastItem = lines.findLast((line) => line.key !== undefined)?.key;
	return {
		scroll: offset,
		overflow: {
			above: from < offset,
			below:
				last >= offset + height ||
				(key === lastItem && offset + height < lines.length),
		},
	};
}

/** `◇ router  …`, wrapped under its text. */
function routerLines(
	live: Live,
	now: number,
	theme: Theme,
	content: number,
): Line[] {
	const { router } = live;
	const prefix: Seg[] = [
		{ t: '◇ ', fg: router.deciding ? 'accent' : 'dim' },
		{ t: 'router  ', fg: 'dim' },
	];
	const segs: Seg[] = [];
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
	return hang(prefix, segs, content);
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

/** The toast, wrapped under its sentence; past `maxLines` it ends in `…`. */
function toastLines(
	ui: Ui,
	now: number,
	content: number,
	maxLines: number,
): { lines: Line[]; fading: boolean } | null {
	const { toast } = ui;
	if (!toast) return null;
	const elapsed = now - toast.at;
	if (elapsed >= toast.ms) return null;
	const fadeIn = elapsed / FADE_MS;
	const fadeOut = (toast.ms - elapsed) / FADE_MS;
	const fade = Math.min(1, fadeIn, fadeOut);
	const all = hang(
		[
			{
				t: `${toast.glyph} `,
				fg: toast.glyph === '✓' ? 'ok' : toast.glyph === '✗' ? 'err' : 'faint',
			},
		],
		[
			{ t: paragraphs(toast.subject), fg: 'fg' },
			...(toast.detail
				? [sep, { t: paragraphs(toast.detail), fg: 'faint' } satisfies Seg]
				: []),
		],
		content,
	);
	const lines = all.slice(0, maxLines);
	const last = lines.at(-1);
	if (last && all.length > maxLines)
		last.segs = truncate(last.segs, content, true);
	for (const line of lines) line.fade = fade;
	return { lines, fading: fade < 1 };
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

/** `new tasks in <repo>` while console messages name a default repository. */
function newTasksIn(model: Model, ui: Ui): string | null {
	const { path } = ui.repo;
	if (path === null || model.live === null) return null;
	// An agent from before `health.repos` sends none.
	return `new tasks in ${repoName(path, model.live.health.repos ?? [])}`;
}

/** The input line; while typing, the draft wraps over up to `maxLines` rows. */
function inputLines(
	model: Model,
	ui: Ui,
	content: number,
	maxLines: number,
	now: number,
): Line[] {
	const offline = model.connection.state !== 'live';
	const repo = offline ? null : newTasksIn(model, ui);
	let to = destination(ui);
	if (repo !== null && toRouter(ui)) {
		const full = `the Router decides · ${repo}`;
		// Narrow terminals keep room to type.
		to = content - width(full) >= MIN_TYPING ? full : repo;
	}
	const preview: Seg[] = [
		{ t: '→ ', fg: 'accent' },
		{ t: to, fg: 'faint' },
	];
	if (ui.typing) {
		const text = ui.typing.text.replaceAll(/\s/g, ' ');
		const draft: Seg[] = [{ t: text, fg: 'fg' }];
		const rest = content - 2;
		const first = rest - width(preview) - 2;
		// Too narrow beside the preview: the draft starts on the next row.
		const beside = first >= MIN_BESIDE_PREVIEW;
		const lines = beside
			? wrap(draft, rest, Infinity, first)
			: text === ''
				? [[]]
				: [[], ...wrap(draft, rest)];
		const cursor: Seg = {
			t: Math.floor(now / 500) % 2 === 0 ? '▏' : ' ',
			fg: 'accent',
		};
		const end = lines.length - 1;
		const endLine = lines[end] ?? [];
		if (width(endLine) < (end === 0 ? first : rest)) endLine.push(cursor);
		else lines.push([cursor]);
		// Past `maxLines`, the end of the draft, where you're typing, stays.
		let shown = lines;
		if (lines.length > maxLines) {
			// Without room beside the preview, its row stays empty above the notice.
			const top = beside ? 0 : 1;
			const hidden = lines.length - maxLines + 1;
			shown = [
				...lines.slice(0, top),
				[{ t: `… ${hidden} earlier ${plural(hidden, 'line')}`, fg: 'faint' }],
				...lines.slice(top + hidden),
			];
		}
		const band: Line[] = shown.map((segs) => ({
			segs: [{ t: '  ' }, ...segs],
			bg: 'surface',
		}));
		const [top] = band;
		if (top) {
			top.segs[0] = { t: '› ', fg: 'accent' };
			top.right = preview;
		}
		return band;
	}
	const placeholder = offline
		? "superagent isn't running"
		: ui.screen.name === 'task'
			? 'press / to write to this task'
			: 'press / to ask, or start with @ to message a task';
	const segs: Seg[] = [
		{ t: '› ', fg: offline ? 'faint' : 'accent' },
		{ t: placeholder, fg: 'faint', i: true },
	];
	if (ui.screen.name === 'task') {
		return [{ segs, ...(offline ? {} : { right: preview }) }];
	}
	// Shown only when the placeholder still fits beside it.
	return [
		repo !== null && width(segs) + 2 + width(repo) <= content
			? { segs, right: [{ t: repo, fg: 'faint' }] }
			: { segs },
	];
}

function hintLine(model: Model, ui: Ui, content: number): Seg[] {
	if (ui.typing) {
		const pairs: Array<[string, string]> = [['enter', 'send']];
		if (
			toRouter(ui) &&
			repoChoices(ui.repo.startedIn, model.live?.health.repos ?? []).length > 0
		) {
			pairs.push(['tab', 'change repo']);
		}
		pairs.push(['esc', 'cancel']);
		return fitHint(pairs, content, ['tab']);
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
