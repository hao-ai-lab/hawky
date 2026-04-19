// =============================================================================
// Tests: Slack bot boundary helpers
//
// The bot is a private surface: only the configured user can DM it, and
// automated channel posts carry a visible "don't expect replies" footer.
// These tests cover the pure helpers that implement those behaviors.
// Live wiring (auto-reply delivery, Socket Mode filter) is covered by the
// manual tests in MANUAL_TESTS.md.
// =============================================================================

import { describe, test, expect } from "bun:test";
import {
  buildBotPostBody,
  buildRejectionReplyText,
} from "../src/gateway/adapters/slack.js";

// -----------------------------------------------------------------------------
// buildBotPostBody — footer decision + mrkdwn conversion
// -----------------------------------------------------------------------------

describe("buildBotPostBody — footer appended for bot-to-channel posts", () => {
  const footer = "_🤖 Automated — replies not monitored. DM <@U123> instead._";

  test("bot identity + public channel → footer appended", () => {
    const out = buildBotPostBody({
      text: "Crawl complete: 42 items",
      channel: "C0PUBLIC",
      identity: "bot",
      footer,
    });
    expect(out).toContain("Crawl complete: 42 items");
    expect(out.endsWith(footer)).toBe(true);
    expect(out).toMatch(/\n\n/); // blank line before footer
  });

  test("bot identity + private channel → footer appended", () => {
    const out = buildBotPostBody({
      text: "status",
      channel: "G0PRIVATE",
      identity: "bot",
      footer,
    });
    expect(out.endsWith(footer)).toBe(true);
  });
});

describe("buildBotPostBody — footer NOT appended for DMs or user identity", () => {
  const footer = "_🤖 Automated — replies not monitored._";

  test("bot identity + DM (D-prefixed) → no footer", () => {
    const out = buildBotPostBody({
      text: "hello",
      channel: "D0DIRECT",
      identity: "bot",
      footer,
    });
    expect(out).not.toContain("Automated");
    expect(out).toBe("hello");
  });

  test("user identity + public channel → no footer (agent is posting AS the user)", () => {
    const out = buildBotPostBody({
      text: "running late",
      channel: "C0PUBLIC",
      identity: "user",
      footer,
    });
    expect(out).not.toContain("Automated");
    expect(out).toBe("running late");
  });

  test("user identity + DM → no footer", () => {
    const out = buildBotPostBody({
      text: "hey",
      channel: "D0FRIEND",
      identity: "user",
      footer,
    });
    expect(out).not.toContain("Automated");
  });

  test("empty footer string → no footer even when other conditions match", () => {
    const out = buildBotPostBody({
      text: "silent post",
      channel: "C0PUBLIC",
      identity: "bot",
      footer: "",
    });
    expect(out).toBe("silent post");
  });
});

describe("buildBotPostBody — mrkdwn conversion still applies", () => {
  test("markdown converted regardless of footer decision", () => {
    const out = buildBotPostBody({
      text: "**bold** status",
      channel: "C0PUBLIC",
      identity: "bot",
      footer: "_note_",
    });
    // Bold converted to Slack mrkdwn
    expect(out).toContain("*bold*");
    expect(out).not.toContain("**bold**");
    // Footer still appended
    expect(out.endsWith("_note_")).toBe(true);
  });

  test("markdown converted in DM too (no footer)", () => {
    const out = buildBotPostBody({
      text: "**important**: check this",
      channel: "D0DIRECT",
      identity: "bot",
      footer: "_footer_",
    });
    expect(out).toContain("*important*");
    expect(out).not.toContain("footer");
  });
});

// -----------------------------------------------------------------------------
// buildRejectionReplyText — one-time auto-reply text
// -----------------------------------------------------------------------------

describe("buildRejectionReplyText — points uninvited DMers at the owner", () => {
  test("with allowedUserId → includes mention", () => {
    const text = buildRejectionReplyText("U05DLLF8AQ1");
    expect(text).toContain("private assistant bot");
    expect(text).toContain("<@U05DLLF8AQ1>");
  });

  test("without allowedUserId → no mention fallback", () => {
    const text = buildRejectionReplyText(null);
    expect(text).toContain("private assistant bot");
    expect(text).not.toContain("<@");
  });

  test("is a single line — Slack DMs look best as short sentences", () => {
    const text = buildRejectionReplyText("U123");
    expect(text).not.toContain("\n");
  });

  test("does not expose any internal terminology", () => {
    const text = buildRejectionReplyText("U123");
    // Shouldn't mention "Hawky", "gateway", "adapter", etc.
    expect(text).not.toMatch(/Hawky|gateway|adapter|channel\b/i);
  });
});
