import { type Line, fit, hang } from '../cells.ts';

const KEYS: Array<[string, string]> = [
	['type', 'write · @handle messages a task'],
	['enter', 'send · with nothing typed, answer or open the selected item'],
	['↑ ↓', 'move or scroll · in a draft, move up or down'],
	['pageup pagedown', 'move or scroll by five'],
	['esc', 'clear the draft · back'],
	['tab', 'change the repository for new tasks'],
	['ctrl-o', 'open the task · in a task, its PR or issue'],
	['ctrl-x ctrl-x', 'stop or dismiss the task'],
	['ctrl-t', 'health'],
	['ctrl-r', 'resume failed tasks, on health'],
	['ctrl-k', 'add or replace the key, on health'],
	['?', 'keys, with nothing typed'],
	['ctrl-c', 'quit · twice with a draft'],
	[
		'editing',
		'← → home end · ctrl-a ctrl-e · ctrl-w deletes a word · ctrl-u clears',
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
