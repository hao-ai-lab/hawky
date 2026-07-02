// =============================================================================
// Anthropic Provider
//
// Implements LLMProvider using the official @anthropic-ai/sdk.
// Handles streaming, error classification, and abort signal support.
// =============================================================================

import Anthropic from "@anthropic-ai/sdk";
import {
  APIError,
  APIUserAbortError,
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
  BadRequestError,
  InternalServerError,
} from "@anthropic-ai/sdk/error";

import type {
  LLMProvider,
  LLMStreamRequest,
  LLMStreamEvent,
  LLMCountTokensRequest,
} from "./provider.js";
import { LLMError } from "./provider.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("agent/api");

// -----------------------------------------------------------------------------
// Model capabilities
// -----------------------------------------------------------------------------

/**
 * Whether a model accepts the `output_config.effort` reasoning dial.
 *
 * The Haiku tier rejects it with HTTP 400 ("This model does not support the
 * effort parameter."), while Opus/Sonnet (4.6+) accept it. The agent loop sets
 * `output_config.effort` on every request (it is provider-agnostic), so the
 * provider must drop the field for models that don't support it — mirroring how
 * the Vertex and OpenAI providers already strip `output_config`.
 */
export function modelSupportsEffort(model: string): boolean {
  return !/haiku/i.test(model);
}

// -----------------------------------------------------------------------------
// Provider implementation
// -----------------------------------------------------------------------------

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  private _warnedEffortDrop = false;

  constructor(apiKey: string, options?: { baseURL?: string; timeout?: number; defaultHeaders?: Record<string, string> }) {
    if (!apiKey) {
      throw new LLMError("auth_error", "Anthropic API key is required");
    }
    this.client = new Anthropic({
      apiKey,
      // Always set baseURL explicitly to avoid inheriting ANTHROPIC_BASE_URL from shell env
      baseURL: options?.baseURL ?? "https://api.anthropic.com",
      timeout: options?.timeout ?? 300_000, // 5 min default (streaming can be long)
      defaultHeaders: options?.defaultHeaders,
    });
  }

  async *stream(
    request: LLMStreamRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMStreamEvent> {
    // Pre-abort check
    if (signal?.aborted) {
      throw new LLMError("aborted", "Request aborted before starting");
    }

    // output_config.effort is supported on Opus/Sonnet but rejected by Haiku
    // (HTTP 400). Drop it for unsupported models; warn once for observability.
    const includeOutputConfig = !!request.output_config && modelSupportsEffort(request.model);
    if (request.output_config && !includeOutputConfig && !this._warnedEffortDrop) {
      this._warnedEffortDrop = true;
      log.warn("output_config.effort not supported on this model; dropping it", {
        model: request.model,
      });
    }

    // Build SDK params
    const params: Anthropic.MessageCreateParamsStreaming = {
      model: request.model,
      max_tokens: request.max_tokens,
      messages: request.messages as Anthropic.MessageParam[],
      stream: true,
      ...(request.system ? { system: request.system } : {}),
      ...(request.tools && request.tools.length > 0
        ? { tools: request.tools as Anthropic.Tool[] }
        : {}),
      ...(request.thinking ? { thinking: request.thinking } : {}),
      ...(includeOutputConfig ? { output_config: request.output_config } : {}),
      ...(request.stop_sequences && request.stop_sequences.length > 0
        ? { stop_sequences: request.stop_sequences }
        : {}),
    };

    let rawStream: ReturnType<Anthropic.Messages["create"]> extends Promise<infer T> ? T : never;

    try {
      rawStream = await this.client.messages.create(params, {
        signal: signal as any,
      }) as any;
    } catch (err) {
      const classified = classifyError(err);
      log.error("API call failed", { code: classified.code, retryable: classified.retryable });
      throw classified;
    }

    try {
      for await (const event of rawStream as AsyncIterable<Anthropic.MessageStreamEvent>) {
        // Check abort between events
        if (signal?.aborted) {
          throw new LLMError("aborted", "Request aborted during streaming");
        }

        const mapped = mapEvent(event);
        if (mapped) {
          yield mapped;
        }
      }
    } catch (err) {
      if (err instanceof LLMError) throw err;
      throw classifyError(err);
    }
  }

  async countTokens(
    request: LLMCountTokensRequest,
    signal?: AbortSignal,
  ): Promise<{ input_tokens: number }> {
    if (signal?.aborted) {
      throw new LLMError("aborted", "countTokens aborted before starting");
    }
    try {
      const result = await this.client.messages.countTokens(
        {
          model: request.model,
          messages: request.messages as Anthropic.MessageParam[],
          ...(request.system ? { system: request.system } : {}),
          ...(request.tools && request.tools.length > 0
            ? { tools: request.tools as Anthropic.Tool[] }
            : {}),
        },
        { signal: signal as any },
      );
      return { input_tokens: result.input_tokens };
    } catch (err) {
      throw classifyError(err);
    }
  }
}

