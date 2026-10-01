import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  assertVoiceprintModelIntegrity,
  classifyVoiceprintModelMismatch,
  isReferenceVoiceprintModel,
  sha256OfFile,
  sidecarEnvSelectsReferenceBackend,
  readEncryptedVoiceprintTemplateArtifact,
  voiceprintTemplateFileRefFromSource,
} from "../src/identity/voiceprint/index.js";
import {
  assertDiscriminativeVoiceprintConfig,
  createInMemoryVoiceprintStorage,
  registerVoiceprintMethods,
  resolveVoiceprintLiveScoringConfigFromConfig,
  type VoiceprintLiveScoringConfig,
} from "../src/gateway/voiceprint-methods.js";
import { createInMemoryVoiceprintLifecycle } from "../src/gateway/voiceprint-lifecycle.js";

// A5 — Voiceprint model lifecycle safety.
//
//   1. Reference-backend production guard (require_discriminative_model)
//   2. Model integrity pin (model_sha256)
//   3. Model-version mismatch handling (reembed / stale -> needs_reenrollment)
//
// Everything is ADDITIVE + OFF by default; these tests assert the guard/pin/backfill
// only activate when configured, and that default (dev/test) behavior is unchanged.

const createdAt = "2026-06-23T00:00:00.000Z";
const consent = {
  captureAllowed: true,
  biometricAllowed: true,
  memoryPromotionAllowed: true,
  exportAllowed: false,
};
const referenceModel = { provider: "reference" as const, modelId: "reference-fbank-v0", version: "0" };

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

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

/**
 * Stub sidecar whose emitted model tag is controllable via env `SIDECAR_MODEL_ID`
 * / `SIDECAR_MODEL_VERSION` (defaults to enroll-sidecar/1). speechMs from the
 * window so the 30s enrollment gate is drivable with a couple of clips.
 */
function writeModelSidecar(dir: string): string {
  const scriptPath = join(dir, "sidecar.js");
  writeFileSync(
    scriptPath,
    `
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const modelId = process.env.SIDECAR_MODEL_ID || "enroll-sidecar";
    const version = process.env.SIDECAR_MODEL_VERSION || "1";
    const provider = process.env.SIDECAR_MODEL_PROVIDER || "custom";
    process.stdout.write(JSON.stringify({
      version: 1,
      responses: request.requests.map((item) => {
        const windowMs = (item.endMs !== undefined && item.startMs !== undefined)
          ? item.endMs - item.startMs
          : 16000;
        return {
          id: item.id,
          embedding: [1, 0],
          model: { provider, modelId, version },
          audio: { speechMs: windowMs },
        };
      }),
    }));
    `,
    "utf8",
  );
  return scriptPath;
}

