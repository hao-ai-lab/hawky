import { describe, expect, test } from "bun:test";
import {
  assessVoiceprintAudioQuality,
  computeVoiceprintAudioQualityMetrics,
} from "../src/identity/voiceprint/index.js";

const sampleRate = 16000;

describe("voiceprint audio quality gate", () => {
  test("accepts a stable speech-like segment for scoring and learning", () => {
    const assessment = assessVoiceprintAudioQuality(sineWave(1500, 0.1), sampleRate);

    expect(assessment.status).toBe("accepted");
    expect(assessment.reasons).toEqual([]);
    expect(assessment.allowedUses.scoring).toBe(true);
    expect(assessment.allowedUses.memoryPromotion).toBe(true);
    expect(assessment.allowedUses.templateLearning).toBe(true);
    expect(assessment.metrics.durationMs).toBeCloseTo(1500);
  });

  test("allows marginal scoring but blocks memory, event, and learning uses", () => {
    const assessment = assessVoiceprintAudioQuality(sineWave(900, 0.1), sampleRate);

    expect(assessment.status).toBe("marginal");
    expect(assessment.reasons).toContain("short_for_learning");
    expect(assessment.allowedUses.scoring).toBe(true);
    expect(assessment.allowedUses.memoryPromotion).toBe(false);
    expect(assessment.allowedUses.eventGraph).toBe(false);
    expect(assessment.allowedUses.templateLearning).toBe(false);
  });

  test("rejects quiet or malformed audio before embedding work", () => {
    const quiet = assessVoiceprintAudioQuality(sineWave(1500, 0.001), sampleRate);
    expect(quiet.status).toBe("rejected");
    expect(quiet.reasons).toContain("too_quiet");
    expect(quiet.allowedUses.scoring).toBe(false);

    const malformedSamples = sineWave(1500, 0.1);
    malformedSamples[100] = Number.NaN;
    const malformed = assessVoiceprintAudioQuality(malformedSamples, sampleRate);
    expect(malformed.status).toBe("rejected");
    expect(malformed.reasons).toContain("non_finite_sample");
    expect(malformed.allowedUses.scoring).toBe(false);
  });

  test("computes deterministic metrics without model dependencies", () => {
    const metrics = computeVoiceprintAudioQualityMetrics(
      new Float32Array([-0.5, 0, 0.5, 1]),
      4,
    );

    expect(metrics.durationMs).toBe(1000);
    expect(metrics.sampleCount).toBe(4);
    expect(metrics.peak).toBe(1);
    expect(metrics.dynamicRange).toBe(1.5);
    expect(metrics.zeroCrossingRate).toBeGreaterThan(0);
  });
});

function sineWave(durationMs: number, amplitude: number): Float32Array {
  const length = Math.round((durationMs / 1000) * sampleRate);
  const samples = new Float32Array(length);
  for (let i = 0; i < samples.length; i += 1) {
    samples[i] = Math.sin((2 * Math.PI * 220 * i) / sampleRate) * amplitude;
  }
  return samples;
}
