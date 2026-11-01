// Wire types for Particle's Chat Completions API, limited to the fields
// Particle documents as supported. Fields it rejects or doesn't qualify (`n`,
// `max_tokens` next to `max_completion_tokens`, logprobs, `cache_salt`) are
// left out on purpose.

export type JsonValue =
	| string
	| number
	| boolean
	| null
	| JsonValue[]
	| { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

export type ChatModel =
	| 'particle-1'
	| 'deepseek-ai/deepseek-v41-flash-1017'
	| 'glm-5.3-flash';

/**
 * Particle maps these onto three levels: `minimal` and `low` to low, `medium`
 * and `high` to high, `max` and `ultra` to max. `xhigh` is high on
 * `particle-1` and DeepSeek, max on GLM. `none` turns thinking off.
 */
export type ReasoningEffort =
	| 'none'
	| 'minimal'
	| 'low'
	| 'medium'
	| 'high'
	| 'xhigh'
	| 'max'
	| 'ultra';

// GLM always thinks and has no ultra level; Particle rejects both with a 400.
type ModelAndEffort =
	| {
			model: 'particle-1' | 'deepseek-ai/deepseek-v41-flash-1017';
			reasoning_effort: ReasoningEffort;
	  }
	| {
			model: 'glm-5.3-flash';
			reasoning_effort: Exclude<ReasoningEffort, 'none' | 'ultra'>;
	  };

export type TextPart = { type: 'text'; text: string };

/** A data URL or a public HTTPS URL; up to 16 MiB each, 100 MiB in total. */
export type ImagePart = { type: 'image_url'; image_url: { url: string } };

export type SystemMessage = {
	role: 'system' | 'developer';
	content: string | TextPart[];
};

export type UserMessage = {
	role: 'user';
	content: string | (TextPart | ImagePart)[];
};

export type ToolCall = {
	id: string;
	type: 'function';
	/** `arguments` is raw model output: Particle doesn't enforce the schema. */
	function: { name: string; arguments: string };
};

export type AssistantMessage = {
	role: 'assistant';
	content: string | null;
	tool_calls?: ToolCall[];
};

export type ToolMessage = {
	role: 'tool';
	tool_call_id: string;
	content: string;
};

export type Message =
	| SystemMessage
	| UserMessage
	| AssistantMessage
	| ToolMessage;

// No `strict`: Particle doesn't document enforcing it.
export type FunctionTool = {
	type: 'function';
	function: { name: string; description?: string; parameters?: JsonObject };
};

/** Particle's hosted web search, billed per successful search. */
export type WebSearchTool = { type: 'web_search' };

export type Tool = FunctionTool | WebSearchTool;

export type ToolChoice =
	| 'auto'
	| 'none'
	| 'required'
	| { type: 'function'; function: { name: string } };

export type ResponseFormat =
	| { type: 'text' }
	/** Checked by Particle: invalid JSON fails, billed, as `invalid_model_output`. */
	| { type: 'json_object' }
	/** Guides the model only; Particle doesn't validate output against it. */
	| {
			type: 'json_schema';
			json_schema: { name: string; description?: string; schema: JsonObject };
	  };

export type ServiceTier = 'default' | 'flex';

/** `stream` and `stream_options` are set by the client. */
export type ChatRequest = ModelAndEffort & {
	messages: Message[];
	/** Includes reasoning tokens. Particle lowers values above 131,072. */
	max_completion_tokens: number;
	/** Sending any of `top_p`, `top_k` or `min_p` turns off Particle's default `top_p` of 0.85. */
	temperature?: number;
	top_p?: number;
	top_k?: number;
	min_p?: number;
	/** Up to 4 sequences. */
	stop?: string | string[];
	frequency_penalty?: number;
	presence_penalty?: number;
	tools?: Tool[];
	tool_choice?: ToolChoice;
	/** Defaults to `true`. */
	parallel_tool_calls?: boolean;
	response_format?: ResponseFormat;
	user?: string;
	/** A request for `flex` isn't a guarantee; check the tier on the result. */
	service_tier?: ServiceTier;
	/** Up to 256 bytes; one per conversation. */
	prompt_cache_key?: string;
	/** Raw settings passed to the model's chat template. */
	chat_template_kwargs?: JsonObject;
};

/** `cached_tokens` is part of `prompt_tokens`; `reasoning_tokens` is part of `completion_tokens`. */
export type Usage = {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details: { cached_tokens: number };
	completion_tokens_details: { reasoning_tokens: number };
};

/** `length` also covers Particle's repetition wall; re-prompt rather than fail. */
export type FinishReason = 'stop' | 'length' | 'tool_calls' | (string & {});

export type WireUsage = {
	prompt_tokens: number;
	completion_tokens: number;
	total_tokens: number;
	prompt_tokens_details?: { cached_tokens?: number } | null;
	completion_tokens_details?: { reasoning_tokens?: number } | null;
};

export type ToolCallDelta = {
	index: number;
	id?: string;
	type?: 'function';
	function?: { name?: string; arguments?: string };
};

export type ChatCompletionChunk = {
	id: string;
	model: string;
	service_tier?: string | null;
	choices: {
		index: number;
		delta: {
			content?: string | null;
			reasoning_content?: string | null;
			tool_calls?: ToolCallDelta[];
		};
		finish_reason: FinishReason | null;
		matched_stop?: string | number | null;
	}[];
	usage?: WireUsage | null;
};

export type ChatCompletion = {
	id: string;
	model: string;
	service_tier?: string | null;
	choices: {
		index: number;
		message: {
			content: string | null;
			reasoning_content?: string | null;
			tool_calls?: ToolCall[] | null;
		};
		finish_reason: FinishReason;
		matched_stop?: string | number | null;
	}[];
	usage?: WireUsage | null;
};

export type ErrorBody = {
	error: { message?: string; type?: string | null; code?: string | null };
};
