import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyLiveVoiceprintScoringPlanPatches,
  buildLiveVoiceprintScoringPlan,
  buildLiveVoiceprintScoringPlanPatches,
  markLiveVoiceprintScoringPlanErrorStates,
  runLiveVoiceprintScoringPlan,
  scoreLiveVoiceprintScoringBatchResponse,
  type LiveVoiceprintPlanItemInput,
} from "../src/identity/voiceprint/index.js";

const sampleRate = 16000;
const createdAt = "2026-06-23T00:00:00.000Z";
const updatedAt = "2026-06-23T00:00:01.000Z";
const processingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
  memoryPromotionAllowed: true,
};
const sidecarModel = { provider: "custom" as const, modelId: "plan-sidecar", version: "1" };
let testDir: string | null = null;

afterEach(() => {
  if (testDir) {
    rmSync(testDir, { recursive: true, force: true });
    testDir = null;
  }
});

describe("live voiceprint scoring plan", () => {
  test("plans queued jobs and pre-sidecar skipped states for finalized turns", () => {
    const plan = buildLiveVoiceprintScoringPlan({
      turns: [
        turn("rt_plan_queued", "audio_plan_queued", {
          audioPath: "/tmp/audio_plan_queued.wav",
          consent: processingConsent,
        }),
        turn("rt_plan_quiet", "audio_plan_quiet", {
          audioPath: "/tmp/audio_plan_quiet.wav",
          amplitude: 0.001,
          consent: processingConsent,
        }),
        turn("rt_plan_denied", "audio_plan_denied", {
          audioPath: "/tmp/audio_plan_denied.wav",
          consent: { captureAllowed: true, biometricAllowed: false },
        }),
        turn("rt_plan_assistant", "audio_plan_assistant", {
          audioPath: "/tmp/audio_plan_assistant.wav",
          role: "assistant",
        }),
      ],
    });

    expect(plan.version).toBe(1);
    expect(plan.status).toBe("partial");
    expect(plan.queueResults).toHaveLength(4);
    expect(plan.queued).toHaveLength(1);
    expect(plan.skipped).toHaveLength(3);
    expect(plan.jobContexts).toHaveLength(1);
    expect(plan.states.map((state) => state.lifecycle)).toEqual([
      "scoring",
      "skipped",
      "skipped",
      "not_applicable",
    ]);
    expect(plan.jobContexts[0]?.job.id).toBe(plan.queued[0]?.job.id);
    expect(plan.jobContexts[0]?.consent).toEqual(processingConsent);
    expect(plan.skipped.map((item) => item.reason)).toEqual([
      "quality_rejected",
      "consent_denied",
      "non_user_turn",
    ]);
  });

  test("builds transcript state patches from plan sidecar results", () => {
    const plan = buildLiveVoiceprintScoringPlan({
      turns: [
        turn("rt_plan_patch", "audio_plan_patch", {
          audioPath: "/tmp/audio_plan_patch.wav",
          consent: processingConsent,
        }),
      ],
    });
    const batch = scoreBatch(plan.jobContexts, [1, 0]);

    const patches = buildLiveVoiceprintScoringPlanPatches({
      plan,
      batch,
      createdAt,
      updatedAt,
    });

    expect(patches).toHaveLength(1);
    const patch = patches[0];
    if (!patch || patch.kind !== "scored") {
      throw new Error("expected scored patch");
    }
    expect(patch.state.lifecycle).toBe("resolved");
    expect(patch.state.policyState).toBe("policy_allowed_use");
    expect(patch.state.requestId).toBe(plan.jobContexts[0]?.job.embeddingRequest.id);
    expect(patch.update.requestId).toBe(plan.jobContexts[0]?.job.embeddingRequest.id);
  });

  test("runs a live plan end to end through the sidecar and returns final states", async () => {
    const scriptPath = writeSidecarScript(`
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: request.requests.map((item) => ({
          id: item.id,
          embedding: [1, 0],
          model: { provider: "custom", modelId: "plan-sidecar", version: "1" }
        }))
      }));
    `);

    const run = await runLiveVoiceprintScoringPlan({
      sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
      turns: [
        turn("rt_plan_run", "audio_plan_run", {
          audioPath: "/tmp/audio_plan_run.wav",
          consent: processingConsent,
        }),
        turn("rt_plan_run_quiet", "audio_plan_run_quiet", {
          audioPath: "/tmp/audio_plan_run_quiet.wav",
          amplitude: 0.001,
          consent: processingConsent,
        }),
      ],
      createdAt,
      updatedAt,
    });

    expect(run.version).toBe(1);
    expect(run.status).toBe("partial");
    expect(run.plan.status).toBe("partial");
    expect(run.batch?.status).toBe("scored");
    expect(run.patches).toHaveLength(1);
    expect(run.states.map((state) => state.lifecycle)).toEqual(["resolved", "skipped"]);
    expect(run.states[0]?.requestId).toBe(run.plan.jobContexts[0]?.job.embeddingRequest.id);
    expect(run.storageBundle?.transcriptIdentityStates).toHaveLength(2);
    expect(run.storageBundle?.transcriptSpeakerAnnotations).toHaveLength(1);
    expect(run.storageBundle?.clearTranscriptIdentity[0]?.transcriptItemId).toBe(
      "rt_plan_run_quiet",
    );
  });

  test("does not spawn the sidecar when every turn is skipped before scoring", async () => {
    const run = await runLiveVoiceprintScoringPlan({
      sidecar: {
        command: process.execPath,
        args: ["-e", "process.exit(99)"],
        timeoutMs: 5_000,
      },
      turns: [
        turn("rt_plan_all_skipped", "audio_plan_all_skipped", {
          audioPath: "/tmp/audio_plan_all_skipped.wav",
          amplitude: 0.001,
          consent: processingConsent,
        }),
      ],
      createdAt,
      updatedAt,
    });

    expect(run.status).toBe("skipped");
    expect(run.batch).toBeNull();
    expect(run.patches).toEqual([]);
    expect(run.states[0]?.lifecycle).toBe("skipped");
    expect(run.states[0]?.skipReason).toBe("quality_rejected");
    expect(run.storageBundle?.transcriptIdentityStates[0]?.lifecycle).toBe("skipped");
    expect(run.storageBundle?.clearTranscriptIdentity[0]?.transcriptItemId).toBe(
      "rt_plan_all_skipped",
    );
  });

  test("plans missing audio without requiring local samples", () => {
    const plan = buildLiveVoiceprintScoringPlan({
      turns: [
        turn("rt_plan_missing_audio_no_samples", "audio_plan_missing_audio_no_samples", {
          samples: undefined,
          sampleRate: undefined,
          consent: processingConsent,
        }),
      ],
    });

    expect(plan.status).toBe("skipped");
    expect(plan.queued).toEqual([]);
    expect(plan.skipped).toHaveLength(1);
    expect(plan.skipped[0]?.reason).toBe("missing_audio_artifact");
    expect(plan.states[0]?.lifecycle).toBe("skipped");
    expect(plan.states[0]?.skipReason).toBe("missing_audio_artifact");
  });

  test("marks scoring states as sidecar errors when the high-level plan run fails", async () => {
    const scriptPath = writeSidecarScript(`
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      process.stderr.write("sidecar boom");
      process.exit(7);
    `);

    const run = await runLiveVoiceprintScoringPlan({
      sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
      turns: [
        turn("rt_plan_sidecar_error", "audio_plan_sidecar_error", {
          audioPath: "/tmp/audio_plan_sidecar_error.wav",
          consent: processingConsent,
        }),
        turn("rt_plan_sidecar_error_quiet", "audio_plan_sidecar_error_quiet", {
          audioPath: "/tmp/audio_plan_sidecar_error_quiet.wav",
          amplitude: 0.001,
          consent: processingConsent,
        }),
      ],
      createdAt,
      updatedAt,
    });

    expect(run.status).toBe("error");
    expect(run.batch).toBeNull();
    expect(run.patches).toEqual([]);
    expect(run.error?.code).toBe("sidecar_failed");
    expect(run.error?.message).toContain("sidecar boom");
    expect(run.states.map((state) => state.lifecycle)).toEqual(["error", "skipped"]);
    expect(run.states[0]?.policyState).toBe("none");
    expect(run.states[0]?.error?.code).toBe("sidecar_failed");
    expect(run.states[0]?.requestId).toBe(run.plan.jobContexts[0]?.job.embeddingRequest.id);
    expect(run.states[1]?.skipReason).toBe("quality_rejected");
  });

  test("can still throw sidecar failures for strict callers", async () => {
    const scriptPath = writeSidecarScript(`
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      process.stderr.write("strict sidecar boom");
      process.exit(7);
    `);

    await expect(
      runLiveVoiceprintScoringPlan({
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        turns: [
          turn("rt_plan_sidecar_throw", "audio_plan_sidecar_throw", {
            audioPath: "/tmp/audio_plan_sidecar_throw.wav",
            consent: processingConsent,
          }),
        ],
        sidecarErrorHandling: "throw",
        createdAt,
        updatedAt,
      }),
    ).rejects.toThrow(/strict sidecar boom/);
  });

  test("applies plan patches without changing unrelated planned states", () => {
    const plan = buildLiveVoiceprintScoringPlan({
      turns: [
        turn("rt_plan_merge_patch", "audio_plan_merge_patch", {
          audioPath: "/tmp/audio_plan_merge_patch.wav",
          consent: processingConsent,
        }),
        turn("rt_plan_merge_quiet", "audio_plan_merge_quiet", {
          audioPath: "/tmp/audio_plan_merge_quiet.wav",
          amplitude: 0.001,
          consent: processingConsent,
        }),
      ],
    });
    const batch = scoreBatch(plan.jobContexts, [1, 0]);
    const patches = buildLiveVoiceprintScoringPlanPatches({
      plan,
      batch,
      createdAt,
      updatedAt,
    });

    const states = applyLiveVoiceprintScoringPlanPatches({ plan, patches });

    expect(states.map((state) => state.lifecycle)).toEqual(["resolved", "skipped"]);
    expect(states[1]?.skipReason).toBe("quality_rejected");
  });

  test("marks plan scoring states as errors without changing skipped states", () => {
    const plan = buildLiveVoiceprintScoringPlan({
      turns: [
        turn("rt_plan_error_state", "audio_plan_error_state", {
          audioPath: "/tmp/audio_plan_error_state.wav",
          consent: processingConsent,
        }),
        turn("rt_plan_error_state_quiet", "audio_plan_error_state_quiet", {
          audioPath: "/tmp/audio_plan_error_state_quiet.wav",
          amplitude: 0.001,
          consent: processingConsent,
        }),
      ],
    });

    const states = markLiveVoiceprintScoringPlanErrorStates({
      plan,
      code: "sidecar_failed",
      message: "sidecar unavailable",
      updatedAt,
    });

    expect(states.map((state) => state.lifecycle)).toEqual(["error", "skipped"]);
    expect(states[0]?.error?.message).toBe("sidecar unavailable");
    expect(states[1]).toBe(plan.states[1]);
  });

  test("drops stale sidecar results when applying patches with the default live handling", () => {
    const first = buildLiveVoiceprintScoringPlan({
      turns: [
        turn("rt_plan_retry", "audio_plan_retry_old", {
          audioPath: "/tmp/audio_plan_retry_old.wav",
          consent: processingConsent,
        }),
      ],
    });
    const retry = buildLiveVoiceprintScoringPlan({
      turns: [
        turn("rt_plan_retry", "audio_plan_retry_new", {
          audioPath: "/tmp/audio_plan_retry_new.wav",
          consent: processingConsent,
          existingState: first.states[0],
        }),
      ],
    });
    const staleBatch = scoreBatch(first.jobContexts, [1, 0]);

    const patches = buildLiveVoiceprintScoringPlanPatches({
      plan: retry,
      batch: staleBatch,
      createdAt,
      updatedAt,
    });

    expect(first.jobContexts[0]?.job.id).not.toBe(retry.jobContexts[0]?.job.id);
    expect(patches).toEqual([]);
  });

  test("rejects duplicate transcript joins inside a single plan", () => {
    expect(() =>
      buildLiveVoiceprintScoringPlan({
        turns: [
          turn("rt_plan_duplicate", "audio_plan_duplicate_a", {
            audioPath: "/tmp/audio_plan_duplicate_a.wav",
            consent: processingConsent,
          }),
          turn("rt_plan_duplicate", "audio_plan_duplicate_b", {
            audioPath: "/tmp/audio_plan_duplicate_b.wav",
            consent: processingConsent,
          }),
        ],
      }),
    ).toThrow(/Duplicate live voiceprint plan turn/);
  });
});

