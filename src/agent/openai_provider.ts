// =============================================================================
// OpenAI-Compatible Provider
//
// Implements LLMProvider against any endpoint that speaks the OpenAI Chat
// Completions wire format (vLLM, Groq, Together, OpenAI, Ollama, etc.).
// =============================================================================

import OpenAI from "openai";
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
} from "openai";

import type {
  LLMProvider,
  LLMStreamRequest,
  LLMStreamEvent,
  LLMCountTokensRequest,
  LLMErrorCode,
} from "./provider.js";
import { LLMError } from "./provider.js";
import { createSubsystemLogger } from "../logging/index.js";
import type { ContentBlock, AnthropicToolDefinition, ToolResultContent } from "./types.js";
import type { LLMSystemBlock } from "./provider.js";

const log = createSubsystemLogger("agent/api");

// -----------------------------------------------------------------------------
// Provider implementation
// -----------------------------------------------------------------------------

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;

  constructor(
    apiKey: string,
    options?: { baseURL?: string; timeout?: number },
  ) {
    if (!apiKey) {
      throw new LLMError("auth_error", "OpenAI-compatible API key is required");
    }
    this.client = new OpenAI({
      apiKey,
      baseURL: options?.baseURL,
      timeout: options?.timeout ?? 300_000,
    });
  }

  async *stream(
    request: LLMStreamRequest,
    signal?: AbortSignal,
  ): AsyncGenerator<LLMStreamEvent> {
    if (signal?.aborted) {
      throw new LLMError("aborted", "Request aborted before starting");
    }

    // _translateMessages throws on image / tool_use / tool_result blocks (slices 3 & 4).
    const messages = translateMessages(request);

    // Drop Anthropic-only request fields. thinking and output_config have no
    // OpenAI equivalent; cache_control was already stripped in translateMessages.
    const params: any = {
      model: request.model,
      max_tokens: request.max_tokens,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (request.stop_sequences && request.stop_sequences.length > 0) {
      params.stop = request.stop_sequences;
    }
    if (request.tools && request.tools.length > 0) {
      params.tools = (request.tools as AnthropicToolDefinition[]).map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: stripCacheControl(t.input_schema),
        },
      }));
    }

    let rawStream: any;
    try {
      rawStream = await this.client.chat.completions.create(params, { signal: signal as any });
    } catch (err) {
      const classified = classifyError(err);
      log.error("API call failed", { code: classified.code, retryable: classified.retryable });
      throw classified;
    }

    // Buffer for the synthesized message_start.usage. The real input_tokens
    // arrives in the final chunk's usage; mutate in place since LLMStreamEvent
    // has no patch mechanism. loop.ts:870-874 stores event.usage by reference.
    //
    // OpenAI's split-chunk pattern with stream_options.include_usage:
    //   chunk N-1: { choices: [{delta:{}, finish_reason:"stop"}], usage: null }
    //   chunk N:   { choices: [], usage: {prompt_tokens, completion_tokens} }
    // We must defer message_delta emission until we've seen BOTH the
    // finish_reason and the usage block (or the stream ends, whichever
    // comes first), or output_tokens will always be 0.
    let messageStartEmitted = false;
    let messageStartUsage: { input_tokens: number; output_tokens: number } | null = null;
    let pendingFinishReason: string | null | undefined = undefined;
    let pendingUsage: { prompt_tokens?: number; completion_tokens?: number } | null = null;
    let messageDeltaEmitted = false;

    // Tool calls arrive fragmented across many chunks, potentially interleaved
    // by index. Buffer all fragments; flush serially (ascending index) after
    // the stream ends. loop.ts has single-slot tool state — parallel interleaved
    // tool_use_start events would silently corrupt it.
    const toolCallBuffer = new Map<
      number,
      { id: string; name: string; argFragments: string[] }
    >();

    const emitMessageDelta = function* (
      finishReason: string | null | undefined,
      usage: { prompt_tokens?: number; completion_tokens?: number } | null,
    ): Generator<LLMStreamEvent> {
      if (usage && messageStartUsage) {
        messageStartUsage.input_tokens = usage.prompt_tokens ?? 0;
      }
      yield {
        type: "message_delta",
        stop_reason: mapFinishReason(finishReason),
        usage: { output_tokens: usage?.completion_tokens ?? 0 },
      };
    };

    try {
      for await (const chunk of rawStream as AsyncIterable<any>) {
        if (signal?.aborted) {
          throw new LLMError("aborted", "Request aborted during streaming");
        }

        // Always emit message_start on the first chunk, unconditionally.
        if (!messageStartEmitted) {
          messageStartUsage = { input_tokens: 0, output_tokens: 0 };
          messageStartEmitted = true;
          yield {
            type: "message_start",
            message_id: chunk.id ?? `openai-${Date.now()}`,
            model: chunk.model ?? request.model,
            usage: messageStartUsage as any,
          };
        }

        // Accumulate tool_call fragments silently. These chunks usually carry
        // no other useful payload, BUT some servers (and some mocks) co-locate
        // finish_reason on the same chunk as the final tool_calls fragment —
        // we must NOT `continue` here, or we'd drop the finish_reason and
        // never emit message_delta. Fall through to the mapChunk path below.
        // NOTE: _mapEvent is intentionally simpler than stream() — it cannot
        // handle tool_calls because they require multi-chunk buffering.
        const toolCallDeltas = chunk.choices?.[0]?.delta?.tool_calls;
        if (toolCallDeltas) {
          for (const tc of toolCallDeltas) {
            const idx: number = tc.index;
            let entry = toolCallBuffer.get(idx);
            if (!entry) {
              entry = { id: tc.id ?? "", name: tc.function?.name ?? "", argFragments: [] };
              toolCallBuffer.set(idx, entry);
            } else {
              // Defensive: spec says first chunk for an index carries id/name,
              // but non-conformant servers occasionally send id on a later
              // chunk. Backfill if missing — never overwrite a non-empty value.
              if (tc.id && !entry.id) entry.id = tc.id;
              if (tc.function?.name && !entry.name) entry.name = tc.function.name;
            }
            if (tc.function?.arguments) {
              entry.argFragments.push(tc.function.arguments);
            }
          }
          // Fall through — same chunk may also carry finish_reason.
        }

        // Delegate text/finish_reason translation to mapChunk so the exported
        // _mapEvent symbol exercises the same code path stream() consumes —
        // prevents drift between the public test helper and the real loop.
        const event = mapChunk(chunk);
        if (event?.type === "text_delta") {
          yield event;
        } else if (event?.type === "message_delta") {
          // Buffer rather than emit immediately: real OpenAI may put usage on
          // a later chunk, and we want output_tokens to reflect it.
          pendingFinishReason = chunk.choices?.[0]?.finish_reason;
          if (chunk.usage) pendingUsage = chunk.usage;
          // If usage is present on the same chunk as finish_reason (e.g.,
          // some test mocks, or some servers), we can emit right away —
          // unless tool calls are buffered and must be flushed first.
          if (pendingUsage && toolCallBuffer.size === 0) {
            yield* emitMessageDelta(pendingFinishReason, pendingUsage);
            messageDeltaEmitted = true;
            pendingFinishReason = undefined;
            pendingUsage = null;
          }
        }

        // Usage-only chunk (no choices entries): {choices: [], usage: {...}}.
        // Pair it with the buffered finish_reason from the prior chunk.
        // Defer if tool calls still need to be flushed first.
        if (chunk.usage && !messageDeltaEmitted) {
          pendingUsage = chunk.usage;
          if (pendingFinishReason !== undefined && toolCallBuffer.size === 0) {
            yield* emitMessageDelta(pendingFinishReason, pendingUsage);
            messageDeltaEmitted = true;
            pendingFinishReason = undefined;
            pendingUsage = null;
          }
        }
      }
    } catch (err) {
      if (err instanceof LLMError) throw err;
      throw classifyError(err);
    }

    // Flush buffered tool calls serially in ascending index order. Emitted
    // before message_delta so the loop sees tool_use_start → input_delta →
    // content_block_stop before it processes the stop_reason.
    if (toolCallBuffer.size > 0) {
      const sortedIndices = [...toolCallBuffer.keys()].sort((a, b) => a - b);
      for (const idx of sortedIndices) {
        const entry = toolCallBuffer.get(idx)!;
        yield { type: "tool_use_start", index: idx, id: entry.id, name: entry.name };
        const joined = entry.argFragments.join("");
        if (joined.length > 0) {
          yield { type: "tool_use_input_delta", partial_json: joined };
        }
        yield { type: "content_block_stop", index: idx };
      }
    }

    // Stream ended without a paired finish_reason+usage. Emit whatever we've
    // buffered so the loop never sees a missing message_delta. Possible cases:
    //   - finish_reason seen, no usage → output_tokens: 0 (server didn't honor
    //     stream_options, or the retry-without-stream_options path was taken).
    //   - usage seen, no finish_reason → unusual; map to end_turn.
    //   - neither → also map to end_turn.
    if (!messageDeltaEmitted) {
      yield* emitMessageDelta(pendingFinishReason ?? null, pendingUsage);
    }

    yield { type: "message_stop" };
  }

  async countTokens(
    request: LLMCountTokensRequest,
    signal?: AbortSignal,
  ): Promise<{ input_tokens: number }> {
    if (signal?.aborted) {
      throw new LLMError("aborted", "countTokens aborted before starting");
    }
    // ~10-25% off for Latin text, more for CJK/emoji; flat 1024 tokens per image is a
    // reasonable middle (gpt-4o: 85-1445, Llama-3.2: ~500). Used only for context-fill %
    // and compaction triggers — not billing.
    let totalChars = 0;
    let imageCount = 0;

    // System prompt
    if (request.system) {
      if (typeof request.system === "string") {
        totalChars += request.system.length;
      } else {
        for (const block of request.system) {
          totalChars += block.text.length;
        }
      }
    }

    // Messages
    for (const msg of request.messages) {
      totalChars += `\n${msg.role}: `.length;
      if (typeof msg.content === "string") {
        totalChars += msg.content.length;
      } else {
        for (const block of msg.content as ContentBlock[]) {
          if (block.type === "text") {
            totalChars += block.text.length;
          } else if (block.type === "image") {
            imageCount++;
          } else if (block.type === "tool_use") {
            totalChars += block.name.length;
            totalChars += JSON.stringify((block as any).input ?? {}).length;
          } else if (block.type === "tool_result") {
            const trContent = (block as any).content;
            if (typeof trContent === "string") {
              totalChars += trContent.length;
            } else if (Array.isArray(trContent)) {
              for (const inner of trContent) {
                if (inner.type === "text") {
                  totalChars += inner.text.length;
                } else if (inner.type === "image") {
                  imageCount++;
                }
              }
            }
          }
          // thinking blocks skipped
        }
      }
    }

    // Tools
    if (request.tools && request.tools.length > 0) {
      for (const t of request.tools) {
        totalChars += JSON.stringify({ name: t.name, description: t.description, input_schema: t.input_schema }).length;
      }
    }

    return { input_tokens: Math.ceil(totalChars / 4) + 1024 * imageCount };
  }
}

