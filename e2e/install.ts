// End to end: install.sh, against fake releases served from localhost. It runs
// the script under every POSIX shell found here, piped as the README's
// one-liner does and as a file, in the C locale, a UTF-8 one and a Latin-1
// one, then checks updates, dry runs, the settings and the ways it fails. Run
// with `bun run e2e`; it exits non-zero if a check fails.
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	rmSync,
	statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';

const SCRIPT = join(import.meta.dir, '..', 'install.sh');
const script = await Bun.file(SCRIPT).text();
const keep = process.env.E2E_KEEP === '1';

function fakeSuperagent(version: string): string {
	return `#!/bin/sh\ncase "\${1:-}" in\n--version) echo ${version} ;;\nstatus) exit 1 ;;\nesac\n`;
}

function sha256(text: string): string {
	return new Bun.CryptoHasher('sha256').update(text).digest('hex');
}

// Each release serves every platform's executable, so the script's own pick
// (Rosetta included) always finds one.
type Release = { binary: string; checksum?: string; slow?: boolean };
const releases: Record<string, Release> = {
	v1: { binary: fakeSuperagent('1.2.3') },
	v2: { binary: fakeSuperagent('1.2.4') },
	tampered: { binary: fakeSuperagent('6.6.6'), checksum: sha256('other') },
	broken: { binary: '#!/bin/sh\nexit 1\n' },
	slow: { binary: fakeSuperagent('1.2.3'), slow: true },
};

const server = Bun.serve({
	hostname: '127.0.0.1',
	port: 0,
	fetch(request) {
		const [, name, file] = new URL(request.url).pathname.split('/');
		const release = releases[name ?? ''];
		const asset = file?.match(
			/^(superagent-(?:darwin|linux)-(?:arm64|x64))(\.sha256)?$/,
		);
		if (!release || !asset) return new Response('Not Found', { status: 404 });
		if (asset[2]) {
			const hash = release.checksum ?? sha256(release.binary);
			return new Response(`${hash}  ${asset[1]}\n`);
		}
		if (!release.slow) return new Response(release.binary);
		// A download that never ends, a byte at a time, for interrupting.
		return new Response(
			new ReadableStream({
				async pull(controller) {
					controller.enqueue(new TextEncoder().encode('#'));
					await Bun.sleep(100);
				},
			}),
		);
	},
});
const base = (release: string) => `${server.url.origin}/${release}`;

const shells = [
	['sh'],
	['dash'],
	['bash'],
	['bash', '--posix'],
	['zsh', '--emulate', 'sh'],
	['busybox', 'sh'],
].filter(([command]) => Bun.which(command ?? '') !== null);

const locales: string[] =
	Bun.which('locale') === null
		? []
		: Bun.spawnSync(['locale', '-a'])
				.stdout.toString()
				.split('\n')
				.map((line) => line.trim());
const utf8 =
	['C.UTF-8', 'C.utf8', 'en_US.UTF-8', 'en_US.utf8'].find((name) =>
		locales.includes(name),
	) ?? locales.find((name) => /utf-?8$/i.test(name));
// Where byte 0xE2, the first of "…", is a letter, as macOS's /bin/sh reads it
// in UTF-8 locales too, bash takes an unbraced "$asset…" for an unset variable.
const latin1 = locales.find((name) => /iso-?8859-?1$/i.test(name));

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
	if (!ok) failures += 1;
	process.stdout.write(
		`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `  (${detail})` : ''}\n`,
	);
}

const folders: string[] = [];
function folder(): string {
	const path = mkdtempSync(join(tmpdir(), 'sa-install-'));
	folders.push(path);
	return path;
}

type Options = {
	shell?: string[];
	piped?: boolean;
	args?: string[];
	env: Record<string, string | undefined>;
};

