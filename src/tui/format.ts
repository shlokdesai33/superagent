/** A row's age: `9s`, `61m`, `5h`, `2d`. */
export function age(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 120) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** A step's duration: `38s`, `1m 4s`, `1h 3m`. */
export function duration(ms: number): string {
	const seconds = Math.max(0, Math.floor(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function ago(ms: number): string {
	return `${age(ms)} ago`;
}

/** Local time, `15:27`. */
export function clock(at: number): string {
	return new Date(at).toTimeString().slice(0, 5);
}

/** `850`, `1.1k`, `12k`, `1.2M`. */
export function tokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${trim(count / 1000)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${trim(count / 1_000_000)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

function trim(value: number): string {
	return value.toFixed(1).replace(/\.0$/, '');
}

export function plural(count: number, one: string, many = `${one}s`): string {
	return count === 1 ? one : many;
}