function writeSineWav(path: string, sampleRate: number, durationMs: number, amplitude: number): void {
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

function writeGoodWav(dir: string, name: string): string {
  const path = join(dir, name);
  writeSineWav(path, 16000, 1500, 0.16);
  return path;
}

function makeScoringConfig(
  dir: string,
  scriptPath: string,
  overrides: Partial<VoiceprintLiveScoringConfig> = {},
  sidecarEnv?: Record<string, string>,
): VoiceprintLiveScoringConfig {
  return {
    sidecar: {
      command: process.execPath,
      args: [scriptPath],
      timeoutMs: 10_000,
      ...(sidecarEnv ? { env: sidecarEnv } : {}),
    },
    ownerTemplateFileSource: {
      filePath: join(dir, "owner-template.enc.json"),
      keyPath: join(dir, "owner-template.key.json"),
      keyRef: "voiceprint-model-lifecycle-key",
      createKeyIfMissing: true,
    },
    allowedAudioRoots: [dir],
    consent,
    expectedModel: { provider: "custom", modelId: "enroll-sidecar", version: "1" },
    ...overrides,
  };
}

async function enrollOwner(
  server: ReturnType<typeof makeMockServer>,
  conn: { sessionKey: string },
  dir: string,
): Promise<void> {
  const clipA = writeGoodWav(dir, "clipA.wav");
  const clipB = writeGoodWav(dir, "clipB.wav");
  const enroll = await server.call("identity.voiceprint.enroll_owner", conn, {
    sources: [
      { audioPath: clipA, startMs: 0, endMs: 20000 },
      { audioPath: clipB, startMs: 0, endMs: 20000 },
    ],
    consent,
  });
  expect(enroll.status).toBe("accepted");
}

// ── 1. Reference-backend production guard ────────────────────────────────────

describe("A5 reference-backend production guard (require_discriminative_model)", () => {
  const base = (dir: string): any => ({
    enabled: true,
    sidecar: { command: "/usr/bin/env", args: ["python3", "embed.py"], env: { VOICEPRINT_BACKEND: "onnx" } },
    owner_template: {
      file_path: join(dir, "owner-template.enc.json"),
      key_path: join(dir, "owner-template.key.json"),
    },
    allowed_audio_roots: [dir],
    consent: { capture_allowed: true, biometric_allowed: true },
  });

  test("guard OFF (default): a reference-backed config still resolves for tests", () => {
    const dir = mkdtempSync(join(tmpdir(), "vp-guard-off-"));
    tempDirs.push(dir);
    const scoring = resolveVoiceprintLiveScoringConfigFromConfig({
      voiceprint: {
        live_scoring: {
          ...base(dir),
          dev_reference_backend: true,
          sidecar: undefined,
        },
      },
    } as any);
    expect(scoring).toBeDefined();
    expect(scoring?.requireDiscriminativeModel).toBe(false);
  });

  test("guard ON: dev_reference_backend true is rejected at config resolve", () => {
    const dir = mkdtempSync(join(tmpdir(), "vp-guard-dev-"));
    tempDirs.push(dir);
    expect(() =>
      resolveVoiceprintLiveScoringConfigFromConfig({
        voiceprint: {
          live_scoring: {
            ...base(dir),
            sidecar: undefined,
            dev_reference_backend: true,
            require_discriminative_model: true,
          },
        },
      } as any),
    ).toThrow(/dev_reference_backend/);
  });

  test("guard ON: a sidecar env selecting VOICEPRINT_BACKEND=reference is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "vp-guard-env-"));
    tempDirs.push(dir);
    expect(() =>
      resolveVoiceprintLiveScoringConfigFromConfig({
        voiceprint: {
          live_scoring: {
            ...base(dir),
            sidecar: {
              command: "/usr/bin/env",
              args: ["python3", "embed.py"],
              env: { VOICEPRINT_BACKEND: "reference" },
            },
            require_discriminative_model: true,
          },
        },
      } as any),
    ).toThrow(/VOICEPRINT_BACKEND=reference/);
  });

  test("guard ON: a reference-tagged expected_model is rejected", () => {
    const dir = mkdtempSync(join(tmpdir(), "vp-guard-expected-"));
    tempDirs.push(dir);
    expect(() =>
      resolveVoiceprintLiveScoringConfigFromConfig({
        voiceprint: {
          live_scoring: {
            ...base(dir),
            require_discriminative_model: true,
            expected_model: { provider: "reference", model_id: "reference-fbank-v0", version: "0" },
          },
        },
      } as any),
    ).toThrow(/reference/);
  });

  test("guard ON: a discriminative (onnx) config resolves cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "vp-guard-ok-"));
    tempDirs.push(dir);
    const scoring = resolveVoiceprintLiveScoringConfigFromConfig({
      voiceprint: {
        live_scoring: {
          ...base(dir),
          require_discriminative_model: true,
          expected_model: { provider: "sherpa-onnx", model_id: "cam++", version: "v1" },
        },
      },
    } as any);
    expect(scoring?.requireDiscriminativeModel).toBe(true);
  });

  test("guard ON: scoring REFUSES a reference-tagged owner template", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "vp-guard-score-"));
    tempDirs.push(dir);
    const scriptPath = writeModelSidecar(dir);
    // Owner template enrolled (with the guard OFF) using the reference model tag.
    const enrollScoring = makeScoringConfig(
      dir,
      scriptPath,
      { expectedModel: referenceModel },
      { SIDECAR_MODEL_PROVIDER: "reference", SIDECAR_MODEL_ID: "reference-fbank-v0", SIDECAR_MODEL_VERSION: "0" },
    );
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, enrollScoring);
    const conn = { sessionKey: "live:vp-guard-score" };
    await enrollOwner(server, conn, dir);

    // Now register a SECOND gateway with the guard ON, pointed at the same template.
    const guarded = makeMockServer();
    const guardedScoring = makeScoringConfig(
      dir,
      scriptPath,
      { expectedModel: referenceModel, requireDiscriminativeModel: true },
      { SIDECAR_MODEL_PROVIDER: "reference", SIDECAR_MODEL_ID: "reference-fbank-v0", SIDECAR_MODEL_VERSION: "0" },
    );
    registerVoiceprintMethods(guarded as any, createInMemoryVoiceprintStorage(), undefined, guardedScoring);
    const ownerAudio = writeGoodWav(dir, "owner-turn.wav");
    await expect(
      guarded.call("identity.voiceprint.score_turns", conn, {
        turns: [
          {
            transcriptItemId: "rt_guard_ref",
            role: "user",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_guard_ref",
            audioPath: ownerAudio,
          },
        ],
        consent,
        createdAt,
      }),
    ).rejects.toThrow(/non-discriminative reference model/);
  });
});

