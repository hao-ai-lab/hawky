import { existsSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
} from "../src/gateway/voiceprint-methods.js";
import {
  CREATED_AT as createdAt,
  UPDATED_AT as updatedAt,
  cosine,
  makeMockServer,
  writeMediaSidecar,
} from "./helpers/voiceprint-e2e.js";

// TRACK 2 — Real-model speaker-discrimination e2e (GATED on assets being present).
//
// Same harness shape as the reference e2e, but with VOICEPRINT_BACKEND=onnx + a real
// 3D-Speaker CAM++ model, proving ACTUAL speaker discrimination through the gateway
// pipeline: enroll speaker A (clip 1), a DIFFERENT clip of A matches (high cosine, resolves)
// and speaker B does NOT match (below threshold, stays unresolved).
//
// This test SKIPS CLEANLY (never fails) when sherpa-onnx, the model, or the labeled speaker
// WAVs are absent, so CI stays green in offline/sandboxed environments. Provision the assets
// with scripts/setup-voiceprint-model.sh and re-run with VOICEPRINT_PYTHON / VOICEPRINT_MODEL
// pointing at the venv python and the CAM++ .onnx.

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..");
const EMBED_SCRIPT = resolve(REPO_ROOT, "services", "voiceprint", "embed.py");
const FIX_DIR = resolve(REPO_ROOT, "fixtures", "voiceprint");
const AUDIO_DIR = join(FIX_DIR, "audio");
const DEFAULT_MODEL = join(FIX_DIR, "models", "campplus.onnx");

const PYTHON = process.env.VOICEPRINT_PYTHON ?? "python3";
const MODEL_PATH = process.env.VOICEPRINT_MODEL ?? DEFAULT_MODEL;

// Speaker A clip 1 (enroll), speaker A clip 2 (match), speaker B (non-match).
// mediaId = WAV basename without extension (matches the media-id regex).
const ENROLL_MEDIA = "speaker1_a_cn_16k";
const MATCH_MEDIA = "speaker1_b_cn_16k";
const CROSS_MEDIA = "speaker2_a_cn_16k";
const SPEAKER_A_ENROLL = join(AUDIO_DIR, `${ENROLL_MEDIA}.wav`);
const SPEAKER_A_MATCH = join(AUDIO_DIR, `${MATCH_MEDIA}.wav`);
const SPEAKER_B = join(AUDIO_DIR, `${CROSS_MEDIA}.wav`);

function onnxSidecar() {
  return {
    command: PYTHON,
    args: [EMBED_SCRIPT],
    env: { VOICEPRINT_BACKEND: "onnx", VOICEPRINT_MODEL: MODEL_PATH },
    timeoutMs: 60_000,
  };
}

