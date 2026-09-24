/** Opt-in paid smoke test. Synthetic text/image only; no physical mic/camera. */
import { GeminiLiveAdapter } from "../../src/live/providers/gemini";
const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
if (!key) throw new Error("Set GEMINI_API_KEY or GOOGLE_API_KEY");
let audio = 0, text = "", calls = 0;
let resolve: () => void = () => {};
const done = new Promise<void>(r => { resolve = r; });
const model = process.env.GEMINI_LIVE_MODEL || "gemini-3.8-live";
const provider = new GeminiLiveAdapter({ id: crypto.randomUUID(), model, voice: "Kore", bridge: true,
  instructions: "You are Hawk. Wait for a new user request. When asked to delegate call session_send_message; results arrive later. Do not claim completion before a result.",
  history: [{ role: "user", text: "My test color is turquoise." }, { role: "assistant", text: "Noted." }],
  tool: async (_id, name, args) => { calls++; console.log({ tool: name, message: args.message }); return { task_id: "synthetic-task", status: "queued" }; },
  emit: e => {
    if (e.type === "audio") { audio++; provider.input({ type: "playback", id: e.id, played: false }); }
    if (e.type === "caption" && e.role === "assistant") { text = e.text; if (e.final) resolve(); }
    if (e.type === "error") { console.error(e.message); process.exitCode = 1; resolve(); }
  },
}, key);
try {
  await provider.start();
  provider.input({ type: "text", text: "What is my test color? Answer in one short sentence." });
  const timer = setTimeout(resolve, 20000); await done; clearTimeout(timer);
  console.log({ model, audioChunks: audio, transcript: text, recalled: /turquoise/i.test(text), calls });
  if (!audio || !/turquoise/i.test(text)) process.exitCode = 1;
} finally { provider.close(); }
