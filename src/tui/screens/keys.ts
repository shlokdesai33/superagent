import { type Line, fit } from '../cells.ts';

const KEYS: Array<[string, string]> = [
	['j k  ↓ ↑', 'move or scroll'],
	['pageup pagedown', 'move or scroll by five'],
	['enter', 'answer, or open the selected item'],
	['o', 'open the task · in a task, its PR or issue'],
	['s s', 'stop or dismiss the task'],
	['/  i', 'write · @handle messages a task'],
	['r', 'resume failed tasks, on health'],
	['p', 'add or replace the key, on health'],
	['h', 'health'],
	['?', 'keys'],
	['esc', 'back · cancel typing'],
	['q  ctrl-c', 'quit (q on home)'],
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
				t: 'enter sends · esc cancels · ctrl-u clears · tab changes the repository',
				fg: 'dim',
			},
		],
	});
	return lines;
}
