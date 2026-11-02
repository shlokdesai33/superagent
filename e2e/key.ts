// End to end: the first-run key screen. With no Particle key, `superagent`
// opens on the welcome screen; a key Particle rejects is refused in place and
// nothing is saved; a good one is checked, written to the key file with mode
// 0600, picked up by the agent without a restart, and the home screen
// follows. A key revoked while the agent was down brings the screen back on
// the next start, and health's "replace key" opens it too. No key ever shows
// in the terminal, the feed, the Router's prompts or the logs. Run with
// `bun run e2e`; it exits non-zero if a check fails.
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { FeedLine, Health } from '../src/protocol.ts';
import { startFakeParticle } from './fake-particle.ts';
import { startAgent } from './harness.ts';
import { replay, text } from './screen.ts';
import { openTui } from './tui.ts';

type HealthLine = Extract<FeedLine, { type: 'health' }>;
type SnapshotLine = Extract<FeedLine, { type: 'snapshot' }>;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (!ok) failures += 1;
	process.stdout.write(
		`${ok ? '✓' : '✗'} ${name}${detail ? `  (${detail})` : ''}\n`,
	);
}

/** A key shaped like Particle's: `pai-` and 43 more characters. */
function newKey(): string {
	const alphabet =
		'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	const bytes = crypto.getRandomValues(new Uint8Array(43));
	return `pai-${Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')}`;
}

const particle = startFakeParticle((request) =>
	request.session === 'compaction'
		? { content: 'Summary.' }
		: { content: 'Nothing to do.' },
);
const badKey = newKey();
const goodKey = newKey();
const nextKey = newKey();
particle.auth.rejectedKeys.add(badKey);
const keys = [badKey, goodKey, nextKey];

const agent = await startAgent(particle.url, { env: { PARTICLE_API_KEY: '' } });
const keyFile = join(agent.home, 'particle-key');
const outside = mkdtempSync('/tmp/sa-key-');
const tuiEnv = { PARTICLE_BASE_URL: particle.url, PARTICLE_API_KEY: '' };
/** The first health or snapshot line after the `from`th feed line whose model matches. */
const health = (
	what: string,
	from: number,
	ok: (model: Health['model']) => boolean,
) =>
	agent.waitFor(
		what,
		(line): line is HealthLine | SnapshotLine =>
			agent.lines.indexOf(line) >= from &&
			((line.type === 'health' && ok(line.health.model)) ||
				(line.type === 'snapshot' && ok(line.snapshot.health.model))),
	);
const fileMode = (): number | null => {
	try {
		return statSync(keyFile).mode & 0o777;
	} catch {
		return null;
	}
};

