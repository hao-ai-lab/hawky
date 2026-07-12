import {
  existsSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  readEncryptedVoiceprintTemplateArtifact,
  voiceprintTemplateFileRefFromSource,
  writeVoiceprintTemplateEncryptionKeyFile,
  type VoiceprintTemplateEncryptionKey,
} from "../src/identity/voiceprint/index.js";
import {
  createInMemoryVoiceprintStorage,
  registerVoiceprintMethods,
  type VoiceprintLiveScoringConfig,
} from "../src/gateway/voiceprint-methods.js";

// A1 — Owner voiceprint enrollment lifecycle (deterministic gateway RPC tests).
//
// These exercise enroll_owner / add_enrollment_clip / delete_owner_template
// against a stub sidecar that returns a controllable embedding + speechMs, so
// the 30s-speech gate, the per-clip quality gate, consent gating, and the
// enroll -> score_turns resolution wiring are all deterministic (no real model).

const createdAt = "2026-06-23T00:00:00.000Z";
const enrollModel = { provider: "custom" as const, modelId: "enroll-sidecar", version: "1" };
const consent = {
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
 * Stub sidecar: emits, per request, an embedding aligned with [1,0] (the owner
 * direction) unless the audio path contains "impostor" (then [0,1]), and a
 * speechMs computed from the request window (endMs-startMs) or a fixed default.
 * This lets a test drive the 30s enrollment gate with a couple of clips.
 */
function writeEnrollSidecar(dir: string, defaultSpeechMs = 16000): string {
  const scriptPath = join(dir, "sidecar.js");
  writeFileSync(
    scriptPath,
    `
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const request = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    process.stdout.write(JSON.stringify({
      version: 1,
      responses: request.requests.map((item) => {
        const impostor = String(item.audioPath).includes("impostor");
        const windowMs = (item.endMs !== undefined && item.startMs !== undefined)
          ? item.endMs - item.startMs
          : ${defaultSpeechMs};
        return {
          id: item.id,
          embedding: impostor ? [0, 1] : [1, 0],
          model: { provider: "custom", modelId: "enroll-sidecar", version: "1" },
          audio: { speechMs: windowMs },
        };
      }),
    }));
    `,
    "utf8",
  );
  return scriptPath;
}

function makeKey(): VoiceprintTemplateEncryptionKey {
  return { keyRef: "voiceprint-enroll-key", rawKey: Buffer.alloc(32, 9) };
}

function makeScoringConfig(dir: string, scriptPath: string): VoiceprintLiveScoringConfig {
  const templatePath = join(dir, "owner-template.enc.json");
  const keyPath = join(dir, "owner-template.key.json");
  return {
    sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 10_000 },
    ownerTemplateFileSource: {
      filePath: templatePath,
      keyPath,
      keyRef: "voiceprint-enroll-key",
      createKeyIfMissing: true,
    },
    allowedAudioRoots: [dir],
    consent,
    expectedModel: enrollModel,
  };
}

/** A sine WAV that comfortably passes the default quality gate. */
function writeGoodWav(dir: string, name: string, durationMs = 1500): string {
  const path = join(dir, name);
  writeSineWav(path, 16000, durationMs, 0.16);
  return path;
}

