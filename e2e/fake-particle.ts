// A fake Particle Chat Completions server for end-to-end runs (§10). The
// scenario decides each answer; `prompt_cache_key` says which session asks.
import type { ChatRequest, Message } from '../src/particle/types.ts';

export type FakeRequest = {
	session: 'router' | 'worker' | 'compaction' | 'watchdog';
	/** The task handle, for Worker and Worker compaction calls. */
	handle: string | null;
	body: ChatRequest;
	/** User text after the last assistant message: new events or inbox. */
	fresh: string;
	/** Tool results after the last assistant message. */
	results: string[];
	/** Names of every tool called so far in this session. */
	called: string[];
	/** What `usage` reports: the prompt at 4 characters a token. */
	promptTokens: number;
	/** The prefix shared with the session's previous prompt, as Particle's cache would serve it. */
	cachedTokens: number;
};

export type FakeReply = {
	content?: string;
	calls?: Array<{ name: string; args: Record<string, unknown> }>;
	/** The stream ends without a finish reason or `[DONE]`: a dropped connection. */
	broken?: boolean;
	/** Wall time before the answer starts, like a slow model. */
	delayMs?: number;
};

export type FakeParticle = {
	/** For `PARTICLE_BASE_URL`. */
	url: string;
	requests: FakeRequest[];
	/** `GET /models`, which the daemon's probe asks while Particle fails. */
	models: { available: boolean; requests: number };
	/**
	 * `rejected`: every request gets a `401`, as for a revoked key.
	 * `rejectedKeys`: requests with one of these keys do.
	 */
	auth: { rejected: boolean; rejectedKeys: Set<string> };
	/** Chat requests get Particle's `402` (no credit) or `403` (key without the scope). */
	account: { refused: 402 | 403 | null };
	stop(): void;
};

const REFUSALS = {
	402: {
		message: 'Your credit balance is empty. Add credits to continue.',
		type: 'insufficient_credits_error',
		code: 'insufficient_credits',
	},
	403: {
		message: "This API key doesn't have the scope this route requires.",
		type: 'authorization_error',
		code: 'insufficient_scope',
	},
};

export function startFakeParticle(
	respond: (request: FakeRequest) => FakeReply,
): FakeParticle {
	const requests: FakeRequest[] = [];
	const models = { available: true, requests: 0 };
	const auth = { rejected: false, rejectedKeys: new Set<string>() };
	const account: FakeParticle['account'] = { refused: null };
	const lastPrompt = new Map<string, string>();
	let count = 0;
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			const apiKey =
				request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
			if (auth.rejected || auth.rejectedKeys.has(apiKey)) {
				return Response.json(
					{
						error: {
							message: 'Invalid API key',
							type: 'authentication_error',
							code: 'invalid_api_key',
						},
					},
					{ status: 401 },
				);
			}
			if (
				request.method === 'GET' &&
				new URL(request.url).pathname === '/v1/models'
			) {
				models.requests += 1;
				return models.available
					? Response.json({
							object: 'list',
							data: [{ id: 'particle-1', object: 'model' }],
						})
					: Response.json(
							{
								error: {
									message: 'unavailable',
									type: 'server_error',
									code: 'model_unavailable',
								},
							},
							{ status: 503 },
						);
			}
			if (account.refused !== null) {
				return Response.json(
					{ error: REFUSALS[account.refused] },
					{ status: account.refused },
				);
			}
			const body: unknown = await request.json();
			if (!isChatRequest(body)) {
				return new Response('expected a Chat Completions request', {
					status: 400,
				});
			}
			const id = `req-${++count}`;
			// Like the real API: every tool call needs its result first.
			const missing = unansweredCalls(body.messages);
			if (missing.length > 0) {
				return Response.json(
					{
						error: {
							message: `tool calls without results: ${missing.join(', ')}`,
							type: 'invalid_request_error',
							code: 'invalid_request',
						},
					},
					{ status: 400, headers: { 'x-particle-request-id': id } },
				);
			}
			// Like a chat template: tool schemas render ahead of the messages.
			const prompt = `${JSON.stringify(body.tools ?? [])}${JSON.stringify(body.messages)}`;
			const key = body.prompt_cache_key ?? '';
			const cached = sharedPrefix(lastPrompt.get(key) ?? '', prompt);
			lastPrompt.set(key, prompt);
			const fake = describe(body, {
				promptTokens: Math.ceil(prompt.length / 4),
				cachedTokens: Math.floor(cached / 4),
			});
			requests.push(fake);
			const reply = respond(fake);
			if (reply.delayMs) await Bun.sleep(reply.delayMs);
			return stream(id, fake, reply);
		},
	});
	return {
		url: `http://127.0.0.1:${server.port}/v1`,
		requests,
		models,
		auth,
		account,
		stop: () => {
			void server.stop(true);
		},
	};
}

