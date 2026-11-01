#!/usr/bin/env bun
import packageJson from '../package.json' with { type: 'json' };

export const usage = `Usage: superagent [options]

Options:
  -h, --help     Show this help
  -v, --version  Show the version`;

export interface CliResult {
	exitCode: number;
	stdout?: string;
	stderr?: string;
}

export function run(args: readonly string[]): CliResult {
	const [arg, ...rest] = args;
	if (rest.length > 0) {
		return {
			exitCode: 1,
			stderr: `Unexpected argument: ${rest[0]}\n\n${usage}`,
		};
	}
	switch (arg) {
		case undefined:
		case '-h':
		case '--help':
			return { exitCode: 0, stdout: usage };
		case '-v':
		case '--version':
			return { exitCode: 0, stdout: packageJson.version };
		default:
			return { exitCode: 1, stderr: `Unknown option: ${arg}\n\n${usage}` };
	}
}

if (import.meta.main) {
	const result = run(Bun.argv.slice(2));
	if (result.stdout !== undefined) console.log(result.stdout);
	if (result.stderr !== undefined) console.error(result.stderr);
	process.exitCode = result.exitCode;
}
