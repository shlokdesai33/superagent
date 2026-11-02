import { appendFileSync, renameSync, statSync } from 'node:fs';

const MAX_LOG_BYTES = 10 * 1024 * 1024;

export type LogLevel = 'info' | 'warn' | 'error';

export type Log = (
	level: LogLevel,
	message: string,
	fields?: Record<string, unknown>,
) => void;

/**
 * Writes JSON lines to `path`, and a readable line to stderr unless `mirror`
 * is off. When the file passes 10 MB it becomes `<path>.1`, replacing the
 * previous old file.
 */
export function createLog(path: string, mirror = true): Log {
	let size = fileSize(path);
	return (level, message, fields = {}) => {
		const at = new Date();
		const line = `${JSON.stringify({ at: at.toISOString(), level, message, ...fields })}\n`;
		if (size > MAX_LOG_BYTES) {
			renameSync(path, `${path}.1`);
			size = 0;
		}
		appendFileSync(path, line);
		size += Buffer.byteLength(line);
		if (!mirror) return;

		const details = Object.entries(fields)
			.map(([key, value]) => ` ${key}=${JSON.stringify(value)}`)
			.join('');
		process.stderr.write(
			`${at.toTimeString().slice(0, 8)} ${level.padEnd(5)} ${message}${details}\n`,
		);
	};
}

function fileSize(path: string): number {
	try {
		return statSync(path).size;
	} catch {
		return 0;
	}
}
