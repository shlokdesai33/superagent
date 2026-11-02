import type { Database } from 'bun:sqlite';
import { rmSync } from 'node:fs';
import type { Server } from 'bun';
import packageJson from '../../package.json' with { type: 'json' };
import { BACKGROUND_ENV, dataPaths } from '../home.ts';
import { loadAgentId, openDatabase } from './db.ts';
import { createFeed } from './feed.ts';
import { missingIdentity, startCleanup } from './git.ts';
import {
	type GitHubClient,
	githubRetryMs,
	initialGitHub,
	startGitHub,
} from './github.ts';
import { pollFollowed } from './github-threads.ts';
import { type Delivery, startDelivery } from './github-delivery.ts';
import { type Watchdog, startWatchdog } from './watchdog.ts';
import { createLog } from './log.ts';
import {
	NO_API_KEY,
	checkStartingKey,
	findParticleKey,
	particleClient,
	watchParticleKey,
} from './model.ts';
import { type RouterLoop, recoverRouter, startRouter } from './router.ts';
import { recoverCommands, captureLoginPath } from './commands.ts';
import { addSecrets } from './secrets.ts';
import { startSandbox, stopSandbox } from './sandbox.ts';
import { listen } from './server.ts';
import {
	createDataFolder,
	gatherMachineFacts,
	loadConfig,
	migrateConfigKey,
	releaseLock,
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
export async function runDaemon(options: {
	scriptChannel: boolean;
}): Promise<void> {
	const startedAt = Date.now();
	const paths = dataPaths();
	createDataFolder(paths);
	takeLock(paths.pid);
	// In the background, stderr goes to output.log, which is kept for what the
	// log can't hold: startup errors and crashes.
	const log = createLog(paths.log, !Bun.env[BACKGROUND_ENV]);

	let server: Server<undefined> | null = null;
	let db: Database | null = null;
	let daemon: Daemon | null = null;
	let router: RouterLoop | null = null;
	let stopActivity: (() => void) | null = null;
	let stopCleanup: (() => Promise<void>) | null = null;
	let stopKeyWatch: (() => void) | null = null;
	let github: GitHubClient | null = null;
	let delivery: Delivery | null = null;
	let watchdog: Watchdog | null = null;
	let sandboxStarted = false;
	const teardown = async () => {
		await watchdog?.stop();
		if (daemon) daemon.stopping = true;
		stopKeyWatch?.();
		await delivery?.stop();
		await github?.stop();
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
		if (sandboxStarted) await stopSandbox();
		db?.close();
		rmSync(paths.socket, { force: true });
		releaseLock(paths.pid);
	};

	try {
		const loginPath = captureLoginPath();
		if (loginPath === null) {
			log(
				'warn',
				"couldn't read your login shell's PATH; commands get the agent's own",
			);
		}
		const commandPath = loginPath ?? Bun.env.PATH ?? '/usr/bin:/bin';
		// Before the socket, so no request arrives while it starts.
		sandboxStarted = true;
		const sandbox = await startSandbox(paths, commandPath);
		if (sandbox.state === 'on') {
			log('info', 'sandbox on');
		} else {
			log('warn', 'sandbox off; Worker commands run unsandboxed', {
				cause: sandbox.cause,
				fix: sandbox.fix,
			});
		}

		// We hold the lock, so any socket left here is from a run that crashed.
		rmSync(paths.socket, { force: true });
		// Every step from here to `daemon = …` is synchronous, so no request is
		// handled before the daemon exists.
		server = listen(paths.socket, () => {
			if (daemon === null) throw new Error('The agent is still starting');
			return daemon;
		});
		db = openDatabase(paths.db);
		const movedKey = migrateConfigKey(paths, log);
		const config = loadConfig(paths.config);
		const key = findParticleKey(paths.particleKey);
		const secrets: string[] = [];
		addSecrets(secrets, [...key.found, movedKey]);
		const machine = gatherMachineFacts(commandPath);
		const identity = missingIdentity(
			commandPath,
			secrets,
			config.repos.map((repo) => repo.path),
		);
		if (identity.length > 0) {
			log('warn', 'git has no commit identity; Worker commits will fail', {
				missing: identity,
			});
		}
		const agentId = loadAgentId(db);

		const channels = new Map<string, number | null>([['console', null]]);
		if (options.scriptChannel) channels.set('script', null);
		for (const row of db
			.query<{ channel: string; at: number }, []>(
				`SELECT channel, MAX(received_at) AS at FROM events
				WHERE channel != 'internal' GROUP BY channel`,
			)
			.all()) {
			if (channels.has(row.channel)) channels.set(row.channel, row.at);
		}

		const particle = key.key === null ? null : particleClient(key.key);
		const context: Daemon = {
			db,
			feed: createFeed(() => buildSnapshot(context), log),
			log,
			config,
			secrets,
			agent: {
				id: agentId,
				version: packageJson.version,
				pid: process.pid,
				startedAt,
			},
			machine,
			channels,
			github: initialGitHub(config),
			githubApi: null,
			wakeDelivery: () => {},
			scriptChannel: options.scriptChannel,
			actionResults: new Map(),
			usageTimer: null,
			particle,
			particleKey: key.key,
			keySource: key.source,
			model:
				particle === null
					? {
							state: 'paused',
							detail: key.problem ?? NO_API_KEY,
							since: startedAt,
						}
					: { state: 'ok', detail: null, since: null },
			router: { batch: null, backoffUntil: null, wake: () => {} },
			paths,
			loginPath: commandPath,
			sandbox,
			missingIdentity: identity,
			workers: new Map(),
			commands: new Map(),
			runWorker: () => {},
			slotQueue: [],
			calls: { workers: 0, waiters: new Set() },
			taskUpdates: { pending: new Set(), timer: null },
			stopping: false,
			watchdog: { lastCheckAt: null },
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
		particleKey: daemon.keySource,
	});
	if (daemon.particle === null) log('warn', daemon.model.detail ?? NO_API_KEY);
	else void checkStartingKey(daemon);
	stopKeyWatch = watchParticleKey(daemon);
	router = startRouter(daemon);
	startWorkers(daemon);
	stopActivity = startActivityTimer(daemon);
	stopCleanup = startCleanup(daemon);
	const running = daemon;
	github = startGitHub(running, async (api) => {
		await pollFollowed(running, api);
		running.wakeDelivery();
	});
	running.githubApi = github;
	delivery = startDelivery(running, github, githubRetryMs());
	running.wakeDelivery = delivery.wake;
	watchdog = startWatchdog(running);

	const signal = await new Promise<NodeJS.Signals>((resolve) => {
		process.once('SIGINT', resolve);
		process.once('SIGTERM', resolve);
	});
	log('info', 'stopping', { signal });
	await teardown();
	log('info', 'agent stopped');
}
