/**
 * Yields the `data` of each server-sent event in `body`. Comments (Particle's
 * `: keep-alive`) and other fields are skipped. Cancels the body when the
 * caller stops iterating.
 */
export async function* readSseData(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, undefined> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buffer = '';
	let data: string[] = [];
	try {
		for (;;) {
			// oxlint-disable-next-line eslint/no-await-in-loop -- reads are sequential
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				const event = readLine(line.endsWith('\r') ? line.slice(0, -1) : line);
				if (event === null) continue;
				if (event === END_OF_EVENT) {
					if (data.length > 0) yield data.join('\n');
					data = [];
				} else {
					data.push(event);
				}
			}
		}
		// An unterminated last line may be cut off mid-JSON, so it's dropped; whole
		// data lines missing only their blank line still count.
		if (data.length > 0) yield data.join('\n');
	} finally {
		await reader.cancel().catch(() => undefined);
	}
}

const END_OF_EVENT = Symbol('end of event');

function readLine(line: string): string | typeof END_OF_EVENT | null {
	if (line === '') return END_OF_EVENT;
	if (line.startsWith(':')) return null;
	const colon = line.indexOf(':');
	const field = colon === -1 ? line : line.slice(0, colon);
	if (field !== 'data') return null;
	const value = colon === -1 ? '' : line.slice(colon + 1);
	return value.startsWith(' ') ? value.slice(1) : value;
}
