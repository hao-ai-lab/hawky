// A6 — Fail-closed sweep for the voiceprint scoring pipeline (server-side / TS).
//
// Every failure in the voiceprint path must degrade GRACEFULLY:
//   (a) never propagate an unhandled throw out of the score_turns RPC handler
//       (a clean typed MethodError for a genuine precondition is fine — that is
//       NOT a crash and NOT a false-accept);
//   (b) NEVER falsely accept a speaker as owner on a failure — fail-CLOSED, i.e.
//       a failure yields lifecycle skipped/error/needs_reenrollment, NEVER
//       resolved / owner_speaking;
//   (c) produce a structured result (status error/partial/skipped) rather than
//       throwing out of the handler.
//
// The tests inject each failure via a stub sidecar / stub storage and assert the
// no-resolve-on-failure invariant across all cases.

import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildVoiceprintTemplateArtifact,
  type VoiceprintTemplateArtifact,
  type VoiceprintTemplateEncryptionKey,
} from "../src/identity/voiceprint/index.js";
import {
  createInMemoryVoiceprintStorage,
  registerVoiceprintMethods,
  type VoiceprintStorageAdapter,
} from "../src/gateway/voiceprint-methods.js";

const createdAt = "2026-07-11T00:00:00.000Z";
const updatedAt = "2026-07-11T00:00:01.000Z";
const sidecarModel = { provider: "custom" as const, modelId: "fail-closed-sidecar", version: "1" };
const trustedConsent = {
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

/**
 * THE INVARIANT. No matter the failure, no transcript state may end `resolved`
 * (nor carry `result: "owner_speaking"` / `"confirmed_person"`). Assert it over
 * every returned state AND every persisted annotation.
 */
function assertNoOwnerResolveOnFailure(
  result: { states?: Array<{ lifecycle: string; result?: string }> },
  storage: VoiceprintStorageAdapter,
): void {
  for (const state of result.states ?? []) {
    expect(state.lifecycle).not.toBe("resolved");
    expect(state.result).not.toBe("owner_speaking");
    expect(state.result).not.toBe("confirmed_person");
  }
  const snapshot = storage.snapshot?.();
  for (const annotation of snapshot?.transcriptSpeakerAnnotations ?? []) {
    expect(annotation.result).not.toBe("owner_speaking");
    expect(annotation.result).not.toBe("confirmed_person");
  }
}

describe("voiceprint fail-closed sweep (score_turns)", () => {
  test("spawn-fail sidecar (bad command): status error, no throw, no resolve", async () => {
    const { server, storage, dir } = makeScorer({
      sidecar: {
        command: join(mkdirTmp(), "does-not-exist-binary"),
        args: [],
        timeoutMs: 5_000,
      },
    });
    const audioPath = writeSine(dir, "owner.wav");

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "s:spawn-fail" },
      { turns: [userTurn("s:spawn-fail", "rt_spawn_fail", audioPath)], createdAt, updatedAt },
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("sidecar_failed");
    expect(result.states[0]?.lifecycle).toBe("error");
    assertNoOwnerResolveOnFailure(result, storage);
  });

  test("non-zero exit sidecar: status error, no throw, no resolve", async () => {
    const { server, storage, dir } = makeScorer({
      sidecar: sidecarScript(`process.stderr.write("boom"); process.exit(7);`),
    });
    const audioPath = writeSine(dir, "owner.wav");

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "s:nonzero" },
      { turns: [userTurn("s:nonzero", "rt_nonzero", audioPath)], createdAt, updatedAt },
    );

    expect(result.status).toBe("error");
    expect(result.error?.code).toBe("sidecar_failed");
    expect(result.states[0]?.lifecycle).toBe("error");
    assertNoOwnerResolveOnFailure(result, storage);
  });

  test("garbage-stdout sidecar (not JSON): status error, no throw, no resolve", async () => {
    const { server, storage, dir } = makeScorer({
      sidecar: sidecarScript(`process.stdout.write("this is not json"); process.exit(0);`),
    });
    const audioPath = writeSine(dir, "owner.wav");

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "s:garbage" },
      { turns: [userTurn("s:garbage", "rt_garbage", audioPath)], createdAt, updatedAt },
    );

    expect(result.status).toBe("error");
    expect(result.states[0]?.lifecycle).toBe("error");
    assertNoOwnerResolveOnFailure(result, storage);
  });

  test("empty-stdout sidecar: status error, no throw, no resolve", async () => {
    const { server, storage, dir } = makeScorer({
      sidecar: sidecarScript(`process.exit(0);`),
    });
    const audioPath = writeSine(dir, "owner.wav");

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "s:empty" },
      { turns: [userTurn("s:empty", "rt_empty", audioPath)], createdAt, updatedAt },
    );

    expect(result.status).toBe("error");
    expect(result.states[0]?.lifecycle).toBe("error");
    assertNoOwnerResolveOnFailure(result, storage);
  });

  test("truncated-JSON sidecar: status error, no throw, no resolve", async () => {
    const { server, storage, dir } = makeScorer({
      sidecar: sidecarScript(`process.stdout.write('{"version":1,"responses":[');`),
    });
    const audioPath = writeSine(dir, "owner.wav");

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "s:truncated" },
      { turns: [userTurn("s:truncated", "rt_truncated", audioPath)], createdAt, updatedAt },
    );

    expect(result.status).toBe("error");
    assertNoOwnerResolveOnFailure(result, storage);
  });

  test("timeout sidecar: status error, no throw, no resolve", async () => {
    const { server, storage, dir } = makeScorer({
      sidecar: {
        ...sidecarScript(`setTimeout(() => process.stdout.write("late"), 5000);`),
        timeoutMs: 30,
      },
    });
    const audioPath = writeSine(dir, "owner.wav");

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "s:timeout" },
      { turns: [userTurn("s:timeout", "rt_timeout", audioPath)], createdAt, updatedAt },
    );

    expect(result.status).toBe("error");
    expect(result.error?.message).toMatch(/timed out/);
    assertNoOwnerResolveOnFailure(result, storage);
  });

  test("killed-mid-run sidecar (self SIGKILL): status error, no throw, no resolve", async () => {
    const { server, storage, dir } = makeScorer({
      sidecar: sidecarScript(`process.kill(process.pid, "SIGKILL");`),
    });
    const audioPath = writeSine(dir, "owner.wav");

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "s:killed" },
      { turns: [userTurn("s:killed", "rt_killed", audioPath)], createdAt, updatedAt },
    );

    expect(result.status).toBe("error");
    assertNoOwnerResolveOnFailure(result, storage);
  });

  test("response missing an expected id: status error, no throw, no resolve", async () => {
    // Sidecar drops the response entirely -> missing id -> batch integrity throw
    // -> caught -> status error (fail-closed), never a resolve.
    const { server, storage, dir } = makeScorer({
      sidecar: sidecarScript(`
        process.stdout.write(JSON.stringify({ version: 1, responses: [] }));
      `),
    });
    const audioPath = writeSine(dir, "owner.wav");

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "s:missing-id" },
      { turns: [userTurn("s:missing-id", "rt_missing_id", audioPath)], createdAt, updatedAt },
    );

    expect(result.status).toBe("error");
    assertNoOwnerResolveOnFailure(result, storage);
  });

  test("response with a duplicate id: status error, no throw, no resolve", async () => {
    const { server, storage, dir } = makeScorer({
      sidecar: sidecarScript(`
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const item = request.requests[0];
        const one = { id: item.id, embedding: [1, 0], model: { provider: "custom", modelId: "fail-closed-sidecar", version: "1" } };
        process.stdout.write(JSON.stringify({ version: 1, responses: [one, one] }));
      `),
    });
    const audioPath = writeSine(dir, "owner.wav");

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "s:dup-id" },
      { turns: [userTurn("s:dup-id", "rt_dup_id", audioPath)], createdAt, updatedAt },
    );

    expect(result.status).toBe("error");
    assertNoOwnerResolveOnFailure(result, storage);
  });

  for (const [label, embedding] of [
    ["NaN", "[NaN, NaN]"],
    ["empty", "[]"],
    ["zero-norm", "[0, 0]"],
    ["wrong-dim", "[1, 0, 0]"],
  ] as const) {
    test(`garbage embedding (${label}) single turn: not resolved, no throw`, async () => {
      const { server, storage, dir } = makeScorer({
        sidecar: sidecarScript(`
          const chunks = [];
          for await (const chunk of process.stdin) chunks.push(chunk);
          const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          process.stdout.write(JSON.stringify({
            version: 1,
            responses: request.requests.map((item) => ({
              id: item.id,
              embedding: ${embedding},
              model: { provider: "custom", modelId: "fail-closed-sidecar", version: "1" }
            }))
          }));
        `),
      });
      const audioPath = writeSine(dir, "owner.wav");

      const result = await server.call(
        "identity.voiceprint.score_turns",
        { sessionKey: `s:garbage-${label}` },
        { turns: [userTurn(`s:garbage-${label}`, `rt_garbage_${label}`, audioPath)], createdAt, updatedAt },
      );

      // Either a whole-batch error (transport-parse variants) or a per-turn skip
      // (scoring-boundary variants). BOTH are fail-closed; the invariant is that
      // it is NEVER resolved.
      expect(["error", "skipped", "partial"]).toContain(result.status);
      assertNoOwnerResolveOnFailure(result, storage);
    });
  }

  test("mixed batch (one wrong-dim + one good): good resolves, bad skips, RPC returns partial", async () => {
    // The bad turn's embedding has a mismatched dimension so it fails at the
    // scoring boundary (not the transport parser), letting the good turn resolve.
    const { server, storage, dir } = makeScorer({
      sidecar: sidecarScript(`
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        // The bad turn is submitted second (index 1); give it a wrong-dimension
        // embedding so it fails at the scoring boundary while the good turn (index
        // 0) resolves. Request order preserves turn order.
        process.stdout.write(JSON.stringify({
          version: 1,
          responses: request.requests.map((item, index) => ({
            id: item.id,
            embedding: index === 1 ? [1, 0, 0] : [1, 0],
            model: { provider: "custom", modelId: "fail-closed-sidecar", version: "1" }
          }))
        }));
      `),
    });
    const goodAudio = writeSine(dir, "good.wav");
    const badAudio = writeSine(dir, "bad.wav");

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "s:mixed" },
      {
        turns: [
          userTurn("s:mixed", "rt_mixed_good", goodAudio, "audio_mixed_good"),
          userTurn("s:mixed", "rt_mixed_bad", badAudio, "audio_mixed_bad"),
        ],
        createdAt,
        updatedAt,
      },
    );

    expect(result.status).toBe("partial");
    const byId = new Map(result.states.map((s: any) => [s.transcriptItemId, s]));
    expect(byId.get("rt_mixed_good")?.lifecycle).toBe("resolved");
    expect(byId.get("rt_mixed_good")?.result).toBe("owner_speaking");
    expect(byId.get("rt_mixed_bad")?.lifecycle).toBe("skipped");
    expect(byId.get("rt_mixed_bad")?.skipReason).toBe("scoring_failed");
    // Exactly the good annotation persisted; the bad turn NEVER resolves.
    const annotations = storage.snapshot?.().transcriptSpeakerAnnotations ?? [];
    expect(annotations).toHaveLength(1);
    expect(annotations[0]).toMatchObject({
      transcriptItemId: "rt_mixed_good",
      result: "owner_speaking",
    });
  });

  test("wrong-model sidecar response: status error, no throw, no resolve", async () => {
    const { server, storage, dir } = makeScorer({
      sidecar: sidecarScript(`
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        process.stdout.write(JSON.stringify({
          version: 1,
          responses: request.requests.map((item) => ({
            id: item.id,
            embedding: [1, 0],
            model: { provider: "custom", modelId: "SOME-OTHER-MODEL", version: "9" }
          }))
        }));
      `),
    });
    const audioPath = writeSine(dir, "owner.wav");

    const result = await server.call(
      "identity.voiceprint.score_turns",
      { sessionKey: "s:wrong-model" },
      { turns: [userTurn("s:wrong-model", "rt_wrong_model", audioPath)], createdAt, updatedAt },
    );

    expect(result.status).toBe("error");
    assertNoOwnerResolveOnFailure(result, storage);
  });

  test("corrupt / undecryptable owner template: MethodError (no crash), no resolve", async () => {
    // A corrupt on-disk owner template must fail-closed at resolve time. This is a
    // genuine precondition violation, so a clean typed MethodError is acceptable —
    // it is NOT a crash and NOT a false-accept. Assert the handler throws a typed
    // FAILED_PRECONDITION rather than resolving any owner.
    const dir = mkdirTmp();
    const templatePath = join(dir, "owner-template.enc.json");
    // Not valid encrypted-template JSON -> readEncryptedVoiceprintTemplateArtifact throws.
    writeFileSync(templatePath, "{ not a real encrypted template }", "utf8");
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    registerVoiceprintMethods(server as any, storage, undefined, {
      sidecar: sidecarScript(`process.exit(0);`),
      ownerTemplateFile: {
        filePath: templatePath,
        key: makeEncryptionKey(),
        expectedKeyRef: "fail-closed-template-key",
      },
      allowedAudioRoots: [dir],
      consent: trustedConsent,
      expectedModel: sidecarModel,
    });
    const audioPath = writeSine(dir, "owner.wav");

    let threw = false;
    try {
      await server.call(
        "identity.voiceprint.score_turns",
        { sessionKey: "s:corrupt-template" },
        { turns: [userTurn("s:corrupt-template", "rt_corrupt_template", audioPath)], createdAt, updatedAt },
      );
    } catch (error) {
      threw = true;
      // Clean typed error, not an unhandled crash.
      expect((error as { code?: string }).code).toBe("FAILED_PRECONDITION");
      expect((error as Error).message).toMatch(/owner template is not usable/);
    }
    expect(threw).toBe(true);
    // No owner ever resolved / persisted.
    expect(storage.snapshot?.().transcriptSpeakerAnnotations ?? []).toEqual([]);
  });

  test("storage applyBundle throws: MethodError (no crash), no resolve", async () => {
    // A storage adapter whose applyBundle throws must not crash the gateway and
    // must not resolve any owner. The handler surfaces a typed MethodError.
    const throwingStorage: VoiceprintStorageAdapter = {
      applyBundle() {
        throw new Error("disk on fire");
      },
      snapshot() {
        return {
          transcriptIdentityStates: [],
          speakerTurnTags: [],
          identitySignals: [],
          transcriptSpeakerAnnotations: [],
          eventParticipations: [],
        };
      },
    };
    const dir = mkdirTmp();
    const server = makeMockServer();
    registerVoiceprintMethods(server as any, throwingStorage, undefined, {
      sidecar: sidecarScript(`
        const chunks = [];
        for await (const chunk of process.stdin) chunks.push(chunk);
        const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        process.stdout.write(JSON.stringify({
          version: 1,
          responses: request.requests.map((item) => ({
            id: item.id, embedding: [1, 0],
            model: { provider: "custom", modelId: "fail-closed-sidecar", version: "1" }
          }))
        }));
      `),
      ownerTemplateArtifact: makeTemplateArtifact(),
      allowedAudioRoots: [dir],
      consent: trustedConsent,
      expectedModel: sidecarModel,
    });
    const audioPath = writeSine(dir, "owner.wav");

    let threw = false;
    try {
      await server.call(
        "identity.voiceprint.score_turns",
        { sessionKey: "s:storage-throws" },
        { turns: [userTurn("s:storage-throws", "rt_storage_throws", audioPath)], createdAt, updatedAt },
      );
    } catch (error) {
      threw = true;
      // Typed MethodError — a crash would have been an unhandled throw of a
      // different shape; the important thing is no false-accept was persisted.
      expect(typeof (error as { code?: string }).code).toBe("string");
    }
    expect(threw).toBe(true);
    expect(throwingStorage.snapshot?.().transcriptSpeakerAnnotations ?? []).toEqual([]);
  });

  test("no owner template configured: MethodError (no crash), no resolve", async () => {
    const dir = mkdirTmp();
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    registerVoiceprintMethods(server as any, storage, undefined, {
      sidecar: sidecarScript(`process.exit(0);`),
      // no owner template source at all
      allowedAudioRoots: [dir],
      consent: trustedConsent,
      expectedModel: sidecarModel,
    });
    const audioPath = writeSine(dir, "owner.wav");

    let threw = false;
    try {
      await server.call(
        "identity.voiceprint.score_turns",
        { sessionKey: "s:no-template" },
        { turns: [userTurn("s:no-template", "rt_no_template", audioPath)], createdAt, updatedAt },
      );
    } catch (error) {
      threw = true;
      expect((error as { code?: string }).code).toBe("FAILED_PRECONDITION");
    }
    expect(threw).toBe(true);
    assertNoOwnerResolveOnFailure({ states: [] }, storage);
  });
});

