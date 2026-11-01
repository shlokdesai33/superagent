#!/usr/bin/env bun
import packageJson from '../package.json' with { type: 'json' };

const usage = `Usage: superagent [options]

Options:
  -h, --help     Show this help
  -v, --version  Show the version`;

const [arg, ...rest] = Bun.argv.slice(2);

if (rest.length > 0) {
	console.error(`Unexpected argument: ${rest[0]}\n\n${usage}`);
	process.exitCode = 1;
} else {
	switch (arg) {
		case undefined:
		case '-h':
		case '--help':
			console.log(usage);
			break;
		case '-v':
		case '--version':
			console.log(packageJson.version);
			break;
		default:
			console.error(`Unknown option: ${arg}\n\n${usage}`);
			process.exitCode = 1;
	}
}
