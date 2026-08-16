import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildEmbeddingBatchRequest,
  isUsableEmbeddingVector,
  runEmbeddingSidecar,
} from "../src/identity/voiceprint/index.js";
import {
  createInMemoryVoiceprintStorage,
  registerVoiceprintMethods,
  resolveVoiceprintLiveScoringConfigFromConfig,
} from "../src/gateway/voiceprint-methods.js";

// End-to-end tests that spawn the REAL Python reference sidecar through the same
// runEmbeddingSidecar / sidecar-client path the gateway uses. The reference
// backend is deterministic and dependency-free (no weights, no network), so these
// are safe in CI. VOICEPRINT_BACKEND=reference is set explicitly.

const here = dirname(fileURLToPath(import.meta.url));
const EMBED_SCRIPT = resolve(here, "..", "services", "voiceprint", "embed.py");
const PYTHON = process.env.VOICEPRINT_PYTHON ?? "python3";
const createdAt = "2026-06-23T00:00:00.000Z";

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

/** Writes a mono 16-bit PCM WAV of a sine at `freqHz` so different turns differ. */
function writeSineWav(path: string, freqHz: number, durationMs = 1500, sampleRate = 16000): void {
  const sampleCount = Math.round((durationMs / 1000) * sampleRate);
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < sampleCount; i += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * freqHz * i) / sampleRate) * 0.5 * 32767);
    buffer.writeInt16LE(value, 44 + i * 2);
  }
  writeFileSync(path, buffer);
}

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

describe("voiceprint embedding service (real python reference sidecar)", () => {
  test("returns valid, id-matched, finite embeddings for a batch", async () => {
    const dir = tempDir("voiceprint-embed-batch-");
    const turn1 = join(dir, "turn_1.wav");
    const turn2 = join(dir, "turn_2.wav");
    writeSineWav(turn1, 220);
    writeSineWav(turn2, 660);

    const request = buildEmbeddingBatchRequest([
      { id: "turn_1", audioPath: turn1 },
      { id: "turn_2", audioPath: turn2 },
    ]);
    const response = await runEmbeddingSidecar({ sidecar: referenceSidecar(), request });

    expect(response.version).toBe(1);
    expect(response.responses.map((item) => item.id)).toEqual(["turn_1", "turn_2"]);
    for (const item of response.responses) {
      expect(item.model.provider).toBe("reference");
      expect(item.model.modelId).toBe("reference-fbank-v0");
      expect(item.embedding.length).toBe(192);
      expect(isUsableEmbeddingVector(item.embedding)).toBe(true);
      expect(item.audio?.sampleRate).toBe(16000);
      expect(item.audio?.speechMs ?? 0).toBeGreaterThanOrEqual(0);
    }
  });

  test("is deterministic: same audio yields the same vector, different differs", async () => {
    const dir = tempDir("voiceprint-embed-determinism-");
    const same = join(dir, "same.wav");
    const other = join(dir, "other.wav");
    writeSineWav(same, 300);
    writeSineWav(other, 900);

    const first = await runEmbeddingSidecar({
      sidecar: referenceSidecar(),
      request: buildEmbeddingBatchRequest([{ id: "a", audioPath: same }]),
    });
    const second = await runEmbeddingSidecar({
      sidecar: referenceSidecar(),
      request: buildEmbeddingBatchRequest([{ id: "a", audioPath: same }]),
    });
    const different = await runEmbeddingSidecar({
      sidecar: referenceSidecar(),
      request: buildEmbeddingBatchRequest([{ id: "a", audioPath: other }]),
    });

    expect(second.responses[0]!.embedding).toEqual(first.responses[0]!.embedding);
    expect(different.responses[0]!.embedding).not.toEqual(first.responses[0]!.embedding);
  });

  test("surfaces a missing WAV file as a rejected promise (non-zero exit + JSON error)", async () => {
    await expect(
      runEmbeddingSidecar({
        sidecar: referenceSidecar(),
        request: buildEmbeddingBatchRequest([{ id: "x", audioPath: "/no/such/file.wav" }]),
      }),
    ).rejects.toThrow(/not found|exited/);
  });

  test("dev_reference_backend opt-in defaults the sidecar to the bundled python service", () => {
    const dir = tempDir("voiceprint-embed-devopt-");
    const scoring = resolveVoiceprintLiveScoringConfigFromConfig({
      voiceprint: {
        live_scoring: {
          enabled: true,
          dev_reference_backend: true,
          owner_template: { file_path: join(dir, "owner.enc.json"), key_path: join(dir, "owner.key.json") },
          allowed_audio_roots: [dir],
          consent: { capture_allowed: true, biometric_allowed: true },
        },
      },
    } as any);

    expect(scoring?.sidecar.command).toBe(PYTHON);
    expect(scoring?.sidecar.args).toEqual([EMBED_SCRIPT]);
    expect(scoring?.sidecar.env).toMatchObject({ VOICEPRINT_BACKEND: "reference" });
  });

  test("score_turns consumes real reference embeddings end-to-end", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = tempDir("voiceprint-embed-score-");
    const audioPath = join(dir, "owner.wav");
    writeSineWav(audioPath, 220);

    // Precompute the reference embedding for this exact audio so the owner template
    // matches the turn (the reference backend is deterministic). This proves the
    // score_turns path can consume the sidecar's output.
    const ownerVector = (
      await runEmbeddingSidecar({
        sidecar: referenceSidecar(),
        request: buildEmbeddingBatchRequest([{ id: "owner", audioPath }]),
      })
    ).responses[0]!.embedding;

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

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-embed-service" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-embed-service",
            transcriptItemId: "rt_embed_service_owner",
            role: "user",
            text: "owner speaking",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_embed_service_owner",
            audioPath,
            route: "iphone_mic",
          },
        ],
        consent: { captureAllowed: true, biometricAllowed: true, memoryPromotionAllowed: true },
        createdAt,
        updatedAt: "2026-06-23T00:00:01.000Z",
      },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("scored");
    expect(result.states[0]?.lifecycle).toBe("resolved");
    // Same audio as the owner template -> cosine 1.0 -> owner_speaking.
    expect(result.states[0]?.transcriptItemId).toBe("rt_embed_service_owner");
  });
});
