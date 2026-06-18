// =============================================================================
// Test: Modes (M4 gateway core)
// Run: bun test tests/test-modes.ts
// Verifies: projectMode latentIntentionEnabled only.
// Modes are scaffolding for the (deferred) latent path; at this stage they
// change ONLY latentIntentionEnabled — no other settings.
// =============================================================================

import { describe, expect, test } from "bun:test";
import { projectMode } from "../src/ambient/modes.js";

describe("projectMode — latentIntentionEnabled", () => {
  test("quiet → latentIntentionEnabled === false", () => {
    expect(projectMode("quiet").latentIntentionEnabled).toBe(false);
  });

  test("ambient → latentIntentionEnabled === true", () => {
    expect(projectMode("ambient").latentIntentionEnabled).toBe(true);
  });

  test("directive → latentIntentionEnabled === true", () => {
    expect(projectMode("directive").latentIntentionEnabled).toBe(true);
  });
});
