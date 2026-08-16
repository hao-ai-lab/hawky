// A9 — Reviewed voiceprint -> memory-candidate BRIDGE unit tests.
//
// The bridge is the missing link that feeds a REVIEWED owner tag into the
// memory-candidate path. These tests pin the FAIL-CLOSED invariant across every
// result type, the no-secrets guard, and the crash-safety degrade.

import { describe, expect, test } from "bun:test";
import {
  buildVoiceprintTurnRecords,
  applyVoiceprintReviewDecision,
  voiceprintTurnRecordsToMemoryCandidate,
  assertVoiceprintMemoryCandidateHasNoSecrets,
  type VoiceprintTurnRecords,
} from "../src/identity/voiceprint/index.js";
import { assertMemoryCandidate } from "../src/memory/candidate.js";
import {
  registerVoiceprintMethods,
  resolveVoiceprintMemoryBridgeConfigFromConfig,
  createInMemoryVoiceprintStorage,
} from "../src/gateway/voiceprint-methods.js";

const createdAt = "2026-07-11T00:00:00.000Z";
const model = { provider: "custom" as const, modelId: "bridge-model", version: "1" };
const processingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
};
const promotionConsent = {
  ...processingConsent,
  memoryPromotionAllowed: true,
};

function turn(overrides: Partial<{ transcriptItemId: string }> = {}) {
  return {
    sessionKey: "live:bridge",
    transcriptItemId: overrides.transcriptItemId ?? "rt_bridge_1",
    role: "user" as const,
    text: "remind me to buy milk",
    startMs: 1000,
    endMs: 3000,
    audioArtifactId: "audio_bridge",
    route: "iphone_mic",
  };
}

function strongOwnerRecords(consent = promotionConsent): VoiceprintTurnRecords {
  return buildVoiceprintTurnRecords({
    turn: turn(),
    scoring: {
      result: "owner_speaking",
      confidence: 0.95,
      score: 0.95,
      thresholdUsed: 0.82,
      model,
    },
    consent,
    createdAt,
  });
}

