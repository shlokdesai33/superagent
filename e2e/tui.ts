// Runs the real terminal UI in a pseudo-terminal made by `script`, so it
// starts the way `superagent` does: in a folder, detecting its repository.
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const WAIT_MS = 15_000;
const COLUMNS = 100;
const ROWS = 30;

export type Tui = {
	/** Where the output so far ends, for `waitFor` and `seen`. */
	mark(): number;
	/** The screen's text since `from`, without escape sequences. */
	seen(from?: number): string;
	/** Everything written since `from`, escape sequences included. */
	raw(from?: number): string;
	waitFor(text: string, from?: number): Promise<void>;
	/** Keys as the terminal sends them: `\t` is tab, `\r` enter. */
	type(keys: string): Promise<void>;
	quit(): Promise<void>;
};

function plain(raw: string): string {
	return (
		raw
			// oxlint-disable-next-line no-control-regex
			.replaceAll(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
			// oxlint-disable-next-line no-control-regex
			.replaceAll(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
	);
}

/**
 * Opens `superagent` in `cwd` for the agent in `home`. `env` is added to the
 * environment; an `undefined` value removes the variable. With `background`
 * (`#rrggbb`), the terminal answers the background query (OSC 11) as a
 * terminal with that background does; without, nothing answers.
 */
export async function openTui(
	home: string,
	cwd: string,
	env: Record<string, string | undefined> = {},
	background?: string,
): Promise<Tui> {
	// Like the harness, SUPERAGENT_BIN runs a compiled executable instead.
	const superagent = Bun.env.SUPERAGENT_BIN ?? `bun ${CLI}`;
	const command = `stty cols ${COLUMNS} rows ${ROWS}; exec ${superagent}`;
	const environment: Record<string, string | undefined> = {
		...Bun.env,
		SUPERAGENT_HOME: home,
		SHELL: '/bin/sh',
	};
	for (const [name, value] of Object.entries(env)) {
		if (value === undefined) delete environment[name];
		else environment[name] = value;
	}
	const child = Bun.spawn(
		process.platform === 'darwin'
			? ['script', '-q', '/dev/null', 'sh', '-c', command]
			: ['script', '-qfec', command, '/dev/null'],
		{
			cwd,
			env: environment,
			stdin: 'pipe',
			stdout: 'pipe',
			stderr: 'ignore',
		},
	);
	let raw = '';
	const decoder = new TextDecoder();
	const send = async (keys: string) => {
		await child.stdin.write(keys);
		await child.stdin.flush();
	};
	// Doubled, as `xterm` answers: `rgb:2828/2a2a/3636`.
	const reply = background
		? `\x1b]11;rgb:${[1, 3, 5].map((at) => background.slice(at, at + 2).repeat(2)).join('/')}\x1b\\`
		: null;
	const reading = (async () => {
		for await (const chunk of child.stdout) {
			const text = decoder.decode(chunk, { stream: true });
			raw += text;
			if (reply && text.includes('\x1b]11;?')) await send(reply);
		}
	})();

	const tui: Tui = {
		mark: () => raw.length,
		seen: (from = 0) => plain(raw.slice(from)),
		raw: (from = 0) => raw.slice(from),
		async waitFor(text, from = 0) {
			const deadline = Date.now() + WAIT_MS;
			while (!tui.seen(from).includes(text)) {
				if (Date.now() > deadline) {
					throw new Error(`timed out waiting for the UI to show "${text}"`);
				}
				// oxlint-disable-next-line eslint/no-await-in-loop
				await Bun.sleep(50);
			}
		},
		async type(keys) {
			await send(keys);
			await Bun.sleep(150);
		},
		async quit() {
			await send('q');
			const exited = await Promise.race([
				child.exited.then(() => true),
				Bun.sleep(3_000).then(() => false),
			]);
			if (!exited) child.kill();
			await child.exited;
			await reading;
		},
	};
	await tui.waitFor('press / to ask');
	return tui;
}