// -----------------------------------------------------------------------------
// Event mapping: SDK events → our LLMStreamEvent
// -----------------------------------------------------------------------------

function mapEvent(event: Anthropic.MessageStreamEvent): LLMStreamEvent | null {
  switch (event.type) {
    case "message_start":
      return {
        type: "message_start",
        message_id: event.message.id,
        model: event.message.model,
        usage: {
          input_tokens: event.message.usage.input_tokens,
          output_tokens: event.message.usage.output_tokens,
          cache_creation_input_tokens: (event.message.usage as any).cache_creation_input_tokens,
          cache_read_input_tokens: (event.message.usage as any).cache_read_input_tokens,
        },
      };

    case "message_delta":
      return {
        type: "message_delta",
        stop_reason: event.delta.stop_reason,
        usage: { output_tokens: event.usage.output_tokens },
      };

    case "message_stop":
      return { type: "message_stop" };

    case "content_block_start": {
      const block = event.content_block;
      if (block.type === "tool_use") {
        return {
          type: "tool_use_start",
          index: event.index,
          id: block.id,
          name: block.name,
        };
      }
      // text and thinking blocks start — no separate event needed,
      // deltas carry the content
      return null;
    }

    case "content_block_delta": {
      const delta = event.delta;
      if (delta.type === "text_delta") {
        return { type: "text_delta", text: delta.text };
      }
      if (delta.type === "thinking_delta") {
        return { type: "thinking_delta", thinking: delta.thinking };
      }
      if (delta.type === "input_json_delta") {
        return { type: "tool_use_input_delta", partial_json: delta.partial_json };
      }
      // signature_delta, citations_delta — skip for now
      return null;
    }

    case "content_block_stop":
      return { type: "content_block_stop", index: event.index };

    default:
      return null;
  }
}

// -----------------------------------------------------------------------------
// Error classification: SDK errors → LLMError
// -----------------------------------------------------------------------------

function classifyError(err: unknown): LLMError {
  if (err instanceof LLMError) return err;

  if (err instanceof APIUserAbortError) {
    return new LLMError("aborted", "Request aborted by user");
  }

  if (err instanceof APIConnectionTimeoutError) {
    return new LLMError("timeout", err.message);
  }

  if (err instanceof APIConnectionError) {
    return new LLMError("connection_error", err.message);
  }

  if (err instanceof AuthenticationError) {
    return new LLMError("auth_error", err.message, err.status);
  }

  if (err instanceof PermissionDeniedError) {
    return new LLMError("permission_error", err.message, err.status);
  }

  if (err instanceof RateLimitError) {
    return new LLMError("rate_limit", err.message, err.status);
  }

  if (err instanceof BadRequestError) {
    // Check if it's a context overflow
    const msg = err.message.toLowerCase();
    if (msg.includes("context") || msg.includes("too long") || msg.includes("token")) {
      return new LLMError("context_overflow", err.message, err.status);
    }
    return new LLMError("bad_request", err.message, err.status);
  }

  if (err instanceof InternalServerError) {
    return new LLMError("overloaded", err.message, err.status);
  }

  if (err instanceof APIError) {
    return new LLMError("unknown", err.message, err.status);
  }

  // Non-API errors
  const message = err instanceof Error ? err.message : String(err);
  return new LLMError("unknown", message);
}

// -----------------------------------------------------------------------------
// Exports for testing
// -----------------------------------------------------------------------------

export { classifyError as _classifyError };
export { mapEvent as _mapEvent };