// ── 2. Model integrity pin ───────────────────────────────────────────────────

describe("A5 model integrity pin (model_sha256)", () => {
  const base = (dir: string): any => ({
    enabled: true,
    sidecar: { command: "/usr/bin/env", args: ["python3", "embed.py"], env: { VOICEPRINT_BACKEND: "onnx" } },
    owner_template: {
      file_path: join(dir, "owner-template.enc.json"),
      key_path: join(dir, "owner-template.key.json"),
    },
    allowed_audio_roots: [dir],
    consent: { capture_allowed: true, biometric_allowed: true },
  });

  test("no pin configured: config resolves with no integrity pin", () => {
    const dir = mkdtempSync(join(tmpdir(), "vp-pin-none-"));
    tempDirs.push(dir);
    const scoring = resolveVoiceprintLiveScoringConfigFromConfig({
      voiceprint: { live_scoring: base(dir) },
    } as any);
    expect(scoring?.modelIntegrityPin).toBeUndefined();
  });

  test("matching hash: config resolves and records the pin", () => {
    const dir = mkdtempSync(join(tmpdir(), "vp-pin-match-"));
    tempDirs.push(dir);
    const modelPath = join(dir, "model.onnx");
    writeFileSync(modelPath, "fake-model-bytes");
    const digest = createHash("sha256").update("fake-model-bytes").digest("hex");
    const scoring = resolveVoiceprintLiveScoringConfigFromConfig({
      voiceprint: {
        live_scoring: { ...base(dir), model_path: modelPath, model_sha256: digest },
      },
    } as any);
    expect(scoring?.modelIntegrityPin).toEqual({ modelPath, sha256: digest });
  });

  test("mismatched hash: config resolve is REFUSED", () => {
    const dir = mkdtempSync(join(tmpdir(), "vp-pin-mismatch-"));
    tempDirs.push(dir);
    const modelPath = join(dir, "model.onnx");
    writeFileSync(modelPath, "actual-bytes");
    const wrong = createHash("sha256").update("different-bytes").digest("hex");
    expect(() =>
      resolveVoiceprintLiveScoringConfigFromConfig({
        voiceprint: {
          live_scoring: { ...base(dir), model_path: modelPath, model_sha256: wrong },
        },
      } as any),
    ).toThrow(/integrity check FAILED/);
  });

  test("model_sha256 set but no model file resolvable: refused", () => {
    const dir = mkdtempSync(join(tmpdir(), "vp-pin-nopath-"));
    tempDirs.push(dir);
    const cfg = base(dir);
    delete cfg.sidecar.env.VOICEPRINT_MODEL;
    expect(() =>
      resolveVoiceprintLiveScoringConfigFromConfig({
        voiceprint: {
          live_scoring: { ...cfg, model_sha256: "a".repeat(64) },
        },
      } as any),
    ).toThrow(/no model file is resolvable/);
  });

  test("assertVoiceprintModelIntegrity: direct match passes, mismatch throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "vp-pin-direct-"));
    tempDirs.push(dir);
    const modelPath = join(dir, "m.bin");
    writeFileSync(modelPath, "hello");
    const digest = sha256OfFile(modelPath);
    expect(() => assertVoiceprintModelIntegrity({ modelPath, sha256: digest })).not.toThrow();
    expect(() =>
      assertVoiceprintModelIntegrity({ modelPath, sha256: "b".repeat(64) }),
    ).toThrow(/integrity check FAILED/);
  });
});

// ── 3. Model-version mismatch handling ───────────────────────────────────────

