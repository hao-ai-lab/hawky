// =============================================================================
// Gemini Live WebSocket client — thin wrapper over the Bun built-in WebSocket.
//
// Protocol: Gemini Live v1beta BidiGenerateContent. The wire shape follows
// Google's published `BidiGenerateContentSetup` / `BidiGenerateContentRealtimeInput`
// / `BidiGenerateContentServerContent` messages.
//
// This wrapper intentionally speaks the JSON subset we need for Slice 3:
//   • send setup (model + system instruction)
//   • send realtimeInput with inline JPEG frames and PCM16 audio
//   • send realtime text turns for smoke/diagnostic checks
//   • receive serverContent turn complete + modelTurn text
//   • receive toolCall / toolCallCancellation blocks
//
// The exact endpoint path version (v1alpha / v1beta) has shifted during the
// beta — keep it in ONE constant so it can be edited in one place. If the
// upstream renames a field, a rebase/update should touch this file only.
// =============================================================================

import { createSubsystemLogger } from "../../logging/index.js";

const log = createSubsystemLogger("gemini-live-client");

// -----------------------------------------------------------------------------
// Endpoint / model constants — single source of truth for easy edits.
// -----------------------------------------------------------------------------

/**
 * Gemini Live API-key bidirectional generate endpoint. Google documents
 * ephemeral tokens on the constrained v1alpha endpoint, but normal API keys
 * use v1beta.
 */
export const GEMINI_LIVE_URL_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

/** Default model for Gemini Live. Override via config if needed. */
export const DEFAULT_GEMINI_LIVE_MODEL = "models/gemini-3.1-flash-live-preview";

// -----------------------------------------------------------------------------
// Wire shapes (narrow subset we actually send/receive)
// -----------------------------------------------------------------------------

export interface GeminiSetup {
  model: string;
  systemInstruction?: {
    parts: Array<{ text: string }>;
  };
  generationConfig?: {
    responseModalities?: Array<"TEXT" | "AUDIO">;
    temperature?: number;
  };
  outputAudioTranscription?: Record<string, never>;
  tools?: Array<Record<string, unknown>>;
}

export interface GeminiInlineBlob {
  mimeType: string;         // "image/jpeg" | "audio/pcm;rate=16000"
  data: string;             // base64
}

export interface GeminiRealtimeInput {
  audio?: GeminiInlineBlob;
  video?: GeminiInlineBlob;
  text?: string;
  /** Deprecated upstream; accepted here only for backwards-compatible mocks. */
  mediaChunks?: GeminiInlineBlob[];
}

export interface GeminiClientContent {
  turns: Array<{
    role: "user" | "model";
    parts: Array<{ text: string }>;
  }>;
  turnComplete?: boolean;
}

/** A single tool-use block delivered by the server. */
export interface GeminiToolCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

/** What the consumer cares about from a server message. */
export type GeminiServerEvent =
  | { kind: "setupComplete" }
  | { kind: "textDelta"; text: string }
  | { kind: "turnComplete" }
  | { kind: "toolCall"; calls: GeminiToolCall[] }
  | { kind: "toolCallCancellation"; ids: string[] }
  | { kind: "error"; message: string };

// -----------------------------------------------------------------------------
// Client
// -----------------------------------------------------------------------------

export interface GeminiLiveClientOptions {
  apiKey: string;
  model?: string;
  /** Optional override for tests — injects a fake WebSocket constructor. */
  wsFactory?: (url: string) => WebSocketLike;
}

/** Minimal WebSocket surface we rely on. Mirrors Bun/Node WebSocket. */
export interface WebSocketLike {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (ev: { code: number; reason: string }) => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
  readyState: number;
}

export class GeminiLiveClient {
  private ws: WebSocketLike | null = null;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly wsFactory: (url: string) => WebSocketLike;
  private handlers: Array<(e: GeminiServerEvent) => void> = [];
  private rawHandlers: Array<(raw: string) => void> = [];
  private openPromise: Promise<void> | null = null;
  private closed = false;

