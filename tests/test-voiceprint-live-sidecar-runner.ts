import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildLiveVoiceprintScoringBatchRequest,
  buildLiveVoiceprintScoringJob,
  buildVoiceprintTranscriptIdentityUpdates,
  prepareLiveVoiceprintTurn,
  runLiveVoiceprintScoringJobs,
  scoreLiveVoiceprintScoringBatchResponse,
  type LiveVoiceprintReadyTurn,
  type LiveVoiceprintScoringJob,
  type LiveVoiceprintScoringJobContext,
} from "../src/identity/voiceprint/index.js";

const sampleRate = 16000;
const processingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
};
let testDir: string | null = null;

afterEach(() => {
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
    testDir = null;
  }
});

describe("live voiceprint sidecar runner", () => {
  test("scores batch responses and builds transcript identity updates", () => {
    const contexts = [jobContext("rt_runner_1", "audio_runner_1"), jobContext("rt_runner_2", "audio_runner_2")];
    const request = buildLiveVoiceprintScoringBatchRequest(contexts.map((context) => context.job));
    const batch = scoreLiveVoiceprintScoringBatchResponse({
      request,
      jobs: contexts,
      response: {
        version: 1,
        responses: contexts.map((context) => ({
          id: context.job.embeddingRequest.id,
          embedding: [1, 0],
          model: { provider: "custom", modelId: "runner-sidecar", version: "1" },
        })),
      },
    });

    expect(batch.status).toBe("scored");
    expect(batch.results).toHaveLength(2);
    expect(batch.model).toEqual({ provider: "custom", modelId: "runner-sidecar", version: "1" });
    expect(batch.results.every((result) => result.result.score.decision === "owner_speaking")).toBe(true);

    const updates = buildVoiceprintTranscriptIdentityUpdates({
      results: batch.results,
      createdAt: "2026-06-23T00:00:00.000Z",
    });
    expect(updates).toHaveLength(2);
    expect(updates[0]?.status).toBe("identity_resolved");
    expect(updates[0]?.transcriptItemId).toBe("rt_runner_1");
    expect(updates[0]?.eventParticipation?.actor).toEqual({ type: "owner" });
    expect(updates[1]?.status).toBe("identity_resolved");
  });

  test("rejects mixed model responses before building updates", () => {
    const contexts = [jobContext("rt_runner_1", "audio_runner_1"), jobContext("rt_runner_2", "audio_runner_2")];
    const request = buildLiveVoiceprintScoringBatchRequest(contexts.map((context) => context.job));

    expect(() =>
      scoreLiveVoiceprintScoringBatchResponse({
        request,
        jobs: contexts,
        response: {
          version: 1,
          responses: [
            {
              id: contexts[0]!.job.embeddingRequest.id,
              embedding: [1, 0],
              model: { provider: "custom", modelId: "runner-sidecar", version: "1" },
            },
            {
              id: contexts[1]!.job.embeddingRequest.id,
              embedding: [1, 0],
              model: { provider: "custom", modelId: "runner-sidecar", version: "2" },
            },
          ],
        },
      }),
    ).toThrow(/mixed models/);
  });

  test("runs sidecar jobs end to end through JSON stdin/stdout", async () => {
    const scriptPath = writeSidecarScript(`
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: request.requests.map((item) => ({
          id: item.id,
          embedding: [1, 0],
          model: { provider: "custom", modelId: "runner-sidecar", version: "1" }
        }))
      }));
    `);
    const contexts = [jobContext("rt_runner_live", "audio_runner_live")];

    const batch = await runLiveVoiceprintScoringJobs({
      sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
      jobs: contexts,
    });
    const updates = buildVoiceprintTranscriptIdentityUpdates({
      results: batch.results,
      createdAt: "2026-06-23T00:00:00.000Z",
    });

    expect(batch.results).toHaveLength(1);
    expect(updates[0]?.sessionKey).toBe("live:voiceprint-runner");
    expect(updates[0]?.transcriptItemId).toBe("rt_runner_live");
    expect(updates[0]?.identitySignal.metadata.model.modelId).toBe("runner-sidecar");
  });

  test("honors the shortest queued job timeout when running the sidecar", async () => {
    const scriptPath = writeSidecarScript(`
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ version: 1, responses: [] }));
      }, 200);
    `);
    const context = jobContext("rt_runner_timeout", "audio_runner_timeout", {
      timeoutMs: 25,
    });

    await expect(
      runLiveVoiceprintScoringJobs({
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        jobs: [context],
      }),
    ).rejects.toThrow(/timed out after 25ms/);
  });

  test("keeps a stricter sidecar timeout when it is shorter than job timeouts", async () => {
    const scriptPath = writeSidecarScript(`
      setTimeout(() => {
        process.stdout.write(JSON.stringify({ version: 1, responses: [] }));
      }, 200);
    `);
    const context = jobContext("rt_runner_sidecar_timeout", "audio_runner_sidecar_timeout", {
      timeoutMs: 5_000,
    });

    await expect(
      runLiveVoiceprintScoringJobs({
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 20 },
        jobs: [context],
      }),
    ).rejects.toThrow(/timed out after 20ms/);
  });

  test("skips denied-consent jobs before invoking the sidecar", async () => {
    const scriptPath = writeSidecarScript(`
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.requests.length !== 1) {
        process.stderr.write("expected exactly one processable request");
        process.exit(9);
      }
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: request.requests.map((item) => ({
          id: item.id,
          embedding: [1, 0],
          model: { provider: "custom", modelId: "runner-sidecar", version: "1" }
        }))
      }));
    `);
    const allowed = jobContext("rt_runner_allowed", "audio_runner_allowed");
    const denied = {
      ...jobContext("rt_runner_denied", "audio_runner_denied"),
      consent: { captureAllowed: false },
    };

    const batch = await runLiveVoiceprintScoringJobs({
      sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
      jobs: [allowed, denied],
    });

    expect(batch.status).toBe("partial");
    expect(batch.request?.requests).toHaveLength(1);
    expect(batch.request?.requests[0]?.id).toBe(allowed.job.embeddingRequest.id);
    expect(batch.results).toHaveLength(1);
    expect(batch.skipped).toEqual([
      {
        status: "skipped",
        jobId: denied.job.id,
        requestId: denied.job.embeddingRequest.id,
        sessionKey: "live:voiceprint-runner",
        transcriptItemId: "rt_runner_denied",
        reason: "consent_denied",
      },
    ]);
  });

  test("skips an all-denied batch without spawning the sidecar", async () => {
    const denied = {
      ...jobContext("rt_runner_denied", "audio_runner_denied"),
      consent: { biometricAllowed: false },
    };

    const batch = await runLiveVoiceprintScoringJobs({
      sidecar: {
        command: process.execPath,
        args: ["-e", "process.exit(99)"],
        timeoutMs: 5_000,
      },
      jobs: [denied],
    });

    expect(batch.status).toBe("skipped");
    expect(batch.request).toBeNull();
    expect(batch.results).toEqual([]);
    expect(batch.skipped[0]?.reason).toBe("consent_denied");
  });

  test("rejects a provided request that includes denied-consent jobs", () => {
    const allowed = jobContext("rt_runner_allowed", "audio_runner_allowed");
    const denied = {
      ...jobContext("rt_runner_denied", "audio_runner_denied"),
      consent: { captureAllowed: false },
    };
    const unsafeRequest = buildLiveVoiceprintScoringBatchRequest([allowed.job, denied.job]);

    expect(() =>
      scoreLiveVoiceprintScoringBatchResponse({
        request: unsafeRequest,
        jobs: [allowed, denied],
        response: {
          version: 1,
          responses: unsafeRequest.requests.map((item) => ({
            id: item.id,
            embedding: [1, 0],
            model: { provider: "custom", modelId: "runner-sidecar", version: "1" },
          })),
        },
      }),
    ).toThrow(/non-processable job/);
  });

  test("rejects provided requests that change job audio details", () => {
    const allowed = jobContext("rt_runner_allowed", "audio_runner_allowed");
    const unsafeRequest = {
      version: 1 as const,
      requests: [
        {
          ...allowed.job.embeddingRequest,
          audioPath: "/tmp/different-audio.wav",
        },
      ],
    };

    expect(() =>
      scoreLiveVoiceprintScoringBatchResponse({
        request: unsafeRequest,
        jobs: [allowed],
        response: {
          version: 1,
          responses: [
            {
              id: allowed.job.embeddingRequest.id,
              embedding: [1, 0],
              model: { provider: "custom", modelId: "runner-sidecar", version: "1" },
            },
          ],
        },
      }),
    ).toThrow(/request details do not match/);
  });

  test("rejects duplicate job contexts before scoring responses", () => {
    const context = jobContext("rt_runner_duplicate", "audio_runner_duplicate");
    const request = buildLiveVoiceprintScoringBatchRequest([context.job]);

    expect(() =>
      scoreLiveVoiceprintScoringBatchResponse({
        request,
        jobs: [context, context],
        response: {
          version: 1,
          responses: [
            {
              id: context.job.embeddingRequest.id,
              embedding: [1, 0],
              model: { provider: "custom", modelId: "runner-sidecar", version: "1" },
            },
          ],
        },
      }),
    ).toThrow(/Duplicate live voiceprint scoring job id/);
  });
});

