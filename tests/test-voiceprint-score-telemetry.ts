import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  aggregateVoiceprintScoreTelemetry,
  assertVoiceprintScoreTelemetryHasNoSecrets,
  hashVoiceprintSessionRef,
  type VoiceprintScoreTelemetryRecord,
} from "../src/identity/voiceprint/index.js";
import {
  createInMemoryVoiceprintStorage,
  registerVoiceprintMethods,
  type VoiceprintLiveScoringConfig,
} from "../src/gateway/voiceprint-methods.js";
import {
  createFileVoiceprintScoreTelemetrySink,
  createInMemoryVoiceprintLifecycle,
  createInMemoryVoiceprintScoreTelemetrySink,
  resolveVoiceprintScoreTelemetrySinkFromConfig,
} from "../src/gateway/voiceprint-lifecycle.js";

// A7 — Privacy-safe scoring-DECISION telemetry.
//
// The telemetry records the scalar SCORE + decision + threshold + model per scoring
// decision so operators can watch decision drift and build the score DISTRIBUTION
// for later threshold calibration. It NEVER records a biometric vector, raw audio,
// or an encryption key. It is OFF by default (a no-op sink) so existing scoring is
// byte-for-byte unchanged.

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
      keyRef: "voiceprint-telemetry-key",
      createKeyIfMissing: true,
    },
    allowedAudioRoots: [dir],
    consent,
    expectedModel: enrollModel,
  };
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

function writeGoodWav(dir: string, name: string): string {
  const path = join(dir, name);
  writeSineWav(path, 16000, 1500, 0.16);
  return path;
}

async function enrollOwner(server: ReturnType<typeof makeMockServer>, conn: any, dir: string) {
  const clip = writeGoodWav(dir, "enroll.wav");
  await server.call("identity.voiceprint.enroll_owner", conn, {
    sources: [{ audioPath: clip, startMs: 0, endMs: 40000 }],
    consent,
  });
}

function scoreTurnParams(audioPath: string, transcriptItemId: string, audioArtifactId: string) {
  return {
    turns: [
      {
        transcriptItemId,
        role: "user",
        startMs: 0,
        endMs: 1500,
        audioArtifactId,
        audioPath,
      },
    ],
    consent,
    createdAt,
  };
}

// ── Pure core: guard + histograms ────────────────────────────────────────────

describe("voiceprint score telemetry (pure core)", () => {
  test("no-secrets guard rejects a record smuggling an embedding", () => {
    expect(() =>
      assertVoiceprintScoreTelemetryHasNoSecrets({
        version: 1,
        op: "score",
        at: createdAt,
        outcome: "scored",
        sessionRef: "vpref_abc",
        decision: "owner_speaking",
        score: 0.9,
        thresholdUsed: 0.82,
        // @ts-expect-error — smuggling an embedding vector must throw.
        embedding: [0.1, 0.2, 0.3],
      }),
    ).toThrow();
  });

  test("no-secrets guard rejects a vector smuggled as the score scalar", () => {
    expect(() =>
      assertVoiceprintScoreTelemetryHasNoSecrets({
        version: 1,
        op: "score",
        at: createdAt,
        outcome: "scored",
        sessionRef: "vpref_abc",
        decision: "owner_speaking",
        // @ts-expect-error — score must be a finite scalar, not an array.
        score: [0.1, 0.2, 0.3],
        thresholdUsed: 0.82,
      }),
    ).toThrow();
  });

  test("no-secrets guard rejects a record whose decision is out of the enum", () => {
    // A tampered/loaded record with an out-of-enum decision must be rejected AT THE
    // READ BOUNDARY, otherwise it survives the guard and blows up later inside
    // aggregateVoiceprintScoreTelemetry (histograms[decision] === undefined).
    expect(() =>
      assertVoiceprintScoreTelemetryHasNoSecrets({
        version: 1,
        op: "score",
        at: createdAt,
        outcome: "scored",
        sessionRef: "vpref_abc",
        // @ts-expect-error — decision must be one of the three known classes.
        decision: "garbage",
        score: 0.9,
        thresholdUsed: 0.82,
      }),
    ).toThrow();
  });

  test("histogram aggregates multiple decisions into per-class bins", () => {
    const records: VoiceprintScoreTelemetryRecord[] = [
      makeScored("owner_speaking", 0.9),
      makeScored("owner_speaking", 0.95),
      makeScored("possible_owner", 0.76),
      makeScored("unknown_speaker", -0.3),
      { version: 1, op: "score", at: createdAt, outcome: "skipped", sessionRef: "s", reason: "quality_rejected" },
      { version: 1, op: "score", at: createdAt, outcome: "error", sessionRef: "s", reason: "sidecar_failed" },
    ];
    const agg = aggregateVoiceprintScoreTelemetry(records);
    expect(agg.total).toBe(6);
    expect(agg.decisionCounts.owner_speaking).toBe(2);
    expect(agg.decisionCounts.possible_owner).toBe(1);
    expect(agg.decisionCounts.unknown_speaker).toBe(1);
    expect(agg.outcomeCounts.scored).toBe(4);
    expect(agg.outcomeCounts.skipped).toBe(1);
    expect(agg.outcomeCounts.error).toBe(1);
    // Both owner-speaking scores fold into the owner histogram (count === 2) and
    // land in the high end of [-1, 1] (last two bins).
    expect(agg.histograms.owner_speaking.count).toBe(2);
    expect(agg.histograms.owner_speaking.bins.reduce((a, b) => a + b, 0)).toBe(2);
    expect(agg.histograms.owner_speaking.bins[18]! + agg.histograms.owner_speaking.bins[19]!).toBe(2);
    // A skipped/error record never contributes a bin.
    expect(agg.histograms.unknown_speaker.count).toBe(1);
  });
});

