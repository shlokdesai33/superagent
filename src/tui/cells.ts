import {
	type ColorDepth,
	type Rgb,
	type Role,
	type Theme,
	blend,
	nearest256,
} from './theme.ts';

export type Color = Role | Rgb;

/** A run of text in one style. */
export type Seg = {
	t: string;
	fg?: Color;
	bg?: Color;
	b?: boolean;
	i?: boolean;
	u?: boolean;
	/** An OSC 8 hyperlink target; drawn underlined. */
	link?: string;
};

/** One painted row, before it's laid out to the terminal width. */
export type Line = {
	segs: Seg[];
	/** Right-aligned; ends one column before the edge. */
	right?: Seg[];
	/** A tint across the whole row. */
	bg?: Color;
	/** The item this row belongs to, for selection and arrival highlights. */
	key?: string;
	/** 0 to 1; text blends toward the row's background below 1. */
	fade?: number;
};

export type Cell = {
	/** One grapheme; `''` for the second half of a wide one. */
	ch: string;
	fg: Rgb;
	bg: Rgb;
	attrs: number;
	link: string | null;
};

export const BOLD = 1;
export const ITALIC = 2;
export const UNDERLINE = 4;

/** Columns after the content. */
export const MARGIN = 1;

type Glyph = { g: string; w: number; seg: Seg };

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
// C0 and C1 controls would move the cursor or restyle and break the cell grid.
// oxlint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;

export function resolve(theme: Theme, color: Color): Rgb {
	return typeof color === 'string' ? theme[color] : color;
}

function glyphs(seg: Seg): Glyph[] {
	const text = seg.t.replace(CONTROLS, ' ');
	if (PRINTABLE_ASCII.test(text)) {
		return Array.from(text, (g) => ({ g, w: 1, seg }));
	}
	const out: Glyph[] = [];
	for (const { segment } of segmenter.segment(text)) {
		if (segment === '\n') {
			out.push({ g: '\n', w: 0, seg });
			continue;
		}
		const w = Bun.stringWidth(segment);
		if (w === 0) continue;
		out.push({ g: segment, w: Math.min(w, 2), seg });
	}
	return out;
}

function toGlyphs(segs: Seg[], flatten = true): Glyph[] {
	const out: Glyph[] = [];
	for (const seg of segs) {
		for (const glyph of glyphs(seg)) {
			out.push(
				flatten && glyph.g === '\n' ? { ...glyph, g: ' ', w: 1 } : glyph,
			);
		}
	}
	return out;
}

function toSegs(list: Glyph[]): Seg[] {
	const out: Seg[] = [];
	let last: Seg | null = null;
	let text = '';
	for (const { g, seg } of list) {
		if (seg !== last) {
			if (last) out.push({ ...last, t: text });
			last = seg;
			text = '';
		}
		text += g;
	}
	if (last) out.push({ ...last, t: text });
	return out;
}

export function width(segs: Seg[] | string): number {
	const list = typeof segs === 'string' ? [{ t: segs }] : segs;
	let total = 0;
	for (const glyph of toGlyphs(list)) total += glyph.w;
	return total;
}

/** At most `room` columns, ending in `…` when cut (or always, with `more`). */
export function truncate(segs: Seg[], room: number, more = false): Seg[] {
	if (room <= 0) return [];
	const list = toGlyphs(segs);
	let total = 0;
	for (const glyph of list) total += glyph.w;
	if (total <= room && !more) return segs;
	if (more && total + 1 <= room) {
		const lastSeg = list.at(-1)?.seg ?? {};
		return [...segs, { ...lastSeg, t: '…' }];
	}
	const kept: Glyph[] = [];
	let used = 0;
	for (const glyph of list) {
		if (used + glyph.w > room - 1) break;
		kept.push(glyph);
		used += glyph.w;
	}
	while (kept.at(-1)?.g === ' ') kept.pop();
	const lastSeg = kept.at(-1)?.seg ?? list[0]?.seg ?? { t: '' };
	kept.push({ g: '…', w: 1, seg: lastSeg });
	return toSegs(kept);
}

/** `text` cut or padded to exactly `columns`. */
export function fit(text: string, columns: number): string {
	const cut = truncate([{ t: text }], columns)
		.map((seg) => seg.t)
		.join('');
	return cut + ' '.repeat(Math.max(0, columns - width(cut)));
}

/** `text` right-aligned in `columns`. */
export function fitStart(text: string, columns: number): string {
	const cut = truncate([{ t: text }], columns)
		.map((seg) => seg.t)
		.join('');
	return ' '.repeat(Math.max(0, columns - width(cut))) + cut;
}

/**
 * Word-wraps to `columns`, breaking `\n` too. Past `maxLines` the last line
 * ends in `…`.
 */
