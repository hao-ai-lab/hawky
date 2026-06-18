// =============================================================================
// Test: when provenance semantics (M9 §9a regression)
// Verifies: provided-when is still armable + schedules unchanged;
//           inferred-when is NOT armable (match-only, never scheduled).
// Run: bun test tests/test-when-provenance.ts
// =============================================================================

import { describe, expect, test } from "bun:test";
import { armIntention } from "../src/ambient/arming.js";
import { WhenAdapter } from "../src/ambient/arm-when.js";
import { InMemoryIntentionStore } from "../src/ambient/intention-store.js";
import type { Intention } from "../src/ambient/intention.js";
import type { ArmResult } from "../src/ambient/trigger.js";
import { isArmable, termKey } from "../src/ambient/trigger.js";
import type { WhenCronService } from "../src/ambient/arm-when.js";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function baseIntention(overrides?: Partial<Intention>): Omit<Intention, "id" | "state" | "createdAt" | "updatedAt"> {
  return {
    content: "test item",
    trigger: {},
    strength: "hard",
    origin: "obvious",
    evidence: { ts: "2026-06-07T00:00:00Z" },
    sensitivity: "private",
    ...overrides,
  };
}

function makeNullCron(): WhenCronService & { scheduled: string[]; cancelled: string[] } {
  const scheduled: string[] = [];
  const cancelled: string[] = [];
  return {
    scheduled,
    cancelled,
    scheduleAt(id, _isoTime, _callback) { scheduled.push(id); },
    cancel(id) { cancelled.push(id); },
    cancelAll() {},
  };
}

// -----------------------------------------------------------------------------
// isArmable — provenance contract
// -----------------------------------------------------------------------------

describe("isArmable: when provenance", () => {
  test("provided when (explicit at) → armable", () => {
    expect(isArmable({ kind: "when", at: "2026-06-07T10:00:00Z", provenance: "provided" })).toBe(true);
  });

  test("provided when (no provenance field, defaults to armable) → armable", () => {
    // No provenance field at all: !=="inferred" → armable
    expect(isArmable({ kind: "when", at: "2026-06-07T10:00:00Z" })).toBe(true);
  });

  test("inferred when with window → NOT armable (match-only)", () => {
    expect(isArmable({ kind: "when", window: { start: "18:00", end: "22:00" }, provenance: "inferred" })).toBe(false);
  });

  test("inferred when without window → NOT armable", () => {
    expect(isArmable({ kind: "when", provenance: "inferred" })).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// termKey — key stability contract
// -----------------------------------------------------------------------------

describe("termKey: when provenance", () => {
  test("provided when (no window) → 'when'", () => {
    expect(termKey({ kind: "when", at: "2026-06-07T10:00:00Z", provenance: "provided" })).toBe("when");
  });

  test("provided when (no provenance) → 'when'", () => {
    expect(termKey({ kind: "when", at: "2026-06-07T10:00:00Z" })).toBe("when");
  });

  test("inferred when WITH window → distinct slot key", () => {
    expect(termKey({ kind: "when", window: { start: "18:00", end: "22:00" }, provenance: "inferred" })).toBe("when:slot:18:00-22:00");
  });

  test("inferred when WITHOUT window → 'when' (no window = no slot = fall-through)", () => {
    // No window: still not a slot key, falls back to "when"
    expect(termKey({ kind: "when", provenance: "inferred" })).toBe("when");
  });
});

// -----------------------------------------------------------------------------
// Arming: provided-when still arms + schedules (regression)
// -----------------------------------------------------------------------------

describe("provided-when: arming still works (regression)", () => {
  test("provided when arms and schedules a cron job", async () => {
    const cron = makeNullCron();
    let fired = false;
    const adapter = new WhenAdapter(cron, async () => { fired = true; });
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({ trigger: { all: [{ kind: "when", at: "2026-06-07T10:00:00Z", provenance: "provided" }] } }),
    );
    const result = await adapter.arm(intention);
    expect(result.ok).toBe(true);
    expect(result.state).toBe("armed");
    expect(cron.scheduled).toHaveLength(1);
    expect(cron.scheduled[0]).toContain(intention.id);
    void fired; // silence unused warning
  });

  test("provided when (no provenance) → also arms and schedules (backward compat)", async () => {
    const cron = makeNullCron();
    const adapter = new WhenAdapter(cron, async () => {});
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({ trigger: { all: [{ kind: "when", at: "2026-06-07T10:00:00Z" }] } }),
    );
    const result = await adapter.arm(intention);
    expect(result.ok).toBe(true);
    expect(cron.scheduled).toHaveLength(1);
  });

  test("armIntention with provided when → transitions store to armed", async () => {
    const cron = makeNullCron();
    const adapter = new WhenAdapter(cron, async () => {});
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({ trigger: { all: [{ kind: "when", at: "2026-06-07T10:00:00Z", provenance: "provided" }] } }),
    );
    const outcome = await armIntention(intention, new Map([["when", adapter]]), store);
    expect(outcome).toBe("armed");
    expect((await store.get(intention.id))?.state).toBe("armed");
  });
});

// -----------------------------------------------------------------------------
// Arming: inferred-when slot is NOT scheduled (match-only)
// -----------------------------------------------------------------------------

describe("inferred-when slot: match-only, never scheduled", () => {
  test("inferred when alone → armed without adapter (match-only)", async () => {
    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({
        trigger: {
          all: [{ kind: "when", window: { start: "18:00", end: "22:00" }, provenance: "inferred", confidence: 0.8 }],
        },
      }),
    );
    // No adapters provided; inferred when is match-only — should arm immediately.
    const outcome = await armIntention(intention, new Map(), store);
    expect(outcome).toBe("armed");
    expect((await store.get(intention.id))?.state).toBe("armed");
  });

  test("inferred when + WhenAdapter provided → adapter is NOT called (term is not armable)", async () => {
    const cron = makeNullCron();
    let adapterCalled = false;
    const adapter = new WhenAdapter(cron, async () => {});
    // Override arm to track calls
    const trackingAdapter = {
      kind: "when" as const,
      async arm(i: Intention): Promise<ArmResult> {
        adapterCalled = true;
        return adapter.arm(i);
      },
      async disarm(i: Intention): Promise<void> {
        return adapter.disarm(i);
      },
    };

    const store = new InMemoryIntentionStore();
    const intention = await store.create(
      baseIntention({
        trigger: {
          all: [{ kind: "when", window: { start: "18:00", end: "22:00" }, provenance: "inferred", confidence: 0.8 }],
        },
      }),
    );
    await armIntention(intention, new Map([["when", trackingAdapter]]), store);
    // isArmable returns false for inferred when → armIntention skips the adapter.
    expect(adapterCalled).toBe(false);
    expect(cron.scheduled).toHaveLength(0);
  });

  test("inferred when: termKey is slot-specific (distinct from 'when')", () => {
    const slotKey = termKey({ kind: "when", window: { start: "18:00", end: "22:00" }, provenance: "inferred" });
    const providedKey = termKey({ kind: "when", at: "2026-06-07T10:00:00Z", provenance: "provided" });
    expect(slotKey).not.toBe(providedKey);
    expect(slotKey).toBe("when:slot:18:00-22:00");
    expect(providedKey).toBe("when");
  });
});
