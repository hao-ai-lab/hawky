import { readFile } from "node:fs/promises";

export interface WavAudio {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  formatCode: number;
  samples: Float32Array;
  durationMs: number;
}

interface WavFmtChunk {
  formatCode: number;
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  blockAlign: number;
}

function readChunkId(buf: Buffer, offset: number): string {
  return buf.toString("ascii", offset, offset + 4);
}

export function parseWavPcm(buf: Buffer): WavAudio {
  if (buf.length < 44 || readChunkId(buf, 0) !== "RIFF" || readChunkId(buf, 8) !== "WAVE") {
    throw new Error("Expected a RIFF/WAVE buffer.");
  }

  let fmt: WavFmtChunk | null = null;
  let dataStart = -1;
  let dataSize = 0;
  let offset = 12;

  while (offset + 8 <= buf.length) {
    const id = readChunkId(buf, offset);
    const size = buf.readUInt32LE(offset + 4);
    const payloadStart = offset + 8;
    const payloadEnd = Math.min(payloadStart + size, buf.length);

    if (id === "fmt ") {
      if (size < 16) {
        throw new Error("Invalid WAV fmt chunk.");
      }
      fmt = {
        formatCode: buf.readUInt16LE(payloadStart),
        channels: buf.readUInt16LE(payloadStart + 2),
        sampleRate: buf.readUInt32LE(payloadStart + 4),
        blockAlign: buf.readUInt16LE(payloadStart + 12),
        bitsPerSample: buf.readUInt16LE(payloadStart + 14),
      };
    } else if (id === "data") {
      dataStart = payloadStart;
      dataSize = payloadEnd - payloadStart;
      break;
    }

    offset = payloadStart + size + (size % 2);
  }

  if (!fmt) {
    throw new Error("WAV file is missing a fmt chunk.");
  }
  if (dataStart < 0) {
    throw new Error("WAV file is missing a data chunk.");
  }
  if (fmt.channels <= 0 || fmt.sampleRate <= 0 || fmt.blockAlign <= 0) {
    throw new Error("WAV file has invalid audio format metadata.");
  }

  const bytesPerSample = fmt.bitsPerSample / 8;
  if (!Number.isInteger(bytesPerSample) || bytesPerSample <= 0) {
    throw new Error(`Unsupported WAV bit depth: ${fmt.bitsPerSample}.`);
  }

  const frameCount = Math.floor(dataSize / fmt.blockAlign);
  const samples = new Float32Array(frameCount);
  for (let frame = 0; frame < frameCount; frame += 1) {
    const frameOffset = dataStart + frame * fmt.blockAlign;
    let mono = 0;
    for (let channel = 0; channel < fmt.channels; channel += 1) {
      const sampleOffset = frameOffset + channel * bytesPerSample;
      mono += readSample(buf, sampleOffset, fmt.formatCode, fmt.bitsPerSample);
    }
    samples[frame] = mono / fmt.channels;
  }

  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    formatCode: fmt.formatCode,
    samples,
    durationMs: (samples.length / fmt.sampleRate) * 1000,
  };
}

function readSample(
  buf: Buffer,
  offset: number,
  formatCode: number,
  bitsPerSample: number,
): number {
  if (formatCode === 1) {
    switch (bitsPerSample) {
      case 8:
        return (buf.readUInt8(offset) - 128) / 128;
      case 16:
        return buf.readInt16LE(offset) / 32768;
      case 24:
        return buf.readIntLE(offset, 3) / 8388608;
      case 32:
        return buf.readInt32LE(offset) / 2147483648;
      default:
        throw new Error(`Unsupported PCM WAV bit depth: ${bitsPerSample}.`);
    }
  }

  if (formatCode === 3) {
    if (bitsPerSample === 32) {
      return buf.readFloatLE(offset);
    }
    if (bitsPerSample === 64) {
      return buf.readDoubleLE(offset);
    }
  }

  throw new Error(`Unsupported WAV format code ${formatCode} / ${bitsPerSample} bits.`);
}

export async function readWavFile(path: string): Promise<WavAudio> {
  return parseWavPcm(await readFile(path));
}

export function sliceWavAudio(audio: WavAudio, startMs = 0, endMs = audio.durationMs): WavAudio {
  const boundedStartMs = Math.max(0, Math.min(startMs, audio.durationMs));
  const boundedEndMs = Math.max(boundedStartMs, Math.min(endMs, audio.durationMs));
  const startSample = Math.floor((boundedStartMs / 1000) * audio.sampleRate);
  const endSample = Math.floor((boundedEndMs / 1000) * audio.sampleRate);

  const samples = audio.samples.slice(startSample, endSample);
  return {
    ...audio,
    samples,
    durationMs: (samples.length / audio.sampleRate) * 1000,
  };
}

export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) {
    return samples;
  }

  const outLength = Math.max(1, Math.round((samples.length * toRate) / fromRate));
  const out = new Float32Array(outLength);
  const ratio = fromRate / toRate;

  for (let i = 0; i < outLength; i += 1) {
    const sourceIndex = i * ratio;
    const left = Math.floor(sourceIndex);
    const right = Math.min(left + 1, samples.length - 1);
    const t = sourceIndex - left;
    out[i] = samples[left]! * (1 - t) + samples[right]! * t;
  }

  return out;
}
