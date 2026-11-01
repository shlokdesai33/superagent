// Drives a real daemon end to end (§10): an isolated data folder, the script
// channel, and every request over the Unix socket like the TUI's.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
	type Action,
	type ActionResult,
	type FeedLine,
	PROTOCOL_HEADER,
	PROTOCOL_VERSION,
} from '../src/protocol.ts';

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts');
const WAIT_MS = 15_000;

export type Agent = {
	home: string;
	/** Every feed line so far, oldest first. */
	lines: FeedLine[];
	action(action: Action): Promise<ActionResult>;
	/** `POST /v1/events` on the script channel. */
	event(body: ScriptEvent): Promise<{ seq: number; duplicate: boolean }>;
	get(path: string): Promise<unknown>;
	/** The first feed line, old or new, that matches. */
	waitFor<T extends FeedLine>(
		what: string,
		match: (line: FeedLine) => line is T,
	): Promise<T>;
	/** Polls `read` until `done` holds for its value. */
	until<T>(
		what: string,
		read: () => Promise<T>,
		done: (value: T) => boolean,
	): Promise<T>;
	stop(): Promise<void>;
};

export type ScriptEvent = {
	externalId: string;
	thread: { key: string; title: string; url: string | null };
	author: { id: string | null; name: string; isBot: boolean; isSelf?: boolean };
	text: string;
	mentionsAgent: boolean;
};

async function json(response: Response): Promise<unknown> {
	if (!response.ok) {
		throw new Error(`HTTP ${response.status}: ${await response.text()}`);
	}
	return response.json();
}

// The daemon is trusted to send the shapes the protocol promises; these only
// tell them apart.
function isFeedLine(value: unknown): value is FeedLine {
	return (
		typeof value === 'object' &&
		value !== null &&
		'type' in value &&
		typeof value.type === 'string'
	);
}

function has<K extends string>(
	value: unknown,
	key: K,
): value is K extends 'ok'
	? ActionResult
	: { seq: number; duplicate: boolean } {
	return typeof value === 'object' && value !== null && key in value;
}

/** Starts `superagent daemon --script-channel` in a fresh `/tmp/sa-…` folder. */
export async function startAgent(particleUrl: string): Promise<Agent> {
	// Short, to stay under the socket path limit.
	const home = mkdtempSync('/tmp/sa-');
	const socket = join(home, 'agent.sock');
	const child = Bun.spawn(['bun', CLI, 'daemon', '--script-channel'], {
		// Not inside a repository, so first-run detection adds none.
		cwd: home,
		env: {
			...Bun.env,
			SUPERAGENT_HOME: home,
			PARTICLE_BASE_URL: particleUrl,
			PARTICLE_API_KEY: 'pai-e2e',
		},
		stdin: 'ignore',
		stdout: 'ignore',
		stderr: Bun.env.E2E_VERBOSE ? 'inherit' : 'ignore',
	});

	const request = async (path: string, init: RequestInit = {}) => {
		const token = (await Bun.file(join(home, 'token')).text()).trim();
		const headers = new Headers(init.headers);
		headers.set('Authorization', `Bearer ${token}`);
		headers.set(PROTOCOL_HEADER, PROTOCOL_VERSION);
		return fetch(`http://superagent${path}`, {
			...init,
			headers,
			unix: socket,
		});
	};

	const lines: FeedLine[] = [];
	const waiters = new Set<() => void>();
	const started = Date.now();
	for (;;) {
		try {
			// oxlint-disable-next-line eslint/no-await-in-loop
			const response = await request('/v1/feed');
			if (response.ok && response.body) {
				readFeed(response.body);
				break;
			}
		} catch {
			// Not listening yet.
		}
		if (Date.now() - started > WAIT_MS) {
			child.kill();
			throw new Error(`the daemon didn't start; see ${home}/daemon.log`);
		}
		// oxlint-disable-next-line eslint/no-await-in-loop
		await Bun.sleep(100);
	}

	function readFeed(body: ReadableStream<Uint8Array>) {
		void (async () => {
			let buffered = '';
			const decoder = new TextDecoder();
			for await (const chunk of body) {
				buffered += decoder.decode(chunk, { stream: true });
				let end = buffered.indexOf('\n');
				while (end !== -1) {
					const line = buffered.slice(0, end);
					buffered = buffered.slice(end + 1);
					end = buffered.indexOf('\n');
					if (line.trim() === '') continue;
					const parsed: unknown = JSON.parse(line);
					if (isFeedLine(parsed)) lines.push(parsed);
				}
				for (const waiter of waiters) waiter();
			}
		})().catch(() => {});
	}

	return {
		home,
		lines,
		async action(action) {
			const result = await json(
				await request('/v1/actions', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ requestId: crypto.randomUUID(), action }),
				}),
			);
			if (!has(result, 'ok')) throw new Error('not an action result');
			return result;
		},
		async event(body) {
			const result = await json(
				await request('/v1/events', {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
				}),
			);
			if (!has(result, 'duplicate')) throw new Error('not an event result');
			return result;
		},
		async get(path) {
			return json(await request(path));
		},
		waitFor<T extends FeedLine>(
			what: string,
			match: (line: FeedLine) => line is T,
		) {
			return new Promise<T>((resolve, reject) => {
				const check = () => {
					const found = lines.find(match);
					if (!found) return;
					waiters.delete(check);
					clearTimeout(timer);
					resolve(found);
				};
				const timer = setTimeout(() => {
					waiters.delete(check);
					reject(new Error(`timed out waiting for ${what}`));
				}, WAIT_MS);
				waiters.add(check);
				check();
			});
		},
		async until(what, read, done) {
			const deadline = Date.now() + WAIT_MS;
			for (;;) {
				// oxlint-disable-next-line eslint/no-await-in-loop
				const value = await read();
				if (done(value)) return value;
				if (Date.now() > deadline)
					throw new Error(`timed out waiting for ${what}`);
				// oxlint-disable-next-line eslint/no-await-in-loop
				await Bun.sleep(100);
			}
		},
		async stop() {
			child.kill('SIGTERM');
			await child.exited;
			if (!Bun.env.E2E_KEEP) rmSync(home, { recursive: true, force: true });
		},
	};
}