  constructor(opts: GeminiLiveClientOptions) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? DEFAULT_GEMINI_LIVE_MODEL;
    this.wsFactory =
      opts.wsFactory ??
      ((url: string) => new (globalThis as any).WebSocket(url) as WebSocketLike);
  }

  /**
   * Open the WS and return a promise that resolves on `open`. Does NOT send
   * setup — caller must call `sendSetup` once opened.
   */
  open(): Promise<void> {
    if (this.openPromise) return this.openPromise;
    const url = `${GEMINI_LIVE_URL_BASE}?key=${encodeURIComponent(this.apiKey)}`;
    this.ws = this.wsFactory(url);
    let opened = false;
    this.ws.addEventListener("message", (ev) => {
      void this.onMessage(ev.data);
    });
    this.ws.addEventListener("close", (ev) => {
      this.closed = true;
      log.info("gemini-live ws closed", { code: ev.code, reason: ev.reason });
      if (ev.code !== 1000) {
        this.emit({
          kind: "error",
          message: `Gemini Live WebSocket closed: ${ev.code} ${ev.reason}`,
        });
      }
    });
    this.ws.addEventListener("error", (ev) => {
      log.warn("gemini-live ws error", {
        error: ev instanceof Error ? ev.message : String(ev),
      });
      this.emit({ kind: "error", message: String(ev) });
    });

    this.openPromise = new Promise<void>((resolve, reject) => {
      this.ws!.addEventListener("open", () => {
        opened = true;
        resolve();
      });
      this.ws!.addEventListener("close", (ev) => {
        if (!opened) {
          reject(
            new Error(
              `Gemini Live WebSocket closed before open: ${ev.code} ${ev.reason}`,
            ),
          );
        }
      });
      this.ws!.addEventListener("error", (ev) => {
        if (!opened) {
          reject(
            new Error(
              `Gemini Live WebSocket failed before open: ${
                ev instanceof Error ? ev.message : String(ev)
              }`,
            ),
          );
        }
      });
    });
    return this.openPromise;
  }

  sendSetup(setup: GeminiSetup): void {
    this.sendJson({ setup });
  }

  /** Send a JPEG frame as inline media. */
  sendFrame(jpegBase64: string): void {
    this.sendJson({
      realtimeInput: {
        video: { mimeType: "image/jpeg", data: jpegBase64 },
      },
    });
  }

  /** Send a PCM16 audio chunk (16kHz little-endian mono). */
  sendAudio(pcm16Base64: string, sampleRate = 16000): void {
    this.sendJson({
      realtimeInput: {
        audio: { mimeType: `audio/pcm;rate=${sampleRate}`, data: pcm16Base64 },
      },
    });
  }

  /** Send a realtime text chunk. End-of-turn is activity-derived. */
  sendText(text: string): void {
    this.sendJson({ realtimeInput: { text } });
  }

  /** Send an explicit text turn and request generation immediately. */
  sendClientTurn(text: string): void {
    const clientContent: GeminiClientContent = {
      turns: [
        {
          role: "user",
          parts: [{ text }],
        },
      ],
      turnComplete: true,
    };
    this.sendJson({ clientContent });
  }

  /** Reply to a tool call block with results. */
  sendToolResponse(id: string | undefined, name: string, response: unknown): void {
    this.sendJson({
      toolResponse: {
        functionResponses: [
          {
            id,
            name,
            response: { output: response },
          },
        ],
      },
    });
  }

  onEvent(handler: (e: GeminiServerEvent) => void): () => void {
    this.handlers.push(handler);
    return () => {
      this.handlers = this.handlers.filter((h) => h !== handler);
    };
  }

  onRawMessage(handler: (raw: string) => void): () => void {
    this.rawHandlers.push(handler);
    return () => {
      this.rawHandlers = this.rawHandlers.filter((h) => h !== handler);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.ws?.close(1000, "client closing");
    } catch {
      /* non-fatal */
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private sendJson(obj: unknown): void {
    if (!this.ws || this.closed) {
      log.warn("gemini-live send on closed socket — dropping");
      return;
    }
    try {
      this.ws.send(JSON.stringify(obj));
    } catch (err) {
      log.warn("gemini-live send failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async onMessage(raw: unknown): Promise<void> {
    let payload: any;
    let text: string;
    try {
      text = await this.decodeRawMessage(raw);
      this.emitRaw(text);
      payload = JSON.parse(text);
    } catch (err) {
      log.warn("gemini-live bad json", {
        error: err instanceof Error ? err.message : String(err),
      });
      this.emit({
        kind: "error",
        message: `Gemini Live bad JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      });
      return;
    }

    // setupComplete
    if (payload.setupComplete) {
      this.emit({ kind: "setupComplete" });
      return;
    }

    // serverContent — modelTurn text or turnComplete
    if (payload.serverContent) {
      const sc = payload.serverContent;
      if (sc.modelTurn?.parts) {
        for (const part of sc.modelTurn.parts as Array<{ text?: string }>) {
          if (typeof part.text === "string" && part.text.length > 0) {
            this.emit({ kind: "textDelta", text: part.text });
          }
        }
      }
      if (
        typeof sc.outputTranscription?.text === "string" &&
        sc.outputTranscription.text.length > 0
      ) {
        this.emit({ kind: "textDelta", text: sc.outputTranscription.text });
      }
      if (sc.turnComplete === true) {
        this.emit({ kind: "turnComplete" });
      }
      return;
    }

    if (payload.error) {
      const message =
        typeof payload.error.message === "string"
          ? payload.error.message
          : JSON.stringify(payload.error);
      this.emit({ kind: "error", message });
      return;
    }

    // toolCall — one or more functionCalls to dispatch
    if (payload.toolCall?.functionCalls) {
      const calls = (payload.toolCall.functionCalls as Array<any>).map((c) => ({
        id: typeof c.id === "string" ? c.id : undefined,
        name: String(c.name ?? ""),
        args: (c.args ?? {}) as Record<string, unknown>,
      })).filter((c) => c.name.length > 0);
      if (calls.length > 0) {
        this.emit({ kind: "toolCall", calls });
      }
      return;
    }

    if (payload.toolCallCancellation?.ids) {
      this.emit({
        kind: "toolCallCancellation",
        ids: payload.toolCallCancellation.ids as string[],
      });
      return;
    }
  }

  private async decodeRawMessage(raw: unknown): Promise<string> {
    if (typeof raw === "string") return raw;
    if (raw instanceof ArrayBuffer) return new TextDecoder().decode(raw);
    if (ArrayBuffer.isView(raw)) {
      return new TextDecoder().decode(
        new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength),
      );
    }
    if (Buffer.isBuffer(raw)) return (raw as Buffer).toString("utf-8");
    if (
      raw &&
      typeof raw === "object" &&
      "text" in raw &&
      typeof (raw as { text?: unknown }).text === "function"
    ) {
      return String(await (raw as { text: () => Promise<string> }).text());
    }
    return String(raw);
  }

  private emit(e: GeminiServerEvent): void {
    for (const h of this.handlers) {
      try {
        h(e);
      } catch (err) {
        log.warn("gemini-live handler threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  private emitRaw(raw: string): void {
    for (const h of this.rawHandlers) {
      try {
        h(raw);
      } catch (err) {
        log.warn("gemini-live raw handler threw", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