// The daemon is trusted to send the shape its client builds.
function isChatRequest(value: unknown): value is ChatRequest {
	return (
		typeof value === 'object' &&
		value !== null &&
		'messages' in value &&
		Array.isArray(value.messages)
	);
}

function text(message: Message): string {
	if (typeof message.content === 'string') return message.content;
	if (message.content === null) return '';
	return message.content
		.map((part) => (part.type === 'text' ? part.text : ''))
		.join('');
}

function sharedPrefix(a: string, b: string): number {
	const length = Math.min(a.length, b.length);
	let index = 0;
	while (index < length && a[index] === b[index]) index += 1;
	return index;
}

function describe(
	body: ChatRequest,
	usage: { promptTokens: number; cachedTokens: number },
): FakeRequest {
	const key = body.prompt_cache_key ?? '';
	const handle = key.startsWith('task-') ? key.slice('task-'.length) : null;
	const messages = body.messages;
	const last = messages.findLastIndex(
		(message) => message.role === 'assistant',
	);
	const trailing = messages.slice(last + 1);
	return {
		session:
			key === 'watchdog'
				? 'watchdog'
				: body.tools
					? handle
						? 'worker'
						: 'router'
					: 'compaction',
		handle,
		body,
		fresh: trailing
			.filter((message) => message.role === 'user')
			.map(text)
			.join('\n'),
		results: trailing.filter((message) => message.role === 'tool').map(text),
		called: messages.flatMap((message) =>
			message.role === 'assistant'
				? (message.tool_calls ?? []).map((call) => call.function.name)
				: [],
		),
		...usage,
	};
}

function unansweredCalls(messages: Message[]): string[] {
	const missing: string[] = [];
	for (const [index, message] of messages.entries()) {
		if (message.role !== 'assistant') continue;
		const answered = new Set<string>();
		for (const next of messages.slice(index + 1)) {
			if (next.role !== 'tool') break;
			answered.add(next.tool_call_id);
		}
		for (const call of message.tool_calls ?? []) {
			if (!answered.has(call.id)) missing.push(call.id);
		}
	}
	return missing;
}

function stream(id: string, request: FakeRequest, reply: FakeReply): Response {
	const base = { id, service_tier: 'default' };
	const calls = reply.calls ?? [];
	const frames: unknown[] = [];
	if (reply.content) {
		frames.push({
			...base,
			choices: [
				{ index: 0, delta: { content: reply.content }, finish_reason: null },
			],
		});
	}
	for (const [index, call] of calls.entries()) {
		frames.push({
			...base,
			choices: [
				{
					index: 0,
					delta: {
						tool_calls: [
							{
								index,
								id: `${id}-call-${index}`,
								type: 'function',
								function: {
									name: call.name,
									arguments: JSON.stringify(call.args),
								},
							},
						],
					},
					finish_reason: null,
				},
			],
		});
	}
	if (reply.broken) {
		return new Response(
			frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''),
			{
				headers: {
					'Content-Type': 'text/event-stream',
					'x-particle-request-id': id,
				},
			},
		);
	}
	const prompt = request.promptTokens;
	frames.push(
		{
			...base,
			choices: [
				{
					index: 0,
					delta: {},
					finish_reason: calls.length > 0 ? 'tool_calls' : 'stop',
				},
			],
		},
		{
			...base,
			choices: [],
			usage: {
				prompt_tokens: prompt,
				completion_tokens: 20,
				total_tokens: prompt + 20,
				prompt_tokens_details: { cached_tokens: request.cachedTokens },
			},
		},
	);
	const sse = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}data: [DONE]\n\n`;
	return new Response(sse, {
		headers: {
			'Content-Type': 'text/event-stream',
			'x-particle-request-id': id,
		},
	});
}
