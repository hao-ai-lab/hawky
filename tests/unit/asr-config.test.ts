// =============================================================================
// Unit tests: resolveChatPosterConfig — session_id_override allow-list.
//
// The override lands directly in AgentSessionManager.getOrCreate(sessionKey),
// which maps the key onto a filesystem path. An empty string or a traversal
// pattern must never reach that layer.
// =============================================================================

import { describe, expect, test } from "bun:test";
import { resolveChatPosterConfig } from "../../src/consumers/asr/config.js";

describe("resolveChatPosterConfig: session_id_override", () => {
  test("accepts null / absent", () => {
    expect(resolveChatPosterConfig({} as any).session_id_override).toBe(null);
    expect(resolveChatPosterConfig({ chat_poster: {} } as any).session_id_override).toBe(null);
    expect(
      resolveChatPosterConfig({ chat_poster: { session_id_override: null } } as any)
        .session_id_override,
    ).toBe(null);
  });

  test("accepts conventional session keys", () => {
    for (const key of ["voice:abcdef123456", "web:general", "cron:daily-brief", "rec-20260422-220131.mic"]) {
      const r = resolveChatPosterConfig({
        chat_poster: { session_id_override: key },
      } as any);
      expect(r.session_id_override).toBe(key);
    }
  });

  test("rejects empty / whitespace-only override", () => {
    // Empty → null (caller falls back to derived voice:<node> key).
    expect(
      resolveChatPosterConfig({ chat_poster: { session_id_override: "" } } as any)
        .session_id_override,
    ).toBe(null);
    expect(
      resolveChatPosterConfig({ chat_poster: { session_id_override: "   " } } as any)
        .session_id_override,
    ).toBe(null);
  });

  test("rejects traversal + shell-unsafe characters", () => {
    for (const bad of [
      "../escape",
      "/abs/path",
      "a b",       // whitespace
      "foo\\bar",  // backslash
      ".",         // pure dot — first-char constraint
      "..",
      "name$with$dollars",
      "x".repeat(65), // > 64 chars
    ]) {
      expect(() =>
        resolveChatPosterConfig({ chat_poster: { session_id_override: bad } } as any),
      ).toThrow(/session_id_override/);
    }
  });

  test("preserves the rest of the config shape", () => {
    const r = resolveChatPosterConfig({
      chat_poster: {
        enabled: false,
        session_id_override: "voice:node-xyz",
        prefix: "[voice] ",
        include_confidence: true,
      },
    } as any);
    expect(r.enabled).toBe(false);
    expect(r.session_id_override).toBe("voice:node-xyz");
    expect(r.prefix).toBe("[voice] ");
    expect(r.include_confidence).toBe(true);
  });
});