function makeScored(
  decision: "owner_speaking" | "possible_owner" | "unknown_speaker",
  score: number,
): VoiceprintScoreTelemetryRecord {
  return {
    version: 1,
    op: "score",
    at: createdAt,
    outcome: "scored",
    sessionRef: "s",
    decision,
    score,
    thresholdUsed: decision === "owner_speaking" ? 0.82 : 0.72,
    modelProvider: "custom",
    modelId: "enroll-sidecar",
  };
}

// ── Sinks ─────────────────────────────────────────────────────────────────────

describe("voiceprint score telemetry sinks", () => {
  test("no-op sink from unconfigured config records nothing (OFF by default)", () => {
    const sink = resolveVoiceprintScoreTelemetrySinkFromConfig(undefined);
    expect(sink.enabled).toBe(false);
    sink.record(makeScored("owner_speaking", 0.9));
    expect(sink.read()).toHaveLength(0);
    expect(sink.aggregate().total).toBe(0);
  });

  test("no-op sink still rejects a record carrying a secret", () => {
    const sink = resolveVoiceprintScoreTelemetrySinkFromConfig({ enabled: false });
    expect(() =>
      sink.record({
        version: 1,
        op: "score",
        at: createdAt,
        outcome: "scored",
        sessionRef: "s",
        // @ts-expect-error — an audio blob must be rejected even by the no-op sink.
        audio: "AAAA",
      }),
    ).toThrow();
  });

  test("file-backed sink round-trips and re-validates on read", () => {
    const dir = mkdtempSync(join(tmpdir(), "vp-telemetry-file-"));
    tempDirs.push(dir);
    const filePath = join(dir, "score-telemetry.json");
    const sink = createFileVoiceprintScoreTelemetrySink({ filePath });
    sink.record(makeScored("owner_speaking", 0.9));
    sink.record(makeScored("unknown_speaker", -0.2));

    // A fresh instance over the same file sees both records + aggregates them.
    const reopened = createFileVoiceprintScoreTelemetrySink({ filePath });
    expect(reopened.read()).toHaveLength(2);
    expect(reopened.aggregate().decisionCounts.owner_speaking).toBe(1);

    // A tampered file that smuggled a vector is rejected on read.
    writeFileSync(
      filePath,
      JSON.stringify({
        version: 1,
        records: [
          { version: 1, op: "score", at: createdAt, outcome: "scored", sessionRef: "s", embedding: [1, 2, 3] },
        ],
      }),
      "utf8",
    );
    expect(() => createFileVoiceprintScoreTelemetrySink({ filePath }).read()).toThrow();
  });
});

// ── End-to-end via score_turns RPC ───────────────────────────────────────────

