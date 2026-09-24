/** Read a caller-supplied synthetic WAV; never open a physical microphone. */
export async function probePcm(path: string) {
  const wav = Buffer.from(await Bun.file(path).arrayBuffer());
  if (wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("Expected a WAV fixture");
  let pcm: Buffer | undefined, valid = false;
  for (let at = 12; at + 8 <= wav.length;) {
    const size = wav.readUInt32LE(at + 4), start = at + 8;
    if (start + size > wav.length) throw new Error("Truncated WAV fixture");
    const tag = wav.toString("ascii", at, at + 4);
    if (tag === "fmt " && size >= 16) valid = wav.readUInt16LE(start) === 1 && wav.readUInt16LE(start + 2) === 1 && wav.readUInt32LE(start + 4) === 16000 && wav.readUInt16LE(start + 14) === 16;
    if (tag === "data") pcm = wav.subarray(start, start + size);
    at = start + size + size % 2;
  }
  if (!valid || !pcm?.length || pcm.length % 2 || pcm.length > 960000) throw new Error("Use a mono 16 kHz PCM16 WAV shorter than 30 seconds");
  return pcm;
}
