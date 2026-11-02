// Test-only: end-to-end runs shrink every Watchdog duration with this.
const SCALE = Number(Bun.env.SUPERAGENT_WATCHDOG_SCALE) || 1;

/** A Watchdog duration in milliseconds, scaled for tests. */
export function watchdogMs(ms: number): number {
	return Math.max(1, Math.round(ms * SCALE));
}
