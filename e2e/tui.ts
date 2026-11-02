// Runs the real terminal UI in a pseudo-terminal made by `script`, so it
// starts the way `superagent` does: in a folder, detecting its repository.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { COLUMNS, ROWS, replayText } from './screen.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const WAIT_MS = 15_000;

export type Tui = {
	/** Where the output so far ends, for `waitFor` and `seen`. */
	mark(): number;
	/** The screen's text since `from`, without escape sequences. */
	seen(from?: number): string;
	/** Everything written since `from`, escape sequences included. */
	raw(from?: number): string;
	/**
	 * The screen's rows as a terminal shows them, replaying what was written
	 * since `from` (a mark taken before a full repaint, or the start). A wide
	 * character takes two columns.
	 */
	screen(from?: number): string[];
	waitFor(text: string, from?: number): Promise<void>;
	/** Keys as the terminal sends them: `\t` is tab, `\r` enter. */
	type(keys: string): Promise<void>;
	/** Resizes the pseudo-terminal, which sends the UI a SIGWINCH. */
	resize(columns: number, rows: number): Promise<void>;
	quit(): Promise<void>;
};

export type TuiSize = { columns?: number; rows?: number };

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
 * environment; an `undefined` value removes the variable.
 */
export async function openTui(
	home: string,
	cwd: string,
	env: Record<string, string | undefined> = {},
	size: TuiSize = {},
): Promise<Tui> {
	let columns = size.columns ?? COLUMNS;
	let rows = size.rows ?? ROWS;
	// Like the harness, SUPERAGENT_BIN runs a compiled executable instead.
	const superagent = Bun.env.SUPERAGENT_BIN ?? `bun ${CLI}`;
	// The pseudo-terminal's name, for `resize`.
	const ttyFile = join(mkdtempSync(join(tmpdir(), 'sa-tty-')), 'tty');
	const command = `tty > ${ttyFile}; stty cols ${columns} rows ${rows}; exec ${superagent}`;
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
	void (async () => {
		for await (const chunk of child.stdout) {
			raw += decoder.decode(chunk, { stream: true });
		}
	})();

	const send = async (keys: string) => {
		await child.stdin.write(keys);
		await child.stdin.flush();
	};
	const tui: Tui = {
		mark: () => raw.length,
		seen: (from = 0) => plain(raw.slice(from)),
		raw: (from = 0) => raw.slice(from),
		screen: (from = 0) => replayText(raw.slice(from), columns, rows),
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
		async resize(newColumns, newRows) {
			const tty = readFileSync(ttyFile, 'utf8').trim();
			const flag = process.platform === 'darwin' ? '-f' : '-F';
			const stty = Bun.spawnSync([
				'stty',
				flag,
				tty,
				'cols',
				String(newColumns),
				'rows',
				String(newRows),
			]);
			if (stty.exitCode !== 0) {
				throw new Error(
					`stty couldn't resize ${tty}: ${stty.stderr.toString()}`,
				);
			}
			columns = newColumns;
			rows = newRows;
			await Bun.sleep(300);
		},
		async quit() {
			await send('q');
			const exited = await Promise.race([
				child.exited.then(() => true),
				Bun.sleep(3_000).then(() => false),
			]);
			if (!exited) child.kill();
			await child.exited;
			rmSync(dirname(ttyFile), { recursive: true, force: true });
		},
	};
	await tui.waitFor('press / to ask');
	return tui;
}
