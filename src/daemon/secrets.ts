import { API_KEY_ENV } from '../particle/client.ts';
import type { Config } from './setup.ts';

/** Environment variables that hold the agent's own keys. */
const SECRET_ENV = [API_KEY_ENV];

/**
 * The agent's own keys. They never reach Worker commands, the model, the
 * feed, the TUI or the log.
 */
export function agentSecrets(config: Config): string[] {
	return [Bun.env[API_KEY_ENV], config.particleApiKey].filter(
		(key): key is string => Boolean(key),
	);
}

/** The daemon's environment without the agent's keys, by name or by value. */
export function envWithoutSecrets(
	secrets: string[],
): Record<string, string | undefined> {
	return Object.fromEntries(
		Object.entries(Bun.env).filter(
			([name, value]) =>
				!SECRET_ENV.includes(name) &&
				(value === undefined || !secrets.includes(value)),
		),
	);
}

/** `text` with every agent key replaced by `[redacted]`. */
export function redact(secrets: string[], text: string): string {
	let out = text;
	for (const secret of secrets) out = out.replaceAll(secret, '[redacted]');
	return out;
}
