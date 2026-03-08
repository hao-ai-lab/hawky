// =============================================================================
// LLM Provider Interface
//
// Abstract interface for LLM providers. Currently only Anthropic is implemented,
// but this abstraction allows adding OpenAI, OpenRouter, etc. in the future.
// =============================================================================

import type {
  TokenUsage,
  AnthropicToolDefinition,
  CacheControl,
  ContentBlock,
} from "./types.js";

/**
 * One block of the system prompt when sent as a typed array (instead of a
 * plain string). The typed-array form is required to attach a cache_control
 * breakpoint to the system prompt; passing a string skips the marker.
 */
export interface LLMSystemBlock {
  type: "text";
  text: string;
  cache_control?: CacheControl;
}

// -----------------------------------------------------------------------------
// Stream events emitted by a provider during streaming
// -----------------------------------------------------------------------------

export type LLMStreamEvent =
  | LLMTextDelta
  | LLMThinkingDelta
  | LLMToolUseStart
  | LLMToolUseInputDelta
  | LLMContentBlockStop
  | LLMMessageStart
  | LLMMessageDelta
  | LLMMessageStop;

export interface LLMTextDelta {
  type: "text_delta";
  text: string;
}

export interface LLMThinkingDelta {
  type: "thinking_delta";
  thinking: string;
}

export interface LLMToolUseStart {
  type: "tool_use_start";
  index: number;
  id: string;
  name: string;
}

export interface LLMToolUseInputDelta {
  type: "tool_use_input_delta";
  partial_json: string;
}

export interface LLMContentBlockStop {
  type: "content_block_stop";
  index: number;
}

export interface LLMMessageStart {
  type: "message_start";
  message_id: string;
  model: string;
  usage: TokenUsage;
}

export interface LLMMessageDelta {
  type: "message_delta";
  stop_reason: string | null;
  usage: { output_tokens: number };
}

export interface LLMMessageStop {
  type: "message_stop";
}

// -----------------------------------------------------------------------------
// Request types
// -----------------------------------------------------------------------------

export interface LLMMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

export interface LLMStreamRequest {
  model: string;
  max_tokens: number;
  messages: LLMMessage[];
  /** Plain string OR a typed-block array (the latter required for system-prompt cache markers). */
  system?: string | LLMSystemBlock[];
  tools?: AnthropicToolDefinition[];
  thinking?: { type: "enabled"; budget_tokens: number } | { type: "disabled" } | { type: "adaptive" };
  output_config?: { effort: "low" | "medium" | "high" | "xhigh" | "max" };
  stop_sequences?: string[];
}

// -----------------------------------------------------------------------------
// Provider interface
// -----------------------------------------------------------------------------

export interface LLMProvider {
  /** Stream a message completion. Yields LLMStreamEvents. */
  stream(
    request: LLMStreamRequest,
    signal?: AbortSignal,
  ): AsyncIterable<LLMStreamEvent>;

  /**
   * Count input tokens for a request without invoking the model. Used to
   * compute the "context fill %" metric and to decide when to trigger
   * compaction. Mirrors the request shape of `stream()` but never consumes
   * the model's billed input tokens — Anthropic's count_tokens endpoint is
   * free at the time of writing.
   */
  countTokens(
    request: LLMCountTokensRequest,
    signal?: AbortSignal,
  ): Promise<{ input_tokens: number }>;
}

export interface LLMCountTokensRequest {
  model: string;
  messages: LLMMessage[];
  system?: string | LLMSystemBlock[];
  tools?: AnthropicToolDefinition[];
}

// -----------------------------------------------------------------------------
// Error classification
// -----------------------------------------------------------------------------

export type LLMErrorCode =
  | "auth_error"        // 401 — bad API key
  | "permission_error"  // 403 — key lacks permission
  | "rate_limit"        // 429 — too many requests
  | "overloaded"        // 529 / 500 — server overloaded
  | "context_overflow"  // 400 — context too long
  | "bad_request"       // 400 — malformed request
  | "timeout"           // connection/read timeout
  | "connection_error"  // network failure
  | "aborted"           // user cancelled
  | "unknown";          // unclassified

export class LLMError extends Error {
  readonly code: LLMErrorCode;
  readonly status?: number;
  readonly retryable: boolean;

  constructor(code: LLMErrorCode, message: string, status?: number) {
    super(message);
    this.name = "LLMError";
    this.code = code;
    this.status = status;
    this.retryable = code === "rate_limit" || code === "overloaded" || code === "timeout";
  }
}
