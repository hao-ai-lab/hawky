import { isAbsolute, resolve } from "node:path";
import { MethodError } from "./methods.js";
import { getConfigDir } from "../storage/config.js";
import type { VoiceprintAudioQualityThresholds } from "../identity/voiceprint/index.js";

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function configString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${field} is required.`);
  }
  return value.trim();
}

export function optionalConfigString(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("Expected a string.");
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function configBoolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${field} must be a boolean.`);
  }
  return value;
}

export function optionalBoolean(value: unknown): boolean | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error("Expected a boolean.");
  }
  return value;
}

export function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number.`);
  }
  return value;
}

export function optionalPositiveNumber(value: unknown, field: string): number | undefined {
  const number = optionalNumber(value, field);
  if (number !== undefined && number <= 0) {
    throw new Error(`${field} must be a positive number.`);
  }
  return number;
}

export function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${field} must be an array of strings.`);
  }
  return value.map((item, index) => configString(item, `${field}[${index}]`));
}

export function optionalStringRecord(
  value: unknown,
  field: string,
): Record<string, string> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object.`);
  }
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!key.trim()) {
      throw new Error(`${field} contains an empty key.`);
    }
    out[key] = configString(item, `${field}.${key}`);
  }
  return out;
}

export function configPath(value: unknown, field: string): string {
  return resolveConfigPath(configString(value, field));
}

export function optionalConfigPath(value: unknown): string | undefined {
  const path = optionalConfigString(value);
  return path ? resolveConfigPath(path) : undefined;
}

export function resolveConfigPath(path: string): string {
  return isAbsolute(path) ? path : resolve(getConfigDir(), path);
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new MethodError("INVALID_REQUEST", `${field} is required.`);
  }
  return value.trim();
}

export function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export function requiredFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new MethodError("INVALID_REQUEST", `${field} must be a finite number.`);
  }
  return value;
}

export function optionalNonNegativeFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MethodError("INVALID_REQUEST", `${field} must be a non-negative finite number.`);
  }
  return value;
}

export function optionalPositiveFiniteNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new MethodError("INVALID_REQUEST", `${field} must be a positive finite number.`);
  }
  return value;
}

export function validateVoiceprintQualityThresholds(
  thresholds: VoiceprintAudioQualityThresholds,
  field: string,
): void {
  for (const [key, value] of Object.entries(thresholds)) {
    optionalNonNegativeFiniteNumber(value, `${field}.${key}`);
  }
  if (thresholds.targetDurationMs < thresholds.minDurationMs) {
    throw new MethodError(
      "INVALID_REQUEST",
      `${field}.targetDurationMs must be greater than or equal to minDurationMs.`,
    );
  }
  if (thresholds.targetRms < thresholds.minRms) {
    throw new MethodError(
      "INVALID_REQUEST",
      `${field}.targetRms must be greater than or equal to minRms.`,
    );
  }
}

export function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new MethodError("INVALID_REQUEST", "Expected an object.");
  }
  return value as Record<string, unknown>;
}
