import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildEmbeddingBatchRequest,
  runEmbeddingSidecar,
} from "../src/identity/voiceprint/index.js";
import {
  createInMemoryVoiceprintStorage,
  registerVoiceprintMethods,
  type VoiceprintLiveScoringConfig,
  type VoiceprintStorageAdapter,
} from "../src/gateway/voiceprint-methods.js";
import {
  createInMemoryVoiceprintLifecycle,
  createInMemoryVoiceprintScoreTelemetrySink,
} from "../src/gateway/voiceprint-lifecycle.js";
import {
  makeMockServer,
  writeFinalizedMediaWav,
  writeSineWav,
  type MockRpcConn,
  type MockRpcServer,
} from "./helpers/voiceprint-e2e.js";

// WS1 — gateway auto-score of finalized realtime turns + identity push.
//
// These tests drive the REAL gateway RPC handlers (registerVoiceprintMethods) with
// the REAL Python reference sidecar (deterministic, dependency-free), a recording
// broadcast, and the deterministic onBatchSettled tuning hook, and prove:
//   1. flag OFF (default): the realtime_event response shape is byte-for-byte
//      unchanged and NOTHING is auto-scored or broadcast;
//   2. flag ON: a finalized turn is background-scored through the SAME internal
//      seam score_turns uses (storage bundles + A7 telemetry come free) and the
//      scored states + identity summary piggyback on the NEXT realtime_event;
//   3. wait-for-audio: a not-yet-landed WAV is retried and scored once it lands;
//   4. wait-for-audio: audio that never lands is skipped fail-safe;
//   5. edge-triggered identity: K consecutive owner turns emit EXACTLY ONE
//      voiceprint.identity broadcast (a same-verdict turn emits nothing) with a
//      scalar-only payload;
//   6. realtime_reset clears evidence + the pending piggyback buffer;
//   7. withdraw_consent (right-to-erasure) purges auto-score state too: no
//      piggyback re-delivery of erased records, no post-purge storage bundles,
//      evidence restarted;
//   8. a scoring fault never rejects, never crashes, never emits identity.

