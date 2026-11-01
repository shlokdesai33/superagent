import type { Line, Seg } from './cells.ts';

export const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
export const BARS = '▁▂▃▄▅▆▇█';
export const FRAME_MS = 80;
/** Prose wraps at this many columns at most. */
export const MEASURE = 100;

/** Every spinner on screen shares this phase. */
export function spinner(now: number): string {
	return SPINNER[Math.floor(now / FRAME_MS) % SPINNER.length] ?? '⠋';
}

export const sep: Seg = { t: ' · ', fg: 'ghost' };

export function blank(): Line {
	return { segs: [] };
}

export function rule(columns: number): Line {
	return { segs: [{ t: '─'.repeat(Math.max(0, columns)), fg: 'ghost' }] };
}

/** `NEEDS YOU  1`, with an optional faint note after it. */
export function label(name: string, count?: number, note?: string): Line {
	const segs: Seg[] = [{ t: name, fg: 'faint' }];
	if (count !== undefined) segs.push({ t: `  ${count}`, fg: 'dim' });
	if (note) segs.push({ t: `   ${note}`, fg: 'faint' });
	return { segs };
}

/** `j/k move · enter open`: keys bold `dim`, words `faint`. */
export function hint(pairs: Array<[string, string]>): Seg[] {
	return pairs.flatMap(([key, word], index) => [
		...(index > 0 ? [sep] : []),
		{ t: key, fg: 'dim', b: true },
		{ t: ` ${word}`, fg: 'faint' },
	]);
}

/** `[enter] answer   [o] open`, for the selected row. */
export function bracketed(pairs: Array<[string, string]>): Seg[] {
	return pairs.flatMap(([key, word], index) => [
		...(index > 0 ? [{ t: '   ' }] : []),
		{ t: `[${key}]`, fg: 'dim', b: true },
		{ t: ` ${word}`, fg: 'faint' },
	]);
}

/** A command on a `surface` chip, one space of padding on each side. */
export function chip(text: string): Seg {
	return { t: ` ${text} `, fg: 'fg', bg: 'surface' };
}

/** `github · #142 alice`, in `faint` with a `ghost` dot. */
export function origin(value: {
	channel: string;
	place: string | null;
	author: string | null;
}): Seg[] {
	const segs: Seg[] = [{ t: value.channel, fg: 'faint' }];
	const rest = [value.place, value.author].filter(Boolean).join(' ');
	if (rest) segs.push(sep, { t: rest, fg: 'faint' });
	return segs;
}

/** `12k tokens`: the number `fg`, the unit `faint`. */
export function figure(value: string, unit: string): Seg[] {
	return [
		{ t: value, fg: 'fg' },
		{ t: ` ${unit}`, fg: 'faint' },
	];
}

/** Collapses whitespace, for one-line previews. */
export function oneLine(text: string): string {
	return text.replaceAll(/\s+/g, ' ').trim();
}
