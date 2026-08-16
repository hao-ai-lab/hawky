import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import {
  buildVoiceprintTemplateArtifact,
  loadOrCreateVoiceprintTemplateEncryptionKey,
  parseEncryptedVoiceprintTemplateArtifactFile,
  parseVoiceprintTemplateEncryptionKeyFile,
  readEncryptedVoiceprintTemplateArtifact,
  readVoiceprintTemplateEncryptionKeyFile,
  voiceprintTemplateFileRefFromSource,
  writeEncryptedVoiceprintTemplateArtifact,
  writeVoiceprintTemplateEncryptionKeyFile,
  type VoiceprintTemplateEncryptionKey,
} from "../src/identity/voiceprint/index.js";

const createdAt = "2026-06-24T00:00:00.000Z";
const model = {
  provider: "custom" as const,
  modelId: "template-store-test-model",
  version: "1",
};
const key: VoiceprintTemplateEncryptionKey = {
  keyRef: "voiceprint-template-store-key",
  rawKey: Buffer.alloc(32, 11),
};
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("voiceprint encrypted template store", () => {
  test("writes and reloads restricted local template key files", () => {
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-template-store-"));
    tempDirs.push(dir);
    const keyPath = join(dir, "owner-template.key.json");

    const written = writeVoiceprintTemplateEncryptionKeyFile({
      filePath: keyPath,
      key,
      createdAt,
    });
    const raw = readFileSync(keyPath, "utf8");
    const parsed = parseVoiceprintTemplateEncryptionKeyFile(JSON.parse(raw));
    const reloaded = readVoiceprintTemplateEncryptionKeyFile(keyPath);

    expect(written.keyRef).toBe(key.keyRef);
    expect(parsed.keyRef).toBe(key.keyRef);
    expect(Buffer.from(reloaded.rawKey)).toEqual(Buffer.from(key.rawKey));
    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(raw).not.toContain(Buffer.from(key.rawKey).toString("hex"));
  });

  test("loads or creates local template key files for source refs", () => {
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-template-store-"));
    tempDirs.push(dir);
    const keyPath = join(dir, "owner-template.key.json");
    const templatePath = join(dir, "owner-template.enc.json");

    const created = loadOrCreateVoiceprintTemplateEncryptionKey({
      filePath: keyPath,
      keyRef: "created-template-key",
      createdAt,
    });
    const reloaded = loadOrCreateVoiceprintTemplateEncryptionKey({
      filePath: keyPath,
      keyRef: "created-template-key",
      createIfMissing: false,
    });
    const sourceRef = voiceprintTemplateFileRefFromSource({
      filePath: templatePath,
      keyPath,
      keyRef: "created-template-key",
      createKeyIfMissing: false,
    });

    expect(Buffer.from(created.rawKey)).toHaveLength(32);
    expect(Buffer.from(reloaded.rawKey)).toEqual(Buffer.from(created.rawKey));
    expect(sourceRef.filePath).toBe(templatePath);
    expect(sourceRef.expectedKeyRef).toBe("created-template-key");
    expect(Buffer.from(sourceRef.key.rawKey)).toEqual(Buffer.from(created.rawKey));
    expect(() =>
      loadOrCreateVoiceprintTemplateEncryptionKey({
        filePath: keyPath,
        keyRef: "wrong-key-ref",
        createIfMissing: false,
      }),
    ).toThrow(/keyRef/);
  });

  test("rejects malformed local template key files", () => {
    expect(() =>
      parseVoiceprintTemplateEncryptionKeyFile({
        version: 1,
        createdAt,
        keyRef: "bad-key",
        rawKey: Buffer.alloc(16, 1).toString("base64url"),
      }),
    ).toThrow(/32 bytes/);
    expect(() =>
      loadOrCreateVoiceprintTemplateEncryptionKey({
        filePath: join(tmpdir(), "missing-voiceprint-template-key.json"),
        createIfMissing: false,
      }),
    ).toThrow(/does not exist/);
  });

  test("writes and reads local encrypted owner template artifacts", () => {
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-template-store-"));
    tempDirs.push(dir);
    const filePath = join(dir, "owner-template.enc.json");
    const artifact = makeArtifact();

    const written = writeEncryptedVoiceprintTemplateArtifact({
      filePath,
      artifact,
      key,
      updatedAt: createdAt,
    });
    const raw = readFileSync(filePath, "utf8");
    const parsed = parseEncryptedVoiceprintTemplateArtifactFile(JSON.parse(raw));
    const reloaded = readEncryptedVoiceprintTemplateArtifact({
      filePath,
      key,
      expectedKeyRef: key.keyRef,
    });

    expect(written.template.id).toBe(artifact.template.id);
    expect(parsed.template.id).toBe(artifact.template.id);
    expect(reloaded).toEqual(artifact);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
    expect(raw).not.toContain("\"centroid\"");
    expect(raw).not.toContain("0.99");
  });

  test("rejects wrong keys and tampered template metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "voiceprint-template-store-"));
    tempDirs.push(dir);
    const filePath = join(dir, "owner-template.enc.json");
    const artifact = makeArtifact();
    writeEncryptedVoiceprintTemplateArtifact({
      filePath,
      artifact,
      key,
      updatedAt: createdAt,
    });

    expect(() =>
      readEncryptedVoiceprintTemplateArtifact({
        filePath,
        key: { ...key, rawKey: Buffer.alloc(32, 12) },
      }),
    ).toThrow();
    expect(() =>
      readEncryptedVoiceprintTemplateArtifact({
        filePath,
        key: { ...key, keyRef: "wrong-key-ref" },
      }),
    ).toThrow(/keyRef/);

    const tampered = JSON.parse(readFileSync(filePath, "utf8"));
    tampered.template.id = "tampered-template";
    writeFileSync(filePath, `${JSON.stringify(tampered, null, 2)}\n`, "utf8");

    expect(() =>
      readEncryptedVoiceprintTemplateArtifact({
        filePath,
        key,
      }),
    ).toThrow();
  });

  test("rejects malformed encrypted template files", () => {
    expect(() =>
      parseEncryptedVoiceprintTemplateArtifactFile({
        version: 1,
        updatedAt: createdAt,
        template: makeArtifact().template,
        encryption: {
          algorithm: "none",
          keyRef: key.keyRef,
          iv: "bad",
          tag: "bad",
        },
        ciphertext: "bad",
      }),
    ).toThrow(/unsupported/);
  });
});

function makeArtifact() {
  return buildVoiceprintTemplateArtifact({
    model,
    sources: [
      {
        artifactId: "store_enroll_1",
        embedding: [1, 0],
        speechMs: 1500,
        route: "iphone_mic",
      },
      {
        artifactId: "store_enroll_2",
        embedding: [0.98, 0.02],
        speechMs: 1500,
        route: "iphone_mic",
      },
    ],
    storage: {
      templateUri: "local-voiceprint://owner/template-store-test.enc",
      encrypted: true,
      localOnly: true,
      keyRef: key.keyRef,
    },
    createdAt,
    minSpeechMs: 1000,
  });
}
