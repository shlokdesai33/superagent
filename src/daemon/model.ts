import {
	API_KEY_ENV,
	type ChatResult,
	type ParticleClient,
	ParticleError,
	checkApiKey,
	createParticleClient,
} from '../particle/client.ts';
import { estimateCostUsd } from '../particle/cost.ts';
import type { ChatRequest } from '../particle/types.ts';
import type { KeySource } from '../protocol.ts';
import { readKeyFile } from '../keys.ts';
import { watchdogMs } from './scale.ts';
import { addSecrets } from './secrets.ts';
import {
	type Daemon,
	type Params,
	health,
	setModelHealth,
	usageChanged,
} from './state.ts';

// Particle publishes no rate limit and advises capping concurrency.
const MAX_CALLS_IN_FLIGHT = 6;

const KEY_POLL_MS = 2_000;
const PROBE_MS = watchdogMs(2 * 60_000);

export const NO_API_KEY = `No Particle API key: run superagent login particle, or set ${API_KEY_ENV}`;
export const REJECTED_KEY = 'Particle rejected the API key';
/** How often every loop tries Particle again after an account failure; shorter in tests. */
export const ACCOUNT_RETRY_MS =
	Number(Bun.env.SUPERAGENT_PARTICLE_RETRY_MS) || 2 * 60_000;

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

export type FoundKey = {
	key: string | null;
	source: KeySource;
	/** Every key found, including a key file that `PARTICLE_API_KEY` overrides. */
	found: string[];
	/** Why the key file couldn't be read, when it couldn't. */
	problem: string | null;
};

/** `PARTICLE_API_KEY` wins over the key file. */
export function findParticleKey(keyFile: string): FoundKey {
	const env = Bun.env[API_KEY_ENV]?.trim() || null;
	let file: string | null = null;
	let problem: string | null = null;
	try {
		file = readKeyFile(keyFile);
	} catch (error) {
		problem = `Couldn't read ${keyFile}: ${error instanceof Error ? error.message : String(error)}`;
	}
	return {
		key: env ?? file,
		source: env !== null ? 'env' : file !== null ? 'file' : 'missing',
		found: [env, file].filter((key) => key !== null),
		problem,
	};
}

export function particleClient(apiKey: string): ParticleClient {
	const baseUrl = Bun.env.PARTICLE_BASE_URL;
	return createParticleClient(baseUrl ? { apiKey, baseUrl } : { apiKey });
}

/**
 * Reads the key again. A changed key replaces the client for the next call;
 * a key appearing resumes the model and wakes the Router and Workers, and one
 * disappearing pauses it.
 */
export function refreshParticleKey(daemon: Daemon): void {
	const { key, source, found, problem } = findParticleKey(
		daemon.paths.particleKey,
	);
	addSecrets(daemon.secrets, found);
	if (key === daemon.particleKey) {
		if (key === null) setModelHealth(daemon, 'paused', problem ?? NO_API_KEY);
		return;
	}
	const had = daemon.particleKey !== null;
	daemon.particleKey = key;
	daemon.keySource = source;
	daemon.particle = key === null ? null : particleClient(key);
	daemon.log(
		key === null ? 'warn' : 'info',
		key === null
			? 'Particle key gone'
			: had
				? 'Particle key changed'
				: 'Particle key found',
		problem === null ? { source } : { source, problem },
	);
	const before = daemon.model;
	if (key === null) setModelHealth(daemon, 'paused', problem ?? NO_API_KEY);
	else if (!had) setModelHealth(daemon, 'ok', null);
	// `setModelHealth` publishes only a changed state; the key source changed.
	if (daemon.model === before) {
		daemon.feed.publish({ type: 'health', health: health(daemon) });
	}
	// A replaced key also ends the Router's pause after an account failure.
	if (key !== null) daemon.router.wake();
	if (key !== null && !had) {
		for (const live of daemon.workers.values()) live.wake();
	}
}

/**
 * Re-reads the key every 2 seconds, so a model paused without one resumes,
 * and probes Particle every 2 minutes while it's failing.
 */
export function watchParticleKey(daemon: Daemon): () => void {
	const timer = setInterval(() => refreshParticleKey(daemon), KEY_POLL_MS);
	let probing = false;
	const probe = setInterval(() => {
		if (probing) return;
		probing = true;
		void probeParticle(daemon).finally(() => {
			probing = false;
		});
	}, PROBE_MS);
	return () => {
		clearInterval(timer);
		clearInterval(probe);
	};
}

/**
 * While Particle is failing and nothing has succeeded, asks `GET /models`,
 * which spends no tokens or credits. Leaving `error` wakes the Workers waiting
 * on Particle and the Router's backoff (`setModelHealth`).
 */
async function probeParticle(daemon: Daemon): Promise<void> {
	const { particleKey } = daemon;
	if (particleKey === null || daemon.model.state !== 'error') return;
	const baseUrl = Bun.env.PARTICLE_BASE_URL;
	const check = await checkApiKey(
		baseUrl ? { apiKey: particleKey, baseUrl } : { apiKey: particleKey },
	);
	// A call may have settled it, or the key changed, while the probe ran.
	if (daemon.model.state !== 'error' || daemon.particleKey !== particleKey) {
		return;
	}
	if (check.result === 'valid') {
		daemon.log('info', 'Particle answers again');
		setModelHealth(daemon, 'ok', null);
	} else if (check.result === 'rejected') {
		setModelHealth(
			daemon,
			'paused',
			REJECTED_KEY,
			'run superagent login particle with a working key',
		);
	}
}

