import type { FeedLine, FeedUpdate, Snapshot } from '../protocol.ts';
import type { Log } from './log.ts';

// Under Bun's 10 s idle timeout: Bun 1.4.4 ignores per-request timeouts on Unix-socket servers.
const PING_INTERVAL_MS = 5_000;
// A client this far behind isn't reading; dropping it makes it reconnect to a
// fresh snapshot instead of the daemon buffering forever.
const MAX_QUEUED_LINES = 10_000;

type Unsequenced<T> = T extends unknown ? Omit<T, 'seq'> : never;

export type Feed = {
	/** The sequence of the last update published. */
	readonly seq: number;
	/** Call only after the change's transaction has committed. Returns its `seq`. */
	publish(update: Unsequenced<FeedUpdate>): number;
	/** A new NDJSON stream that starts with a snapshot. */
	open(): ReadableStream<Uint8Array>;
	/** Ends every stream and stops the timers. */
	close(): void;
};

type Subscriber = ReadableStreamDefaultController<Uint8Array>;

/**
 * `snapshot` must build the whole state synchronously, so the snapshot sent at
 * sequence S reflects every update up to S and none after it.
 */
export function createFeed(snapshot: () => Snapshot, log: Log): Feed {
	const subscribers = new Set<Subscriber>();
	const encoder = new TextEncoder();
	let seq = 0;

	const send = (subscriber: Subscriber, line: FeedLine) => {
		try {
			subscriber.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
		} catch {
			subscribers.delete(subscriber);
			return;
		}
		if ((subscriber.desiredSize ?? 0) < -MAX_QUEUED_LINES) {
			log('warn', 'dropping a feed client that stopped reading');
			subscribers.delete(subscriber);
			subscriber.error(new Error('feed client too slow'));
		}
	};
	const broadcast = (line: () => FeedLine) => {
		if (subscribers.size === 0) return;
		const value = line();
		for (const subscriber of subscribers) send(subscriber, value);
	};

	const ping = setInterval(() => {
		broadcast(() => ({ type: 'ping', now: Date.now() }));
	}, PING_INTERVAL_MS);

	// A fresh snapshot at local midnight resets DONE TODAY and today's usage.
	let midnight: Timer;
	const scheduleMidnight = () => {
		const next = new Date();
		next.setHours(24, 0, 0, 0);
		midnight = setTimeout(() => {
			broadcast(() => ({ type: 'snapshot', seq, snapshot: snapshot() }));
			scheduleMidnight();
		}, next.getTime() - Date.now());
	};
	scheduleMidnight();

	return {
		get seq() {
			return seq;
		},
		publish(update) {
			seq += 1;
			// `type` and `seq` first, as people read the lines too.
			const line: FeedUpdate = Object.assign(
				{ type: update.type, seq },
				update,
			);
			for (const subscriber of subscribers) send(subscriber, line);
			return seq;
		},
		open() {
			let subscriber: Subscriber;
			return new ReadableStream<Uint8Array>({
				start(controller) {
					subscriber = controller;
					subscribers.add(controller);
					send(controller, { type: 'snapshot', seq, snapshot: snapshot() });
				},
				cancel() {
					subscribers.delete(subscriber);
				},
			});
		},
		close() {
			clearInterval(ping);
			clearTimeout(midnight);
			for (const subscriber of subscribers) {
				try {
					subscriber.close();
				} catch {
					// Already closed by the client.
				}
			}
			subscribers.clear();
		},
	};
}
