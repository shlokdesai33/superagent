// Publishes a release from this machine: builds every executable, writes
// their SHA-256 checksums and uploads them, with install.sh, to a GitHub
// Release named after package.json's version. Needs gh, logged in.
//
//   bun run release            build, check and publish v<version>
//   bun run release --dry-run  build and check, without publishing
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { DIST, TARGETS, binaryName, build } from './build.ts';

const ROOT = join(import.meta.dir, '..');
const dryRun = Bun.argv.includes('--dry-run');
const tag = `v${packageJson.version}`;

function run(command: string[]): { code: number; stdout: string } {
	const result = Bun.spawnSync(command, {
		cwd: ROOT,
		stdout: 'pipe',
		stderr: 'inherit',
	});
	return { code: result.exitCode, stdout: result.stdout.toString().trim() };
}

function stop(message: string): never {
	process.stderr.write(`${message}\n`);
	process.exit(1);
}

if (!dryRun) {
	if (Bun.which('gh') === null)
		stop('Install gh first: https://cli.github.com');
	if (run(['gh', 'auth', 'status']).code !== 0)
		stop('Log in first: gh auth login');
	if (run(['git', 'status', '--porcelain']).stdout !== '') {
		stop(
			'Commit or stash your changes first: a release is built from a clean tree.',
		);
	}
	const head = run(['git', 'rev-parse', 'HEAD']).stdout;
	run(['git', 'fetch', '--quiet', 'origin', 'main']);
	if (
		run(['git', 'merge-base', '--is-ancestor', head, 'origin/main']).code !== 0
	) {
		stop('Push this commit to main first: a release is tagged on main.');
	}
	if (run(['gh', 'release', 'view', tag]).code === 0) {
		stop(`${tag} is already released. Raise "version" in package.json first.`);
	}
}

const binaries = await build(TARGETS);
const assets: string[] = [...binaries];
const sums: string[] = [];
for (const file of binaries) {
	const hash = new Bun.CryptoHasher('sha256')
		.update(readFileSync(file))
		.digest('hex');
	// The format sha256sum and shasum -c read.
	const line = `${hash}  ${basename(file)}\n`;
	writeFileSync(`${file}.sha256`, line);
	assets.push(`${file}.sha256`);
	sums.push(line);
}
writeFileSync(join(DIST, 'SHA256SUMS'), sums.join(''));
copyFileSync(join(ROOT, 'install.sh'), join(DIST, 'install.sh'));
assets.push(join(DIST, 'SHA256SUMS'), join(DIST, 'install.sh'));

const host = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch}`;
const own = TARGETS.find((target) => target === host);
if (own) {
	const version = run([join(DIST, binaryName(own)), '--version']).stdout;
	if (version !== packageJson.version) {
		stop(
			`${binaryName(own)} --version printed ${version}, not ${packageJson.version}`,
		);
	}
	process.stdout.write(`checked ${binaryName(own)} --version: ${version}\n`);
}

if (dryRun) {
	process.stdout.write(`\nDry run: would release ${tag} with\n`);
	for (const asset of assets) process.stdout.write(`  ${asset}\n`);
	process.exit(0);
}

const created = Bun.spawnSync(
	[
		'gh',
		'release',
		'create',
		tag,
		...assets,
		'--target',
		run(['git', 'rev-parse', 'HEAD']).stdout,
		'--title',
		tag,
		'--generate-notes',
	],
	{ cwd: ROOT, stdout: 'inherit', stderr: 'inherit' },
);
if (created.exitCode !== 0) stop(`gh release create ${tag} failed`);
process.stdout.write(`Released ${tag}\n`);
