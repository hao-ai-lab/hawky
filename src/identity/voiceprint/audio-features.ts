import type { VoiceprintLoadedEmbedding } from "./types.js";
import { readWavFile, resampleLinear, sliceWavAudio } from "./wav.js";

const BASELINE_SAMPLE_RATE = 16000;

// Minimum analyzable clip: at least 160 samples AND at least 50 ms of audio.
// Shorter clips carry too little signal for stable band/energy features.
const MIN_ANALYSIS_SAMPLES = 160;
const MIN_ANALYSIS_SECONDS = 0.05;

// Goertzel probe frequencies (Hz) spanning the voice band, from fundamental
// pitch through the upper formants/fricative energy.
const VOICE_BAND_FREQUENCIES_HZ = [120, 220, 440, 880, 1760, 3200] as const;

export const SIGNAL_BASELINE_MODEL = {
  provider: "signal-baseline",
  modelId: "signal-baseline-v0",
} as const;

export function signalBaselineEmbedding(samples: Float32Array, sampleRate: number): number[] {
  if (samples.length < Math.max(MIN_ANALYSIS_SAMPLES, sampleRate * MIN_ANALYSIS_SECONDS)) {
    return [];
  }

  let sumSquares = 0;
  let sumAbs = 0;
  let peak = 0;
  let zeroCrossings = 0;
  let previous = samples[0]!;

  for (const sample of samples) {
    const abs = Math.abs(sample);
    sumSquares += sample * sample;
    sumAbs += abs;
    peak = Math.max(peak, abs);
    if ((previous < 0 && sample >= 0) || (previous >= 0 && sample < 0)) {
      zeroCrossings += 1;
    }
    previous = sample;
  }

  const rms = Math.sqrt(sumSquares / samples.length);
  if (rms < 1e-5) {
    return [];
  }

  const frameStats = frameRmsStats(samples, sampleRate);
  const bandPowers = VOICE_BAND_FREQUENCIES_HZ.map((freqHz) =>
    goertzelPower(samples, sampleRate, freqHz),
  );
  const totalBandPower = bandPowers.reduce((sum, value) => sum + value, 0) || 1;

  return [
    Math.log1p(samples.length / sampleRate),
    Math.log1p(rms * 100),
    Math.log1p((sumAbs / samples.length) * 100),
    peak,
    zeroCrossings / samples.length,
    frameStats.mean,
    frameStats.std,
    frameStats.p10,
    frameStats.p90,
    ...bandPowers.map((value) => Math.log1p(value / totalBandPower)),
  ];
}

function frameRmsStats(samples: Float32Array, sampleRate: number): {
  mean: number;
  std: number;
  p10: number;
  p90: number;
} {
  const frameSize = Math.max(1, Math.round(sampleRate * 0.025));
  const values: number[] = [];

  for (let offset = 0; offset < samples.length; offset += frameSize) {
    const end = Math.min(samples.length, offset + frameSize);
    let sumSquares = 0;
    for (let i = offset; i < end; i += 1) {
      sumSquares += samples[i]! * samples[i]!;
    }
    values.push(Math.sqrt(sumSquares / Math.max(1, end - offset)));
  }

  values.sort((a, b) => a - b);
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;

  return {
    mean,
    std: Math.sqrt(variance),
    p10: values[Math.floor(values.length * 0.1)] ?? 0,
    p90: values[Math.floor(values.length * 0.9)] ?? 0,
  };
}

function goertzelPower(samples: Float32Array, sampleRate: number, targetHz: number): number {
  const normalizedFrequency = targetHz / sampleRate;
  const coefficient = 2 * Math.cos(2 * Math.PI * normalizedFrequency);
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;

  for (const sample of samples) {
    q0 = coefficient * q1 - q2 + sample;
    q2 = q1;
    q1 = q0;
  }

  return q1 * q1 + q2 * q2 - coefficient * q1 * q2;
}

export async function loadSignalBaselineEmbedding(
  sourceId: string,
  audioPath: string,
  startMs?: number,
  endMs?: number,
): Promise<VoiceprintLoadedEmbedding> {
  const wav = await readWavFile(audioPath);
  const sliced = sliceWavAudio(wav, startMs, endMs);
  const samples = resampleLinear(sliced.samples, sliced.sampleRate, BASELINE_SAMPLE_RATE);
  const vector = signalBaselineEmbedding(samples, BASELINE_SAMPLE_RATE);

  return {
    sourceId,
    vector,
    provider: SIGNAL_BASELINE_MODEL.provider,
    modelId: SIGNAL_BASELINE_MODEL.modelId,
    source: "wav_signal_baseline",
    dim: vector.length,
  };
}
