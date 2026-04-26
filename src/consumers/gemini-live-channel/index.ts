// =============================================================================
// gemini-live-channel — Slice 3 of the priority-stream-ingest feature.
//
// Subscribes to `media.live.chunk` (published by Slice 1's live-chunk writer).
// Maintains one Gemini Live WebSocket session per `session_key`. Streams frames
// (inline JPEG) and audio (PCM16 16kHz) straight through Gemini's realtimeInput
// video/audio message shape. Dispatches model-issued tool calls (memory_append /
// channel_send) to the existing tool-handler registry. On `turnComplete`,
// persists a summary assistant message to the voice:<device_id> session JSONL
// using the same sessionManager.appendMessage pattern as voice-memo-channel.
//
// Lifecycle:
//   • First chunk for a session_key → open WS + send setup with system prompt
//     resolved from the session when a future per-session prompt field exists.
//   • Every chunk pushed through until inactivity > idleMs → close + reap.
//   • Close also happens on consumer shutdown (returned unsubscribe).
//
// Out of scope (slice 3):
//   • Back-pressure / bounded queues. Gemini Live already paces us; if memory
//     grows unbounded the `idle_reaper_ms` default keeps sessions bounded to
//     30s since last chunk.
//   • Audio cadence rewrites (we forward what we're given — 100ms PCM chunks
//     per contract).
//   • Provider-abstraction. When a second provider lands, factor the WS
//     lifecycle out; today only Gemini Live exists.
// =============================================================================

import { createSubsystemLogger } from "../../logging/index.js";
import { getPrompt } from "../../prompts/index.js";
import { getBus } from "../../bus/index.js";
import type { MediaLiveChunkEvent } from "../../bus/events.js";
import type { AgentSessionManager } from "../../gateway/agent-sessions.js";
import type { GatewayServer } from "../../gateway/server.js";
import { loadSessionMeta } from "../../storage/session.js";
import { memoryAppendToolDefinition } from "../../tools/memory_append.js";
import { channelSendToolDefinition } from "../../tools/channel_send.js";
import type { ExtensionManifest } from "../../extensions/types.js";
import { ToolRegistry } from "../../tools/registry.js";
import type { ToolContext, ToolDefinition, ToolResult } from "../../agent/types.js";
import {
  GeminiLiveClient,
  DEFAULT_GEMINI_LIVE_MODEL,
  type GeminiServerEvent,
  type GeminiToolCall,
  type WebSocketLike,
} from "./client.js";
import { readFileSync } from "node:fs";

const log = createSubsystemLogger("gemini-live-channel");

// -----------------------------------------------------------------------------
// Default prompt — matches the proposer framing voice-memo-channel uses when
// there is no session-specific override.
// -----------------------------------------------------------------------------

// Default text lives in the prompt registry (#512). Kept as an exported const
// for existing importers; resolved at module load (registry default unless a
// ~/.hawky/prompts/gemini_live.default.md override exists).
export const GEMINI_LIVE_DEFAULT_PROMPT = getPrompt("gemini_live.default");

// ToolDefinition<SpecificInput> -> ToolDefinition<Record<string, unknown>> needs
// a cast because the generic parameter is contravariant on execute.
const geminiLiveTools = [
  memoryAppendToolDefinition,
  channelSendToolDefinition,
] as unknown as ToolDefinition[];

export const GEMINI_LIVE_TOOL_EXTENSION_MANIFEST: ExtensionManifest = {
  id: "live.provider.tools",
  version: "0.1.0",
  displayName: "Live Provider Tools",
  description: "Tools exposed to the Gemini Live consumer session.",
  capabilities: ["live.provider.tools"],
  surfaces: ["gemini.live"],
  tools: geminiLiveTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
    permission: tool.permission,
    surfaces: ["gemini.live"],
  })),
};

const geminiLiveToolRegistry = new ToolRegistry();
geminiLiveToolRegistry.registerExtension(GEMINI_LIVE_TOOL_EXTENSION_MANIFEST, geminiLiveTools);

export function getGeminiLiveToolNames(): string[] {
  return geminiLiveToolRegistry.getToolsBySurface("gemini.live").map((tool) => tool.name);
}

