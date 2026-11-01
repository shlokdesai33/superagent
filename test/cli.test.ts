import { describe, expect, test } from 'bun:test';
import packageJson from '../package.json' with { type: 'json' };
import { run, usage } from '../src/cli.ts';

describe('superagent CLI', () => {
	test('--version prints the package version', () => {
		expect(run(['--version'])).toEqual({
			exitCode: 0,
			stdout: packageJson.version,
		});
		expect(run(['-v'])).toEqual(run(['--version']));
	});

	test('--help, and no arguments, print usage', () => {
		expect(run(['--help'])).toEqual({ exitCode: 0, stdout: usage });
		expect(run(['-h'])).toEqual(run(['--help']));
		expect(run([])).toEqual(run(['--help']));
	});

	test('unknown arguments fail with usage on stderr', () => {
		const result = run(['--nope']);
		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBeUndefined();
		expect(result.stderr).toStartWith('Unknown option: --nope');
		expect(result.stderr).toEndWith(usage);
		expect(run(['--help', 'extra']).exitCode).toBe(1);
	});

	test('the entry point runs under Bun', async () => {
		const proc = Bun.spawn([process.execPath, 'src/cli.ts', '--version'], {
			stdout: 'pipe',
		});
		expect(await proc.stdout.text()).toBe(`${packageJson.version}\n`);
		expect(await proc.exited).toBe(0);
	});
});
