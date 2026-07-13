import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildEmbeddingBatchRequest,
  buildVoiceprintStorageBundle,
  buildVoiceprintTranscriptIdentityState,
  isUsableEmbeddingVector,
  runEmbeddingSidecar,
} from "../src/identity/voiceprint/index.js";
import {
  createInMemoryVoiceprintStorage,
  registerVoiceprintMethods,
  type VoiceprintLiveScoringConfig,
} from "../src/gateway/voiceprint-methods.js";
import {
  CREATED_AT as createdAt,
  UPDATED_AT as updatedAt,
  makeMockServer,
  writeFinalizedMediaWav,
  writeSineWav,
} from "./helpers/voiceprint-e2e.js";

// TRACK 1 — Full gateway-pipeline end-to-end with the deterministic, dependency-free
// reference backend. This drives the REAL gateway RPC handlers (registerVoiceprintMethods)
// and the REAL live-sidecar-runner spawning the REAL Python reference sidecar — no mocks
// of the sidecar. It exercises the full orchestration:
//
//   register audio artifact -> realtime events build turn state -> enroll owner
//   (owner embedding from the SAME reference backend) -> score_turns resolves a
//   self-match and does NOT resolve unrelated audio -> apply_bundle persists +
//   expected_model enforcement accepts the reference tag -> realtime_reset clears state.
//
// The reference backend is NON-DISCRIMINATIVE between real speakers, but it is
// deterministic (same audio -> same vector, different audio -> different vector), so it
// fully exercises the pipeline wiring/lifecycle without weights or network. Real speaker
// discrimination is proven separately by the gated onnx e2e (e2e-voiceprint-onnx.ts).

