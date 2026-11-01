import type { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import type { Server } from 'bun';
import packageJson from '../../package.json' with { type: 'json' };
import { dataPaths } from '../home.ts';
import { loadAgentId, openDatabase } from './db.ts';
import { createFeed } from './feed.ts';
import { repositoryName, repositoryRoot, startCleanup } from './git.ts';
import { createLog } from './log.ts';
import { NO_API_KEY, createModelClient } from './model.ts';
import { type RouterLoop, recoverRouter, startRouter } from './router.ts';
import { recoverCommands, captureLoginPath } from './commands.ts';
import { listen } from './server.ts';
import {
	createDataFolder,
	gatherMachineFacts,
	loadConfig,
	loadToken,
	releaseLock,
	saveRepos,
	takeLock,
} from './setup.ts';
import { buildSnapshot } from './snapshot.ts';
import type { Daemon } from './state.ts';
import { startActivityTimer } from './task-feed.ts';
import { installWorkers, startWorkers, stopWorkers } from './worker.ts';

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
	let router: RouterLoop | null = null;
	let stopActivity: (() => void) | null = null;
	let stopCleanup: (() => Promise<void>) | null = null;
	const teardown = async () => {
		if (daemon) daemon.stopping = true;
		await router?.stop();
		// Workers may still store their last tool result, so the database stays
		// open until they and their commands have ended.
		if (daemon) await stopWorkers(daemon);
		stopActivity?.();
		await stopCleanup?.();
		if (daemon) {
			daemon.feed.close();
			if (daemon.usageTimer) clearTimeout(daemon.usageTimer);
			if (daemon.taskUpdates.timer) clearTimeout(daemon.taskUpdates.timer);
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
		// First run inside a repository: use it.
		if (config.repos.length === 0) {
			const top = repositoryRoot(process.cwd());
			if (top !== null) {
				config.repos = [{ name: repositoryName(top), path: top }];
				saveRepos(paths.config, config.repos);
				log('info', 'added the current repository to config.json', {
					repo: config.repos[0]?.name,
					path: top,
				});
			}
		}
		const token = loadToken(paths.token);
		const agentId = loadAgentId(db);
		const machine = gatherMachineFacts();
		const loginPath = captureLoginPath();
		if (loginPath === null) {
			log(
				'warn',
				"couldn't read your login shell's PATH; commands get the agent's own",
			);
		}

		const channels = new Map<string, number | null>([['console', null]]);
		for (const row of db
			.query<{ channel: string; at: number }, []>(
				`SELECT channel, MAX(received_at) AS at FROM events
				WHERE channel != 'internal' GROUP BY channel`,
			)
			.all()) {
			channels.set(row.channel, row.at);
		}

		const particle = createModelClient(config);
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
			particle,
			model:
				particle === null
					? { state: 'paused', detail: NO_API_KEY, since: startedAt }
					: { state: 'ok', detail: null, since: null },
			router: { batch: null, wake: () => {} },
			paths,
			loginPath: loginPath ?? Bun.env.PATH ?? '/usr/bin:/bin',
			workers: new Map(),
			commands: new Map(),
			runWorker: () => {},
			slotQueue: [],
			calls: { workers: 0, waiters: new Set() },
			taskUpdates: { pending: new Set(), timer: null },
			stopping: false,
		};
		installWorkers(context);
		recoverRouter(context);
		const interrupted = recoverCommands(context);
		if (interrupted > 0) {
			log('info', 'recovered commands', { interrupted });
		}
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
	if (daemon.particle === null) log('warn', NO_API_KEY);
	router = startRouter(daemon);
	startWorkers(daemon);
	stopActivity = startActivityTimer(daemon);
	stopCleanup = startCleanup(daemon);

	const signal = await new Promise<NodeJS.Signals>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	log('info', 'stopping', { signal });
	await teardown();
	log('info', 'agent stopped');
}
