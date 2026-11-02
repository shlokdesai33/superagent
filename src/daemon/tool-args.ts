import type { FunctionTool, JsonObject } from '../particle/types.ts';

/** A problem with a tool call that goes back to the model as `error: …`. */
export class ToolError extends Error {
	override name = 'ToolError';
}

export type Args = Record<string, unknown>;

// Every schema is sent on every call: leave out a description the name
// already says.
const typed = (type: string, description?: string): JsonObject =>
	description === undefined ? { type } : { type, description };
export const string = (description?: string) => typed('string', description);
export const integer = (description?: string) => typed('integer', description);
export const strings = (description?: string): JsonObject => ({
	...typed('array', description),
	items: { type: 'string' },
});

export function tool(
	name: string,
	description: string,
	properties: Record<string, JsonObject>,
	required: string[],
): FunctionTool {
	return {
		type: 'function',
		function: {
			name,
			description,
			parameters:
				required.length > 0
					? { type: 'object', properties, required }
					: { type: 'object', properties },
		},
	};
}

/** Particle doesn't enforce tool schemas, so arguments are checked by hand. */
export function parseArgs(raw: string): Args {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw || '{}');
	} catch {
		throw new ToolError("arguments aren't valid JSON");
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new ToolError('arguments must be a JSON object');
	}
	return { ...parsed };
}

export function requiredString(args: Args, name: string): string {
	const value = args[name];
	if (typeof value !== 'string' || value.trim() === '') {
		throw new ToolError(`${name} must be a non-empty string`);
	}
	return value;
}

export function optionalString(args: Args, name: string): string | null {
	const value = args[name];
	if (value === undefined || value === null || value === '') return null;
	if (typeof value !== 'string') {
		throw new ToolError(`${name} must be a string`);
	}
	return value;
}

/** A string at most `max` characters long, refused rather than cut. */
export function limitedString(args: Args, name: string, max: number): string {
	const value = requiredString(args, name).trim();
	if (value.length > max) {
		throw new ToolError(
			`${name} has ${value.length} characters; the limit is ${max}. Shorten it.`,
		);
	}
	return value;
}

// Models often send numbers as strings, or event numbers as `#42`.
export function optionalInteger(args: Args, name: string): number | null {
	const value = args[name];
	if (value === undefined || value === null || value === '') return null;
	const number =
		typeof value === 'string' && /^#?\d+$/.test(value.trim())
			? Number(value.trim().replace('#', ''))
			: value;
	if (
		typeof number !== 'number' ||
		!Number.isSafeInteger(number) ||
		number < 0
	) {
		throw new ToolError(`${name} must be a whole number`);
	}
	return number;
}

export function requiredInteger(args: Args, name: string): number {
	const value = optionalInteger(args, name);
	if (value === null) throw new ToolError(`${name} is required`);
	return value;
}

export function optionalStrings(args: Args, name: string): string[] {
	const value = args[name];
	if (value === undefined || value === null) return [];
	if (
		!Array.isArray(value) ||
		!value.every((item): item is string => typeof item === 'string')
	) {
		throw new ToolError(`${name} must be a list of strings`);
	}
	return value;
}