describe("voiceprint memory bridge — fail-closed gate", () => {
  test("strong + consented + confirmed owner turn yields a PROMOTABLE durable candidate", () => {
    const records = strongOwnerRecords();
    // owner_speaking builds with review.state === "confirmed" and memoryPromotion=true.
    expect(records.identitySignal.review.state).toBe("confirmed");
    expect(records.transcriptSpeakerAnnotation.allowedUses.memoryPromotion).toBe(true);

    const result = voiceprintTurnRecordsToMemoryCandidate(records, {
      consent: promotionConsent,
      createdAt,
    });

    expect(result.promotable).toBe(true);
    expect(result.candidate.allowedUses.durableMemory).toBe(true);
    expect(result.candidate.quarantineReason).toBeUndefined();
    // review state mirrors the source signal (confirmed), never upgraded past it.
    expect(result.candidate.review.state).toBe("confirmed");
    expect(result.candidate.subjects[0]).toEqual({ type: "owner" });
    assertMemoryCandidate(result.candidate);
  });

  test("consent WITHHELD forces quarantine even for a confirmed owner turn", () => {
    // Build the records with promotion consent so the annotation itself permits
    // memory, then bridge with consent that WITHHOLDS memory promotion. The strict
    // gate must still refuse durable.
    const records = strongOwnerRecords();
    const result = voiceprintTurnRecordsToMemoryCandidate(records, {
      consent: { ...processingConsent, memoryPromotionAllowed: false },
      createdAt,
    });
    expect(result.promotable).toBe(false);
    expect(result.candidate.allowedUses.durableMemory).toBe(false);
    expect(result.candidate.quarantineReason).toBe("unreviewed_identity_signal");
  });

  test("score below ownerAccept forces quarantine", () => {
    const records = strongOwnerRecords();
    // Raise ownerAccept above the record's score of 0.95.
    const result = voiceprintTurnRecordsToMemoryCandidate(records, {
      consent: promotionConsent,
      thresholds: { ownerAccept: 0.99, ownerPossible: 0.72 },
      createdAt,
    });
    expect(result.promotable).toBe(false);
    expect(result.candidate.allowedUses.durableMemory).toBe(false);
    expect(result.candidate.quarantineReason).toBe("unreviewed_identity_signal");
  });

  test("possible_owner is ALWAYS quarantined, never durable", () => {
    const records = buildVoiceprintTurnRecords({
      turn: turn({ transcriptItemId: "rt_possible" }),
      scoring: {
        result: "possible_owner",
        confidence: 0.78,
        score: 0.78,
        thresholdUsed: 0.82,
        model,
      },
      consent: promotionConsent,
      createdAt,
    });
    const result = voiceprintTurnRecordsToMemoryCandidate(records, {
      consent: promotionConsent,
      createdAt,
    });
    expect(result.promotable).toBe(false);
    expect(result.candidate.allowedUses.durableMemory).toBe(false);
    expect(result.candidate.quarantineReason).toBe("unreviewed_identity_signal");
    // review mirrors the unreviewed source signal.
    expect(result.candidate.review.state).toBe("unreviewed");
  });

  test("unknown_cluster is quarantined, never durable", () => {
    const records = buildVoiceprintTurnRecords({
      turn: turn({ transcriptItemId: "rt_cluster" }),
      scoring: {
        result: "unknown_cluster",
        confidence: 0.6,
        score: 0.6,
        thresholdUsed: 0.82,
        model,
        clusterId: "cluster_7",
      },
      consent: promotionConsent,
      createdAt,
    });
    const result = voiceprintTurnRecordsToMemoryCandidate(records, {
      consent: promotionConsent,
      createdAt,
    });
    expect(result.promotable).toBe(false);
    expect(result.candidate.allowedUses.durableMemory).toBe(false);
    expect(result.candidate.quarantineReason).toBe("unreviewed_identity_signal");
  });

  test("unknown_speaker is quarantined, never durable", () => {
    const records = buildVoiceprintTurnRecords({
      turn: turn({ transcriptItemId: "rt_unknown" }),
      scoring: {
        result: "unknown_speaker",
        confidence: 0.3,
        score: 0.3,
        thresholdUsed: 0.82,
        model,
      },
      consent: promotionConsent,
      createdAt,
    });
    const result = voiceprintTurnRecordsToMemoryCandidate(records, {
      consent: promotionConsent,
      createdAt,
    });
    expect(result.promotable).toBe(false);
    expect(result.candidate.allowedUses.durableMemory).toBe(false);
    expect(result.candidate.subjects[0]).toEqual({ type: "unknown" });
  });

  test("a REJECTED owner signal is quarantined, never durable", () => {
    const records = strongOwnerRecords();
    const rejected = applyVoiceprintReviewDecision({
      records,
      decision: "reject_identity",
      reviewedAt: createdAt,
    }).records;
    expect(rejected.identitySignal.review.state).toBe("rejected");
    const result = voiceprintTurnRecordsToMemoryCandidate(rejected, {
      consent: promotionConsent,
      createdAt,
    });
    expect(result.promotable).toBe(false);
    expect(result.candidate.allowedUses.durableMemory).toBe(false);
    // review state mirrors the rejected source (never upgraded).
    expect(result.candidate.review.state).toBe("rejected");
  });

  test("a SUPPRESSED owner signal is quarantined, never durable", () => {
    const records = strongOwnerRecords();
    const suppressed = applyVoiceprintReviewDecision({
      records,
      decision: "suppress_identity",
      reviewedAt: createdAt,
    }).records;
    expect(suppressed.identitySignal.review.state).toBe("suppressed");
    const result = voiceprintTurnRecordsToMemoryCandidate(suppressed, {
      consent: promotionConsent,
      createdAt,
    });
    expect(result.promotable).toBe(false);
    expect(result.candidate.allowedUses.durableMemory).toBe(false);
    expect(result.candidate.review.state).toBe("suppressed");
  });

  test("missing consent (default) fails closed to quarantine", () => {
    const records = strongOwnerRecords(processingConsent);
    // No consent override AND the signal consent withholds memory promotion.
    const result = voiceprintTurnRecordsToMemoryCandidate(records, { createdAt });
    expect(result.promotable).toBe(false);
    expect(result.candidate.allowedUses.durableMemory).toBe(false);
  });
});

