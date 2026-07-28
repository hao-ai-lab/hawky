import { describe, it, expect } from "vitest";
import { historyToTranscript } from "../src/lib/transcript-view";
import { sessionKeyFromId } from "../src/lib/session-store";

describe("sessionKeyFromId", () => {
  it("normalizes the first slash to a colon (session.list id → key)", () => {
    expect(sessionKeyFromId("web/ios")).toBe("web:ios");
    expect(sessionKeyFromId("realtime/abc-123")).toBe("realtime:abc-123");
  });
  it("leaves colon-form ids untouched", () => {
    expect(sessionKeyFromId("web:ios")).toBe("web:ios");
  });
  it("leaves plain ids untouched", () => {
    expect(sessionKeyFromId("general")).toBe("general");
  });
});

describe("historyToTranscript", () => {
  it("maps user/assistant text blocks to bubbles", () => {
    const out = historyToTranscript([
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: "2026-06-21T10:00:00Z" },
      { role: "assistant", content: [{ type: "text", text: "hi there" }] },
    ]);
    expect(out.map((e) => [e.kind, e.text])).toEqual([
      ["user", "hello"],
      ["assistant", "hi there"],
    ]);
  });

  it("keeps history a clean conversation: drops raw backend tool blocks + bridge/system noise", () => {
    const out = historyToTranscript([
      { role: "user", content: [{ type: "text", text: "remind me to buy milk" }] },
      // backend agent noise that must NOT appear in the user's transcript:
      { role: "user", content: [{ type: "text", text: "[From web-ios Live]\nCreate a reminder…" }] },
      { role: "assistant", content: [{ type: "tool_use", name: "cron", input: { action: "add" } }] },
      { role: "user", content: [{ type: "tool_result", content: "Created cron job" }] },
      { role: "assistant", content: [{ type: "text", text: "[No remote nodes connected.] anything" }] },
      { role: "assistant", content: [{ type: "text", text: "Reminder set!" }] },
    ]);
    expect(out.map((e) => [e.kind, e.text])).toEqual([
      ["user", "remind me to buy milk"],
      ["assistant", "Reminder set!"],
    ]);
  });

  it("restores a PERSISTED tool record into a tool bubble (with status)", () => {
    const marker = "⁣TOOL⁣";
    const out = historyToTranscript([
      { role: "user", content: [{ type: "text", text: "remind me to buy milk" }] },
      { role: "assistant", content: [{ type: "text", text: `${marker}${JSON.stringify({ label: "Delegating: set reminder", status: "ok", detail: "Done.", ms: 420 })}` }] },
      { role: "assistant", content: [{ type: "text", text: "Reminder set!" }] },
    ]);
    expect(out.map((e) => e.kind)).toEqual(["user", "tool", "assistant"]);
    const tool = out.find((e) => e.kind === "tool")!;
    expect(tool.text).toBe("Delegating: set reminder");
    expect(tool.toolStatus).toBe("ok");
    expect(tool.toolDetail).toBe("Done.");
  });

  it("dedupes consecutive identical turns (legacy double-persist)", () => {
    const out = historyToTranscript([
      { role: "assistant", content: [{ type: "text", text: "Doing well!" }] },
      { role: "assistant", content: [{ type: "text", text: "Doing well!" }] },
    ]);
    expect(out).toHaveLength(1);
  });

  it("handles string content and skips empty/unknown blocks", () => {
    const out = historyToTranscript([
      { role: "user", content: "plain string" },
      { role: "assistant", content: [{ type: "text", text: "   " }, { type: "thinking", thinking: "x" }] },
    ]);
    expect(out.map((e) => e.text)).toEqual(["plain string"]);
  });
});
