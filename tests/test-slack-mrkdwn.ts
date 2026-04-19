// =============================================================================
// Tests: CommonMark → Slack mrkdwn converter
//
// The agent produces standard markdown. Slack's mrkdwn dialect differs in
// several ways (single asterisk for bold, underscores for italic, no
// native headings, angle-bracket links). This converter bridges the gap.
// =============================================================================

import { describe, test, expect } from "bun:test";
import { toMrkdwn } from "../src/gateway/adapters/slack.js";

describe("toMrkdwn — bold", () => {
  test("**text** → *text*", () => {
    expect(toMrkdwn("hello **world** done")).toBe("hello *world* done");
  });

  test("multiple bold runs in one line", () => {
    expect(toMrkdwn("**one** and **two**")).toBe("*one* and *two*");
  });

  test("bold at start of line", () => {
    expect(toMrkdwn("**Active conversations:**")).toBe("*Active conversations:*");
  });

  test("bold in list item", () => {
    expect(toMrkdwn("1. **Yi Sun** (Apr 13)")).toBe("1. *Yi Sun* (Apr 13)");
  });

  test("preserves bold when text has punctuation", () => {
    expect(toMrkdwn("send **'hi, there'** message")).toBe("send *'hi, there'* message");
  });
});

describe("toMrkdwn — italic", () => {
  test("*text* → _text_", () => {
    expect(toMrkdwn("hello *world* done")).toBe("hello _world_ done");
  });

  test("single-word italic", () => {
    expect(toMrkdwn("he said *maybe* later")).toBe("he said _maybe_ later");
  });

  test("does not eat bold (double-asterisk pass runs first)", () => {
    expect(toMrkdwn("**bold** and *italic*")).toBe("*bold* and _italic_");
  });

  test("ignores asterisks inside inline code", () => {
    expect(toMrkdwn("use `a*b` not *c*")).toBe("use `a*b` not _c_");
  });
});

describe("toMrkdwn — strikethrough", () => {
  test("~~text~~ → ~text~", () => {
    expect(toMrkdwn("~~old~~ new")).toBe("~old~ new");
  });
});

describe("toMrkdwn — links", () => {
  test("[text](url) → <url|text>", () => {
    expect(toMrkdwn("see [docs](https://example.com)")).toBe("see <https://example.com|docs>");
  });

  test("multiple links", () => {
    expect(toMrkdwn("[a](u1) and [b](u2)")).toBe("<u1|a> and <u2|b>");
  });
});

describe("toMrkdwn — headings", () => {
  test("# heading → *heading*", () => {
    expect(toMrkdwn("# Title")).toBe("*Title*");
  });

  test("## heading → *heading*", () => {
    expect(toMrkdwn("## Section")).toBe("*Section*");
  });

  test("heading mid-document", () => {
    const input = "intro\n\n## Section\n\ncontent";
    expect(toMrkdwn(input)).toBe("intro\n\n*Section*\n\ncontent");
  });
});

describe("toMrkdwn — code fences (preserved)", () => {
  test("triple-backtick code block passes through", () => {
    const input = "look at\n```\nconst x = **1**;\n```\nend";
    // Content inside code fence must NOT be rewritten
    expect(toMrkdwn(input)).toContain("const x = **1**;");
  });

  test("inline code not rewritten", () => {
    expect(toMrkdwn("use `**literal**` here")).toContain("`**literal**`");
  });

  test("bold outside fence still converted", () => {
    const input = "**bold**\n```\n**literal**\n```\n**also bold**";
    const out = toMrkdwn(input);
    expect(out).toContain("*bold*");
    expect(out).toContain("**literal**"); // preserved
    expect(out).toContain("*also bold*");
  });
});

describe("toMrkdwn — real-world samples", () => {
  test("agent DM summary (from manual test)", () => {
    const input = "**Active conversations:**\n\n1. **Yi Sun** (Apr 13) — Sent you a detailed report";
    const out = toMrkdwn(input);
    expect(out).toBe("*Active conversations:*\n\n1. *Yi Sun* (Apr 13) — Sent you a detailed report");
  });

  test("mixed bold + italic + link + inline code", () => {
    const input = "**Important**: see *docs* at [site](https://ex.com) and run `cmd --flag`";
    expect(toMrkdwn(input)).toBe(
      "*Important*: see _docs_ at <https://ex.com|site> and run `cmd --flag`",
    );
  });

  test("empty string passes through", () => {
    expect(toMrkdwn("")).toBe("");
  });

  test("plain text unchanged", () => {
    expect(toMrkdwn("just a plain sentence.")).toBe("just a plain sentence.");
  });

  test("bullet list with bold items", () => {
    const input = "- **Alpha**: first\n- **Beta**: second";
    expect(toMrkdwn(input)).toBe("- *Alpha*: first\n- *Beta*: second");
  });
});