describe("voiceprint score telemetry via score_turns", () => {
  test("OFF by default: scoring works and NOTHING is recorded", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "vp-telemetry-off-"));
    tempDirs.push(dir);
    const scoring = makeScoringConfig(dir, writeEnrollSidecar(dir));
    // Default lifecycle => no-op telemetry sink.
    const lifecycle = createInMemoryVoiceprintLifecycle();
    expect(lifecycle.scoreTelemetry.enabled).toBe(false);
    registerVoiceprintMethods(
      server as any,
      createInMemoryVoiceprintStorage(),
      undefined,
      scoring,
      undefined,
      undefined,
      lifecycle,
    );
    const conn = { sessionKey: "live:vp-telemetry-off" };
    await enrollOwner(server, conn, dir);

    const owner = writeGoodWav(dir, "owner-turn.wav");
    const scored = await server.call(
      "identity.voiceprint.score_turns",
      conn,
      scoreTurnParams(owner, "rt_turn", "audio_turn"),
    );
    // Scoring itself is unchanged (a real decision was produced).
    expect(scored.states[0]?.lifecycle).toBe("resolved");

    // Telemetry recorded nothing.
    const telemetry = await server.call("identity.voiceprint.get_score_telemetry", conn, {});
    expect(telemetry.enabled).toBe(false);
    expect(telemetry.records).toHaveLength(0);
    expect(telemetry.total).toBe(0);
  });

  test("ON: a scored owner turn emits a record with decision+score+threshold+model and NO vector/audio/key", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "vp-telemetry-on-"));
    tempDirs.push(dir);
    const scoring = makeScoringConfig(dir, writeEnrollSidecar(dir));
    const lifecycle = createInMemoryVoiceprintLifecycle({
      scoreTelemetry: createInMemoryVoiceprintScoreTelemetrySink(),
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
    const conn = { sessionKey: "live:vp-telemetry-on" };
    await enrollOwner(server, conn, dir);

    const owner = writeGoodWav(dir, "owner-turn.wav");
    await server.call(
      "identity.voiceprint.score_turns",
      conn,
      scoreTurnParams(owner, "rt_turn", "audio_turn"),
    );

    const telemetry = await server.call("identity.voiceprint.get_score_telemetry", conn, {});
    expect(telemetry.enabled).toBe(true);
    expect(telemetry.records.length).toBeGreaterThan(0);
    const record = telemetry.records[0];
    expect(record.outcome).toBe("scored");
    expect(record.decision).toBe("owner_speaking");
    expect(typeof record.score).toBe("number");
    expect(typeof record.thresholdUsed).toBe("number");
    expect(record.modelProvider).toBe("custom");
    expect(record.modelId).toBe("enroll-sidecar");

    // sessionRef is OPAQUE — the hash, not the raw sessionKey.
    expect(record.sessionRef).toBe(hashVoiceprintSessionRef(conn.sessionKey));
    expect(record.sessionRef).not.toBe(conn.sessionKey);

    // The histogram counts the owner_speaking decision.
    expect(telemetry.decisionCounts.owner_speaking).toBe(1);
    expect(telemetry.histograms.owner_speaking.count).toBe(1);

    // SECURITY: scan the serialized TELEMETRY (records + histograms — the persisted
    // artifact) for any vector/audio/key. The response envelope echoes the request's
    // raw sessionKey for routing (as every voiceprint RPC does), but the telemetry
    // ITSELF only ever carries the opaque sessionRef.
    const serialized = JSON.stringify({
      records: telemetry.records,
      histograms: telemetry.histograms,
    });
    expect(serialized).not.toContain("embedding");
    expect(serialized).not.toContain("audio");
    expect(serialized).not.toMatch(/"key"/i);
    // The raw sessionKey (potential PII) must not appear inside the telemetry.
    expect(serialized).not.toContain(conn.sessionKey);
    // No array-shaped score field (a vector) leaked into any record.
    for (const r of telemetry.records) {
      expect(Array.isArray((r as any).score)).toBe(false);
    }
  });

  test("ON: a turn skipped WITHIN a run emits a scoreless `skipped` record (skip counts are not undercounted)", async () => {
    const server = makeMockServer();
    const dir = mkdtempSync(join(tmpdir(), "vp-telemetry-skip-"));
    tempDirs.push(dir);
    const scoring = makeScoringConfig(dir, writeEnrollSidecar(dir));
    const lifecycle = createInMemoryVoiceprintLifecycle({
      scoreTelemetry: createInMemoryVoiceprintScoreTelemetrySink(),
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
    const conn = { sessionKey: "live:vp-telemetry-skip" };
    await enrollOwner(server, conn, dir);

    // One real user turn (scored) plus one assistant turn (skipped as non_user_turn
    // WITHIN a successful/partial run — never a whole-batch error).
    const owner = writeGoodWav(dir, "owner-turn.wav");
    await server.call("identity.voiceprint.score_turns", conn, {
      turns: [
        {
          transcriptItemId: "rt_user",
          role: "user",
          startMs: 0,
          endMs: 1500,
          audioArtifactId: "audio_user",
          audioPath: owner,
        },
        {
          transcriptItemId: "rt_assistant",
          role: "assistant",
          startMs: 0,
          endMs: 1500,
        },
      ],
      consent,
      createdAt,
    });

    const telemetry = await server.call("identity.voiceprint.get_score_telemetry", conn, {});
    expect(telemetry.enabled).toBe(true);
    // The scored turn AND the skipped turn each produced a record.
    expect(telemetry.outcomeCounts.scored).toBe(1);
    expect(telemetry.outcomeCounts.skipped).toBe(1);
    const skippedRecord = telemetry.records.find((r: any) => r.outcome === "skipped");
    expect(skippedRecord).toBeDefined();
    expect(skippedRecord.reason).toBe("non_user_turn");
    // Skip path carries NO bogus score/decision.
    expect(skippedRecord.score).toBeUndefined();
    expect(skippedRecord.decision).toBeUndefined();
    // sessionRef is still the opaque hash on the skip record.
    expect(skippedRecord.sessionRef).toBe(hashVoiceprintSessionRef(conn.sessionKey));
  });
});
