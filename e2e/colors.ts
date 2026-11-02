// End to end: on a terminal without 24-bit colour (Terminal.app before
// macOS 26), the UI draws with the xterm 256 palette only. The selected NEEDS
// YOU row and the input band while typing use the theme's 256-colour roles,
// and every word on screen reads at 4.5:1 or better, in both themes. Console
// messages are one colour on every line, wrapped ones too, at both depths;
// truecolor sent to that Terminal.app turned first lines faint. Run with
// `bun run e2e`; it exits non-zero if a check fails.
//
// The screen keeps the terminal's own background: only the selected item and
// the input band paint one, a subtle step from the background the terminal
// reports, and every word reads at 4.5:1 on whichever it sits on.
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
	themeFor,
	themeOf,
} from '../src/tui/theme.ts';
import { startFakeParticle } from './fake-particle.ts';
import { startAgent } from './harness.ts';
import {
	COLUMNS,
	type Screen,
	contrast,
	find,
	findIn,
	replay,
	replayOldTerminal,
	text,
} from './screen.ts';
import { type Tui, openTui } from './tui.ts';

type TaskLine = Extract<FeedLine, { type: 'task' }>;
type MessageLine = Extract<FeedLine, { type: 'message' }>;

const TITLE = 'Settle the flaky login retries';
const QUESTION = 'Retry the login step 2 or 3 times?';
const TYPED = 'three attempts';
const SHORT_REPLY = 'Started a task for the retries.';
// Wraps: the console's text column is 92 wide at 100 columns.
const LONG_REPLY =
	'The login test fails about one run in twenty because the session cookie is read before the redirect lands, so it keeps going.';
const LONG_TAIL = 'so it keeps going.';
/** Reset, no link, paste and focus reports off, autowrap and cursor back, main screen. */
const RESTORE =
	'\x1b[0m\x1b]8;;\x1b\\\x1b[?2004l\x1b[?1004l\x1b[?7h\x1b[?25h\x1b[?1049l';
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
	const replies = [...request.fresh.matchAll(/\(C(\d)\)/g)].map(([, id]) => ({
		name: 'reply',
		args: { thread: 'console', text: id === '1' ? SHORT_REPLY : LONG_REPLY },
	}));
	if (replies.length > 0) return { calls: replies };
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

