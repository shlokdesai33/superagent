import { DaemonUnreachable, openFeed } from '../client.ts';
import type { FeedLine } from '../protocol.ts';
import type { Connection } from './model.ts';

const RETRY_MS = 1_500;
const SILENCE_MS = 45_000;

type Handlers = {
	line(line: FeedLine): void;
	connection(connection: Connection): void;
};

/** Keeps a feed open, reconnecting on its own. Returns a function that stops it. */
export function connect(handlers: Handlers): () => void {
	let stopped = false;
	let generation = 0;
	let current: AbortController | null = null;
	let retry: Timer | null = null;

	const attempt = async () => {
		const controller = new AbortController();
		current = controller;
		let silent = false;
		let silence: Timer = setTimeout(() => {}, 0);
		const listen = () => {
			clearTimeout(silence);
			silence = setTimeout(() => {
				silent = true;
				controller.abort();
			}, SILENCE_MS);
		};
		let opened = false;
		try {
			listen();
			for await (const line of openFeed(controller.signal)) {
				listen();
				if (!opened) {
					opened = true;
					generation += 1;
					handlers.connection({ state: 'live', generation });
				}
				handlers.line(line);
			}
			if (!stopped) offline('the agent closed the connection');
		} catch (error) {
			if (stopped) return;
			if (silent) offline('no word from the agent for 45 s');
			else if (
				error instanceof DaemonUnreachable &&
				error.kind === 'rejected'
			) {
				handlers.connection({
					state: 'rejected',
					message: error.message,
					detail: error.detail,
				});
			} else if (error instanceof DaemonUnreachable) offline(error.detail);
			else offline(error instanceof Error ? error.message : String(error));
		} finally {
			clearTimeout(silence);
			current = null;
		}
		if (!stopped) {
			retry = setTimeout(() => {
				void attempt();
			}, RETRY_MS);
		}
	};

	const offline = (detail: string) => {
		handlers.connection({ state: 'offline', detail, since: Date.now() });
	};

	void attempt();
	return () => {
		stopped = true;
		if (retry) clearTimeout(retry);
		current?.abort();
	};
}
