// End to end: long text wraps instead of being cut. At 80 columns a
// 600-character console message and the Router's reply show in full across
// wrapped rows, continuation rows lined up under the text, wide characters and
// emoji included; so does the draft in the composer while you type it, and a
// long question under NEEDS YOU and in the task view. Resizing re-wraps, and
// ↑ ↓ scroll through a reply taller than the screen. Run with `bun run e2e`;
// it exits non-zero if a check fails.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FeedLine } from '../src/protocol.ts';
import { startFakeParticle } from './fake-particle.ts';
import { startAgent } from './harness.ts';
import { type Tui, openTui } from './tui.ts';

type TaskLine = Extract<FeedLine, { type: 'task' }>;

const WORDS = [
	'the',
	'export',
	'crashes',
	'when',
	'Safari',
	'opens',
	'a',
	'shared',
	'report',
	'設定ファイル',
	'with',
	'more',
	'than',
	'forty',
	'columns',
	'🚀',
	'and',
	'then',
	'retries',
	'every',
	'request',
	'twice',
	'👍🏽',
	'before',
	'giving',
	'up',
];

// Longer words: the Router's console replies are at most 100 words.
const REPLY_WORDS = [
	'reproduced',
	'the',
	'intermittent',
	'export',
	'failure',
	'設定ファイル',
	'investigating',
	'Safari',
	'rendering',
	'pipeline',
	'🚀',
	'configuration',
	'regression',
	'introduced',
	'yesterday',
	'👍🏽',
	'afternoon',
];

/** At least `length` characters of `words`, after `start`, ending with `end`. */
function long(
	start: string,
	end: string,
	length: number,
	words = WORDS,
): string {
	const out = [start];
	for (let i = 0; [...out, end].join(' ').length < length; i += 1) {
		out.push(words[i % words.length] ?? 'word');
	}
	return [...out, end].join(' ');
}

const MESSAGE = long('Please look into this:', 'thanks, omega.', 600);
const REPLY = long(
	'Here is what I found:',
	'all done, sigma.',
	600,
	REPLY_WORDS,
);
// Questions are at most 300 characters.
const QUESTION = long('Which fix do you want?', 'pick one, delta?', 285);
const TITLE = 'Settle the export retries';

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
						instructions: 'Ask which fix to make.',
						threads: [],
						repo: 'none',
					},
				},
			],
		};
	}
	if (request.fresh.includes('omega')) {
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
		`${ok ? '✓' : '✗'} ${name}${detail ? `\n    ${detail.replaceAll('\n', '\n    ')}` : ''}\n`,
	);
}

const squash = (text: string) => text.replaceAll(/\s+/g, ' ').trim();

/**
 * The text of a wrapped block: the row where `starts` matches, then every row
 * indented by `indent` spaces under it, with the first `indent` columns cut.
 */
function block(
	rows: string[],
	starts: (row: string) => boolean,
	indent: number,
): { text: string; rows: string[] } | null {
	const first = rows.findIndex(starts);
	if (first === -1) return null;
	const taken = [rows[first] ?? ''];
	for (const row of rows.slice(first + 1)) {
		if (!row.startsWith(' '.repeat(indent)) || row[indent] === ' ') break;
		taken.push(row);
	}
	return {
		text: squash(taken.map((row) => row.slice(indent)).join(' ')),
		rows: taken,
	};
}

/** Checks `text` shows in full in the block, on more than one row. */
function whole(
	name: string,
	found: { text: string; rows: string[] } | null,
	text: string,
	screen: string[],
): void {
	check(
		name,
		found !== null &&
			found.rows.length > 1 &&
			found.text === squash(text) &&
			!found.text.includes('…'),
		found
			? `${found.rows.length} rows:\n${found.rows.join('\n')}`
			: screen.join('\n'),
	);
}

/** Your message and the Router's reply in the console, at the current size. */
function consoleChecks(tui: Tui, from: number, label: string): void {
	const screen = tui.screen(from);
	whole(
		`${label}: the 600-character console message shows in full, wrapped under the author column`,
		block(screen, (row) => row.startsWith('you    Please look'), 7),
		MESSAGE,
		screen,
	);
	whole(
		`${label}: the Router's 600-character reply shows in full, wrapped under the author column`,
		block(screen, (row) => /^\S+ +Here is what I found/.test(row), 7),
		REPLY,
		screen,
	);
}