try {
	// 1. No key: the welcome screen, not home.
	const tui = await openTui(agent.home, outside, tuiEnv, {
		until: 'Paste your Particle API key',
	});
	const first = tui.screen();
	await Bun.sleep(200);
	const painted = replay(tui.raw()).cells.filter((row) =>
		row.some((cell) => cell.bgRgb !== null),
	);
	check(
		"the key screen keeps the terminal's background, painting only the input band",
		painted.length === 1 && text(painted[0] ?? []).includes('paste your key'),
		painted.map(text).join(' | '),
	);
	check(
		'with no key, superagent opens on the key screen with the wordmark',
		first.some((row) => row.includes('███████╗██╗   ██╗██████╗')) &&
			!tui.seen().includes('@handle to message a task'),
	);

	// 1b. On short terminals the wordmark shrinks or goes, never the input or
	//     the outcome of a try.
	for (const [columns, rows] of [
		[40, 12],
		[100, 16],
	] as const) {
		const small = await openTui(agent.home, outside, tuiEnv, {
			columns,
			rows,
			until: 'enter save',
		});
		const before = small.screen().join('\n');
		await small.paste(badKey);
		await Bun.sleep(200);
		const pasted = small.screen();
		await small.type('\r');
		await small.waitFor('Particle rejected', small.mark()).catch(() => {});
		await Bun.sleep(200);
		const shown = small.screen();
		const after = shown.join('\n');
		check(
			`at ${columns}×${rows} the input and the outcome line stay on screen`,
			before.includes('› ') &&
				before.includes('paste your key') &&
				after.includes('Particle rejected this key'),
		);
		// Like typed text, the masked key and the error wrap, every character
		// kept, continuing under the text after `› ` and `✗ `.
		const masked = pasted.filter((row) => row.includes('•'));
		const error = shown.findIndex((row) => row.includes('✗ Particle'));
		const errorText = shown
			.slice(error, error + 2)
			.map((row) => row.trim())
			.join(' ');
		check(
			`at ${columns}×${rows} the masked key and the error wrap, nothing cut`,
			masked.join('').split('•').length - 1 === badKey.length &&
				masked.slice(1).every((row) => /^ *  •/.test(row)) &&
				errorText.includes('Particle rejected this key · paste another') &&
				!after.includes('…'),
			`${masked.length} key rows`,
		);
		await small.type('\x1b');
		await small.quit();
	}

	// 2. Not a key at all, then a key Particle rejects: refused in place.
	let mark = tui.mark();
	await tui.type('hello\r');
	await tui.waitFor("That isn't a Particle API key", mark);
	mark = tui.mark();
	await tui.paste(badKey);
	await tui.waitFor('•'.repeat(badKey.length), mark);
	await tui.type('\r');
	await tui.waitFor('Particle rejected this key', mark);
	check(
		'the screen says only what to do: no storage or reassurance',
		!/costs nothing|readable only|nothing was saved|stays hidden/.test(
			tui.seen(),
		),
	);
	check(
		'a rejected key is refused on the same screen and nothing is saved',
		fileMode() === null &&
			tui.screen().some((row) => row.includes('Paste your')),
	);

	// 3. A good key: saved with 0600, picked up live, and home appears.
	let from = agent.lines.length;
	mark = tui.mark();
	await tui.paste(goodKey);
	await tui.type('\r');
	await tui.waitFor('@handle to message a task', mark);
	check(
		'a good key is written to the key file with mode 0600',
		fileMode() === 0o600 && readFileSync(keyFile, 'utf8') === `${goodKey}\n`,
		fileMode()?.toString(8) ?? 'no file',
	);
	check(
		'the home screen follows, with a toast saying it was saved',
		tui.seen(mark).includes('✓ Saved the key'),
	);
	await health(
		'the agent to take the key from its file',
		from,
		(model) => model.key === 'file' && model.state === 'ok',
	);
	check('the running agent uses the new key without a restart', true);

	// 4. Health's replace key opens the same screen; esc goes back.
	mark = tui.mark();
	await tui.type('\x14');
	await tui.waitFor('ctrl-k replace key', mark);
	await tui.type('\x0b');
	await tui.waitFor('Paste a new Particle API key', mark);
	mark = tui.mark();
	await tui.type('\x1b');
	await tui.waitFor('ctrl-k replace key', mark);
	check("health's replace key opens the key screen, and esc goes back", true);
	await tui.type('\x1b');

	// 5. The key is revoked while the agent is down: its next start finds out
	//    with the free key check, and the screen comes back to replace it.
	particle.auth.rejectedKeys.add(goodKey);
	await agent.crash();
	from = agent.lines.length;
	mark = tui.mark();
	await agent.restart();
	await tui.waitFor('Particle rejected the saved key', mark);
	const rejected = await health(
		'the startup check to reject the key',
		from,
		(model) => model.keyRejected,
	);
	check('a key rejected at startup brings the key screen back', true);
	mark = tui.mark();
	await tui.paste(nextKey);
	await tui.type('\r');
	await tui.waitFor('@handle to message a task', mark);
	await health(
		'the model to resume on the replaced key',
		agent.lines.indexOf(rejected) + 1,
		(model) => model.state === 'ok' && !model.keyRejected,
	);
	check(
		'a replaced rejected key resumes the model at once',
		readFileSync(keyFile, 'utf8') === `${nextKey}\n`,
	);

	// 6. Particle rejects the key in use while you're writing a message, then
	//    accepts it again: the key screen opens anyway, the draft is back
	//    after it, and pasting the same key resumes the model at once, not
	//    at the next 2-minute retry.
	await tui.type('half a thought');
	particle.auth.rejectedKeys.add(nextKey);
	from = agent.lines.length;
	mark = tui.mark();
	await agent.action({ type: 'send_console', text: 'hello' });
	const paused = await health(
		'a model call to be rejected',
		from,
		(model) => model.keyRejected,
	);
	const opened = await tui
		.waitFor('Particle rejected the saved key', mark)
		.then(() => true)
		.catch(() => false);
	check('the key screen opens while a message is being written', opened);
	particle.auth.rejectedKeys.delete(nextKey);
	mark = tui.mark();
	await tui.paste(nextKey);
	await tui.type('\r');
	await tui.waitFor('✓ Saved the key', mark);
	check(
		'the draft is still there after the key screen',
		tui.screen().some((row) => row.includes('› half a thought')),
	);
	await tui.type('\x1b');
	const resumed = await health(
		'the model to resume on the same key saved again',
		agent.lines.indexOf(paused) + 1,
		(model) => model.state === 'ok',
	).catch(() => null);
	check(
		'saving the same key again after Particle accepts it resumes the model',
		resumed !== null,
	);

	// 7. No key anywhere it shouldn't be.
	const terminal = tui.seen();
	check(
		'no key ever shows in the terminal',
		keys.every((key) => !terminal.includes(key)),
	);
	const feed = JSON.stringify(agent.lines);
	check(
		'no key is on the feed',
		keys.every((key) => !feed.includes(key)),
	);
	const prompts = JSON.stringify(particle.requests.map((r) => r.body));
	check(
		"no key is in the Router's or Workers' prompts",
		keys.every((key) => !prompts.includes(key)),
	);
	await tui.quit();
} finally {
	await agent.stop((home) => {
		const logs = ['daemon.log', 'output.log']
			.map((name) => {
				try {
					return readFileSync(join(home, name), 'utf8');
				} catch {
					return '';
				}
			})
			.join('\n');
		check(
			'no key is in the logs',
			logs.includes('Particle key found') &&
				keys.every((key) => !logs.includes(key)),
		);
	});
	rmSync(outside, { recursive: true, force: true });
	particle.stop();
}

process.stdout.write(
	failures === 0 ? '\nAll checks passed.\n' : `\n${failures} failed.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