export function getGeminiLiveFunctionDeclarations(): Record<string, unknown>[] {
  return geminiLiveToolRegistry.getToolsBySurface("gemini.live").map((tool) =>
    toolDeclarationFor(tool.name, tool.description, tool.input_schema),
  );
}

// -----------------------------------------------------------------------------
// Config
// -----------------------------------------------------------------------------

export type GeminiLiveProvider = "gemini-live" | "none";

export interface GeminiLiveConsumerConfig {
  provider: GeminiLiveProvider;
  /** Gemini model override. Null/undefined → DEFAULT_GEMINI_LIVE_MODEL. */
  model: string | null;
  /** Idle reaper window. Default 30_000ms. */
  idle_reaper_ms: number;
  /**
   * If true, enable `memory_append` + `channel_send` tool dispatch. Default true.
   * Disable for pure observation runs.
   */
  tools_enabled: boolean;
  /** Response modalities. Default ["TEXT"] — audio out is not wired for slice 3. */
  response_modalities: Array<"TEXT" | "AUDIO">;
}

export const DEFAULT_GEMINI_LIVE_CONSUMER_CONFIG: GeminiLiveConsumerConfig = {
  provider: "none",
  model: null,
  idle_reaper_ms: 30_000,
  tools_enabled: true,
  response_modalities: ["TEXT"],
};

export interface GeminiLiveConsumerDeps {
  sessions: AgentSessionManager;
  server?: GatewayServer;
  config: GeminiLiveConsumerConfig;
  /** API key lookup override (tests). Defaults to env GEMINI_API_KEY. */
  apiKeyProvider?: () => string | undefined;
  /** WebSocket factory override (tests). */
  wsFactory?: (url: string) => WebSocketLike;
}

// -----------------------------------------------------------------------------
// Per-session in-memory state
// -----------------------------------------------------------------------------

interface SessionState {
  sessionKey: string;
  deviceId: string | null;
  client: GeminiLiveClient;
  lastActivityMs: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  textBuffer: string;
  setupSent: boolean;
  setupComplete: boolean;
  /** Chunks received while waiting for setupComplete; drain on setupComplete. */
  pending: Array<{ kind: "frame" | "audio_chunk"; base64: string }>;
}

// -----------------------------------------------------------------------------
// Registration
// -----------------------------------------------------------------------------