describe("voiceprint enrollment lifecycle", () => {
  test("enroll_owner with sufficient good audio stores the template and score_turns resolves the owner", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, storage, undefined, scoring);

    const conn = { sessionKey: "live:voiceprint-enroll" };
    // Two clips at 20s voiced each -> 40s total, over the 30s floor.
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
    expect(enroll.ok).toBe(true);
    expect(enroll.templateRef).toBeTruthy();
    expect(enroll.sourceCount).toBe(2);
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(true);
    // The response must not leak biometric embeddings.
    expect(JSON.stringify(enroll)).not.toContain("\"embedding\"");

    // A score_turns of the owner audio now resolves against the enrolled template.
    const ownerAudio = writeGoodWav(dir, "owner-turn.wav");
    const result = await server.call("identity.voiceprint.score_turns", conn, {
      turns: [
        {
          transcriptItemId: "rt_enroll_owner_turn",
          role: "user",
          startMs: 0,
          endMs: 1500,
          audioArtifactId: "audio_enroll_owner_turn",
          audioPath: ownerAudio,
        },
      ],
      consent,
      createdAt,
    });

    expect(result.status).toBe("scored");
    expect(result.states[0]?.lifecycle).toBe("resolved");
    expect(storage.snapshot?.().transcriptSpeakerAnnotations[0]).toMatchObject({
      transcriptItemId: "rt_enroll_owner_turn",
      result: "owner_speaking",
    });
  });

  test("enroll_owner with < 30s speech is rejected (not_enough_speech) and stores nothing", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-short-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, scoring);

    const conn = { sessionKey: "live:voiceprint-enroll-short" };
    const clip = writeGoodWav(dir, "short.wav");
    const enroll = await server.call("identity.voiceprint.enroll_owner", conn, {
      sources: [{ audioPath: clip, startMs: 0, endMs: 10000 }],
      consent,
    });

    expect(enroll.status).toBe("rejected");
    expect(enroll.ok).toBe(false);
    expect(enroll.reasons).toContain("not_enough_speech");
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(false);
  });

  test("enroll_owner rejects a low-quality clip and enrolls nothing when good speech is below the floor", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-quality-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, scoring);

    const conn = { sessionKey: "live:voiceprint-enroll-quality" };
    // One good clip (25s voiced) + one clip that fails the quality gate (too short).
    const good = writeGoodWav(dir, "good.wav");
    const badShort = join(dir, "bad-short.wav");
    writeSineWav(badShort, 16000, 200, 0.16); // 200ms < minDurationMs -> quality rejected
    const enroll = await server.call("identity.voiceprint.enroll_owner", conn, {
      sources: [
        { audioPath: good, startMs: 0, endMs: 25000 },
        { audioPath: badShort },
      ],
      consent,
    });

    // The rejected clip pushes the assessment to rejected (quality_rejected), and
    // because it is discarded, nothing is stored.
    expect(enroll.status).toBe("rejected");
    expect(enroll.reasons).toContain("quality_rejected");
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(false);
  });

  test("enroll_owner without consent is rejected and stores nothing", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-consent-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, scoring);

    const conn = { sessionKey: "live:voiceprint-enroll-consent" };
    const clip = writeGoodWav(dir, "clip.wav");
    await expect(
      server.call("identity.voiceprint.enroll_owner", conn, {
        sources: [{ audioPath: clip, startMs: 0, endMs: 40000 }],
        consent: { captureAllowed: true, biometricAllowed: false },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(false);
  });

  test("owner_template_status reports not-enrolled before and enrolled metadata after (no biometric leak)", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-status-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, scoring);
    const conn = { sessionKey: "live:voiceprint-enroll-status" };

    const before = await server.call("identity.voiceprint.owner_template_status", conn, {});
    expect(before).toMatchObject({ ok: true, enrolled: false });

    const clip = writeGoodWav(dir, "clip.wav");
    await server.call("identity.voiceprint.enroll_owner", conn, {
      sources: [{ audioPath: clip, startMs: 0, endMs: 40000 }],
      consent,
    });

    const after = await server.call("identity.voiceprint.owner_template_status", conn, {});
    expect(after.enrolled).toBe(true);
    expect(after.templateRef).toBeTruthy();
    expect(after.enrolledAt).toBeTruthy();
    expect(after.sourceCount).toBe(1);
    expect(typeof after.speechMs).toBe("number");
    expect(after.embeddingDim).toBeGreaterThan(0);
    // Scalar metadata only — never the centroid/embeddings.
    expect(JSON.stringify(after)).not.toContain("centroid");
    expect(JSON.stringify(after)).not.toContain("\"embedding\"");

    // After deletion it reports not-enrolled again.
    await server.call("identity.voiceprint.delete_owner_template", conn, {});
    const afterDelete = await server.call("identity.voiceprint.owner_template_status", conn, {});
    expect(afterDelete.enrolled).toBe(false);
  });

  test("owner_template_status is not-enrolled (never throws) when enrollment is unconfigured", async () => {
    const server = makeMockServer();
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, undefined);
    const status = await server.call("identity.voiceprint.owner_template_status", { sessionKey: "live:x" }, {});
    expect(status).toMatchObject({ ok: true, enrolled: false });
  });

  test("add_enrollment_clip grows the template and keeps the owner match", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-add-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, storage, undefined, scoring);

    const conn = { sessionKey: "live:voiceprint-enroll-add" };
    const clipA = writeGoodWav(dir, "clipA.wav");
    const enroll = await server.call("identity.voiceprint.enroll_owner", conn, {
      sources: [{ audioPath: clipA, startMs: 0, endMs: 40000 }],
      consent,
    });
    expect(enroll.status).toBe("accepted");
    expect(enroll.sourceCount).toBe(1);

    const clipB = writeGoodWav(dir, "clipB.wav");
    const added = await server.call("identity.voiceprint.add_enrollment_clip", conn, {
      source: { audioPath: clipB, startMs: 0, endMs: 20000 },
      consent,
    });
    expect(added.status).toBe("accepted");
    // Prior centroid carried forward + the new clip -> 2 enrollment sources.
    expect(added.sourceCount).toBe(2);

    // Owner still resolves after growing the template.
    const ownerAudio = writeGoodWav(dir, "owner-turn.wav");
    const result = await server.call("identity.voiceprint.score_turns", conn, {
      turns: [
        {
          transcriptItemId: "rt_enroll_add_turn",
          role: "user",
          startMs: 0,
          endMs: 1500,
          audioArtifactId: "audio_enroll_add_turn",
          audioPath: ownerAudio,
        },
      ],
      consent,
      createdAt,
    });
    expect(result.states[0]?.lifecycle).toBe("resolved");
  });

  test("add_enrollment_clip rejects a low-quality clip and leaves the stored template untouched", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-add-bad-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, scoring);

    const conn = { sessionKey: "live:voiceprint-enroll-add-bad" };
    const clipA = writeGoodWav(dir, "clipA.wav");
    await server.call("identity.voiceprint.enroll_owner", conn, {
      sources: [{ audioPath: clipA, startMs: 0, endMs: 40000 }],
      consent,
    });
    const key = voiceprintTemplateFileRefFromSource(scoring.ownerTemplateFileSource!);
    const before = readEncryptedVoiceprintTemplateArtifact(key);

    const badShort = join(dir, "bad-short.wav");
    writeSineWav(badShort, 16000, 200, 0.16);
    const added = await server.call("identity.voiceprint.add_enrollment_clip", conn, {
      source: { audioPath: badShort },
      consent,
    });
    expect(added.status).toBe("rejected");
    expect(added.reasons).toContain("quality_rejected");

    const after = readEncryptedVoiceprintTemplateArtifact(
      voiceprintTemplateFileRefFromSource(scoring.ownerTemplateFileSource!),
    );
    expect(after.template.id).toBe(before.template.id);
    expect(after.template.enrollment.sourceCount).toBe(1);
  });

  test("delete_owner_template makes a subsequent score_turns unable to resolve the owner and is idempotent", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-delete-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, storage, undefined, scoring);

    const conn = { sessionKey: "live:voiceprint-enroll-delete" };
    const clip = writeGoodWav(dir, "clip.wav");
    await server.call("identity.voiceprint.enroll_owner", conn, {
      sources: [{ audioPath: clip, startMs: 0, endMs: 40000 }],
      consent,
    });
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(true);

    const del = await server.call("identity.voiceprint.delete_owner_template", conn, {});
    expect(del.removed).toBe(true);
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(false);

    // Idempotent: a second delete is a no-op success.
    const del2 = await server.call("identity.voiceprint.delete_owner_template", conn, {});
    expect(del2.removed).toBe(false);

    // score_turns can no longer resolve an owner -> the template source is gone.
    const ownerAudio = writeGoodWav(dir, "owner-turn.wav");
    await expect(
      server.call("identity.voiceprint.score_turns", conn, {
        turns: [
          {
            transcriptItemId: "rt_enroll_delete_turn",
            role: "user",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_enroll_delete_turn",
            audioPath: ownerAudio,
          },
        ],
        consent,
        createdAt,
      }),
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
  });

  test("enrollment RPCs require a file-backed owner template store", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-nofile-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    // Inline ownerEmbeddings scoring has no durable store to enroll into.
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, {
      sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 10_000 },
      ownerEmbeddings: [[1, 0]],
      allowedAudioRoots: [dir],
      consent,
      expectedModel: enrollModel,
    });

    const clip = writeGoodWav(dir, "clip.wav");
    await expect(
      server.call("identity.voiceprint.enroll_owner", { sessionKey: "live:voiceprint-enroll-nofile" }, {
        sources: [{ audioPath: clip, startMs: 0, endMs: 40000 }],
        consent,
      }),
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });
  });

  test("the encrypted template round-trips and a wrong key fails to decrypt", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-crypto-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, scoring);

    const conn = { sessionKey: "live:voiceprint-enroll-crypto" };
    const clip = writeGoodWav(dir, "clip.wav");
    const enroll = await server.call("identity.voiceprint.enroll_owner", conn, {
      sources: [{ audioPath: clip, startMs: 0, endMs: 40000 }],
      consent,
    });
    expect(enroll.status).toBe("accepted");

    // Round-trip with the real key.
    const ref = voiceprintTemplateFileRefFromSource(scoring.ownerTemplateFileSource!);
    const artifact = readEncryptedVoiceprintTemplateArtifact(ref);
    expect(artifact.centroid).toEqual([1, 0]);
    expect(artifact.template.id).toBe(enroll.templateRef);

    // A different 32-byte key (same keyRef) must fail authenticated decryption.
    const wrongKeyPath = join(dir, "wrong.key.json");
    writeVoiceprintTemplateEncryptionKeyFile({
      filePath: wrongKeyPath,
      key: { keyRef: "voiceprint-enroll-key", rawKey: Buffer.alloc(32, 3) },
    });
    expect(() =>
      readEncryptedVoiceprintTemplateArtifact(
        voiceprintTemplateFileRefFromSource({
          filePath: ref.filePath,
          keyPath: wrongKeyPath,
          keyRef: "voiceprint-enroll-key",
          createKeyIfMissing: false,
        }),
      ),
    ).toThrow();
  });
});