const agent = await startAgent(particle.url);
const outside = mkdtempSync(join(tmpdir(), 'sa-long-'));
const settle = () => Bun.sleep(600);
const truecolor = { TERM: 'xterm-256color', COLORTERM: 'truecolor' };
// Terminal.app on macOS 15: the 256-colour palette.
const appleTerminal = {
	TERM: 'xterm-256color',
	TERM_PROGRAM: 'Apple_Terminal',
	TERM_PROGRAM_VERSION: '455.1',
	COLORTERM: undefined,
};

try {
	check(
		'the texts are long and hold wide characters and emoji',
		MESSAGE.length >= 600 &&
			REPLY.length >= 600 &&
			REPLY.split(' ').length <= 100 &&
			QUESTION.length <= 300 &&
			MESSAGE.includes('設定ファイル') &&
			MESSAGE.includes('👍🏽'),
		`${MESSAGE.length} / ${REPLY.length} / ${QUESTION.length} characters`,
	);

	let tui = await openTui(agent.home, outside, truecolor, {
		columns: 80,
		rows: 30,
	});
	try {
		await tui.type(MESSAGE);
		await tui.waitFor('omega.');
		await settle();
		const typing = tui.screen();
		// Inside the input box's border.
		const unboxed = typing.map((row) =>
			row.startsWith('│ ') ? row.slice(2).replace(/\s*│\s*$/, '') : row,
		);
		const band = block(unboxed, (row) => row.startsWith('› '), 2);
		const draft = band
			? {
					rows: band.rows,
					// The first row ends with the destination preview.
					text: squash(
						band.rows
							.map((row, index) =>
								(index === 0
									? row.slice(2, row.indexOf('→'))
									: row.slice(2)
								).replaceAll('▏', ''),
							)
							.join(' '),
					),
				}
			: null;
		whole(
			'80 columns: the composer shows the whole 600-character draft across wrapped rows',
			draft,
			MESSAGE,
			typing,
		);
		check(
			'80 columns: the destination preview stays on the composer’s first row',
			(band?.rows[0] ?? '').includes('→ the Router'),
		);

		let mark = tui.mark();
		await tui.type('\r');
		await tui.waitFor('sigma.', mark);
		await settle();
		consoleChecks(tui, 0, '80 columns');

		for (const columns of [120, 100]) {
			mark = tui.mark();
			// oxlint-disable-next-line eslint/no-await-in-loop
			await tui.resize(columns, 30);
			// oxlint-disable-next-line eslint/no-await-in-loop
			await settle();
			consoleChecks(tui, mark, `resized to ${columns} columns`);
		}

		// Too short for the reply: ↓ scrolls on through it, ↑ back.
		mark = tui.mark();
		await tui.resize(80, 14);
		await settle();
		const short = tui.screen(mark);
		check(
			'80×14: the reply is taller than the body, so its end is out of view at first',
			short.some((row) => row.startsWith('you    Please look')) &&
				!short.some((row) => row.includes('sigma.')),
			short.join('\n'),
		);
		await tui.type('\x1b[B'.repeat(20));
		await settle();
		const scrolled = tui.screen(mark);
		check(
			'80×14: ↓ scrolls the body until the end of the reply shows',
			scrolled.some((row) => row.includes('sigma.')),
			scrolled.join('\n'),
		);
		await tui.type('\x1b[A'.repeat(24));
		await settle();
		check(
			'80×14: ↑ scrolls back up to the start of the message',
			tui.screen(mark).some((row) => row.startsWith('you    Please look')),
		);
	} finally {
		await tui.quit();
	}

	tui = await openTui(agent.home, outside, appleTerminal, {
		columns: 80,
		rows: 30,
	});
	try {
		await tui.waitFor('sigma.');
		await settle();
		consoleChecks(tui, 0, '256 colours, 80 columns');
		check(
			'256 colours: only 256-colour SGR is used',
			!tui.raw().includes(';2;'),
		);

		await agent.action({ type: 'send_console', text: 'please settle (ASK)' });
		await agent.waitFor(
			'the task to ask its question',
			(line): line is TaskLine =>
				line.type === 'task' &&
				line.task.title === TITLE &&
				line.task.status === 'needs_you',
		);
		await tui.waitFor('delta?');
		await settle();
		let screen = tui.screen();
		whole(
			'256 colours, 80 columns: the NEEDS YOU question shows in full, wrapped under └',
			block(screen, (row) => row.startsWith('  └ Which fix'), 4),
			QUESTION,
			screen,
		);

		const mark = tui.mark();
		await tui.type('\x0f');
		await tui.waitFor('QUESTION', mark);
		await settle();
		screen = tui.screen();
		whole(
			'256 colours, 80 columns: the task view shows the question in full',
			block(screen, (row) => row.startsWith('  └ Which fix'), 4),
			QUESTION,
			screen,
		);
	} finally {
		await tui.quit();
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
