// =============================================================================
// Vertex AI Provider
//
// Implements LLMProvider using the official @anthropic-ai/vertex-sdk.
// Routes Claude calls through Google Cloud's Vertex AI endpoint instead
// of api.anthropic.com — auth is Google ADC (Application Default
// Credentials), not an Anthropic API key.
//
// Model IDs are identical to the direct SDK (claude-opus-4-7,
// claude-sonnet-4-6, etc.) on Vertex's `region: "global"` endpoint.
// Stream event shape and error classes are the same as the direct
// SDK because the Vertex SDK extends it — we reuse the mapping +
// classification helpers already exported from anthropic_provider.
// =============================================================================
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type Anthropic from "@anthropic-ai/sdk";

import type {
  LLMProvider,
  LLMStreamRequest,
  LLMStreamEvent,
  LLMCountTokensRequest,
} from "./provider.js";
import { LLMError } from "./provider.js";
import { _mapEvent, _classifyError } from "./anthropic_provider.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("agent/api");

// -----------------------------------------------------------------------------
// Provider implementation
// -----------------------------------------------------------------------------

export interface VertexProviderOptions {
  /** Google Cloud project ID (e.g. "hawky-prod"). */
  projectId: string;
  /** Vertex region. Opus 4.7 is served from the global endpoint. */
  region?: string;
  /** Request timeout in ms (default 5 min, matching AnthropicProvider). */
  timeout?: number;
}

export class VertexProvider implements LLMProvider {
  private readonly options: VertexProviderOptions;
  // Lazily constructed — the AnthropicVertex ctor eagerly kicks off
  // google-auth-library's ADC resolution. If we do that work at provider
  // construction, a user who has `provider: "vertex"` set but no valid
  // ADC credentials would see an unhandled rejection between the gateway
  // starting and their first actual request. Deferring means the ADC
  // error surfaces exactly where the caller expects it — inside stream()
  // on the first turn — and is wrapped by our classifyError path.
  private _client: AnthropicVertex | null = null;
  // Vertex's Anthropic-compatible surface rejects `output_config` with a
  // 400 ("Extra inputs are not permitted"). The direct Anthropic API
  // accepts it as the Opus 4.7 effort dial, so the loop sets it on every
  // request. We strip it here and warn once per provider instance to
  // avoid log-spamming on every turn.
  private _warnedOutputConfig = false;

  constructor(options: VertexProviderOptions) {
    if (!options.projectId) {
      throw new LLMError(
        "auth_error",
        "Vertex project_id is required. Set it under `vertex.project_id` in ~/.hawky/config.json. See deploy/VERTEX_SETUP.md for setup.",
      );
    }
    this.options = options;
  }

  private client(): AnthropicVertex {
    if (!this._client) {
      this._client = new AnthropicVertex({
        projectId: this.options.projectId,
        region: this.options.region ?? "global",
        timeout: this.options.timeout ?? 300_000,
      });
    }
    return this._client;
  }

  async *stream(
    request: LLMStreamRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMStreamEvent> {
    if (signal?.aborted) {
      throw new LLMError("aborted", "Request aborted before starting");
    }

    if (request.output_config && !this._warnedOutputConfig) {
      this._warnedOutputConfig = true;
      log.warn("output_config not supported on Vertex; ignoring (effort dial is Anthropic-direct only)");
    }

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
      ...(request.stop_sequences && request.stop_sequences.length > 0
        ? { stop_sequences: request.stop_sequences }
        : {}),
    };

    let rawStream: any;
    try {
      rawStream = await this.client().messages.create(params, {
        signal: signal as any,
      });
    } catch (err) {
      const classified = _classifyError(err);
      log.error("Vertex API call failed", {
        code: classified.code,
        retryable: classified.retryable,
      });
      throw classified;
    }

    try {
      for await (const event of rawStream as AsyncIterable<Anthropic.MessageStreamEvent>) {
        if (signal?.aborted) {
          throw new LLMError("aborted", "Request aborted during streaming");
        }
        const mapped = _mapEvent(event);
        if (mapped) yield mapped;
      }
    } catch (err) {
      if (err instanceof LLMError) throw err;
      throw _classifyError(err);
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
      const result = await this.client().messages.countTokens(
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
      throw _classifyError(err);
    }
  }
}
