// End to end: on a terminal without 24-bit colour (Terminal.app before
// macOS 26), the UI draws with the xterm 256 palette only. The selected NEEDS
// YOU row and the input band while typing use the theme's 256-colour roles,
// and every word on screen reads at 4.5:1 or better, in both themes. Run with
// `bun run e2e`; it exits non-zero if a check fails.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedLine } from '../src/protocol.ts';
import {
	type Rgb,
	type Role,
	THEMES,
	type ThemeName,
	colorDepth,
	nearest256,
	xterm256,
} from '../src/tui/theme.ts';
import { startFakeParticle } from './fake-particle.ts';
import { startAgent } from './harness.ts';
import { type Tui, openTui } from './tui.ts';

type TaskLine = Extract<FeedLine, { type: 'task' }>;

const TITLE = 'Settle the flaky login retries';
const QUESTION = 'Retry the login step 2 or 3 times?';
const TYPED = 'three attempts';
const COLUMNS = 100;
const ROWS = 30;
// Words, not lines: `ghost` is never used for text (tui-design.md §5).
const WORD_ROLES: Role[] = [
	'fg',
	'dim',
	'faint',
	'accent',
	'ok',
	'warn',
	'err',
];

const particle = startFakeParticle((request) => {
	if (request.session === 'compaction') return { content: 'Summary.' };
	if (request.session === 'worker') {
		return request.called.includes('ask')
			? { calls: [{ name: 'wait_for', args: { what: 'an answer' } }] }
			: { calls: [{ name: 'ask', args: { question: QUESTION } }] };
	}
	if (request.fresh.includes('(ASK)')) {
		return {
			calls: [
				{
					name: 'start_task',
					args: {
						title: TITLE,
						instructions: 'Ask whether to retry 2 or 3 times.',
						threads: [],
						repo: 'none',
					},
				},
			],
		};
	}
	return { content: 'Nothing to do.' };
});

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (!ok) failures += 1;
	process.stdout.write(
		`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}\n`,
	);
}

function luminance(rgb: Rgb): number {
	const [r, g, b] = rgb.map((value) => {
		const s = value / 255;
		return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
	});
	return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
}

