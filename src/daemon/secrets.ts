import { API_KEY_ENV } from '../particle/client.ts';

/** Environment variables that hold the agent's own keys. */
const SECRET_ENV = [API_KEY_ENV];

/**
 * Adds keys to the agent's own, which never reach Worker commands, the model,
 * the feed, the TUI or the log.
 */
export function addSecrets(
	secrets: string[],
	keys: Array<string | null>,
): void {
	for (const key of keys) {
		if (key && !secrets.includes(key)) secrets.push(key);
	}
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
