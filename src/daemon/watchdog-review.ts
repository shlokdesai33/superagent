import type { Database } from 'bun:sqlite';
import { ModelError, callModel } from './model.ts';
import { redact } from './secrets.ts';
import { type Daemon, cut } from './state.ts';
import {
	ToolError,
	limitedString,
	parseArgs,
	requiredString,
	string,
	tool,
} from './tool-args.ts';

const EFFORT = 'low';
const MAX_COMPLETION_TOKENS = 2_000;
const INSTRUCTION_CHARS = 2_000;
const STEPS_SHOWN = 30;
const STEP_CHARS = 200;
const REASON_CHARS = 200;
const ADVICE_CHARS = 300;
// The Worker's recent assistant items searched for repeated tool calls.
const RECENT_ITEMS = 20;

const VERDICTS = ['progressing', 'stuck', 'looping', 'off_goal'] as const;
export type Verdict = {
	verdict: (typeof VERDICTS)[number];
	reason: string;
	advice: string;
};

const VERDICT_TOOL = tool(
	'verdict',
	'Your judgment of the Worker: whether it is making real progress on its task.',
	{
		verdict: {
			type: 'string',
			enum: [...VERDICTS],
			description:
				'progressing: getting closer to the goal. stuck: not getting anywhere. looping: repeating itself. off_goal: working on something other than the task.',
		},
		reason: string(`Why, for the operator; at most ${REASON_CHARS} characters`),
		advice: string(
			`What the Worker should do differently, written to it; at most ${ADVICE_CHARS} characters`,
		),
	},
	['verdict', 'reason', 'advice'],
);

const SYSTEM_PROMPT = `You check whether an AI coding Worker is making real progress on its task. You see its task and its recent steps since it last made progress: the commands it ran with their results, the files it edited, and its own one-line notes.

- Progress means getting closer to the task's goal, not activity.
- Repeating a command or a tool call without changing anything in between is looping.
- Investigating, reading and testing are progress when each step learns something new.
- Working on something the task didn't ask for is off goal.
- Answer only by calling verdict. When you're unsure, say progressing.`;

