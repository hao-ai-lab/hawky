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
  buildVoiceprintConsentGrant,
  buildVoiceprintConsentWithdrawal,
  foldVoiceprintConsentHistory,
  isVoiceprintConsentExpired,
  assertVoiceprintAuditRecordHasNoSecrets,
  DEFAULT_VOICEPRINT_RETENTION_MS,
} from "../src/identity/voiceprint/index.js";
import {
  createInMemoryVoiceprintStorage,
  createInMemoryVoiceprintAudioArtifactStore,
  registerVoiceprintMethods,
  type VoiceprintLiveScoringConfig,
} from "../src/gateway/voiceprint-methods.js";
import { createVoiceprintRealtimeSessionStore } from "../src/gateway/voiceprint-realtime.js";
import {
  createFileVoiceprintAuditLog,
  createFileVoiceprintConsentLedger,
  createInMemoryVoiceprintLifecycle,
  type VoiceprintLifecycle,
} from "../src/gateway/voiceprint-lifecycle.js";

// A4 — Biometric consent + retention + deletion + audit lifecycle (BIPA/GDPR).
//
// Deterministic gateway RPC tests over an in-memory lifecycle with injected time.
// A stub sidecar returns a controllable embedding + speechMs so enroll/score are
// deterministic (no real model).

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

function makeScoringConfig(dir: string, scriptPath: string): VoiceprintLiveScoringConfig {
  return {
    sidecar: { command: process.execPath, args: [scriptPath], timeoutMs: 10_000 },
    ownerTemplateFileSource: {
      filePath: join(dir, "owner-template.enc.json"),
      keyPath: join(dir, "owner-template.key.json"),
      keyRef: "voiceprint-lifecycle-key",
      createKeyIfMissing: true,
    },
    allowedAudioRoots: [dir],
    consent,
    expectedModel: enrollModel,
  };
}

function writeGoodWav(dir: string, name: string): string {
  const path = join(dir, name);
  writeSineWav(path, 16000, 1500, 0.16);
  return path;
}

