// Retries and stream reads are sequential by nature.
/* oxlint-disable eslint/no-await-in-loop */
import { readSseData } from './sse.ts';
import type {
	AssistantMessage,
	ChatCompletion,
	ChatCompletionChunk,
	ChatRequest,
	ErrorBody,
	FinishReason,
	ToolCall,
	Usage,
	WireUsage,
} from './types.ts';

/** The only model the agent will ever support; every request sends it. */
export const MODEL = 'particle-1';
export const API_KEY_ENV = 'PARTICLE_API_KEY';
export const DEFAULT_BASE_URL = 'https://api.particle.ai/v1';

// Particle ends a request after 1,800 s with a 504; stay above that so its
// answer, not ours, decides.
const DEFAULT_TIMEOUT_MS = 1_860_000;
// Particle sends a keep-alive at least every 15 s while streaming, so this much
// silence means the connection is dead.
const STREAM_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 3;
const BACKOFF_MS = { base: 1_000, cap: 30_000 };
// Particle asks for minutes of backoff when particle-1 has no healthy servers.
const UNAVAILABLE_BACKOFF_MS = { base: 60_000, cap: 300_000 };
const MAX_RETRY_AFTER_MS = 300_000;

const RETRYABLE_CODES = new Set([
	'fleet_capacity_exhausted',
	'internal_error',
	'invalid_upstream_response',
	'model_unavailable',
	'billing_unavailable',
	'usage_tracking_unavailable',
	'upstream_response_deadline_exceeded',
]);

export type ParticleClientOptions = {
	/** Defaults to `PARTICLE_API_KEY`. */
	apiKey?: string;
	baseUrl?: string;
	/** Retries after the first attempt, for failures before a response. */
	maxRetries?: number;
	/** Deadline for each attempt. */
	timeoutMs?: number;
};

export type ChatDelta = { type: 'reasoning' | 'content'; text: string };

export type ChatOptions = {
	/** Defaults to `true`. */
	stream?: boolean;
	signal?: AbortSignal;
	/** Called with each piece of streamed text, reasoning first. */
	onDelta?: (delta: ChatDelta) => void;
};

export type ChatResult = {
	requestId: string | null;
	id: string;
	/** Ready to append to `messages`. */
	message: AssistantMessage;
	reasoning: string;
	finishReason: FinishReason;
	matchedStop: string | number | null;
	usage: Usage | null;
	/** The tier that actually ran. */
	serviceTier: string | null;
};

export type ParticleClient = {
	chat(request: ChatRequest, options?: ChatOptions): Promise<ChatResult>;
};

/**
 * - `http`: a non-2xx response.
 * - `stream`: an error frame or malformed data inside a 200 response.
 * - `incomplete`: the stream ended without `[DONE]` or a finish reason.
 * - `network`: the connection failed.
 * - `timeout`: the attempt passed `timeoutMs`.
 */
export type ParticleErrorKind =
	| 'http'
	| 'stream'
	| 'incomplete'
	| 'network'
	| 'timeout';

export class ParticleError extends Error {
	override name = 'ParticleError';
	readonly kind: ParticleErrorKind;
	readonly status: number | null;
	readonly code: string | null;
	readonly type: string | null;
	readonly requestId: string | null;
	/**
	 * Whether Particle says resubmitting the same request may succeed. The
	 * client retries only failures before a response; once a stream has
	 * started, its output was delivered and billed, so the caller decides.
	 */
	readonly retryable: boolean;

	constructor(
		message: string,
		fields: {
			kind: ParticleErrorKind;
			status?: number | null;
			code?: string | null;
			type?: string | null;
			requestId?: string | null;
			retryable: boolean;
		},
		options?: ErrorOptions,
	) {
		super(message, options);
		this.kind = fields.kind;
		this.status = fields.status ?? null;
		this.code = fields.code ?? null;
		this.type = fields.type ?? null;
		this.requestId = fields.requestId ?? null;
		this.retryable = fields.retryable;
	}
}

