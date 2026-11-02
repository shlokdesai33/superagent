// End to end: home keeps the console pinned above the input, newest at the
// bottom. With 30 tasks done today, DONE TODAY folds to its newest rows and a
// `+ N more` row, the latest console exchange shows in full right above the
// input at 80×24 and 120×40, and enter on `+ N more` shows every done task.
// Run with `bun run e2e`; it exits non-zero if a check fails.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedLine } from '../src/protocol.ts';
import { startFakeParticle } from './fake-particle.ts';
import { startAgent } from './harness.ts';
import { type Tui, openTui } from './tui.ts';

type TaskLine = Extract<FeedLine, { type: 'task' }>;
type MessageLine = Extract<FeedLine, { type: 'message' }>;

const DONE = 30;
const ASKED = 'How is it going? (HI)';
const REPLY =
	'Thirty reports are tidied, the login question is waiting on you, and the Safari fix is waiting on CI, which usually takes about ten minutes on this repository.';
const DOWN = '\x1b[B';
const ESC = '\x1b';

function startTask(title: string, instructions: string) {
	return {
		name: 'start_task',
		args: { title, instructions, threads: [], repo: 'none' },
	};
}

const particle = startFakeParticle((request) => {
	if (request.session === 'compaction') return { content: 'Summary.' };
	if (request.session === 'worker') {
		const body = JSON.stringify(request.body);
		if (body.includes('(ASKS)')) {
			return request.called.includes('ask')
				? { calls: [{ name: 'wait_for', args: { what: 'an answer' } }] }
				: {
						calls: [{ name: 'ask', args: { question: 'Retry 2 or 3 times?' } }],
					};
		}
		if (body.includes('(WAITS)')) {
			return { calls: [{ name: 'wait_for', args: { what: 'CI' } }] };
		}
		return { calls: [{ name: 'finish', args: { result: 'Tidied' } }] };
	}
	if (request.fresh.includes('(MANY)')) {
		return {
			calls: Array.from({ length: DONE }, (_, index) =>
				startTask(`Tidy report ${index + 1}`, 'Tidy it.'),
			),
		};
	}
	if (request.fresh.includes('(TWO)')) {
		return {
			calls: [
				startTask('Settle the flaky login retries', 'Ask (ASKS).'),
				startTask('Fix the Safari export crash', 'Wait (WAITS).'),
			],
		};
	}
	if (request.fresh.includes('(HI)')) {
		return {
			calls: [{ name: 'reply', args: { thread: 'console', text: REPLY } }],
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

const squash = (text: string) => text.replaceAll(/\s+/g, ' ').trim();
const settle = () => Bun.sleep(600);

const agent = await startAgent(particle.url);
const outside = mkdtempSync(join(tmpdir(), 'sa-home-'));
const env = { COLORTERM: 'truecolor', COLORFGBG: '15;0' };

/** The rows between the rule over the console and the Router line. */
function consoleRows(rows: string[]): { from: number; rows: string[] } | null {
	const router = rows.findIndex((row) => row.startsWith('◇ router'));
	if (router === -1) return null;
	let rule = router - 1;
	while (rule > 0 && !/^─+\s*$/.test(rows[rule] ?? '')) rule -= 1;
	return { from: rule + 1, rows: rows.slice(rule + 1, router) };
}

async function layoutChecks(columns: number, rows: number): Promise<void> {
	const size = `${columns}×${rows}`;
	const tui: Tui = await openTui(agent.home, outside, env, {
		columns,
		rows,
		until: 'ask',
	});
	try {
		await settle();
		let screen = tui.screen();
		const pinned = consoleRows(screen);
		const box = screen.findIndex((row) => row.startsWith('╭'));
		const asked =
			pinned?.rows.findIndex((row) =>
				row.startsWith('you    How is it going'),
			) ?? -1;
		const exchange = pinned && asked !== -1 ? pinned.rows.slice(asked) : [];
		check(
			`${size}: the latest exchange shows in full right above the input, after a rule`,
			pinned !== null &&
				exchange.length >= 2 &&
				squash(exchange.join(' ')) === squash(`you ${ASKED} agent ${REPLY}`) &&
				pinned.from + pinned.rows.length === box - 1 &&
				pinned.rows.every((row) => /^(you|agent| {6}) /.test(row)),
			(pinned?.rows ?? screen).join(' / '),
		);
		const more = screen.find((row) => /^\+ \d+ more\s*$/.test(row));
		const hidden = Number(more?.match(/\d+/)?.[0] ?? 0);
		const doneRows = screen.filter((row) => /^✓ \S+ +Tidy report/.test(row));
		check(
			`${size}: DONE TODAY folds to its newest rows and "+ N more", above the console`,
			more !== undefined &&
				doneRows.length >= 1 &&
				doneRows.length + hidden === DONE &&
				screen.indexOf(more) < (pinned?.from ?? 0) &&
				screen.some((row) => row.startsWith('NEEDS YOU')) &&
				screen.some((row) => row.startsWith('WORKING')),
			`${doneRows.length} shown + ${hidden} more`,
		);

		// ↓ reaches "+ N more"; enter shows every done task, esc folds them.
		for (let step = 0; step < 12; step += 1) {
			if ((tui.screen().at(-1) ?? '').includes('enter show all')) break;
			// oxlint-disable-next-line eslint/no-await-in-loop
			await tui.type(DOWN);
		}
		check(
			`${size}: "+ N more" can be selected, and the hint says enter shows all`,
			(tui.screen().at(-1) ?? '').includes('enter show all'),
			tui.screen().at(-1),
		);
		await tui.type('\r');
		await settle();
		const seen = new Set<string>();
		for (let step = 0; step <= DONE; step += 1) {
			screen = tui.screen();
			for (const row of screen) {
				const title = row.match(/^✓ \S+ +(Tidy report \d+)/)?.[1];
				if (title) seen.add(title);
			}
			// oxlint-disable-next-line eslint/no-await-in-loop
			await tui.type(DOWN);
		}
		screen = tui.screen();
		const stillPinned = consoleRows(screen);
		check(
			`${size}: enter on it shows all ${DONE} done tasks, scrolling above the pinned console`,
			seen.size === DONE &&
				!screen.some((row) => /^\+ \d+ more/.test(row)) &&
				(screen.at(-1) ?? '').includes('esc fewer') &&
				squash(stillPinned?.rows.join(' ') ?? '').endsWith(squash(REPLY)),
			`${seen.size} seen`,
		);
		await tui.type(ESC);
		await settle();
		screen = tui.screen();
		check(
			`${size}: esc folds DONE TODAY back, with "+ N more" selected`,
			screen.some((row) => /^\+ \d+ more/.test(row)) &&
				(screen.at(-1) ?? '').includes('enter show all'),
			screen.at(-1),
		);
	} finally {
		await tui.quit();
	}
}

try {
	await agent.action({ type: 'send_console', text: 'tidy the reports (MANY)' });
	await agent.until(
		`${DONE} tasks done`,
		async () =>
			new Set(
				agent.lines
					.filter(
						(line): line is TaskLine =>
							line.type === 'task' &&
							line.task.status === 'done' &&
							line.task.title.startsWith('Tidy report'),
					)
					.map((line) => line.task.handle),
			).size,
		(count) => count >= DONE,
	);
	await agent.action({ type: 'send_console', text: 'and these two (TWO)' });
	await agent.waitFor(
		'the question',
		(line): line is TaskLine =>
			line.type === 'task' && line.task.status === 'needs_you',
	);
	await agent.action({ type: 'send_console', text: ASKED });
	await agent.waitFor(
		'the reply',
		(line): line is MessageLine =>
			line.type === 'message' && line.message.text === REPLY,
	);
	await layoutChecks(80, 24);
	await layoutChecks(120, 40);
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
