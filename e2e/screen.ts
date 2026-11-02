// Replays the TUI's output on a grid of cells, so a check can read the
// colours a terminal would show on the final screen, after every fade.
import { type Rgb, xterm256 } from '../src/tui/theme.ts';

export const COLUMNS = 100;
export const ROWS = 30;

export type ScreenCell = {
	ch: string;
	/** The 256-colour index, when set with `38;5;n` / `48;5;n`. */
	fg: number | null;
	bg: number | null;
	/** The colour shown, at either depth; `null` is the terminal's own. */
	fgRgb: Rgb | null;
	bgRgb: Rgb | null;
	bold: boolean;
	italic: boolean;
};

export type Screen = {
	cells: ScreenCell[][];
	/** SGR parameters that aren't a reset, bold, italic, underline or a 256-colour index. */
	foreign: Set<string>;
};

function empty(): ScreenCell {
	return {
		ch: ' ',
		fg: null,
		bg: null,
		fgRgb: null,
		bgRgb: null,
		bold: false,
		italic: false,
	};
}

export function replay(raw: string): Screen {
	const cells = Array.from({ length: ROWS }, () =>
		Array.from({ length: COLUMNS }, empty),
	);
	const foreign = new Set<string>();
	let row = 0;
	let column = 0;
	let pen = empty();
	let i = 0;
	while (i < raw.length) {
		const ch = raw[i] ?? '';
		if (ch === '\x1b' && raw[i + 1] === '[') {
			let end = i + 2;
			while (end < raw.length && !/[@-~]/.test(raw[end] ?? '')) end += 1;
			const params = raw.slice(i + 2, end);
			const final = raw[end];
			i = end + 1;
			if (final === 'H') {
				const [y = '1', x = '1'] = params.split(';');
				row = Number(y) - 1;
				column = Number(x) - 1;
			} else if (final === 'J') {
				for (const line of cells) line.fill(empty());
			} else if (final === 'm' && !params.startsWith('?')) {
				const codes = params === '' ? ['0'] : params.split(';');
				for (let k = 0; k < codes.length; k += 1) {
					const code = codes[k];
					const layer = code === '38' ? 'fg' : code === '48' ? 'bg' : null;
					if (code === '0') pen = empty();
					else if (code === '1') pen = { ...pen, bold: true };
					else if (code === '3') pen = { ...pen, italic: true };
					else if (code === '4') continue;
					else if (code === '39') pen = { ...pen, fg: null, fgRgb: null };
					else if (code === '49') pen = { ...pen, bg: null, bgRgb: null };
					else if (layer && codes[k + 1] === '5') {
						const index = Number(codes[k + 2]);
						if (!(index >= 16 && index <= 255))
							foreign.add(`${code};5;${index}`);
						pen = { ...pen, [layer]: index, [`${layer}Rgb`]: xterm256(index) };
						k += 2;
					} else if (layer && codes[k + 1] === '2') {
						foreign.add(`${code};2`);
						const rgb: Rgb = [
							Number(codes[k + 2]),
							Number(codes[k + 3]),
							Number(codes[k + 4]),
						];
						pen = { ...pen, [layer]: null, [`${layer}Rgb`]: rgb };
						k += 4;
					} else {
						foreign.add(codes.slice(k, k + 2).join(';'));
					}
				}
			}
			continue;
		}
		if (ch === '\x1b' && raw[i + 1] === ']') {
			const bel = raw.indexOf('\x07', i);
			const st = raw.indexOf('\x1b\\', i);
			if (st !== -1 && (bel === -1 || st < bel)) i = st + 2;
			else i = bel === -1 ? raw.length : bel + 1;
			continue;
		}
		if (ch === '\x1b') {
			i += 2;
			continue;
		}
		const point = String.fromCodePoint(raw.codePointAt(i) ?? 32);
		i += point.length;
		if (point < ' ') continue;
		const line = cells[row];
		if (line && column < COLUMNS) line[column] = { ...pen, ch: point };
		column += 1;
	}
	return { cells, foreign };
}

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/**
 * The rows' text at any size, without colours: cursor moves and clears on a
 * grid without autowrap, as the UI sets it, where a wide character (CJK,
 * emoji) takes two columns.
 */
