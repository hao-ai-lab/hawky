import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { dirname } from "node:path";
import type { IsoTime } from "./contracts.js";
import {
  validateVoiceprintTemplate,
  validateVoiceprintTemplateArtifact,
  type VoiceprintTemplate,
  type VoiceprintTemplateArtifact,
} from "./template.js";
import { validateIsoLikeTime as validateIsoLikeTimeShared } from "./live-validators.js";

const VOICEPRINT_TEMPLATE_FILE_MODE = 0o600;
const VOICEPRINT_TEMPLATE_KEY_BYTES = 32;
const VOICEPRINT_TEMPLATE_IV_BYTES = 12;
const VOICEPRINT_TEMPLATE_TAG_BYTES = 16;
const VOICEPRINT_TEMPLATE_CIPHER = "aes-256-gcm";

export interface VoiceprintTemplateEncryptionKey {
  keyRef: string;
  rawKey: Uint8Array;
}

export interface VoiceprintTemplateFileRef {
  filePath: string;
  key: VoiceprintTemplateEncryptionKey;
  expectedKeyRef?: string;
}

export interface VoiceprintTemplateFileSource {
  filePath: string;
  keyPath: string;
  keyRef?: string;
  createKeyIfMissing?: boolean;
}

export interface VoiceprintTemplateEncryptionKeyFile {
  version: 1;
  createdAt: IsoTime;
  keyRef: string;
  rawKey: string;
}

export interface EncryptedVoiceprintTemplateArtifactFile {
  version: 1;
  updatedAt: IsoTime;
  template: VoiceprintTemplate;
  encryption: {
    algorithm: "aes-256-gcm";
    keyRef: string;
    iv: string;
    tag: string;
  };
  ciphertext: string;
}

export function writeVoiceprintTemplateEncryptionKeyFile(input: {
  filePath: string;
  key: VoiceprintTemplateEncryptionKey;
  createdAt?: IsoTime;
}): VoiceprintTemplateEncryptionKeyFile {
  const key = normalizeVoiceprintTemplateEncryptionKey(input.key);
  const createdAt = input.createdAt ?? new Date().toISOString();
  validateIsoLikeTime(createdAt, "createdAt");
  const file: VoiceprintTemplateEncryptionKeyFile = {
    version: 1,
    createdAt,
    keyRef: key.keyRef,
    rawKey: key.rawKey.toString("base64url"),
  };
  writeRestrictedJsonFile(input.filePath, file);
  return file;
}

export function readVoiceprintTemplateEncryptionKeyFile(
  filePath: string,
): VoiceprintTemplateEncryptionKey {
  const file = parseVoiceprintTemplateEncryptionKeyFile(
    JSON.parse(readFileSync(filePath, "utf8")),
  );
  return {
    keyRef: file.keyRef,
    rawKey: decodeBase64url(file.rawKey, "rawKey", VOICEPRINT_TEMPLATE_KEY_BYTES),
  };
}

export function loadOrCreateVoiceprintTemplateEncryptionKey(input: {
  filePath: string;
  keyRef?: string;
  createIfMissing?: boolean;
  createdAt?: IsoTime;
}): VoiceprintTemplateEncryptionKey {
  if (existsSync(input.filePath)) {
    const key = readVoiceprintTemplateEncryptionKeyFile(input.filePath);
    if (input.keyRef && key.keyRef !== input.keyRef) {
      throw new Error("Voiceprint template key file keyRef does not match expected keyRef.");
    }
    return key;
  }

  if (input.createIfMissing === false) {
    throw new Error("Voiceprint template key file does not exist.");
  }
  const keyRef = input.keyRef?.trim();
  if (!keyRef) {
    throw new Error("Voiceprint template key creation requires keyRef.");
  }
  const key: VoiceprintTemplateEncryptionKey = {
    keyRef,
    rawKey: randomBytes(VOICEPRINT_TEMPLATE_KEY_BYTES),
  };
  writeVoiceprintTemplateEncryptionKeyFile({
    filePath: input.filePath,
    key,
    createdAt: input.createdAt,
  });
  return key;
}

