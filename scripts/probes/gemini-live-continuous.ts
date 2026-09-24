/** Opt-in paid regression probe. Synthetic JPEG/WAV only; no physical devices.
 * Unlike gemini-live.ts, this keeps the microphone stream open across turns.
 * GEMINI_LIVE_PROBE=voice (default) or text; both end with a typed follow-up.
 */
import { GeminiLiveAdapter } from "../../src/live/providers/gemini";
import { probePcm } from "./live-media";

const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!key) throw new Error("Set GEMINI_API_KEY or GOOGLE_API_KEY");
const mode = process.env.GEMINI_LIVE_PROBE || "voice";
if (!["voice", "text"].includes(mode)) throw new Error("Use GEMINI_LIVE_PROBE=voice or text");
if (!process.env.GEMINI_LIVE_IMAGE) throw new Error("Set GEMINI_LIVE_IMAGE to a synthetic red JPEG");
if (mode === "voice" && !process.env.GEMINI_LIVE_WAV) throw new Error("Set GEMINI_LIVE_WAV to a synthetic image-color question");
const image = Buffer.from(await Bun.file(process.env.GEMINI_LIVE_IMAGE).arrayBuffer()).toString("base64");
const speech = mode === "voice" ? await probePcm(process.env.GEMINI_LIVE_WAV!) : Buffer.alloc(0);
const replies: string[] = [], usage: any[] = [];
let user = "", audio = 0, error = "";
const model = process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";
const provider = new GeminiLiveAdapter({ id: crypto.randomUUID(), model, bridge: false, history: [],
  instructions: "You are Hawk. Wait for a new user request. Use incoming images. Answer briefly.",
  tool: async () => ({}), emit: e => {
    if (e.type === "audio") { audio++; provider.input({ type: "playback", id: e.id, played: false }); }
    if (e.type === "caption" && e.final) {
      if (e.role === "assistant") replies.push(e.text);
      else user += ` ${e.text}`;
    }
    if (e.type === "diagnostic" && e.detail.usage) usage.push(e.detail.usage);
    if (e.type === "error") error = e.message;
  },
}, key);
try {
  await provider.start();
  let secondAt = 0;
  // 100 ms PCM packets, one frame every five seconds: the browser's default.
  // Do not flush/close audio to force a reply; that masked the original bug.
  for (let tick = 0; tick < 600 && replies.length < 2 && !error; tick++) {
    if (tick % 50 === 0) provider.input({ type: "image", data: image, at: Date.now() });
    const offset = (tick - 60) * 3200;
    const pcm = offset >= 0 && offset < speech.length ? speech.subarray(offset, offset + 3200) : Buffer.alloc(3200);
    provider.input({ type: "audio", data: pcm.toString("base64") });
    if (mode === "text" && tick === 60) provider.input({ type: "text", text: "What color is the image? Answer briefly." });
    if (replies.length === 1 && !secondAt) secondAt = tick + 20;
    if (secondAt && tick === secondAt) provider.input({ type: "text", text: "And what color is it now? Answer briefly." });
    await Bun.sleep(100);
  }
  const passed = !error && replies.length === 2 && replies.every(t => /red/i.test(t)) && audio > 0 &&
    (mode === "text" || /color/i.test(user)) && usage.length >= 2 &&
    usage.every(u => u.promptTokensDetails?.some((d: any) => d.modality === "IMAGE" && d.tokenCount > 0));
  console.log({ model, mode, replies, audioChunks: audio, imageUsageVerified: passed, error: error || undefined, passed });
  if (!passed) process.exitCode = 1;
} finally { provider.close(); }