describe("voiceprint consent ledger (pure core)", () => {
  test("fold: grant then withdrawal, append-only history is preserved", () => {
    const grant = buildVoiceprintConsentGrant({
      subjectKey: "s1",
      scopes: ["capture", "biometric"],
      history: [],
      grantedAt: "2026-01-01T00:00:00.000Z",
    });
    const withdrawal = buildVoiceprintConsentWithdrawal({
      subjectKey: "s1",
      history: [grant],
      withdrawnAt: "2026-02-01T00:00:00.000Z",
    });
    // After withdrawal, no scope resolves — but the grant record still exists.
    const effective = foldVoiceprintConsentHistory("s1", [grant, withdrawal]);
    expect(effective.active).toBe(false);
    expect(effective.scopes.biometric).toBe(false);
    expect(effective.withdrawnAt).toBe("2026-02-01T00:00:00.000Z");
    expect(effective.history).toHaveLength(2);
    expect(effective.history[0]?.kind).toBe("grant");
    // seq is monotonic — the withdrawal did not overwrite the grant.
    expect(withdrawal.seq).toBe(1);
  });

  test("retention expiry only fires past the window for an active grant", () => {
    const grant = buildVoiceprintConsentGrant({
      subjectKey: "s1",
      scopes: ["capture", "biometric"],
      history: [],
      grantedAt: "2026-01-01T00:00:00.000Z",
    });
    const effective = foldVoiceprintConsentHistory("s1", [grant]);
    const anchorMs = Date.parse("2026-01-01T00:00:00.000Z");
    expect(
      isVoiceprintConsentExpired({
        effective,
        nowMs: anchorMs + DEFAULT_VOICEPRINT_RETENTION_MS - 1,
        retentionMs: DEFAULT_VOICEPRINT_RETENTION_MS,
      }),
    ).toBe(false);
    expect(
      isVoiceprintConsentExpired({
        effective,
        nowMs: anchorMs + DEFAULT_VOICEPRINT_RETENTION_MS + 1,
        retentionMs: DEFAULT_VOICEPRINT_RETENTION_MS,
      }),
    ).toBe(true);
  });

  test("file-backed consent ledger persists and stays append-only across instances", () => {
    const dir = mkdtempSync(join(tmpdir(), "vp-file-ledger-"));
    tempDirs.push(dir);
    const filePath = join(dir, "consent-ledger.json");
    const ledger = createFileVoiceprintConsentLedger({ filePath });
    ledger.append(
      buildVoiceprintConsentGrant({
        subjectKey: "s1",
        scopes: ["capture", "biometric"],
        history: ledger.history("s1"),
        grantedAt: createdAt,
      }),
    );
    ledger.append(
      buildVoiceprintConsentWithdrawal({
        subjectKey: "s1",
        history: ledger.history("s1"),
        withdrawnAt: "2026-06-24T00:00:00.000Z",
      }),
    );
    // A fresh instance over the same file sees BOTH records (grant retained).
    const reopened = createFileVoiceprintConsentLedger({ filePath });
    const history = reopened.history("s1");
    expect(history).toHaveLength(2);
    expect(history[0]?.kind).toBe("grant");
    expect(history[1]?.kind).toBe("withdrawal");
    expect(reopened.effective("s1").active).toBe(false);
  });

  test("file-backed audit log rejects a record carrying a secret", () => {
    const dir = mkdtempSync(join(tmpdir(), "vp-file-audit-"));
    tempDirs.push(dir);
    const audit = createFileVoiceprintAuditLog({ filePath: join(dir, "audit-log.json") });
    audit.append({ version: 1, subjectKey: "s1", op: "score", at: createdAt, outcome: "ok" });
    expect(audit.read("s1")).toHaveLength(1);
    expect(() =>
      audit.append({
        version: 1,
        subjectKey: "s1",
        op: "score",
        at: createdAt,
        outcome: "ok",
        // @ts-expect-error — smuggling audio into a persisted audit record must throw.
        audio: "AAAA",
      }),
    ).toThrow();
  });

  test("audit record with a disallowed (secret-shaped) field is rejected", () => {
    expect(() =>
      assertVoiceprintAuditRecordHasNoSecrets({
        version: 1,
        subjectKey: "s1",
        op: "score",
        at: createdAt,
        outcome: "ok",
        // @ts-expect-error — smuggling an embedding must throw.
        embedding: [0.1, 0.2, 0.3],
      }),
    ).toThrow();
  });
});

