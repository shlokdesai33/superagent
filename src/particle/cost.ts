import type { Usage } from './types.ts';

// particle-1's default peak prices in USD per million tokens; accounts may
// have overrides.
const INPUT_USD_PER_MILLION = 0.25;
const CACHED_INPUT_USD_PER_MILLION = 0.03;
const OUTPUT_USD_PER_MILLION = 1;

/** Per successful hosted web search, with no Flex discount. */
export const WEB_SEARCH_PRICE_USD = 0.0025;

const newYorkTime = new Intl.DateTimeFormat('en-US', {
	timeZone: 'America/New_York',
	hour: 'numeric',
	minute: 'numeric',
	hourCycle: 'h23',
});

/** Off-peak is 20:30 to 04:00 New York time, following daylight saving. */
export function isOffPeak(at: Date): boolean {
	const parts = newYorkTime.formatToParts(at);
	const hour = Number(parts.find((part) => part.type === 'hour')?.value);
	const minute = Number(parts.find((part) => part.type === 'minute')?.value);
	const minutes = hour * 60 + minute;
	return minutes >= 20 * 60 + 30 || minutes < 4 * 60;
}

/**
 * Estimates what one response cost. Particle picks the pricing period itself
 * and doesn't report it, so `at` (when the request was sent) is a guess near
 * the boundaries; the settled charge is in Particle's usage records.
 */
export function estimateCostUsd(input: {
	usage: Usage;
	/** The tier that actually ran, from the result. */
	serviceTier: string | null;
	at: Date;
	webSearches?: number;
}): number {
	const cached = input.usage.prompt_tokens_details.cached_tokens;
	const uncached = input.usage.prompt_tokens - cached;
	const tokens =
		uncached * INPUT_USD_PER_MILLION +
		cached * CACHED_INPUT_USD_PER_MILLION +
		input.usage.completion_tokens * OUTPUT_USD_PER_MILLION;
	const discount =
		(isOffPeak(input.at) ? 0.5 : 1) * (input.serviceTier === 'flex' ? 0.5 : 1);
	return (
		(tokens / 1_000_000) * discount +
		(input.webSearches ?? 0) * WEB_SEARCH_PRICE_USD
	);
}