/** Returns a skip reason string if any real-model asset is missing, else null. */
function detectSkipReason(): string | null {
  if (!existsSync(MODEL_PATH)) {
    return `CAM++ model not found at ${MODEL_PATH}`;
  }
  for (const wav of [SPEAKER_A_ENROLL, SPEAKER_A_MATCH, SPEAKER_B]) {
    if (!existsSync(wav)) {
      return `labeled speaker WAV not found at ${wav}`;
    }
  }
  const probe = spawnSync(PYTHON, ["-c", "import sherpa_onnx"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    return `sherpa-onnx not importable via ${PYTHON}`;
  }
  return null;
}

async function onnxEmbedding(audioPath: string): Promise<{ embedding: number[]; version?: string }> {
  const response = await runEmbeddingSidecar({
    sidecar: onnxSidecar(),
    request: buildEmbeddingBatchRequest([{ id: "e", audioPath }]),
  });
  const item = response.responses[0]!;
  expect(item.model.provider).toBe("sherpa-onnx");
  expect(item.model.modelId).toBe("cam++");
  return { embedding: item.embedding, version: item.model.version };
}

const skipReason = detectSkipReason();

describe("voiceprint onnx e2e (real CAM++ speaker discrimination, gated)", () => {
  // The gateway resolves finalized media by <mediaId>.json sidecars sitting next to the real
  // WAVs, so these must be written into the (version-controlled) fixtures/voiceprint/audio dir
  // rather than a temp dir. Remove them after each test so the run does not leave writes behind
  // in a tracked path — .gitignore already ignores this dir, but we don't rely on it for hygiene.
  afterEach(() => {
    for (const media of [MATCH_MEDIA, CROSS_MEDIA]) {
      rmSync(join(AUDIO_DIR, `${media}.json`), { force: true });
    }
  });

  if (skipReason) {
    test.skip(`SKIPPED — ${skipReason}. Run scripts/setup-voiceprint-model.sh to enable.`, () => {});
    // eslint-disable-next-line no-console
    console.log(
      `[e2e-voiceprint-onnx] SKIPPED: ${skipReason}. ` +
        "Run scripts/setup-voiceprint-model.sh and set VOICEPRINT_PYTHON/VOICEPRINT_MODEL to enable.",
    );
    return;
  }

  // Per-test timeout is self-contained (matches the sidecar's 60s budget) so this spec is
  // robust under the shared `test:e2e` glob, which runs at --timeout 30000 — a full-suite,
  // single-concurrency CAM++ spawn can exceed 30s and must not fail on the runner default.
  const ONNX_TEST_TIMEOUT_MS = 120_000;

  test("CAM++ embeddings discriminate speakers: A-vs-A cosine >> A-vs-B", async () => {
    const enroll = (await onnxEmbedding(SPEAKER_A_ENROLL)).embedding;
    const sameSpeaker = (await onnxEmbedding(SPEAKER_A_MATCH)).embedding;
    const otherSpeaker = (await onnxEmbedding(SPEAKER_B)).embedding;

    const sameCos = cosine(enroll, sameSpeaker);
    const crossCos = cosine(enroll, otherSpeaker);
    // eslint-disable-next-line no-console
    console.log(
      `[e2e-voiceprint-onnx] A-vs-A cosine=${sameCos.toFixed(4)} A-vs-B cosine=${crossCos.toFixed(4)}`,
    );

    // Real speaker discrimination: same-speaker similarity must clearly exceed cross-speaker.
    expect(sameCos).toBeGreaterThan(crossCos);
    expect(sameCos - crossCos).toBeGreaterThan(0.15);
  }, ONNX_TEST_TIMEOUT_MS);

  test("gateway score_turns resolves a same-speaker turn and rejects a cross-speaker turn", async () => {
    // Enroll owner = CAM++ embedding of speaker A clip 1, passed as the owner template.
    const enrolled = await onnxEmbedding(SPEAKER_A_ENROLL);
    const ownerVector = enrolled.embedding;
    const modelVersionTag = enrolled.version;

    // Empirically-tuned owner thresholds for CAM++. On the sr-data clips the measured
    // same-speaker cosine is ~0.60 and cross-speaker ~0.05 (see the discrimination test
    // above), so the default 0.82 is too strict for a genuine A-vs-A match. We drop to the
    // pipeline's minimum allowed ownerAccept (0.5): the real same-speaker match (~0.60)
    // clears it, the real cross-speaker turn (~0.05) does not even reach ownerPossible. The
    // scoring pipeline still does the real cosine comparison — we only move the gate to the
    // floor this model supports.
    const scoring: VoiceprintLiveScoringConfig = {
      sidecar: onnxSidecar(),
      ownerEmbeddings: [ownerVector],
      allowedAudioRoots: [AUDIO_DIR],
      // OnnxBackend tags the version with the model file basename (campplus.onnx -> "campplus");
      // sameVoiceprintModel compares the version too, so include it to accept the scorer.
      expectedModel: modelVersionTag
        ? { provider: "sherpa-onnx", modelId: "cam++", version: modelVersionTag }
        : { provider: "sherpa-onnx", modelId: "cam++" },
      thresholds: { ownerAccept: 0.5, ownerPossible: 0.5 },
      consent: {
        captureAllowed: true,
        biometricAllowed: true,
        memoryPromotionAllowed: true,
        exportAllowed: false,
      },
    };

    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    registerVoiceprintMethods(server as any, storage, undefined, scoring);
    const sessionKey = "live:voiceprint-e2e-onnx";
    const conn = { sessionKey };

    // Register both scored clips as finalized media artifacts by writing the .json sidecars
    // next to the real 16 kHz WAVs in the fixture dir (the WAVs themselves ship via setup).
    writeMediaSidecar(AUDIO_DIR, MATCH_MEDIA, "audio/wav;rate=16000");
    writeMediaSidecar(AUDIO_DIR, CROSS_MEDIA, "audio/wav;rate=16000");
    await server.call("identity.voiceprint.audio_artifact.register", conn, {
      audioArtifactId: "audio_onnx_same",
      mediaId: MATCH_MEDIA,
    });
    await server.call("identity.voiceprint.audio_artifact.register", conn, {
      audioArtifactId: "audio_onnx_cross",
      mediaId: CROSS_MEDIA,
    });

    // Same-speaker turn (speaker A clip 2) -> should resolve to the owner.
    const sameResult = await server.call("identity.voiceprint.score_turns", conn, {
      turns: [
        {
          transcriptItemId: "rt_onnx_same_speaker",
          role: "user",
          text: "speaker A, different clip",
          startMs: 0,
          endMs: 4000,
          audioArtifactId: "audio_onnx_same",
        },
      ],
      consent: { captureAllowed: true, biometricAllowed: true, memoryPromotionAllowed: true },
      createdAt,
      updatedAt,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[e2e-voiceprint-onnx] same-speaker status=${sameResult.status} lifecycle=${sameResult.states[0]?.lifecycle}`,
    );
    expect(sameResult.ok).toBe(true);
    expect(sameResult.states.find((s) => s.transcriptItemId === "rt_onnx_same_speaker")?.lifecycle).toBe(
      "resolved",
    );

    // Cross-speaker turn (speaker B) -> must NOT resolve to the owner.
    const crossResult = await server.call("identity.voiceprint.score_turns", conn, {
      turns: [
        {
          transcriptItemId: "rt_onnx_cross_speaker",
          role: "user",
          text: "speaker B",
          startMs: 0,
          endMs: 4000,
          audioArtifactId: "audio_onnx_cross",
        },
      ],
      consent: { captureAllowed: true, biometricAllowed: true, memoryPromotionAllowed: true },
      createdAt,
      updatedAt,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[e2e-voiceprint-onnx] cross-speaker status=${crossResult.status} lifecycle=${crossResult.states[0]?.lifecycle}`,
    );
    expect(crossResult.ok).toBe(true);
    // The cross-speaker turn must have been SCORED and rejected, not silently skipped. With the
    // measured cross-speaker cosine (~0.05) well below ownerPossible (0.5), the annotation is
    // unknown_speaker -> identity_unknown -> lifecycle "unknown". Asserting the exact "unknown"
    // lifecycle + "scored" batch status rules out a broken audio/sidecar path (which would yield
    // "skipped"/"error"), making this negative assertion load-bearing for real discrimination.
    expect(crossResult.status).toBe("scored");
    expect(crossResult.states.find((s) => s.transcriptItemId === "rt_onnx_cross_speaker")?.lifecycle).toBe(
      "unknown",
    );
  }, ONNX_TEST_TIMEOUT_MS);
});