export function voiceprintTemplateFileRefFromSource(
  source: VoiceprintTemplateFileSource,
): VoiceprintTemplateFileRef {
  const key = loadOrCreateVoiceprintTemplateEncryptionKey({
    filePath: source.keyPath,
    keyRef: source.keyRef,
    createIfMissing: source.createKeyIfMissing,
  });
  return {
    filePath: source.filePath,
    key,
    expectedKeyRef: source.keyRef ?? key.keyRef,
  };
}

export function writeEncryptedVoiceprintTemplateArtifact(input: {
  filePath: string;
  artifact: VoiceprintTemplateArtifact;
  key: VoiceprintTemplateEncryptionKey;
  updatedAt?: IsoTime;
}): EncryptedVoiceprintTemplateArtifactFile {
  validateVoiceprintTemplateArtifact(input.artifact);
  const key = normalizeVoiceprintTemplateEncryptionKey(input.key);
  if (input.artifact.template.storage.keyRef !== key.keyRef) {
    throw new Error("Voiceprint template encryption keyRef does not match template storage.");
  }

  const updatedAt = input.updatedAt ?? new Date().toISOString();
  validateIsoLikeTime(updatedAt, "updatedAt");
  const iv = randomBytes(VOICEPRINT_TEMPLATE_IV_BYTES);
  const cipher = createCipheriv(VOICEPRINT_TEMPLATE_CIPHER, key.rawKey, iv);
  cipher.setAAD(templateFileAdditionalData(input.artifact.template.id, key.keyRef));
  const plaintext = Buffer.from(JSON.stringify(input.artifact), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  const file: EncryptedVoiceprintTemplateArtifactFile = {
    version: 1,
    updatedAt,
    template: input.artifact.template,
    encryption: {
      algorithm: VOICEPRINT_TEMPLATE_CIPHER,
      keyRef: key.keyRef,
      iv: iv.toString("base64url"),
      tag: tag.toString("base64url"),
    },
    ciphertext: ciphertext.toString("base64url"),
  };

  writeRestrictedJsonFile(input.filePath, file);
  return file;
}

export function readEncryptedVoiceprintTemplateArtifact(
  ref: VoiceprintTemplateFileRef,
): VoiceprintTemplateArtifact {
  const key = normalizeVoiceprintTemplateEncryptionKey(ref.key);
  const file = parseEncryptedVoiceprintTemplateArtifactFile(
    JSON.parse(readFileSync(ref.filePath, "utf8")),
  );
  if (ref.expectedKeyRef && file.encryption.keyRef !== ref.expectedKeyRef) {
    throw new Error("Voiceprint template keyRef does not match expected keyRef.");
  }
  if (file.encryption.keyRef !== key.keyRef) {
    throw new Error("Voiceprint template encryption keyRef does not match provided key.");
  }

  const decipher = createDecipheriv(
    VOICEPRINT_TEMPLATE_CIPHER,
    key.rawKey,
    decodeBase64url(file.encryption.iv, "encryption.iv", VOICEPRINT_TEMPLATE_IV_BYTES),
  );
  decipher.setAAD(templateFileAdditionalData(file.template.id, file.encryption.keyRef));
  decipher.setAuthTag(
    decodeBase64url(file.encryption.tag, "encryption.tag", VOICEPRINT_TEMPLATE_TAG_BYTES),
  );
  const plaintext = Buffer.concat([
    decipher.update(decodeBase64url(file.ciphertext, "ciphertext")),
    decipher.final(),
  ]).toString("utf8");
  const artifact = JSON.parse(plaintext) as VoiceprintTemplateArtifact;
  validateVoiceprintTemplateArtifact(artifact);

  if (artifact.template.id !== file.template.id) {
    throw new Error("Voiceprint template artifact id does not match file metadata.");
  }
  if (artifact.template.storage.keyRef !== file.encryption.keyRef) {
    throw new Error("Voiceprint template artifact keyRef does not match file metadata.");
  }
  return artifact;
}

export function parseVoiceprintTemplateEncryptionKeyFile(
  value: unknown,
): VoiceprintTemplateEncryptionKeyFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Voiceprint template key file must be an object.");
  }
  const file = value as Partial<VoiceprintTemplateEncryptionKeyFile>;
  if (file.version !== 1) {
    throw new Error("Voiceprint template key file version must be 1.");
  }
  if (!file.createdAt || typeof file.createdAt !== "string") {
    throw new Error("Voiceprint template key file requires createdAt.");
  }
  validateIsoLikeTime(file.createdAt, "createdAt");
  if (!file.keyRef?.trim()) {
    throw new Error("Voiceprint template key file requires keyRef.");
  }
  decodeBase64url(file.rawKey, "rawKey", VOICEPRINT_TEMPLATE_KEY_BYTES);
  return file as VoiceprintTemplateEncryptionKeyFile;
}