describe("A5 model-version mismatch handling", () => {
  test("owner template v1 + scorer v2 -> score_turns returns needs_reenrollment (no silent score)", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "vp-mismatch-"));
    tempDirs.push(dir);
    const scriptPath = writeModelSidecar(dir);
    // Enroll with model v1.
    const enrollScoring = makeScoringConfig(dir, scriptPath, {
      expectedModel: { provider: "custom", modelId: "enroll-sidecar", version: "1" },
    });
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, enrollScoring);
    const conn = { sessionKey: "live:vp-mismatch" };
    await enrollOwner(server, conn, dir);

    // Now score with a v2 scorer against the v1 template.
    const scorer = makeMockServer();
    const scorerScoring = makeScoringConfig(dir, scriptPath, {
      expectedModel: { provider: "custom", modelId: "enroll-sidecar", version: "2" },
    });
    registerVoiceprintMethods(scorer as any, createInMemoryVoiceprintStorage(), undefined, scorerScoring);
    const ownerAudio = writeGoodWav(dir, "owner-turn.wav");
    await expect(
      scorer.call("identity.voiceprint.score_turns", conn, {
        turns: [
          {
            transcriptItemId: "rt_mismatch",
            role: "user",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_mismatch",
            audioPath: ownerAudio,
          },
        ],
        consent,
        createdAt,
      }),
    ).rejects.toThrow(/needs_reenrollment/);
  });

  test("reembed_owner_template with retained source re-embeds to the current model and then resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vp-reembed-"));
    tempDirs.push(dir);
    const scriptPath = writeModelSidecar(dir);
    // Enroll with model v1.
    const enrollServer = makeMockServer();
    const enrollScoring = makeScoringConfig(dir, scriptPath, {
      expectedModel: { provider: "custom", modelId: "enroll-sidecar", version: "1" },
    });
    registerVoiceprintMethods(enrollServer as any, createInMemoryVoiceprintStorage(), undefined, enrollScoring);
    const conn = { sessionKey: "live:vp-reembed" };
    await enrollOwner(enrollServer, conn, dir);

    // A v2 scorer/backfill gateway. Its sidecar emits model v2.
    const scriptV2 = writeModelSidecar(dir);
    writeFileSync(join(dir, "v2-marker"), "");
    const v2Env = { SIDECAR_MODEL_VERSION: "2" };
    const backfill = makeMockServer();
    const lifecycle = createInMemoryVoiceprintLifecycle();
    const v2Scoring = makeScoringConfig(
      dir,
      scriptV2,
      { expectedModel: { provider: "custom", modelId: "enroll-sidecar", version: "2" } },
      v2Env,
    );
    registerVoiceprintMethods(
      backfill as any,
      createInMemoryVoiceprintStorage(),
      undefined,
      v2Scoring,
      undefined,
      undefined,
      lifecycle,
    );

    // Before backfill: scoring fails needs_reenrollment.
    const ownerAudio = writeGoodWav(dir, "owner-turn.wav");
    await expect(
      backfill.call("identity.voiceprint.score_turns", conn, {
        turns: [
          {
            transcriptItemId: "rt_pre",
            role: "user",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_pre",
            audioPath: ownerAudio,
          },
        ],
        consent,
        createdAt,
      }),
    ).rejects.toThrow(/needs_reenrollment/);

    // Re-embed the owner template from retained source audio with the CURRENT (v2) model.
    const clipA = writeGoodWav(dir, "reclipA.wav");
    const clipB = writeGoodWav(dir, "reclipB.wav");
    const reembed = await backfill.call("identity.voiceprint.reembed_owner_template", conn, {
      sources: [
        { audioPath: clipA, startMs: 0, endMs: 20000 },
        { audioPath: clipB, startMs: 0, endMs: 20000 },
      ],
    });
    expect(reembed.ok).toBe(true);
    expect(reembed.status).toBe("reembedded");
    expect(reembed.model).toEqual({ provider: "custom", modelId: "enroll-sidecar", version: "2", notes: undefined });

    // The stored template now carries the v2 model tag.
    const artifact = readEncryptedVoiceprintTemplateArtifact(
      voiceprintTemplateFileRefFromSource(v2Scoring.ownerTemplateFileSource!),
    );
    expect(artifact.template.model.version).toBe("2");

    // Now scoring resolves against the re-embedded template.
    const resolved = await backfill.call("identity.voiceprint.score_turns", conn, {
      turns: [
        {
          transcriptItemId: "rt_post",
          role: "user",
          startMs: 0,
          endMs: 1500,
          audioArtifactId: "audio_post",
          audioPath: ownerAudio,
        },
      ],
      consent,
      createdAt,
    });
    expect(resolved.status).toBe("scored");
    expect(resolved.states[0]?.lifecycle).toBe("resolved");

    // A `reembed` audit entry was emitted.
    const audit = await backfill.call("identity.voiceprint.get_audit_log", conn, {});
    expect(audit.records.some((r: any) => r.op === "reembed" && r.outcome === "ok")).toBe(true);
  });

  test("reembed_owner_template without retained source -> needs_reenrollment + stale audit", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "vp-reembed-stale-"));
    tempDirs.push(dir);
    const scriptPath = writeModelSidecar(dir);
    const lifecycle = createInMemoryVoiceprintLifecycle();
    const scoring = makeScoringConfig(dir, scriptPath, {
      expectedModel: { provider: "custom", modelId: "enroll-sidecar", version: "1" },
    });
    registerVoiceprintMethods(
      server as any,
      createInMemoryVoiceprintStorage(),
      undefined,
      scoring,
      undefined,
      undefined,
      lifecycle,
    );
    const conn = { sessionKey: "live:vp-reembed-stale" };
    await enrollOwner(server, conn, dir);

    const reembed = await server.call("identity.voiceprint.reembed_owner_template", conn, {
      // No sources: no retained enrollment source audio.
    });
    expect(reembed.ok).toBe(false);
    expect(reembed.status).toBe("needs_reenrollment");
    expect(reembed.reason).toBe("no_retained_source_audio");

    const audit = await server.call("identity.voiceprint.get_audit_log", conn, {});
    expect(
      audit.records.some(
        (r: any) => r.op === "reembed" && r.outcome === "rejected",
      ),
    ).toBe(true);
  });

  test("reembed_owner_template with no owner template enrolled fails clearly", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "vp-reembed-noowner-"));
    tempDirs.push(dir);
    const scriptPath = writeModelSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, scoring);
    const conn = { sessionKey: "live:vp-reembed-noowner" };
    await expect(
      server.call("identity.voiceprint.reembed_owner_template", conn, { sources: [] }),
    ).rejects.toThrow(/owner template does not exist/);
  });
});

