#!/usr/bin/env bun
import { mkdirSync } from 'node:fs';
import packageJson from '../package.json' with { type: 'json' };
import { DaemonUnreachable, readSnapshot } from './client.ts';
import { runDaemon } from './daemon/main.ts';
import { StartupError } from './daemon/setup.ts';
import { dataPaths } from './home.ts';
import { writeKeyFile } from './keys.ts';
import {
	API_KEY_ENV,
	checkApiKey,
	looksLikeApiKey,
} from './particle/client.ts';
import { Cancelled, readSecret } from './read-secret.ts';
import { formatStatus } from './status.ts';
import { runTui } from './tui/main.ts';

const usage = `Usage: superagent [command] [options]

Commands:
  (none)         Open the terminal UI; prints the status when not in a terminal
  daemon         Run the agent in the foreground until Ctrl-C
  status         Print the agent's status and exit
  login particle Ask for your Particle API key, check it and save it

Options:
  --json             With status: print the raw snapshot JSON
  --script-channel   With daemon: accept test events on POST /v1/events
  -h, --help     Show this help
  -v, --version  Show the version

The data folder is $SUPERAGENT_HOME, or ~/.superagent.`;

const [command, ...rest] = Bun.argv.slice(2);

switch (command) {
	case undefined:
		if (process.stdin.isTTY && process.stdout.isTTY) await runTui();
		else await status(false);
		break;
	case '-h':
	case '--help':
		if (rest.length > 0) fail(`Unexpected argument: ${rest[0]}`);
		else console.log(usage);
		break;
	case '-v':
	case '--version':
		if (rest.length > 0) fail(`Unexpected argument: ${rest[0]}`);
		else console.log(packageJson.version);
		break;
	case 'daemon': {
		const unexpected = rest.find((arg) => arg !== '--script-channel');
		if (unexpected !== undefined) fail(`Unexpected argument: ${unexpected}`);
		else await daemon(rest.includes('--script-channel'));
		break;
	}
	case 'status': {
		const unexpected = rest.find((arg) => arg !== '--json');
		if (unexpected !== undefined) fail(`Unexpected argument: ${unexpected}`);
		else await status(rest.includes('--json'));
		break;
	}
	// Never echo the arguments: one may be a key typed in by mistake.
	case 'login':
		if (rest[0] !== 'particle') fail('Usage: superagent login particle');
		else if (rest.length > 1) {
			fail('superagent login particle takes no arguments; it asks for the key');
		} else await loginParticle();
		break;
	default:
		fail(`Unknown command: ${command}`);
}

async function daemon(scriptChannel: boolean): Promise<void> {
	try {
		await runDaemon({ scriptChannel });
	} catch (error) {
		if (!(error instanceof StartupError)) throw error;
		console.error(error.message);
		process.exitCode = 1;
	}
}

async function status(json: boolean): Promise<void> {
	try {
		const snapshot = await readSnapshot();
		console.log(
			json
				? JSON.stringify(snapshot, null, 2)
				: formatStatus(snapshot, dataPaths()),
		);
	} catch (error) {
		if (!(error instanceof DaemonUnreachable)) throw error;
		console.error(error.message);
		process.exitCode = 1;
	}
}

async function loginParticle(): Promise<void> {
	let key: string;
	try {
		key = await readSecret('Particle API key (input hidden): ');
	} catch (error) {
		if (!(error instanceof Cancelled)) throw error;
		process.exitCode = 130;
		return;
	}
	if (!looksLikeApiKey(key)) {
		console.error(
			key === ''
				? 'No key given; nothing saved.'
				: "That isn't a Particle API key (they start with pai-); nothing saved.",
		);
		process.exitCode = 1;
		return;
	}
	const baseUrl = Bun.env.PARTICLE_BASE_URL;
	const check = await checkApiKey(
		baseUrl ? { apiKey: key, baseUrl } : { apiKey: key },
	);
	if (check.result === 'rejected') {
		console.error('Particle rejected this key; nothing saved.');
		process.exitCode = 1;
		return;
	}
	const paths = dataPaths();
	mkdirSync(paths.home, { recursive: true, mode: 0o700 });
	writeKeyFile(paths.particleKey, key);
	console.log(
		check.result === 'valid'
			? `Particle accepted the key. Saved it to ${paths.particleKey}`
			: `Couldn't check the key with Particle (${check.problem}). Saved it to ${paths.particleKey}`,
	);
	console.log(
		Bun.env[API_KEY_ENV]
			? `${API_KEY_ENV} is set here and overrides the file while it is.`
			: 'A running agent picks it up within a few seconds.',
	);
}

function fail(message: string): void {
	console.error(`${message}\n\n${usage}`);
	process.exitCode = 1;
}
