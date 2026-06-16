// =============================================================================
// Test: latent-recognizer wrapper — retry on transient errors (fix/recognizer-retry)
// Run: bun test tests/test-recognizer-retry.ts
//
// Verifies the index.ts wrapper logic:
//   (a) transient error on first call, then success → wrapper RETRIES, returns model result
//   (b) transient error on both calls → returns empty (no fallback)
//   (c) non-transient error → returns empty immediately (no retry)
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  makeRetryingRecognizer,
  isTransientError,
} from "../src/ambient/latent-recognizer.js";
import type { RecognizerInput } from "../src/ambient/latent-recognizer.js";

// Exercises the PRODUCTION makeRetryingRecognizer closure directly (no copy).

function makeInput(texts: string[], ts = "2026-06-07T10:00:00Z"): RecognizerInput {
  return {
    window: texts.map((text) => ({ role: "user" as const, text, ts })),
    recentIntentions: [],
    now: Date.now(),
    tz: "America/Los_Angeles",
  };
}

// ---------------------------------------------------------------------------
// (a) Transient-once-then-success → wrapper retries, returns model result
// ---------------------------------------------------------------------------

describe("recognizer wrapper — retry on transient error", () => {
  test("(a) transient error once then success → retries, returns MODEL result (not deterministic)", async () => {
    let calls = 0;
    const modelFn = async (_prompt: string): Promise<string> => {
      calls++;
      if (calls === 1) {
        const err = new Error("ECONNRESET: socket closed");
        throw err;
      }
      // Second call succeeds with a model result that deterministic would NOT produce
      return JSON.stringify([{ content: "buy tissue", confidence: 0.9, topic: "tissue" }]);
    };

    const wrapped = makeRetryingRecognizer(modelFn);
    const result = await wrapped.recognize(makeInput(["out of tissue"]));

    // Must have retried (2 calls to modelFn)
    expect(calls).toBe(2);
    // Must have used the MODEL result, not deterministic (deterministic doesn't cover "tissue")
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("buy tissue");
  });

  test("(b) transient error twice → returns empty (no fallback)", async () => {
    let calls = 0;
    const modelFn = async (_prompt: string): Promise<string> => {
      calls++;
      throw new Error("HTTP 503 service unavailable");
    };

    const wrapped = makeRetryingRecognizer(modelFn);
    const result = await wrapped.recognize(makeInput(["we're out of coffee"]));

    // Tried twice (retry once), then returned empty — no deterministic fallback.
    expect(calls).toBe(2);
    expect(result).toHaveLength(0);
  });

  test("(c) non-transient error → returns empty immediately, no retry", async () => {
    let calls = 0;
    const modelFn = async (_prompt: string): Promise<string> => {
      calls++;
      throw new Error("SyntaxError: unexpected token in model response");
    };

    const wrapped = makeRetryingRecognizer(modelFn);
    const result = await wrapped.recognize(makeInput(["we're out of coffee"]));

    // No retry (1 call), returns empty — no deterministic fallback.
    expect(calls).toBe(1);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// isTransientError classification tests
// ---------------------------------------------------------------------------

describe("isTransientError — classification", () => {
  test("ECONNRESET → transient", () => {
    expect(isTransientError(new Error("ECONNRESET: socket closed"))).toBe(true);
  });

  test("socket closed → transient", () => {
    expect(isTransientError(new Error("socket hang up"))).toBe(true);
  });

  test("aborted message → NOT transient (user/program cancellation is intentional)", () => {
    expect(isTransientError(new Error("The request was aborted"))).toBe(false);
  });

  test("fetch failed → transient", () => {
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
  });

  test("timeout → transient", () => {
    expect(isTransientError(new Error("request timeout exceeded"))).toBe(true);
  });

  test("overloaded → transient", () => {
    expect(isTransientError(new Error("Anthropic API overloaded"))).toBe(true);
  });

  test("rate limit → transient", () => {
    expect(isTransientError(new Error("rate limit exceeded"))).toBe(true);
  });

  test("temporarily unavailable → transient", () => {
    expect(isTransientError(new Error("temporarily unavailable"))).toBe(true);
  });

  test("HTTP 429 in message → transient", () => {
    expect(isTransientError(new Error("HTTP 429 Too Many Requests"))).toBe(true);
  });

  test("HTTP 503 in message → transient", () => {
    expect(isTransientError(new Error("HTTP 503 service unavailable"))).toBe(true);
  });

  test("HTTP 529 in message → transient", () => {
    expect(isTransientError(new Error("error 529"))).toBe(true);
  });

  test(".status = 429 → transient", () => {
    const err = Object.assign(new Error("Too Many Requests"), { status: 429 });
    expect(isTransientError(err)).toBe(true);
  });

  test(".status = 503 → transient", () => {
    const err = Object.assign(new Error("Service Unavailable"), { status: 503 });
    expect(isTransientError(err)).toBe(true);
  });

  test("Anthropic SDK APIConnectionError (default message 'Connection error.') → transient", () => {
    // SDK APIConnectionError default message does not contain ECONNRESET/socket/etc;
    // we detect it by constructor name.
    const err = new Error("Connection error.");
    Object.defineProperty(err, "constructor", { value: { name: "APIConnectionError" } });
    expect(isTransientError(err)).toBe(true);
  });

  test("Anthropic SDK APIConnectionTimeoutError (default message 'Request timed out.') → transient", () => {
    const err = new Error("Request timed out.");
    Object.defineProperty(err, "constructor", { value: { name: "APIConnectionTimeoutError" } });
    expect(isTransientError(err)).toBe(true);
  });

  test("'connection error' message → transient", () => {
    expect(isTransientError(new Error("Connection error."))).toBe(true);
  });

  test("APIUserAbortError constructor → NOT transient (user cancellation is intentional)", () => {
    const err = new Error("Request was aborted.");
    Object.defineProperty(err, "constructor", { value: { name: "APIUserAbortError" } });
    expect(isTransientError(err)).toBe(false);
  });

  test("null thrown → false (safe, no throw)", () => {
    expect(isTransientError(null)).toBe(false);
  });

  test("undefined thrown → false (safe, no throw)", () => {
    expect(isTransientError(undefined)).toBe(false);
  });

  test("SyntaxError (non-transient) → false", () => {
    expect(isTransientError(new Error("SyntaxError: unexpected token"))).toBe(false);
  });

  test("authentication error (non-transient) → false", () => {
    expect(isTransientError(new Error("401 Unauthorized: invalid API key"))).toBe(false);
  });

  test("validation error (non-transient) → false", () => {
    expect(isTransientError(new Error("400 Bad Request: invalid model"))).toBe(false);
  });
});
