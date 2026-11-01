import type { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import type { Server } from 'bun';
import packageJson from '../../package.json' with { type: 'json' };
import { dataPaths } from '../home.ts';
import { loadAgentId, openDatabase } from './db.ts';
import { createFeed } from './feed.ts';
import { createLog } from './log.ts';
import { listen } from './server.ts';
import {
	createDataFolder,
	gatherMachineFacts,
	loadConfig,
	loadToken,
	releaseLock,
	takeLock,
} from './setup.ts';
import { type Daemon, buildSnapshot } from './state.ts';

/**
 * Runs the agent until SIGINT or SIGTERM. Setup problems throw `StartupError`
 * before anything can connect.
 */
export async function runDaemon(): Promise<void> {
	const startedAt = Date.now();
	const paths = dataPaths();
	createDataFolder(paths);
	takeLock(paths.pid);
	const log = createLog(paths.log);

	let server: Server<undefined> | null = null;
	let db: Database | null = null;
	let daemon: Daemon | null = null;
	const teardown = async () => {
		if (daemon) {
			daemon.feed.close();
			if (daemon.usageTimer) clearTimeout(daemon.usageTimer);
		}
		await server?.stop(true);
		db?.close();
		rmSync(paths.socket, { force: true });
		releaseLock(paths.pid);
	};

	try {
		// We hold the lock, so any socket left here is from a run that crashed.
		rmSync(paths.socket, { force: true });
		// Every step from here to `daemon = …` is synchronous, so no request is
		// handled before the daemon exists.
		server = listen(paths.socket, () => {
			if (daemon === null) throw new Error('The agent is still starting');
			return daemon;
		});
		db = openDatabase(paths.db);
		const config = loadConfig(paths.config);
		const token = loadToken(paths.token);
		const agentId = loadAgentId(db);
		const machine = gatherMachineFacts();

		const channels = new Map<string, number | null>([['console', null]]);
		for (const row of db
			.query<{ channel: string; at: number }, []>(
				`SELECT channel, MAX(received_at) AS at FROM events
				WHERE channel != 'internal' GROUP BY channel`,
			)
			.all()) {
			channels.set(row.channel, row.at);
		}

		const context: Daemon = {
			db,
			feed: createFeed(() => buildSnapshot(context), log),
			log,
			token,
			config,
			agent: {
				id: agentId,
				version: packageJson.version,
				pid: process.pid,
				startedAt,
			},
			machine,
			channels,
			actionResults: new Map(),
			usageTimer: null,
		};
		daemon = context;
	} catch (error) {
		await teardown();
		throw error;
	}

	log('info', 'agent started', {
		agent: daemon.agent.id,
		pid: process.pid,
		home: paths.home,
		socket: paths.socket,
		os: daemon.machine.os,
	});

	const signal = await new Promise<NodeJS.Signals>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	log('info', 'stopping', { signal });
	await teardown();
	log('info', 'agent stopped');
}
