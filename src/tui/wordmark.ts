import { type Seg, width } from './cells.ts';

// Block letters for the welcome screen, in the ANSI Shadow style: `█` strokes
// with a box-drawing shadow. 85 columns by 6 rows.
const SHADOW: Record<string, string[]> = {
	S: ['███████╗', '██╔════╝', '███████╗', '╚════██║', '███████║', '╚══════╝'],
	U: [
		'██╗   ██╗',
		'██║   ██║',
		'██║   ██║',
		'██║   ██║',
		'╚██████╔╝',
		' ╚═════╝ ',
	],
	P: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔═══╝ ', '██║     ', '╚═╝     '],
	E: ['███████╗', '██╔════╝', '█████╗  ', '██╔══╝  ', '███████╗', '╚══════╝'],
	R: ['██████╗ ', '██╔══██╗', '██████╔╝', '██╔══██╗', '██║  ██║', '╚═╝  ╚═╝'],
	A: [' █████╗ ', '██╔══██╗', '███████║', '██╔══██║', '██║  ██║', '╚═╝  ╚═╝'],
	G: [
		' ██████╗ ',
		'██╔════╝ ',
		'██║  ███╗',
		'██║   ██║',
		'╚██████╔╝',
		' ╚═════╝ ',
	],
	N: [
		'███╗   ██╗',
		'████╗  ██║',
		'██╔██╗ ██║',
		'██║╚██╗██║',
		'██║ ╚████║',
		'╚═╝  ╚═══╝',
	],
	T: [
		'████████╗',
		'╚══██╔══╝',
		'   ██║   ',
		'   ██║   ',
		'   ██║   ',
		'   ╚═╝   ',
	],
};

// The same letters as 5-high pixels, for the smaller sizes.
const PIXELS: Record<string, string[]> = {
	S: ['###', '#..', '###', '..#', '###'],
	U: ['#.#', '#.#', '#.#', '#.#', '###'],
	P: ['###', '#.#', '###', '#..', '#..'],
	E: ['###', '#..', '##.', '#..', '###'],
	R: ['##.', '#.#', '##.', '#.#', '#.#'],
	A: ['###', '#.#', '###', '#.#', '#.#'],
	G: ['####', '#...', '#.##', '#..#', '####'],
	N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
	T: ['###', '.#.', '.#.', '.#.', '.#.'],
};

const WORD = 'SUPERAGENT';

/** Rows of text, each the same width. */
type Art = string[];

function letters(): string[] {
	return Array.from(WORD);
}

/** 85 × 6: `█` with its shadow. */
function shadow(): Art {
	return Array.from({ length: 6 }, (_, row) =>
		letters()
			.map((letter) => SHADOW[letter]?.[row] ?? '')
			.join(''),
	);
}

/** 73 × 5: each pixel two `█` wide, a column between letters. */
function blocks(): Art {
	return Array.from({ length: 5 }, (_, row) =>
		letters()
			.map((letter) =>
				Array.from(PIXELS[letter]?.[row] ?? '', (px) =>
					px === '#' ? '██' : '  ',
				).join(''),
			)
			.join(' '),
	);
}

/** 41 × 3: two pixel rows per text row, in half blocks. */
function halves(): Art {
	return Array.from({ length: 3 }, (_, row) =>
		letters()
			.map((letter) => {
				const pixels = PIXELS[letter] ?? [];
				const top = pixels[row * 2] ?? '';
				const bottom = pixels[row * 2 + 1] ?? '';
				return Array.from(top, (px, x) => {
					const up = px === '#';
					const down = bottom[x] === '#';
					return up && down ? '█' : up ? '▀' : down ? '▄' : ' ';
				}).join('');
			})
			.join(' '),
	);
}

const SIZES: Art[] = [shadow(), blocks(), halves()];

/**
 * Every wordmark size that fits `columns`, largest first: strokes in
 * `accent`, the shadow in `ghost`.
 */
export function wordmarks(columns: number): Seg[][][] {
	return SIZES.filter((size) => width(size[0] ?? '') <= columns).map(paint);
}

function paint(art: Art): Seg[][] {
	return art.map((line) => {
		const segs: Seg[] = [];
		for (const ch of line) {
			const fg =
				ch === ' '
					? undefined
					: ch === '█' || ch === '▀' || ch === '▄'
						? 'accent'
						: 'ghost';
			const last = segs.at(-1);
			if (last && last.fg === fg) last.t += ch;
			else segs.push(fg === undefined ? { t: ch } : { t: ch, fg });
		}
		return segs;
	});
}
