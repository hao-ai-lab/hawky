// =============================================================================
// Unit tests for chat-poster's debounce coalescing.
//
// Two memos within debounce → one user turn with `\n\n[HH:MM:SS]` separator.
// Two memos outside debounce → two separate turns. max_items / max_chars /
// flush_age_ms force an early flush even when events keep arriving fast.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { getBus, resetBus } from "../../src/bus/index.js";
import {
  registerChatPoster,
  type ChatPosterConfig,
} from "../../src/consumers/chat-poster/index.js";
import type { AsrFinalEvent } from "../../src/consumers/asr/events.js";

// -----------------------------------------------------------------------------
// Mock session manager — captures appends without touching disk.
// -----------------------------------------------------------------------------

interface AppendedMessage {
  role: string;
  content: Array<{ type: string; text: string }>;
  timestamp: string;
}

function makeMockSessions(): {
  manager: any;
  appended: Map<string, AppendedMessage[]>;
  histories: Map<string, AppendedMessage[]>;
} {
  const appended = new Map<string, AppendedMessage[]>();
  const histories = new Map<string, AppendedMessage[]>();
  const manager = {
    getOrCreate(key: string) {
      if (!appended.has(key)) appended.set(key, []);
      if (!histories.has(key)) histories.set(key, []);
      const history = histories.get(key)!;
      const appends = appended.get(key)!;
      return {
        loop: {
          getHistory: () => history.slice(),
          setHistory: (h: AppendedMessage[]) => {
            histories.set(key, h.slice());
          },
        },
        sessionManager: {
          appendMessage: (m: AppendedMessage) => appends.push(m),
        },
      };
    },
  };
  return { manager, appended, histories };
}

function mkEvent(over: Partial<AsrFinalEvent> = {}): AsrFinalEvent {
  return {
    media_id: over.media_id ?? "m",
    lang: "en",
    text: over.text ?? "hello",
    segments: [{ t0_ms: 0, t1_ms: 1000, text: over.text ?? "hello", confidence: 0.95 }],
    backend: "mock",
    model: "mock-1",
    transcribe_wallclock_ms: 100,
    media_duration_ms: 2000,
    node_id: "test",
    captured_start_iso: over.captured_start_iso ?? "2026-04-29T10:00:00.000Z",
    ...over,
  };
}

const baseConfig: ChatPosterConfig = {
  enabled: true,
  session_id_override: "voice:coalesce-test",
  prefix: "",
  include_confidence: false,
  silence_denylist: [],
  min_confidence: 0,
  min_duration_ms: 0,
};

// -----------------------------------------------------------------------------

beforeEach(() => {
  resetBus();
});

afterEach(() => {
  resetBus();
});

