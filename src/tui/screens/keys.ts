import { type Line, fit } from '../cells.ts';
import { blank, label } from '../parts.ts';

const KEYS: Array<[string, string]> = [
	['j k  ↓ ↑', 'move the selection, or scroll'],
	['pageup pagedown', 'move or scroll five at a time'],
	[
		'enter',
		'answer the selected question · open a task · open health for a problem',
	],
	['o', 'open the selected task'],
	['a  x', 'act on or ignore an observed match'],
	[
		's s',
		'stop the selected task; the first press asks, any other key cancels',
	],
	['/  i', 'write · start with @handle to message a task'],
	['r', 'resume failed tasks, on the health screen'],
	['h', 'health'],
	['?', 'keys and the river'],
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
	lines.push(
		{
			segs: [
				{ t: fit('while typing', 18), fg: 'fg', b: true },
				{
					t: 'enter sends · esc cancels · backspace deletes · ctrl-u clears the line',
					fg: 'dim',
				},
			],
		},
		blank(false),
		label('THE RIVER'),
		{
			segs: [
				{ t: 'The dotted line on the left shows events arriving.', fg: 'dim' },
			],
		},
		{
			segs: [
				{
					t: 'A drop that stops at a task is a follow-up that went straight to it.',
					fg: 'dim',
				},
			],
		},
		{
			segs: [
				{
					t: 'A drop that falls to the Router line is a new request, and a drop that fades out was filtered.',
					fg: 'dim',
				},
			],
		},
	);
	return lines;
}