function contrast(a: Rgb, b: Rgb): number {
	const [hi, lo] = [luminance(a), luminance(b)].toSorted((x, y) => y - x);
	return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

type ScreenCell = {
	ch: string;
	fg: number | null;
	bg: number | null;
	bold: boolean;
	italic: boolean;
};

type Screen = {
	cells: ScreenCell[][];
	/** SGR parameters that aren't a reset, bold, italic, underline or a 256-colour index. */
	foreign: Set<string>;
};

function empty(): ScreenCell {
	return { ch: ' ', fg: null, bg: null, bold: false, italic: false };
}

/** Replays the output on a grid, as a terminal that only reads `38;5;n` would. */
function replay(raw: string): Screen {
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
					if (code === '0') pen = empty();
					else if (code === '1') pen = { ...pen, bold: true };
					else if (code === '3') pen = { ...pen, italic: true };
					else if (code === '4') continue;
					else if ((code === '38' || code === '48') && codes[k + 1] === '5') {
						const index = Number(codes[k + 2]);
						if (!(index >= 16 && index <= 255))
							foreign.add(`${code};5;${index}`);
						pen = code === '38' ? { ...pen, fg: index } : { ...pen, bg: index };
						k += 2;
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

function text(line: ScreenCell[]): string {
	return line.map((cell) => cell.ch).join('');
}

/** The cells of `word` in the first row that has it. */
function find(
	screen: Screen,
	word: string,
): { row: ScreenCell[]; cells: ScreenCell[] } | null {
	for (const row of screen.cells) {
		const at = text(row).indexOf(word);
		if (at !== -1) return { row, cells: row.slice(at, at + word.length) };
	}
	return null;
}

const agent = await startAgent(particle.url);
const outside = mkdtempSync(join(tmpdir(), 'sa-colors-'));
const settle = () => Bun.sleep(900);

// Terminal.app on macOS 15 (build 455): no COLORTERM, xterm-256color.
const appleTerminal = (theme: ThemeName, version = '455.1') => ({
	TERM: 'xterm-256color',
	TERM_PROGRAM: 'Apple_Terminal',
	TERM_PROGRAM_VERSION: version,
	COLORTERM: undefined,
	// Nothing answers OSC 11 in the test's pseudo-terminal, so this picks the theme.
	COLORFGBG: theme === 'light' ? '0;15' : '15;0',
});

async function themeChecks(name: ThemeName, handle: string): Promise<void> {
	const theme = THEMES['256'][name];
	const index = (role: Role) => nearest256(theme[role]);
	const tui: Tui = await openTui(agent.home, outside, {
		env: appleTerminal(name),
	});
	try {
		await tui.waitFor('answer');
		await settle();
		const home = replay(tui.raw());

		check(
			`${name}: only 256-colour SGR, no 24-bit or basic colours`,
			home.foreign.size === 0 && !tui.raw().includes(';2;'),
			[...home.foreign].join(' '),
		);

		const title = find(home, TITLE);
		const handleCells = find(home, handle);
		const glyph = handleCells?.row[0];
		const enter = find(home, 'enter');
		const answer = find(home, 'answer');
		const question = find(home, QUESTION);
		const row = title?.row ?? [];
		check(
			`${name}: the selected NEEDS YOU row is a surface band (${index('surface')}) across the whole width`,
			row.length === COLUMNS &&
				row.every((cell) => cell.bg === index('surface')) &&
				(question?.row ?? []).every((cell) => cell.bg === index('surface')),
			text(row).trimEnd(),
		);
		check(
			`${name}: its title is bold fg (${index('fg')}), its handle accent (${index('accent')}), its ? bold warn (${index('warn')})`,
			(title?.cells ?? []).every(
				(cell) => cell.fg === index('fg') && cell.bold,
			) &&
				(handleCells?.cells ?? []).every(
					(cell) => cell.fg === index('accent'),
				) &&
				glyph?.ch === '?' &&
				glyph.fg === index('warn') &&
				glyph.bold,
		);
		check(
			`${name}: its keys are bold dim (${index('dim')}), words faint (${index('faint')}), the question italic fg`,
			(enter?.cells ?? []).every(
				(cell) => cell.fg === index('dim') && cell.bold,
			) &&
				(answer?.cells ?? []).every((cell) => cell.fg === index('faint')) &&
				(question?.cells ?? []).every(
					(cell) => cell.fg === index('fg') && cell.italic,
				),
		);

		const mark = tui.mark();
		await tui.type(`/${TYPED}`);
		await tui.waitFor(TYPED, mark);
		await settle();
		const typing = replay(tui.raw());
		const typed = find(typing, TYPED);
		const band = typed?.row ?? [];
		const prompt = band[0];
		const arrow = band.find((cell) => cell.ch === '→');
		const preview = find(typing, 'the Router decides');
		check(
			`${name}: while typing, the input row is a surface band with fg text, accent › and →, faint preview`,
			band.length === COLUMNS &&
				band.every((cell) => cell.bg === index('surface')) &&
				(typed?.cells ?? []).every((cell) => cell.fg === index('fg')) &&
				prompt?.ch === '›' &&
				prompt.fg === index('accent') &&
				arrow?.fg === index('accent') &&
				(preview?.cells ?? []).every((cell) => cell.fg === index('faint')),
			text(band).trimEnd(),
		);

		// Every word on both screens: its colours as the 256 palette shows them.
		const pairs = new Map<string, number>();
		for (const screen of [home, typing]) {
			for (const line of screen.cells) {
				for (const cell of line) {
					if (cell.ch === ' ' || cell.fg === index('ghost')) continue;
					if (cell.fg === null || cell.bg === null) continue;
					pairs.set(
						`${cell.fg} on ${cell.bg}`,
						contrast(xterm256(cell.fg), xterm256(cell.bg)),
					);
				}
			}
		}
		const sorted = [...pairs].toSorted((a, b) => a[1] - b[1]);
		check(
			`${name}: every word on screen is at least 4.5:1`,
			sorted.length > 0 && (sorted[0]?.[1] ?? 0) >= 4.5,
			sorted.map(([pair, ratio]) => `${pair} ${ratio.toFixed(1)}`).join(', '),
		);
	} finally {
		await tui.quit();
	}
}

try {
	await agent.action({ type: 'send_console', text: 'please settle (ASK)' });
	const asking = await agent.waitFor(
		'the task to ask its question',
		(line): line is TaskLine =>
			line.type === 'task' &&
			line.task.title === TITLE &&
			line.task.status === 'needs_you',
	);
	const { handle } = asking.task;

	check(
		'Terminal.app before macOS 26 gets the 256 palette, even with COLORTERM=truecolor from a shell profile',
		colorDepth(appleTerminal('dark')) === '256' &&
			colorDepth({ ...appleTerminal('dark'), COLORTERM: 'truecolor' }) ===
				'256' &&
			colorDepth({ TERM_PROGRAM: 'Apple_Terminal' }) === '256',
	);
	check(
		'Terminal.app on macOS 26 (build 464 on), COLORTERM=truecolor and iTerm2 get 24-bit colour',
		colorDepth(appleTerminal('dark', '470')) === 'truecolor' &&
			colorDepth({ COLORTERM: 'truecolor', TERM: 'xterm-256color' }) ===
				'truecolor' &&
			colorDepth({ TERM_PROGRAM: 'iTerm.app' }) === 'truecolor',
	);
	check(
		'an unknown terminal without COLORTERM gets the 256 palette',
		colorDepth({ TERM: 'xterm-256color' }) === '256' &&
			colorDepth({}) === '256',
	);

	for (const depth of ['truecolor', '256'] as const) {
		for (const name of ['dark', 'light'] as const) {
			const theme = THEMES[depth][name];
			const low: string[] = [];
			const need = (role: Role, on: Role) => {
				const ratio = contrast(theme[role], theme[on]);
				if (ratio < 4.5) low.push(`${role} on ${on} ${ratio.toFixed(2)}`);
			};
			for (const role of WORD_ROLES) {
				need(role, 'bg');
				need(role, 'surface');
			}
			need('ok', 'okSoft');
			need('err', 'errSoft');
			for (const tint of ['okSoft', 'errSoft', 'okWord', 'errWord'] as const) {
				need('fg', tint);
			}
			check(
				`${depth} ${name} palette: every word role is at least 4.5:1 on bg, surface and the diff tints`,
				low.length === 0,
				low.join(', '),
			);
		}
	}

	await themeChecks('dark', handle);
	await themeChecks('light', handle);

	const modern = await openTui(agent.home, outside, {
		env: appleTerminal('dark', '470'),
	});
	try {
		await modern.type('/x');
		await modern.waitFor('the Router decides');
		const [r, g, b] = THEMES.truecolor.dark.surface;
		check(
			'Terminal.app on macOS 26 keeps the exact truecolor surface',
			modern.raw().includes(`48;2;${r};${g};${b}m`) &&
				!modern.raw().includes('48;5;'),
		);
	} finally {
		await modern.quit();
	}
} finally {
	await agent.stop();
	particle.stop();
}

if (failures > 0) {
	process.stdout.write(`\n${failures} check(s) failed.\n`);
	process.exit(1);
}
process.stdout.write('\nAll checks passed.\n');