/** Reads the API key from `PARTICLE_API_KEY` unless given one. */
export function createParticleClient(
	options: ParticleClientOptions = {},
): ParticleClient {
	const apiKey = options.apiKey ?? Bun.env[API_KEY_ENV];
	if (!apiKey) throw new Error(`${API_KEY_ENV} is not set`);
	const url = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/chat/completions`;
	const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
	const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	async function chat(
		request: ChatRequest,
		chatOptions: ChatOptions = {},
	): Promise<ChatResult> {
		const stream = chatOptions.stream ?? true;
		const callerSignal = chatOptions.signal;
		const body = JSON.stringify(
			stream
				? {
						...request,
						model: MODEL,
						stream: true,
						stream_options: { include_usage: true },
					}
				: { ...request, model: MODEL, stream: false },
		);

		for (let attempt = 0; ; attempt++) {
			callerSignal?.throwIfAborted();
			const deadline = AbortSignal.timeout(timeoutMs);
			const signal = callerSignal
				? AbortSignal.any([callerSignal, deadline])
				: deadline;
			const fail = (error: unknown, requestId: string | null) =>
				readFailure(error, { callerSignal, deadline, timeoutMs, requestId });

			let response: Response;
			try {
				response = await fetch(url, {
					method: 'POST',
					headers: {
						Authorization: `Bearer ${apiKey}`,
						'Content-Type': 'application/json',
						Accept: stream ? 'text/event-stream' : 'application/json',
					},
					body,
					signal,
					// Non-streaming replies can be silent for up to 1,740 s, longer
					// than Bun's default idle timeout; the deadline covers them.
					timeout: stream ? STREAM_IDLE_TIMEOUT_MS : false,
				});
			} catch (error) {
				const failure = fail(error, null);
				if (
					!(failure instanceof ParticleError) ||
					!failure.retryable ||
					attempt >= maxRetries
				) {
					throw failure;
				}
				await sleep(backoffMs(attempt, null), callerSignal);
				continue;
			}

			const requestId = response.headers.get('x-particle-request-id');
			if (!response.ok) {
				let text: string;
				try {
					text = await response.text();
				} catch (error) {
					throw fail(error, requestId);
				}
				const failure = httpError(response, text, requestId);
				if (!failure.retryable || attempt >= maxRetries) throw failure;
				await sleep(
					retryAfterMs(response.headers) + backoffMs(attempt, failure.code),
					callerSignal,
				);
				continue;
			}

			const headerTier = response.headers.get('x-particle-service-tier');
			return stream
				? readStream(response, requestId, headerTier, chatOptions.onDelta, fail)
				: readCompletion(response, requestId, headerTier, fail);
		}
	}

	return { chat };
}

const KEY_CHECK_TIMEOUT_MS = 15_000;

/** Particle keys are `pai-` and 43 more characters; older `ds-` keys still work. */
export function looksLikeApiKey(key: string): boolean {
	return /^(?:pai|ds)-[\x21-\x7e]+$/.test(key);
}

export type KeyCheck =
	| { result: 'valid' }
	| { result: 'rejected' }
	| { result: 'unchecked'; problem: string };

/** Asks Particle about a key with `GET /models`, which spends no tokens or credits. */
export async function checkApiKey(options: {
	apiKey: string;
	baseUrl?: string;
}): Promise<KeyCheck> {
	const url = `${(options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')}/models`;
	let response: Response;
	try {
		response = await fetch(url, {
			headers: { Authorization: `Bearer ${options.apiKey}` },
			signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS),
		});
		await response.body?.cancel();
	} catch (error) {
		return {
			result: 'unchecked',
			problem: error instanceof Error ? error.message : String(error),
		};
	}
	if (response.ok) return { result: 'valid' };
	if (response.status === 401) return { result: 'rejected' };
	return { result: 'unchecked', problem: `HTTP ${response.status}` };
}

type Fail = (error: unknown, requestId: string | null) => unknown;

async function readStream(
	response: Response,
	requestId: string | null,
	headerTier: string | null,
	onDelta: ChatOptions['onDelta'],
	fail: Fail,
): Promise<ChatResult> {
	if (response.body === null) {
		throw new ParticleError('Particle returned an empty stream', {
			kind: 'incomplete',
			requestId,
			retryable: true,
		});
	}
	const events = readSseData(response.body);
	let id = '';
	let serviceTier: string | null = null;
	let content = '';
	let reasoning = '';
	const toolCalls = new Map<number, ToolCall>();
	let finishReason: FinishReason | null = null;
	let matchedStop: string | number | null = null;
	let usage: Usage | null = null;
	let sawDone = false;

	try {
		for (;;) {
			let next: IteratorResult<string, void>;
			try {
				next = await events.next();
			} catch (error) {
				throw fail(error, requestId);
			}
			if (next.done) break;
			if (next.value === '[DONE]') {
				sawDone = true;
				break;
			}

			const chunk = parseJson(next.value, requestId);
			if (isErrorBody(chunk)) throw errorFrame(chunk, requestId);
			if (!isChunk(chunk)) throw malformed(requestId);
			id ||= chunk.id;
			serviceTier = chunk.service_tier ?? serviceTier;
			if (chunk.usage) usage = toUsage(chunk.usage);

			const choice = chunk.choices[0];
			if (choice === undefined) continue;
			const delta = choice.delta;
			if (delta.reasoning_content) {
				reasoning += delta.reasoning_content;
				onDelta?.({ type: 'reasoning', text: delta.reasoning_content });
			}
			if (delta.content) {
				content += delta.content;
				onDelta?.({ type: 'content', text: delta.content });
			}
			for (const part of delta.tool_calls ?? []) {
				const call = toolCalls.get(part.index) ?? {
					id: '',
					type: 'function',
					function: { name: '', arguments: '' },
				};
				// Particle may send whole calls per chunk or OpenAI-style fragments;
				// concatenating arguments by index handles both.
				if (part.id) call.id = part.id;
				if (part.function?.name) call.function.name = part.function.name;
				call.function.arguments += part.function?.arguments ?? '';
				toolCalls.set(part.index, call);
			}
			if (choice.finish_reason) finishReason = choice.finish_reason;
			matchedStop = choice.matched_stop ?? matchedStop;
		}
	} finally {
		await events.return();
	}

	if (!sawDone || finishReason === null) {
		throw new ParticleError(
			sawDone
				? 'Particle stream finished without a finish_reason'
				: 'Particle stream ended before [DONE]',
			{ kind: 'incomplete', requestId, retryable: true },
		);
	}

	const calls = [...toolCalls.entries()]
		.toSorted(([a], [b]) => a - b)
		.map(([, call]) => call);
	return {
		requestId,
		id,
		message: assistantMessage(content || null, calls),
		reasoning,
		finishReason,
		matchedStop,
		usage,
		serviceTier: serviceTier ?? headerTier,
	};
}

async function readCompletion(
	response: Response,
	requestId: string | null,
	headerTier: string | null,
	fail: Fail,
): Promise<ChatResult> {
	let text: string;
	try {
		text = await response.text();
	} catch (error) {
		throw fail(error, requestId);
	}
	const completion = parseJson(text, requestId);
	if (isErrorBody(completion)) throw errorFrame(completion, requestId);
	if (!isCompletion(completion)) throw malformed(requestId);
	const choice = completion.choices[0];
	if (choice === undefined) {
		throw new ParticleError('Particle returned no choices', {
			kind: 'incomplete',
			requestId,
			retryable: true,
		});
	}
	return {
		requestId,
		id: completion.id,
		message: assistantMessage(
			choice.message.content,
			choice.message.tool_calls ?? [],
		),
		reasoning: choice.message.reasoning_content ?? '',
		finishReason: choice.finish_reason,
		matchedStop: choice.matched_stop ?? null,
		usage: completion.usage ? toUsage(completion.usage) : null,
		serviceTier: completion.service_tier ?? headerTier,
	};
}

function assistantMessage(
	content: string | null,
	toolCalls: ToolCall[],
): AssistantMessage {
	return toolCalls.length > 0
		? { role: 'assistant', content, tool_calls: toolCalls }
		: { role: 'assistant', content };
}

function toUsage(usage: WireUsage): Usage {
	return {
		prompt_tokens: usage.prompt_tokens,
		completion_tokens: usage.completion_tokens,
		total_tokens: usage.total_tokens,
		prompt_tokens_details: {
			cached_tokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
		},
		completion_tokens_details: {
			reasoning_tokens: usage.completion_tokens_details?.reasoning_tokens ?? 0,
		},
	};
}

function parseJson(text: string, requestId: string | null): unknown {
	try {
		return JSON.parse(text) as unknown;
	} catch (error) {
		throw malformed(requestId, error);
	}
}

function malformed(requestId: string | null, cause?: unknown): ParticleError {
	return new ParticleError(
		'Particle sent a malformed response',
		{ kind: 'stream', requestId, retryable: true },
		cause === undefined ? undefined : { cause },
	);
}

function hasChoices(value: unknown): boolean {
	return (
		typeof value === 'object' &&
		value !== null &&
		'choices' in value &&
		Array.isArray(value.choices)
	);
}

function isChunk(value: unknown): value is ChatCompletionChunk {
	return hasChoices(value);
}

function isCompletion(value: unknown): value is ChatCompletion {
	return hasChoices(value);
}

function isErrorBody(value: unknown): value is ErrorBody {
	return (
		typeof value === 'object' &&
		value !== null &&
		'error' in value &&
		typeof value.error === 'object' &&
		value.error !== null
	);
}

function isRetryable(status: number | null, code: string | null): boolean {
	// Billed, and the same prompt is likely to fail the same way.
	if (code === 'invalid_model_output') return false;
	if (code !== null && RETRYABLE_CODES.has(code)) return true;
	return status !== null && (status === 429 || status >= 500);
}

function errorFrame(body: ErrorBody, requestId: string | null): ParticleError {
	const code = body.error.code ?? null;
	return new ParticleError(body.error.message ?? 'Particle stream failed', {
		kind: 'stream',
		code,
		type: body.error.type ?? null,
		requestId,
		retryable: isRetryable(null, code),
	});
}

function httpError(
	response: Response,
	text: string,
	requestId: string | null,
): ParticleError {
	let body: unknown = null;
	try {
		body = JSON.parse(text) as unknown;
	} catch {
		// Not Particle's envelope; handled below.
	}
	if (!isErrorBody(body)) {
		// Particle: errors without its envelope (from proxies, say) are retryable.
		return new ParticleError(
			`Particle returned HTTP ${response.status}: ${text.slice(0, 200)}`,
			{ kind: 'http', status: response.status, requestId, retryable: true },
		);
	}
	const code = body.error.code ?? null;
	return new ParticleError(
		body.error.message ?? `Particle returned HTTP ${response.status}`,
		{
			kind: 'http',
			status: response.status,
			code,
			type: body.error.type ?? null,
			requestId,
			retryable: isRetryable(response.status, code),
		},
	);
}

function readFailure(
	error: unknown,
	context: {
		callerSignal: AbortSignal | undefined;
		deadline: AbortSignal;
		timeoutMs: number;
		requestId: string | null;
	},
): unknown {
	if (context.callerSignal?.aborted) return context.callerSignal.reason;
	if (error instanceof ParticleError) return error;
	if (context.deadline.aborted) {
		return new ParticleError(
			`Particle request passed its ${context.timeoutMs} ms deadline`,
			{ kind: 'timeout', requestId: context.requestId, retryable: false },
			{ cause: error },
		);
	}
	return new ParticleError(
		`Particle connection failed: ${error instanceof Error ? error.message : String(error)}`,
		{ kind: 'network', requestId: context.requestId, retryable: true },
		{ cause: error },
	);
}

function backoffMs(attempt: number, code: string | null): number {
	const { base, cap } =
		code === 'model_unavailable' ? UNAVAILABLE_BACKOFF_MS : BACKOFF_MS;
	const ceiling = Math.min(cap, base * 2 ** attempt);
	return ceiling / 2 + (Math.random() * ceiling) / 2;
}

function retryAfterMs(headers: Headers): number {
	const value = headers.get('retry-after');
	if (value === null) return 0;
	const seconds = Number(value);
	const ms = Number.isFinite(seconds)
		? seconds * 1000
		: Date.parse(value) - Date.now();
	return Number.isNaN(ms) ? 0 : Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		if (signal?.aborted) onAbort();
		else signal?.addEventListener('abort', onAbort, { once: true });
	});
}
