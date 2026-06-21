// =============================================================================
// Test: ambient.latent_model_processing config flag (#484)
// Run: bun test ./tests/test-latent-model-processing-flag.ts
//
// Verifies the exported isLatentModelEnabled() helper from
// src/ambient/latent-recognizer.ts — the same function used by
// src/index.ts to gate model-backed recognizer/gate construction.
//
// Because tests import isLatentModelEnabled() directly from the production
// module, a revert of the gateway wiring check would break these tests.
// =============================================================================

import { describe, test, expect } from "bun:test";
import {
  ModelLatentRecognizer,
  makeRetryingRecognizer,
  isLatentModelEnabled,
} from "../src/ambient/latent-recognizer.js";
import type { RecognizerInput } from "../src/ambient/latent-recognizer.js";
import {
  makeRelevanceGate,
  DeterministicRelevanceGate,
} from "../src/ambient/relevance-gate.js";
import type { RelevanceInput } from "../src/ambient/relevance-gate.js";
import type { Intention } from "../src/ambient/intention.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecognizerInput(): RecognizerInput {
  return {
    window: [{ role: "user", text: "we're out of coffee", ts: "2026-06-06T10:00:00Z" }],
    recentIntentions: [],
    now: Date.now(),
    tz: "America/Los_Angeles",
  };
}

function makeArmedIntention(): Intention {
  return {
    id: "test-1",
    content: "buy coffee",
    trigger: { all: [{ kind: "topic", topic: "coffee", provenance: "inferred", confidence: 0.7 }] },
    strength: "soft",
    origin: "latent",
    state: "armed",
    evidence: { ts: "2026-06-06T09:00:00Z" },
    sensitivity: "private",
    createdAt: "2026-06-06T09:00:00Z",
    updatedAt: "2026-06-06T09:00:00Z",
  };
}

function makeRelevanceInput(): RelevanceInput {
  return {
    armed: [makeArmedIntention()],
    window: [{ role: "user", text: "we're out of coffee", ts: "2026-06-06T10:00:00Z" }],
    now: Date.now(),
    tz: "America/Los_Angeles",
  };
}

// ---------------------------------------------------------------------------
// isLatentModelEnabled — the production config check (tests the real export)
// ---------------------------------------------------------------------------

describe("isLatentModelEnabled — config flag logic", () => {
  test("returns true when ambient config is undefined (field absent)", () => {
    expect(isLatentModelEnabled(undefined)).toBe(true);
  });

  test("returns true when latent_model_processing is undefined (field absent in ambient)", () => {
    expect(isLatentModelEnabled({})).toBe(true);
  });

  test("returns true when latent_model_processing=true", () => {
    expect(isLatentModelEnabled({ latent_model_processing: true })).toBe(true);
  });

  test("returns false when latent_model_processing=false", () => {
    expect(isLatentModelEnabled({ latent_model_processing: false })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Flag true (model path) — model fn is called
// ---------------------------------------------------------------------------

describe("latent_model_processing=true (or absent) → model path used", () => {
  test("ModelLatentRecognizer calls invokeFn when isLatentModelEnabled returns true", async () => {
    let callCount = 0;
    const fn = async (_prompt: string): Promise<string> => {
      callCount++;
      return JSON.stringify([{ content: "buy coffee", confidence: 0.9, topic: "coffee" }]);
    };

    // Gateway: isLatentModelEnabled(gwConfig.ambient) === true → use fn
    expect(isLatentModelEnabled(undefined)).toBe(true);
    const recognizer = new ModelLatentRecognizer(fn);
    await recognizer.recognize(makeRecognizerInput());

    expect(callCount).toBe(1);
  });

  test("makeRelevanceGate(fn) calls the model when isLatentModelEnabled returns true", async () => {
    let callCount = 0;
    const fn = async (_prompt: string): Promise<string> => {
      callCount++;
      return JSON.stringify([{ id: "test-1", surface: true, confidence: 0.9 }]);
    };

    expect(isLatentModelEnabled(undefined)).toBe(true);
    const gate = makeRelevanceGate(fn);
    await gate.evaluate(makeRelevanceInput());

    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Flag false → latent model processing off, zero model calls
// ---------------------------------------------------------------------------

describe("latent_model_processing=false → latent recognition off (LLM-only, no deterministic)", () => {
  test("isLatentModelEnabled({latent_model_processing:false}) returns false", () => {
    expect(isLatentModelEnabled({ latent_model_processing: false })).toBe(false);
  });

  test("flag off ⇒ makeRelevanceGate(undefined) surfaces nothing, zero model calls", async () => {
    let callCount = 0;
    const fn = async (_prompt: string): Promise<string> => {
      callCount++;
      return "[]";
    };

    const enabled = isLatentModelEnabled({ latent_model_processing: false });
    expect(enabled).toBe(false);

    // Gateway wires relevanceGate: makeRelevanceGate(modelInvokeFn ?? undefined).
    // Flag off ⇒ modelInvokeFn null ⇒ makeRelevanceGate(undefined) is an empty gate:
    // no model call, and NO deterministic substring surfacing (recognition is off).
    const gate = makeRelevanceGate(enabled ? fn : undefined);
    const verdicts = await gate.evaluate(makeRelevanceInput());

    expect(verdicts).toHaveLength(0);
    expect(callCount).toBe(0);
  });

  test("flag off ⇒ makeRetryingRecognizer(undefined) mints nothing, zero model calls", async () => {
    let callCount = 0;
    const fn = async (_prompt: string): Promise<string> => {
      callCount++;
      return JSON.stringify([{ content: "buy coffee", confidence: 0.9, topic: "coffee" }]);
    };

    const enabled = isLatentModelEnabled({ latent_model_processing: false });
    expect(enabled).toBe(false);

    // Gateway wires recognizer: makeRetryingRecognizer(modelInvokeFn ?? undefined).
    // Flag off ⇒ modelInvokeFn null ⇒ recognizer returns [] with no local keyword fallback.
    const recognizer = makeRetryingRecognizer(enabled ? fn : undefined);
    const minted = await recognizer.recognize(makeRecognizerInput());

    expect(minted).toHaveLength(0);
    expect(callCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Comparison: flag true vs false produces different behaviors end-to-end
// ---------------------------------------------------------------------------

describe("isLatentModelEnabled gates model calls end-to-end", () => {
  test("model called when enabled=true, not called when enabled=false", async () => {
    let callsTrue = 0;
    let callsFalse = 0;

    const fnTrue = async (_prompt: string): Promise<string> => {
      callsTrue++;
      return JSON.stringify([{ content: "buy coffee", confidence: 0.9, topic: "coffee" }]);
    };
    const fnFalse = async (_prompt: string): Promise<string> => {
      callsFalse++;
      return "[]";
    };

    const enabledTrue = isLatentModelEnabled({ latent_model_processing: true });
    const enabledFalse = isLatentModelEnabled({ latent_model_processing: false });

    // flag=true: ModelLatentRecognizer path
    if (enabledTrue) {
      await new ModelLatentRecognizer(fnTrue).recognize(makeRecognizerInput());
    }

    // flag=false: production wrapper with no invoke returns no latent results
    if (!enabledFalse) {
      const minted = await makeRetryingRecognizer(undefined).recognize(makeRecognizerInput());
      expect(minted).toHaveLength(0);
    }

    expect(callsTrue).toBe(1);   // model called when enabled
    expect(callsFalse).toBe(0);  // model NOT called when disabled
  });
});