// ── Pure helpers ─────────────────────────────────────────────────────────────

describe("A5 model-lifecycle pure helpers", () => {
  test("isReferenceVoiceprintModel matches provider or reference modelId", () => {
    expect(isReferenceVoiceprintModel(referenceModel)).toBe(true);
    expect(isReferenceVoiceprintModel({ provider: "reference", modelId: "x" })).toBe(true);
    expect(isReferenceVoiceprintModel({ provider: "custom", modelId: "reference-fbank-v0" })).toBe(true);
    expect(isReferenceVoiceprintModel({ provider: "sherpa-onnx", modelId: "cam++" })).toBe(false);
    expect(isReferenceVoiceprintModel(undefined)).toBe(false);
  });

  test("sidecarEnvSelectsReferenceBackend treats unset/reference as reference", () => {
    expect(sidecarEnvSelectsReferenceBackend(undefined)).toBe(true);
    expect(sidecarEnvSelectsReferenceBackend({})).toBe(true);
    expect(sidecarEnvSelectsReferenceBackend({ VOICEPRINT_BACKEND: "reference" })).toBe(true);
    expect(sidecarEnvSelectsReferenceBackend({ VOICEPRINT_BACKEND: "onnx" })).toBe(false);
  });

  test("classifyVoiceprintModelMismatch names same vs different models", () => {
    const v1 = { provider: "custom" as const, modelId: "m", version: "1" };
    const v2 = { provider: "custom" as const, modelId: "m", version: "2" };
    expect(classifyVoiceprintModelMismatch(v1, v1).kind).toBe("match");
    expect(classifyVoiceprintModelMismatch(undefined, v1).kind).toBe("match");
    expect(classifyVoiceprintModelMismatch(v2, v1)).toEqual({
      kind: "mismatch",
      scoringModel: v2,
      templateModel: v1,
    });
  });

  test("assertDiscriminativeVoiceprintConfig rejects each reference footgun", () => {
    const onnxSidecar = { command: "python3", env: { VOICEPRINT_BACKEND: "onnx" } } as any;
    expect(() =>
      assertDiscriminativeVoiceprintConfig({
        devReferenceBackend: true,
        sidecar: onnxSidecar,
        expectedModel: undefined,
      }),
    ).toThrow(/dev_reference_backend/);
    expect(() =>
      assertDiscriminativeVoiceprintConfig({
        devReferenceBackend: false,
        sidecar: { command: "python3", env: { VOICEPRINT_BACKEND: "reference" } } as any,
        expectedModel: undefined,
      }),
    ).toThrow(/VOICEPRINT_BACKEND=reference/);
    expect(() =>
      assertDiscriminativeVoiceprintConfig({
        devReferenceBackend: false,
        sidecar: onnxSidecar,
        expectedModel: referenceModel,
      }),
    ).toThrow(/reference/);
    expect(() =>
      assertDiscriminativeVoiceprintConfig({
        devReferenceBackend: false,
        sidecar: onnxSidecar,
        expectedModel: { provider: "sherpa-onnx", modelId: "cam++", version: "v1" },
      }),
    ).not.toThrow();
  });
});
