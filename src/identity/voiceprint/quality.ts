import type { VoiceprintAnnotationAllowedUses } from "./policy.js";

export type VoiceprintAudioQualityStatus = "accepted" | "marginal" | "rejected";

export type VoiceprintAudioQualityReason =
  | "non_finite_sample"
  | "too_short"
  | "short_for_learning"
  | "too_quiet"
  | "quiet_for_learning"
  | "low_dynamic_range"
  | "clipped"
  | "dc_offset";

export interface VoiceprintAudioQualityThresholds {
  minDurationMs: number;
  targetDurationMs: number;
  minRms: number;
  targetRms: number;
  minPeak: number;
  minDynamicRange: number;
  maxClippingRatio: number;
  clippingAmplitude: number;
  maxAbsDcOffset: number;
}

export interface VoiceprintAudioQualityMetrics {
  durationMs: number;
  sampleRate: number;
  sampleCount: number;
  rms: number;
  peak: number;
  mean: number;
  dynamicRange: number;
  clippingRatio: number;
  zeroCrossingRate: number;
}

export interface VoiceprintAudioQualityAllowedUses
  extends VoiceprintAnnotationAllowedUses {
  scoring: boolean;
}

export interface VoiceprintAudioQualityAssessment {
  status: VoiceprintAudioQualityStatus;
  reasons: VoiceprintAudioQualityReason[];
  metrics: VoiceprintAudioQualityMetrics;
  thresholds: VoiceprintAudioQualityThresholds;
  allowedUses: VoiceprintAudioQualityAllowedUses;
}

export const DEFAULT_VOICEPRINT_AUDIO_QUALITY_THRESHOLDS: VoiceprintAudioQualityThresholds = {
  minDurationMs: 700,
  targetDurationMs: 1200,
  minRms: 0.004,
  targetRms: 0.012,
  minPeak: 0.02,
  minDynamicRange: 0.02,
  maxClippingRatio: 0.02,
  clippingAmplitude: 0.98,
  maxAbsDcOffset: 0.2,
};

export function assessVoiceprintAudioQuality(
  samples: Float32Array,
  sampleRate: number,
  thresholds?: Partial<VoiceprintAudioQualityThresholds>,
): VoiceprintAudioQualityAssessment {
  const resolvedThresholds = {
    ...DEFAULT_VOICEPRINT_AUDIO_QUALITY_THRESHOLDS,
    ...thresholds,
  };
  validateQualityInput(samples, sampleRate, resolvedThresholds);

  const metrics = computeVoiceprintAudioQualityMetrics(samples, sampleRate, resolvedThresholds);
  const hardReasons: VoiceprintAudioQualityReason[] = [];
  const softReasons: VoiceprintAudioQualityReason[] = [];

  if (!qualityMetricsAreFinite(metrics)) {
    hardReasons.push("non_finite_sample");
  }

  if (metrics.sampleCount === 0 || metrics.durationMs < resolvedThresholds.minDurationMs) {
    hardReasons.push("too_short");
  } else if (metrics.durationMs < resolvedThresholds.targetDurationMs) {
    softReasons.push("short_for_learning");
  }

  if (metrics.rms < resolvedThresholds.minRms || metrics.peak < resolvedThresholds.minPeak) {
    hardReasons.push("too_quiet");
  } else if (metrics.rms < resolvedThresholds.targetRms) {
    softReasons.push("quiet_for_learning");
  }

  if (metrics.dynamicRange < resolvedThresholds.minDynamicRange) {
    hardReasons.push("low_dynamic_range");
  }
  if (metrics.clippingRatio > resolvedThresholds.maxClippingRatio) {
    hardReasons.push("clipped");
  }
  if (Math.abs(metrics.mean) > resolvedThresholds.maxAbsDcOffset) {
    hardReasons.push("dc_offset");
  }

  const reasons = [...hardReasons, ...softReasons];
  const status =
    hardReasons.length > 0 ? "rejected" : softReasons.length > 0 ? "marginal" : "accepted";

  return {
    status,
    reasons,
    metrics,
    thresholds: resolvedThresholds,
    allowedUses: allowedUsesForQualityStatus(status),
  };
}