export function replayText(
	raw: string,
	columns: number,
	rows: number,
): string[] {
	const grid = Array.from({ length: rows }, () =>
		Array<string>(columns).fill(' '),
	);
	let row = 0;
	let column = 0;
	const token =
		// oxlint-disable-next-line no-control-regex
		/\x1b\[([0-?]*)[ -/]*([@-~])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b.|([^\x1b]+)/gs;
	for (const match of raw.matchAll(token)) {
		const [, params = '', final, printed] = match;
		if (printed !== undefined) {
			for (const { segment } of segmenter.segment(printed)) {
				if (segment < ' ') continue;
				const w = Math.max(1, Math.min(2, Bun.stringWidth(segment)));
				const line = grid[row];
				if (line && column + w <= columns) {
					line[column] = segment;
					if (w === 2) line[column + 1] = '';
				}
				column += w;
			}
		} else if (final === 'H') {
			const [y = '1', x = '1'] = params.split(';');
			row = Number(y || 1) - 1;
			column = Number(x || 1) - 1;
		} else if (final === 'J' && params === '2') {
			for (const line of grid) line.fill(' ');
		}
	}
	return grid.map((line) => line.join(''));
}

/** A cell as Terminal.app before macOS 26 shows it. */
export type OldTerminalCell = {
	ch: string;
	faint: boolean;
	fg: string;
	bg: string;
};

function blank(): OldTerminalCell {
	return { ch: ' ', faint: false, fg: 'default', bg: 'default' };
}

/**
 * Replays the output as Terminal.app before macOS 26 reads SGR: it knows
 * `38;5;n`, but not `38;2`, so it drops the 38 and reads `2` (faint), r, g
 * and b as codes of their own.
 */
export function replayOldTerminal(raw: string): OldTerminalCell[][] {
	const cells = Array.from({ length: ROWS }, () =>
		Array.from({ length: COLUMNS }, blank),
	);
	let pen = blank();
	let row = 0;
	let column = 0;
	let i = 0;
	while (i < raw.length) {
		if (raw[i] === '\x1b' && raw[i + 1] === '[') {
			let end = i + 2;
			while (end < raw.length && !/[@-~]/.test(raw[end] ?? '')) end += 1;
			const params = raw.slice(i + 2, end);
			const final = raw[end];
			i = end + 1;
			if (final === 'H') {
				const [y = '1', x = '1'] = params.split(';');
				row = Number(y) - 1;
				column = Number(x) - 1;
			} else if (final === 'm' && !params.startsWith('?')) {
				const codes = (params || '0').split(';').map(Number);
				for (let k = 0; k < codes.length; k += 1) {
					const code = codes[k] ?? 0;
					if ((code === 38 || code === 48) && codes[k + 1] === 5) {
						const index = String(codes[k + 2]);
						pen = code === 38 ? { ...pen, fg: index } : { ...pen, bg: index };
						k += 2;
					} else if (code === 0) pen = blank();
					else if (code === 2) pen = { ...pen, faint: true };
					else if (code === 22) pen = { ...pen, faint: false };
					else if (code === 39) pen = { ...pen, fg: 'default' };
					else if (code === 49) pen = { ...pen, bg: 'default' };
					else if (code >= 30 && code <= 37)
						pen = { ...pen, fg: `ansi ${code}` };
					else if (code >= 40 && code <= 47)
						pen = { ...pen, bg: `ansi ${code}` };
				}
			}
			continue;
		}
		if (raw[i] === '\x1b' && raw[i + 1] === ']') {
			const bel = raw.indexOf('\x07', i);
			const st = raw.indexOf('\x1b\\', i);
			if (st !== -1 && (bel === -1 || st < bel)) i = st + 2;
			else i = bel === -1 ? raw.length : bel + 1;
			continue;
		}
		if (raw[i] === '\x1b') {
			i += 2;
			continue;
		}
		const point = String.fromCodePoint(raw.codePointAt(i) ?? 32);
		i += point.length;
		if (point < ' ') continue;
		const line = cells[row];
		if (line && column < COLUMNS) line[column] = { ...pen, ch: point };
		column += 1;
	}
	return cells;
}

/** The cells of `word` in the first row that has it, from either replay. */
export function findIn<T extends { ch: string }>(
	cells: T[][],
	word: string,
): T[] {
	for (const row of cells) {
		const at = row
			.map((cell) => cell.ch)
			.join('')
			.indexOf(word);
		if (at !== -1) return row.slice(at, at + word.length);
	}
	return [];
}

export function text(line: ScreenCell[]): string {
	return line.map((cell) => cell.ch).join('');
}

/** The cells of `word` in the first row that has it. */
export function find(
	screen: Screen,
	word: string,
): { row: ScreenCell[]; cells: ScreenCell[] } | null {
	for (const row of screen.cells) {
		const at = text(row).indexOf(word);
		if (at !== -1) return { row, cells: row.slice(at, at + word.length) };
	}
	return null;
}

function luminance(rgb: Rgb): number {
	const [r, g, b] = rgb.map((value) => {
		const s = value / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

/** The WCAG contrast ratio. */
export function contrast(a: Rgb, b: Rgb): number {
	const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
	return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}
