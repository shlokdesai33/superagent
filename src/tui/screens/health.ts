import type { Health } from '../../protocol.ts';
import { type Line, type Seg, fit, hang, width, wrap } from '../cells.ts';
import { ago, clock, plural, tokens } from '../format.ts';
import type { Live } from '../model.ts';
import {
	MEASURE,
	blank,
	figure,
	label,
	oneLine,
	paragraphs,
	sep,
} from '../parts.ts';

const BAR = 32;

const KEY: Record<Health['model']['key'], string | null> = {
	env: 'from PARTICLE_API_KEY',
	file: null,
	missing: 'missing · run superagent login particle',
};

export function healthBody(live: Live, content: number, now: number): Line[] {
	const { health, usage } = live;
	const measure = Math.min(MEASURE, content);
	const failed = [...live.tasks.values()].filter(
		(task) => task.status === 'failed' && !task.dismissed,
	);
	const problems = health.problems.length + failed.length;
	// Channels that are off are optional extras, not part of the count.
	const active = health.channels.filter((channel) => channel.state !== 'off');
	const up = active.filter((channel) => channel.state === 'up').length;
	const summary: Seg[] =
		problems === 0
			? [
					{ t: '● ', fg: 'ok' },
					{ t: 'All healthy', fg: 'fg', b: true },
				]
			: [
					{ t: '! ', fg: 'warn', b: true },
					{
						t: `${problems} ${plural(problems, 'problem')}`,
						fg: 'fg',
						b: true,
					},
				];
	if (up < active.length) {
		summary.push(sep, {
			t: `${up} of ${active.length} ${plural(active.length, 'channel')} up`,
			fg: 'faint',
		});
	}
	if (failed.length > 0) {
		summary.push(sep, {
			t: `${failed.length} failed ${plural(failed.length, 'task')}`,
			fg: 'faint',
		});
	}
	const lines: Line[] = [
		...wrap(summary, content).map((segs) => ({ segs })),
		blank(),
	];

	if (problems > 0) {
		lines.push(label('PROBLEMS'));
		for (const problem of health.problems.toSorted(
			(a, b) => a.since - b.since,
		)) {
			lines.push(
				...hang(
					[{ t: '! ', fg: 'warn', b: true }],
					[{ t: paragraphs(problem.text), fg: 'fg' }],
					content,
					[{ t: ago(now - problem.since), fg: 'faint' }],
				),
			);
			if (problem.fix) lines.push(...fixLines(problem.fix, measure));
		}
		for (const task of failed) {
			const prefix: Seg[] = [
				{ t: '✗ ', fg: 'err' },
				{ t: fit(task.handle, 6), fg: 'dim' },
			];
			const title: Seg = { t: oneLine(task.title), fg: 'fg' };
			const result: Seg = {
				t: oneLine(task.result ?? 'failed'),
				fg: 'faint',
			};
			// The result sits on the right while both fit, else wraps after the title.
			lines.push(
				...(width([...prefix, title]) + 2 + width([result]) <= content
					? [{ segs: [...prefix, title], right: [result] }]
					: hang(prefix, [title, sep, result], content)),
			);
		}
		lines.push(blank());
	}

	if (health.warnings.length > 0) {
		lines.push(label('WARNINGS'));
		for (const warning of health.warnings) {
			lines.push(
				...hang(
					[{ t: '· ', fg: 'warn' }],
					[{ t: paragraphs(warning.text), fg: 'fg' }],
					content,
				),
			);
			if (warning.fix) lines.push(...fixLines(warning.fix, measure));
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
				? `connected${channel.lastEventAt === null ? '' : ` · last event ${ago(now - channel.lastEventAt)}`}`
				: channel.state === 'down'
					? 'disconnected'
					: channel.state === 'off'
						? 'off'
						: 'connecting';
		lines.push(
			...hang(
				[
					dot,
					{
						t: fit(channel.name, 12),
						fg: channel.state === 'off' ? 'faint' : 'fg',
					},
				],
				[
					{ t: words, fg: 'faint' },
					...(channel.detail
						? [sep, { t: oneLine(channel.detail), fg: 'faint' } satisfies Seg]
						: []),
				],
				content,
			),
		);
	}
	lines.push(blank());

	const { model } = health;
	lines.push(label('MODEL'));
	lines.push(
		...hang(
			[
				model.state === 'ok'
					? { t: '● ', fg: 'ok' }
					: { t: '● ', fg: model.state === 'paused' ? 'warn' : 'err' },
				{ t: fit(model.name, 12), fg: 'fg' },
			],
			[
				{ t: model.state === 'ok' ? 'ready' : model.state, fg: 'faint' },
				...(model.detail
					? [sep, { t: oneLine(model.detail), fg: 'faint' } satisfies Seg]
					: []),
				...(model.since !== null && model.state !== 'ok'
					? [
							sep,
							{ t: `since ${clock(model.since)}`, fg: 'faint' } satisfies Seg,
						]
					: []),
			],
			content,
		),
	);
	// Where the key comes from matters only when it's the fix: none, or a
	// PARTICLE_API_KEY that a new saved key wouldn't override.
	const key = KEY[model.key];
	if (key && (model.key === 'missing' || model.state === 'error')) {
		lines.push(
			...hang(
				[{ t: '  ' }, { t: fit('key', 12), fg: 'dim' }],
				[{ t: key, fg: 'faint' }],
				content,
			),
		);
	}
	lines.push(blank());

	const { watchdog } = health;
	// Checks run every minute; one this old means the Watchdog has stalled.
	const late =
		watchdog.lastCheckAt !== null && now - watchdog.lastCheckAt > 3 * 60_000;
	if (late && watchdog.lastCheckAt !== null) {
		lines.push(label('WATCHDOG'));
		lines.push({
			segs: [
				{ t: '● ', fg: 'warn' },
				{ t: `checked ${ago(now - watchdog.lastCheckAt)}`, fg: 'fg' },
			],
		});
		lines.push(blank());
	}

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

	const missing = Object.entries(health.machine.tools)
		.filter(([, present]) => !present)
		.map(([tool]) => tool);
	lines.push(label('THIS MACHINE'));
	const machine: Seg[] = [
		{ t: `${health.machine.os} ${health.machine.arch}`, fg: 'fg' },
		...(missing.length > 0
			? [
					sep,
					{
						t: `${missing.join(', ')} not installed`,
						fg: 'faint',
					} satisfies Seg,
				]
			: []),
	];
	for (const segs of wrap(machine, measure)) lines.push({ segs });
	return lines;
}

/** `fix: …`, wrapped and indented under its problem or warning. */
function fixLines(fix: string, measure: number): Line[] {
	return wrap(
		[
			{ t: 'fix: ', fg: 'faint' },
			{ t: fix, fg: 'dim' },
		],
		measure - 2,
	).map((segs) => ({ segs: [{ t: '  ' }, ...segs] }));
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
