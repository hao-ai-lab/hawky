import {
  DEFAULT_VOICEPRINT_THRESHOLDS,
  type VoiceprintDecision,
  type VoiceprintThresholds,
} from "./types.js";

export type VoiceprintSpeakerResult =
  | VoiceprintDecision
  | "unknown_cluster"
  | "confirmed_person";

export interface VoiceprintConsentSnapshot {
  captureAllowed: boolean;
  biometricAllowed: boolean;
  memoryPromotionAllowed: boolean;
  exportAllowed: boolean;
  templateLearningAllowed?: boolean;
  reason?: string;
}

export interface VoiceprintAnnotationAllowedUses {
  diagnostics: boolean;
  transcriptDisplay: boolean;
  memoryPromotion: boolean;
  actionProposal: boolean;
  eventGraph: boolean;
  contextExport: boolean;
  templateLearning: boolean;
}

export const NO_VOICEPRINT_ALLOWED_USES: VoiceprintAnnotationAllowedUses = {
  diagnostics: false,
  transcriptDisplay: false,
  memoryPromotion: false,
  actionProposal: false,
  eventGraph: false,
  contextExport: false,
  templateLearning: false,
};

export const DEFAULT_VOICEPRINT_CONSENT: VoiceprintConsentSnapshot = {
  captureAllowed: false,
  biometricAllowed: false,
  memoryPromotionAllowed: false,
  exportAllowed: false,
  templateLearningAllowed: false,
  reason: "missing_voiceprint_consent",
};

export function resolveVoiceprintConsent(
  consent?: Partial<VoiceprintConsentSnapshot>,
): VoiceprintConsentSnapshot {
  const resolved = { ...DEFAULT_VOICEPRINT_CONSENT, ...consent };
  if (
    resolved.captureAllowed &&
    resolved.biometricAllowed &&
    consent?.reason === undefined
  ) {
    return {
      captureAllowed: resolved.captureAllowed,
      biometricAllowed: resolved.biometricAllowed,
      memoryPromotionAllowed: resolved.memoryPromotionAllowed,
      exportAllowed: resolved.exportAllowed,
      templateLearningAllowed: resolved.templateLearningAllowed,
    };
  }
  return resolved;
}

export function voiceprintConsentAllowsProcessing(
  consent?: Partial<VoiceprintConsentSnapshot>,
): boolean {
  const resolved = resolveVoiceprintConsent(consent);
  return resolved.captureAllowed && resolved.biometricAllowed;
}

export function assertVoiceprintConsentAllowsProcessing(
  consent?: Partial<VoiceprintConsentSnapshot>,
): VoiceprintConsentSnapshot {
  const resolved = resolveVoiceprintConsent(consent);
  if (!resolved.captureAllowed || !resolved.biometricAllowed) {
    throw new Error("Voiceprint consent does not allow capture/biometric processing.");
  }
  return resolved;
}

export function allowedUsesForVoiceprintResult(input: {
  result: VoiceprintSpeakerResult;
  confidence: number;
  score?: number;
  thresholdUsed?: number;
  thresholds?: Partial<VoiceprintThresholds>;
  consent?: Partial<VoiceprintConsentSnapshot>;
  reviewed?: boolean;
}): VoiceprintAnnotationAllowedUses {
  const consent = resolveVoiceprintConsent(input.consent);
  if (!consent.captureAllowed || !consent.biometricAllowed) {
    return { ...NO_VOICEPRINT_ALLOWED_USES };
  }

  const confidence = Number.isFinite(input.confidence) ? input.confidence : -1;
  const score = Number.isFinite(input.score) ? input.score! : confidence;
  const ownerAccept =
    input.thresholds?.ownerAccept ??
    input.thresholdUsed ??
    DEFAULT_VOICEPRINT_THRESHOLDS.ownerAccept;
  const reviewed = input.reviewed === true;

  switch (input.result) {
    case "owner_speaking": {
      const strongOwner = score >= ownerAccept;
      return {
        diagnostics: true,
        transcriptDisplay: true,
        memoryPromotion: strongOwner && consent.memoryPromotionAllowed,
        actionProposal: strongOwner && consent.memoryPromotionAllowed,
        eventGraph: strongOwner,
        contextExport: false,
        templateLearning:
          strongOwner && reviewed && consent.templateLearningAllowed === true,
      };
    }
    case "possible_owner":
      return {
        diagnostics: true,
        transcriptDisplay: false,
        memoryPromotion: false,
        actionProposal: false,
        eventGraph: false,
        contextExport: false,
        templateLearning: false,
      };
    case "unknown_cluster":
      return {
        diagnostics: true,
        transcriptDisplay: true,
        memoryPromotion: false,
        actionProposal: false,
        eventGraph: reviewed,
        contextExport: false,
        templateLearning: false,
      };
    case "confirmed_person":
      return {
        diagnostics: true,
        transcriptDisplay: reviewed,
        memoryPromotion: reviewed && consent.memoryPromotionAllowed,
        actionProposal: false,
        eventGraph: reviewed,
        contextExport: reviewed && consent.exportAllowed,
        templateLearning: false,
      };
    case "unknown_speaker":
      return {
        diagnostics: true,
        transcriptDisplay: true,
        memoryPromotion: false,
        actionProposal: false,
        eventGraph: false,
        contextExport: false,
        templateLearning: false,
      };
    default:
      return { ...NO_VOICEPRINT_ALLOWED_USES };
  }
}

export function voiceprintResultCanInfluenceMemory(
  allowedUses: VoiceprintAnnotationAllowedUses,
): boolean {
  return allowedUses.memoryPromotion || allowedUses.actionProposal;
}
