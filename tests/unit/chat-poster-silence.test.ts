// =============================================================================
// Unit tests for chat-poster's default-on isLikelySilence filter.
//
// Integration tests pass empty denylist + zeroed thresholds to bypass the
// filter; this file pins the default-on behavior so a future tweak to the
// defaults trips a test rather than silently changing what the gateway drops.
// =============================================================================

import { describe, test, expect } from "bun:test";
import { isLikelySilence, type ChatPosterConfig } from "../../src/consumers/chat-poster/index.js";
import type { AsrFinalEvent } from "../../src/consumers/asr/events.js";

const baseConfig: ChatPosterConfig = {
  enabled: true,
  session_id_override: null,
  prefix: "",
  include_confidence: false,
  // Leave silence_denylist / min_confidence / min_duration_ms unset so the
  // module-level defaults are the thing under test.
};

function mkEvent(over: Partial<AsrFinalEvent> = {}): AsrFinalEvent {
  return {
    media_id: "m-test",
    lang: "en",
    text: over.text ?? "Hello world.",
    segments: over.segments ?? [{ t0_ms: 0, t1_ms: 1000, text: over.text ?? "Hello world." }],
    backend: "mock",
    model: "mock-1",
    transcribe_wallclock_ms: 100,
    media_duration_ms: 2000,
    node_id: "test",
    captured_start_iso: "2026-04-29T10:00:00.000Z",
    ...over,
  };
}

describe("isLikelySilence (default-on)", () => {
  test("drops 'Thank you.'", () => {
    const e = mkEvent({ text: "Thank you." });
    expect(isLikelySilence("Thank you.", e, baseConfig)).toBe(true);
  });

  test("drops 'Thanks for watching.'", () => {
    const e = mkEvent({ text: "Thanks for watching." });
    expect(isLikelySilence("Thanks for watching.", e, baseConfig)).toBe(true);
  });

  test("drops case variants in the denylist", () => {
    const e = mkEvent({ text: "thank you" });
    expect(isLikelySilence("thank you", e, baseConfig)).toBe(true);
    const e2 = mkEvent({ text: "  THANK YOU.  " });
    expect(isLikelySilence("  THANK YOU.  ", e2, baseConfig)).toBe(true);
  });

  test("drops empty / whitespace-only text", () => {
    const e = mkEvent({ text: "" });
    expect(isLikelySilence("", e, baseConfig)).toBe(true);
    const e2 = mkEvent({ text: "   " });
    expect(isLikelySilence("   ", e2, baseConfig)).toBe(true);
  });

  test("drops sub-default-confidence transcripts", () => {
    // Default min_confidence is 0.4; supply mean confidence well below.
    const e = mkEvent({
      text: "this is a long sentence",
      segments: [
        { t0_ms: 0, t1_ms: 500, text: "this is", confidence: 0.1 },
        { t0_ms: 500, t1_ms: 1000, text: "a long sentence", confidence: 0.2 },
      ],
    });
    expect(isLikelySilence("this is a long sentence", e, baseConfig)).toBe(true);
  });

  test("drops sub-default-media-duration transcripts", () => {
    // Default min_duration_ms is 500; supply 100ms.
    const e = mkEvent({
      text: "blip",
      media_duration_ms: 100,
    });
    expect(isLikelySilence("blip", e, baseConfig)).toBe(true);
  });

  test("keeps a normal transcript", () => {
    const e = mkEvent({
      text: "hello world this is a real sentence",
      segments: [
        {
          t0_ms: 0,
          t1_ms: 2000,
          text: "hello world this is a real sentence",
          confidence: 0.9,
        },
      ],
      media_duration_ms: 2000,
    });
    expect(
      isLikelySilence("hello world this is a real sentence", e, baseConfig),
    ).toBe(false);
  });
});
