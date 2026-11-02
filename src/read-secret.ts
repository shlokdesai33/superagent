/** Thrown when the person presses Ctrl-C at the prompt. */
export class Cancelled extends Error {
	override name = 'Cancelled';
}

/**
 * Reads one line from the terminal without echoing it, after writing `prompt`
 * to stderr. Piped input is read whole instead, without a prompt.
 */
export async function readSecret(prompt: string): Promise<string> {
	const { stdin, stderr } = process;
	if (!stdin.isTTY) return (await Bun.stdin.text()).trim();
	stderr.write(prompt);
	stdin.setRawMode(true);
	stdin.setEncoding('utf8');
	try {
		return await new Promise<string>((resolve, reject) => {
			let text = '';
			const onData = (chunk: string) => {
				for (const char of chunk) {
					if (char === '\r' || char === '\n' || char === '\u0004') {
						stdin.off('data', onData);
						resolve(text.trim());
						return;
					}
					if (char === '\u0003') {
						stdin.off('data', onData);
						reject(new Cancelled('Cancelled'));
						return;
					}
					if (char === '\u007f' || char === '\b') text = text.slice(0, -1);
					else if (char === '\u0015') text = '';
					else if (char >= ' ') text += char;
				}
			};
			stdin.on('data', onData);
			stdin.resume();
		});
	} finally {
		stdin.setRawMode(false);
		stdin.pause();
		stderr.write('\n');
	}
}
