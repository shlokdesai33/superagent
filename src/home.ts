import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type DataPaths = {
	home: string;
	config: string;
	particleKey: string;
	socket: string;
	pid: string;
	log: string;
	/** What the background agent prints: startup errors and crashes. */
	output: string;
	db: string;
};

/** Set in the environment of an agent started in the background. */
export const BACKGROUND_ENV = 'SUPERAGENT_BACKGROUND';

/** `$SUPERAGENT_HOME`, or `~/.superagent`. */
export function dataPaths(): DataPaths {
	const home = resolve(
		Bun.env.SUPERAGENT_HOME || join(homedir(), '.superagent'),
	);
	return {
		home,
		config: join(home, 'config.json'),
		particleKey: join(home, 'particle-key'),
		socket: join(home, 'agent.sock'),
		pid: join(home, 'daemon.pid'),
		log: join(home, 'daemon.log'),
		output: join(home, 'output.log'),
		db: join(home, 'state.db'),
	};
}