function qualityMetricsAreFinite(metrics: VoiceprintAudioQualityMetrics): boolean {
  return (
    Number.isFinite(metrics.durationMs) &&
    Number.isFinite(metrics.sampleRate) &&
    Number.isFinite(metrics.sampleCount) &&
    Number.isFinite(metrics.rms) &&
    Number.isFinite(metrics.peak) &&
    Number.isFinite(metrics.mean) &&
    Number.isFinite(metrics.dynamicRange) &&
    Number.isFinite(metrics.clippingRatio) &&
    Number.isFinite(metrics.zeroCrossingRate)
  );
}

export function computeVoiceprintAudioQualityMetrics(
  samples: Float32Array,
  sampleRate: number,
  thresholds: Pick<VoiceprintAudioQualityThresholds, "clippingAmplitude"> = DEFAULT_VOICEPRINT_AUDIO_QUALITY_THRESHOLDS,
): VoiceprintAudioQualityMetrics {
  let sum = 0;
  let sumSquares = 0;
  let peak = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let clippingCount = 0;
  let zeroCrossings = 0;
  let previous = samples[0] ?? 0;

  for (const sample of samples) {
    if (!Number.isFinite(sample)) {
      return {
        durationMs: (samples.length / sampleRate) * 1000,
        sampleRate,
        sampleCount: samples.length,
        rms: Number.NaN,
        peak: Number.NaN,
        mean: Number.NaN,
        dynamicRange: Number.NaN,
        clippingRatio: Number.NaN,
        zeroCrossingRate: Number.NaN,
      };
    }

    const abs = Math.abs(sample);
    sum += sample;
    sumSquares += sample * sample;
    peak = Math.max(peak, abs);
    min = Math.min(min, sample);
    max = Math.max(max, sample);
    if (abs >= thresholds.clippingAmplitude) {
      clippingCount += 1;
    }
    if ((previous < 0 && sample >= 0) || (previous >= 0 && sample < 0)) {
      zeroCrossings += 1;
    }
    previous = sample;
  }

  const sampleCount = samples.length;
  const durationMs = (sampleCount / sampleRate) * 1000;
  const rms = sampleCount === 0 ? 0 : Math.sqrt(sumSquares / sampleCount);
  const mean = sampleCount === 0 ? 0 : sum / sampleCount;
  const dynamicRange = sampleCount === 0 ? 0 : max - min;

  return {
    durationMs,
    sampleRate,
    sampleCount,
    rms,
    peak,
    mean,
    dynamicRange,
    clippingRatio: sampleCount === 0 ? 0 : clippingCount / sampleCount,
    zeroCrossingRate: sampleCount === 0 ? 0 : zeroCrossings / sampleCount,
  };
}

export function allowedUsesForQualityStatus(
  status: VoiceprintAudioQualityStatus,
): VoiceprintAudioQualityAllowedUses {
  if (status === "accepted") {
    return {
      diagnostics: true,
      scoring: true,
      transcriptDisplay: true,
      memoryPromotion: true,
      actionProposal: true,
      eventGraph: true,
      contextExport: false,
      templateLearning: true,
    };
  }

  if (status === "marginal") {
    return {
      diagnostics: true,
      scoring: true,
      transcriptDisplay: true,
      memoryPromotion: false,
      actionProposal: false,
      eventGraph: false,
      contextExport: false,
      templateLearning: false,
    };
  }

  return {
    diagnostics: true,
    scoring: false,
    transcriptDisplay: false,
    memoryPromotion: false,
    actionProposal: false,
    eventGraph: false,
    contextExport: false,
    templateLearning: false,
  };
}

export function summarizeVoiceprintAudioQuality(
  assessment: VoiceprintAudioQualityAssessment,
): Pick<VoiceprintAudioQualityAssessment, "status" | "reasons" | "metrics"> {
  return {
    status: assessment.status,
    reasons: assessment.reasons,
    metrics: assessment.metrics,
  };
}

function validateQualityInput(
  samples: Float32Array,
  sampleRate: number,
  thresholds: VoiceprintAudioQualityThresholds,
): void {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
    throw new Error("Voiceprint audio quality requires a positive sampleRate.");
  }
  for (const [key, value] of Object.entries(thresholds)) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`Voiceprint audio quality threshold ${key} must be non-negative.`);
    }
  }
  if (thresholds.targetDurationMs < thresholds.minDurationMs) {
    throw new Error("Voiceprint targetDurationMs must be greater than or equal to minDurationMs.");
  }
  if (thresholds.targetRms < thresholds.minRms) {
    throw new Error("Voiceprint targetRms must be greater than or equal to minRms.");
  }
}
