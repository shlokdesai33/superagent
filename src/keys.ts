import {
	chmodSync,
	closeSync,
	fsyncSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	writeSync,
} from 'node:fs';

/**
 * The key in a key file, or `null` when there's no file or it's empty. A file
 * others can read is narrowed to `0600` first.
 */
export function readKeyFile(path: string): string | null {
	let text: string;
	try {
		if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
		text = readFileSync(path, 'utf8');
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return null;
		}
		throw error;
	}
	return text.trim() || null;
}

/** Replaces a key file in one rename, so readers see the old key or the new one. */
export function writeKeyFile(path: string, key: string): void {
	const temporary = `${path}.${process.pid}.tmp`;
	rmSync(temporary, { force: true });
	try {
		const fd = openSync(temporary, 'wx', 0o600);
		try {
			writeSync(fd, `${key}\n`);
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		renameSync(temporary, path);
	} catch (error) {
		rmSync(temporary, { force: true });
		throw error;
	}
}