const here = dirname(fileURLToPath(import.meta.url));
const EMBED_SCRIPT = resolve(here, "..", "services", "voiceprint", "embed.py");
const PYTHON = process.env.VOICEPRINT_PYTHON ?? "python3";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function referenceSidecar() {
  return {
    command: PYTHON,
    args: [EMBED_SCRIPT],
    env: { VOICEPRINT_BACKEND: "reference" },
    timeoutMs: 20_000,
  };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function enrollOwnerEmbedding(audioPath: string): Promise<number[]> {
  const response = await runEmbeddingSidecar({
    sidecar: referenceSidecar(),
    request: buildEmbeddingBatchRequest([{ id: "owner", audioPath }]),
  });
  return response.responses[0]!.embedding;
}

interface RecordedBroadcast {
  event: string;
  payload: Record<string, unknown>;
}

/** Mock RPC server extended with a recording `broadcast` (the real GatewayServer shape). */
function makeBroadcastServer(): {
  server: MockRpcServer & { broadcast(event: string, payload: unknown): void };
  broadcasts: RecordedBroadcast[];
} {
  const broadcasts: RecordedBroadcast[] = [];
  const server = Object.assign(makeMockServer(), {
    broadcast(event: string, payload: unknown) {
      broadcasts.push({ event, payload: payload as Record<string, unknown> });
    },
  });
  return { server, broadcasts };
}

/** Deterministic settle hook: await exactly one background auto-score batch. */
function makeSettleWaiter(): {
  onBatchSettled: () => void;
  nextSettle: () => Promise<void>;
} {
  let waiters: Array<() => void> = [];
  return {
    onBatchSettled: () => {
      for (const resolveWaiter of waiters.splice(0)) {
        resolveWaiter();
      }
    },
    nextSettle: () => new Promise<void>((resolveWaiter) => waiters.push(resolveWaiter)),
  };
}

function makeScoring(
  dir: string,
  ownerVector: number[],
  autoScore: {
    enabled: boolean;
    onBatchSettled?: () => void;
    audioRetryAttempts?: number;
    audioRetryDelayMs?: number;
  },
): VoiceprintLiveScoringConfig {
  return {
    sidecar: referenceSidecar(),
    ownerEmbeddings: [ownerVector],
    allowedAudioRoots: [dir],
    consent: {
      captureAllowed: true,
      biometricAllowed: true,
      memoryPromotionAllowed: true,
      exportAllowed: false,
    },
    autoScoreFinalized: autoScore.enabled,
    autoScoreTuning: {
      audioRetryAttempts: autoScore.audioRetryAttempts ?? 3,
      audioRetryDelayMs: autoScore.audioRetryDelayMs ?? 25,
      onBatchSettled: autoScore.onBatchSettled,
    },
  };
}

async function registerArtifact(
  server: MockRpcServer,
  conn: MockRpcConn,
  audioArtifactId: string,
  mediaId: string,
): Promise<void> {
  const registered = (await server.call("identity.voiceprint.audio_artifact.register", conn, {
    audioArtifactId,
    mediaId,
  })) as { ok: boolean };
  expect(registered.ok).toBe(true);
}

/** Drive the 4-event realtime sequence that finalizes ONE turn for `itemId`. */
async function finalizeTurn(
  server: MockRpcServer,
  conn: MockRpcConn,
  itemId: string,
  audioArtifactId: string,
): Promise<Record<string, unknown>> {
  await server.call("identity.voiceprint.realtime_event", conn, {
    event: { type: "input_audio_buffer.speech_started", item_id: itemId, audio_start_ms: 0 },
  });
  await server.call("identity.voiceprint.realtime_event", conn, {
    event: { type: "input_audio_buffer.speech_stopped", item_id: itemId, audio_end_ms: 1500 },
  });
  await server.call("identity.voiceprint.realtime_event", conn, {
    event: {
      type: "live_recording.audio_artifact",
      item_id: itemId,
      audio_artifact_id: audioArtifactId,
    },
  });
  const finalize = (await server.call("identity.voiceprint.realtime_event", conn, {
    event: {
      type: "conversation.item.input_audio_transcription.completed",
      item_id: itemId,
      transcript: `finalized turn ${itemId}`,
    },
  })) as Record<string, unknown>;
  expect((finalize.finalizedTurns as unknown[]).length).toBe(1);
  return finalize;
}

/** A bare probe event that finalizes nothing: used to drain the piggyback buffer. */
async function probeEvent(
  server: MockRpcServer,
  conn: MockRpcConn,
  itemId: string,
): Promise<Record<string, unknown>> {
  return (await server.call("identity.voiceprint.realtime_event", conn, {
    event: { type: "input_audio_buffer.speech_started", item_id: itemId, audio_start_ms: 0 },
  })) as Record<string, unknown>;
}

describe("voiceprint gateway auto-score (WS1: auto_score_finalized)", () => {
  test("flag OFF (default): finalized turns are NOT auto-scored, no broadcast, response shape unchanged", async () => {
    const { server, broadcasts } = makeBroadcastServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = tempDir("vp-auto-score-off-");
    const conn = { sessionKey: "live:vp-auto-off" };

    const mediaId = "vp_auto_off.mic";
    const ownerAudioPath = writeFinalizedMediaWav(dir, mediaId, 220);
    const ownerVector = await enrollOwnerEmbedding(ownerAudioPath);

    // Default posture: autoScoreFinalized comes back false from the resolver,
    // and constructing the config WITHOUT the flag must behave identically.
    const scoring: VoiceprintLiveScoringConfig = {
      sidecar: referenceSidecar(),
      ownerEmbeddings: [ownerVector],
      allowedAudioRoots: [dir],
      consent: {
        captureAllowed: true,
        biometricAllowed: true,
        memoryPromotionAllowed: true,
        exportAllowed: false,
      },
    };
    registerVoiceprintMethods(server as any, storage, undefined, scoring);
    await registerArtifact(server, conn, "audio_auto_off", mediaId);

    const finalize = await finalizeTurn(server, conn, "rt_off_1", "audio_auto_off");
    // The pre-change realtime_event response shape, byte-for-byte: exactly these
    // keys, no scoredStates, no identity.
    expect(Object.keys(finalize).sort()).toEqual([
      "event",
      "finalizedTurns",
      "ok",
      "pendingSpeechWindows",
      "pendingTranscripts",
      "sessionKey",
    ]);

    // Nothing runs in the background: give any (buggy) stray task a beat, then
    // confirm no broadcast fired and no identity state was ever persisted.
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    expect(broadcasts).toEqual([]);
    expect(storage.snapshot?.().transcriptIdentityStates).toEqual([]);

    const probe = await probeEvent(server, conn, "rt_off_probe");
    expect(probe.scoredStates).toBeUndefined();
    expect(probe.identity).toBeUndefined();
  });

  test("flag ON: finalized turn is background-scored via the score_turns seam; states + identity piggyback on the NEXT realtime_event (telemetry + storage come free via reuse)", async () => {
    const { server, broadcasts } = makeBroadcastServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = tempDir("vp-auto-score-on-");
    const conn = { sessionKey: "live:vp-auto-on" };
    const settle = makeSettleWaiter();

    const mediaId = "vp_auto_on.mic";
    const ownerAudioPath = writeFinalizedMediaWav(dir, mediaId, 220);
    const ownerVector = await enrollOwnerEmbedding(ownerAudioPath);

    // A7 telemetry must flow through the reused seam: opt in with a recording sink.
    const lifecycle = createInMemoryVoiceprintLifecycle({
      scoreTelemetry: createInMemoryVoiceprintScoreTelemetrySink(),
    });
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      makeScoring(dir, ownerVector, { enabled: true, onBatchSettled: settle.onBatchSettled }),
      undefined,
      undefined,
      lifecycle,
    );
    await registerArtifact(server, conn, "audio_auto_on", mediaId);

    const settled = settle.nextSettle();
    const finalize = await finalizeTurn(server, conn, "rt_on_1", "audio_auto_on");
    // The finalize response itself is NOT delayed or mutated by the in-flight
    // background batch (nothing is buffered yet at response time).
    expect(finalize.scoredStates).toBeUndefined();
    await settled;

    // The NEXT realtime_event for the session carries the piggyback.
    const probe = await probeEvent(server, conn, "rt_on_probe");
    const scoredStates = probe.scoredStates as Array<Record<string, unknown>>;
    expect(Array.isArray(scoredStates)).toBe(true);
    expect(scoredStates.length).toBe(1);
    expect(scoredStates[0]?.transcriptItemId).toBe("rt_on_1");
    expect(scoredStates[0]?.lifecycle).toBe("resolved");
    expect(scoredStates[0]?.result).toBe("owner_speaking");
    const identity = probe.identity as Record<string, unknown>;
    // One owner turn < flipThreshold(3): stabilized verdict is provisional.
    expect(identity.verdict).toBe("provisional");
    expect(identity.decision).toBe("owner_speaking");
    expect(typeof identity.confidence).toBe("number");
    expect(typeof identity.at).toBe("string");

    // Drained once: the buffer does not replay on the following event.
    const probe2 = await probeEvent(server, conn, "rt_on_probe2");
    expect(probe2.scoredStates).toBeUndefined();

    // REUSE, not re-implementation: the same seam persisted the state bundle...
    expect(
      storage
        .snapshot?.()
        .transcriptIdentityStates.some(
          (s) => s.transcriptItemId === "rt_on_1" && s.lifecycle === "resolved",
        ),
    ).toBe(true);
    // ...and emitted A7 telemetry exactly as score_turns does.
    const telemetry = (await server.call(
      "identity.voiceprint.get_score_telemetry",
      conn,
      {},
    )) as { enabled: boolean; records: Array<Record<string, unknown>> };
    expect(telemetry.enabled).toBe(true);
    expect(
      telemetry.records.some((r) => r.outcome === "scored" && r.decision === "owner_speaking"),
    ).toBe(true);

    // A provisional verdict is NOT an identity establish: no broadcast yet.
    expect(broadcasts).toEqual([]);
  });

  test("wait-for-audio: a WAV that lands after finalize is retried and then scored", async () => {
    const { server } = makeBroadcastServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = tempDir("vp-auto-score-wait-");
    const conn = { sessionKey: "live:vp-auto-wait" };
    const settle = makeSettleWaiter();

    const mediaId = "vp_auto_wait.mic";
    const ownerAudioPath = writeFinalizedMediaWav(dir, mediaId, 220);
    const ownerVector = await enrollOwnerEmbedding(ownerAudioPath);

    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      makeScoring(dir, ownerVector, {
        enabled: true,
        onBatchSettled: settle.onBatchSettled,
        audioRetryAttempts: 5,
        audioRetryDelayMs: 30,
      }),
    );
    // Register while the WAV exists (registration requires it), then delete it to
    // model the live-upload tail chunk that has not landed yet.
    await registerArtifact(server, conn, "audio_auto_wait", mediaId);
    rmSync(ownerAudioPath);

    const settled = settle.nextSettle();
    await finalizeTurn(server, conn, "rt_wait_1", "audio_auto_wait");
    // First readiness check already failed (file missing); the scorer is now in
    // its retry sleep. Land the audio and let the retry pick it up.
    writeSineWav(ownerAudioPath, 220);
    await settled;

    const probe = await probeEvent(server, conn, "rt_wait_probe");
    const scoredStates = probe.scoredStates as Array<Record<string, unknown>>;
    expect(scoredStates?.length).toBe(1);
    expect(scoredStates[0]?.transcriptItemId).toBe("rt_wait_1");
    expect(scoredStates[0]?.lifecycle).toBe("resolved");
  });

  test("wait-for-audio: audio that never lands is skipped fail-safe (no states, no broadcast, no false owner)", async () => {
    const { server, broadcasts } = makeBroadcastServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = tempDir("vp-auto-score-never-");
    const conn = { sessionKey: "live:vp-auto-never" };
    const settle = makeSettleWaiter();

    const mediaId = "vp_auto_never.mic";
    const ownerAudioPath = writeFinalizedMediaWav(dir, mediaId, 220);
    const ownerVector = await enrollOwnerEmbedding(ownerAudioPath);

    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      makeScoring(dir, ownerVector, {
        enabled: true,
        onBatchSettled: settle.onBatchSettled,
        audioRetryAttempts: 2,
        audioRetryDelayMs: 5,
      }),
    );
    await registerArtifact(server, conn, "audio_auto_never", mediaId);
    rmSync(ownerAudioPath);

    const settled = settle.nextSettle();
    await finalizeTurn(server, conn, "rt_never_1", "audio_auto_never");
    await settled;

    const probe = await probeEvent(server, conn, "rt_never_probe");
    expect(probe.scoredStates).toBeUndefined();
    expect(probe.identity).toBeUndefined();
    expect(broadcasts).toEqual([]);
    expect(storage.snapshot?.().transcriptIdentityStates).toEqual([]);
  });

  test("edge-triggered identity: 3 consecutive owner turns emit EXACTLY ONE voiceprint.identity broadcast; a 4th same-verdict turn emits nothing", async () => {
    const { server, broadcasts } = makeBroadcastServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = tempDir("vp-auto-score-edge-");
    const conn = { sessionKey: "live:vp-auto-edge" };
    const settle = makeSettleWaiter();

    const mediaId = "vp_auto_edge.mic";
    const ownerAudioPath = writeFinalizedMediaWav(dir, mediaId, 220);
    const ownerVector = await enrollOwnerEmbedding(ownerAudioPath);

    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      makeScoring(dir, ownerVector, { enabled: true, onBatchSettled: settle.onBatchSettled }),
    );
    await registerArtifact(server, conn, "audio_auto_edge", mediaId);

    // DEFAULT_SPEAKER_EVIDENCE_CONFIG.flipThreshold = 3: the hard owner_present
    // flip lands on the 3rd consecutive owner turn — one establish broadcast.
    for (let i = 1; i <= 3; i += 1) {
      const settled = settle.nextSettle();
      await finalizeTurn(server, conn, `rt_edge_${i}`, "audio_auto_edge");
      await settled;
    }
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0]?.event).toBe("voiceprint.identity");
    const payload = broadcasts[0]!.payload;
    expect(payload.sessionKey).toBe(conn.sessionKey);
    expect(payload.verdict).toBe("owner_present");
    expect(payload.decision).toBe("owner_speaking");
    expect(typeof payload.confidence).toBe("number");
    expect(typeof payload.at).toBe("string");
    // NO SECRETS discipline: the payload is EXACTLY the scalar identity summary —
    // no embeddings, no audio paths, no states, no keys.
    expect(Object.keys(payload).sort()).toEqual([
      "at",
      "confidence",
      "decision",
      "sessionKey",
      "verdict",
    ]);

    // A 4th owner turn keeps verdict owner_present: edge-triggered => no new event.
    const settled4 = settle.nextSettle();
    await finalizeTurn(server, conn, "rt_edge_4", "audio_auto_edge");
    await settled4;
    expect(broadcasts.length).toBe(1);
  });

  test("realtime_reset clears the evidence state and the pending piggyback buffer", async () => {
    const { server, broadcasts } = makeBroadcastServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = tempDir("vp-auto-score-reset-");
    const conn = { sessionKey: "live:vp-auto-reset" };
    const settle = makeSettleWaiter();

    const mediaId = "vp_auto_reset.mic";
    const ownerAudioPath = writeFinalizedMediaWav(dir, mediaId, 220);
    const ownerVector = await enrollOwnerEmbedding(ownerAudioPath);

    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      makeScoring(dir, ownerVector, { enabled: true, onBatchSettled: settle.onBatchSettled }),
    );
    await registerArtifact(server, conn, "audio_auto_reset", mediaId);

    // Two owner turns: streak 2 (< flipThreshold 3), pending buffer holds 2 states.
    for (let i = 1; i <= 2; i += 1) {
      const settled = settle.nextSettle();
      await finalizeTurn(server, conn, `rt_reset_${i}`, "audio_auto_reset");
      await settled;
    }

    await server.call("identity.voiceprint.realtime_reset", conn, {});

    // Pending buffer cleared: the next event carries no piggyback.
    const probe = await probeEvent(server, conn, "rt_reset_probe");
    expect(probe.scoredStates).toBeUndefined();
    expect(probe.identity).toBeUndefined();

    // Evidence cleared: ONE more owner turn is streak 1, not streak 3 — if the
    // reset had leaked, this third consecutive owner turn would hard-flip to
    // owner_present and broadcast. (reset also cleared artifacts: re-register.)
    await registerArtifact(server, conn, "audio_auto_reset", mediaId);
    const settled = settle.nextSettle();
    await finalizeTurn(server, conn, "rt_reset_3", "audio_auto_reset");
    await settled;
    expect(broadcasts).toEqual([]);

    // The post-reset turn itself was scored (evidence restarted, not disabled).
    const probe2 = await probeEvent(server, conn, "rt_reset_probe2");
    const scoredStates = probe2.scoredStates as Array<Record<string, unknown>>;
    expect(scoredStates?.length).toBe(1);
    expect((probe2.identity as Record<string, unknown>).verdict).toBe("provisional");
  });

  test("withdraw_consent (right-to-erasure) purges auto-score state: no piggyback re-delivery, no post-purge identity states, evidence restarted", async () => {
    const { server, broadcasts } = makeBroadcastServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = tempDir("vp-auto-score-withdraw-");
    const conn = { sessionKey: "live:vp-auto-withdraw" };
    const settle = makeSettleWaiter();

    const mediaId = "vp_auto_withdraw.mic";
    const ownerAudioPath = writeFinalizedMediaWav(dir, mediaId, 220);
    const ownerVector = await enrollOwnerEmbedding(ownerAudioPath);

    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      makeScoring(dir, ownerVector, { enabled: true, onBatchSettled: settle.onBatchSettled }),
    );
    await registerArtifact(server, conn, "audio_auto_withdraw", mediaId);

    // Two owner turns: streak 2 (< flipThreshold 3), pending piggyback buffer
    // holds 2 derived-biometric states, storage holds their bundles.
    for (let i = 1; i <= 2; i += 1) {
      const settled = settle.nextSettle();
      await finalizeTurn(server, conn, `rt_wd_${i}`, "audio_auto_withdraw");
      await settled;
    }
    expect(storage.snapshot?.().transcriptIdentityStates.length).toBeGreaterThan(0);

    const withdraw = (await server.call("identity.voiceprint.withdraw_consent", conn, {})) as {
      ok: boolean;
    };
    expect(withdraw.ok).toBe(true);

    // The erased derived-biometric records must NOT be re-delivered via the
    // piggyback buffer, and the stabilized evidence verdict must not survive.
    const probe = await probeEvent(server, conn, "rt_wd_probe");
    expect(probe.scoredStates).toBeUndefined();
    expect(probe.identity).toBeUndefined();
    // Storage stays purged: no batch persisted a bundle after the purge.
    expect(storage.snapshot?.().transcriptIdentityStates).toEqual([]);

    // Evidence restarted, not leaked: ONE more owner turn is streak 1 (verdict
    // provisional). Had the pre-withdrawal streak of 2 survived, this third
    // consecutive owner turn would hard-flip to owner_present and broadcast.
    // (The purge also evicted the audio-artifact cache: re-register.)
    await registerArtifact(server, conn, "audio_auto_withdraw", mediaId);
    const settled = settle.nextSettle();
    await finalizeTurn(server, conn, "rt_wd_3", "audio_auto_withdraw");
    await settled;
    expect(broadcasts).toEqual([]);
    const probe2 = await probeEvent(server, conn, "rt_wd_probe2");
    expect((probe2.identity as Record<string, unknown>).verdict).toBe("provisional");
  });

  test("fail-safe: a scoring-path throw never rejects, never crashes, never emits identity, and never delays realtime_event", async () => {
    const { server, broadcasts } = makeBroadcastServer();
    const dir = tempDir("vp-auto-score-fault-");
    const conn = { sessionKey: "live:vp-auto-fault" };
    const settle = makeSettleWaiter();

    const mediaId = "vp_auto_fault.mic";
    const ownerAudioPath = writeFinalizedMediaWav(dir, mediaId, 220);
    const ownerVector = await enrollOwnerEmbedding(ownerAudioPath);

    // Storage that throws makes the whole reused seam throw its typed
    // MethodError — the auto-scorer must swallow it fail-safe.
    const throwingStorage: VoiceprintStorageAdapter = {
      applyBundle() {
        throw new Error("storage exploded");
      },
    };

    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", onRejection);
    try {
      registerVoiceprintMethods(
        server as any,
        throwingStorage,
        undefined,
        makeScoring(dir, ownerVector, { enabled: true, onBatchSettled: settle.onBatchSettled }),
      );
      await registerArtifact(server, conn, "audio_auto_fault", mediaId);

      const settled = settle.nextSettle();
      const finalize = await finalizeTurn(server, conn, "rt_fault_1", "audio_auto_fault");
      // The hot path succeeded and was not mutated by the failing background task.
      expect(finalize.ok).toBe(true);
      expect(finalize.scoredStates).toBeUndefined();
      await settled;

      // No identity ever emitted from a fault; the next event still succeeds and
      // carries no piggyback (the batch was skipped, not partially applied).
      const probe = await probeEvent(server, conn, "rt_fault_probe");
      expect(probe.ok).toBe(true);
      expect(probe.scoredStates).toBeUndefined();
      expect(broadcasts).toEqual([]);

      // Give any stray rejection a macrotask to surface, then assert none did.
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 20));
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });
});

