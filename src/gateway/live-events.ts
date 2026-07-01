// =============================================================================
// live-events — realtime downlink contract (#2).
//
// The realtime channels (gemini-live today, openai-realtime next) ingest media
// but, until now, surfaced nothing timed back to the caller: a turn ended with a
// JSONL summary append and a bare `session.updated` poke. A headless benchmark
// (or any client) could feed audio/frames in but could not read a timed response
// stream out.
//
// This module defines the downlink as a `live.*` event family that mirrors the
// proven `agent.*` streaming pattern (agent-turn.ts → broadcastToSession): one
// session-scoped event per realtime signal, each stamped with server time so a
// consumer can compute onset latency against the `ts_captured_ns` it sent on
// `media.chunk.upload`.
//
// The contract is provider-agnostic: the openai-realtime consumer (#3) reuses
// `LiveDownlinkEmitter` unchanged — only the event-source wiring differs.
// =============================================================================

export type LiveProvider = "gemini-live" | "openai-realtime";

/** Common fields stamped on every `live.*` event. */
export interface LiveDownlinkEnvelope {
  sessionKey: string;
  provider: LiveProvider;
  /** Groups all events of one model response. `${sessionKey}#${turnIndex}`. */
  turnId: string;
  /** Monotonic within a turn; resets to 0 on each new turn. */
  seq: number;
  /** Server epoch ms at emit — the timing source for latency measurement. */
  tMs: number;
}

/** The realtime signals a benchmark/client reads to time and score a turn. */
export type LiveDownlinkEvent =
  | { kind: "session_open"; model: string }
  /** First output of a turn — the onset marker (FDB "first response"). */
  | { kind: "response_start"; modality: "audio" | "text" }
  | { kind: "text_delta"; text: string }
  /** Audio output present; bytes only — PCM is not put on the wire. */
  | { kind: "audio_delta"; bytes: number }
  | { kind: "tool_call"; callId: string; name: string; args: unknown }
  | { kind: "tool_result"; callId: string; ok: boolean }
  /** Barge-in (e.g. Gemini `serverContent.interrupted`). */
  | { kind: "interrupted" }
  | { kind: "turn_complete"; text?: string }
  | { kind: "error"; message: string };

/** Minimal sink so the real GatewayServer and test mocks are both assignable. */
export interface LiveEventSink {
  broadcastToSession(
    sessionKey: string,
    event: string,
    payload?: unknown,
    excludeClientId?: string,
  ): unknown;
}

/**
 * Per-session emitter. Owns turn/seq bookkeeping and the once-per-turn
 * `response_start` gate so callers just announce raw signals. Best-effort: a
 * sink failure never propagates into the realtime loop, and a missing sink
 * (server not wired in tests) makes every method a no-op.
 */
export class LiveDownlinkEmitter {
  private seq = 0;
  private turnIndex = 0;
  private responseStarted = false;

  constructor(
    private readonly sink: LiveEventSink | undefined,
    private readonly sessionKey: string,
    private readonly provider: LiveProvider,
  ) {}

  private emit(ev: LiveDownlinkEvent): void {
    if (!this.sink) return;
    const envelope: LiveDownlinkEnvelope = {
      sessionKey: this.sessionKey,
      provider: this.provider,
      turnId: `${this.sessionKey}#${this.turnIndex}`,
      seq: this.seq++,
      tMs: Date.now(),
    };
    try {
      this.sink.broadcastToSession(this.sessionKey, `live.${ev.kind}`, {
        ...envelope,
        ...ev,
      });
    } catch {
      /* downlink is best-effort; never break the realtime loop */
    }
  }

  sessionOpen(model: string): void {
    this.emit({ kind: "session_open", model });
  }

  /** Fire once per turn, before the first delta. Idempotent within a turn. */
  responseStart(modality: "audio" | "text"): void {
    if (this.responseStarted) return;
    this.responseStarted = true;
    this.emit({ kind: "response_start", modality });
  }

  textDelta(text: string): void {
    this.responseStart("text");
    this.emit({ kind: "text_delta", text });
  }

  audioDelta(bytes: number): void {
    this.responseStart("audio");
    this.emit({ kind: "audio_delta", bytes });
  }

  toolCall(callId: string, name: string, args: unknown): void {
    this.emit({ kind: "tool_call", callId, name, args });
  }

  toolResult(callId: string, ok: boolean): void {
    this.emit({ kind: "tool_result", callId, ok });
  }

  interrupted(): void {
    this.emit({ kind: "interrupted" });
  }

  turnComplete(text?: string): void {
    this.emit({ kind: "turn_complete", ...(text !== undefined ? { text } : {}) });
    this.turnIndex += 1;
    this.seq = 0;
    this.responseStarted = false;
  }

  error(message: string): void {
    this.emit({ kind: "error", message });
  }
}
