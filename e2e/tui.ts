// Runs the real terminal UI in a pseudo-terminal made by `script`, so it
// starts the way `superagent` does: in a folder, detecting its repository.
import { join } from 'node:path';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const WAIT_MS = 15_000;

export type Tui = {
	/** Where the output so far ends, for `waitFor` and `seen`. */
	mark(): number;
	/** The screen's text since `from`, without escape sequences. */
	seen(from?: number): string;
	/** Everything written since `from`, escape sequences included. */
	raw(from?: number): string;
	/** The rows on screen now, as text with trailing spaces trimmed. */
	screen(): string[];
	waitFor(text: string, from?: number): Promise<void>;
	/** Keys as the terminal sends them: `\t` is tab, `\r` enter. */
	type(keys: string): Promise<void>;
	/** Text as a terminal pastes it, between bracketed-paste markers. */
	paste(text: string): Promise<void>;
	quit(): Promise<void>;
};

export type TuiOptions = {
	/** Added to the environment; an `undefined` value removes the variable. */
	env?: Record<string, string | undefined>;
	columns?: number;
	rows?: number;
	/** What to wait for before returning; the home screen's input line by default. */
	until?: string;
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

/** Opens `superagent` in `cwd` for the agent in `home`. */
export async function openTui(
	home: string,
	cwd: string,
	options: TuiOptions = {},
): Promise<Tui> {
	const columns = options.columns ?? 100;
	const rows = options.rows ?? 30;
	// Like the harness, SUPERAGENT_BIN runs a compiled executable instead.
	const superagent = Bun.env.SUPERAGENT_BIN ?? `bun ${CLI}`;
	const command = `stty cols ${columns} rows ${rows}; exec ${superagent}`;
	const environment: Record<string, string | undefined> = {
		...Bun.env,
		SUPERAGENT_HOME: home,
		SHELL: '/bin/sh',
	};
	for (const [name, value] of Object.entries(options.env ?? {})) {
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
		// The UI paints whole rows, each after a cursor move to its start.
		screen() {
			const shown: string[] = Array.from({ length: rows }, () => '');
			// oxlint-disable-next-line no-control-regex
			for (const part of raw.split(/(?=\x1b\[\d+;1H)/)) {
				// oxlint-disable-next-line no-control-regex
				const row = part.match(/^\x1b\[(\d+);1H/);
				if (!row) continue;
				const y = Number(row[1]) - 1;
				if (y < rows) shown[y] = plain(part.slice(row[0].length)).trimEnd();
			}
			return shown;
		},
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
		async paste(text) {
			await tui.type(`\x1b[200~${text}\x1b[201~`);
		},
		async quit() {
			await send('q');
			const exited = await Promise.race([
				child.exited.then(() => true),
				Bun.sleep(3_000).then(() => false),
			]);
			if (!exited) child.kill();
			await child.exited;
		},
	};
	await tui.waitFor(options.until ?? 'press / to ask');
	return tui;
}
