/** Opt-in JoyAI camera/ASR/TTS probe. Supply synthetic media, never a physical mic. */
import { JoyAIAdapter } from "../../src/live/providers/joyai";
import { probePcm } from "./live-media";
const { HAWKY_JOYAI_URL: url, JOYAI_LIVE_IMAGE: imagePath } = process.env;
if (!url || !imagePath) throw new Error("Set HAWKY_JOYAI_URL and JOYAI_LIVE_IMAGE (a red JPEG)");
const image = Buffer.from(await Bun.file(imagePath).arrayBuffer()).toString("base64");
let audio = 0, text = "", user = "", error = "";
const p = new JoyAIAdapter({ id: crypto.randomUUID(), model: "joyai-vl-interaction",
  instructions: "Answer briefly. Use the camera image to answer color questions.", history: [], bridge: false, tool: async () => ({}),
  emit: e => {
    if (e.type === "audio") { audio++; p.input({ type: "playback", id: e.id, played: true }); }
    if (e.type === "caption" && e.final) { if (e.role === "assistant") text = e.text; else user = e.text; }
    if (e.type === "error") error = e.message;
  },
}, { url, api_key: process.env.HAWKY_JOYAI_API_KEY,
  asr_url: process.env.HAWKY_JOYAI_ASR_URL, asr_api_key: process.env.HAWKY_JOYAI_API_KEY,
  tts_url: process.env.HAWKY_JOYAI_TTS_URL, tts_api_key: process.env.HAWKY_JOYAI_API_KEY });
try {
  await p.start(); p.input({ type: "image", data: image, at: Date.now() });
  if (process.env.JOYAI_LIVE_WAV) {
    const pcm = await probePcm(process.env.JOYAI_LIVE_WAV);
    for (let at = 0; at < pcm.length + 32000; at += 3200) {
      p.input({ type: "audio", data: (at < pcm.length ? pcm.subarray(at, at + 3200) : Buffer.alloc(3200)).toString("base64") });
      if (at % 32000 === 0) p.input({ type: "image", data: image, at: Date.now() });
      await Bun.sleep(100);
    }
  } else p.input({ type: "text", text: "What color fills the camera image? Answer with the color only." });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline && !error && !(text && (!process.env.HAWKY_JOYAI_TTS_URL || audio))) await Bun.sleep(100);
  const passed = /red|红色/i.test(text) && !error && (!process.env.JOYAI_LIVE_WAV || /color/i.test(user)) && (!process.env.HAWKY_JOYAI_TTS_URL || audio > 0);
  console.log({ transcript: text, userTranscript: user, audioChunks: audio, error, passed });
  if (!passed) process.exitCode = 1;
} finally { await p.close(); }
