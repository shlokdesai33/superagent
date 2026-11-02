import { type Line, fit, hang } from '../cells.ts';

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
	[
		'while typing',
		'enter sends · esc cancels · backspace deletes · ctrl-u clears the line',
	],
	[
		'',
		'tab, when opened in a repository, changes where new tasks go: there, another repository, or none',
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