export function registerGeminiLiveConsumer(
  deps: GeminiLiveConsumerDeps,
): () => void {
  const { config } = deps;

  if (config.provider !== "gemini-live") {
    log.info("gemini-live consumer disabled — provider != gemini-live", {
      provider: config.provider,
    });
    return () => {};
  }

  const apiKeyProvider =
    deps.apiKeyProvider ?? (() => process.env.GEMINI_API_KEY);
  const apiKey = apiKeyProvider();
  if (!apiKey || !apiKey.trim()) {
    log.warn(
      "gemini-live consumer: provider=gemini-live but GEMINI_API_KEY not set — skipping registration",
    );
    return () => {};
  }

  const sessionsState = new Map<string, SessionState>();

  const bus = getBus();
  const unsub = bus.subscribe<MediaLiveChunkEvent>(
    "media.live.chunk",
    (event) => {
      void onChunk(event, sessionsState, deps, apiKey).catch((err) => {
        log.warn("gemini-live chunk dispatch failed", {
          sessionKey: event.session_key,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
  );

  log.info("gemini-live consumer registered", {
    model: config.model ?? DEFAULT_GEMINI_LIVE_MODEL,
    idle_reaper_ms: config.idle_reaper_ms,
    tools_enabled: config.tools_enabled,
  });

  return () => {
    unsub();
    for (const [key, state] of sessionsState) {
      closeSession(key, state, sessionsState, "unregister");
    }
  };
}

// -----------------------------------------------------------------------------
// Chunk handler
// -----------------------------------------------------------------------------

async function onChunk(
  event: MediaLiveChunkEvent,
  sessionsState: Map<string, SessionState>,
  deps: GeminiLiveConsumerDeps,
  apiKey: string,
): Promise<void> {
  const { config } = deps;
  const sessionKey = event.session_key;

  let state = sessionsState.get(sessionKey);
  if (!state) {
    state = await openSession(sessionKey, event.device_id ?? null, deps, apiKey);
    sessionsState.set(sessionKey, state);
  }

  // Read the chunk bytes and base64-encode. Slice 1 writes chunks to disk at
  // event.file_path; we consume from there.
  let base64: string;
  try {
    const buf = readFileSync(event.file_path);
    base64 = buf.toString("base64");
  } catch (err) {
    log.warn("gemini-live could not read chunk file", {
      sessionKey,
      file: event.file_path,
      error: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  touch(state, config.idle_reaper_ms, sessionsState);

  if (!state.setupComplete) {
    state.pending.push({ kind: event.media_kind, base64 });
    return;
  }

  forwardChunk(state, event.media_kind, base64);
}

function forwardChunk(
  state: SessionState,
  mediaKind: "frame" | "audio_chunk",
  base64: string,
): void {
  if (mediaKind === "frame") {
    state.client.sendFrame(base64);
  } else {
    state.client.sendAudio(base64, 16000);
  }
}

// -----------------------------------------------------------------------------
// Session open / close
// -----------------------------------------------------------------------------

async function openSession(
  sessionKey: string,
  deviceId: string | null,
  deps: GeminiLiveConsumerDeps,
  apiKey: string,
): Promise<SessionState> {
  const { config } = deps;
  const client = new GeminiLiveClient({
    apiKey,
    model: config.model ?? DEFAULT_GEMINI_LIVE_MODEL,
    wsFactory: deps.wsFactory,
  });

  const state: SessionState = {
    sessionKey,
    deviceId,
    client,
    lastActivityMs: Date.now(),
    idleTimer: null,
    textBuffer: "",
    setupSent: false,
    setupComplete: false,
    pending: [],
  };

  client.onEvent((e) => {
    void onServerEvent(e, state, deps).catch((err) => {
      log.warn("gemini-live server event handler failed", {
        sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  });

  // Wire open + setup. open() resolves on `open`; then we send setup.
  await client.open();
  const systemPrompt = resolveSystemPrompt(sessionKey);
  const setup = {
    model: config.model ?? DEFAULT_GEMINI_LIVE_MODEL,
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: {
      responseModalities: config.response_modalities,
    },
    ...(config.response_modalities.includes("AUDIO")
      ? { outputAudioTranscription: {} }
      : {}),
    ...(config.tools_enabled
      ? {
          tools: [
            {
              functionDeclarations: getGeminiLiveFunctionDeclarations(),
            },
          ],
        }
      : {}),
  };
  client.sendSetup(setup);
  state.setupSent = true;

  log.info("gemini-live session opened", {
    sessionKey,
    deviceId,
    model: setup.model,
    promptChars: systemPrompt.length,
  });

  return state;
}

function closeSession(
  sessionKey: string,
  state: SessionState,
  sessionsState: Map<string, SessionState>,
  reason: string,
): void {
  if (state.idleTimer) {
    clearTimeout(state.idleTimer);
    state.idleTimer = null;
  }
  try {
    state.client.close();
  } catch {
    /* non-fatal */
  }
  sessionsState.delete(sessionKey);
  log.info("gemini-live session closed", { sessionKey, reason });
}

function touch(
  state: SessionState,
  idleMs: number,
  sessionsState: Map<string, SessionState>,
): void {
  state.lastActivityMs = Date.now();
  if (state.idleTimer) clearTimeout(state.idleTimer);
  state.idleTimer = setTimeout(() => {
    closeSession(state.sessionKey, state, sessionsState, "idle");
  }, idleMs);
}

// -----------------------------------------------------------------------------
// Server event handling — text deltas, turn complete, tool calls.
// -----------------------------------------------------------------------------

async function onServerEvent(
  e: GeminiServerEvent,
  state: SessionState,
  deps: GeminiLiveConsumerDeps,
): Promise<void> {
  switch (e.kind) {
    case "setupComplete": {
      state.setupComplete = true;
      // Drain pending chunks queued while waiting for setup.
      for (const p of state.pending) forwardChunk(state, p.kind, p.base64);
      state.pending = [];
      return;
    }
    case "textDelta": {
      state.textBuffer += e.text;
      return;
    }
    case "turnComplete": {
      await onTurnComplete(state, deps);
      return;
    }
    case "toolCall": {
      await dispatchToolCalls(e.calls, state, deps);
      return;
    }
    case "toolCallCancellation": {
      // Nothing to cancel server-side today (tool handlers are synchronous
      // from Gemini's POV). Log for observability.
      log.info("gemini-live tool cancellation", {
        sessionKey: state.sessionKey,
        ids: e.ids,
      });
      return;
    }
    case "error": {
      log.warn("gemini-live error event", {
        sessionKey: state.sessionKey,
        message: e.message,
      });
      return;
    }
  }
}

async function onTurnComplete(
  state: SessionState,
  deps: GeminiLiveConsumerDeps,
): Promise<void> {
  const text = state.textBuffer.trim();
  state.textBuffer = "";
  if (!text) return;

  // Persist as an assistant message on the voice session JSONL, mirroring
  // voice-memo-channel's sessionManager.appendMessage pattern.
  try {
    const session = deps.sessions.getOrCreate(state.sessionKey);
    const message = {
      role: "assistant" as const,
      content: [{ type: "text" as const, text }],
      timestamp: new Date().toISOString(),
    };
    session.sessionManager.appendMessage(message);

    if (deps.server) {
      try {
        deps.server.broadcast("session.updated", {
          sessionKey: state.sessionKey,
        });
      } catch {
        /* non-fatal */
      }
    }
  } catch (err) {
    log.warn("gemini-live persist summary failed", {
      sessionKey: state.sessionKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// -----------------------------------------------------------------------------
// Tool dispatch — route Gemini-issued function calls to existing handlers.
// -----------------------------------------------------------------------------

async function dispatchToolCalls(
  calls: GeminiToolCall[],
  state: SessionState,
  deps: GeminiLiveConsumerDeps,
): Promise<void> {
  if (!deps.config.tools_enabled) {
    log.info("gemini-live tool calls arrived but tools_enabled=false — ignoring", {
      sessionKey: state.sessionKey,
      names: calls.map((c) => c.name),
    });
    return;
  }

  const toolContext: ToolContext = {
    session_id: state.sessionKey,
    working_directory: process.cwd(),
    abort_signal: new AbortController().signal,
    emit: () => {},
    headless: true,
  };

  for (const call of calls) {
    let result: ToolResult;
    try {
      const tool = geminiLiveToolRegistry.get(call.name);
      if (!tool) {
        result = {
          type: "error",
          content: `unknown tool: ${call.name}`,
        } as ToolResult;
      } else {
        result = await tool.execute(call.args as any, toolContext);
      }
    } catch (err) {
      result = {
        type: "error",
        content: `tool threw: ${err instanceof Error ? err.message : String(err)}`,
      } as ToolResult;
    }

    // Report the result back to Gemini so future turns can observe it.
    try {
      state.client.sendToolResponse(call.id, call.name, result);
    } catch (err) {
      log.warn("gemini-live toolResponse send failed", {
        sessionKey: state.sessionKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function resolveSystemPrompt(sessionKey: string): string {
  try {
    const meta = loadSessionMeta();
    // Forward-compatible hook for branches that add per-session prompt
    // overrides. Current upstream SessionMetaEntry does not expose this field,
    // so keep it as an optional runtime read instead of expanding meta schema
    // in the live-consumer PR.
    const override = (meta[sessionKey] as { system_prompt_override?: unknown } | undefined)
      ?.system_prompt_override;
    if (typeof override === "string" && override.trim().length > 0) {
      return override;
    }
  } catch {
    /* fall through to default */
  }
  return GEMINI_LIVE_DEFAULT_PROMPT;
}

function toolDeclarationFor(
  name: string,
  description: string,
  schema: unknown,
): Record<string, unknown> {
  return {
    name,
    description,
    parameters: schema,
  };
}