function jobContext(
  transcriptItemId: string,
  audioArtifactId: string,
  options: { timeoutMs?: number } = {},
): LiveVoiceprintScoringJobContext {
  const job = buildLiveVoiceprintScoringJob({
    prepared: readyTurn(transcriptItemId, audioArtifactId),
    audioPath: `/tmp/${audioArtifactId}.wav`,
    ownerTemplateRef: "owner-template:v1",
    createdAt: "2026-06-23T00:00:00.000Z",
    timeoutMs: options.timeoutMs,
  });
  return contextForJob(job);
}

function contextForJob(job: LiveVoiceprintScoringJob): LiveVoiceprintScoringJobContext {
  return {
    job,
    ownerEmbeddings: [[1, 0], [0.98, 0.02]],
    consent: { ...processingConsent, memoryPromotionAllowed: true },
    eventId: `event:${job.prepared.turn.transcriptItemId}`,
    createdAt: "2026-06-23T00:00:00.000Z",
    expectedModel: { provider: "custom", modelId: "runner-sidecar", version: "1" },
  };
}

function readyTurn(transcriptItemId: string, audioArtifactId: string): LiveVoiceprintReadyTurn {
  const prepared = prepareLiveVoiceprintTurn({
    sessionKey: "live:voiceprint-runner",
    transcriptItemId,
    role: "user",
    text: "this is the owner speaking",
    startMs: 1000,
    endMs: 2500,
    audioArtifactId,
    route: "iphone_mic",
    samples: sineWave(1500, 0.1),
    sampleRate,
  });
  if (prepared.status !== "ready") {
    throw new Error("expected ready voiceprint turn");
  }
  return prepared;
}

function writeSidecarScript(source: string): string {
  testDir = mkdtempSync(join(tmpdir(), "voiceprint-runner-test-"));
  const scriptPath = join(testDir, "sidecar.js");
  writeFileSync(scriptPath, source, "utf8");
  return scriptPath;
}

function sineWave(durationMs: number, amplitude: number): Float32Array {
  const length = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Float32Array(length);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude;
  }
  return samples;
}
