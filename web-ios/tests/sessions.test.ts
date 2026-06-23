import { describe, it, expect } from "vitest";
import { cleanSessions, sessionDisplayName, sessionKeyFromId, type SessionEntry } from "../src/lib/session-store";

function s(partial: Partial<SessionEntry> & { key: string }): SessionEntry {
  return { id: partial.key.replace(":", "/"), createdAt: "2026-06-21T00:00:00Z", messageCount: 1, ...partial };
}

describe("cleanSessions", () => {
  it("hides realtime/cron/heartbeat channels", () => {
    const out = cleanSessions([
      s({ key: "web:ios", messageCount: 5 }),
      s({ key: "realtime:probe-abc", messageCount: 2 }),
      s({ key: "cron:standup", messageCount: 3 }),
      s({ key: "heartbeat:main", messageCount: 1 }),
    ], "web:ios");
    expect(out.map((e) => e.key)).toEqual(["web:ios"]);
  });

  it("hides empty (0-msg) sessions except the active one", () => {
    const out = cleanSessions([
      s({ key: "web:ios", messageCount: 8 }),
      s({ key: "web:general", messageCount: 0 }),
      s({ key: "web:current", messageCount: 0 }), // active, kept
    ], "web:current");
    expect(out.map((e) => e.key).sort()).toEqual(["web:current", "web:ios"]);
  });

  it("hides per-session -bridge backend channels", () => {
    const out = cleanSessions([
      s({ key: "web:ios", messageCount: 5 }),
      s({ key: "web:ios-bridge", messageCount: 12 }),
    ], "web:ios");
    expect(out.map((e) => e.key)).toEqual(["web:ios"]);
  });

  it("sorts pinned first, then most-recent", () => {
    const out = cleanSessions([
      s({ key: "web:old", messageCount: 1, createdAt: "2026-06-01T00:00:00Z" }),
      s({ key: "web:new", messageCount: 1, createdAt: "2026-06-20T00:00:00Z" }),
      s({ key: "web:pinned", messageCount: 1, createdAt: "2026-05-01T00:00:00Z", pinned: true }),
    ], "web:ios");
    expect(out.map((e) => e.key)).toEqual(["web:pinned", "web:new", "web:old"]);
  });
});

describe("sessionDisplayName", () => {
  it("prefers displayName, falls back to the key suffix", () => {
    expect(sessionDisplayName(s({ key: "web:ios", displayName: "My Chat" }))).toBe("My Chat");
    expect(sessionDisplayName(s({ key: "web:project-x" }))).toBe("project-x");
  });
});

describe("sessionKeyFromId", () => {
  it("normalizes slash ids to colon keys", () => {
    expect(sessionKeyFromId("web/ios")).toBe("web:ios");
    expect(sessionKeyFromId("web:ios")).toBe("web:ios");
  });
});