export function parseEncryptedVoiceprintTemplateArtifactFile(
  value: unknown,
): EncryptedVoiceprintTemplateArtifactFile {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Voiceprint template file must be an object.");
  }
  const file = value as Partial<EncryptedVoiceprintTemplateArtifactFile>;
  if (file.version !== 1) {
    throw new Error("Voiceprint template file version must be 1.");
  }
  if (!file.updatedAt || typeof file.updatedAt !== "string") {
    throw new Error("Voiceprint template file requires updatedAt.");
  }
  validateIsoLikeTime(file.updatedAt, "updatedAt");
  if (!file.template || typeof file.template !== "object" || Array.isArray(file.template)) {
    throw new Error("Voiceprint template file requires template metadata.");
  }
  validateVoiceprintTemplate(file.template as VoiceprintTemplate);
  if (
    !file.encryption ||
    typeof file.encryption !== "object" ||
    Array.isArray(file.encryption)
  ) {
    throw new Error("Voiceprint template file requires encryption metadata.");
  }
  if (file.encryption.algorithm !== VOICEPRINT_TEMPLATE_CIPHER) {
    throw new Error("Voiceprint template file encryption algorithm is unsupported.");
  }
  if (!file.encryption.keyRef?.trim()) {
    throw new Error("Voiceprint template file encryption requires keyRef.");
  }
  decodeBase64url(file.encryption.iv, "encryption.iv", VOICEPRINT_TEMPLATE_IV_BYTES);
  decodeBase64url(file.encryption.tag, "encryption.tag", VOICEPRINT_TEMPLATE_TAG_BYTES);
  decodeBase64url(file.ciphertext, "ciphertext");
  return file as EncryptedVoiceprintTemplateArtifactFile;
}

function normalizeVoiceprintTemplateEncryptionKey(
  key: VoiceprintTemplateEncryptionKey,
): { keyRef: string; rawKey: Buffer } {
  const keyRef = key.keyRef.trim();
  if (!keyRef) {
    throw new Error("Voiceprint template encryption key requires keyRef.");
  }
  const rawKey = Buffer.from(key.rawKey);
  if (rawKey.length !== VOICEPRINT_TEMPLATE_KEY_BYTES) {
    throw new Error(
      `Voiceprint template encryption key must be ${VOICEPRINT_TEMPLATE_KEY_BYTES} bytes.`,
    );
  }
  return { keyRef, rawKey };
}

function templateFileAdditionalData(templateId: string, keyRef: string): Buffer {
  return Buffer.from(`voiceprint-template:v1:${templateId}:${keyRef}`, "utf8");
}

function writeRestrictedJsonFile(
  filePath: string,
  file: unknown,
): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, {
      encoding: "utf8",
      mode: VOICEPRINT_TEMPLATE_FILE_MODE,
    });
    renameSync(tmp, filePath);
    try {
      chmodSync(filePath, VOICEPRINT_TEMPLATE_FILE_MODE);
    } catch {
      // Non-fatal on platforms that do not support chmod.
    }
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // Best-effort cleanup after a failed atomic write.
    }
    throw error;
  }
}

function decodeBase64url(value: unknown, field: string, expectedBytes?: number): Buffer {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Voiceprint template file ${field} must be a base64url string.`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`Voiceprint template file ${field} must be a valid base64url string.`);
  }
  const buffer = Buffer.from(value, "base64url");
  if (expectedBytes !== undefined && buffer.length !== expectedBytes) {
    throw new Error(
      `Voiceprint template file ${field} must decode to ${expectedBytes} bytes.`,
    );
  }
  if (expectedBytes === undefined && buffer.length === 0) {
    throw new Error(`Voiceprint template file ${field} must not be empty.`);
  }
  return buffer;
}

function validateIsoLikeTime(value: string, field: string): void {
  validateIsoLikeTimeShared(value, "Voiceprint template file", field);
}
