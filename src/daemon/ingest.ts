import type { RoutedEvent } from '../protocol.ts';
import {
	type Daemon,
	MESSAGE_COLUMNS,
	type MessageRow,
	type Params,
	cut,
	health,
	routerChanged,
	toMessage,
} from './state.ts';
import { publishTask } from './task-feed.ts';

const PREVIEW_CHARS = 80;

export type InboundEvent = {
	channel: 'console' | 'script' | 'internal';
	/** The dedupe key; the request ID for console actions. */
	externalId: string | null;
	thread: {
		id: string;
		title: string;
		url: string | null;
		ownable: boolean;
	} | null;
	kind: string;
	author: { name: string; id: string | null; isBot: boolean; isSelf: boolean };
	text: string;
	/** Addressed to the agent explicitly. */
	mentionsAgent: boolean;
	data?: Record<string, unknown>;
	/** Set for notes, answers and internal events. */
	taskId?: number;
};

type Decision =
	| { route: 'router' }
	| { route: 'task'; taskId: number }
	| { route: 'filtered'; reason: string };

const PEOPLE_KINDS = new Set(['message', 'note', 'answer']);

/** Internal events from Workers, addressed to the Router. */
export const ROUTER_KINDS = new Set([
	'task_finished',
	'task_failed',
	'task_stopped',
	'task_question',
	'task_report',
	'thread_released',
	'question_answered',
]);

/**
 * Stores an event and decides where it goes in one transaction, then publishes
 * it. Returns the `seq` of the last feed update, or `null` when the event was
 * already stored.
 */
