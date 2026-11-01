import { expect, test } from 'bun:test';
import { SandboxManager } from '@anthropic-ai/sandbox-runtime';

test('sandbox-runtime loads under Bun and supports this platform', () => {
	expect(SandboxManager.isSupportedPlatform()).toBe(true);
	expect(SandboxManager.isSandboxingEnabled()).toBe(false);
});