/** The tool calls the Worker made in its current episode, more than once. */
export function repeatedCalls(
	db: Database,
	taskId: number,
	since: number,
): Array<{ call: string; count: number }> {
	const counts = new Map<string, number>();
	for (const { item } of db
		.query<{ item: string }, [number, number, number]>(
			`SELECT i.item FROM session_items i JOIN sessions s ON s.id = i.session_id
			WHERE s.task_id = ? AND i.at >= ? AND json_extract(i.item, '$.role') = 'assistant'
			ORDER BY i.seq DESC LIMIT ?`,
		)
		.all(taskId, since, RECENT_ITEMS)) {
		const parsed: unknown = JSON.parse(item);
		const calls =
			typeof parsed === 'object' &&
			parsed !== null &&
			'tool_calls' in parsed &&
			Array.isArray(parsed.tool_calls)
				? parsed.tool_calls
				: [];
		for (const call of calls) {
			const fn: unknown =
				typeof call === 'object' && call !== null && 'function' in call
					? call.function
					: null;
			if (
				typeof fn !== 'object' ||
				fn === null ||
				!('name' in fn) ||
				typeof fn.name !== 'string'
			) {
				continue;
			}
			const args =
				'arguments' in fn && typeof fn.arguments === 'string'
					? fn.arguments
					: '';
			const key = `${fn.name} ${args}`;
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
	}
	return [...counts]
		.filter(([, count]) => count > 1)
		.map(([call, count]) => ({ call, count }))
		.toSorted((a, b) => b.count - a.count);
}

type ReviewedTask = {
	id: number;
	handle: string;
	title: string;
	instructions: string;
	idle: number;
	since: number;
};

/**
 * One stateless call asking whether the task's Worker is getting anywhere.
 * `null` when the call failed or its answer wasn't a valid verdict.
 */
export async function reviewTask(
	daemon: Daemon,
	task: ReviewedTask,
	trigger: string,
	signal: AbortSignal,
): Promise<Verdict | null> {
	const input = redact(daemon.secrets, reviewInput(daemon.db, task, trigger));
	let result: Awaited<ReturnType<typeof callModel>>;
	try {
		result = await callModel(daemon, {
			sessionId: null,
			taskId: task.id,
			purpose: 'watchdog',
			signal,
			request: {
				reasoning_effort: EFFORT,
				max_completion_tokens: MAX_COMPLETION_TOKENS,
				prompt_cache_key: 'watchdog',
				tools: [VERDICT_TOOL],
				messages: [
					{ role: 'system', content: SYSTEM_PROMPT },
					{ role: 'user', content: input },
				],
			},
		});
	} catch (error) {
		if (signal.aborted) return null;
		daemon.log('warn', 'watchdog review failed', {
			task: task.handle,
			error:
				error instanceof ModelError
					? error.message
					: error instanceof Error
						? error.message
						: String(error),
		});
		return null;
	}
	const call = result.message.tool_calls?.find(
		(candidate) => candidate.function.name === 'verdict',
	);
	if (!call) {
		daemon.log('warn', 'watchdog review gave no verdict', {
			task: task.handle,
		});
		return null;
	}
	try {
		const args = parseArgs(call.function.arguments);
		const verdict = requiredString(args, 'verdict');
		const known = VERDICTS.find((name) => name === verdict);
		if (!known) throw new ToolError(`unknown verdict ${verdict}`);
		return {
			verdict: known,
			reason: cut(limitedString(args, 'reason', 10_000), REASON_CHARS),
			advice: cut(limitedString(args, 'advice', 10_000), ADVICE_CHARS),
		};
	} catch (error) {
		daemon.log('warn', 'watchdog review gave an invalid verdict', {
			task: task.handle,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function reviewInput(
	db: Database,
	task: ReviewedTask,
	trigger: string,
): string {
	const steps = db
		.query<
			{
				kind: string;
				text: string;
				status: string;
				exitCode: number | null;
			},
			[number, number, number]
		>(
			`SELECT kind, text, status, exit_code AS exitCode FROM steps
			WHERE task_id = ? AND COALESCE(ended_at, started_at) >= ?
			ORDER BY id DESC LIMIT ?`,
		)
		.all(task.id, task.since, STEPS_SHOWN)
		.toReversed();
	const counts = db
		.query<
			{ edits: number; commands: number; failed: number },
			[number, number]
		>(
			`SELECT COALESCE(SUM(kind = 'edit'), 0) AS edits,
				COALESCE(SUM(kind = 'command'), 0) AS commands,
				COALESCE(SUM(kind = 'command' AND status = 'failed'), 0) AS failed
			FROM steps WHERE task_id = ? AND COALESCE(ended_at, started_at) >= ?`,
		)
		.get(task.id, task.since) ?? { edits: 0, commands: 0, failed: 0 };
	const minutes = Math.max(0, Math.round((Date.now() - task.since) / 60_000));
	const repeated = repeatedCalls(db, task.id, task.since);
	return [
		`Task ${task.handle}: ${task.title}`,
		`Instructions:\n${cut(task.instructions, INSTRUCTION_CHARS)}`,
		`Why you're asked: ${trigger}.`,
		`Since its last progress: ${task.idle} model calls over ${minutes} min, ${counts.edits} edits, ${counts.commands} commands (${counts.failed} failed).`,
		steps.length === 0
			? 'Its steps since then: none.'
			: `Its last ${steps.length} steps, oldest first:\n${steps
					.map(
						(step) =>
							`- ${step.kind} · ${step.status}${step.exitCode === null ? '' : ` · exit ${step.exitCode}`} · ${cut(step.text, STEP_CHARS)}`,
					)
					.join('\n')}`,
		repeated.length === 0
			? 'No tool call repeated.'
			: `Repeated tool calls:\n${repeated
					.slice(0, 5)
					.map(
						(entry) => `- ${entry.count} times: ${cut(entry.call, STEP_CHARS)}`,
					)
					.join('\n')}`,
	].join('\n\n');
}
