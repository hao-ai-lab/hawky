// =============================================================================
// Tests for classifySlackInitError
//
// Exercises the decision logic that distinguishes the "missing dependency"
// deployment case from generic Slack adapter init failures.
// =============================================================================

import { describe, expect, test } from "bun:test";
import { classifySlackInitError } from "../src/gateway/adapters/slack-errors.js";

describe("classifySlackInitError", () => {
  test("promotes Node-style 'Cannot find module' for @slack/bolt to error", () => {
    const raw =
      "ResolveMessage: Cannot find module '@slack/bolt' from " +
      "'/home/hao/projects/hawky/src/gateway/adapters/slack.ts'";
    const decision = classifySlackInitError(raw);
    expect(decision.level).toBe("error");
    expect(decision.message).toContain("@slack/bolt is not installed");
    expect(decision.message).toContain("bun install");
  });

  test("promotes Bun-style 'Cannot find package' to error", () => {
    const raw = "Cannot find package '@slack/bolt' from '/foo/bar'";
    const decision = classifySlackInitError(raw);
    expect(decision.level).toBe("error");
    expect(decision.message).toContain("@slack/bolt is not installed");
  });

  test("names the actual missing package, not always bolt", () => {
    const raw = "Cannot find module '@slack/web-api' from '/foo/bar'";
    const decision = classifySlackInitError(raw);
    expect(decision.level).toBe("error");
    expect(decision.message).toContain("@slack/web-api is not installed");
    expect(decision.message).not.toContain("@slack/bolt");
  });

  test("falls through to warn for unrelated runtime errors", () => {
    const raw = "TypeError: foo is not a function";
    const decision = classifySlackInitError(raw);
    expect(decision.level).toBe("warn");
    expect(decision.message).toBe("slack adapter initialization failed (non-fatal)");
    expect(decision.data?.error).toBe(raw);
  });

  test("does not mis-classify a module error for a non-@slack package", () => {
    const raw = "Cannot find module 'some-other-pkg'";
    const decision = classifySlackInitError(raw);
    expect(decision.level).toBe("warn");
  });

  test("handles empty input gracefully", () => {
    const decision = classifySlackInitError("");
    expect(decision.level).toBe("warn");
    expect(decision.data?.error).toBe("");
  });
});