describe("voiceprint consent lifecycle RPCs", () => {
  test("record_consent then get_consent reflects the persisted effective consent", async () => {
    const server = makeMockServer();
    const lifecycle = createInMemoryVoiceprintLifecycle();
    registerVoiceprintMethods(
      server as any,
      createInMemoryVoiceprintStorage(),
      undefined,
      undefined,
      undefined,
      undefined,
      lifecycle,
    );
    const conn = { sessionKey: "live:vp-consent" };

    const recorded = await server.call("identity.voiceprint.record_consent", conn, {
      scopes: ["capture", "biometric", "memoryPromotion"],
      grantedAt: createdAt,
      now: createdAt,
    });
    expect(recorded.consent.active).toBe(true);
    expect(recorded.consent.scopes.biometric).toBe(true);
    expect(recorded.consent.scopes.export).toBe(false);

    const read = await server.call("identity.voiceprint.get_consent", conn, {});
    expect(read.consent.active).toBe(true);
    expect(read.consent.scopes.capture).toBe(true);
    expect(read.history).toHaveLength(1);
    expect(read.history[0].kind).toBe("grant");
  });

  test("enroll respects the persisted consent when enforced: no consent -> rejected", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "vp-lifecycle-enroll-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    const lifecycle = createInMemoryVoiceprintLifecycle({ enforceConsentLedger: true });
    registerVoiceprintMethods(
      server as any,
      createInMemoryVoiceprintStorage(),
      undefined,
      scoring,
      undefined,
      undefined,
      lifecycle,
    );
    const conn = { sessionKey: "live:vp-lifecycle-enroll" };
    const clip = writeGoodWav(dir, "clip.wav");

    // No persisted consent yet -> enrollment rejected even though inline consent allows.
    await expect(
      server.call("identity.voiceprint.enroll_owner", conn, {
        sources: [{ audioPath: clip, startMs: 0, endMs: 40000 }],
        consent,
      }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(false);

    // Record consent, then enrollment succeeds.
    await server.call("identity.voiceprint.record_consent", conn, {
      scopes: ["capture", "biometric"],
      grantedAt: createdAt,
      now: createdAt,
    });
    const enroll = await server.call("identity.voiceprint.enroll_owner", conn, {
      sources: [{ audioPath: clip, startMs: 0, endMs: 40000 }],
      consent,
    });
    expect(enroll.status).toBe("accepted");
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(true);
  });

  test("withdraw_consent purges template + derived states, appends withdrawal + audit, is idempotent", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "vp-lifecycle-withdraw-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    const lifecycle = createInMemoryVoiceprintLifecycle();
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      scoring,
      undefined,
      undefined,
      lifecycle,
    );
    const conn = { sessionKey: "live:vp-lifecycle-withdraw" };

    await server.call("identity.voiceprint.record_consent", conn, {
      scopes: ["capture", "biometric"],
      grantedAt: createdAt,
      now: createdAt,
    });
    const clip = writeGoodWav(dir, "clip.wav");
    await server.call("identity.voiceprint.enroll_owner", conn, {
      sources: [{ audioPath: clip, startMs: 0, endMs: 40000 }],
      consent,
    });

    // Score a turn so there is a DERIVED storage state for the subject.
    const ownerAudio = writeGoodWav(dir, "owner-turn.wav");
    const scored = await server.call("identity.voiceprint.score_turns", conn, {
      turns: [
        {
          transcriptItemId: "rt_turn",
          role: "user",
          startMs: 0,
          endMs: 1500,
          audioArtifactId: "audio_turn",
          audioPath: ownerAudio,
        },
      ],
      consent,
      createdAt,
    });
    expect(scored.states[0]?.lifecycle).toBe("resolved");
    expect(storage.snapshot?.().transcriptIdentityStates.length).toBeGreaterThan(0);
    expect(storage.snapshot?.().transcriptSpeakerAnnotations.length).toBeGreaterThan(0);
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(true);

    // Withdraw -> template gone AND all derived states cleared.
    const withdraw = await server.call("identity.voiceprint.withdraw_consent", conn, {
      now: "2026-06-24T00:00:00.000Z",
    });
    expect(withdraw.templateRemoved).toBe(true);
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(false);
    // Crypto-shred: the AES-256-GCM key file is also removed so the ciphertext's
    // decryption key does not survive withdrawal.
    expect(existsSync(scoring.ownerTemplateFileSource!.keyPath)).toBe(false);
    expect(storage.snapshot?.().transcriptIdentityStates).toHaveLength(0);
    expect(storage.snapshot?.().transcriptSpeakerAnnotations).toHaveLength(0);
    expect(storage.snapshot?.().identitySignals).toHaveLength(0);

    // The prior GRANT history is preserved (append-only) even though data is erased.
    const consentAfter = await server.call("identity.voiceprint.get_consent", conn, {});
    expect(consentAfter.consent.active).toBe(false);
    expect(consentAfter.history.some((r: any) => r.kind === "grant")).toBe(true);
    expect(consentAfter.history.some((r: any) => r.kind === "withdrawal")).toBe(true);

    // Audit contains a withdraw entry.
    const audit = await server.call("identity.voiceprint.get_audit_log", conn, {});
    expect(audit.records.some((r: any) => r.op === "withdraw" && r.outcome === "ok")).toBe(true);

    // A subsequent score cannot resolve the owner (template is gone).
    await expect(
      server.call("identity.voiceprint.score_turns", conn, {
        turns: [
          {
            transcriptItemId: "rt_turn_2",
            role: "user",
            startMs: 0,
            endMs: 1500,
            audioArtifactId: "audio_turn_2",
            audioPath: ownerAudio,
          },
        ],
        consent,
        createdAt,
      }),
    ).rejects.toMatchObject({ code: "FAILED_PRECONDITION" });

    // Idempotent: withdrawing again is a no-op success (nothing left to remove).
    const withdraw2 = await server.call("identity.voiceprint.withdraw_consent", conn, {
      now: "2026-06-25T00:00:00.000Z",
    });
    expect(withdraw2.templateRemoved).toBe(false);
  });

  test("withdraw_consent evicts the in-memory realtime turn tracker + audio-artifact cache for the subject", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "vp-lifecycle-inmem-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    const lifecycle = createInMemoryVoiceprintLifecycle();
    // Explicit in-memory stores so the test can inspect residency directly.
    const realtime = createVoiceprintRealtimeSessionStore();
    const audioArtifacts = createInMemoryVoiceprintAudioArtifactStore();
    registerVoiceprintMethods(
      server as any,
      storage,
      realtime,
      scoring,
      audioArtifacts,
      undefined,
      lifecycle,
    );
    const conn = { sessionKey: "live:vp-lifecycle-inmem" };

    await server.call("identity.voiceprint.record_consent", conn, {
      scopes: ["capture", "biometric"],
      grantedAt: createdAt,
      now: createdAt,
    });
    const clip = writeGoodWav(dir, "clip.wav");
    await server.call("identity.voiceprint.enroll_owner", conn, {
      sources: [{ audioPath: clip, startMs: 0, endMs: 40000 }],
      consent,
    });

    // Register a session-keyed audio artifact (raw-audio file pointer) and drive a
    // realtime speech window so the in-memory tracker holds subject-derived state.
    const turnWav = writeGoodWav(dir, "turn.wav");
    audioArtifacts.register({
      sessionKey: conn.sessionKey,
      audioArtifactId: "a1",
      mediaId: "media-turn",
      audioPath: turnWav,
      sampleRate: 16000,
      registeredAt: createdAt,
    });
    const started = await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "input_audio_buffer.speech_started",
        speech_window_id: "w1",
        audio_start_ms: 0,
      },
    });
    expect(started.pendingSpeechWindows).toBe(1);

    // Pre-withdrawal: the audio-artifact cache resolves the raw-audio file pointer.
    const beforeResolve = audioArtifacts.resolve({
      sessionKey: conn.sessionKey,
      audioArtifactId: "a1",
    });
    expect(beforeResolve?.audioPath).toBe(turnWav);

    // Withdraw.
    await server.call("identity.voiceprint.withdraw_consent", conn, {
      now: "2026-06-26T00:00:00.000Z",
    });

    // Post-withdrawal: the audio-artifact cache no longer resolves the pointer.
    expect(
      audioArtifacts.resolve({ sessionKey: conn.sessionKey, audioArtifactId: "a1" }),
    ).toBeUndefined();

    // Post-withdrawal: the realtime tracker is evicted. Re-applying speech_started
    // with the SAME window id succeeds (a fresh tracker) rather than failing on a
    // duplicate window — proving the prior speech window / audio pointer was cleared.
    const restarted = await server.call("identity.voiceprint.realtime_event", conn, {
      event: {
        type: "input_audio_buffer.speech_started",
        speech_window_id: "w1",
        audio_start_ms: 0,
      },
    });
    expect(restarted.pendingSpeechWindows).toBe(1);
  });

  test("purge_expired destroys data older than the window and keeps fresh data", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "vp-lifecycle-retention-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    const lifecycle = createInMemoryVoiceprintLifecycle();
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      scoring,
      undefined,
      undefined,
      lifecycle,
    );
    const conn = { sessionKey: "live:vp-lifecycle-retention" };

    const grantedAt = "2026-01-01T00:00:00.000Z";
    await server.call("identity.voiceprint.record_consent", conn, {
      scopes: ["capture", "biometric"],
      grantedAt,
      now: grantedAt,
    });
    const clip = writeGoodWav(dir, "clip.wav");
    await server.call("identity.voiceprint.enroll_owner", conn, {
      sources: [{ audioPath: clip, startMs: 0, endMs: 40000 }],
      consent,
    });
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(true);

    const anchorMs = Date.parse(grantedAt);

    // Within the window -> nothing purged.
    const fresh = await server.call("identity.voiceprint.purge_expired", conn, {
      nowMs: anchorMs + DEFAULT_VOICEPRINT_RETENTION_MS - 1000,
    });
    expect(fresh.purged).toHaveLength(0);
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(true);

    // Past the window -> the subject's template is destroyed.
    const expired = await server.call("identity.voiceprint.purge_expired", conn, {
      nowMs: anchorMs + DEFAULT_VOICEPRINT_RETENTION_MS + 1000,
    });
    expect(expired.purged).toHaveLength(1);
    expect(expired.purged[0].templateRemoved).toBe(true);
    expect(existsSync(scoring.ownerTemplateFileSource!.filePath)).toBe(false);

    const audit = await server.call("identity.voiceprint.get_audit_log", conn, {});
    expect(audit.records.some((r: any) => r.op === "purge" && r.outcome === "ok")).toBe(true);
  });

  test("the audit log carries op/timestamp/outcome but NO embedding/audio/key", async () => {
    const server = makeMockServer();
    const storage = createInMemoryVoiceprintStorage();
    const dir = mkdtempSync(join(tmpdir(), "vp-lifecycle-audit-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    const lifecycle = createInMemoryVoiceprintLifecycle();
    registerVoiceprintMethods(
      server as any,
      storage,
      undefined,
      scoring,
      undefined,
      undefined,
      lifecycle,
    );
    const conn = { sessionKey: "live:vp-lifecycle-audit" };

    await server.call("identity.voiceprint.record_consent", conn, {
      scopes: ["capture", "biometric"],
      grantedAt: createdAt,
      now: createdAt,
    });
    const clip = writeGoodWav(dir, "clip.wav");
    await server.call("identity.voiceprint.enroll_owner", conn, {
      sources: [{ audioPath: clip, startMs: 0, endMs: 40000 }],
      consent,
    });
    const ownerAudio = writeGoodWav(dir, "owner-turn.wav");
    await server.call("identity.voiceprint.score_turns", conn, {
      turns: [
        {
          transcriptItemId: "rt_turn",
          role: "user",
          startMs: 0,
          endMs: 1500,
          audioArtifactId: "audio_turn",
          audioPath: ownerAudio,
        },
      ],
      consent,
      createdAt,
    });
    await server.call("identity.voiceprint.withdraw_consent", conn, {
      now: "2026-06-24T00:00:00.000Z",
    });

    const audit = await server.call("identity.voiceprint.get_audit_log", conn, {});
    // Every op emitted, each with op/at/outcome metadata.
    const ops = new Set(audit.records.map((r: any) => r.op));
    expect(ops.has("enroll")).toBe(true);
    expect(ops.has("score")).toBe(true);
    expect(ops.has("withdraw")).toBe(true);
    for (const record of audit.records) {
      expect(typeof record.op).toBe("string");
      expect(typeof record.at).toBe("string");
      expect(typeof record.outcome).toBe("string");
    }

    // Scan the SERIALIZED audit for the owner embedding vector components and the
    // encryption key material — both must be absent.
    const serialized = JSON.stringify(audit.records);
    expect(serialized).not.toContain("embedding");
    expect(serialized).not.toContain("rawKey");
    expect(serialized).not.toContain("voiceprint-lifecycle-key");
    // The owner embedding was [1,0]; a raw vector dump would contain this shape.
    expect(serialized).not.toContain("[1,0]");
    expect(serialized).not.toContain("ciphertext");
  });

  test("consent ledger is inert by default: enroll without any persisted consent still works", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "vp-lifecycle-inert-"));
    tempDirs.push(dir);
    const scriptPath = writeEnrollSidecar(dir);
    const scoring = makeScoringConfig(dir, scriptPath);
    // Default lifecycle: NOT enforcing. No record_consent call at all.
    registerVoiceprintMethods(
      server as any,
      createInMemoryVoiceprintStorage(),
      undefined,
      scoring,
    );
    const conn = { sessionKey: "live:vp-lifecycle-inert" };
    const clip = writeGoodWav(dir, "clip.wav");
    const enroll = await server.call("identity.voiceprint.enroll_owner", conn, {
      sources: [{ audioPath: clip, startMs: 0, endMs: 40000 }],
      consent,
    });
    expect(enroll.status).toBe("accepted");
  });
});

// Local sine-WAV writer (mono 16-bit PCM), matching the other voiceprint specs.
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
