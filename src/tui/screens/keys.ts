import { type Line, fit } from '../cells.ts';

const KEYS: Array<[string, string]> = [
	['j k  ↓ ↑', 'move the selection, or scroll'],
	['pageup pagedown', 'move or scroll five at a time'],
	[
		'enter',
		'answer the selected question · open a task · open health for a problem',
	],
	['o', 'open the selected task · in a task, its PR or issue in your browser'],
	[
		's s',
		'stop the selected task; the first press asks, any other key cancels',
	],
	['/  i', 'write · start with @handle to message a task'],
	['r', 'resume failed tasks, on the health screen'],
	['h', 'health'],
	['?', 'this list of keys'],
	['esc', 'back to home · cancel typing'],
	['q  ctrl-c', 'quit (q on the home screen)'],
];

export function keysBody(): Line[] {
	const lines: Line[] = KEYS.map(([key, words]) => ({
		segs: [
			{ t: fit(key, 18), fg: 'fg', b: true },
			{ t: words, fg: 'dim' },
		],
	}));
	lines.push({
		segs: [
			{ t: fit('while typing', 18), fg: 'fg', b: true },
			{
				t: 'enter sends · esc cancels · backspace deletes · ctrl-u clears the line',
				fg: 'dim',
			},
		],
	});
	return lines;
}
