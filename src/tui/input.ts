export type KeyName =
	| 'up'
	| 'down'
	| 'left'
	| 'right'
	| 'pageup'
	| 'pagedown'
	| 'home'
	| 'end'
	| 'enter'
	| 'escape'
	| 'backspace'
	| 'delete'
	| 'tab';

export type InputEvent =
	| { kind: 'char'; ch: string }
	| { kind: 'key'; name: KeyName }
	| { kind: 'ctrl'; letter: string }
	| { kind: 'paste'; text: string }
	| { kind: 'focus'; gained: boolean }
	/** An OSC 11 reply, such as `rgb:1616/1616/1b1b`. */
	| { kind: 'background'; reply: string }
	/** A primary device attributes reply; it follows the OSC 11 reply, if any. */
	| { kind: 'attributes' };

const ESCAPE_WAIT_MS = 30;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const CSI_KEYS: Record<string, KeyName> = {
	A: 'up',
	B: 'down',
	C: 'right',
	D: 'left',
	H: 'home',
	F: 'end',
	'5~': 'pageup',
	'6~': 'pagedown',
	'1~': 'home',
	'3~': 'delete',
	'7~': 'home',
	'4~': 'end',
	'8~': 'end',
};

const segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' });

/** Turns raw terminal input into events. Unknown escape sequences are swallowed. */
export function createParser(
	emit: (event: InputEvent) => void,
): (chunk: Uint8Array) => void {
	const decoder = new TextDecoder();
	let buffer = '';
	let paste: string | null = null;
	let timer: Timer | null = null;

	const parse = () => {
		if (timer) {
			clearTimeout(timer);
			timer = null;
		}
		while (buffer.length > 0) {
			if (paste !== null) {
				const end = buffer.indexOf(PASTE_END);
				if (end === -1) {
					paste += buffer;
					buffer = '';
					return;
				}
				paste += buffer.slice(0, end);
				buffer = buffer.slice(end + PASTE_END.length);
				emit({ kind: 'paste', text: paste });
				paste = null;
				continue;
			}
			const consumed = step();
			if (consumed === 0) {
				// An incomplete sequence: wait briefly, then treat a lone escape
				// as the key and drop anything else.
				timer = setTimeout(() => {
					timer = null;
					if (buffer === '\x1b') emit({ kind: 'key', name: 'escape' });
					buffer = '';
				}, ESCAPE_WAIT_MS);
				return;
			}
			buffer = buffer.slice(consumed);
		}
	};

	/** Handles the start of the buffer; returns how much it used, or 0 to wait. */
	const step = (): number => {
		const first = buffer[0] ?? '';
		if (first === '\x1b') return escape();
		if (first === '\r' || first === '\n') {
			emit({ kind: 'key', name: 'enter' });
			return buffer.startsWith('\r\n') ? 2 : 1;
		}
		if (first === '\x7f' || first === '\x08') {
			emit({ kind: 'key', name: 'backspace' });
			return 1;
		}
		if (first === '\t') {
			emit({ kind: 'key', name: 'tab' });
			return 1;
		}
		const code = first.charCodeAt(0);
		if (code < 0x20) {
			emit({ kind: 'ctrl', letter: String.fromCharCode(code + 0x60) });
			return 1;
		}
		if (code >= 0x80 && code < 0xa0) return 1;
		// eslint-disable-next-line no-control-regex
		const run = buffer.match(/^[^\x00-\x1f\x7f-\x9f]+/)?.[0] ?? first;
		for (const { segment } of segmenter.segment(run)) {
			emit({ kind: 'char', ch: segment });
		}
		return run.length;
	};

	const escape = (): number => {
		if (buffer.length < 2) return 0;
		const kind = buffer[1];
		if (kind === '[') {
			const match = buffer.slice(2).match(/^[0-?]*[ -/]*[@-~]/);
			if (!match) return buffer.length > 64 ? buffer.length : 0;
			const body = match[0];
			const length = 2 + body.length;
			if (buffer.startsWith(PASTE_START)) {
				paste = '';
				return PASTE_START.length;
			}
			if (body === 'I' || body === 'O') {
				emit({ kind: 'focus', gained: body === 'I' });
				return length;
			}
			if (body.startsWith('?') && body.endsWith('c')) {
				emit({ kind: 'attributes' });
				return length;
			}
			// Modified keys (`1;5A`) act as the plain key.
			const plain = body
				.replace(/^1;\d+(?=[A-DHF]$)/, '')
				.replace(/;\d+(?=~$)/, '');
			const name = CSI_KEYS[plain];
			if (name) emit({ kind: 'key', name });
			return length;
		}
		if (kind === 'O') {
			if (buffer.length < 3) return 0;
			const name = CSI_KEYS[buffer[2] ?? ''];
			if (name) emit({ kind: 'key', name });
			return 3;
		}
		if (kind === ']' || kind === 'P' || kind === '_' || kind === '^') {
			const bell = buffer.indexOf('\x07', 2);
			const st = buffer.indexOf('\x1b\\', 2);
			const ends = [bell, st].filter((index) => index !== -1);
			if (ends.length === 0) return buffer.length > 4096 ? buffer.length : 0;
			const end = Math.min(...ends);
			const body = buffer.slice(2, end);
			if (kind === ']' && body.startsWith('11;')) {
				emit({ kind: 'background', reply: body.slice(3) });
			}
			return end + (end === st ? 2 : 1);
		}
		emit({ kind: 'key', name: 'escape' });
		return 1;
	};

	return (chunk) => {
		buffer += decoder.decode(chunk, { stream: true });
		parse();
	};
}
