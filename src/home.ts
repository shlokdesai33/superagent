import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type DataPaths = {
	home: string;
	config: string;
	token: string;
	socket: string;
	pid: string;
	log: string;
	db: string;
};

/** `$SUPERAGENT_HOME`, or `~/.superagent`. */
export function dataPaths(): DataPaths {
	const home = resolve(
		Bun.env.SUPERAGENT_HOME || join(homedir(), '.superagent'),
	);
	return {
		home,
		config: join(home, 'config.json'),
		token: join(home, 'token'),
		socket: join(home, 'agent.sock'),
		pid: join(home, 'daemon.pid'),
		log: join(home, 'daemon.log'),
		db: join(home, 'state.db'),
	};
}
