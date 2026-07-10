import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildVoiceprintTemplateArtifact,
  buildVoiceprintStorageBundle,
  buildVoiceprintTranscriptIdentityState,
  tombstoneVoiceprintTemplate,
  writeEncryptedVoiceprintTemplateArtifact,
  writeVoiceprintTemplateEncryptionKeyFile,
  type VoiceprintTemplateEncryptionKey,
  type VoiceprintTemplateArtifact,
} from "../src/identity/voiceprint/index.js";
import {
  createFileVoiceprintStorage,
  createInMemoryVoiceprintStorage,
  registerVoiceprintMethods,
  resolveVoiceprintLiveScoringConfigFromConfig,
} from "../src/gateway/voiceprint-methods.js";

const createdAt = "2026-06-23T00:00:00.000Z";
const sidecarModel = { provider: "custom" as const, modelId: "method-sidecar", version: "1" };
const trustedProcessingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
  memoryPromotionAllowed: true,
  exportAllowed: false,
};
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("voiceprint gateway methods", () => {
  test("keeps live scoring disabled unless server config explicitly enables it", () => {
    expect(resolveVoiceprintLiveScoringConfigFromConfig({} as any)).toBeUndefined();
    expect(resolveVoiceprintLiveScoringConfigFromConfig({
      voiceprint: {
        live_scoring: {
          enabled: false,
        },
      },
    } as any)).toBeUndefined();
  });

  test("resolves live scoring from server config without client-provided keys", () => {
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-config-"));
    tempDirs.push(dir);
    const scoring = resolveVoiceprintLiveScoringConfigFromConfig({
      voiceprint: {
        live_scoring: {
          enabled: true,
          sidecar: {
            command: "/usr/bin/env",
            args: ["node", "voiceprint-sidecar.js"],
            cwd: dir,
            timeout_ms: 12_000,
            max_stdout_bytes: 4096,
            env: {
              VOICEPRINT_TEST: "1",
            },
          },
          owner_template: {
            file_path: join(dir, "owner-template.enc.json"),
            key_path: join(dir, "owner-template.key.json"),
            key_ref: "owner-template-config-key",
            create_key_if_missing: false,
          },
          allowed_audio_roots: [dir],
          consent: {
            capture_allowed: true,
            biometric_allowed: true,
            memory_promotion_allowed: false,
            template_learning_allowed: false,
            export_allowed: false,
          },
          expected_model: {
            provider: "custom",
            model_id: "method-sidecar",
            version: "1",
          },
          thresholds: {
            owner_accept: 0.86,
            owner_possible: 0.74,
          },
          quality_thresholds: {
            min_duration_ms: 800,
            target_duration_ms: 1300,
          },
          target_sample_rate: 16000,
          timeout_ms: 9000,
        },
      },
    } as any);

    expect(scoring?.sidecar).toMatchObject({
      command: "/usr/bin/env",
      args: ["node", "voiceprint-sidecar.js"],
      cwd: dir,
      timeoutMs: 12_000,
      maxStdoutBytes: 4096,
      env: {
        VOICEPRINT_TEST: "1",
      },
    });
    expect(scoring?.ownerTemplateFileSource).toMatchObject({
      filePath: join(dir, "owner-template.enc.json"),
      keyPath: join(dir, "owner-template.key.json"),
      keyRef: "owner-template-config-key",
      createKeyIfMissing: false,
    });
    expect(scoring?.allowedAudioRoots).toEqual([dir]);
    expect(scoring?.consent).toMatchObject({
      captureAllowed: true,
      biometricAllowed: true,
      memoryPromotionAllowed: false,
      templateLearningAllowed: false,
      exportAllowed: false,
    });
    expect(scoring?.expectedModel).toEqual({
      provider: "custom",
      modelId: "method-sidecar",
      version: "1",
      notes: undefined,
    });
    expect(scoring?.thresholds).toEqual({
      ownerAccept: 0.86,
      ownerPossible: 0.74,
    });
    expect(scoring?.qualityThresholds).toMatchObject({
      minDurationMs: 800,
      targetDurationMs: 1300,
    });
    expect(scoring?.targetSampleRate).toBe(16000);
    expect(scoring?.timeoutMs).toBe(9000);
  });

  test("rejects incomplete enabled live scoring config", () => {
    expect(() =>
      resolveVoiceprintLiveScoringConfigFromConfig({
        voiceprint: {
          live_scoring: {
            enabled: true,
            sidecar: {
              command: "/usr/bin/env",
            },
            owner_template: {
              file_path: "/tmp/owner-template.enc.json",
              key_path: "/tmp/owner-template.key.json",
            },
            allowed_audio_roots: ["/tmp"],
          },
        },
      } as any),
    ).toThrow(/consent/);

    expect(() =>
      resolveVoiceprintLiveScoringConfigFromConfig({
        voiceprint: {
          live_scoring: {
            enabled: true,
            sidecar: {
              command: "/usr/bin/env",
            },
            owner_template: {
              file_path: "/tmp/owner-template.enc.json",
              key_path: "/tmp/owner-template.key.json",
            },
            allowed_audio_roots: [],
            consent: {
              capture_allowed: true,
              biometric_allowed: true,
            },
          },
        },
      } as any),
    ).toThrow(/allowed_audio_roots/);
  });

  test("applies a voiceprint storage bundle for the bound session", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    registerVoiceprintMethods(server as any, storage);
    const bundle = buildVoiceprintStorageBundle({
      states: [
        buildVoiceprintTranscriptIdentityState({
          sessionKey: "live:voiceprint-methods",
          transcriptItemId: "rt_voiceprint_methods_1",
          createdAt,
        }),
      ],
      createdAt,
    });

    const result = await server.call(
      "identity.voiceprint.apply_bundle",
      { sessionKey: "live:voiceprint-methods" },
      { bundle },
    );

    expect(result.ok).toBe(true);
    expect(result.bundleId).toBe(bundle.id);
    expect(result.sessionKey).toBe("live:voiceprint-methods");
    expect(result.counts.transcriptIdentityStates).toBe(1);
    expect(storage.snapshot?.().transcriptIdentityStates[0]?.transcriptItemId).toBe(
      "rt_voiceprint_methods_1",
    );
  });

  test("rejects unbound or cross-session bundle application", async () => {
    const server = makeMockServer();
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage());
    const bundle = buildVoiceprintStorageBundle({
      states: [
        buildVoiceprintTranscriptIdentityState({
          sessionKey: "live:voiceprint-methods",
          transcriptItemId: "rt_voiceprint_methods_forbidden",
          createdAt,
        }),
      ],
      createdAt,
    });

    await expect(
      server.call("identity.voiceprint.apply_bundle", { sessionKey: null }, { bundle }),
    ).rejects.toThrow(/Unbound connection/);
    await expect(
      server.call(
        "identity.voiceprint.apply_bundle",
        { sessionKey: "live:voiceprint-other" },
        { bundle },
      ),
    ).rejects.toThrow(/sessionKey does not match/);
  });

  test("buffers realtime voiceprint events for the bound session", async () => {
    const server = makeMockServer();
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage());

    const conn = { sessionKey: "live:voiceprint-methods-realtime" };
    await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "input_audio_buffer.speech_started",
        item_id: "rt_voiceprint_methods_realtime",
        audio_start_ms: 1000,
      },
    });
    await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "input_audio_buffer.speech_stopped",
        item_id: "rt_voiceprint_methods_realtime",
        audio_end_ms: 2400,
      },
    });
    await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "live_recording.audio_artifact",
        item_id: "rt_voiceprint_methods_realtime",
        audio_artifact_id: "audio_voiceprint_methods_realtime",
        audio_path: "/tmp/audio_voiceprint_methods_realtime.wav",
      },
    });
    const result = await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "rt_voiceprint_methods_realtime",
        transcript: "this should become a finalized turn from the gateway",
      },
    });

    expect(result.ok).toBe(true);
    expect(result.sessionKey).toBe("live:voiceprint-methods-realtime");
    expect(result.finalizedTurns).toMatchObject([
      {
        transcriptItemId: "rt_voiceprint_methods_realtime",
        speechWindowId: "rt_voiceprint_methods_realtime",
        startMs: 1000,
        endMs: 2400,
        audioArtifactId: "audio_voiceprint_methods_realtime",
        audioPath: "/tmp/audio_voiceprint_methods_realtime.wav",
      },
    ]);
    expect(result.finalizedTurns[0]?.samples).toBeUndefined();
  });

  test("resolves realtime audio artifacts from registered gateway media", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-artifact-"));
    tempDirs.push(dir);
    const mediaId = "voiceprint_methods_realtime_registered.mic";
    const audioPath = writeFinalizedMediaWav(dir, mediaId);
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: ["-e", "process.exit(99)"], timeoutMs: 5_000 },
        ownerEmbeddings: [[1, 0]],
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        expectedModel: sidecarModel,
      },
    );

    const conn = { sessionKey: "live:voiceprint-methods-artifact" };
    await server.call("identity.voiceprint.audio_artifact.register", conn, {
      audioArtifactId: "audio_voiceprint_methods_registered",
      mediaId,
    });
    await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "input_audio_buffer.speech_started",
        item_id: "rt_voiceprint_methods_registered",
        audio_start_ms: 0,
      },
    });
    await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "input_audio_buffer.speech_stopped",
        item_id: "rt_voiceprint_methods_registered",
        audio_end_ms: 1500,
      },
    });
    await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "rt_voiceprint_methods_registered",
        transcript: "registered audio should win",
      },
    });
    const result = await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "live_recording.audio_artifact",
        item_id: "rt_voiceprint_methods_registered",
        audio_artifact_id: "audio_voiceprint_methods_registered",
        audio_path: "/tmp/untrusted-phone-local.wav",
      },
    });

    expect(result.finalizedTurns).toMatchObject([
      {
        transcriptItemId: "rt_voiceprint_methods_registered",
        audioArtifactId: "audio_voiceprint_methods_registered",
        audioPath: realpathSync(audioPath),
      },
    ]);
  });

  test("rejects cross-session realtime events and can reset a realtime buffer", async () => {
    const server = makeMockServer();
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage());
    const conn = { sessionKey: "live:voiceprint-methods-realtime-reset" };

    await expect(
      server.call("identity.voiceprint.realtime_event", { sessionKey: null }, {
        event: { type: "response.created" },
      }),
    ).rejects.toThrow(/Unbound connection/);
    await expect(
      server.call("identity.voiceprint.realtime_event", conn, {
        sessionKey: "live:voiceprint-methods-other",
        event: { type: "response.created" },
      }),
    ).rejects.toThrow(/sessionKey does not match/);

    await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "input_audio_buffer.speech_started",
        item_id: "rt_voiceprint_methods_reset",
        audio_start_ms: 1000,
      },
    });
    const reset = await server.call("identity.voiceprint.realtime_reset", conn, {});
    const afterReset = await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "rt_voiceprint_methods_reset",
        transcript: "this should not find a prior speech window",
      },
    });

    expect(reset).toEqual({
      ok: true,
      sessionKey: "live:voiceprint-methods-realtime-reset",
    });
    expect(afterReset.finalizedTurns).toEqual([]);
    expect(afterReset.pendingTranscripts).toBe(1);
  });

  test("fails closed when live scoring is not configured", async () => {
    const server = makeMockServer();
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage());

    await expect(
      server.call(
        "identity.voiceprint.score_turns",
        { sessionKey: null },
        { turns: [] },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      server.call(
        "identity.voiceprint.score_turns",
        { sessionKey: "live:voiceprint-methods-score" },
        { turns: [] },
      ),
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
  });

  test("does not load owner templates when live scoring consent is denied", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-score-"));
    tempDirs.push(dir);
    const audioPath = join(dir, "owner.wav");
    const scriptPath = join(dir, "sidecar.js");
    writeSineWav(audioPath, 16000, 1800, 0.16);
    writeFileSync(scriptPath, "process.exit(99);", "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerTemplateFile: {
          filePath: join(dir, "missing-owner-template.enc.json"),
          key: makeOwnerTemplateEncryptionKey(),
          expectedKeyRef: "voiceprint-methods-template-key",
        },
        allowedAudioRoots: [dir],
        consent: {
          captureAllowed: false,
          biometricAllowed: false,
          memoryPromotionAllowed: false,
          exportAllowed: false,
        },
        expectedModel: sidecarModel,
      },
    );

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-methods-denied-consent-template" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-methods-denied-consent-template",
            transcriptItemId: "rt_voiceprint_methods_denied_consent_template",
            role: "user",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_voiceprint_methods_denied_consent_template",
            audioPath,
          },
        ],
        createdAt,
      },
    );

    expect(result.status).toBe("skipped");
    expect(result.queued).toBe(0);
    expect(result.states[0]).toMatchObject({
      lifecycle: "skipped",
      skipReason: "consent_denied",
      transcriptItemId: "rt_voiceprint_methods_denied_consent_template",
    });
    expect(storage.snapshot?.().transcriptSpeakerAnnotations).toEqual([]);
  });

  test("scores finalized realtime turns and applies the storage bundle", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-score-"));
    tempDirs.push(dir);
    const audioPath = join(dir, "owner.wav");
    const scriptPath = join(dir, "sidecar.js");
    writeSineWav(audioPath, 16000, 1800, 0.16);
    writeFileSync(scriptPath, `
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: request.requests.map((item) => ({
          id: item.id,
          embedding: [1, 0],
          model: { provider: "custom", modelId: "method-sidecar", version: "1" }
        }))
      }));
    `, "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerTemplateArtifact: makeOwnerTemplateArtifact(),
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        expectedModel: sidecarModel,
      },
    );

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-methods-score" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-methods-score",
            transcriptItemId: "rt_voiceprint_methods_score",
            role: "user",
            text: "owner spoke here",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_voiceprint_methods_score",
            audioPath,
            route: "iphone_mic",
          },
        ],
        consent: {
          captureAllowed: true,
          biometricAllowed: true,
          memoryPromotionAllowed: true,
        },
        createdAt,
        updatedAt: "2026-06-23T00:00:01.000Z",
      },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("scored");
    expect(result.storage?.counts.transcriptSpeakerAnnotations).toBe(1);
    expect(result.states[0]?.lifecycle).toBe("resolved");
    expect(result.states[0]?.transcriptItemId).toBe("rt_voiceprint_methods_score");
    expect(storage.snapshot?.().transcriptSpeakerAnnotations[0]).toMatchObject({
      sessionKey: "live:voiceprint-methods-score",
      transcriptItemId: "rt_voiceprint_methods_score",
      result: "owner_speaking",
    });
    expect(JSON.stringify(result)).not.toContain("\"embedding\"");
  });

  test("scores registered gateway audio artifacts without client audio paths", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-score-"));
    tempDirs.push(dir);
    const mediaId = "voiceprint_methods_score_registered.mic";
    writeFinalizedMediaWav(dir, mediaId);
    const scriptPath = join(dir, "sidecar.js");
    writeFileSync(scriptPath, `
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: request.requests.map((item) => ({
          id: item.id,
          embedding: [1, 0],
          model: { provider: "custom", modelId: "method-sidecar", version: "1" }
        }))
      }));
    `, "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerTemplateArtifact: makeOwnerTemplateArtifact(),
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        expectedModel: sidecarModel,
      },
    );

    await server.call("identity.voiceprint.audio_artifact.register", {
      sessionKey: "live:voiceprint-methods-score-registered",
    }, {
      audioArtifactId: "audio_voiceprint_methods_score_registered",
      mediaId,
    });
    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-methods-score-registered" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-methods-score-registered",
            transcriptItemId: "rt_voiceprint_methods_score_registered",
            role: "user",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_voiceprint_methods_score_registered",
            route: "iphone_mic",
          },
        ],
        createdAt,
      },
    );

    expect(result.status).toBe("scored");
    expect(storage.snapshot?.().transcriptSpeakerAnnotations[0]).toMatchObject({
      sessionKey: "live:voiceprint-methods-score-registered",
      transcriptItemId: "rt_voiceprint_methods_score_registered",
      result: "owner_speaking",
    });
  });

  test("scores registered gateway audio segments with segment-relative request bounds", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-score-"));
    tempDirs.push(dir);
    const mediaId = "voiceprint_methods_score_segment.mic";
    writeFinalizedMediaWav(dir, mediaId);
    const scriptPath = join(dir, "sidecar.js");
    writeFileSync(scriptPath, `
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const item = request.requests[0];
      if (item.startMs !== 500 || item.endMs !== 1500) {
        console.error(JSON.stringify(item));
        process.exit(98);
      }
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: [{
          id: item.id,
          embedding: [1, 0],
          model: { provider: "custom", modelId: "method-sidecar", version: "1" }
        }]
      }));
    `, "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerTemplateArtifact: makeOwnerTemplateArtifact(),
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        expectedModel: sidecarModel,
      },
    );

    await server.call("identity.voiceprint.audio_artifact.register", {
      sessionKey: "live:voiceprint-methods-score-segment",
    }, {
      audioArtifactId: "audio_voiceprint_methods_score_segment",
      mediaId,
      recordingStartMs: 3000,
      recordingEndMs: 4800,
    });
    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-methods-score-segment" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-methods-score-segment",
            transcriptItemId: "rt_voiceprint_methods_score_segment",
            role: "user",
            startMs: 3500,
            endMs: 4500,
            audioArtifactId: "audio_voiceprint_methods_score_segment",
            route: "iphone_mic",
          },
        ],
        createdAt,
      },
    );

    expect(result.status).toBe("scored");
    expect(storage.snapshot?.().transcriptSpeakerAnnotations[0]).toMatchObject({
      sessionKey: "live:voiceprint-methods-score-segment",
      transcriptItemId: "rt_voiceprint_methods_score_segment",
      result: "owner_speaking",
    });
  });

  test("ignores stale score_turns sidecar results after a newer rescore starts", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-score-"));
    tempDirs.push(dir);
    const slowAudioPath = join(dir, "slow-owner.wav");
    const fastAudioPath = join(dir, "fast-owner.wav");
    const scriptPath = join(dir, "sidecar.js");
    writeSineWav(slowAudioPath, 16000, 1800, 0.16);
    writeSineWav(fastAudioPath, 16000, 1800, 0.16);
    writeFileSync(scriptPath, `
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const first = request.requests[0];
      const slow = first.audioPath.includes("slow-owner");
      if (slow) await new Promise((resolve) => setTimeout(resolve, 150));
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: request.requests.map((item) => ({
          id: item.id,
          embedding: slow ? [1, 0] : [0, 1],
          model: { provider: "custom", modelId: "method-sidecar", version: "1" }
        }))
      }));
    `, "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerEmbeddings: [[0, 1]],
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        expectedModel: sidecarModel,
      },
    );

    const slow = server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-methods-stale-score" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-methods-stale-score",
            transcriptItemId: "rt_voiceprint_methods_stale_score",
            role: "user",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_voiceprint_methods_stale_slow",
            audioPath: slowAudioPath,
          },
        ],
        createdAt,
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const fast = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-methods-stale-score" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-methods-stale-score",
            transcriptItemId: "rt_voiceprint_methods_stale_score",
            role: "user",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_voiceprint_methods_stale_fast",
            audioPath: fastAudioPath,
          },
        ],
        createdAt,
      },
    );
    const late = await slow;
    const snapshot = storage.snapshot?.();

    expect(fast.status).toBe("scored");
    expect(late.status).toBe("skipped");
    expect(late.patches).toBe(0);
    expect(snapshot?.transcriptIdentityStates[0]).toMatchObject({
      lifecycle: "resolved",
      transcriptItemId: "rt_voiceprint_methods_stale_score",
      result: "owner_speaking",
    });
    expect(snapshot?.transcriptSpeakerAnnotations).toHaveLength(1);
    expect(snapshot?.transcriptSpeakerAnnotations[0]).toMatchObject({
      transcriptItemId: "rt_voiceprint_methods_stale_score",
      result: "owner_speaking",
      evidenceRefs: [
        {
          artifactId: "audio_voiceprint_methods_stale_fast",
        },
      ],
    });
  });

  test("fails closed when the configured owner template is deleted", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-score-"));
    tempDirs.push(dir);
    const audioPath = join(dir, "owner.wav");
    const scriptPath = join(dir, "sidecar.js");
    const artifact = makeOwnerTemplateArtifact();
    writeSineWav(audioPath, 16000, 1800, 0.16);
    writeFileSync(scriptPath, "process.exit(99);", "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerTemplateArtifact: {
          ...artifact,
          template: tombstoneVoiceprintTemplate(
            artifact.template,
            "2026-06-23T00:00:02.000Z",
          ),
        },
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        expectedModel: sidecarModel,
      },
    );

    await expect(
      server.call(
        "identity.voiceprint.score_turns",
        { sessionKey: "live:voiceprint-methods-deleted-template" },
        {
          turns: [
            {
              sessionKey: "live:voiceprint-methods-deleted-template",
              transcriptItemId: "rt_voiceprint_methods_deleted_template",
              role: "user",
              startMs: 0,
              endMs: 1500,
              audioArtifactId: "audio_voiceprint_methods_deleted_template",
              audioPath,
            },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
    expect(storage.snapshot?.()).toMatchObject({
      transcriptIdentityStates: [],
      transcriptSpeakerAnnotations: [],
      speakerTurnTags: [],
      identitySignals: [],
      eventParticipations: [],
    });
  });

  test("scores finalized realtime turns from an encrypted owner template file", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-score-"));
    tempDirs.push(dir);
    const audioPath = join(dir, "owner.wav");
    const scriptPath = join(dir, "sidecar.js");
    const templatePath = join(dir, "owner-template.enc.json");
    const key = makeOwnerTemplateEncryptionKey();
    writeSineWav(audioPath, 16000, 1800, 0.16);
    writeEncryptedVoiceprintTemplateArtifact({
      filePath: templatePath,
      artifact: makeOwnerTemplateArtifact(),
      key,
      updatedAt: createdAt,
    });
    writeFileSync(scriptPath, `
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: request.requests.map((item) => ({
          id: item.id,
          embedding: [1, 0],
          model: { provider: "custom", modelId: "method-sidecar", version: "1" }
        }))
      }));
    `, "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerTemplateFile: {
          filePath: templatePath,
          key,
          expectedKeyRef: key.keyRef,
        },
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        expectedModel: sidecarModel,
      },
    );

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-methods-template-file" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-methods-template-file",
            transcriptItemId: "rt_voiceprint_methods_template_file",
            role: "user",
            text: "owner spoke here",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_voiceprint_methods_template_file",
            audioPath,
            route: "iphone_mic",
          },
        ],
        createdAt,
      },
    );

    expect(result.status).toBe("scored");
    expect(storage.snapshot?.().transcriptSpeakerAnnotations[0]).toMatchObject({
      sessionKey: "live:voiceprint-methods-template-file",
      transcriptItemId: "rt_voiceprint_methods_template_file",
      result: "owner_speaking",
    });
    expect(JSON.stringify(result)).not.toContain("\"embedding\"");
  });

  test("scores finalized realtime turns from an encrypted owner template file source", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-score-"));
    tempDirs.push(dir);
    const audioPath = join(dir, "owner.wav");
    const scriptPath = join(dir, "sidecar.js");
    const templatePath = join(dir, "owner-template.enc.json");
    const keyPath = join(dir, "owner-template.key.json");
    const key = makeOwnerTemplateEncryptionKey();
    writeSineWav(audioPath, 16000, 1800, 0.16);
    writeVoiceprintTemplateEncryptionKeyFile({
      filePath: keyPath,
      key,
      createdAt,
    });
    writeEncryptedVoiceprintTemplateArtifact({
      filePath: templatePath,
      artifact: makeOwnerTemplateArtifact(),
      key,
      updatedAt: createdAt,
    });
    writeFileSync(scriptPath, `
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: request.requests.map((item) => ({
          id: item.id,
          embedding: [1, 0],
          model: { provider: "custom", modelId: "method-sidecar", version: "1" }
        }))
      }));
    `, "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerTemplateFileSource: {
          filePath: templatePath,
          keyPath,
          keyRef: key.keyRef,
          createKeyIfMissing: false,
        },
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        expectedModel: sidecarModel,
      },
    );

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-methods-template-source" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-methods-template-source",
            transcriptItemId: "rt_voiceprint_methods_template_source",
            role: "user",
            text: "owner spoke here",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_voiceprint_methods_template_source",
            audioPath,
            route: "iphone_mic",
          },
        ],
        createdAt,
      },
    );

    expect(result.status).toBe("scored");
    expect(storage.snapshot?.().transcriptSpeakerAnnotations[0]).toMatchObject({
      sessionKey: "live:voiceprint-methods-template-source",
      transcriptItemId: "rt_voiceprint_methods_template_source",
      result: "owner_speaking",
    });
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(JSON.stringify(result)).not.toContain("\"rawKey\"");
  });

  test("fails closed when the owner template model differs from the scorer model", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-score-"));
    tempDirs.push(dir);
    const audioPath = join(dir, "owner.wav");
    const scriptPath = join(dir, "sidecar.js");
    writeSineWav(audioPath, 16000, 1800, 0.16);
    writeFileSync(scriptPath, "process.exit(99);", "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerTemplateArtifact: makeOwnerTemplateArtifact(),
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        expectedModel: { provider: "custom", modelId: "different-sidecar", version: "1" },
      },
    );

    await expect(
      server.call(
        "identity.voiceprint.score_turns",
        { sessionKey: "live:voiceprint-methods-model-mismatch" },
        {
          turns: [
            {
              sessionKey: "live:voiceprint-methods-model-mismatch",
              transcriptItemId: "rt_voiceprint_methods_model_mismatch",
              role: "user",
              startMs: 0,
              endMs: 1500,
              audioArtifactId: "audio_voiceprint_methods_model_mismatch",
              audioPath,
            },
          ],
        },
      ),
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
    expect(storage.snapshot?.().transcriptIdentityStates).toEqual([]);
  });

  test("keeps live scoring consent server-side", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-score-"));
    tempDirs.push(dir);
    const audioPath = join(dir, "malformed.wav");
    const scriptPath = join(dir, "sidecar.js");
    writeFileSync(audioPath, "not a wav", "utf8");
    writeFileSync(scriptPath, "process.exit(99);", "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerEmbeddings: [[1, 0]],
        allowedAudioRoots: [dir],
        expectedModel: sidecarModel,
      },
    );

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-methods-score-consent" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-methods-score-consent",
            transcriptItemId: "rt_voiceprint_methods_score_consent",
            role: "user",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_voiceprint_methods_score_consent",
            audioPath,
          },
        ],
        consent: {
          captureAllowed: true,
          biometricAllowed: true,
          memoryPromotionAllowed: true,
          templateLearningAllowed: true,
        },
      },
    );

    expect(result.status).toBe("skipped");
    expect(result.queued).toBe(0);
    expect(result.states[0]).toMatchObject({
      lifecycle: "skipped",
      transcriptItemId: "rt_voiceprint_methods_score_consent",
      skipReason: "consent_denied",
    });
    expect(storage.snapshot?.().transcriptSpeakerAnnotations).toEqual([]);
  });

  test("does not let clients relax live scoring quality thresholds", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-score-"));
    tempDirs.push(dir);
    const audioPath = join(dir, "short.wav");
    const scriptPath = join(dir, "sidecar.js");
    writeSineWav(audioPath, 16000, 500, 0.16);
    writeFileSync(scriptPath, `
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: request.requests.map((item) => ({
          id: item.id,
          embedding: [1, 0],
          model: { provider: "custom", modelId: "method-sidecar", version: "1" }
        }))
      }));
    `, "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerEmbeddings: [[1, 0]],
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        expectedModel: sidecarModel,
      },
    );

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-methods-score-quality" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-methods-score-quality",
            transcriptItemId: "rt_voiceprint_methods_score_quality",
            role: "user",
            startMs: 0,
            endMs: 500,
            audioArtifactId: "audio_voiceprint_methods_score_quality",
            audioPath,
          },
        ],
        qualityThresholds: {
          minDurationMs: 1,
          targetDurationMs: 1,
          minRms: 0,
          targetRms: 0,
          minPeak: 0,
          minDynamicRange: 0,
        },
      },
    );

    expect(result.status).toBe("skipped");
    expect(result.queued).toBe(0);
    expect(result.states[0]).toMatchObject({
      lifecycle: "skipped",
      transcriptItemId: "rt_voiceprint_methods_score_quality",
      skipReason: "quality_rejected",
    });
    expect(storage.snapshot?.().transcriptSpeakerAnnotations).toEqual([]);
  });

  test("does not let clients mark template learning as reviewed", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-score-"));
    tempDirs.push(dir);
    const audioPath = join(dir, "owner.wav");
    const scriptPath = join(dir, "sidecar.js");
    writeSineWav(audioPath, 16000, 1800, 0.16);
    writeFileSync(scriptPath, `
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: request.requests.map((item) => ({
          id: item.id,
          embedding: [1, 0],
          model: { provider: "custom", modelId: "method-sidecar", version: "1" }
        }))
      }));
    `, "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerEmbeddings: [[1, 0]],
        allowedAudioRoots: [dir],
        consent: { ...trustedProcessingConsent, templateLearningAllowed: true },
        expectedModel: sidecarModel,
      },
    );

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-methods-score-template" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-methods-score-template",
            transcriptItemId: "rt_voiceprint_methods_score_template",
            role: "user",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_voiceprint_methods_score_template",
            audioPath,
          },
        ],
        templateLearningReviewed: true,
      },
    );

    expect(result.status).toBe("scored");
    expect(storage.snapshot?.().transcriptSpeakerAnnotations[0]?.allowedUses).toMatchObject({
      templateLearning: false,
    });
  });

  test("rejects live scoring audio outside configured roots", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-score-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "voiceprint-methods-outside-"));
    tempDirs.push(dir, outsideDir);
    const audioPath = join(outsideDir, "owner.wav");
    const scriptPath = join(dir, "sidecar.js");
    writeSineWav(audioPath, 16000, 1800, 0.16);
    writeFileSync(scriptPath, "process.exit(99);", "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerEmbeddings: [[1, 0]],
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        expectedModel: sidecarModel,
      },
    );

    await expect(
      server.call(
        "identity.voiceprint.score_turns",
        { sessionKey: "live:voiceprint-methods-score-root" },
        {
          turns: [
            {
              sessionKey: "live:voiceprint-methods-score-root",
              transcriptItemId: "rt_voiceprint_methods_score_root",
              role: "user",
              startMs: 0,
              endMs: 1500,
              audioArtifactId: "audio_voiceprint_methods_score_root",
              audioPath,
            },
          ],
          consent: {
            captureAllowed: true,
            biometricAllowed: true,
            memoryPromotionAllowed: false,
          },
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(storage.snapshot?.().transcriptIdentityStates).toEqual([]);
  });

  test("rejects live scoring audio symlinks that resolve outside configured roots", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-score-"));
    const outsideDir = mkdtempSync(join(tmpdir(), "voiceprint-methods-outside-"));
    tempDirs.push(dir, outsideDir);
    const outsideAudioPath = join(outsideDir, "owner.wav");
    const symlinkAudioPath = join(dir, "linked-owner.wav");
    const scriptPath = join(dir, "sidecar.js");
    writeSineWav(outsideAudioPath, 16000, 1800, 0.16);
    symlinkSync(outsideAudioPath, symlinkAudioPath);
    writeFileSync(scriptPath, "process.exit(99);", "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerEmbeddings: [[1, 0]],
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        expectedModel: sidecarModel,
      },
    );

    await expect(
      server.call(
        "identity.voiceprint.score_turns",
        { sessionKey: "live:voiceprint-methods-score-symlink" },
        {
          turns: [
            {
              sessionKey: "live:voiceprint-methods-score-symlink",
              transcriptItemId: "rt_voiceprint_methods_score_symlink",
              role: "user",
              startMs: 0,
              endMs: 1500,
              audioArtifactId: "audio_voiceprint_methods_score_symlink",
              audioPath: symlinkAudioPath,
            },
          ],
          consent: {
            captureAllowed: true,
            biometricAllowed: true,
            memoryPromotionAllowed: false,
          },
        },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(storage.snapshot?.().transcriptIdentityStates).toEqual([]);
  });

  test("skips malformed score turns before reading audio files", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-score-"));
    tempDirs.push(dir);
    const audioPath = join(dir, "malformed.wav");
    const scriptPath = join(dir, "sidecar.js");
    writeFileSync(audioPath, "not a wav", "utf8");
    writeFileSync(scriptPath, "process.exit(99);", "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerEmbeddings: [[1, 0]],
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        expectedModel: sidecarModel,
      },
    );

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-methods-score-malformed" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-methods-score-malformed",
            transcriptItemId: "rt_voiceprint_methods_score_malformed",
            role: "user",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "   ",
            audioPath,
          },
        ],
        consent: {
          captureAllowed: true,
          biometricAllowed: true,
          memoryPromotionAllowed: false,
        },
      },
    );

    expect(result.status).toBe("skipped");
    expect(result.queued).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.states[0]).toMatchObject({
      lifecycle: "skipped",
      transcriptItemId: "rt_voiceprint_methods_score_malformed",
      skipReason: "missing_audio_artifact",
    });
    expect(storage.snapshot?.().transcriptIdentityStates[0]).toMatchObject({
      lifecycle: "skipped",
      transcriptItemId: "rt_voiceprint_methods_score_malformed",
      skipReason: "missing_audio_artifact",
    });
  });

  test("persists voiceprint storage bundles to disk", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-"));
    tempDirs.push(dir);
    const filePath = join(dir, "state", "voiceprint-storage.json");
    registerVoiceprintMethods(
      server as any,
      createFileVoiceprintStorage({ filePath }),
    );
    const bundle = buildVoiceprintStorageBundle({
      states: [
        buildVoiceprintTranscriptIdentityState({
          sessionKey: "live:voiceprint-methods-file",
          transcriptItemId: "rt_voiceprint_methods_file",
          createdAt,
        }),
      ],
      createdAt,
    });

    const result = await server.call(
      "identity.voiceprint.apply_bundle",
      { sessionKey: "live:voiceprint-methods-file" },
      { bundle },
    );
    const reloaded = createFileVoiceprintStorage({ filePath }).snapshot?.();

    expect(result.counts.transcriptIdentityStates).toBe(1);
    expect(existsSync(filePath)).toBe(true);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(reloaded?.transcriptIdentityStates[0]?.transcriptItemId).toBe(
      "rt_voiceprint_methods_file",
    );

    chmodSync(filePath, 0o644);
    await server.call(
      "identity.voiceprint.apply_bundle",
      { sessionKey: "live:voiceprint-methods-file" },
      {
        bundle: buildVoiceprintStorageBundle({
          states: [
            buildVoiceprintTranscriptIdentityState({
              sessionKey: "live:voiceprint-methods-file",
              transcriptItemId: "rt_voiceprint_methods_file_rewrite",
              createdAt,
            }),
          ],
          createdAt,
        }),
      },
    );

    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  test("reports corrupt durable storage as an internal storage error", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-"));
    tempDirs.push(dir);
    const filePath = join(dir, "voiceprint-storage.json");
    writeFileSync(filePath, JSON.stringify({ version: 1, snapshot: {} }), "utf-8");
    registerVoiceprintMethods(
      server as any,
      createFileVoiceprintStorage({ filePath }),
    );
    const bundle = buildVoiceprintStorageBundle({
      states: [
        buildVoiceprintTranscriptIdentityState({
          sessionKey: "live:voiceprint-methods-corrupt",
          transcriptItemId: "rt_voiceprint_methods_corrupt",
          createdAt,
        }),
      ],
      createdAt,
    });

    await expect(
      server.call(
        "identity.voiceprint.apply_bundle",
        { sessionKey: "live:voiceprint-methods-corrupt" },
        { bundle },
      ),
    ).rejects.toMatchObject({ code: "INTERNAL_ERROR" });
  });

  test("scores a client-supplied embedding without spawning the sidecar when opted in", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-client-embed-"));
    tempDirs.push(dir);
    const audioPath = join(dir, "owner.wav");
    writeSineWav(audioPath, 16000, 1800, 0.16);
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        // A sidecar that fails if ever spawned: the client-embedding path must
        // resolve without touching it.
        sidecar: {
          command: process.execPath,
          args: ["-e", "process.stderr.write('sidecar must not spawn'); process.exit(99)"],
          timeoutMs: 5_000,
        },
        ownerEmbeddings: [[1, 0]],
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        expectedModel: sidecarModel,
        acceptClientEmbeddings: true,
      },
    );

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-methods-client-embed" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-methods-client-embed",
            transcriptItemId: "rt_voiceprint_methods_client_embed",
            role: "user",
            text: "owner spoke here",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_voiceprint_methods_client_embed",
            audioPath,
            route: "iphone_mic",
            sampleEmbedding: [1, 0],
            sampleEmbeddingModel: sidecarModel,
          },
        ],
        consent: {
          captureAllowed: true,
          biometricAllowed: true,
          memoryPromotionAllowed: true,
        },
        createdAt,
        updatedAt: "2026-06-23T00:00:01.000Z",
      },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("scored");
    expect(result.states[0]?.lifecycle).toBe("resolved");
    expect(storage.snapshot?.().transcriptSpeakerAnnotations[0]).toMatchObject({
      transcriptItemId: "rt_voiceprint_methods_client_embed",
      result: "owner_speaking",
    });
    // The server never echoes or stores the client biometric vector back out.
    expect(JSON.stringify(result)).not.toContain("\"sampleEmbedding\"");
  });

  test("ignores a client embedding when acceptClientEmbeddings is off (uses the audio/sidecar path)", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-client-embed-off-"));
    tempDirs.push(dir);
    const audioPath = join(dir, "owner.wav");
    const scriptPath = join(dir, "sidecar.js");
    writeSineWav(audioPath, 16000, 1800, 0.16);
    // Sidecar returns an impostor embedding orthogonal to the owner template,
    // so if it is used the turn resolves to unknown (NOT owner_speaking). This
    // proves the client's [1,0] vector was NOT trusted.
    writeFileSync(scriptPath, `
      const chunks = [];
      for await (const chunk of process.stdin) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      process.stdout.write(JSON.stringify({
        version: 1,
        responses: request.requests.map((item) => ({
          id: item.id,
          embedding: [0, 1],
          model: { provider: "custom", modelId: "method-sidecar", version: "1" }
        }))
      }));
    `, "utf8");
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 },
        ownerEmbeddings: [[1, 0]],
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        expectedModel: sidecarModel,
        // Opt-in OFF (default).
      },
    );

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-methods-client-embed-off" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-methods-client-embed-off",
            transcriptItemId: "rt_voiceprint_methods_client_embed_off",
            role: "user",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_voiceprint_methods_client_embed_off",
            audioPath,
            sampleEmbedding: [1, 0],
            sampleEmbeddingModel: sidecarModel,
          },
        ],
        consent: {
          captureAllowed: true,
          biometricAllowed: true,
          memoryPromotionAllowed: true,
        },
        createdAt,
        updatedAt: "2026-06-23T00:00:01.000Z",
      },
    );

    expect(result.status).toBe("scored");
    // The sidecar (impostor embedding) decided the result -> the client vector
    // was ignored; the turn is not resolved as the owner.
    expect(result.states[0]?.lifecycle).not.toBe("resolved");
    expect(result.states[0]?.result).not.toBe("owner_speaking");
  });

  test("enforces the model match from the owner template when expected_model is unconfigured", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-methods-client-embed-notmodel-"));
    tempDirs.push(dir);
    const audioPath = join(dir, "owner.wav");
    writeSineWav(audioPath, 16000, 1800, 0.16);
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      {
        sidecar: {
          command: process.execPath,
          args: ["-e", "process.stderr.write('sidecar must not spawn'); process.exit(99)"],
          timeoutMs: 5_000,
        },
        // Owner template carries model = sidecarModel. Crucially, expected_model
        // is NOT configured here — the model match must still be enforced from
        // the template model so a mismatched client vector cannot be accepted.
        ownerTemplateArtifact: makeOwnerTemplateArtifact(),
        allowedAudioRoots: [dir],
        consent: trustedProcessingConsent,
        acceptClientEmbeddings: true,
      },
    );

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "live:voiceprint-methods-client-embed-notmodel" },
      {
        turns: [
          {
            sessionKey: "live:voiceprint-methods-client-embed-notmodel",
            transcriptItemId: "rt_voiceprint_methods_client_embed_notmodel",
            role: "user",
            text: "owner spoke here",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_voiceprint_methods_client_embed_notmodel",
            audioPath,
            route: "iphone_mic",
            // Vector geometrically aligned with the owner template [1,0], but
            // tagged with a DIFFERENT model version. Must be rejected, not scored.
            sampleEmbedding: [1, 0],
            sampleEmbeddingModel: { ...sidecarModel, version: "2" },
          },
        ],
        consent: {
          captureAllowed: true,
          biometricAllowed: true,
          memoryPromotionAllowed: true,
        },
        createdAt,
        updatedAt: "2026-06-23T00:00:01.000Z",
      },
    );

    // The mismatched client vector is rejected (skipped), never resolved as owner.
    expect(result.states[0]?.lifecycle).not.toBe("resolved");
    expect(result.states[0]?.result).not.toBe("owner_speaking");
    expect(result.states[0]?.skipReason).toBe("client_embedding_rejected");
  });
});