// -----------------------------------------------------------------------------
// Message translation
// -----------------------------------------------------------------------------

// Strips cache_control recursively from any value. OpenAI endpoints (especially
// stricter vLLM builds) reject unknown fields; Anthropic's cache markers must
// not appear in the wire payload.
function stripCacheControl(value: unknown): any {
  if (Array.isArray(value)) {
    return value.map(stripCacheControl);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "cache_control") continue;
      out[k] = stripCacheControl(v);
    }
    return out;
  }
  return value;
}

// Translates a single Anthropic content block to the OpenAI content-part shape.
// Returns a string for text blocks, an image_url object for image blocks,
// or throws for unsupported types (document).
function translateContentBlock(block: any): string | { type: "image_url"; image_url: { url: string } } {
  if (block.type === "text") {
    return block.text as string;
  }
  if (block.type === "image") {
    const source = block.source as any;
    let url: string;
    if (source.type === "base64") {
      url = `data:${source.media_type};base64,${source.data}`;
    } else {
      // source.type === "url" — pass through directly
      url = source.url as string;
    }
    return { type: "image_url", image_url: { url } };
  }
  if (block.type === "document") {
    throw new LLMError(
      "bad_request",
      "document blocks not supported on openai — convert to text or image first",
    );
  }
  // thinking blocks — skip silently by returning empty string; callers filter
  return "";
}

