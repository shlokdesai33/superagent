// End to end: on a terminal without 24-bit colour (Terminal.app before
// macOS 26), the UI draws with the xterm 256 palette only. The selected NEEDS
// YOU row and the input band while typing use the theme's 256-colour roles,
// and every word on screen reads at 4.5:1 or better, in both themes. Console
// messages are one colour on every line, wrapped ones too, at both depths;
// truecolor sent to that Terminal.app turned first lines faint. Run with
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
import {
	COLUMNS,
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

/**
 * Every console message's text, first and wrapped lines alike, is plain `fg`;
 * only the author column is styled (`you` accent, others `dim`). At 256
 * colours, Terminal.app before macOS 26 shows it the same, never faint.
 */
async function consoleChecks(name: ThemeName, version: string): Promise<void> {
	const env = appleTerminal(name, version);
	const depth = colorDepth(env);
	const theme = THEMES[depth][name];
	const tui = await openTui(agent.home, outside, { env });
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