export function wrap(
	segs: Seg[],
	columns: number,
	maxLines = Infinity,
): Seg[][] {
	if (columns <= 0) return [];
	const lines: Glyph[][] = [];
	let line: Glyph[] = [];
	let used = 0;
	let pending: Glyph[] = [];
	const list = toGlyphs(segs, false);
	const flush = () => {
		lines.push(line);
		line = [];
		used = 0;
		pending = [];
	};
	let i = 0;
	while (i < list.length) {
		const glyph = list[i];
		if (glyph === undefined) break;
		if (glyph.g === '\n') {
			flush();
			i += 1;
			continue;
		}
		if (glyph.g === ' ') {
			if (line.length > 0) pending.push(glyph);
			i += 1;
			continue;
		}
		let end = i;
		let wordWidth = 0;
		while (end < list.length) {
			const next = list[end];
			if (next === undefined || next.g === ' ' || next.g === '\n') break;
			wordWidth += next.w;
			end += 1;
		}
		const word = list.slice(i, end);
		i = end;
		const gap = pending.reduce((n, g) => n + g.w, 0);
		if (used + gap + wordWidth <= columns) {
			line.push(...pending, ...word);
			used += gap + wordWidth;
			pending = [];
			continue;
		}
		if (line.length > 0) flush();
		for (const part of word) {
			if (used + part.w > columns) flush();
			line.push(part);
			used += part.w;
		}
		pending = [];
	}
	if (line.length > 0 || lines.length === 0) lines.push(line);
	const out = lines.map(toSegs);
	if (out.length <= maxLines) return out;
	const kept = out.slice(0, maxLines);
	const lastIndex = maxLines - 1;
	kept[lastIndex] = truncate(kept[lastIndex] ?? [], columns, true);
	return kept;
}

/** Lays a line out to exactly `columns` cells, margin included. */
export function paint(
	line: Line,
	theme: Theme,
	columns: number,
	rowBg: Rgb,
): Cell[] {
	const fade = line.fade ?? 1;
	const ink = (color: Color, under: Rgb) =>
		fade >= 1
			? resolve(theme, color)
			: blend(under, resolve(theme, color), fade);
	const cells: Cell[] = [];
	const blank = (): Cell => ({
		ch: ' ',
		fg: theme.fg,
		bg: rowBg,
		attrs: 0,
		link: null,
	});
	const put = (list: Glyph[]) => {
		for (const { g, w, seg } of list) {
			const bg = seg.bg === undefined ? rowBg : ink(seg.bg, rowBg);
			const link = seg.link ?? null;
			const attrs =
				(seg.b ? BOLD : 0) |
				(seg.i ? ITALIC : 0) |
				(seg.u || link ? UNDERLINE : 0);
			const cell: Cell = {
				ch: g,
				fg: ink(seg.fg ?? 'fg', bg),
				bg,
				attrs,
				link,
			};
			cells.push(cell);
			if (w === 2) cells.push({ ...cell, ch: '' });
		}
	};

	const content = Math.max(0, columns - MARGIN);

	const right = line.right && line.right.length > 0 ? line.right : null;
	const rightWidth = right ? Math.min(width(right), content) : 0;
	const leftRoom = right ? Math.max(0, content - rightWidth - 2) : content;
	const left = toGlyphs(truncate(line.segs, leftRoom));
	put(left);
	const leftWidth = left.reduce((n, g) => n + g.w, 0);
	if (right) {
		const rightList = toGlyphs(truncate(right, content - leftWidth));
		const rightUsed = rightList.reduce((n, g) => n + g.w, 0);
		const gap = content - leftWidth - rightUsed;
		for (let c = 0; c < gap; c += 1) cells.push(blank());
		put(rightList);
	}
	while (cells.length < columns) cells.push(blank());
	cells.length = columns;
	return cells;
}

function sgrColor(layer: 38 | 48, rgb: Rgb, depth: ColorDepth): string {
	return depth === 'truecolor'
		? `\x1b[${layer};2;${rgb[0]};${rgb[1]};${rgb[2]}m`
		: `\x1b[${layer};5;${nearest256(rgb)}m`;
}

/** One row as escape sequences, starting from a reset. */
export function serialize(cells: Cell[], depth: ColorDepth): string {
	let out = '';
	let fg: Rgb | null = null;
	let bg: Rgb | null = null;
	let attrs = -1;
	let link: string | null = null;
	for (const cell of cells) {
		if (cell.ch === '') continue;
		if (cell.link !== link) {
			out += `\x1b]8;;${cell.link ?? ''}\x1b\\`;
			link = cell.link;
		}
		if (cell.attrs !== attrs) {
			out += `\x1b[0${cell.attrs & BOLD ? ';1' : ''}${cell.attrs & ITALIC ? ';3' : ''}${cell.attrs & UNDERLINE ? ';4' : ''}m`;
			attrs = cell.attrs;
			fg = null;
			bg = null;
		}
		if (fg === null || !same(fg, cell.fg)) {
			out += sgrColor(38, cell.fg, depth);
			fg = cell.fg;
		}
		if (bg === null || !same(bg, cell.bg)) {
			out += sgrColor(48, cell.bg, depth);
			bg = cell.bg;
		}
		out += cell.ch;
	}
	if (link !== null) out += '\x1b]8;;\x1b\\';
	return out;
}

function same(a: Rgb, b: Rgb): boolean {
	return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}
