import { homedir } from 'node:os';
import { type Line, type Seg, width, wrap } from '../cells.ts';
import type { Model } from '../model.ts';
import { hint, rule, sep, spinner } from '../parts.ts';
import type { KeyScreen } from '../state.ts';
import { wordmarks } from '../wordmark.ts';

/** The text column is at least this wide, and as wide as the wordmark. */
const COLUMN = 60;
const MASK = '•';
/** Rows between the wordmark and the text. */
const GAP = 2;
const OUTCOME_LINES = 3;

type Text = {
	title: Seg[][];
	/** What happens to the key. */
	about: Seg[][];
	/** A blank row above the input. */
	blank: boolean;
	input: Seg[];
	/** Always at least one row, so a result doesn't move the layout. */
	outcome: Seg[][];
};

function textHeight(text: Text): number {
	return (
		text.title.length +
		text.about.length +
		(text.blank ? 1 : 0) +
		1 +
		text.outcome.length
	);
}

const TITLE: Record<KeyScreen['reason'], string> = {
	missing: 'Paste your Particle API key to get started',
	rejected: 'Particle rejected the saved key; paste a new one to carry on',
	replace: 'Paste a new Particle API key',
};

/**
 * The welcome screen where a Particle API key is pasted: the wordmark, what
 * happens to the key, the masked input and the outcome of the last try,
 * centred, with the hint line at the bottom. Exactly `rows` lines.
 */
export function keyLines(
	model: Model,
	screen: KeyScreen,
	content: number,
	rows: number,
	now: number,
): { lines: Line[]; animating: boolean } {
	const footer: Line[] = [rule(content), { segs: hintSegs(screen, content) }];
	const room = rows - footer.length;

	const textFor = (column: number): Text => {
		const prose = (segs: Seg[]): Seg[][] => wrap(segs, column);
		const about = prose([
			{
				t: `superagent checks it with Particle, which costs nothing, then saves it to ${home(screen.keyFile)}, readable only by you.`,
				fg: 'faint',
			},
		]);
		if (model.live?.health.model.key === 'env') {
			about.push(
				...prose([
					{
						t: 'PARTICLE_API_KEY is set where the agent runs and overrides this file while it is.',
						fg: 'faint',
					},
				]),
			);
		}
		return {
			title: prose([{ t: TITLE[screen.reason], fg: 'fg', b: true }]),
			about,
			blank: true,
			input: inputSegs(screen, column, now),
			outcome: wrap(outcomeSegs(screen, now), column, OUTCOME_LINES),
		};
	};

	// The largest wordmark that fits with all the text; the text column lines
	// up under it when it's the wider one.
	let name: Seg[][] = [];
	let gap = GAP;
	let column = Math.min(content, COLUMN);
	let text: Text | null = null;
	for (const art of wordmarks(content)) {
		const wide = Math.min(content, Math.max(COLUMN, width(art[0] ?? [])));
		const full = textFor(wide);
		if (art.length + GAP + textHeight(full) <= room) {
			name = art;
			column = wide;
			text = full;
			break;
		}
	}
	if (text === null) {
		// Too short for a wordmark: the input and the outcome always stay, then
		// the title, the blank above the input, what happens to the key, and
		// the name, as far as they fit.
		const full = textFor(column);
		let spare = room - 1 - full.outcome.length;
		const keep = (lines: Seg[][]): Seg[][] => {
			if (lines.length > spare) return [];
			spare -= lines.length;
			return lines;
		};
		const title = keep(full.title);
		const blank = keep([[]]).length > 0;
		const about = keep(full.about);
		gap = Math.min(GAP, spare - 1);
		if (gap >= 1) name = [[{ t: 'superagent', fg: 'fg', b: true }]];
		text = { ...full, title, blank, about };
	}

	const left = Math.floor((content - column) / 2);
	const artLeft = left + Math.floor((column - width(name[0] ?? [])) / 2);
	const textLines: Seg[][] = [
		...text.title,
		...text.about,
		...(text.blank ? [[]] : []),
		text.input,
		...text.outcome,
	];
	const block: Line[] = [
		...name.map((segs) => indent(segs, artLeft)),
		...(name.length > 0
			? Array.from({ length: gap }, () => ({ segs: [] }))
			: []),
		...textLines.map((segs) => indent(segs, left)),
	];
	// A little above the middle reads as centred.
	const top = Math.max(0, Math.floor((room - block.length) * 0.4));
	const lines: Line[] = [
		...Array.from({ length: top }, () => ({ segs: [] })),
		...block,
	].slice(0, room);
	while (lines.length < room) lines.push({ segs: [] });
	lines.push(...footer);
	return { lines, animating: screen.checking !== null };
}

function indent(segs: Seg[], columns: number): Line {
	return { segs: columns > 0 ? [{ t: ' '.repeat(columns) }, ...segs] : segs };
}

function home(path: string): string {
	const dir = homedir();
	return dir && path.startsWith(`${dir}/`)
		? `~${path.slice(dir.length)}`
		: path;
}

/** The key as `•`s on a `surface` band across the column; never the key. */
function inputSegs(screen: KeyScreen, column: number, now: number): Seg[] {
	const count = Array.from(screen.text).length;
	const room = Math.max(1, column - 4);
	const mask = count <= room ? MASK.repeat(count) : `…${MASK.repeat(room - 1)}`;
	const cursor: Seg = {
		t: screen.checking === null && Math.floor(now / 500) % 2 === 0 ? '▏' : ' ',
		fg: 'accent',
		bg: 'surface',
	};
	const segs: Seg[] = [{ t: '› ', fg: 'accent', bg: 'surface' }];
	if (count === 0) {
		segs.push(cursor, {
			t: 'paste your key here · it stays hidden',
			fg: 'faint',
			i: true,
			bg: 'surface',
		});
	} else segs.push({ t: mask, fg: 'dim', bg: 'surface' }, cursor);
	const used = width(segs);
	if (used < column) {
		segs.push({ t: ' '.repeat(column - used), bg: 'surface' });
	}
	return segs;
}

function outcomeSegs(screen: KeyScreen, now: number): Seg[] {
	if (screen.checking !== null) {
		return [
			{ t: `${spinner(now)} `, fg: 'accent' },
			{ t: 'checking with Particle…', fg: 'faint' },
		];
	}
	const { error } = screen;
	if (error === null) return [];
	return [
		{ t: '✗ ', fg: 'err' },
		{ t: error.subject, fg: 'fg' },
		...(error.detail
			? [sep, { t: error.detail, fg: 'faint' } satisfies Seg]
			: []),
	];
}

/** Drops `ctrl-u`, then `ctrl-c`, until the hint fits. */
function hintSegs(screen: KeyScreen, content: number): Seg[] {
	const esc: [string, string] = [
		'esc',
		screen.back.name === 'home' && screen.reason !== 'replace'
			? 'skip for now'
			: 'back',
	];
	let pairs: Array<[string, string]> =
		screen.checking !== null
			? [esc, ['ctrl-c', 'quit']]
			: [
					['enter', 'check and save'],
					['ctrl-u', 'clear'],
					esc,
					['ctrl-c', 'quit'],
				];
	for (const drop of ['ctrl-u', 'ctrl-c']) {
		if (width(hint(pairs)) <= content) break;
		pairs = pairs.filter(([key]) => key !== drop);
	}
	return hint(pairs);
}