export type ModelCall = {
	/** `null` for a Watchdog review, which has no session. */
	sessionId: number | null;
	taskId: number | null;
	purpose: 'router' | 'worker' | 'compaction' | 'watchdog';
	request: ChatRequest;
	signal: AbortSignal;
};

/**
 * Makes one Chat Completions call and records it in `model_calls`. A failure
 * becomes a `ModelError` and shows in the model's health; a success clears it.
 * Only a call made with the current key changes health, and an account
 * failure with a key replaced meanwhile is tried again with the new one. An
 * aborted call rethrows the abort reason.
 */
export async function callModel(
	daemon: Daemon,
	call: ModelCall,
): Promise<ChatResult> {
	// The Router's calls (no task) are never queued; it makes one at a time.
	const worker = call.taskId !== null;
	if (worker) await takeWorkerCall(daemon, call.signal);
	try {
		for (;;) {
			refreshParticleKey(daemon);
			const { particle } = daemon;
			if (particle === null) throw new ModelError(NO_API_KEY, 'account');
			try {
				// oxlint-disable-next-line eslint/no-await-in-loop
				return await chat(daemon, particle, call);
			} catch (error) {
				// The key was replaced during the call, so try the new one.
				const stale =
					error instanceof ModelError &&
					error.failure === 'account' &&
					!call.signal.aborted &&
					daemon.particle !== particle;
				if (!stale) throw error;
			}
		}
	} finally {
		if (worker) {
			daemon.calls.workers -= 1;
			for (const waiter of daemon.calls.waiters) waiter();
		}
	}
}

/** Waits for one of the 5 Worker calls; the 6th is kept for the Router. */
async function takeWorkerCall(
	daemon: Daemon,
	signal: AbortSignal,
): Promise<void> {
	while (daemon.calls.workers >= MAX_CALLS_IN_FLIGHT - 1) {
		signal.throwIfAborted();
		// oxlint-disable-next-line eslint/no-await-in-loop
		await new Promise<void>((resolve) => {
			const done = () => {
				daemon.calls.waiters.delete(done);
				signal.removeEventListener('abort', done);
				resolve();
			};
			daemon.calls.waiters.add(done);
			signal.addEventListener('abort', done, { once: true });
		});
	}
	signal.throwIfAborted();
	daemon.calls.workers += 1;
}

/** What a paused Worker shows it's waiting on. */
export function pausedOn(error: ModelError): string {
	const status =
		error.cause instanceof ParticleError ? error.cause.status : null;
	if (status === 401) return 'Particle (API key rejected)';
	if (status === 402) return 'Particle (out of credit)';
	if (status === 403) return 'Particle (API key not allowed)';
	return 'Particle (no API key)';
}

async function chat(
	daemon: Daemon,
	particle: ParticleClient,
	call: ModelCall,
): Promise<ChatResult> {
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
			detail: error instanceof Error ? error.message : String(error),
			requestId,
		});
		// A call made with a key that has since changed says nothing about the
		// current one; each key change makes a new client.
		if (daemon.particle === particle) {
			setModelHealth(
				daemon,
				failure === 'account' ? 'paused' : 'error',
				detail,
				failure === 'account' ? accountFix(error) : null,
			);
		}
		throw new ModelError(detail, failure, { cause: error });
	}
	record(daemon, call, startedAt, { result });
	if (daemon.particle === particle) setModelHealth(daemon, 'ok', null);
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
					usage,
					serviceTier: result.serviceTier,
					at: new Date(startedAt),
				})
			: null;
	daemon.db
		.query<unknown, Params>(
			`INSERT INTO model_calls (session_id, task_id, purpose, effort, started_at,
				ended_at, prompt_tokens, cached_tokens, completion_tokens, reasoning_tokens,
				service_tier, cost_usd, request_id, error)
			VALUES ($sessionId, $taskId, $purpose, $effort, $startedAt,
				$endedAt, $promptTokens, $cachedTokens, $completionTokens, $reasoningTokens,
				$serviceTier, $costUsd, $requestId, $error)`,
		)
		.run({
			sessionId: call.sessionId,
			taskId: call.taskId,
			purpose: call.purpose,
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
		if (error.status === 401) return REJECTED_KEY;
		if (error.status === 402) return 'Particle account is out of credit';
		if (error.status === 403) {
			return "Particle's API key isn't allowed to use chat completions";
		}
	}
	return `Particle call failed: ${text}`;
}

/** What the operator does about an account failure; the health screen shows it. */
function accountFix(error: unknown): string {
	const status = error instanceof ParticleError ? error.status : null;
	if (status === 402) {
		return 'add credit on the Billing page at https://platform.particle.ai';
	}
	if (status === 403) {
		return 'create a key that can use chat completions at https://platform.particle.ai, then run superagent login particle';
	}
	return 'run superagent login particle with a working key';
}
