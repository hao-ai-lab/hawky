// =============================================================================
// gemini-live-channel — live API smoke test.
//
// Gated by RUN_LIVE_TESTS=1 AND GEMINI_API_KEY. Skips gracefully when either
// is missing. Opens a real Gemini Live WebSocket, sends setup, sends one
// realtime text input, and asserts a non-empty output transcription.
//
// The gateway media consumer path is covered by mock integration tests. This
// file intentionally keeps the live test deterministic: synthetic silence,
// unprompted frames, and clientContent history seeding do not reliably trigger
// a model response on Gemini 3.1 Live.
//
// Run:
//   RUN_LIVE_TESTS=1 GEMINI_API_KEY=... bun test ./tests/live/test-gemini-live-smoke.ts
//
// Optional:
//   GEMINI_LIVE_MODEL=models/gemini-3.1-flash-live-preview
// =============================================================================

import { test, expect } from "bun:test";

import {
  DEFAULT_GEMINI_LIVE_MODEL,
  GeminiLiveClient,
} from "../../src/consumers/gemini-live-channel/client.js";

const SHOULD_RUN =
  process.env.RUN_LIVE_TESTS === "1" && !!process.env.GEMINI_API_KEY;

const LIVE_MODEL =
  process.env.GEMINI_LIVE_MODEL?.trim() || DEFAULT_GEMINI_LIVE_MODEL;

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

test("gemini-live smoke — text turn → non-empty response", async () => {
  if (!SHOULD_RUN) {
    console.log(
      "gemini-live smoke: skipped (set RUN_LIVE_TESTS=1 and GEMINI_API_KEY to run)",
    );
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY!.trim();
  const client = new GeminiLiveClient({ apiKey, model: LIVE_MODEL });
  const errors: string[] = [];
  const rawMessages: string[] = [];
  let setupComplete = false;
  let turnComplete = false;
  let text = "";

  client.onEvent((event) => {
    switch (event.kind) {
      case "setupComplete":
        setupComplete = true;
        return;
      case "textDelta":
        text += event.text;
        return;
      case "turnComplete":
        turnComplete = true;
        return;
      case "error":
        errors.push(event.message);
        return;
      case "toolCall":
      case "toolCallCancellation":
        return;
    }
  });
  client.onRawMessage((raw) => {
    rawMessages.push(raw);
    if (process.env.GEMINI_LIVE_DEBUG === "1") {
      console.log(`gemini-live raw: ${raw.slice(0, 1000)}`);
    }
  });

  try {
    await client.open();
    client.sendSetup({
      model: LIVE_MODEL,
      systemInstruction: {
        parts: [
          {
            text: "You are a short diagnostic assistant. Answer exactly and briefly.",
          },
        ],
      },
      generationConfig: {
        responseModalities: ["AUDIO"],
      },
      outputAudioTranscription: {},
    });

    try {
      await waitFor(
        "setupComplete",
        () => setupComplete || errors.length > 0 || client.isClosed,
        15_000,
      );
    } catch (err) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}; ` +
          `closed=${client.isClosed}; errors=${JSON.stringify(errors)}; ` +
          `raw=${rawMessages.slice(-3).join("\n").slice(0, 2000)}`,
      );
    }
    expect(errors).toEqual([]);
    if (!setupComplete) {
      throw new Error(
        `Gemini Live setup did not complete; closed=${client.isClosed}; ` +
          `raw=${rawMessages.slice(-3).join("\n").slice(0, 2000)}`,
      );
    }

    client.sendText("Reply with exactly two words: gemini live");

    try {
      await waitFor(
        "assistant transcription",
        () => text.trim().length > 0 || errors.length > 0 || client.isClosed,
        30_000,
      );
    } catch (err) {
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}; ` +
          `closed=${client.isClosed}; errors=${JSON.stringify(errors)}; ` +
          `raw=${rawMessages.slice(-5).join("\n").slice(0, 4000)}`,
      );
    }
    expect(errors).toEqual([]);
    if (text.trim().length === 0) {
      throw new Error(
        `Gemini Live returned no output transcription; closed=${client.isClosed}; ` +
          `raw=${rawMessages.slice(-5).join("\n").slice(0, 4000)}`,
      );
    }
    expect(text.trim().length).toBeGreaterThan(0);

    // Prefer observing turnComplete, but do not make a text smoke flaky if the
    // model returns text and the close races the final turn-complete event.
    try {
      await waitFor(
        "turnComplete",
        () => turnComplete || errors.length > 0,
        5_000,
      );
    } catch {
      // Non-fatal: the connectivity/model-response smoke already passed.
    }
  } finally {
    client.close();
  }
}, 50_000);
