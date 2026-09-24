/** Opt-in paid probe. bun scripts/probes/gpt-live.ts
 * Uses synthetic speech only; never records the microphone or prints credentials.
 */
import { loadConfig } from "../../src/storage/config.js";
const key = process.env.OPENAI_API_KEY || loadConfig().api_keys?.openai;
if (!key) throw new Error("Configure OPENAI_API_KEY or the gateway OpenAI key first");
const speech = await fetch("https://api.openai.com/v1/audio/speech", {
  method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
  body: JSON.stringify({ model: "gpt-4o-mini-tts", voice: "alloy", response_format: "pcm",
    input: "Please ask the backend to check the probe. Then tell me its result and the color I told you earlier." }),
});
if (!speech.ok) throw new Error(`Synthetic speech failed: ${speech.status}`);
const pcm = Buffer.from(await speech.arrayBuffer());
const socket = new WebSocket("wss://api.openai.com/v1/live/sessions", { headers: { Authorization: `Bearer ${key}` } });
let tick: ReturnType<typeof setInterval>, closeTimer: ReturnType<typeof setTimeout>;
let offset = 0, audioBytes = 0, delegated = 0, closed = false;
const transcript = { user: "", assistant: "" };
const send = (value: unknown) => socket.send(JSON.stringify(value));
const done = new Promise<void>((resolve, reject) => {
  const deadline = setTimeout(() => { socket.close(); reject(new Error("Probe deadline")); }, 80_000);
  socket.onopen = () => send({ type: "session.start", session: {
    model: "gpt-live-1", store: false, audio: { format: { type: "audio/pcm", rate: 24000 }, output: { voice: "marin" } },
    instructions: "Be concise. Wait silently until the user speaks. Delegate backend checks to the client. Only report the backend result once it arrives. Remember earlier conversation.",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "My favorite color is turquoise." }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "I'll remember turquoise." }] }],
    delegation: { type: "client" },
  } });
  socket.onmessage = event => {
    const e = JSON.parse(String(event.data));
    if (!["session.input_transcript.delta", "session.output_transcript.delta", "session.output_audio.delta"].includes(e.type)) console.log(e.type, e.client_event_id ?? "");
    if (e.type === "session.started") {
      console.log("Session started with client delegation and seeded history");
      tick = setInterval(() => {
        const bytes = offset < pcm.length ? pcm.subarray(offset, offset + 4800) : Buffer.from(new Int16Array(Array.from({ length: 2400 }, (_, i) => Math.round(12 * Math.sin(i * 0.05)))).buffer);
        offset += 4800;
        send({ type: "session.input_audio.append", audio: bytes.toString("base64") });
      }, 100);
      closeTimer = setTimeout(() => send({ type: "session.close" }), 55_000);
    }
    if (e.type === "session.input_transcript.delta") transcript.user += e.delta;
    if (e.type === "session.output_transcript.delta") transcript.assistant += e.delta;
    if (e.type === "session.output_audio.delta") audioBytes += Buffer.from(e.delta, "base64").length;
    if (e.type === "session.delegation.created") {
      delegated++;
      console.log("Client delegation received", { offset_ms: e.offset_ms, keys: Object.keys(e.delegation) });
      setTimeout(() => send({ type: "session.commentary.append", event_id: "probe-result", delegation_id: e.delegation.id,
        content: "The backend probe completed successfully. Its result is silver kite." }), 3000);
    }
    if (e.type === "error") { console.error(e); send({ type: "session.close" }); }
    if (e.type === "session.closed") {
      closed = true; clearTimeout(deadline); clearInterval(tick); clearTimeout(closeTimer); socket.close(); resolve();
    }
  };
  socket.onerror = () => { clearTimeout(deadline); reject(new Error("GPT-Live connection failed")); };
});
try {
  await done;
  console.log(JSON.stringify({ closed, delegated, audioBytes, transcript }, null, 2));
  if (!delegated || !audioBytes || !/turquoise/i.test(transcript.assistant) || !/silver kite/i.test(transcript.assistant)) process.exitCode = 1;
} finally { clearInterval(tick!); clearTimeout(closeTimer!); socket.close(); }