// Local sine-WAV writer (mono 16-bit PCM) matching the other voiceprint specs.
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

// ---------------------------------------------------------------------------
// enroll_owner_from_recording — capture-domain-parity enrollment from a live
// recording's finalized segments. Pins: timeline-ordered selection, quality
// DROP (not reject) for bad segments, the shared enroll seam (floor + template
// write + biometric-minimized response), and clear failure shapes.
// ---------------------------------------------------------------------------

function writeRecordingSegment(
  dir: string,
  base: string,
  index: number,
  durationMs: number,
  amplitude = 0.16,
): void {
  const mediaId = `${base}.seg${String(index).padStart(3, "0")}.mic`;
  writeSineWav(join(dir, `${mediaId}.wav`), 16000, durationMs, amplitude);
  writeFileSync(
    join(dir, `${mediaId}.json`),
    JSON.stringify({
      mime: "audio/pcm16;rate=16000",
      captured_start_iso: createdAt,
      locked: false,
      duration_ms: durationMs,
      final_iso: createdAt,
    }),
    "utf8",
  );
}

describe("enroll_owner_from_recording (live capture-domain enrollment)", () => {
  test("enrolls from quality-passing segments, drops bad ones, and score_turns resolves the owner", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-rec-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, storage, undefined, scoring);
    const conn = { sessionKey: "live:enroll-from-recording" };

    const base = "live-20260713-000000";
    writeRecordingSegment(dir, base, 0, 1500);
    writeRecordingSegment(dir, base, 1, 200); // too short -> quality gate DROPS it
    writeRecordingSegment(dir, base, 2, 1500);

    const enroll = await server.call("identity.voiceprint.enroll_owner_from_recording", conn, {
      recordingBaseId: base,
      consent,
    });
    expect(enroll.ok).toBe(true);
    expect(enroll.status).toBe("accepted");
    expect(enroll.templateRef).toBeTruthy();
    expect(enroll.segmentsConsidered).toBe(3);
    expect(enroll.segmentsUsed).toBe(2);
    expect(enroll.segmentsQualityRejected).toBe(1);
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(true);
    // Biometric minimization holds on this path too.
    expect(JSON.stringify(enroll)).not.toContain("\"embedding\"");

    // The enrolled template resolves the owner through the normal score path.
    const ownerAudio = writeGoodWav(dir, "owner-turn.wav");
    const scored = await server.call("identity.voiceprint.score_turns", conn, {
      turns: [{
        transcriptItemId: "rt_rec_enroll_turn",
        role: "user",
        startMs: 0,
        endMs: 1500,
        audioArtifactId: "audio_rec_enroll_turn",
        audioPath: ownerAudio,
      }],
      consent,
      createdAt,
    });
    expect(scored.status).toBe("scored");
    expect(scored.states[0]?.lifecycle).toBe("resolved");
  });

  test("not enough usable speech rejects with counts (never a bare throw)", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-rec-short-"));
    tempDirs.push(dir);
    // Sidecar reports only 10s voiced per segment -> 1 segment = 10s < 30s floor.
    const scriptPath = writeEnrollSidecar(dir, 10_000);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, scoring);
    const conn = { sessionKey: "live:enroll-from-recording-short" };

    const base = "live-20260713-000001";
    writeRecordingSegment(dir, base, 0, 1500);

    const enroll = await server.call("identity.voiceprint.enroll_owner_from_recording", conn, {
      recordingBaseId: base,
      consent,
    });
    expect(enroll.ok).toBe(false);
    expect(enroll.status).toBe("rejected");
    expect(enroll.reasons).toContain("not_enough_speech");
    expect(typeof enroll.speechMs).toBe("number");
    expect(enroll.segmentsUsed).toBe(1);
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(false);
  });

  test("all segments quality-rejected reports a rejection, not an error", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-rec-bad-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, scoring);
    const conn = { sessionKey: "live:enroll-from-recording-bad" };

    const base = "live-20260713-000002";
    writeRecordingSegment(dir, base, 0, 200);
    writeRecordingSegment(dir, base, 1, 200);

    const enroll = await server.call("identity.voiceprint.enroll_owner_from_recording", conn, {
      recordingBaseId: base,
      consent,
    });
    expect(enroll.ok).toBe(false);
    expect(enroll.status).toBe("rejected");
    expect(enroll.reasons).toContain("quality_rejected");
    expect(enroll.segmentsQualityRejected).toBe(2);
  });

  test("unknown recording is FAILED_PRECONDITION; missing consent is FORBIDDEN; bad id is INVALID_REQUEST", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-rec-err-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, scoring);
    const conn = { sessionKey: "live:enroll-from-recording-err" };

    await expect(
      server.call("identity.voiceprint.enroll_owner_from_recording", conn, {
        recordingBaseId: "live-20260713-nope",
        consent,
      }),
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });

    const base = "live-20260713-000003";
    writeRecordingSegment(dir, base, 0, 1500);
    await expect(
      server.call("identity.voiceprint.enroll_owner_from_recording", conn, {
        recordingBaseId: base,
        consent: { captureAllowed: true, biometricAllowed: false },
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    await expect(
      server.call("identity.voiceprint.enroll_owner_from_recording", conn, {
        recordingBaseId: "../escape",
        consent,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  test("selection caps at ~90s of segment audio and reports capped/afterGap counts honestly", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-rec-cap-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, scoring);
    const conn = { sessionKey: "live:enroll-from-recording-cap" };

    // Sidecar duration_ms drives the cap budget (the WAVs themselves stay small):
    // 50s + 50s reaches the 90s budget, so seg002 is capped.
    const base = "live-20260713-000004";
    for (const index of [0, 1, 2]) {
      const mediaId = `${base}.seg${String(index).padStart(3, "0")}.mic`;
      writeSineWav(join(dir, `${mediaId}.wav`), 16000, 1500, 0.16);
      writeFileSync(
        join(dir, `${mediaId}.json`),
        JSON.stringify({
          mime: "audio/pcm16;rate=16000",
          captured_start_iso: createdAt,
          locked: false,
          duration_ms: 50_000,
          final_iso: createdAt,
        }),
        "utf8",
      );
    }

    const enroll = await server.call("identity.voiceprint.enroll_owner_from_recording", conn, {
      recordingBaseId: base,
      consent,
    });
    expect(enroll.segmentsUsed).toBe(2);
    expect(enroll.segmentsCapped).toBe(1);
    expect(enroll.segmentsAfterGap).toBe(0);
    expect(enroll.segmentsConsidered).toBe(3);
  });

  test("a timeline gap is reported as afterGap (never mislabeled quality_rejected)", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-rec-gap-"));
    tempDirs.push(dir);
    // Sidecar reports 40s voiced for the one reachable segment -> floor passes,
    // proving the gap costs coverage but not the enrollment itself.
    const scriptPath = writeEnrollSidecar(dir, 40_000);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, scoring);
    const conn = { sessionKey: "live:enroll-from-recording-gap" };

    const base = "live-20260713-000005";
    writeRecordingSegment(dir, base, 0, 1500);
    writeRecordingSegment(dir, base, 2, 1500); // seg001 missing -> gap

    const enroll = await server.call("identity.voiceprint.enroll_owner_from_recording", conn, {
      recordingBaseId: base,
      consent,
    });
    expect(enroll.status).toBe("accepted");
    expect(enroll.segmentsConsidered).toBe(2);
    expect(enroll.segmentsUsed).toBe(1);
    expect(enroll.segmentsQualityRejected).toBe(0);
    expect(enroll.segmentsAfterGap).toBe(1);
  });

  test("multiple takes accumulate: two recordings each below the floor enroll together", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-rec-multi-"));
    tempDirs.push(dir);
    // Sidecar counts 16s voiced per segment: one take (1 segment) = 16s < 30s,
    // two takes = 32s >= 30s. This is exactly the "keep talking -> continue
    // recording" UX: the second take ADDS to the first instead of replacing it.
    const scriptPath = writeEnrollSidecar(dir, 16_000);
    const scoring = makeScoringConfig(dir, scriptPath);
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, scoring);
    const conn = { sessionKey: "live:enroll-from-recording-multi" };

    const takeA = "live-20260713-000010";
    const takeB = "live-20260713-000011";
    writeRecordingSegment(dir, takeA, 0, 1500);
    writeRecordingSegment(dir, takeB, 0, 1500);

    const short = await server.call("identity.voiceprint.enroll_owner_from_recording", conn, {
      recordingBaseIds: [takeA],
      consent,
    });
    expect(short.status).toBe("rejected");
    expect(short.reasons).toContain("not_enough_speech");

    const enroll = await server.call("identity.voiceprint.enroll_owner_from_recording", conn, {
      recordingBaseIds: [takeA, takeB],
      consent,
    });
    expect(enroll.status).toBe("accepted");
    expect(enroll.sourceCount).toBe(2);
    expect(enroll.segmentsUsed).toBe(2);
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(true);
  });

  test("recordingBaseIds validation: empty, too many, and duplicates are INVALID_REQUEST", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-enroll-rec-val-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    registerVoiceprintMethods(server as any, createInMemoryVoiceprintStorage(), undefined, makeScoringConfig(dir, scriptPath));
    const conn = { sessionKey: "live:enroll-from-recording-val" };

    await expect(
      server.call("identity.voiceprint.enroll_owner_from_recording", conn, { recordingBaseIds: [], consent }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      server.call("identity.voiceprint.enroll_owner_from_recording", conn, {
        recordingBaseIds: Array.from({ length: 11 }, (_, i) => `live-2026-take${i}`),
        consent,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      server.call("identity.voiceprint.enroll_owner_from_recording", conn, {
        recordingBaseIds: ["live-2026-dup", "live-2026-dup"],
        consent,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});