function translateMessages(req: LLMStreamRequest): any[] {
  const result: any[] = [];

  if (req.system) {
    let systemText: string;
    if (typeof req.system === "string") {
      systemText = req.system;
    } else {
      systemText = (req.system as LLMSystemBlock[])
        .map((b) => stripCacheControl(b).text)
        .join("\n");
    }
    result.push({ role: "system", content: systemText });
  }

  for (const msg of req.messages) {
    if (typeof msg.content === "string") {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    const blocks = (msg.content as ContentBlock[]).map(stripCacheControl);

    // Check if this message contains any tool_use or tool_result blocks,
    // which require special OpenAI-shaped output (not a simple text message).
    const hasToolUse = blocks.some((b: any) => b.type === "tool_use");
    const hasToolResult = blocks.some((b: any) => b.type === "tool_result");

    if (hasToolUse) {
      // Assistant message: join text blocks, build tool_calls array.
      const textParts: string[] = [];
      const toolCalls: any[] = [];
      for (const block of blocks) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input),
            },
          });
        } else if (block.type === "document") {
          throw new LLMError(
            "bad_request",
            "document blocks not supported on openai — convert to text or image first",
          );
          // thinking and image blocks skipped silently (images rare in assistant turns)
        }
      }
      const textContent = textParts.join("");
      result.push({
        role: "assistant",
        content: textContent.length > 0 ? textContent : null,
        tool_calls: toolCalls,
      });
      continue;
    }

    if (hasToolResult) {
      // User message: expand tool_result blocks into tool-role messages,
      // then emit any remaining user text as a follow-up user message.
      const trailingTextParts: string[] = [];
      for (const block of blocks) {
        if (block.type === "tool_result") {
          result.push({
            role: "tool",
            tool_call_id: block.tool_use_id,
            content: translateToolResultContent(block.content),
          });
        } else if (block.type === "text") {
          trailingTextParts.push(block.text);
        } else if (block.type === "document") {
          throw new LLMError(
            "bad_request",
            "document blocks not supported on openai — convert to text or image first",
          );
        }
      }
      if (trailingTextParts.length > 0) {
        result.push({ role: "user", content: trailingTextParts.join("") });
      }
      continue;
    }

    // Plain text or mixed text+image message.
    const parts: Array<string | { type: "image_url"; image_url: { url: string } }> = [];
    let hasImage = false;
    for (const block of blocks) {
      if (block.type === "thinking") continue; // skip silently
      const translated = translateContentBlock(block);
      if (typeof translated === "string") {
        if (translated.length > 0) parts.push(translated);
      } else {
        hasImage = true;
        parts.push(translated);
      }
    }

    if (hasImage) {
      // When any image is present, content must be an array of content parts.
      result.push({
        role: msg.role,
        content: parts.map((p) =>
          typeof p === "string" ? { type: "text", text: p } : p,
        ),
      });
    } else {
      result.push({ role: msg.role, content: parts.join("") });
    }
  }

  return result;
}

