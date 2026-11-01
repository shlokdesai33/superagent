import { writeSync } from 'node:fs';
import { type Cell, serialize } from './cells.ts';
import { type InputEvent, createParser } from './input.ts';
import { type ThemeName, themeFromColorFgBg, themeFromOsc11 } from './theme.ts';

const DETECT_TIMEOUT_MS = 100;

// Alternate screen, hidden cursor, no autowrap (so the last cell can be
// painted), focus reports and bracketed paste.
const ENTER = '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1004h\x1b[?2004h\x1b[2J';
const LEAVE =
	'\x1b[0m\x1b]8;;\x1b\\\x1b[?2004l\x1b[?1004l\x1b[?7h\x1b[?25h\x1b[?1049l';
const QUERY_BACKGROUND = '\x1b]11;?\x1b\\';
const QUERY_ATTRIBUTES = '\x1b[c';
const SYNC_START = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';

export class Terminal {
	private previous: string[] = [];
	private listener: (event: InputEvent) => void = () => {};
	private entered = false;
	private readonly onData = createParser((event) => this.listener(event));
	private readonly onChunk = (chunk: Uint8Array) => this.onData(chunk);

	get columns(): number {
		return process.stdout.columns || 80;
	}

	get rows(): number {
		return process.stdout.rows || 24;
	}

	/** Raw input; events go to `listen`'s handler. */
	start(): void {
		process.stdin.setRawMode(true);
		process.stdin.on('data', this.onChunk);
		process.stdin.resume();
	}

	listen(handler: (event: InputEvent) => void): void {
		this.listener = handler;
	}

	onResize(handler: () => void): void {
		process.stdout.on('resize', handler);
	}

	/**
	 * Asks the terminal for its background (OSC 11), using the device
	 * attributes reply that follows it to stop waiting early. Falls back to
	 * `COLORFGBG`, then dark.
	 */
	detectTheme(): Promise<ThemeName> {
		return new Promise((resolve) => {
			let done = false;
			const finish = (name: ThemeName) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				resolve(name);
			};
			const timer = setTimeout(
				() => finish(themeFromColorFgBg(Bun.env.COLORFGBG)),
				DETECT_TIMEOUT_MS,
			);
			this.listen((event) => {
				if (event.kind === 'background') {
					finish(
						themeFromOsc11(event.reply) ??
							themeFromColorFgBg(Bun.env.COLORFGBG),
					);
				} else if (event.kind === 'attributes') {
					finish(themeFromColorFgBg(Bun.env.COLORFGBG));
				}
			});
			this.write(QUERY_BACKGROUND + QUERY_ATTRIBUTES);
		});
	}

	/** Asks again; the reply arrives as a `background` event. */
	queryBackground(): void {
		this.write(QUERY_BACKGROUND);
	}

	enter(): void {
		this.entered = true;
		this.write(ENTER);
	}

	/** Restores the terminal as it was. Safe to call more than once. */
	leave(): void {
		if (this.entered) {
			this.entered = false;
			writeSync(1, LEAVE);
		}
		process.stdin.off('data', this.onChunk);
		if (process.stdin.isTTY) process.stdin.setRawMode(false);
		process.stdin.pause();
	}

	/** Rewrites only the rows that changed, in one synchronized update. */
	draw(rows: Cell[][]): void {
		let out = '';
		rows.forEach((cells, y) => {
			const line = serialize(cells);
			if (this.previous[y] === line) return;
			this.previous[y] = line;
			out += `\x1b[${y + 1};1H${line}`;
		});
		this.previous.length = rows.length;
		if (out !== '') this.write(`${SYNC_START}${out}\x1b[0m${SYNC_END}`);
	}

	/** Forgets what's on screen, so the next frame repaints every row. */
	invalidate(): void {
		this.previous = [];
	}

	private write(text: string): void {
		process.stdout.write(text);
	}
}
