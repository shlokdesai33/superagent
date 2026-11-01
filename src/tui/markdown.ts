import {
	type Color,
	type Line,
	type Seg,
	fit,
	truncate,
	width,
	wrap,
} from './cells.ts';

const INLINE =
	/`([^`]+)`|\[([^\]]+)\]\((\S+?)\)|(https?:\/\/[^\s<>()]+)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*/g;

type Style = { fg: Color; i?: boolean };

/** Inline markdown: code chips, links, and emphasis markers dropped. */
export function inline(text: string, style: Style): Seg[] {
	const base = (t: string): Seg => ({
		t,
		fg: style.fg,
		...(style.i ? { i: true } : {}),
	});
	const segs: Seg[] = [];
	let last = 0;
	for (const match of text.matchAll(INLINE)) {
		const index = match.index;
		if (index > last) segs.push(base(text.slice(last, index)));
		const [, code, label, url, bare, strong, strong2, emphasis] = match;
		if (code !== undefined) segs.push({ t: code, fg: 'fg', bg: 'surface' });
		else if (label !== undefined && url !== undefined) {
			segs.push({ ...base(label), link: url });
		} else if (bare !== undefined) segs.push({ ...base(bare), link: bare });
		else segs.push(base(strong ?? strong2 ?? emphasis ?? ''));
		last = index + match[0].length;
	}
	if (last < text.length) segs.push(base(text.slice(last)));
	return segs;
}

/** Block markdown as lines at most `columns` wide. */
export function markdown(text: string, columns: number): Line[] {
	const source = text.replaceAll('\t', '    ').split('\n');
	const lines: Line[] = [];
	const push = (segs: Seg[]) => lines.push({ segs });
	const space = () => {
		if (lines.length > 0 && lines.at(-1)?.segs.length !== 0) push([]);
	};
	let paragraph: string[] = [];
	const flush = () => {
		if (paragraph.length === 0) return;
		for (const segs of wrap(
			inline(paragraph.join(' '), { fg: 'fg' }),
			columns,
		)) {
			push(segs);
		}
		paragraph = [];
	};

	for (let index = 0; index < source.length; index += 1) {
		const raw = source[index] ?? '';
		const line = raw.trimEnd();

		if (/^\s*```/.test(line)) {
			flush();
			const code: string[] = [];
			index += 1;
			while (index < source.length && !/^\s*```/.test(source[index] ?? '')) {
				code.push((source[index] ?? '').replaceAll('\t', '    ').trimEnd());
				index += 1;
			}
			const inner = Math.min(
				Math.max(0, ...code.map((c) => width(c))),
				Math.max(1, columns - 4),
			);
			for (const c of code) {
				push([
					{ t: '  ' },
					{ t: ` ${fit(c, inner)} `, fg: 'fg', bg: 'surface' },
				]);
			}
			continue;
		}

		if (line.trim() === '') {
			flush();
			space();
			continue;
		}

		const heading = line.match(/^#{1,6}\s+(.*)$/);
		if (heading) {
			flush();
			space();
			for (const segs of wrap(
				[{ t: heading[1] ?? '', fg: 'fg', b: true }],
				columns,
			)) {
				push(segs);
			}
			continue;
		}

		const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
		if (item) {
			flush();
			const depth = Math.min(3, Math.floor((item[1]?.length ?? 0) / 2));
			const marker = /\d/.test(item[2] ?? '') ? `${item[2]} ` : '• ';
			const indent = 2 * depth;
			const hang = indent + width(marker);
			wrap(inline(item[3] ?? '', { fg: 'fg' }), columns - hang).forEach(
				(segs, n) => {
					push([
						{ t: ' '.repeat(indent) },
						n === 0
							? { t: marker, fg: 'faint' }
							: { t: ' '.repeat(width(marker)) },
						...segs,
					]);
				},
			);
			continue;
		}

		const quote = line.match(/^>\s?(.*)$/);
		if (quote) {
			flush();
			for (const segs of wrap(
				inline(quote[1] ?? '', { fg: 'dim', i: true }),
				columns - 2,
			)) {
				push([{ t: '│ ', fg: 'ghost' }, ...segs]);
			}
			continue;
		}

		const next = source[index + 1] ?? '';
		if (line.trimStart().startsWith('|') && /^\s*\|?\s*:?-{2,}/.test(next)) {
			flush();
			const rows: string[][] = [cells(line)];
			index += 2;
			while (
				index < source.length &&
				(source[index] ?? '').trimStart().startsWith('|')
			) {
				rows.push(cells(source[index] ?? ''));
				index += 1;
			}
			index -= 1;
			lines.push(...table(rows, columns));
			continue;
		}

		paragraph.push(line.trim());
	}
	flush();
	while (lines.at(-1)?.segs.length === 0) lines.pop();
	return lines;
}

function cells(row: string): string[] {
	return row
		.trim()
		.replace(/^\|/, '')
		.replace(/\|$/, '')
		.split('|')
		.map((cell) => cell.trim());
}

/** No border; a `ghost` rule under the header row. */
function table(rows: string[][], columns: number): Line[] {
	const count = Math.max(...rows.map((r) => r.length));
	const widths = Array.from({ length: count }, (_, c) =>
		Math.max(...rows.map((r) => width(r[c] ?? ''))),
	);
	const total = widths.reduce((n, w) => n + w, 0) + 2 * (count - 1);
	const lines: Line[] = rows.map((r) => ({
		segs: truncate(
			widths.flatMap((w, c) => {
				const cell = inline(fit(r[c] ?? '', w), { fg: 'fg' });
				if (c > 0) cell.unshift({ t: '  ' });
				return cell;
			}),
			columns,
		),
	}));
	lines.splice(1, 0, {
		segs: [{ t: '─'.repeat(Math.min(total, columns)), fg: 'ghost' }],
	});
	return lines;
}