// Translates tool_result.content to either a flat string (text-only) or an
// array of content parts (when images are present). OpenAI's tool-role message
// accepts both shapes.
function translateToolResultContent(content: ToolResultContent): string | any[] {
  if (typeof content === "string") return content;
  const parts: any[] = [];
  let hasImage = false;
  for (const block of content) {
    const stripped = stripCacheControl(block) as any;
    if (stripped.type === "text") {
      parts.push(stripped.text as string);
    } else if (stripped.type === "image") {
      hasImage = true;
      const source = stripped.source as any;
      let url: string;
      if (source.type === "base64") {
        url = `data:${source.media_type};base64,${source.data}`;
      } else {
        url = source.url as string;
      }
      parts.push({ type: "image_url", image_url: { url } });
    } else if (stripped.type === "document") {
      throw new LLMError(
        "bad_request",
        "document blocks not supported on openai — convert to text or image first",
      );
    }
  }
  if (hasImage) {
    return parts.map((p) =>
      typeof p === "string" ? { type: "text", text: p } : p,
    );
  }
  return (parts as string[]).join("");
}

// -----------------------------------------------------------------------------
// Event/chunk mapping
// -----------------------------------------------------------------------------

function mapFinishReason(reason: string | null | undefined): string {
  if (reason === "stop" || reason === null || reason === undefined) return "end_turn";
  if (reason === "tool_calls") return "tool_use";
  if (reason === "function_call") return "tool_use"; // legacy OpenAI v0 / some vLLM builds
  if (reason === "length") return "max_tokens";
  return "end_turn";
}

function mapChunk(chunk: any): LLMStreamEvent | null {
  const delta = chunk.choices?.[0]?.delta;
  const finishReason = chunk.choices?.[0]?.finish_reason;

  if (delta?.content) {
    return { type: "text_delta", text: delta.content };
  }

  if (finishReason) {
    return {
      type: "message_delta",
      stop_reason: mapFinishReason(finishReason),
      usage: { output_tokens: chunk.usage?.completion_tokens ?? 0 },
    };
  }

  return null;
}

// -----------------------------------------------------------------------------
// Error classification
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

  const message = err instanceof Error ? err.message : String(err);
  return new LLMError("unknown", message);
}

// -----------------------------------------------------------------------------
// Exports for testing
// -----------------------------------------------------------------------------

export { classifyError as _classifyError };
export { mapChunk as _mapEvent };
export { translateMessages as _translateMessages };
