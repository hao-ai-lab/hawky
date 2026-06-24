import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  formatVoiceprintReport,
  scoreVoiceprintManifest,
  type VoiceprintManifest,
} from "../src/identity/voiceprint/index.js";

describe("voiceprint threshold report", () => {
  test("scores inline embedding fixtures conservatively", async () => {
    const manifest: VoiceprintManifest = {
      version: 1,
      model: { provider: "external-json", modelId: "test-vectors" },
      thresholds: { ownerAccept: 0.82, ownerPossible: 0.72 },
      owner: {
        id: "owner",
        enrollment: [
          { id: "owner_a", embedding: [1, 0, 0] },
          { id: "owner_b", embedding: [0.98, 0.04, 0] },
        ],
      },
      samples: [
        { id: "owner_ok", expected: "owner", embedding: [0.99, 0.02, 0] },
        { id: "other", expected: "non_owner", embedding: [0, 1, 0] },
        { id: "leak", expected: "assistant_leakage", embedding: [-1, 0, 0] },
        { id: "unlabeled", expected: "unknown", embedding: [0.5, 0.5, 0] },
      ],
    };

    const report = await scoreVoiceprintManifest(manifest, {
      generatedAt: "2026-06-23T00:00:00.000Z",
    });

    expect(report.summary.total).toBe(4);
    expect(report.summary.failed).toBe(0);
    expect(report.summary.unlabeled).toBe(1);
    expect(report.rows.find((row) => row.id === "owner_ok")?.decision).toBe("owner_speaking");
    expect(report.rows.find((row) => row.id === "other")?.decision).toBe("unknown_speaker");
    expect(formatVoiceprintReport(report)).toContain("Voiceprint threshold report");
  });

  test("flags possible owner on non-owner sample as a failed conservative report", async () => {
    const manifest: VoiceprintManifest = {
      version: 1,
      thresholds: { ownerAccept: 0.99, ownerPossible: 0.7 },
      owner: { enrollment: [{ id: "owner", embedding: [1, 0] }] },
      samples: [{ id: "similar_other", expected: "non_owner", embedding: [0.75, 0.25] }],
    };

    const report = await scoreVoiceprintManifest(manifest);

    expect(report.rows[0]?.decision).toBe("possible_owner");
    expect(report.rows[0]?.passed).toBe(false);
    expect(report.rows[0]?.risk).toBe("possible_false_accept");
  });

  test("rejects invalid owner enrollment vectors instead of filtering them out", async () => {
    const manifest: VoiceprintManifest = {
      version: 1,
      owner: {
        enrollment: [
          { id: "broken", embedding: [] },
          { id: "valid", embedding: [1, 0] },
        ],
      },
      samples: [{ id: "owner_ok", expected: "owner", embedding: [1, 0] }],
    };

    await expect(scoreVoiceprintManifest(manifest)).rejects.toThrow(/broken.*invalid embedding/);
  });

  test("rejects invalid expected labels at runtime", async () => {
    const manifest = {
      version: 1,
      owner: { enrollment: [{ id: "owner", embedding: [1, 0] }] },
      samples: [{ id: "missing_label", embedding: [0, 1] }],
    } as unknown as VoiceprintManifest;

    await expect(scoreVoiceprintManifest(manifest)).rejects.toThrow(/invalid expected label/);
  });

  test("rejects invalid sample vectors", async () => {
    const manifest: VoiceprintManifest = {
      version: 1,
      owner: { enrollment: [{ id: "owner", embedding: [1, 0] }] },
      samples: [{ id: "bad_sample", expected: "unknown", embedding: [Number.NaN, 0] }],
    };

    await expect(scoreVoiceprintManifest(manifest)).rejects.toThrow(/bad_sample.*invalid embedding/);
  });

  test("rejects zero-valued enrollment embeddings", async () => {
    const manifest: VoiceprintManifest = {
      version: 1,
      owner: { enrollment: [{ id: "zero_owner", embedding: [0, 0] }] },
      samples: [{ id: "owner_ok", expected: "owner", embedding: [1, 0] }],
    };

    await expect(scoreVoiceprintManifest(manifest)).rejects.toThrow(/zero_owner.*invalid embedding/);
  });

  test("rejects owner enrollment vectors that cancel to a zero centroid", async () => {
    const manifest: VoiceprintManifest = {
      version: 1,
      owner: {
        enrollment: [
          { id: "owner_a", embedding: [1, 0] },
          { id: "owner_b", embedding: [-1, 0] },
        ],
      },
      samples: [
        { id: "other", expected: "non_owner", embedding: [0, 1] },
        { id: "noise", expected: "noise", embedding: [0, -1] },
      ],
    };

    await expect(scoreVoiceprintManifest(manifest)).rejects.toThrow(/zero norm/);
  });

  test("rejects sample embeddings with a different dimension than enrollment", async () => {
    const manifest: VoiceprintManifest = {
      version: 1,
      owner: { enrollment: [{ id: "owner", embedding: [1, 0, 0] }] },
      samples: [{ id: "wrong_dim", expected: "non_owner", embedding: [0, 1] }],
    };

    await expect(scoreVoiceprintManifest(manifest)).rejects.toThrow(/wrong_dim.*dimension 2.*expected 3/);
  });

  test("rejects empty sample lists and duplicate fixture ids", async () => {
    await expect(
      scoreVoiceprintManifest({
        version: 1,
        owner: { enrollment: [{ id: "owner", embedding: [1, 0] }] },
        samples: [],
      }),
    ).rejects.toThrow(/at least one sample/);

    await expect(
      scoreVoiceprintManifest({
        version: 1,
        owner: {
          enrollment: [
            { id: "owner", embedding: [1, 0] },
            { id: "owner", embedding: [0.9, 0.1] },
          ],
        },
        samples: [{ id: "sample", expected: "owner", embedding: [1, 0] }],
      }),
    ).rejects.toThrow(/Duplicate.*owner/);

    await expect(
      scoreVoiceprintManifest({
        version: 1,
        owner: { enrollment: [{ id: "owner", embedding: [1, 0] }] },
        samples: [
          { id: "sample", expected: "owner", embedding: [1, 0] },
          { id: "sample", expected: "non_owner", embedding: [0, 1] },
        ],
      }),
    ).rejects.toThrow(/Duplicate.*sample/);
  });

  test("requires explicit signal-baseline model for audioPath fixtures", async () => {
    await expect(
      scoreVoiceprintManifest({
        version: 1,
        owner: { enrollment: [{ id: "owner", audioPath: "owner.wav" }] },
        samples: [{ id: "sample", expected: "owner", audioPath: "sample.wav" }],
      }),
    ).rejects.toThrow(/requires explicit model signal-baseline\/signal-baseline-v0/);

    await expect(
      scoreVoiceprintManifest({
        version: 1,
        model: { provider: "speechbrain", modelId: "ecapa-tdnn" },
        owner: { enrollment: [{ id: "owner", audioPath: "owner.wav" }] },
        samples: [{ id: "sample", expected: "owner", audioPath: "sample.wav" }],
      }),
    ).rejects.toThrow(/requires explicit model signal-baseline\/signal-baseline-v0/);
  });

  test("scores audioPath fixtures only when the baseline model is explicit", async () => {
    const baseDir = await mkdtemp(join(tmpdir(), "voiceprint-baseline-"));
    await writeFile(join(baseDir, "voice.wav"), buildPcm16SineWav(16000, 1500, 0.1));

    const report = await scoreVoiceprintManifest(
      {
        version: 1,
        model: { provider: "signal-baseline", modelId: "signal-baseline-v0" },
        owner: { enrollment: [{ id: "owner", audioPath: "voice.wav" }] },
        samples: [{ id: "sample", expected: "owner", audioPath: "voice.wav" }],
      },
      { baseDir },
    );

    expect(report.model.provider).toBe("signal-baseline");
    expect(report.rows[0]?.provider).toBe("signal-baseline");
    expect(report.rows[0]?.modelId).toBe("signal-baseline-v0");
    expect(report.summary.failed).toBe(0);
  });
});

function buildPcm16SineWav(sampleRate: number, durationMs: number, amplitude: number): Buffer {
  const frameCount = Math.round((durationMs / 1000) * sampleRate);
  const dataSize = frameCount * 2;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < frameCount; i += 1) {
    const sample = Math.round(
      Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude * 32767,
    );
    buf.writeInt16LE(sample, 44 + i * 2);
  }

  return buf;
}
