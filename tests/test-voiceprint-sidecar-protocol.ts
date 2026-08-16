import { describe, expect, test } from "bun:test";
import {
  buildEmbeddingBatchRequest,
  parseEmbeddingBatchResponseJson,
  validateEmbeddingBatchResponse,
  validateEmbeddingBatchRequest,
  validateEmbeddingRequest,
  validateEmbeddingResponse,
} from "../src/identity/voiceprint/index.js";

describe("voiceprint sidecar protocol", () => {
  test("builds and validates embedding batch requests", () => {
    const batch = buildEmbeddingBatchRequest([
      {
        id: "turn_1",
        audioPath: "/tmp/turn_1.wav",
        startMs: 100,
        endMs: 900,
        targetSampleRate: 16000,
      },
    ]);

    expect(batch.version).toBe(1);
    expect(batch.requests[0]?.id).toBe("turn_1");
    expect(() => validateEmbeddingRequest({ id: "", audioPath: "/tmp/a.wav" })).toThrow(/id/);
    expect(() => validateEmbeddingRequest({ id: "x", audioPath: "", startMs: 1 })).toThrow(/audioPath/);
    expect(() => validateEmbeddingRequest({ id: "x", audioPath: "/tmp/a.wav", startMs: 2, endMs: 1 })).toThrow(/endMs/);
    expect(() =>
      buildEmbeddingBatchRequest([
        { id: "turn_1", audioPath: "/tmp/a.wav" },
        { id: "turn_1", audioPath: "/tmp/b.wav" },
      ]),
    ).toThrow(/Duplicate.*turn_1/);
    expect(() =>
      validateEmbeddingBatchRequest({
        version: 1,
        requests: [
          { id: "turn_1", audioPath: "/tmp/a.wav" },
          { id: "turn_1", audioPath: "/tmp/b.wav" },
        ],
      }),
    ).toThrow(/Duplicate.*turn_1/);
  });

  test("validates sidecar embedding responses", () => {
    expect(() =>
      validateEmbeddingResponse({
        id: "turn_1",
        embedding: [0.1, 0.2],
        model: { provider: "speechbrain", modelId: "spkrec-ecapa-voxceleb" },
      }),
    ).not.toThrow();

    expect(() =>
      validateEmbeddingResponse({
        id: "turn_1",
        embedding: [],
        model: { provider: "speechbrain", modelId: "spkrec-ecapa-voxceleb" },
      }),
    ).toThrow(/embedding/);

    expect(() =>
      validateEmbeddingResponse({
        id: "turn_1",
        embedding: [Number.NaN],
        model: { provider: "speechbrain", modelId: "spkrec-ecapa-voxceleb" },
      }),
    ).toThrow(/embedding/);

    expect(() =>
      validateEmbeddingResponse({
        id: "turn_1",
        embedding: [0, 0],
        model: { provider: "speechbrain", modelId: "spkrec-ecapa-voxceleb" },
      }),
    ).toThrow(/embedding/);
  });

  test("validates batch responses against request ids", () => {
    const batch = {
      version: 1 as const,
      responses: [
        {
          id: "turn_1",
          embedding: [0.1, 0.2],
          model: { provider: "wespeaker" as const, modelId: "wespeaker-test" },
        },
      ],
    };

    expect(() => validateEmbeddingBatchResponse(batch, ["turn_1"])).not.toThrow();
    expect(() => validateEmbeddingBatchResponse(batch, ["turn_1", "turn_2"])).toThrow(/turn_2/);
    expect(() => validateEmbeddingBatchResponse(batch, ["turn_1", "turn_1"])).toThrow(/Duplicate/);
    expect(() => validateEmbeddingBatchResponse(batch, ["different_turn"])).toThrow(/Unexpected|Missing/);
    expect(parseEmbeddingBatchResponseJson(JSON.stringify(batch), ["turn_1"]).responses).toHaveLength(1);
  });
});
