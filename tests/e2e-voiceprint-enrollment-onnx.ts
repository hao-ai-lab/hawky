import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import {
  createInMemoryVoiceprintStorage,
  registerVoiceprintMethods,
  type VoiceprintLiveScoringConfig,
} from "../src/gateway/voiceprint-methods.js";
import {
  CREATED_AT as createdAt,
  UPDATED_AT as updatedAt,
  makeMockServer,
  writeMediaSidecar,
} from "./helpers/voiceprint-e2e.js";

// A1 real-model gate — enroll_owner -> score_turns with the REAL CAM++ model.
//
// Reuses the onnx e2e harness (same fixture WAVs + sidecar). Proves the FULL
// enrollment lifecycle end-to-end against a real embedding model: enroll speaker
// A's clip via identity.voiceprint.enroll_owner (which embeds + quality-gates +
// writes the encrypted template), then a DIFFERENT clip of A resolves and speaker
// B does not. SKIPS CLEANLY when the model / sherpa-onnx / labeled WAVs are absent.

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "..");
const EMBED_SCRIPT = resolve(REPO_ROOT, "services", "voiceprint", "embed.py");
const FIX_DIR = resolve(REPO_ROOT, "fixtures", "voiceprint");
const AUDIO_DIR = join(FIX_DIR, "audio");
const DEFAULT_MODEL = join(FIX_DIR, "models", "campplus.onnx");

const PYTHON = process.env.VOICEPRINT_PYTHON ?? "python3";
const MODEL_PATH = process.env.VOICEPRINT_MODEL ?? DEFAULT_MODEL;

// Enrollment now requires >= 30s of voiced speech (a server-side biometric
// policy floor the client cannot lower). The sr-data clips are only a few
// seconds, so build a >= 33s enrollment clip by repeating speaker A's real PCM
// (still genuinely speaker A's voice). Scoring only needs a short clip, so the
// match/cross clips stay as-is.
const ENROLL_MEDIA = "speaker1_a_long30s";
const MATCH_MEDIA = "speaker1_b_cn_16k";
const CROSS_MEDIA = "speaker2_a_cn_16k";

/** Repeat a canonical PCM WAV's data chunk to reach at least `minMs` of audio. */
function buildLongWav(srcPath: string, destPath: string, minMs: number, sampleRate = 16000): void {
  const buf = readFileSync(srcPath);
  let off = 12; // skip "RIFF"<size>"WAVE"
  let dataStart = -1;
  let dataSize = 0;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === "data") {
      dataStart = off + 8;
      dataSize = size;
      break;
    }
    off += 8 + size + (size % 2);
  }
  if (dataStart < 0) throw new Error(`no data chunk in ${srcPath}`);
  const pcm = buf.subarray(dataStart, dataStart + dataSize);
  const targetBytes = Math.ceil((minMs / 1000) * sampleRate * 2); // 16-bit mono
  const reps = Math.max(1, Math.ceil(targetBytes / pcm.length));
  const repeated = Buffer.concat(Array.from({ length: reps }, () => pcm));
  const head = Buffer.from(buf.subarray(0, dataStart));
  head.writeUInt32LE(dataStart - 8 + repeated.length, 4); // RIFF size = fileSize - 8
  head.writeUInt32LE(repeated.length, dataStart - 4); // data chunk size
  writeFileSync(destPath, Buffer.concat([head, repeated]));
}
const ENROLL_SOURCE = join(AUDIO_DIR, "speaker1_a_cn_16k.wav"); // real short clip (built up to >=30s)
const SPEAKER_A_ENROLL = join(AUDIO_DIR, `${ENROLL_MEDIA}.wav`); // built long enrollment clip
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

