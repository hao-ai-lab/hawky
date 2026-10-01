import {
  DEFAULT_VOICEPRINT_THRESHOLDS,
  type VoiceprintThresholds,
} from "./types.js";

export const MIN_OWNER_ACCEPT_THRESHOLD = 0.5;

export function resolveVoiceprintThresholds(
  ...overrides: Array<Partial<VoiceprintThresholds> | undefined>
): VoiceprintThresholds {
  const thresholds = Object.assign({}, DEFAULT_VOICEPRINT_THRESHOLDS, ...overrides);
  validateVoiceprintThresholds(thresholds);
  return thresholds;
}

export function validateVoiceprintThresholds(thresholds: VoiceprintThresholds): void {
  if (
    !Number.isFinite(thresholds.ownerAccept) ||
    !Number.isFinite(thresholds.ownerPossible)
  ) {
    throw new Error("Voiceprint thresholds must be finite numbers.");
  }
  if (thresholds.ownerAccept < MIN_OWNER_ACCEPT_THRESHOLD || thresholds.ownerAccept > 1) {
    throw new Error(
      `Voiceprint thresholds must satisfy ${MIN_OWNER_ACCEPT_THRESHOLD} <= ownerAccept <= 1.`,
    );
  }
  if (thresholds.ownerPossible < 0 || thresholds.ownerPossible > 1) {
    throw new Error("Voiceprint thresholds must satisfy 0 <= ownerPossible <= 1.");
  }
  if (thresholds.ownerAccept < thresholds.ownerPossible) {
    throw new Error("Voiceprint thresholds must satisfy ownerAccept >= ownerPossible.");
  }
}
