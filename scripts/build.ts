// Builds the single-file executables into dist/: `bun run build` for every
// platform, or `bun run build linux-x64` for some of them.
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };

export const TARGETS = [
	'darwin-arm64',
	'darwin-x64',
	'linux-x64',
	'linux-arm64',
] as const;

export type Target = (typeof TARGETS)[number];

export const DIST = join(import.meta.dir, '..', 'dist');

export function binaryName(target: Target): string {
	return `superagent-${target}`;
}

function isTarget(name: string): name is Target {
	return TARGETS.some((target) => target === name);
}

export async function build(targets: readonly Target[]): Promise<string[]> {
	const outputs: string[] = [];
	for (const target of targets) {
		const outfile = join(DIST, binaryName(target));
		rmSync(outfile, { force: true });
		// oxlint-disable-next-line eslint/no-await-in-loop
		const result = await Bun.build({
			entrypoints: [join(import.meta.dir, '..', 'src', 'cli.ts')],
			minify: true,
			sourcemap: 'linked',
			compile: {
				target: `bun-${target}`,
				outfile,
				// A bunfig.toml in the folder it's started from must not change
				// how the agent runs; .env still works, as from source.
				autoloadBunfig: false,
			},
		});
		if (!result.success) {
			for (const log of result.logs) process.stderr.write(`${log.message}\n`);
			throw new Error(`building ${target} failed`);
		}
		// The executable carries its own copy of the source map, for stack traces.
		rmSync(`${outfile}.map`, { force: true });
		outputs.push(outfile);
		process.stdout.write(`built ${outfile}\n`);
	}
	return outputs;
}

if (import.meta.main) {
	const wanted = Bun.argv.slice(2);
	const unknown = wanted.filter((name) => !isTarget(name));
	if (unknown.length > 0) {
		process.stderr.write(
			`Unknown target ${unknown.join(', ')}; choose from ${TARGETS.join(', ')}\n`,
		);
		process.exit(1);
	}
	process.stdout.write(`superagent ${packageJson.version}\n`);
	await build(wanted.length > 0 ? wanted.filter(isTarget) : TARGETS);
}
