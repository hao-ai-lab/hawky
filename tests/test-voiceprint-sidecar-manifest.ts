import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildManifestEmbeddingRequestPlan,
  materializeManifestEmbeddingsWithSidecar,
  type VoiceprintManifest,
} from "../src/identity/voiceprint/index.js";

let testDir: string | null = null;

afterEach(() => {
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
    testDir = null;
  }
});

function makeTestDir(): string {
  testDir = mkdtempSync(join(tmpdir(), "voiceprint-manifest-sidecar-test-"));
  return testDir;
}

function writeSidecarScript(dir: string, source: string): string {
  const scriptPath = join(dir, "sidecar.js");
  writeFileSync(scriptPath, source, "utf8");
  return scriptPath;
}

describe("voiceprint manifest sidecar materialization", () => {
  test("builds scoped requests for audio sources missing embeddings", () => {
    const baseDir = makeTestDir();
    const manifest: VoiceprintManifest = {
      version: 1,
      owner: {
        enrollment: [
          { id: "owner_audio", audioPath: "owner.wav", startMs: 10, endMs: 100 },
          { id: "owner_embedded", embedding: [1, 0] },
        ],
      },
      samples: [
        { id: "sample_audio", expected: "owner", audioPath: "sample.wav" },
        { id: "sample_embedded", expected: "non_owner", embedding: [0, 1] },
      ],
    };

    const plan = buildManifestEmbeddingRequestPlan({ manifest, baseDir, targetSampleRate: 16000 });

    expect(plan.request?.requests.map((item) => item.id)).toEqual([
      "owner_enrollment:0:owner_audio",
      "sample:0:sample_audio",
    ]);
    expect(plan.request?.requests[0]?.audioPath).toBe(join(baseDir, "owner.wav"));
    expect(plan.request?.requests[0]?.targetSampleRate).toBe(16000);
  });

  test("materializes sidecar embeddings into a cloned manifest", async () => {
    const baseDir = makeTestDir();
    const scriptPath = writeSidecarScript(
      baseDir,
      `
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: request.requests.map((item) => ({
          id: item.id,
          embedding: item.id.startsWith("owner") ? [1, 0] : [0.99, 0.01],
          model: { provider: "custom", modelId: "fake-embedder", version: "1" }
        }))
      }));
      `,
    );
    const manifest: VoiceprintManifest = {
      version: 1,
      owner: { enrollment: [{ id: "owner_audio", audioPath: "owner.wav" }] },
      samples: [{ id: "sample_audio", expected: "owner", audioPath: "sample.wav" }],
    };

    const result = await materializeManifestEmbeddingsWithSidecar({
      manifest,
      baseDir,
      sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
    });

    expect(result.requestCount).toBe(2);
    expect(result.manifest).not.toBe(manifest);
    expect(result.manifest.model).toEqual({
      provider: "custom",
      modelId: "fake-embedder",
      version: "1",
    });
    expect(result.manifest.owner.enrollment[0]?.embedding).toEqual([1, 0]);
    expect(result.manifest.samples[0]?.embedding).toEqual([0.99, 0.01]);
    expect(manifest.owner.enrollment[0]?.embedding).toBeUndefined();
  });

  test("rejects sidecar model mismatch with manifest model", async () => {
    const baseDir = makeTestDir();
    const scriptPath = writeSidecarScript(
      baseDir,
      `
      process.stdin.resume();
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: [{
          id: "owner_enrollment:0:owner_audio",
          embedding: [1, 0],
          model: { provider: "custom", modelId: "different-model" }
        }]
      }));
      `,
    );
    const manifest: VoiceprintManifest = {
      version: 1,
      model: { provider: "custom", modelId: "expected-model" },
      owner: { enrollment: [{ id: "owner_audio", audioPath: "owner.wav" }] },
      samples: [{ id: "sample_embedded", expected: "owner", embedding: [1, 0] }],
    };

    await expect(
      materializeManifestEmbeddingsWithSidecar({
        manifest,
        baseDir,
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
      }),
    ).rejects.toThrow(/does not match sidecar model/);
  });

  test("rejects implicit mixed embedding spaces without manifest model", async () => {
    const baseDir = makeTestDir();
    const scriptPath = writeSidecarScript(
      baseDir,
      `
      process.stdin.resume();
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: [{
          id: "sample:0:sample_audio",
          embedding: [1, 0],
          model: { provider: "custom", modelId: "fake-embedder" }
        }]
      }));
      `,
    );
    const manifest: VoiceprintManifest = {
      version: 1,
      owner: { enrollment: [{ id: "owner_embedded", embedding: [1, 0] }] },
      samples: [{ id: "sample_audio", expected: "owner", audioPath: "sample.wav" }],
    };

    await expect(
      materializeManifestEmbeddingsWithSidecar({
        manifest,
        baseDir,
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
      }),
    ).rejects.toThrow(/mixes existing embeddings/);
  });
});