export function ingest(daemon: Daemon, event: InboundEvent): number | null {
	const { db } = daemon;
	const at = Date.now();

	const stored = db.transaction(() => {
		if (event.externalId !== null) {
			const duplicate = db
				.query<unknown, Params>(
					'SELECT 1 FROM events WHERE channel = $channel AND external_id = $externalId',
				)
				.get({ channel: event.channel, externalId: event.externalId });
			if (duplicate) return null;
		}

		const owner = event.thread
			? (db
					.query<{ owner: number | null }, Params>(
						`INSERT INTO threads (id, channel, title, url, ownable, created_at, last_event_at)
						VALUES ($id, $channel, $title, $url, $ownable, $at, $at)
						ON CONFLICT (id) DO UPDATE SET
							title = excluded.title, url = excluded.url, last_event_at = excluded.last_event_at
						RETURNING owner_task_id AS owner`,
					)
					.get({
						id: event.thread.id,
						channel: event.channel,
						title: event.thread.title,
						url: event.thread.url,
						ownable: event.thread.ownable ? 1 : 0,
						at,
					})?.owner ?? null)
			: null;

		// Worker reports skip the table. The Fast Path filter (rule 4) arrives
		// with the script channel; the console has none.
		const decision: Decision =
			event.channel === 'internal' && ROUTER_KINDS.has(event.kind)
				? { route: 'router' }
				: event.author.isSelf
					? { route: 'filtered', reason: 'own message' }
					: event.taskId !== undefined
						? { route: 'task', taskId: event.taskId }
						: owner !== null
							? { route: 'task', taskId: owner }
							: { route: 'router' };
		// For reports to the Router, the reporting task.
		const taskId =
			decision.route === 'task' ? decision.taskId : (event.taskId ?? null);

		const eventId = Number(
			db
				.query<unknown, Params>(
					`INSERT INTO events (received_at, channel, external_id, thread_id, kind, author,
						author_id, is_bot, text, data, route, task_id, filter_reason)
					VALUES ($at, $channel, $externalId, $threadId, $kind, $author,
						$authorId, $isBot, $text, $data, $route, $taskId, $filterReason)`,
				)
				.run({
					at,
					channel: event.channel,
					externalId: event.externalId,
					threadId: event.thread?.id ?? null,
					kind: event.kind,
					author: event.author.name,
					authorId: event.author.id,
					isBot: event.author.isBot ? 1 : 0,
					text: event.text,
					data: event.data ? JSON.stringify(event.data) : null,
					route: decision.route,
					taskId,
					filterReason: decision.route === 'filtered' ? decision.reason : null,
				}).lastInsertRowid,
		);

		let message: MessageRow | null = null;
		if (
			event.channel !== 'internal' &&
			!event.author.isSelf &&
			PEOPLE_KINDS.has(event.kind)
		) {
			const messageId = db
				.query<unknown, Params>(
					`INSERT INTO messages (at, channel, thread_id, task_id, direction, author, text,
						event_id, delivery)
					VALUES ($at, $channel, $threadId, $taskId, 'in', $author, $text, $eventId, 'delivered')`,
				)
				.run({
					at,
					channel: event.channel,
					threadId: event.thread?.id ?? null,
					taskId: event.taskId ?? null,
					author: event.author.name,
					text: event.text,
					eventId,
				}).lastInsertRowid;
			message = db
				.query<MessageRow, [number]>(`SELECT ${MESSAGE_COLUMNS} WHERE m.id = ?`)
				.get(Number(messageId));
		}

		// A person's message to a task with an open question answers it.
		let answered = false;
		if (
			decision.route === 'task' &&
			event.channel !== 'internal' &&
			PEOPLE_KINDS.has(event.kind)
		) {
			answered =
				db
					.query<unknown, Params>(
						`UPDATE questions SET state = 'answered', answer = $text, answered_by = $by,
							answered_at = $at, answer_event_id = $eventId
						WHERE task_id = $taskId AND state = 'open'`,
					)
					.run({
						text: event.text,
						by: `${event.author.name} (${event.channel})`,
						at,
						eventId,
						taskId: decision.taskId,
					}).changes > 0;
			if (answered) {
				db.query<unknown, [number, number]>(
					"UPDATE tasks SET state = 'active', updated_at = ? WHERE id = ? AND state = 'needs_you'",
				).run(at, decision.taskId);
			}
		}

		const handle =
			taskId === null
				? null
				: (db
						.query<{ handle: string }, [number]>(
							'SELECT handle FROM tasks WHERE id = ?',
						)
						.get(taskId)?.handle ?? null);
		return { eventId, decision, handle, message, answered };
	})();

	if (stored === null) {
		daemon.log('info', 'duplicate event ignored', {
			channel: event.channel,
			externalId: event.externalId,
		});
		return null;
	}

	const { eventId, decision, handle, message, answered } = stored;
	daemon.log('info', 'event routed', {
		event: eventId,
		channel: event.channel,
		kind: event.kind,
		thread: event.thread?.id ?? null,
		route: decision.route,
		...(handle === null ? {} : { task: handle }),
		...(decision.route === 'filtered' ? { reason: decision.reason } : {}),
	});

	if (decision.route === 'router') daemon.router.wake();
	if (decision.route === 'task') daemon.runWorker(decision.taskId);

	// The river shows only what arrives from outside.
	if (event.channel === 'internal') {
		return decision.route === 'router'
			? routerChanged(daemon)
			: daemon.feed.seq;
	}

	const { feed } = daemon;
	const destination: RoutedEvent['destination'] =
		decision.route === 'filtered'
			? { kind: 'filtered', reason: decision.reason }
			: decision.route === 'task'
				? { kind: 'task', handle: handle ?? `#${decision.taskId}` }
				: { kind: 'router' };
	feed.publish({
		type: 'routed',
		event: {
			id: eventId,
			at,
			channel: event.channel,
			threadTitle: event.thread?.title ?? null,
			author: event.author.name,
			preview: cut(event.text, PREVIEW_CHARS),
			destination,
		},
	});
	if (message) feed.publish({ type: 'message', message: toMessage(message) });
	if (answered && decision.route === 'task') {
		publishTask(daemon, decision.taskId);
	}
	if (decision.route === 'router') routerChanged(daemon);
	daemon.channels.set(event.channel, at);
	return feed.publish({ type: 'health', health: health(daemon) });
}
