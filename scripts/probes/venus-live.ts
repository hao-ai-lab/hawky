/** Opt-in real Venus probe. Uses a red JPEG and optional synthetic voice WAV. */
import { VenusAdapter } from "../../src/live/providers/venus";
import { probePcm } from "./live-media";
if (!process.env.VENUS_LIVE_IMAGE) throw new Error("Set VENUS_LIVE_IMAGE to a synthetic red JPEG fixture");
const image = Buffer.from(await Bun.file(process.env.VENUS_LIVE_IMAGE).arrayBuffer()).toString("base64");
let audio = 0, text = "", finish!: () => void;
const done = new Promise<void>(resolve => { finish = resolve; });
const provider = new VenusAdapter({ id: crypto.randomUUID(), model: "realtime-venus-omni",
  instructions: "You are Hawk. Answer the user briefly using the camera when asked.", history: [], bridge: false, tool: async () => ({}),
  emit: e => {
    if (e.type === "audio") { audio++; provider.input({ type: "playback", id: e.id, played: false }); }
    if (e.type === "caption" && e.role === "assistant") { text = e.text; if (e.final) finish(); }
    if (e.type === "error") { console.error(e.message); process.exitCode = 1; finish(); }
  },
}, { url: process.env.HAWKY_VENUS_URL || "http://127.0.0.1:8033", apiKey: process.env.HAWKY_VENUS_API_KEY });
try {
  await provider.start(); provider.input({ type: "image", data: image, at: Date.now() });
  if (process.env.VENUS_LIVE_WAV) {
    const pcm = await probePcm(process.env.VENUS_LIVE_WAV);
    for (let offset = 0; offset < pcm.length + 32000; offset += 3200) {
      if (offset % 32000 === 0) provider.input({ type: "image", data: image, at: Date.now() });
      provider.input({ type: "audio", data: (offset < pcm.length ? pcm.subarray(offset, offset + 3200) : Buffer.alloc(3200)).toString("base64") });
      await Bun.sleep(100);
    }
    provider.input({ type: "mic", enabled: false });
  } else provider.input({ type: "text", text: "What color fills the camera image? Answer with the color only." });
  const timer = setTimeout(finish, 35000); await done; clearTimeout(timer);
  const passed = audio > 0 && /red/i.test(text) && !/<\|/.test(text);
  console.log({ audioChunks: audio, transcript: text, passed });
  if (!passed) process.exitCode = 1;
} finally { await provider.close(); }