function detectSkipReason(): string | null {
  if (!existsSync(MODEL_PATH)) {
    return `CAM++ model not found at ${MODEL_PATH}`;
  }
  for (const wav of [ENROLL_SOURCE, SPEAKER_A_MATCH, SPEAKER_B]) {
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

const skipReason = detectSkipReason();
const tempDirs: string[] = [];

describe("voiceprint enrollment onnx e2e (real CAM++ enroll_owner -> score, gated)", () => {
  afterEach(() => {
    for (const media of [ENROLL_MEDIA, MATCH_MEDIA, CROSS_MEDIA]) {
      rmSync(join(AUDIO_DIR, `${media}.json`), { force: true });
    }
    rmSync(SPEAKER_A_ENROLL, { force: true }); // the built long enrollment clip
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  if (skipReason) {
    test.skip(`SKIPPED — ${skipReason}. Run scripts/setup-voiceprint-model.sh to enable.`, () => {});
    // eslint-disable-next-line no-console
    console.log(
      `[e2e-voiceprint-enrollment-onnx] SKIPPED: ${skipReason}. ` +
        "Run scripts/setup-voiceprint-model.sh and set VOICEPRINT_PYTHON/VOICEPRINT_MODEL to enable.",
    );
    return;
  }

  const ONNX_TEST_TIMEOUT_MS = 120_000;

  test("enroll_owner (real model) -> same-speaker resolves, cross-speaker does not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-onnx-"));
    tempDirs.push(dir);

    // Empirically-tuned owner thresholds for CAM++ on the sr-data clips (same as the
    // scoring onnx e2e): same-speaker ~0.60, cross-speaker ~0.05, so accept at the 0.5 floor.
    const scoring: VoiceprintLiveScoringConfig = {
      sidecar: onnxSidecar(),
      ownerTemplateFileSource: {
        filePath: join(dir, "owner-template.enc.json"),
        keyPath: join(dir, "owner-template.key.json"),
        keyRef: "voiceprint-enroll-onnx-key",
        createKeyIfMissing: true,
      },
      allowedAudioRoots: [AUDIO_DIR],
      // The enrolled template carries the CAM++ model; leave expected_model unset so the
      // owner-template model drives scoring's model match.
      thresholds: { ownerAccept: 0.5, ownerPossible: 0.5 },
      consent: {
        captureAllowed: true,
        biometricAllowed: true,
        memoryPromotionAllowed: true,
        exportAllowed: false,
      },
      // The labeled clips are only a few seconds; use a low enrollment floor so the
      // real single-clip enrollment goes through (the 30s default is a product policy,
      // not a model property — this gate proves the enroll->score wiring).
    };

    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    registerVoiceprintMethods(server as any, storage, undefined, scoring);
    const conn = { sessionKey: "live:voiceprint-e2e-enroll-onnx" };

    // Build a long enrollment clip from speaker A's real PCM (the 30s server
    // floor cannot be lowered by the client). The sidecar counts VOICED speech
    // (~74% of the sr-data clip), so build ~45s of audio to clear 30s voiced.
    buildLongWav(ENROLL_SOURCE, SPEAKER_A_ENROLL, 45_000);
    writeMediaSidecar(AUDIO_DIR, ENROLL_MEDIA, "audio/wav;rate=16000");
    writeMediaSidecar(AUDIO_DIR, MATCH_MEDIA, "audio/wav;rate=16000");
    writeMediaSidecar(AUDIO_DIR, CROSS_MEDIA, "audio/wav;rate=16000");
    await server.call("identity.voiceprint.audio_artifact.register", conn, {
      audioArtifactId: "audio_enroll_onnx",
      mediaId: ENROLL_MEDIA,
    });
    await server.call("identity.voiceprint.audio_artifact.register", conn, {
      audioArtifactId: "audio_onnx_same",
      mediaId: MATCH_MEDIA,
    });
    await server.call("identity.voiceprint.audio_artifact.register", conn, {
      audioArtifactId: "audio_onnx_cross",
      mediaId: CROSS_MEDIA,
    });

    // Enroll speaker A via the REAL enrollment RPC (embeds + quality-gates + writes encrypted).
    const enroll = await server.call("identity.voiceprint.enroll_owner", conn, {
      sources: [{ audioArtifactId: "audio_enroll_onnx" }],
      consent: { captureAllowed: true, biometricAllowed: true, memoryPromotionAllowed: true },
    });
    // eslint-disable-next-line no-console
    console.log(
      `[e2e-voiceprint-enrollment-onnx] enroll status=${enroll.status} sources=${enroll.sourceCount}`,
    );
    expect(enroll.status).toBe("accepted");
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(true);

    // Same-speaker turn (speaker A clip 2) -> resolves against the enrolled owner.
    const sameResult = await server.call("identity.voiceprint.score_turns", conn, {
      turns: [
        {
          transcriptItemId: "rt_enroll_onnx_same",
          role: "user",
          startMs: 0,
          endMs: 4000,
          audioArtifactId: "audio_onnx_same",
        },
      ],
      consent: { captureAllowed: true, biometricAllowed: true, memoryPromotionAllowed: true },
      createdAt,
      updatedAt,
    });
    expect(sameResult.ok).toBe(true);
    expect(
      sameResult.states.find((s: any) => s.transcriptItemId === "rt_enroll_onnx_same")?.lifecycle,
    ).toBe("resolved");

    // Cross-speaker turn (speaker B) -> scored but NOT resolved as owner.
    const crossResult = await server.call("identity.voiceprint.score_turns", conn, {
      turns: [
        {
          transcriptItemId: "rt_enroll_onnx_cross",
          role: "user",
          startMs: 0,
          endMs: 4000,
          audioArtifactId: "audio_onnx_cross",
        },
      ],
      consent: { captureAllowed: true, biometricAllowed: true, memoryPromotionAllowed: true },
      createdAt,
      updatedAt,
    });
    expect(crossResult.status).toBe("scored");
    expect(
      crossResult.states.find((s: any) => s.transcriptItemId === "rt_enroll_onnx_cross")?.lifecycle,
    ).toBe("unknown");
  }, ONNX_TEST_TIMEOUT_MS);
});
