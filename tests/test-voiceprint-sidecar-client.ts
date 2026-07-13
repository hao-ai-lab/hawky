import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildEmbeddingBatchRequest,
  runEmbeddingSidecar,
} from "../src/identity/voiceprint/index.js";

let testDir: string | null = null;

afterEach(() => {
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
    testDir = null;
  }
});

function writeSidecarScript(source: string): string {
  testDir = mkdtempSync(join(tmpdir(), "voiceprint-sidecar-test-"));
  const scriptPath = join(testDir, "sidecar.js");
  writeFileSync(scriptPath, source, "utf8");
  return scriptPath;
}

describe("voiceprint sidecar client", () => {
  test("runs a JSON stdin/stdout sidecar and validates response ids", async () => {
    const scriptPath = writeSidecarScript(`
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: request.requests.map((item) => ({
          id: item.id,
          embedding: [1, 0],
          model: { provider: "custom", modelId: "test-sidecar" }
        }))
      }));
    `);
    const request = buildEmbeddingBatchRequest([
      { id: "turn_1", audioPath: "/tmp/turn_1.wav" },
      { id: "turn_2", audioPath: "/tmp/turn_2.wav" },
    ]);

    const response = await runEmbeddingSidecar({
      sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
      request,
    });

    expect(response.responses.map((item) => item.id)).toEqual(["turn_1", "turn_2"]);
  });

  test("rejects sidecar responses missing requested ids", async () => {
    const scriptPath = writeSidecarScript(`
      process.stdin.resume();
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: [{
          id: "turn_1",
          embedding: [1, 0],
          model: { provider: "custom", modelId: "test-sidecar" }
        }]
      }));
    `);
    const request = buildEmbeddingBatchRequest([
      { id: "turn_1", audioPath: "/tmp/turn_1.wav" },
      { id: "turn_2", audioPath: "/tmp/turn_2.wav" },
    ]);

    await expect(
      runEmbeddingSidecar({
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        request,
      }),
    ).rejects.toThrow(/turn_2/);
  });

  test("rejects sidecar responses with unexpected ids", async () => {
    const scriptPath = writeSidecarScript(`
      process.stdin.resume();
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: [{
          id: "unexpected_turn",
          embedding: [1, 0],
          model: { provider: "custom", modelId: "test-sidecar" }
        }]
      }));
    `);
    const request = buildEmbeddingBatchRequest([
      { id: "turn_1", audioPath: "/tmp/turn_1.wav" },
    ]);

    await expect(
      runEmbeddingSidecar({
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        request,
      }),
    ).rejects.toThrow(/unexpected_turn|turn_1/);
  });

  test("rejects non-zero sidecar exits", async () => {
    const scriptPath = writeSidecarScript(`
      process.stderr.write("model failed");
      process.exit(7);
    `);
    const request = buildEmbeddingBatchRequest([
      { id: "turn_1", audioPath: "/tmp/turn_1.wav" },
    ]);

    await expect(
      runEmbeddingSidecar({
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        request,
      }),
    ).rejects.toThrow(/model failed/);
  });

  test("rejects early sidecar exits without unhandled stdin errors", async () => {
    const scriptPath = writeSidecarScript(`
      process.stderr.write("closed before stdin");
      process.exit(7);
    `);
    const request = buildEmbeddingBatchRequest(
      Array.from({ length: 10_000 }, (_, index) => ({
        id: `turn_${index}`,
        audioPath: `/tmp/turn_${index}.wav`,
      })),
    );

    await expect(
      runEmbeddingSidecar({
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        request,
      }),
    ).rejects.toThrow(/closed before stdin|stdin|EPIPE|exited/);
  });
});