describe("voiceprint memory bridge — no-secrets guard", () => {
  test("every produced candidate passes the no-secrets allow-list guard", () => {
    const records = strongOwnerRecords();
    const result = voiceprintTurnRecordsToMemoryCandidate(records, {
      consent: promotionConsent,
      createdAt,
    });
    expect(() => assertVoiceprintMemoryCandidateHasNoSecrets(result.candidate)).not.toThrow();
    // Metadata carries scalars/ids/tags only.
    expect(result.candidate.metadata.bridge).toBe("voiceprint_memory_bridge");
    expect(result.candidate.metadata.result).toBe("owner_speaking");
    expect(typeof result.candidate.metadata.score).toBe("number");
    expect(result.candidate.metadata).not.toHaveProperty("embedding");
    expect(result.candidate.metadata).not.toHaveProperty("audioPath");
  });

  test("guard REJECTS a smuggled embedding vector in metadata", () => {
    const records = strongOwnerRecords();
    const result = voiceprintTurnRecordsToMemoryCandidate(records, {
      consent: promotionConsent,
      createdAt,
    });
    const tampered = {
      ...result.candidate,
      metadata: { ...result.candidate.metadata, embedding: [0.1, 0.2, 0.3] },
    };
    expect(() => assertVoiceprintMemoryCandidateHasNoSecrets(tampered as any)).toThrow(
      /disallowed field "embedding"/,
    );
  });

  test("guard REJECTS a smuggled raw audioPath in metadata", () => {
    const records = strongOwnerRecords();
    const result = voiceprintTurnRecordsToMemoryCandidate(records, {
      consent: promotionConsent,
      createdAt,
    });
    const tampered = {
      ...result.candidate,
      metadata: { ...result.candidate.metadata, audioPath: "/tmp/secret.wav" },
    };
    expect(() => assertVoiceprintMemoryCandidateHasNoSecrets(tampered as any)).toThrow(
      /disallowed field "audioPath"/,
    );
  });

  test("guard REJECTS a vector smuggled as the score scalar", () => {
    const records = strongOwnerRecords();
    const result = voiceprintTurnRecordsToMemoryCandidate(records, {
      consent: promotionConsent,
      createdAt,
    });
    const tampered = {
      ...result.candidate,
      metadata: { ...result.candidate.metadata, score: [0.9, 0.8] as unknown as number },
    };
    expect(() => assertVoiceprintMemoryCandidateHasNoSecrets(tampered as any)).toThrow(
      /score must be a finite number/,
    );
  });
});