function makeOwnerTemplateArtifact(
  embeddings: number[][] = [[1, 0], [0.99, 0.01]],
): VoiceprintTemplateArtifact {
  return buildVoiceprintTemplateArtifact({
    model: sidecarModel,
    sources: embeddings.map((embedding, index) => ({
      artifactId: `owner_enrollment_${index + 1}`,
      embedding,
      speechMs: 1500,
      route: "iphone_mic",
      qualityStatus: "accepted",
    })),
    storage: {
      templateUri: "local-voiceprint://owner/methods-template.enc",
      encrypted: true,
      localOnly: true,
      keyRef: "voiceprint-methods-template-key",
    },
    createdAt,
    minSpeechMs: 1000,
  });
}

function makeOwnerTemplateEncryptionKey(): VoiceprintTemplateEncryptionKey {
  return {
    keyRef: "voiceprint-methods-template-key",
    rawKey: Buffer.alloc(32, 7),
  };
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

function writeFinalizedMediaWav(root: string, mediaId: string): string {
  const dayDir = join(root, "2026-06-24");
  mkdirSync(dayDir, { recursive: true });
  const audioPath = join(dayDir, `${mediaId}.wav`);
  writeSineWav(audioPath, 16000, 1800, 0.16);
  writeFileSync(
    join(dayDir, `${mediaId}.json`),
    JSON.stringify({
      mime: "audio/pcm16;rate=16000",
      captured_start_iso: createdAt,
      locked: false,
      duration_ms: 1800,
      sha256: "test-sha256",
      final_iso: createdAt,
    }, null, 2),
    "utf8",
  );
  return audioPath;
}

function writeSineWav(
  path: string,
  sampleRate: number,
  durationMs: number,
  amplitude: number,
): void {
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
    const value = Math.round(Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude * 32767);
    buffer.writeInt16LE(value, 44 + i * 2);
  }
  writeFileSync(path, buffer);
}