function scoreBatch(contexts: ReturnType<typeof buildLiveVoiceprintScoringPlan>["jobContexts"], embedding: number[]) {
  return scoreLiveVoiceprintScoringBatchResponse({
    jobs: contexts,
    response: {
      version: 1,
      responses: contexts.map((context) => ({
        id: context.job.embeddingRequest.id,
        embedding,
        model: sidecarModel,
      })),
    },
  });
}

function turn(
  transcriptItemId: string,
  audioArtifactId: string,
  options: Partial<LiveVoiceprintPlanItemInput> & {
    audioPath?: string;
    amplitude?: number;
  } = {},
): LiveVoiceprintPlanItemInput {
  const amplitude = options.amplitude ?? 0.1;
  return {
    sessionKey: "live:voiceprint-plan",
    transcriptItemId,
    role: "user",
    text: "this is the owner speaking",
    startMs: 1000,
    endMs: 2500,
    audioArtifactId,
    route: "iphone_mic",
    samples: sineWave(1500, amplitude),
    sampleRate,
    ownerEmbeddings: [[1, 0], [0.98, 0.02]],
    expectedModel: sidecarModel,
    eventId: `event:${transcriptItemId}`,
    createdAt,
    ...options,
  };
}

function writeSidecarScript(source: string): string {
  testDir = mkdtempSync(join(tmpdir(), "voiceprint-plan-test-"));
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
