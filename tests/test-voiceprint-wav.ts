import { describe, expect, test } from "bun:test";
import { parseWavPcm, resampleLinear, sliceWavAudio } from "../src/identity/voiceprint/index.js";

describe("voiceprint WAV parsing", () => {
  test("parses mono PCM16 WAV data", () => {
    const wav = buildPcm16Wav({
      sampleRate: 16000,
      channels: 1,
      samples: [0, 32767, -32768, 0],
    });

    const parsed = parseWavPcm(wav);

    expect(parsed.sampleRate).toBe(16000);
    expect(parsed.channels).toBe(1);
    expect(parsed.samples.length).toBe(4);
    expect(parsed.samples[1]).toBeCloseTo(32767 / 32768);
    expect(parsed.samples[2]).toBeCloseTo(-1);
  });

  test("mixes stereo samples to mono and slices by time", () => {
    const wav = buildPcm16Wav({
      sampleRate: 1000,
      channels: 2,
      samples: [32767, 0, 0, 32767, -32768, -32768],
    });

    const parsed = parseWavPcm(wav);
    const sliced = sliceWavAudio(parsed, 1, 3);

    expect(parsed.samples.length).toBe(3);
    expect(parsed.samples[0]).toBeCloseTo(0.5, 3);
    expect(sliced.samples.length).toBe(2);
  });

  test("resamples with linear interpolation", () => {
    const out = resampleLinear(new Float32Array([0, 1]), 2, 4);
    expect(Array.from(out)).toHaveLength(4);
    expect(out[0]).toBeCloseTo(0);
    expect(out[2]).toBeCloseTo(1);
  });
});

function buildPcm16Wav(input: {
  sampleRate: number;
  channels: number;
  samples: number[];
}): Buffer {
  const dataSize = input.samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  const byteRate = input.sampleRate * input.channels * 2;
  const blockAlign = input.channels * 2;

  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8, "ascii");
  buf.write("fmt ", 12, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(input.channels, 22);
  buf.writeUInt32LE(input.sampleRate, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(dataSize, 40);

  input.samples.forEach((sample, index) => {
    buf.writeInt16LE(sample, 44 + index * 2);
  });

  return buf;
}
