#!/usr/bin/env bun
import packageJson from '../package.json' with { type: 'json' };
import { DaemonUnreachable, readSnapshot } from './client.ts';
import { runDaemon } from './daemon/main.ts';
import { StartupError } from './daemon/setup.ts';
import { dataPaths } from './home.ts';
import { formatStatus } from './status.ts';
import { runTui } from './tui/main.ts';

const usage = `Usage: superagent [command] [options]

Commands:
  (none)         Open the terminal UI; prints the status when not in a terminal
  daemon         Run the agent in the foreground until Ctrl-C
  status         Print the agent's status and exit

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
				: formatStatus(snapshot, dataPaths().home),
		);
	} catch (error) {
		if (!(error instanceof DaemonUnreachable)) throw error;
		console.error(error.message);
		process.exitCode = 1;
	}
}

function fail(message: string): void {
	console.error(`${message}\n\n${usage}`);
	process.exitCode = 1;
}
