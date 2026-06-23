import { describe, it, expect, beforeEach } from "vitest";
import {
  loadByokKey,
  saveByokKey,
  clearByokKey,
  looksLikeOpenAIKey,
  maskKey,
  byokParam,
} from "../src/lib/byok";

const VALID = "sk-proj-abcdefghijklmnopqrstuvwxyz0123";

beforeEach(() => {
  localStorage.clear();
});

describe("byok storage", () => {
  it("round-trips a key through save/load", () => {
    expect(loadByokKey()).toBe("");
    saveByokKey(VALID);
    expect(loadByokKey()).toBe(VALID);
  });

  it("trims whitespace on save", () => {
    saveByokKey(`  ${VALID}  `);
    expect(loadByokKey()).toBe(VALID);
  });

  it("clears the key when saving blank", () => {
    saveByokKey(VALID);
    saveByokKey("   ");
    expect(loadByokKey()).toBe("");
  });

  it("clearByokKey removes the key", () => {
    saveByokKey(VALID);
    clearByokKey();
    expect(loadByokKey()).toBe("");
  });
});

describe("byok validation + masking", () => {
  it("recognizes OpenAI-shaped keys", () => {
    expect(looksLikeOpenAIKey(VALID)).toBe(true);
    expect(looksLikeOpenAIKey("sk-short")).toBe(false);
    expect(looksLikeOpenAIKey("nope")).toBe(false);
    expect(looksLikeOpenAIKey("")).toBe(false);
  });

  it("masks the middle of a key, keeping prefix + last 4", () => {
    const masked = maskKey(VALID);
    expect(masked.startsWith("sk-")).toBe(true);
    expect(masked.endsWith(VALID.slice(-4))).toBe(true);
    expect(masked).toContain("•");
    // The full key must never appear in the masked form.
    expect(masked).not.toBe(VALID);
  });

  it("masks short/blank values without leaking length", () => {
    expect(maskKey("")).toBe("");
    expect(maskKey("sk-tiny")).toBe("••••••••");
  });
});

describe("byokParam", () => {
  it("returns the key param only for a valid stored key", () => {
    expect(byokParam()).toEqual({});
    saveByokKey("not-a-key");
    expect(byokParam()).toEqual({});
    saveByokKey(VALID);
    expect(byokParam()).toEqual({ byok_api_key: VALID });
  });
});
