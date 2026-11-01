import type { Message, Step, TaskSummary } from '../../protocol.ts';
import { type Line, type Seg, fit, wrap } from '../cells.ts';
import { diffLines } from '../diff.ts';
import { ago, clock, duration } from '../format.ts';
import { markdown } from '../markdown.ts';
import type { Live } from '../model.ts';
import {
	MEASURE,
	blank,
	chip,
	label,
	oneLine,
	sep,
	spinner,
} from '../parts.ts';
import { type Ui, mergedSteps } from '../state.ts';

export function taskBody(
	live: Live,
	ui: Ui,
	handle: string,
	content: number,
	now: number,
): { lines: Line[]; animating: boolean } {
	const state = ui.details.get(handle);
	const detail = state?.detail ?? null;
	const task = live.tasks.get(handle) ?? detail?.task;
	if (!task) {
		return {
			lines: [
				{
					segs: [
						{
							t: `No task ${handle} in the agent's current state.`,
							fg: 'faint',
						},
					],
				},
			],
			animating: false,
		};
	}
	const measure = Math.min(MEASURE, content);
	const steps = mergedSteps(detail, live.steps.get(handle));
	const lines: Line[] = [statusLine(task, now), blank()];
	let animating = task.status === 'working';

	if (task.status === 'needs_you' && task.question) {
		lines.push(label('QUESTION'));
		wrap(
			[{ t: oneLine(task.question.text), fg: 'fg', i: true }],
			measure - 4,
			3,
		).forEach((segs, index) => {
			lines.push({
				segs: [{ t: index === 0 ? '  └ ' : '    ', fg: 'ghost' }, ...segs],
			});
		});
		if (task.question.options && task.question.options.length > 0) {
			lines.push({
				segs: [
					{ t: '    ' },
					...task.question.options.flatMap((option, index) => [
						...(index > 0 ? [sep] : []),
						{ t: oneLine(option), fg: 'dim' } satisfies Seg,
					]),
				],
			});
		}
		if (task.question.context) {
			lines.push(blank());
			for (const line of markdown(task.question.context, measure - 4)) {
				lines.push({ ...line, segs: [{ t: '    ' }, ...line.segs] });
			}
		}
		lines.push(blank());
	}

	if (task.status === 'working' && task.now) {
		lines.push(label('NOW'));
		lines.push({
			segs: [
				{ t: `${spinner(now)} `, fg: 'accent' },
				task.now.command
					? chip(oneLine(task.now.command))
					: { t: oneLine(task.now.text), fg: 'fg' },
			],
			right: [{ t: duration(now - task.now.startedAt), fg: 'faint' }],
		});
		lines.push(blank());
	} else if (task.status === 'waiting') {
		lines.push(label('NOW'));
		lines.push({
			segs: [
				{ t: '◌ ', fg: 'faint' },
				{ t: `waiting on ${task.waitingOn ?? 'a message'}`, fg: 'fg' },
			],
		});
		lines.push(blank());
	}

	if (steps.length > 0) {
		lines.push(label('STEPS'));
		for (const step of steps) {
			if (step.status === 'running') animating = true;
			lines.push(stepRow(step, now));
			const diff = step.hasDiff ? state?.diffs.get(step.id) : undefined;
			if (typeof diff === 'string') lines.push(...diffLines(diff, content));
		}
		lines.push(blank());
	}

	if (detail?.report) {
		lines.push(label('REPORT'));
		lines.push(...markdown(detail.report, measure));
		lines.push(blank());
	}

	const conversation = mergedConversation(
		live,
		handle,
		detail?.seq ?? null,
		detail?.conversation ?? [],
	);
	if (conversation.length > 0) {
		lines.push(
			label(
				'CONVERSATION',
				undefined,
				'every thread this task follows, one timeline',
			),
		);
		for (const message of conversation)
			lines.push(...messageRows(message, measure));
	}

	while (lines.at(-1)?.segs.length === 0) lines.pop();
	return { lines, animating };
}

function statusLine(task: TaskSummary, now: number): Line {
	const words: Record<TaskSummary['status'], string> = {
		working: 'working',
		waiting: `waiting on ${task.waitingOn ?? 'a message'}`,
		needs_you: 'needs you',
		done: 'done',
		failed: 'failed',
		stopped: 'stopped',
	};
	const segs: Seg[] = [
		{ t: words[task.status], fg: 'faint' },
		sep,
		{
			t: `started ${ago(now - (task.startedAt ?? task.createdAt))}`,
			fg: 'faint',
		},
	];
	if (task.endedAt !== null)
		segs.push(sep, { t: `ended ${clock(task.endedAt)}`, fg: 'faint' });
	if (
		(task.status === 'done' ||
			task.status === 'failed' ||
			task.status === 'stopped') &&
		task.result
	) {
		segs.push(sep, { t: oneLine(task.result), fg: 'faint' });
	}
	if (task.threads.length > 0) {
		segs.push(sep, { t: 'follows ', fg: 'faint' });
		task.threads.forEach((thread, index) => {
			if (index > 0) segs.push({ t: ' and ', fg: 'faint' });
			const name =
				thread.channel === thread.title
					? thread.title
					: `${thread.channel} ${thread.title}`;
			segs.push({
				t: oneLine(name),
				fg: 'faint',
				...(thread.url ? { link: thread.url } : {}),
			});
		});
	}
	return { segs };
}

function stepRow(step: Step, now: number): Line {
	const glyph: Seg =
		step.status === 'running'
			? { t: `${spinner(now)} `, fg: 'accent' }
			: step.status === 'ok'
				? { t: '✓ ', fg: 'ok' }
				: step.status === 'failed'
					? { t: '✗ ', fg: 'err' }
					: { t: '– ', fg: 'faint' };
	const text =
		step.kind === 'command' ? (step.command ?? step.text) : step.text;
	const segs: Seg[] = [
		glyph,
		{ t: oneLine(text), fg: step.status === 'running' ? 'fg' : 'dim' },
	];
	if (step.additions !== null || step.deletions !== null) {
		segs.push(
			{ t: '  ' },
			{ t: `+${step.additions ?? 0}`, fg: 'ok' },
			{ t: ' ' },
			{ t: `−${step.deletions ?? 0}`, fg: 'err' },
		);
	}
	if (step.status === 'failed' && step.exitCode !== null) {
		segs.push(sep, { t: `exit ${step.exitCode}`, fg: 'faint' });
	}
	return {
		segs,
		right: [
			{ t: duration((step.endedAt ?? now) - step.startedAt), fg: 'faint' },
		],
	};
}

function mergedConversation(
	live: Live,
	handle: string,
	detailSeq: number | null,
	base: Message[],
): Message[] {
	const byId = new Map<number, Message>();
	for (const message of base) byId.set(message.id, message);
	for (const { message, seq } of live.messages.get(handle)?.values() ?? []) {
		if (detailSeq === null || seq > detailSeq) byId.set(message.id, message);
	}
	return [...byId.values()].toSorted((a, b) => a.id - b.id);
}

function messageRows(message: Message, measure: number): Line[] {
	const room = Math.max(1, measure - 22);
	const text = wrap([{ t: message.text, fg: 'fg' }], room, 12);
	return text.map((segs, index) => ({
		segs:
			index === 0
				? [
						{ t: `${clock(message.at)}  `, fg: 'faint' },
						{ t: fit(message.channel, 8), fg: 'faint' },
						{
							t: fit(message.author, 7),
							fg: message.author === 'you' ? 'accent' : 'dim',
						},
						...segs,
					]
				: [{ t: ' '.repeat(22) }, ...segs],
	}));
}