// ---------------------------------------------------------------------------
// minEvidenceTurnMs — short-turn "unknown" is NEUTRAL evidence (unit-level,
// stub scoring seam; no sidecar). A short turn's unknown_speaker must neither
// vote toward not_owner nor reset the owner streak, while a LONG unknown still
// votes and a short OWNER hit still counts.
// ---------------------------------------------------------------------------
import { createVoiceprintAutoScorer, type VoiceprintAutoScoreTurn } from "../src/gateway/voiceprint-auto-score.js";
import type { VoiceprintTranscriptIdentityState } from "../src/identity/voiceprint/index.js";

function stubState(
  transcriptItemId: string,
  result: "owner_speaking" | "possible_owner" | "unknown_speaker",
): VoiceprintTranscriptIdentityState {
  return {
    version: 1,
    id: `vpstate_${transcriptItemId}` as VoiceprintTranscriptIdentityState["id"],
    source: "voiceprint",
    sessionKey: "unit:min-turn",
    transcriptItemId,
    lifecycle: result === "owner_speaking" ? "resolved" : "unknown",
    policyState: "none",
    createdAt: "2026-07-12T00:00:00.000Z",
    updatedAt: "2026-07-12T00:00:00.000Z",
    result,
  };
}

function unitTurn(id: string, durationMs: number): VoiceprintAutoScoreTurn {
  return { transcriptItemId: id, role: "user", startMs: 0, endMs: durationMs };
}

