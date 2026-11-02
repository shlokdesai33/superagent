import type { Health } from '../../protocol.ts';
import { type Line, type Seg, fit, truncate, wrap } from '../cells.ts';
import { ago, clock, plural, tokens } from '../format.ts';
import type { Live } from '../model.ts';
import { MEASURE, blank, figure, label, oneLine, sep } from '../parts.ts';

const BAR = 32;

const PROACTIVE: Record<Health['proactive'], string> = {
	off: 'only messages for the agent are handled',
	observe: 'matches are listed under OBSERVED without acting',
	act: 'matches are acted on',
};

const SANDBOX: Record<Health['sandbox'], string> = {
	off: 'commands run unsandboxed',
	on: 'commands write only inside their task',
	unavailable: 'the sandbox is unavailable',
};

export function healthBody(live: Live, content: number, now: number): Line[] {
	const { health, usage } = live;
	const measure = Math.min(MEASURE, content);
	const failed = [...live.tasks.values()].filter(
		(task) => task.status === 'failed' && !task.dismissed,
	);
	const problems = health.problems.length + failed.length;
	const up = health.channels.filter((channel) => channel.state === 'up').length;
	const summary: Seg[] = [
		...(problems === 0
			? [
					{ t: '● ', fg: 'ok' } satisfies Seg,
					{ t: 'All healthy', fg: 'fg', b: true } satisfies Seg,
				]
			: [
					{ t: '! ', fg: 'warn', b: true } satisfies Seg,
					{
						t: `${problems} ${plural(problems, 'problem')}`,
						fg: 'fg',
						b: true,
					} satisfies Seg,
				]),
		sep,
		{
			t: `${up} of ${health.channels.length} ${plural(health.channels.length, 'channel')} up`,
			fg: 'faint',
		},
		sep,
		{
			t:
				failed.length === 0
					? 'no failed tasks'
					: `${failed.length} failed ${plural(failed.length, 'task')}`,
			fg: 'faint',
		},
	];
	const lines: Line[] = [{ segs: summary }, blank()];

	if (problems > 0) {
		lines.push(label('PROBLEMS'));
		for (const problem of health.problems.toSorted(
			(a, b) => a.since - b.since,
		)) {
			lines.push({
				segs: [
					{ t: '! ', fg: 'warn', b: true },
					{ t: oneLine(problem.text), fg: 'fg' },
				],
				right: [{ t: ago(now - problem.since), fg: 'faint' }],
			});
			if (problem.fix) {
				for (const segs of wrap(
					[
						{ t: 'fix: ', fg: 'faint' },
						{ t: problem.fix, fg: 'dim' },
					],
					measure - 2,
				)) {
					lines.push({ segs: [{ t: '  ' }, ...segs] });
				}
			}
		}
		for (const task of failed) {
			lines.push({
				segs: [
					{ t: '✗ ', fg: 'err' },
					{ t: fit(task.handle, 6), fg: 'dim' },
					{ t: oneLine(task.title), fg: 'fg' },
				],
				right: truncate(
					[{ t: oneLine(task.result ?? 'failed'), fg: 'faint' }],
					Math.floor(content / 2),
				),
			});
		}
		lines.push(blank());
	}

	lines.push(label('CHANNELS'));
	for (const channel of health.channels) {
		const dot: Seg =
			channel.state === 'up'
				? { t: '● ', fg: 'ok' }
				: channel.state === 'down'
					? { t: '● ', fg: 'err' }
					: { t: '○ ', fg: 'faint' };
		const words =
			channel.state === 'up'
				? `connected · ${channel.lastEventAt === null ? 'no events yet' : `last event ${ago(now - channel.lastEventAt)}`}`
				: channel.state === 'down'
					? 'disconnected'
					: 'connecting';
		lines.push({
			segs: [
				dot,
				{ t: fit(channel.name, 12), fg: 'fg' },
				{ t: words, fg: 'faint' },
				...(channel.detail
					? [sep, { t: oneLine(channel.detail), fg: 'faint' } satisfies Seg]
					: []),
			],
		});
	}
	lines.push(blank());

	const { model } = health;
	lines.push(label('MODEL'));
	lines.push({
		segs: [
			model.state === 'ok'
				? { t: '● ', fg: 'ok' }
				: { t: '● ', fg: model.state === 'paused' ? 'warn' : 'err' },
			{ t: fit(model.name, 12), fg: 'fg' },
			{ t: model.state === 'ok' ? 'ready' : model.state, fg: 'faint' },
			...(model.detail
				? [sep, { t: oneLine(model.detail), fg: 'faint' } satisfies Seg]
				: []),
			...(model.since !== null && model.state !== 'ok'
				? [sep, { t: `since ${clock(model.since)}`, fg: 'faint' } satisfies Seg]
				: []),
		],
	});
	lines.push(blank());

	const peak = Math.max(usage.inputTokens, usage.outputTokens);
	const cachedShare =
		usage.inputTokens === 0
			? 0
			: Math.round((usage.cachedTokens / usage.inputTokens) * 100);
	lines.push(label('USAGE TODAY'));
	lines.push({
		segs: [
			{ t: fit('input', 12), fg: 'dim' },
			...bar(
				peak === 0 ? 0 : usage.inputTokens / peak,
				peak === 0 ? 0 : usage.cachedTokens / peak,
			),
			{ t: '  ' },
			...figure(tokens(usage.inputTokens), 'tokens'),
			sep,
			...figure(`${cachedShare}%`, 'cached'),
		],
	});
	lines.push({
		segs: [
			{ t: fit('output', 12), fg: 'dim' },
			...bar(peak === 0 ? 0 : usage.outputTokens / peak, 0),
			{ t: '  ' },
			...figure(tokens(usage.outputTokens), 'tokens'),
			sep,
			...figure(String(usage.calls), `model ${plural(usage.calls, 'call')}`),
		],
	});
	lines.push({
		segs: [
			{ t: fit('cost', 12), fg: 'dim' },
			...figure(`$${usage.costUsd.toFixed(2)}`, 'estimated'),
		],
	});
	lines.push(blank());

	const tools = Object.entries(health.machine.tools);
	const found = tools.filter(([, present]) => present).map(([tool]) => tool);
	const missing = tools.filter(([, present]) => !present).map(([tool]) => tool);
	lines.push(label('THIS MACHINE'));
	const machine: Seg[] = [
		{ t: `${health.machine.os} ${health.machine.arch}`, fg: 'fg' },
		...(found.length > 0
			? [sep, { t: `${found.join(', ')} available`, fg: 'faint' } satisfies Seg]
			: []),
		...(missing.length > 0
			? [
					sep,
					{
						t: `${missing.join(', ')} not installed`,
						fg: 'faint',
					} satisfies Seg,
				]
			: []),
		sep,
		{ t: SANDBOX[health.sandbox], fg: 'faint' },
	];
	for (const segs of wrap(machine, measure)) lines.push({ segs });
	lines.push(blank());

	lines.push(label('PROACTIVE WORK'));
	lines.push({
		segs: [
			{ t: 'mode: ', fg: 'faint' },
			{ t: health.proactive, fg: 'fg' },
			sep,
			{ t: PROACTIVE[health.proactive], fg: 'faint' },
		],
	});
	return lines;
}

/** `━` in `accent` on a `─` track, with the cached share in `dim`. */
function bar(fill: number, cached: number): Seg[] {
	const filled = Math.round(Math.min(1, fill) * BAR);
	const cachedCells = Math.min(filled, Math.round(Math.min(1, cached) * BAR));
	return [
		{ t: '━'.repeat(filled - cachedCells), fg: 'accent' },
		{ t: '━'.repeat(cachedCells), fg: 'dim' },
		{ t: '─'.repeat(BAR - filled), fg: 'ghost' },
	];
}