// Runs install.sh with only the given environment, besides PATH and LC_ALL,
// from a folder other than the checkout.
function start({ shell = ['sh'], piped = true, args = [], env }: Options) {
	const command = piped
		? [...shell, ...(args.length > 0 ? ['-s', '--', ...args] : [])]
		: [...shell, SCRIPT, ...args];
	const clean: Record<string, string> = {};
	for (const [key, value] of Object.entries({
		PATH: process.env.PATH,
		LC_ALL: 'C',
		...env,
	})) {
		if (value !== undefined) clean[key] = value;
	}
	const proc = Bun.spawn(command, {
		cwd: tmpdir(),
		env: clean,
		stdin: piped ? 'pipe' : 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	if (piped && proc.stdin) {
		void proc.stdin.write(script);
		void proc.stdin.end();
	}
	return proc;
}

type Result = { code: number; stdout: string; stderr: string };
async function finish(
	proc: Subprocess<'pipe' | 'ignore', 'pipe', 'pipe'>,
): Promise<Result> {
	const timer = setTimeout(() => proc.kill('SIGKILL'), 30_000);
	const [code, stdout, stderr] = await Promise.all([
		proc.exited,
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
	]);
	clearTimeout(timer);
	return { code, stdout, stderr };
}

const install = (options: Options) => finish(start(options));

function lastLine(text: string): string {
	return text.trim().split('\n').at(-1) ?? '';
}

function isExecutable(path: string): boolean {
	return existsSync(path) && (statSync(path).mode & 0o111) !== 0;
}

try {
	const unbraced = script
		.split('\n')
		.flatMap((line, index) =>
			/\$[A-Za-z_]\w*[\u0080-\uffff]/.test(line) ? [`line ${index + 1}`] : [],
		);
	check(
		'every variable followed by a non-ASCII character is in braces',
		unbraced.length === 0,
		unbraced.join(', '),
	);

	if (!latin1) {
		process.stdout.write(
			'  no Latin-1 locale here, so that case is skipped; add one with: sudo localedef -i en_US -f ISO-8859-1 en_US.ISO-8859-1\n',
		);
	}
	for (const shell of shells) {
		for (const locale of ['C', utf8, latin1]) {
			if (!locale) continue;
			const problems: string[] = [];
			for (const piped of [true, false]) {
				const home = folder();
				const dest = join(home, '.local', 'bin', 'superagent');
				// oxlint-disable-next-line eslint/no-await-in-loop
				const result = await install({
					shell,
					piped,
					env: {
						HOME: home,
						LC_ALL: locale,
						SUPERAGENT_RELEASE_URL: base('v1'),
					},
				});
				const how = piped ? 'piped' : 'as a file';
				if (result.code !== 0) {
					problems.push(
						`${how}: exit ${result.code}, ${lastLine(result.stderr)}`,
					);
				} else if (
					!result.stdout.includes(`Installed superagent 1.2.3 in ${dest}`) ||
					!isExecutable(dest)
				) {
					problems.push(`${how}: ${lastLine(result.stdout)}`);
				}
			}
			check(
				`${shell.join(' ')}, ${locale} locale: installs piped and run as a file`,
				problems.length === 0,
				problems.join('; '),
			);
		}
	}

	const home = folder();
	const dest = join(home, '.local', 'bin', 'superagent');
	const env = { HOME: home, SUPERAGENT_RELEASE_URL: base('v1') };
	const first = await install({ env });
	check(
		"a fresh install says ~/.local/bin isn't on PATH, without SHELL set",
		first.code === 0 &&
			first.stdout.includes(`${home}/.local/bin isn't on your PATH`) &&
			first.stdout.includes("your shell's startup file") &&
			first.stdout.includes(`paste your Particle API key:\n  ${dest}\n`),
		lastLine(first.stderr),
	);
	const again = await install({ env: { ...env, SHELL: '/bin/zsh' } });
	check(
		'installing the same version again reinstalls it',
		again.code === 0 &&
			again.stdout.includes('superagent 1.2.3 is already the latest') &&
			again.stdout.includes('~/.zshrc'),
		lastLine(again.stdout),
	);
	const update = await install({
		env: { ...env, SUPERAGENT_RELEASE_URL: base('v2') },
	});
	check(
		'a newer release updates it',
		update.code === 0 &&
			update.stdout.includes('Updated superagent 1.2.3 → 1.2.4') &&
			Bun.spawnSync([dest, '--version']).stdout.toString().trim() === '1.2.4',
		lastLine(update.stdout),
	);

	const dryHome = folder();
	const dryEnv = await install({
		env: {
			HOME: dryHome,
			SUPERAGENT_DRY_RUN: '1',
			SUPERAGENT_VERSION: 'v9.9.9',
		},
	});
	check(
		'SUPERAGENT_DRY_RUN with SUPERAGENT_VERSION names that release and changes nothing',
		dryEnv.code === 0 &&
			dryEnv.stdout.includes(
				'Would download https://github.com/shlokdesai33/superagent/releases/download/v9.9.9/superagent-',
			) &&
			readdirSync(dryHome).length === 0,
		lastLine(dryEnv.stdout),
	);
	const dryArg = await install({ args: ['--dry-run'], env: { HOME: dryHome } });
	check(
		'sh -s -- --dry-run, piped, names the latest release and changes nothing',
		dryArg.code === 0 &&
			dryArg.stdout.includes('releases/latest/download/superagent-') &&
			readdirSync(dryHome).length === 0,
		lastLine(dryArg.stdout),
	);
	const dryUpdate = await install({
		args: ['--dry-run'],
		piped: false,
		env,
	});
	check(
		'a dry run over an install names the version it would replace',
		dryUpdate.code === 0 && dryUpdate.stdout.includes('(replacing 1.2.4)'),
		lastLine(dryUpdate.stdout),
	);

	const bin = join(folder(), 'tools');
	const elsewhere = await install({
		env: {
			SUPERAGENT_INSTALL_DIR: bin,
			SUPERAGENT_RELEASE_URL: base('v1'),
			PATH: `${bin}:${process.env.PATH}`,
		},
	});
	check(
		'SUPERAGENT_INSTALL_DIR on PATH, without HOME: installs there and runs it by name',
		elsewhere.code === 0 &&
			elsewhere.stdout.includes(
				`Installed superagent 1.2.3 in ${bin}/superagent`,
			) &&
			elsewhere.stdout.includes(
				'paste your Particle API key:\n  superagent\n',
			) &&
			!elsewhere.stdout.includes("isn't on your PATH"),
		lastLine(elsewhere.stderr),
	);
	const noHome = await install({
		env: { SUPERAGENT_RELEASE_URL: base('v1') },
	});
	check(
		"without HOME or SUPERAGENT_INSTALL_DIR it says what's missing",
		noHome.code === 1 && noHome.stderr.includes("HOME isn't set"),
		lastLine(noHome.stderr),
	);
	const unknown = await install({ args: ['--nope'], env: { HOME: folder() } });
	check(
		'an unknown option is refused',
		unknown.code === 1 && unknown.stderr.includes('unknown option --nope'),
		lastLine(unknown.stderr),
	);

	for (const [release, error, name] of [
		['tampered', "doesn't match its checksum", 'a checksum mismatch'],
		['broken', "doesn't run on this machine", "an executable that doesn't run"],
		['missing', "couldn't download", 'a missing release'],
	] as const) {
		const failHome = folder();
		const temp = folder();
		// oxlint-disable-next-line eslint/no-await-in-loop
		const failed = await install({
			env: {
				HOME: failHome,
				TMPDIR: temp,
				SUPERAGENT_RELEASE_URL: base(release),
			},
		});
		const target = join(failHome, '.local', 'bin');
		check(
			`${name} installs nothing and leaves no temp folder`,
			failed.code === 1 &&
				failed.stderr.includes(error) &&
				(!existsSync(target) || readdirSync(target).length === 0) &&
				readdirSync(temp).length === 0,
			lastLine(failed.stderr),
		);
	}

	// Ctrl-C reaches the shell and the download alike.
	const slowHome = folder();
	const temp = folder();
	const slow = start({
		env: { HOME: slowHome, TMPDIR: temp, SUPERAGENT_RELEASE_URL: base('slow') },
	});
	const deadline = Date.now() + 10_000;
	const downloading = () =>
		readdirSync(temp).some((dir) => readdirSync(join(temp, dir)).length > 0);
	while (!downloading() && Date.now() < deadline) {
		// oxlint-disable-next-line eslint/no-await-in-loop
		await Bun.sleep(50);
	}
	slow.kill('SIGINT');
	Bun.spawnSync(['pkill', '-INT', '-P', String(slow.pid)]);
	const interrupted = await finish(slow);
	check(
		'Ctrl-C mid-download stops the script, installs nothing and removes its temp folder',
		interrupted.code === 130 &&
			!interrupted.stdout.includes('Installed') &&
			!existsSync(join(slowHome, '.local')) &&
			readdirSync(temp).length === 0,
		`exit ${interrupted.code}, ${lastLine(interrupted.stderr)}`,
	);
} catch (error) {
	failures += 1;
	process.stdout.write(
		`✗ ${error instanceof Error ? error.message : String(error)}\n`,
	);
} finally {
	await server.stop(true);
	if (!keep) {
		for (const path of folders) rmSync(path, { recursive: true, force: true });
	}
}

process.stdout.write(
	failures === 0 ? '\nAll checks passed.\n' : `\n${failures} failed.\n`,
);
process.exitCode = failures === 0 ? 0 : 1;
