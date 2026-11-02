import { type Line, fit, hang } from '../cells.ts';

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
	[
		'while typing',
		'enter sends · esc cancels · ctrl-u clears · tab changes the repository',
	],
];

export function keysBody(content: number): Line[] {
	return KEYS.flatMap(([key, words]) =>
		hang(
			[{ t: fit(key, 18), fg: 'fg', b: true }],
			[{ t: words, fg: 'dim' }],
			content,
		),
	);
}