describe("chat-poster debounce coalescing", () => {
  test("two events within debounce coalesce into one user turn with HH:MM:SS separator", async () => {
    const { manager, appended } = makeMockSessions();
    const unsub = registerChatPoster({
      sessions: manager,
      config: { ...baseConfig, debounce_ms: 80 },
    });

    try {
      getBus().publish("asr.final", mkEvent({ media_id: "m1", text: "first thing" }));
      await new Promise((r) => setTimeout(r, 10));
      getBus().publish(
        "asr.final",
        mkEvent({
          media_id: "m2",
          text: "second thing",
          captured_start_iso: "2026-04-29T10:00:05.000Z",
        }),
      );
      // Wait past debounce so the inactivity timer flushes.
      await new Promise((r) => setTimeout(r, 200));

      const msgs = appended.get("voice:coalesce-test") ?? [];
      expect(msgs.length).toBe(1);
      const text = msgs[0].content[0].text;
      expect(text.startsWith("first thing")).toBe(true);
      expect(text).toContain("second thing");
      // Separator includes "[HH:MM:SS] " — 8 digit chars + colons.
      expect(/\n\n\[\d{2}:\d{2}:\d{2}\] /.test(text)).toBe(true);
    } finally {
      unsub();
    }
  });

  test("two events spaced past debounce produce two separate turns", async () => {
    const { manager, appended } = makeMockSessions();
    const unsub = registerChatPoster({
      sessions: manager,
      config: { ...baseConfig, debounce_ms: 30 },
    });

    try {
      getBus().publish("asr.final", mkEvent({ media_id: "m1", text: "first thing" }));
      await new Promise((r) => setTimeout(r, 100));
      getBus().publish("asr.final", mkEvent({ media_id: "m2", text: "second thing" }));
      await new Promise((r) => setTimeout(r, 100));

      const msgs = appended.get("voice:coalesce-test") ?? [];
      expect(msgs.length).toBe(2);
      expect(msgs[0].content[0].text).toBe("first thing");
      expect(msgs[1].content[0].text).toBe("second thing");
    } finally {
      unsub();
    }
  });

  test("max_items flushes early even within debounce", async () => {
    const { manager, appended } = makeMockSessions();
    const unsub = registerChatPoster({
      sessions: manager,
      config: { ...baseConfig, debounce_ms: 5000, max_items: 2 },
    });

    try {
      getBus().publish("asr.final", mkEvent({ media_id: "m1", text: "one" }));
      getBus().publish("asr.final", mkEvent({ media_id: "m2", text: "two" }));
      // Third event must trip the max_items flush of the prior pair before
      // joining a fresh buffer.
      getBus().publish("asr.final", mkEvent({ media_id: "m3", text: "three" }));
      await new Promise((r) => setTimeout(r, 50));

      const msgs = appended.get("voice:coalesce-test") ?? [];
      // First flush has m1+m2 coalesced; m3 still pending in a fresh buffer.
      expect(msgs.length).toBe(1);
      expect(msgs[0].content[0].text).toContain("one");
      expect(msgs[0].content[0].text).toContain("two");
      expect(msgs[0].content[0].text).not.toContain("three");
    } finally {
      unsub();
    }
  });

  test("max_chars flushes early even within debounce", async () => {
    const { manager, appended } = makeMockSessions();
    const unsub = registerChatPoster({
      sessions: manager,
      // max_chars set just above one memo; second memo can't fit.
      config: { ...baseConfig, debounce_ms: 5000, max_chars: 25 },
    });

    try {
      getBus().publish("asr.final", mkEvent({ media_id: "m1", text: "twenty-char string..." }));
      getBus().publish("asr.final", mkEvent({ media_id: "m2", text: "another twenty-char str" }));
      await new Promise((r) => setTimeout(r, 50));

      const msgs = appended.get("voice:coalesce-test") ?? [];
      // First memo flushed because adding the second would overflow max_chars.
      expect(msgs.length).toBe(1);
      expect(msgs[0].content[0].text).toContain("twenty-char string");
      expect(msgs[0].content[0].text).not.toContain("another twenty-char");
    } finally {
      unsub();
    }
  });

  test("flush_age_ms forces flush even with rapid arrivals", async () => {
    const { manager, appended } = makeMockSessions();
    const unsub = registerChatPoster({
      sessions: manager,
      // Very short flush_age so a steady stream of fast events still flushes.
      config: { ...baseConfig, debounce_ms: 5000, flush_age_ms: 30 },
    });

    try {
      getBus().publish("asr.final", mkEvent({ media_id: "m1", text: "one" }));
      await new Promise((r) => setTimeout(r, 10));
      getBus().publish("asr.final", mkEvent({ media_id: "m2", text: "two" }));
      await new Promise((r) => setTimeout(r, 50));
      // By now the buffer is older than flush_age_ms; the next event should
      // trip the age-based forced flush.
      getBus().publish("asr.final", mkEvent({ media_id: "m3", text: "three" }));
      await new Promise((r) => setTimeout(r, 50));

      const msgs = appended.get("voice:coalesce-test") ?? [];
      // m1+m2 flushed via age trigger when m3 arrived; m3 still pending.
      expect(msgs.length).toBe(1);
      expect(msgs[0].content[0].text).toContain("one");
      expect(msgs[0].content[0].text).toContain("two");
    } finally {
      unsub();
    }
  });
});
