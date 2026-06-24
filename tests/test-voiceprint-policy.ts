import { describe, expect, test } from "bun:test";
import {
  allowedUsesForVoiceprintResult,
  resolveVoiceprintConsent,
  voiceprintConsentAllowsProcessing,
  voiceprintResultCanInfluenceMemory,
} from "../src/identity/voiceprint/index.js";

const processingConsent = {
  captureAllowed: true,
  biometricAllowed: true,
};

describe("voiceprint policy gate", () => {
  test("fails closed without explicit capture and biometric consent", () => {
    const denied = allowedUsesForVoiceprintResult({
      result: "owner_speaking",
      confidence: 0.91,
      thresholdUsed: 0.82,
    });
    const partial = allowedUsesForVoiceprintResult({
      result: "owner_speaking",
      confidence: 0.91,
      thresholdUsed: 0.82,
      consent: { memoryPromotionAllowed: true },
    });

    expect(Object.values(denied).every((value) => value === false)).toBe(true);
    expect(Object.values(partial).every((value) => value === false)).toBe(true);
    expect(voiceprintConsentAllowsProcessing()).toBe(false);
    expect(voiceprintConsentAllowsProcessing({ memoryPromotionAllowed: true })).toBe(false);
  });

  test("clears missing-consent reason after capture and biometric consent are granted", () => {
    const allowed = resolveVoiceprintConsent({
      ...processingConsent,
      memoryPromotionAllowed: true,
    });
    const explicitReason = resolveVoiceprintConsent({
      ...processingConsent,
      reason: "user_enabled_voice_identity",
    });
    const denied = resolveVoiceprintConsent();

    expect("reason" in allowed).toBe(false);
    expect(allowed.memoryPromotionAllowed).toBe(true);
    expect(explicitReason.reason).toBe("user_enabled_voice_identity");
    expect(denied.reason).toBe("missing_voiceprint_consent");
  });

  test("allows strong owner speech to influence memory/action only with consent", () => {
    const allowed = allowedUsesForVoiceprintResult({
      result: "owner_speaking",
      confidence: 0.91,
      thresholdUsed: 0.82,
      consent: { ...processingConsent, memoryPromotionAllowed: true },
    });
    expect(allowed.memoryPromotion).toBe(true);
    expect(allowed.actionProposal).toBe(true);
    expect(allowed.contextExport).toBe(false);
    expect(voiceprintResultCanInfluenceMemory(allowed)).toBe(true);
  });

  test("keeps possible owner diagnostic-only", () => {
    const allowed = allowedUsesForVoiceprintResult({
      result: "possible_owner",
      confidence: 0.76,
      thresholdUsed: 0.82,
      consent: { ...processingConsent, memoryPromotionAllowed: true, exportAllowed: true },
    });

    expect(allowed.diagnostics).toBe(true);
    expect(allowed.transcriptDisplay).toBe(false);
    expect(allowed.memoryPromotion).toBe(false);
    expect(allowed.actionProposal).toBe(false);
    expect(allowed.contextExport).toBe(false);
  });

  test("keeps unknown clusters review-first", () => {
    const unreviewed = allowedUsesForVoiceprintResult({
      result: "unknown_cluster",
      confidence: 0.86,
      consent: { ...processingConsent, memoryPromotionAllowed: true },
    });
    expect(unreviewed.eventGraph).toBe(false);
    expect(unreviewed.memoryPromotion).toBe(false);

    const reviewed = allowedUsesForVoiceprintResult({
      result: "unknown_cluster",
      confidence: 0.86,
      reviewed: true,
      consent: { ...processingConsent, memoryPromotionAllowed: true },
    });
    expect(reviewed.eventGraph).toBe(true);
    expect(reviewed.memoryPromotion).toBe(false);
  });

  test("blocks everything when biometric consent is missing", () => {
    const allowed = allowedUsesForVoiceprintResult({
      result: "owner_speaking",
      confidence: 0.99,
      thresholdUsed: 0.82,
      consent: { captureAllowed: true, biometricAllowed: false, memoryPromotionAllowed: true },
    });

    expect(Object.values(allowed).every((value) => value === false)).toBe(true);
  });
});
