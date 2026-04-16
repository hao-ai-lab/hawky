// =============================================================================
// Tests: URL Linkification (10.2h)
//
// Tests for linkifyForTui() and linkifyForWeb() which detect URLs in text
// and wrap them in OSC 8 (TUI) or <a> (web) hyperlinks.
// =============================================================================

import { describe, expect, test } from "bun:test";
import { linkifyForTui, linkifyForWeb, osc8, LINK_RE } from "../src/tui/utils/linkify.js";

// =============================================================================
// OSC 8 helper
// =============================================================================

describe("osc8 helper", () => {
  test("wraps URL in OSC 8 sequence", () => {
    const result = osc8("https://example.com", "Example");
    expect(result).toBe("\x1b]8;;https://example.com\x07Example\x1b]8;;\x07");
  });
});

// =============================================================================
// LINK_RE pattern
// =============================================================================

describe("LINK_RE", () => {
  test("matches https URLs", () => {
    expect("https://example.com".match(LINK_RE)).toEqual(["https://example.com"]);
  });

  test("matches http URLs", () => {
    expect("http://example.com".match(LINK_RE)).toEqual(["http://example.com"]);
  });

  test("matches file:// URLs", () => {
    expect("file:///Users/example/test.txt".match(LINK_RE)).toEqual(["file:///Users/example/test.txt"]);
  });

  test("matches URLs with paths and query params", () => {
    const url = "https://example.com/path?q=test&page=2#section";
    expect(url.match(LINK_RE)).toEqual([url]);
  });

  test("does not match plain text", () => {
    expect("hello world".match(LINK_RE)).toBeNull();
  });

  test("matches markdown links", () => {
    const text = "[Click here](https://example.com)";
    LINK_RE.lastIndex = 0;
    const match = LINK_RE.exec(text);
    LINK_RE.lastIndex = 0;
    expect(match).not.toBeNull();
    expect(match![1]).toBe("Click here");
    expect(match![2]).toBe("https://example.com");
  });

  test("matches file:// markdown links", () => {
    const text = "[config](file:///Users/example/.hawky/config.json)";
    LINK_RE.lastIndex = 0;
    const match = LINK_RE.exec(text);
    LINK_RE.lastIndex = 0;
    expect(match).not.toBeNull();
    expect(match![1]).toBe("config");
    expect(match![2]).toBe("file:///Users/example/.hawky/config.json");
  });
});

// =============================================================================
// linkifyForTui
// =============================================================================

describe("linkifyForTui", () => {
  test("wraps bare HTTPS URL in OSC 8", () => {
    const result = linkifyForTui("Visit https://example.com today");
    expect(result).toContain("\x1b]8;;https://example.com\x07");
    expect(result).toContain("https://example.com");
    expect(result).toContain("\x1b]8;;\x07");
  });

  test("wraps file:// URL in OSC 8", () => {
    const result = linkifyForTui("See file:///tmp/test.txt");
    expect(result).toContain("\x1b]8;;file:///tmp/test.txt\x07");
  });

  test("wraps markdown link with display text", () => {
    const result = linkifyForTui("Check [docs](https://docs.example.com) for info");
    expect(result).toContain("\x1b]8;;https://docs.example.com\x07docs\x1b]8;;\x07");
    expect(result).not.toContain("[docs]");
  });

  test("handles multiple URLs", () => {
    const result = linkifyForTui("https://a.com and https://b.com");
    expect(result).toContain("\x1b]8;;https://a.com\x07");
    expect(result).toContain("\x1b]8;;https://b.com\x07");
  });

  test("handles Wikipedia-style URLs with balanced parens", () => {
    const result = linkifyForTui("https://en.wikipedia.org/wiki/Function_(mathematics)");
    expect(result).toContain("\x1b]8;;https://en.wikipedia.org/wiki/Function_(mathematics)\x07");
  });

  test("strips trailing period from bare URL", () => {
    const result = linkifyForTui("See https://example.com.");
    expect(result).toContain("\x1b]8;;https://example.com\x07");
    expect(result).toContain("https://example.com\x1b]8;;\x07.");
  });

  test("strips trailing comma", () => {
    const result = linkifyForTui("https://a.com, https://b.com");
    expect(result).toContain("\x1b]8;;https://a.com\x07");
    expect(result).toContain("\x1b]8;;https://b.com\x07");
  });

  test("passes through text without URLs", () => {
    const text = "Hello world, no links here";
    expect(linkifyForTui(text)).toBe(text);
  });

  test("handles empty string", () => {
    expect(linkifyForTui("")).toBe("");
  });
});

// =============================================================================
// linkifyForWeb
// =============================================================================

describe("linkifyForWeb", () => {
  test("wraps bare URL in <a> tag", () => {
    const result = linkifyForWeb("Visit https://example.com today");
    expect(result).toContain('<a href="https://example.com"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain(">https://example.com</a>");
  });

  test("wraps markdown link with display text", () => {
    const result = linkifyForWeb("Check [docs](https://docs.example.com)");
    expect(result).toContain(">docs</a>");
    expect(result).not.toContain("[docs]");
  });

  test("wraps file:// URL", () => {
    const result = linkifyForWeb("See file:///tmp/test.txt");
    expect(result).toContain('href="file:///tmp/test.txt"');
  });

  test("passes through text without URLs", () => {
    const text = "No links here";
    expect(linkifyForWeb(text)).toBe(text);
  });
});
