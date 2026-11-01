import {
	API_KEY_ENV,
	type ChatResult,
	type ParticleClient,
	ParticleError,
	createParticleClient,
} from '../particle/client.ts';
import { estimateCostUsd } from '../particle/cost.ts';
import type { ChatRequest } from '../particle/types.ts';
import type { Config } from './setup.ts';
import {
	type Daemon,
	type Params,
	setModelHealth,
	usageChanged,
} from './state.ts';

export const NO_API_KEY = `No Particle API key: set ${API_KEY_ENV} or particleApiKey in config.json, then restart the agent`;

/**
 * - `account`: fixed by the person (401, 402, 403); every loop pauses.
 * - `request`: the same request will fail again (400, 404, 413, invalid output).
 * - `transient`: anything else, after the client's own retries.
 */
export type ModelFailure = 'account' | 'request' | 'transient';

export class ModelError extends Error {
	override name = 'ModelError';
	readonly failure: ModelFailure;

	constructor(message: string, failure: ModelFailure, options?: ErrorOptions) {
		super(message, options);
		this.failure = failure;
	}
}

/** `PARTICLE_API_KEY` wins over `particleApiKey` in the config. */
export function createModelClient(config: Config): ParticleClient | null {
	const apiKey = Bun.env[API_KEY_ENV] || config.particleApiKey;
	if (!apiKey) return null;
	const baseUrl = Bun.env.PARTICLE_BASE_URL;
	return createParticleClient(baseUrl ? { apiKey, baseUrl } : { apiKey });
}

export type ModelCall = {
	sessionId: number;
	taskId: number | null;
	purpose: 'router' | 'worker' | 'compaction';
	request: ChatRequest;
	signal: AbortSignal;
};

/**
 * Makes one Chat Completions call and records it in `model_calls`. A failure
 * becomes a `ModelError` and shows in the model's health; a success clears it.
 * An aborted call rethrows the abort reason.
 */
export async function callModel(
	daemon: Daemon,
	call: ModelCall,
): Promise<ChatResult> {
	const { particle } = daemon;
	if (particle === null) throw new ModelError(NO_API_KEY, 'account');
	const startedAt = Date.now();
	let result: ChatResult;
	try {
		result = await particle.chat(call.request, { signal: call.signal });
	} catch (error) {
		const requestId = error instanceof ParticleError ? error.requestId : null;
		if (call.signal.aborted) {
			record(daemon, call, startedAt, { error: 'aborted', requestId });
			throw error;
		}
		const text = errorText(error);
		record(daemon, call, startedAt, { error: text, requestId });
		const failure = classify(error);
		const detail = describe(error, text);
		daemon.log('warn', 'model call failed', {
			purpose: call.purpose,
			error: text,
			message: error instanceof Error ? error.message : String(error),
			requestId,
		});
		setModelHealth(daemon, failure === 'account' ? 'paused' : 'error', detail);
		throw new ModelError(detail, failure, { cause: error });
	}
	record(daemon, call, startedAt, { result });
	setModelHealth(daemon, 'ok', null);
	return result;
}

function record(
	daemon: Daemon,
	call: ModelCall,
	startedAt: number,
	outcome: { result: ChatResult } | { error: string; requestId: string | null },
): void {
	const endedAt = Date.now();
	const result = 'result' in outcome ? outcome.result : null;
	const usage = result?.usage ?? null;
	const costUsd =
		result && usage
			? estimateCostUsd({
					model: call.request.model,
					usage,
					serviceTier: result.serviceTier,
					at: new Date(startedAt),
				})
			: null;
	daemon.db
		.query<unknown, Params>(
			`INSERT INTO model_calls (session_id, task_id, purpose, model, effort, started_at,
				ended_at, prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens,
				service_tier, cost_usd, request_id, error)
			VALUES ($sessionId, $taskId, $purpose, $model, $effort, $startedAt,
				$endedAt, $promptTokens, $cachedTokens, $completionTokens, $reasoningTokens,
				$serviceTier, $costUsd, $requestId, $error)`,
		)
		.run({
			sessionId: call.sessionId,
			taskId: call.taskId,
			purpose: call.purpose,
			model: call.request.model,
			effort: call.request.reasoning_effort,
			startedAt,
			endedAt,
			promptTokens: usage?.prompt_tokens ?? null,
			cachedTokens: usage?.prompt_tokens_details.cached_tokens ?? null,
			completionTokens: usage?.completion_tokens ?? null,
			reasoningTokens:
				usage?.completion_tokens_details.reasoning_tokens ?? null,
			serviceTier: result?.serviceTier ?? null,
			costUsd,
			requestId:
				'result' in outcome ? outcome.result.requestId : outcome.requestId,
			error: 'error' in outcome ? outcome.error : null,
		});
	usageChanged(daemon);
	if (result) {
		daemon.log('info', 'model call', {
			purpose: call.purpose,
			ms: endedAt - startedAt,
			promptTokens: usage?.prompt_tokens ?? null,
			cachedTokens: usage?.prompt_tokens_details.cached_tokens ?? null,
			completionTokens: usage?.completion_tokens ?? null,
			costUsd,
			finish: result.finishReason,
			requestId: result.requestId,
		});
	}
}

function classify(error: unknown): ModelFailure {
	if (!(error instanceof ParticleError)) return 'transient';
	const { status, code } = error;
	if (status === 401 || status === 402 || status === 403) return 'account';
	if (
		status === 400 ||
		status === 404 ||
		status === 413 ||
		code === 'invalid_model_output'
	) {
		return 'request';
	}
	return 'transient';
}

/** The short form stored in `model_calls.error`: `429 fleet_capacity_exhausted`. */
function errorText(error: unknown): string {
	if (!(error instanceof ParticleError)) {
		return error instanceof Error ? error.message : String(error);
	}
	return [error.status ?? error.kind, error.code].filter(Boolean).join(' ');
}

/** What the TUI shows as the model's health. */
function describe(error: unknown, text: string): string {
	if (error instanceof ParticleError) {
		if (error.status === 401) return 'Particle rejected the API key';
		if (error.status === 402) return 'Particle account is out of credits';
		if (error.status === 403) {
			return "Particle's API key isn't allowed to use chat completions";
		}
	}
	return `Particle call failed: ${text}`;
}
