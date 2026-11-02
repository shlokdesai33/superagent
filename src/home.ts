import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

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

/**
 * Whether `pid` runs `superagent daemon`, the executable or `cli.ts` from
 * source. A `daemon.pid` left by a crash or a reboot can name a pid that now
 * belongs to something else. `true` when its command line can't be read.
 */
export function isAgentProcess(pid: number): boolean {
	let argv: string[];
	try {
		argv = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
			.split('\0')
			.filter(Boolean);
	} catch {
		let ps;
		try {
			ps = Bun.spawnSync(['ps', '-o', 'command=', '-p', String(pid)], {
				stdin: 'ignore',
				stdout: 'pipe',
				stderr: 'ignore',
			});
		} catch {
			return true;
		}
		// ps exits 1 when there's no such process.
		if (!ps.success) return ps.exitCode !== 1;
		argv = ps.stdout.toString().trim().split(/\s+/);
	}
	return (
		argv.includes('daemon') &&
		argv.some((arg) => /^(superagent|cli\.ts)/.test(basename(arg)))
	);
}

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