function same(a: Rgb | null, b: Rgb): boolean {
	return a !== null && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function hexRgb(hex: string): Rgb {
	const value = Number.parseInt(hex.slice(1), 16);
	return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

/** The text of every row with any cell on a painted background. */
function paintedRows(screen: Screen): string[] {
	return screen.cells
		.filter((row) => row.some((cell) => cell.bgRgb !== null))
		.map(text);
}

/**
 * Each word colour on each background shown, lowest contrast first; a cell
 * on the terminal's own background is measured against `background`.
 */
function wordContrasts(
	screens: Screen[],
	background: Rgb,
	ghost: Rgb,
): Array<[string, number]> {
	const pairs = new Map<string, number>();
	for (const screen of screens) {
		for (const line of screen.cells) {
			for (const cell of line) {
				if (cell.ch === ' ' || cell.fgRgb === null) continue;
				if (same(cell.fgRgb, ghost)) continue;
				const under = cell.bgRgb ?? background;
				pairs.set(
					`${cell.fg ?? cell.fgRgb.join(',')} on ${cell.bgRgb ? (cell.bg ?? under.join(',')) : 'default'}`,
					contrast(cell.fgRgb, under),
				);
			}
		}
	}
	return [...pairs].toSorted((a, b) => a[1] - b[1]);
}

/**
 * The terminal reports its background (OSC 11): the screen keeps it, the
 * selected row and the input band step subtly from it, every word reads at
 * 4.5:1 on it, and quitting leaves the terminal's colours alone.
 */
async function backgroundChecks(hex: string, version: string): Promise<void> {
	const background = hexRgb(hex);
	const name = themeOf(background);
	const env = appleTerminal(name, version);
	const depth = colorDepth(env);
	const theme = themeFor(name, depth, background);
	const label = `${depth} on ${hex}`;
	const tui = await openTui(agent.home, outside, env, { background: hex });
	try {
		await tui.waitFor('answer');
		await settle();
		const home = replay(tui.raw());
		const mark = tui.mark();
		await tui.type(`/${TYPED}`);
		await tui.waitFor(TYPED, mark);
		await settle();
		const typing = replay(tui.raw());
		await tui.type('\x1b');
		const surfaces = [home, typing].flatMap((screen) =>
			screen.cells.flatMap((row) => row.filter((cell) => cell.bgRgb !== null)),
		);
		const step = contrast(theme.surface, background);
		check(
			`${label}: ordinary cells keep the terminal's background; the selected row and band are a subtle surface (${step.toFixed(2)}:1)`,
			paintedRows(home).length === 2 &&
				paintedRows(typing).length === 3 &&
				surfaces.every((cell) => same(cell.bgRgb, theme.surface)) &&
				step >= 1.05 &&
				step <= 1.35,
			paintedRows(typing)
				.map((line) => line.trimEnd())
				.join(' / '),
		);
		const sorted = wordContrasts([home, typing], background, theme.ghost);
		check(
			`${label}: every word is at least 4.5:1 on the terminal's background and on the surface`,
			sorted.length > 0 && (sorted[0]?.[1] ?? 0) >= 4.5,
			sorted
				.slice(0, 4)
				.map(([pair, ratio]) => `${pair} ${ratio.toFixed(1)}`)
				.join(', '),
		);
	} finally {
		await tui.quit();
	}
	const raw = tui.raw();
	const left = raw.lastIndexOf(RESTORE);
	check(
		`${label}: quitting leaves the terminal as it was: colours reset, main screen back, its own colours never set`,
		left !== -1 &&
			!raw.slice(left + RESTORE.length).includes('\x1b') &&
			// oxlint-disable-next-line no-control-regex
			!/\x1b\](?:4|10|11|104|110|111);(?!\?)/.test(raw),
	);
}

/**
 * Every console message's text, first and wrapped lines alike, is plain `fg`;
 * only the author column is styled (`you` accent, others `dim`). At 256
 * colours, Terminal.app before macOS 26 shows it the same, never faint.
 */
async function consoleChecks(name: ThemeName, version: string): Promise<void> {
	const env = appleTerminal(name, version);
	const depth = colorDepth(env);
	const theme = THEMES[depth][name];
	const tui = await openTui(agent.home, outside, env);
	try {
		await tui.waitFor(LONG_TAIL);
		await settle();
		const raw = tui.raw();
		const screen = replay(raw);
		const words = [
			'one more (C1)',
			SHORT_REPLY,
			LONG_REPLY.slice(0, 30),
			LONG_TAIL,
		];
		const textCells = words.map((word) => findIn(screen.cells, word));
		const tailRow = find(screen, LONG_TAIL)?.row ?? [];
		check(
			`${depth} ${name}: console text is plain fg on every line, wrapped lines too`,
			textCells.every(
				(cells, index) =>
					cells.length === words[index]?.length &&
					cells.every(
						(cell) => same(cell.fgRgb, theme.fg) && !cell.bold && !cell.italic,
					),
			) && text(tailRow).startsWith(' '.repeat(7)),
			textCells
				.map((cells) =>
					[...new Set(cells.map((cell) => cell.fgRgb?.join(',')))].join('/'),
				)
				.join(' · '),
		);
		const labels = screen.cells
			.filter((row) => text(row).startsWith('agent  '))
			.map((row) => row.slice(0, 5));
		check(
			`${depth} ${name}: only the author column differs: agent in dim`,
			labels.length === 2 &&
				labels.every((cells) =>
					cells.every((cell) => same(cell.fgRgb, theme.dim)),
				),
		);
		if (depth === '256') {
			const old = replayOldTerminal(raw);
			const fg = String(nearest256(theme.fg));
			const oldCells = words.map((word) => findIn(old, word));
			check(
				`${depth} ${name}: as Terminal.app before macOS 26 reads it, no console line is faint`,
				oldCells.every(
					(cells, index) =>
						cells.length === words[index]?.length &&
						cells.every((cell) => !cell.faint && cell.fg === fg),
				),
			);
		}
	} finally {
		await tui.quit();
	}
}

async function themeChecks(name: ThemeName, handle: string): Promise<void> {
	const theme = THEMES['256'][name];
	const index = (role: Role) => nearest256(theme[role]);
	const tui: Tui = await openTui(agent.home, outside, appleTerminal(name));
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
			`${name}: the hint's keys are bold dim (${index('dim')}), words faint (${index('faint')}), the question italic fg`,
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
		await tui.type('\x1b');
		const typed = find(typing, TYPED);
		const band = typed?.row ?? [];
		const prompt = band[0];
		const arrow = band.find((cell) => cell.ch === '→');
		const preview = find(typing, 'the Router');
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

		check(
			`${name}: only the selected item and the input band paint a background; the rest is the terminal's`,
			paintedRows(home).join('|') ===
				[text(row), text(question?.row ?? [])].join('|') &&
				paintedRows(typing).join('|') ===
					[text(row), text(question?.row ?? []), text(band)].join('|'),
			paintedRows(typing)
				.map((line) => line.trimEnd())
				.join(' / '),
		);

		// The terminal's background is the design's here: nothing answers OSC 11.
		const sorted = wordContrasts([home, typing], theme.bg, theme.ghost);
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

	for (const id of [1, 2]) {
		const from = agent.lines.length;
		// oxlint-disable-next-line eslint/no-await-in-loop
		await agent.action({ type: 'send_console', text: `one more (C${id})` });
		// oxlint-disable-next-line eslint/no-await-in-loop
		await agent.waitFor(
			`the Router's reply to (C${id})`,
			(line): line is MessageLine =>
				agent.lines.indexOf(line) >= from &&
				line.type === 'message' &&
				line.message.threadId === 'console' &&
				line.message.author !== 'you',
		);
	}
	for (const version of ['455.1', '470']) {
		for (const name of ['dark', 'light'] as const) {
			// oxlint-disable-next-line eslint/no-await-in-loop
			await consoleChecks(name, version);
		}
	}

	// Terminal.app's Pro and Basic profiles, Dracula and Solarized light.
	for (const [hex, version] of [
		['#000000', '455.1'],
		['#FFFFFF', '455.1'],
		['#282A36', '455.1'],
		['#282A36', '470'],
		['#FDF6E3', '455.1'],
		['#FDF6E3', '470'],
	] as const) {
		// oxlint-disable-next-line eslint/no-await-in-loop
		await backgroundChecks(hex, version);
	}

	const modern = await openTui(
		agent.home,
		outside,
		appleTerminal('dark', '470'),
	);
	try {
		await modern.type('/x');
		await modern.waitFor('→ the Router');
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
