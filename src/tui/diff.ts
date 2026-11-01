import { type Line, type Seg, fitStart, truncate } from './cells.ts';

const MAX_LINES = 80;
const MAX_TOKENS = 200;

type DiffRow =
	| { kind: 'hunk'; text: string }
	| { kind: 'context' | 'add' | 'remove'; number: number; code: string };

/** A unified diff under a step, indented 4, at most `columns` wide. */
export function diffLines(text: string, columns: number): Line[] {
	const rows = parse(text);
	const lines: Line[] = [];
	const shown = rows.slice(0, MAX_LINES);
	const changed = wordChanges(shown);
	shown.forEach((row, index) => {
		if (row.kind === 'hunk') {
			lines.push({
				segs: [
					{ t: '    ' },
					{ t: ` ${row.text} `, fg: 'faint', bg: 'surface' },
				],
			});
			return;
		}
		const sign: Seg =
			row.kind === 'add'
				? { t: '+', fg: 'ok' }
				: row.kind === 'remove'
					? { t: '−', fg: 'err' }
					: { t: ' ' };
		const fg = row.kind === 'remove' ? 'dim' : 'fg';
		const words = changed.get(index);
		const code: Seg[] = words
			? words.map(({ t, changed: hit }): Seg =>
					hit
						? { t, fg, bg: row.kind === 'add' ? 'okWord' : 'errWord' }
						: { t, fg },
				)
			: [{ t: row.code, fg }];
		lines.push({
			segs: truncate(
				[
					{ t: '    ' },
					{ t: fitStart(String(row.number), 4), fg: 'ghost' },
					{ t: ' ' },
					sign,
					{ t: ' ' },
					...code,
				],
				columns,
			),
			...(row.kind === 'add'
				? { bg: 'okSoft' }
				: row.kind === 'remove'
					? { bg: 'errSoft' }
					: {}),
		});
	});
	if (rows.length > MAX_LINES) {
		lines.push({
			segs: [{ t: `    … ${rows.length - MAX_LINES} more lines`, fg: 'faint' }],
		});
	}
	return lines;
}

function parse(text: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let oldNumber = 0;
	let newNumber = 0;
	let inHunk = false;
	for (const raw of text.split('\n')) {
		const line = raw.replaceAll('\t', '    ');
		const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
		if (hunk) {
			oldNumber = Number(hunk[1]);
			newNumber = Number(hunk[2]);
			inHunk = true;
			rows.push({ kind: 'hunk', text: line });
			continue;
		}
		if (!inHunk || line.startsWith('\\')) continue;
		if (line.startsWith('+')) {
			rows.push({ kind: 'add', number: newNumber, code: line.slice(1) });
			newNumber += 1;
		} else if (line.startsWith('-')) {
			rows.push({ kind: 'remove', number: oldNumber, code: line.slice(1) });
			oldNumber += 1;
		} else if (line.startsWith(' ')) {
			rows.push({ kind: 'context', number: newNumber, code: line.slice(1) });
			oldNumber += 1;
			newNumber += 1;
		} else if (line.startsWith('diff ')) {
			inHunk = false;
		}
	}
	return rows;
}

type Word = { t: string; changed: boolean };

/** Pairs each run of removed lines with the added lines after it, word by word. */
function wordChanges(rows: DiffRow[]): Map<number, Word[]> {
	const out = new Map<number, Word[]>();
	let index = 0;
	while (index < rows.length) {
		if (rows[index]?.kind !== 'remove') {
			index += 1;
			continue;
		}
		const removed: number[] = [];
		while (rows[index]?.kind === 'remove') removed.push(index++);
		const added: number[] = [];
		while (rows[index]?.kind === 'add') added.push(index++);
		for (let k = 0; k < Math.min(removed.length, added.length); k += 1) {
			const a = rows[removed[k] ?? -1];
			const b = rows[added[k] ?? -1];
			if (!a || !b || a.kind === 'hunk' || b.kind === 'hunk') continue;
			const pair = compare(a.code, b.code);
			if (!pair) continue;
			out.set(removed[k] ?? -1, pair.before);
			out.set(added[k] ?? -1, pair.after);
		}
	}
	return out;
}

function compare(
	before: string,
	after: string,
): { before: Word[]; after: Word[] } | null {
	const a = before.match(/\s+|\w+|[^\w\s]/g) ?? [];
	const b = after.match(/\s+|\w+|[^\w\s]/g) ?? [];
	if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) return null;
	const table: number[][] = Array.from({ length: a.length + 1 }, () =>
		Array<number>(b.length + 1).fill(0),
	);
	for (let i = a.length - 1; i >= 0; i -= 1) {
		for (let j = b.length - 1; j >= 0; j -= 1) {
			const row = table[i] ?? [];
			row[j] =
				a[i] === b[j]
					? (table[i + 1]?.[j + 1] ?? 0) + 1
					: Math.max(table[i + 1]?.[j] ?? 0, row[j + 1] ?? 0);
		}
	}
	const common = table[0]?.[0] ?? 0;
	// Lines with little in common read better without word marks.
	if (common < 0.4 * Math.max(a.length, b.length)) return null;
	const left: Word[] = [];
	const right: Word[] = [];
	let i = 0;
	let j = 0;
	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			left.push({ t: a[i] ?? '', changed: false });
			right.push({ t: b[j] ?? '', changed: false });
			i += 1;
			j += 1;
		} else if (
			j < b.length &&
			(i >= a.length || (table[i]?.[j + 1] ?? 0) >= (table[i + 1]?.[j] ?? 0))
		) {
			right.push({ t: b[j] ?? '', changed: true });
			j += 1;
		} else {
			left.push({ t: a[i] ?? '', changed: true });
			i += 1;
		}
	}
	return { before: left, after: right };
}