const here = dirname(fileURLToPath(import.meta.url));
const EMBED_SCRIPT = resolve(here, "..", "services", "voiceprint", "embed.py");
const PYTHON = process.env.VOICEPRINT_PYTHON ?? "python3";

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function referenceSidecar(extraEnv?: Record<string, string>) {
  return {
    command: PYTHON,
    args: [EMBED_SCRIPT],
    env: { VOICEPRINT_BACKEND: "reference", ...extraEnv },
    timeoutMs: 20_000,
  };
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Enroll = precompute the owner embedding from the SAME reference sidecar. */
async function enrollOwnerEmbedding(audioPath: string): Promise<number[]> {
  const response = await runEmbeddingSidecar({
    sidecar: referenceSidecar(),
    request: buildEmbeddingBatchRequest([{ id: "owner", audioPath }]),
  });
  const vector = response.responses[0]!.embedding;
  expect(vector.length).toBe(192);
  expect(isUsableEmbeddingVector(vector)).toBe(true);
  return vector;
}

describe("voiceprint gateway pipeline e2e (reference backend, real sidecar)", () => {
  test("full flow: register -> realtime -> enroll -> score(self-match resolves) -> persist -> reset", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = tempDir("voiceprint-e2e-pipeline-");
    const sessionKey = "live:voiceprint-e2e-pipeline";
    const conn = { sessionKey };

    // The owner audio doubles as the finalized media artifact registered below, so the
    // scored turn reads the SAME audio the owner template was enrolled from -> cosine ~1.0.
    const mediaId = "voiceprint_e2e_owner.mic";
    const ownerAudioPath = writeFinalizedMediaWav(dir, mediaId, 220);
    const ownerVector = await enrollOwnerEmbedding(ownerAudioPath);

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

    // 1) Register the audio artifact for the generated (finalized) WAV.
    const registered = await server.call(
      "identity.voiceprint.audio_artifact.register",
      conn,
      { audioArtifactId: "audio_e2e_owner", mediaId },
    );
    expect(registered.ok).toBe(true);
    expect(registered.sessionKey).toBe(sessionKey);
    expect(registered.audioArtifact.mediaId).toBe(mediaId);

    // 2) Drive realtime transcript/audio events that build turn state:
    //    speech_started -> speech_stopped -> live_recording.audio_artifact -> transcription.
    await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "input_audio_buffer.speech_started",
        item_id: "rt_e2e_owner",
        audio_start_ms: 0,
      },
    });
    await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "input_audio_buffer.speech_stopped",
        item_id: "rt_e2e_owner",
        audio_end_ms: 1500,
      },
    });
    // The recording artifact carries only the artifact id; the gateway resolves it against
    // the registered media above and fills in audio_path/sampleRate/route.
    await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "live_recording.audio_artifact",
        item_id: "rt_e2e_owner",
        audio_artifact_id: "audio_e2e_owner",
        audio_path: "/tmp/untrusted-should-be-overridden.wav",
      },
    });
    const finalize = await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "rt_e2e_owner",
        transcript: "owner speaking to build a finalized turn",
      },
    });
    expect(finalize.ok).toBe(true);
    expect(finalize.finalizedTurns).toMatchObject([
      {
        transcriptItemId: "rt_e2e_owner",
        role: "user",
        audioArtifactId: "audio_e2e_owner",
        startMs: 0,
        endMs: 1500,
      },
    ]);

    // 3) Score the finalized turn. Self-match against the owner template -> resolved.
    const scored = await server.call("identity.voiceprint.score_turns", conn, {
      turns: [
        {
          transcriptItemId: "rt_e2e_owner",
          role: "user",
          text: "owner speaking to build a finalized turn",
          startMs: 0,
          endMs: 1500,
          audioArtifactId: "audio_e2e_owner",
        },
      ],
      consent: { captureAllowed: true, biometricAllowed: true, memoryPromotionAllowed: true },
      createdAt,
      updatedAt,
    });
    expect(scored.ok).toBe(true);
    expect(scored.status).toBe("scored");
    expect(scored.states[0]?.transcriptItemId).toBe("rt_e2e_owner");
    expect(scored.states[0]?.lifecycle).toBe("resolved");
    // score_turns persists internally; the resolved state must be visible in storage.
    const snapAfterScore = storage.snapshot?.();
    expect(snapAfterScore?.transcriptIdentityStates.some(
      (s) => s.transcriptItemId === "rt_e2e_owner" && s.lifecycle === "resolved",
    )).toBe(true);

    // 4) Explicit persistence round-trip via apply_bundle.
    const bundle = buildVoiceprintStorageBundle({
      states: [
        buildVoiceprintTranscriptIdentityState({
          sessionKey,
          transcriptItemId: "rt_e2e_apply_bundle",
          createdAt,
        }),
      ],
      createdAt,
    });
    const applied = await server.call("identity.voiceprint.apply_bundle", conn, { bundle });
    expect(applied.ok).toBe(true);
    expect(applied.bundleId).toBe(bundle.id);
    expect(applied.sessionKey).toBe(sessionKey);
    expect(storage.snapshot?.().transcriptIdentityStates.some(
      (s) => s.transcriptItemId === "rt_e2e_apply_bundle",
    )).toBe(true);

    // 5) realtime_reset clears turn tracker + artifact state for the session.
    const reset = await server.call("identity.voiceprint.realtime_reset", conn, {});
    expect(reset).toEqual({ ok: true, sessionKey });
    const afterReset = await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "rt_e2e_owner",
        transcript: "no prior speech window should exist after reset",
      },
    });
    expect(afterReset.finalizedTurns).toEqual([]);
    expect(afterReset.pendingTranscripts).toBe(1);
  });

  test("unrelated audio does NOT resolve against the owner template (deterministic discrimination of vectors)", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = tempDir("voiceprint-e2e-mismatch-");
    const sessionKey = "live:voiceprint-e2e-mismatch";
    const conn = { sessionKey };

    // Owner template is enrolled from audio A (220 Hz). The scored turn uses a DIFFERENT
    // media clip B (880 Hz) -> different reference vector -> cosine below ownerAccept/Possible.
    const ownerAudioPath = join(dir, "owner.wav");
    writeSineWav(ownerAudioPath, 220);
    const ownerVector = await enrollOwnerEmbedding(ownerAudioPath);

    const otherMediaId = "voiceprint_e2e_other.mic";
    writeFinalizedMediaWav(dir, otherMediaId, 880);

    registerVoiceprintMethods(server as any, storage, undefined, {
      sidecar: referenceSidecar(),
      ownerEmbeddings: [ownerVector],
      allowedAudioRoots: [dir],
      consent: {
        captureAllowed: true,
        biometricAllowed: true,
        memoryPromotionAllowed: true,
        exportAllowed: false,
      },
    });

    await server.call("identity.voiceprint.audio_artifact.register", conn, {
      audioArtifactId: "audio_e2e_other",
      mediaId: otherMediaId,
    });

    const scored = await server.call("identity.voiceprint.score_turns", conn, {
      turns: [
        {
          transcriptItemId: "rt_e2e_other",
          role: "user",
          text: "a different speaker/clip that should not match the owner",
          startMs: 0,
          endMs: 1500,
          audioArtifactId: "audio_e2e_other",
        },
      ],
      consent: { captureAllowed: true, biometricAllowed: true, memoryPromotionAllowed: true },
      createdAt,
      updatedAt,
    });

    expect(scored.ok).toBe(true);
    // The turn must have actually been SCORED (a real job read+sliced+embedded the WAV and
    // ran the cosine comparison), then rejected on the vector mismatch. Asserting the precise
    // "unknown" lifecycle + "scored" batch status distinguishes "scored-and-rejected" from a
    // silently-broken pipeline (missing_audio_artifact/sidecar error/consent denial would
    // yield lifecycle "skipped"/"error" and batch status "skipped"/"partial", not "scored"),
    // so this negative assertion is load-bearing on its own.
    expect(scored.status).toBe("scored");
    const state = scored.states.find((s) => s.transcriptItemId === "rt_e2e_other");
    expect(state).toBeDefined();
    // Cosine below ownerPossible -> unknown_speaker -> identity_unknown -> lifecycle "unknown".
    expect(state?.lifecycle).toBe("unknown");
  });

  test("expected_model enforcement accepts the reference model tag via an owner embedding template", async () => {
    // resolveVoiceprintLiveScoringConfigFromConfig accepts provider "reference" in
    // expected_model; the reference sidecar emits provider "reference" / modelId
    // "reference-fbank-v0". With raw ownerEmbeddings the enforcement is a no-op guard,
    // but configuring expected_model to the reference tag must NOT reject the flow — proving
    // the accept path. (Rejection of a mismatched template is covered by the methods suite.)
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = tempDir("voiceprint-e2e-model-");
    const sessionKey = "live:voiceprint-e2e-model";
    const conn = { sessionKey };

    const mediaId = "voiceprint_e2e_model.mic";
    const ownerAudioPath = writeFinalizedMediaWav(dir, mediaId, 330);
    const ownerVector = await enrollOwnerEmbedding(ownerAudioPath);

    registerVoiceprintMethods(server as any, storage, undefined, {
      sidecar: referenceSidecar(),
      ownerEmbeddings: [ownerVector],
      allowedAudioRoots: [dir],
      // The reference backend (embed.py ReferenceBackend) emits version "0"; sameVoiceprintModel
      // compares the version tag too, so the expected tag must include it to accept the scorer.
      expectedModel: { provider: "reference", modelId: "reference-fbank-v0", version: "0" },
      consent: {
        captureAllowed: true,
        biometricAllowed: true,
        memoryPromotionAllowed: true,
        exportAllowed: false,
      },
    });

    await server.call("identity.voiceprint.audio_artifact.register", conn, {
      audioArtifactId: "audio_e2e_model",
      mediaId,
    });

    const scored = await server.call("identity.voiceprint.score_turns", conn, {
      turns: [
        {
          transcriptItemId: "rt_e2e_model",
          role: "user",
          text: "owner speaking, expected_model tagged reference",
          startMs: 0,
          endMs: 1500,
          audioArtifactId: "audio_e2e_model",
        },
      ],
      consent: { captureAllowed: true, biometricAllowed: true, memoryPromotionAllowed: true },
      createdAt,
      updatedAt,
    });

    expect(scored.ok).toBe(true);
    expect(scored.status).toBe("scored");
    expect(scored.states.find((s) => s.transcriptItemId === "rt_e2e_model")?.lifecycle).toBe(
      "resolved",
    );
  });
});
