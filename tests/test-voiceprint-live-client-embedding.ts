import { describe, expect, test } from "bun:test";
import {
  buildLiveVoiceprintScoringPlan,
  deviceAttestedVoiceprintQuality,
  runLiveVoiceprintScoringPlan,
  scoreClientEmbeddingForQueuedTurn,
  type LiveVoiceprintPlanItemInput,
  type VoiceprintModelInfo,
} from "../src/identity/voiceprint/index.js";

const sampleRate = 16000;
const createdAt = "2026-07-03T00:00:00.000Z";
const updatedAt = "2026-07-03T00:00:01.000Z";
const processingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
  memoryPromotionAllowed: true,
};
const ownerModel: VoiceprintModelInfo = {
  provider: "custom",
  modelId: "client-embed",
  version: "1",
};

// A sidecar command that fails loudly if it is ever spawned. Client-embedding
// turns must resolve WITHOUT touching it.
const throwingSidecar = {
  command: process.execPath,
  args: ["-e", "process.stderr.write('sidecar must not be spawned'); process.exit(99)"],
  timeoutMs: 5_000,
};

describe("live voiceprint client embedding scoring", () => {
  test("scores a client embedding directly without spawning the sidecar", async () => {
    const run = await runLiveVoiceprintScoringPlan({
      sidecar: throwingSidecar,
      turns: [
        clientTurn("rt_client_ok", "audio_client_ok", {
          sampleEmbedding: [1, 0],
          sampleEmbeddingModel: ownerModel,
        }),
      ],
      createdAt,
      updatedAt,
    });

    expect(run.status).toBe("scored");
    // No sidecar jobs were queued -> the sidecar was never spawned.
    expect(run.plan.jobContexts).toHaveLength(0);
    expect(run.plan.clientScored).toHaveLength(1);
    expect(run.patches).toHaveLength(1);
    expect(run.states[0]?.lifecycle).toBe("resolved");
    expect(run.states[0]?.result).toBe("owner_speaking");
    expect(run.storageBundle?.transcriptSpeakerAnnotations).toHaveLength(1);
  });

  test("rejects a client embedding whose model does not match the owner template", () => {
    const plan = buildLiveVoiceprintScoringPlan({
      turns: [
        clientTurn("rt_client_model_mismatch", "audio_client_model_mismatch", {
          sampleEmbedding: [1, 0],
          sampleEmbeddingModel: { ...ownerModel, version: "2" },
        }),
      ],
    });

    expect(plan.jobContexts).toHaveLength(0);
    expect(plan.clientScored).toHaveLength(0);
    expect(plan.clientRejected).toHaveLength(1);
    expect(plan.clientRejected[0]?.reason).toBe("client_embedding_model_mismatch");
    expect(plan.states[0]?.lifecycle).toBe("skipped");
    expect(plan.states[0]?.skipReason).toBe("client_embedding_rejected");
  });

  test("rejects a client embedding with a missing model", () => {
    const plan = buildLiveVoiceprintScoringPlan({
      turns: [
        clientTurn("rt_client_model_missing", "audio_client_model_missing", {
          sampleEmbedding: [1, 0],
          sampleEmbeddingModel: undefined,
        }),
      ],
    });

    expect(plan.clientRejected[0]?.reason).toBe("client_embedding_model_missing");
    expect(plan.states[0]?.skipReason).toBe("client_embedding_rejected");
  });

  test("rejects a client embedding when no expected owner-template model is available", () => {
    const plan = buildLiveVoiceprintScoringPlan({
      turns: [
        clientTurn("rt_client_no_expected", "audio_client_no_expected", {
          sampleEmbedding: [1, 0],
          sampleEmbeddingModel: ownerModel,
          // No expected model to enforce the match against -> must reject, not
          // silently skip the model check.
          expectedModel: undefined,
        }),
      ],
    });

    expect(plan.clientScored).toHaveLength(0);
    expect(plan.clientRejected[0]?.reason).toBe("client_embedding_expected_model_unavailable");
    expect(plan.states[0]?.lifecycle).toBe("skipped");
    expect(plan.states[0]?.skipReason).toBe("client_embedding_rejected");
  });

  test("scoreClientEmbeddingForQueuedTurn refuses to score without processing consent", () => {
    // The plan/gateway path skips consent-denied turns upstream in the queue,
    // but the reusable scoring boundary must ALSO refuse (defense-in-depth):
    // an alternate caller must never score a client vector without consent.
    const plan = buildLiveVoiceprintScoringPlan({
      turns: [
        clientTurn("rt_client_consent_lowlevel", "audio_client_consent_lowlevel", {
          acceptClientEmbeddings: false,
          sampleEmbedding: undefined,
          sampleEmbeddingModel: undefined,
          quality: undefined,
          samples: sineWave(1500, 0.1),
          sampleRate,
        }),
      ],
    });
    const queued = plan.queued[0];
    if (!queued) {
      throw new Error("expected a queued turn");
    }

    const outcome = scoreClientEmbeddingForQueuedTurn({
      queued,
      context: {
        ownerEmbeddings: [[1, 0]],
        sampleEmbedding: [1, 0],
        sampleEmbeddingModel: ownerModel,
        expectedModel: ownerModel,
        consent: { captureAllowed: true, biometricAllowed: false },
      },
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) {
      throw new Error("expected a rejection");
    }
    expect(outcome.reason).toBe("client_embedding_consent_denied");
  });

  test("rejects invalid client embeddings without a spurious accept", () => {
    const cases: Array<{ embedding: number[]; reason: string }> = [
      { embedding: [], reason: "client_embedding_empty" },
      { embedding: [Number.NaN, 1], reason: "client_embedding_not_finite" },
      { embedding: [0, 0], reason: "client_embedding_zero_norm" },
      { embedding: [1, 0, 0], reason: "client_embedding_dimension_mismatch" },
    ];

    for (const [index, { embedding, reason }] of cases.entries()) {
      const plan = buildLiveVoiceprintScoringPlan({
        turns: [
          clientTurn(`rt_client_invalid_${index}`, `audio_client_invalid_${index}`, {
            sampleEmbedding: embedding,
            sampleEmbeddingModel: ownerModel,
          }),
        ],
      });

      expect(plan.clientScored).toHaveLength(0);
      expect(plan.clientRejected[0]?.reason).toBe(reason);
      expect(plan.states[0]?.lifecycle).toBe("skipped");
      expect(plan.states[0]?.result).toBeUndefined();
    }
  });

  test("does NOT score from a client vector when opt-in is off (falls back to audio path)", async () => {
    const run = await runLiveVoiceprintScoringPlan({
      sidecar: throwingSidecar,
      turns: [
        // Opt-in off: sampleEmbedding present but acceptClientEmbeddings unset.
        // The turn still carries audio samples, so it takes the sidecar path.
        // The throwing sidecar proves the client vector was NOT trusted (it would
        // have resolved without the sidecar if it had been).
        clientTurn("rt_client_optin_off", "audio_client_optin_off", {
          sampleEmbedding: [1, 0],
          sampleEmbeddingModel: ownerModel,
          acceptClientEmbeddings: false,
          quality: undefined,
          samples: sineWave(1500, 0.1),
          sampleRate,
        }),
      ],
      createdAt,
      updatedAt,
    });

    // A sidecar job WAS queued (the client vector was ignored for direct scoring).
    expect(run.plan.jobContexts).toHaveLength(1);
    expect(run.plan.clientScored).toHaveLength(0);
    // The throwing sidecar surfaces as an error (not a resolved-from-client turn).
    expect(run.status).toBe("error");
    expect(run.states[0]?.lifecycle).toBe("error");
  });

  test("mixed batch: one client-embedded turn resolves without the sidecar; the audio turn uses it", async () => {
    const run = await runLiveVoiceprintScoringPlan({
      sidecar: audioEchoSidecar([1, 0], ownerModel),
      turns: [
        clientTurn("rt_mixed_client", "audio_mixed_client", {
          sampleEmbedding: [1, 0],
          sampleEmbeddingModel: ownerModel,
        }),
        // Audio turn: no client embedding, real samples -> sidecar path.
        clientTurn("rt_mixed_audio", "audio_mixed_audio", {
          audioPath: "/tmp/audio_mixed_audio.wav",
          acceptClientEmbeddings: false,
          sampleEmbedding: undefined,
          sampleEmbeddingModel: undefined,
          quality: undefined,
          samples: sineWave(1500, 0.1),
          sampleRate,
        }),
      ],
      createdAt,
      updatedAt,
    });

    expect(run.plan.jobContexts).toHaveLength(1);
    expect(run.plan.jobContexts[0]?.job.prepared.turn.transcriptItemId).toBe("rt_mixed_audio");
    expect(run.plan.clientScored).toHaveLength(1);
    expect(run.status).toBe("scored");

    const byId = new Map(run.states.map((state) => [state.transcriptItemId, state]));
    expect(byId.get("rt_mixed_client")?.lifecycle).toBe("resolved");
    expect(byId.get("rt_mixed_audio")?.lifecycle).toBe("resolved");
  });

  test("an impostor client embedding stays below ownerAccept and is not resolved", async () => {
    const run = await runLiveVoiceprintScoringPlan({
      sidecar: throwingSidecar,
      turns: [
        clientTurn("rt_client_impostor", "audio_client_impostor", {
          // Orthogonal to the owner template [1,0] -> cosine ~0.
          sampleEmbedding: [0, 1],
          sampleEmbeddingModel: ownerModel,
        }),
      ],
      createdAt,
      updatedAt,
    });

    expect(run.plan.clientScored).toHaveLength(1);
    expect(run.status).toBe("scored");
    expect(run.states[0]?.lifecycle).not.toBe("resolved");
    expect(run.states[0]?.result).not.toBe("owner_speaking");
  });

  test("scoreClientEmbeddingForQueuedTurn exposes the low-level outcome", () => {
    const plan = buildLiveVoiceprintScoringPlan({
      turns: [
        clientTurn("rt_client_low_level", "audio_client_low_level", {
          // No opt-in -> queued as a sidecar job so we can score it directly here.
          acceptClientEmbeddings: false,
          sampleEmbedding: undefined,
          sampleEmbeddingModel: undefined,
          quality: undefined,
          samples: sineWave(1500, 0.1),
          sampleRate,
        }),
      ],
    });
    const queued = plan.queued[0];
    if (!queued) {
      throw new Error("expected a queued turn");
    }

    const outcome = scoreClientEmbeddingForQueuedTurn({
      queued,
      context: {
        ownerEmbeddings: [[1, 0]],
        sampleEmbedding: [1, 0],
        sampleEmbeddingModel: ownerModel,
        expectedModel: ownerModel,
        consent: processingConsent,
      },
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      throw new Error("expected ok outcome");
    }
    expect(outcome.result.result.score.decision).toBe("owner_speaking");
  });
});

// A sidecar that echoes a fixed embedding for every audio request (for the audio
// leg of the mixed-batch test).
function audioEchoSidecar(embedding: number[], model: VoiceprintModelInfo) {
  const source = `
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    process.stdout.write(JSON.stringify({
      version: 1,
      responses: request.requests.map((item) => ({
        id: item.id,
        embedding: ${JSON.stringify(embedding)},
        model: ${JSON.stringify(model)}
      }))
    }));
  `;
  return { command: process.execPath, args: ["-e", source], timeoutMs: 5_000 };
}

function clientTurn(
  transcriptItemId: string,
  audioArtifactId: string,
  options: Partial<LiveVoiceprintPlanItemInput> = {},
): LiveVoiceprintPlanItemInput {
  return {
    sessionKey: "live:voiceprint-client",
    transcriptItemId,
    role: "user",
    text: "this is the owner speaking",
    startMs: 1000,
    endMs: 2500,
    audioArtifactId,
    route: "iphone_mic",
    // On-device path: no server-side samples; a device-attested quality lets the
    // shared scoring path run. audioPath references the (unread) registered artifact.
    audioPath: `/tmp/${audioArtifactId}.wav`,
    quality: deviceAttestedVoiceprintQuality(),
    ownerEmbeddings: [[1, 0], [0.98, 0.02]],
    expectedModel: ownerModel,
    consent: processingConsent,
    acceptClientEmbeddings: true,
    createdAt,
    ...options,
  };
}

function sineWave(durationMs: number, amplitude: number): Float32Array {
  const length = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Float32Array(length);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude;
  }
  return samples;
}