describe("voiceprint memory bridge — crash-safety degrade", () => {
  test("a malformed record degrades to a quarantined candidate, never a throw", () => {
    // Missing speakerTurnTag/identitySignal/annotation triggers the internal throw;
    // the bridge must swallow it into a quarantined, non-durable candidate.
    const broken = {} as unknown as VoiceprintTurnRecords;
    let result!: ReturnType<typeof voiceprintTurnRecordsToMemoryCandidate>;
    expect(() => {
      result = voiceprintTurnRecordsToMemoryCandidate(broken, { createdAt });
    }).not.toThrow();
    expect(result.promotable).toBe(false);
    expect(result.candidate.allowedUses.durableMemory).toBe(false);
    expect(result.candidate.quarantineReason).toBe("unreviewed_identity_signal");
    expect(result.degradeReason).toMatch(/bridge_error/);
    assertMemoryCandidate(result.candidate);
    expect(() => assertVoiceprintMemoryCandidateHasNoSecrets(result.candidate)).not.toThrow();
  });

  test("a record whose identitySignal throws inside the mapping still degrades", () => {
    const records = strongOwnerRecords();
    // Poison the review accessor so reading review.state throws mid-mapping.
    const poisoned = {
      ...records,
      identitySignal: new Proxy(records.identitySignal, {
        get(target, prop, receiver) {
          if (prop === "review") throw new Error("boom");
          return Reflect.get(target, prop, receiver);
        },
      }),
    } as unknown as VoiceprintTurnRecords;
    let result!: ReturnType<typeof voiceprintTurnRecordsToMemoryCandidate>;
    expect(() => {
      result = voiceprintTurnRecordsToMemoryCandidate(poisoned, { createdAt });
    }).not.toThrow();
    expect(result.candidate.allowedUses.durableMemory).toBe(false);
    expect(result.candidate.quarantineReason).toBe("unreviewed_identity_signal");
  });
});

describe("voiceprint memory bridge — opt-in / no-op-by-default wiring", () => {
  test("config resolver defaults DISABLED", () => {
    expect(resolveVoiceprintMemoryBridgeConfigFromConfig({} as any)).toEqual({ enabled: false });
    expect(
      resolveVoiceprintMemoryBridgeConfigFromConfig({
        voiceprint: { memory_bridge: { enabled: false } },
      } as any),
    ).toEqual({ enabled: false });
    expect(
      resolveVoiceprintMemoryBridgeConfigFromConfig({
        voiceprint: { memory_bridge: { enabled: true } },
      } as any),
    ).toEqual({ enabled: true });
  });

  test("bridge RPC is REFUSED by default (disabled), and works when enabled", async () => {
    const disabledServer = makeMockServer();
    registerVoiceprintMethods(disabledServer as any, createInMemoryVoiceprintStorage());
    const records = strongOwnerRecords();
    // The handler is synchronous and throws synchronously when disabled.
    expect(() =>
      disabledServer.call(
        "identity.voiceprint.bridge_memory_candidate",
        { sessionKey: "live:bridge" },
        { records, consent: promotionConsent, createdAt },
      ),
    ).toThrow(/disabled/);

    const enabledServer = makeMockServer();
    registerVoiceprintMethods(
      enabledServer as any,
      createInMemoryVoiceprintStorage(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { enabled: true },
    );
    const result = await enabledServer.call(
      "identity.voiceprint.bridge_memory_candidate",
      { sessionKey: "live:bridge" },
      { records, consent: promotionConsent, createdAt },
    );
    expect(result.ok).toBe(true);
    expect(result.promotable).toBe(true);
    expect(result.candidate.allowedUses.durableMemory).toBe(true);
    expect(result.sessionKey).toBe("live:bridge");
  });

  test("bridge RPC rejects a cross-session records payload", async () => {
    const server = makeMockServer();
    registerVoiceprintMethods(
      server as any,
      createInMemoryVoiceprintStorage(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { enabled: true },
    );
    const records = strongOwnerRecords();
    expect(() =>
      server.call(
        "identity.voiceprint.bridge_memory_candidate",
        { sessionKey: "live:other-session" },
        { records, consent: promotionConsent, createdAt },
      ),
    ).toThrow(/does not match/);
  });
});

function makeMockServer() {
  const methods: Record<string, Function> = {};
  return {
    registerMethod(name: string, handler: Function) {
      methods[name] = handler;
    },
    call(name: string, conn: { sessionKey: string | null }, params: unknown) {
      const method = methods[name];
      if (!method) {
        throw new Error(`Method not found: ${name}`);
      }
      return method(conn, params, this);
    },
  };
}
