// End to end: the input box is always focused. Letters type straight into it
// and enter sends, without pressing `/` first. With nothing typed, ↑ ↓ move
// the selection and enter opens it; actions are on ctrl chords, so no letter
// quits or stops anything; ctrl-c quits at once with an empty draft and asks
// first with one. Run with `bun run e2e`; it exits non-zero if a check fails.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedLine, TaskSummary } from '../src/protocol.ts';
import { THEMES } from '../src/tui/theme.ts';
import { startFakeParticle } from './fake-particle.ts';
import { startAgent } from './harness.ts';
import { type Screen, type ScreenCell, replay, text } from './screen.ts';
import { type Tui, openTui } from './tui.ts';

type TaskLine = Extract<FeedLine, { type: 'task' }>;
type MessageLine = Extract<FeedLine, { type: 'message' }>;

const ALPHA = 'Alpha waits on CI';
const BETA = 'Beta asks a question';
const QUESTION = 'Retry the login step 2 or 3 times?';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const ESC = '\x1b';
const CTRL_C = '\x03';
const CTRL_X = '\x18';
const WAIT_MS = 10_000;

function startTask(title: string, instructions: string) {
	return {
		name: 'start_task',
		args: { title, instructions, threads: [], repo: 'none' },
	};
}

const particle = startFakeParticle((request) => {
	if (request.session === 'compaction') return { content: 'Summary.' };
	if (request.session === 'worker') {
		const asks =
			JSON.stringify(request.body).includes('(ASKS)') &&
			!request.called.includes('ask');
		return asks
			? { calls: [{ name: 'ask', args: { question: QUESTION } }] }
			: { calls: [{ name: 'wait_for', args: { what: 'CI' } }] };
	}
	if (request.fresh.includes('(HI)')) {
		return {
			calls: [
				{
					name: 'reply',
					args: { thread: 'console', text: 'Hello back (HI).' },
				},
			],
		};
	}
	if (request.fresh.includes('(TASKS)')) {
		return {
			calls: [
				startTask(ALPHA, 'Wait for CI.'),
				startTask(BETA, 'Ask the operator how often to retry (ASKS).'),
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
const outside = mkdtempSync(join(tmpdir(), 'sa-input-'));
// Truecolor dark, so the selection's band is the exact dark `surface`.
const env = { COLORTERM: 'truecolor', COLORFGBG: '15;0' };
const surface = THEMES.truecolor.dark.surface.join(',');
const accent = THEMES.truecolor.dark.accent.join(',');
const ghost = THEMES.truecolor.dark.ghost.join(',');

function rows(tui: Tui): string[] {
	return replay(tui.raw()).cells.map(text);
}

/** The home row painted as the selection: a `surface` band to the edge. */
function selected(screen: Screen): string | null {
	const input = screen.cells.length - 2;
	const row = screen.cells.find(
		(line, y) => y < input && line.at(-1)?.bgRgb?.join(',') === surface,
	);
	return row ? text(row).trimEnd() : null;
}

/** The input box's rows, top border first, above the hint line. */
function box(screen: Screen): ScreenCell[][] {
	const bottom = screen.cells.length - 2;
	let top = bottom;
	while (top > 0 && !text(screen.cells[top] ?? []).startsWith('╭')) top -= 1;
	return screen.cells.slice(top, bottom + 1);
}

/** The draft's rows inside the box, without the border or the cursor. */
function draftBand(screen: Screen): string[] {
	return box(screen)
		.slice(1, -1)
		.map((line) =>
			text(line)
				.replaceAll(/[▏\u00a0]/g, '')
				.replace(/^│ /, '')
				.replace(/\s*│\s*$/, ''),
		);
}

/** The box in `screen()`'s rows, which are sized to the terminal. */
function boxOf(lines: string[]): string[] {
	const top = lines.findLastIndex((line) => line.startsWith('╭'));
	const bottom = lines.findLastIndex((line) => line.startsWith('╰'));
	return top === -1 ? [] : lines.slice(top, bottom + 1);
}

/** The cursor, or its blink, is inside the box. */
function cursorShown(screen: Screen): boolean {
	return box(screen)
		.slice(1, -1)
		.some((line) => /[▏\u00a0]/.test(text(line)));
}

/** The box's corner colour, as `r,g,b`. */
function border(screen: Screen): string | undefined {
	return box(screen)[0]?.[0]?.fgRgb?.join(',');
}

/** Polls the replayed screen until `done` holds. */
async function until(
	tui: Tui,
	what: string,
	done: (screen: Screen) => boolean,
): Promise<Screen> {
	const deadline = Date.now() + WAIT_MS;
	for (;;) {
		const screen = replay(tui.raw());
		if (done(screen)) return screen;
		if (Date.now() > deadline) {
			throw new Error(
				`timed out waiting for ${what}:\n${screen.cells.map(text).join('\n')}`,
			);
		}
		// oxlint-disable-next-line eslint/no-await-in-loop
		await Bun.sleep(50);
	}
}

const showing = (screen: Screen, words: string) =>
	screen.cells.some((line) => text(line).includes(words));

const taskLine = (title: string, done: (task: TaskSummary) => boolean) =>
	agent.waitFor(
		`${title} to change`,
		(line): line is TaskLine =>
			line.type === 'task' && line.task.title === title && done(line.task),
	);

/** Whether the UI is still running after `ms`. */
async function running(tui: Tui, ms = 600): Promise<boolean> {
	return Promise.race([
		tui.exited.then(() => false),
		Bun.sleep(ms).then(() => true),
	]);
}

try {
	// 1. Letters type straight into the box; enter sends.
	let tui = await openTui(agent.home, outside, env);
	const idle = rows(tui);
	check(
		'the idle box says what typing does, and the hint names ctrl-c to quit, not q or /',
		idle.some((line) =>
			line.includes('› ▏ask, or @handle to message a task'),
		) &&
			idle.some((line) => line.includes('ctrl-c quit')) &&
			!idle.some((line) => line.includes('/ write') || line.includes('q quit')),
		idle.at(-1)?.trimEnd(),
	);
	await tui.type('hello there (HI)');
	await until(
		tui,
		'the draft and its destination',
		(screen) =>
			showing(screen, '› hello there (HI)') &&
			showing(screen, '→ the Router') &&
			showing(screen, 'enter send'),
	);
	check('typing without / fills the box and previews where it goes', true);
	await tui.type('\r');
	const sent = await agent.waitFor(
		'the console message',
		(line): line is MessageLine =>
			line.type === 'message' &&
			line.message.direction === 'in' &&
			line.message.text === 'hello there (HI)',
	);
	check('enter sends it to the Router', sent.message.author === 'you');
	await until(tui, 'the reply', (screen) =>
		showing(screen, 'Hello back (HI).'),
	);
	check('and the reply shows under CONSOLE', true);

	// 2. With nothing typed, ↑ ↓ move the selection and enter opens it.
	await agent.action({ type: 'send_console', text: 'two tasks (TASKS)' });
	const alpha = (await taskLine(ALPHA, (task) => task.status === 'waiting'))
		.task.handle;
	const beta = (await taskLine(BETA, (task) => task.status === 'needs_you'))
		.task.handle;
	await until(
		tui,
		'both tasks on home',
		(screen) => showing(screen, ALPHA) && showing(screen, QUESTION),
	);
	await tui.type(UP + UP);
	let screen = await until(
		tui,
		'the question selected',
		(now) => selected(now)?.includes(BETA) === true,
	);
	check(
		'↑ selects the question at the top, the box turns accent, and the hint offers ↑↓, answer and open',
		showing(screen, '↑↓ move') &&
			showing(screen, 'enter answer') &&
			showing(screen, 'ctrl-o open') &&
			border(screen) === accent,
		selected(screen) ?? 'nothing selected',
	);
	await tui.type(DOWN);
	screen = await until(
		tui,
		'the working task selected',
		(now) => selected(now)?.includes(ALPHA) === true,
	);
	check('↓ moves the selection to the next task', true);
	await tui.type('\r');
	screen = await until(tui, 'the task view', (now) =>
		showing(now, `superagent  ›  ${alpha}`),
	);
	check('enter on an empty draft opens the selected task', true);
	await tui.type(ESC);
	screen = await until(
		tui,
		'home again',
		(now) => showing(now, 'NEEDS YOU') && !showing(now, `›  ${alpha}`),
	);
	check('esc with nothing typed goes back home', true);

	// 3. With a draft, ↑ ↓ move in it, not the selection; esc clears it.
	await tui.type('abc');
	await tui.type(UP);
	await tui.type('X');
	screen = await until(tui, 'the edited draft', (now) =>
		showing(now, '│ › X▏abc'),
	);
	check(
		'with a draft, ↑ moves its cursor to the start, drawn inside the box',
		true,
	);
	check(
		'a draft turns the box accent',
		border(screen) === accent,
		border(screen),
	);
	await tui.type(DOWN);
	await tui.type('Y');
	await until(tui, 'the draft ended', (now) => showing(now, '› XabcY'));
	await tui.type(ESC);
	screen = await until(tui, 'the draft cleared', (now) =>
		showing(now, '› ▏ask, or @handle'),
	);
	check(
		'and the selection stayed put while typing; esc clears the draft',
		selected(screen)?.includes(ALPHA) === true,
		selected(screen) ?? 'nothing selected',
	);
	const idleBox = box(screen).map((line) => text(line).trimEnd());
	check(
		'with nothing typed and no question selected, the box is a subtle rounded border',
		border(screen) === ghost &&
			idleBox.length === 3 &&
			/^╭─+╮$/.test(idleBox[0] ?? '') &&
			/^│ › ▏ask, or @handle to message a task +│$/.test(idleBox[1] ?? '') &&
			/^╰─+╯$/.test(idleBox[2] ?? '') &&
			(idleBox[0]?.length ?? 0) === 99,
		idleBox.join(' / '),
	);

	// In a draft that wraps, ↑ goes to the row above, ↓ past the last row to its end.
	const words = Array.from({ length: 50 }, (_, index) => `w${index + 10}`);
	await tui.type(words.join(' '));
	await tui.type(UP);
	await tui.type('#');
	screen = await until(tui, 'the mark in the draft', (now) =>
		showing(now, '#'),
	);
	const band = draftBand(screen);
	const marked = band.findIndex((row) => row.includes('#'));
	check(
		'in a wrapped draft, ↑ moves the cursor to the row above',
		band.length >= 3 && marked === band.length - 2,
		band.join(' | '),
	);
	await tui.type(DOWN + DOWN);
	await tui.type('%');
	screen = await until(
		tui,
		'the end mark',
		(now) => draftBand(now).at(-1)?.includes(`w59%`) === true,
	);
	check('and ↓ on the last row goes to the end', true);
	await tui.type(ESC);

	// Taller than the box allows, with the cursor in the middle: notices for
	// the rows above and below, the cursor's row always shown, never more
	// rows than the box has (half the 30 rows, borders included).
	const many = Array.from({ length: 400 }, (_, index) => `x${index + 100}`);
	await tui.type(many.join(' '));
	await tui.type(UP.repeat(16));
	screen = await until(
		tui,
		'both notices',
		(now) =>
			showing(now, 'earlier lines') &&
			showing(now, 'more lines') &&
			cursorShown(now),
	);
	check(
		'a tall draft keeps the cursor row between "earlier" and "more" notices, within the box',
		box(screen).length <= 15,
		`${box(screen).length} rows`,
	);
	await tui.type(ESC);

	// 12 rows and an answer at 40 columns: one row for the draft, so the
	// notices give way and the cursor row stays.
	const small = await openTui(agent.home, outside, env, {
		columns: 40,
		rows: 12,
		until: 'ask',
	});
	await small.type(UP + UP + '\r');
	await until(small, 'the answer box', (now) => showing(now, 'answers'));
	await small.type(many.slice(0, 40).join(' '));
	await small.type(UP);
	const deadline = Date.now() + WAIT_MS;
	let squeezed: string[] = [];
	let rows12: string[] = [];
	do {
		// oxlint-disable-next-line eslint/no-await-in-loop
		await Bun.sleep(100);
		rows12 = small.screen();
		squeezed = boxOf(rows12).map((row) => row.trimEnd());
	} while (
		!squeezed.some((row) => /[▏\u00a0]/.test(row)) &&
		Date.now() < deadline
	);
	check(
		'squeezed to one row (the router line wraps), the box still shows the cursor in at most 3 rows',
		squeezed.length === 3 &&
			squeezed.some((row) => /[▏\u00a0]/.test(row)) &&
			rows12.length === 12 &&
			(rows12[0] ?? '').startsWith('superagent'),
		squeezed.join(' / '),
	);
	await small.quit();

	// 4. Enter on the question answers it; the answer goes to its task.
	await tui.type(UP);
	await until(tui, 'the question selected', (now) =>
		Boolean(selected(now)?.includes(BETA)),
	);
	await tui.type('\r');
	await until(
		tui,
		'the answer box',
		(now) =>
			showing(now, '› ▏type your answer') &&
			showing(now, `→ answers ${beta}'s question`),
	);
	check('enter on a question starts an answer to it', true);
	await tui.type('three attempts\r');
	await taskLine(BETA, (task) => task.status !== 'needs_you');
	check('enter sends the answer, and the task stops waiting on you', true);

	// 5. Letters never act: ? opens keys only with nothing typed.
	await tui.type('?');
	screen = await until(tui, 'the keys screen', (now) =>
		showing(now, 'superagent  ›  keys'),
	);
	check(
		'? with nothing typed opens the keys, which list the ctrl chords',
		showing(screen, 'ctrl-x ctrl-x') &&
			showing(screen, 'ctrl-t') &&
			!rows(tui).some((line) => /^j k|^q {2}/.test(line)),
	);
	await tui.type(ESC);
	await until(
		tui,
		'home again',
		(now) => showing(now, 'NEEDS YOU') || showing(now, 'WORKING'),
	);
	await tui.type('q');
	await until(tui, 'q in the draft', (now) => showing(now, '› q▏'));
	check('q types a q instead of quitting', await running(tui));
	await tui.type('?');
	await until(tui, '? in the draft', (now) => showing(now, '› q?'));
	check('? after other text types a ?', !showing(replay(tui.raw()), '›  keys'));

	// 6. Ctrl-c with a draft asks; any other key cancels; twice quits.
	await tui.type(CTRL_C);
	await until(tui, 'the quit question', (now) =>
		showing(now, 'ctrl-c again to quit and drop the draft'),
	);
	check('ctrl-c with a draft asks before quitting', await running(tui));
	await tui.type('!');
	await until(
		tui,
		'the question gone',
		(now) => showing(now, '› q?!') && !showing(now, 'again to quit'),
	);
	check('any other key cancels it, and still types', await running(tui));
	await tui.type(CTRL_C);
	await until(tui, 'the quit question', (now) => showing(now, 'again to quit'));
	await tui.type(CTRL_C);
	check('a second ctrl-c quits', !(await running(tui, 3_000)));

	// 7. Ctrl-x ctrl-x stops the selected task; ctrl-c on an empty draft quits.
	tui = await openTui(agent.home, outside, env);
	await until(tui, 'home', (now) => showing(now, ALPHA));
	for (let step = 0; step < 4; step += 1) {
		if (selected(replay(tui.raw()))?.includes(ALPHA)) break;
		// oxlint-disable-next-line eslint/no-await-in-loop
		await tui.type(DOWN);
	}
	await tui.type(CTRL_X);
	await until(tui, 'the stop question', (now) =>
		showing(now, `ctrl-x again to stop ${alpha}`),
	);
	check('ctrl-x asks before stopping the selected task', true);
	await tui.type(CTRL_X);
	await taskLine(ALPHA, (task) => task.status === 'stopped');
	check('a second ctrl-x stops it', true);
	await tui.type(CTRL_C);
	check(
		'ctrl-c with nothing typed quits at once',
		!(await running(tui, 3_000)),
	);
} catch (error) {
	failures += 1;
	process.stdout.write(
		`✗ ${error instanceof Error ? error.message : String(error)}\n`,
	);
} finally {
	await agent.stop();
	particle.stop();
	rmSync(outside, { recursive: true, force: true });
}

process.stdout.write(
	failures === 0 ? '\nAll checks passed.\n' : `\n${failures} failed.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
