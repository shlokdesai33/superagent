import { width } from './cells.ts';

/** What's in the input box, and where its cursor is: a UTF-16 offset at a grapheme boundary. */
export type Draft = { text: string; cursor: number };

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Where each grapheme starts, then the end of the text. */
function stops(text: string): number[] {
	const out = [...segmenter.segment(text)].map((part) => part.index);
	out.push(text.length);
	return out;
}

export function insert(draft: Draft, text: string): void {
	draft.text =
		draft.text.slice(0, draft.cursor) + text + draft.text.slice(draft.cursor);
	draft.cursor += text.length;
}

export function clear(draft: Draft): void {
	draft.text = '';
	draft.cursor = 0;
}

export function left(draft: Draft): void {
	draft.cursor = stops(draft.text).findLast((at) => at < draft.cursor) ?? 0;
}

export function right(draft: Draft): void {
	draft.cursor =
		stops(draft.text).find((at) => at > draft.cursor) ?? draft.text.length;
}

export function backspace(draft: Draft): void {
	const end = draft.cursor;
	left(draft);
	draft.text = draft.text.slice(0, draft.cursor) + draft.text.slice(end);
}

export function deleteForward(draft: Draft): void {
	const start = draft.cursor;
	right(draft);
	draft.text = draft.text.slice(0, start) + draft.text.slice(draft.cursor);
	draft.cursor = start;
}

/**
 * ↑ / ↓ in a wrapped draft: the same column on the row above or below, given
 * where each row on screen starts. Past the first or last row, its start or end.
 */
export function vertical(draft: Draft, starts: number[], step: 1 | -1): void {
	const row = starts.findLastIndex((start) => start <= draft.cursor);
	const target = row + step;
	if (row === -1 || target < 0) {
		draft.cursor = 0;
		return;
	}
	if (target >= starts.length) {
		draft.cursor = draft.text.length;
		return;
	}
	const column = width(draft.text.slice(starts[row], draft.cursor));
	const start = starts[target] ?? 0;
	const end = starts[target + 1] ?? draft.text.length;
	let at = start;
	let used = 0;
	for (const { segment, index } of segmenter.segment(
		draft.text.slice(start, end),
	)) {
		used += width(segment);
		if (used > column) break;
		at = start + index + segment.length;
	}
	// The end of a row that isn't the last is where the next one starts.
	if (target < starts.length - 1 && at >= end) {
		at = stops(draft.text).findLast((stop) => stop < end) ?? start;
	}
	draft.cursor = at;
}

/** Ctrl-W: the word before the cursor, and the spaces after it. */
export function deleteWord(draft: Draft): void {
	const before = draft.text.slice(0, draft.cursor);
	const start = before.replace(/\S*\s*$/u, '').length;
	draft.text = draft.text.slice(0, start) + draft.text.slice(draft.cursor);
	draft.cursor = start;
}