async function foldViaScorer(
  plan: Array<{ id: string; durationMs: number; result: "owner_speaking" | "possible_owner" | "unknown_speaker" }>,
  minEvidenceTurnMs: number,
): Promise<{ broadcasts: Array<Record<string, unknown>> }> {
  const broadcasts: Array<Record<string, unknown>> = [];
  const settled: Array<() => void> = [];
  const scorer = createVoiceprintAutoScorer({
    scoreTurns: async (_sessionKey, turns) => ({
      states: turns.map((turn) => {
        const spec = plan.find((p) => p.id === turn.transcriptItemId)!;
        return stubState(turn.transcriptItemId, spec.result);
      }),
    }),
    isTurnAudioReady: () => true,
    broadcast: (_event, payload) => { broadcasts.push(payload); },
    evidenceConfig: { flipThreshold: 2, windowSize: 5 },
    minEvidenceTurnMs,
    onBatchSettled: () => { settled.pop()?.(); },
  });
  for (const spec of plan) {
    await new Promise<void>((resolve) => {
      settled.push(resolve);
      scorer.enqueue("unit:min-turn", [unitTurn(spec.id, spec.durationMs)]);
    });
  }
  return { broadcasts };
}

describe("auto-score minEvidenceTurnMs (short turns are neutral)", () => {
  test("short unknowns between owner turns cannot overturn the owner verdict", async () => {
    const { broadcasts } = await foldViaScorer(
      [
        { id: "t1", durationMs: 3000, result: "owner_speaking" },
        { id: "t2", durationMs: 3000, result: "owner_speaking" }, // establish → 1 broadcast
        { id: "t3", durationMs: 800, result: "unknown_speaker" }, // short → neutral
        { id: "t4", durationMs: 900, result: "unknown_speaker" }, // short → neutral
        { id: "t5", durationMs: 700, result: "unknown_speaker" }, // short → neutral
      ],
      2000,
    );
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0]!.verdict).toBe("owner_present");
  });

  test("LONG unknowns still vote and can overturn", async () => {
    const { broadcasts } = await foldViaScorer(
      [
        { id: "t1", durationMs: 3000, result: "owner_speaking" },
        { id: "t2", durationMs: 3000, result: "owner_speaking" }, // → owner_present
        { id: "t3", durationMs: 3000, result: "unknown_speaker" },
        { id: "t4", durationMs: 3000, result: "unknown_speaker" }, // 2 long unknowns → not_owner
      ],
      2000,
    );
    expect(broadcasts.map((b) => b.verdict)).toEqual(["owner_present", "not_owner"]);
  });

  test("a SHORT owner hit still counts toward establishing", async () => {
    const { broadcasts } = await foldViaScorer(
      [
        { id: "t1", durationMs: 800, result: "owner_speaking" },
        { id: "t2", durationMs: 900, result: "owner_speaking" },
      ],
      2000,
    );
    expect(broadcasts.length).toBe(1);
    expect(broadcasts[0]!.verdict).toBe("owner_present");
  });

  test("minEvidenceTurnMs unset (default 0): short unknowns vote as before", async () => {
    const { broadcasts } = await foldViaScorer(
      [
        { id: "t1", durationMs: 3000, result: "owner_speaking" },
        { id: "t2", durationMs: 3000, result: "owner_speaking" },
        { id: "t3", durationMs: 800, result: "unknown_speaker" },
        { id: "t4", durationMs: 900, result: "unknown_speaker" },
      ],
      0,
    );
    expect(broadcasts.map((b) => b.verdict)).toEqual(["owner_present", "not_owner"]);
  });
});