// ── helpers ────────────────────────────────────────────────────────────────

function makeScorer(overrides: {
  sidecar: {
    command: string;
    args?: string[];
    timeoutMs?: number;
  };
}): { server: ReturnType<typeof makeMockServer>; storage: VoiceprintStorageAdapter; dir: string } {
  const dir = mkdirTmp();
  const server = makeMockServer();
  const storage = createInMemoryVoiceprintStorage();
  registerVoiceprintMethods(server as any, storage, undefined, {
    sidecar: overrides.sidecar,
    ownerTemplateArtifact: makeTemplateArtifact(),
    allowedAudioRoots: [dir],
    consent: trustedConsent,
    expectedModel: sidecarModel,
  });
  return { server, storage, dir };
}

function userTurn(
  sessionKey: string,
  transcriptItemId: string,
  audioPath: string,
  audioArtifactId = `audio_${transcriptItemId}`,
) {
  return {
    sessionKey,
    transcriptItemId,
    role: "user" as const,
    text: "owner is speaking here now",
    startMs: 0,
    endMs: 1500,
    audioArtifactId,
    audioPath,
    route: "iphone_mic",
  };
}

function sidecarScript(source: string): { command: string; args: string[]; timeoutMs: number } {
  const dir = mkdirTmp();
  const scriptPath = join(dir, "sidecar.js");
  writeFileSync(scriptPath, source, "utf8");
  return { command: process.execPath, args: [scriptPath], timeoutMs: 5_000 };
}

function mkdirTmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "voiceprint-fail-closed-"));
  tempDirs.push(dir);
  return dir;
}

function writeSine(dir: string, name: string): string {
  const path = join(dir, name);
  const sampleRate = 16000;
  const durationMs = 1800;
  const amplitude = 0.16;
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
  chmodSync(path, 0o600);
  return path;
}

function makeTemplateArtifact(): VoiceprintTemplateArtifact {
  return buildVoiceprintTemplateArtifact({
    model: sidecarModel,
    sources: [
      { artifactId: "owner_enrollment_1", embedding: [1, 0], speechMs: 1500, route: "iphone_mic", qualityStatus: "accepted" },
      { artifactId: "owner_enrollment_2", embedding: [0.99, 0.01], speechMs: 1500, route: "iphone_mic", qualityStatus: "accepted" },
    ],
    storage: {
      templateUri: "local-voiceprint://owner/fail-closed-template.enc",
      encrypted: true,
      localOnly: true,
      keyRef: "fail-closed-template-key",
    },
    createdAt,
    minSpeechMs: 1000,
  });
}

function makeEncryptionKey(): VoiceprintTemplateEncryptionKey {
  return {
    keyRef: "fail-closed-template-key",
    rawKey: Buffer.alloc(32, 9),
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
