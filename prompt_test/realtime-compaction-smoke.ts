/** Opt-in paid smoke test of the SAME compactor used by Live. Synthetic data only.
 * OPENAI_API_KEY=... bun run prompt_test/realtime-compaction-smoke.ts
 * No microphone, gateway state, user files, or production conversations touched.
 */
import { createCanvas } from "canvas";
import { RealtimeCompaction, type CompactionState } from "../web-ios/src/lib/realtime-compaction";
const key = process.env.OPENAI_API_KEY;
if (!key) throw new Error("Set OPENAI_API_KEY to run this paid smoke test.");
const model = process.env.HAWKY_REALTIME_MODEL ?? "gpt-realtime-2";
const socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${key}` } });
const events: any[] = [];
let state: CompactionState | undefined;
let failure: Error | undefined;
let privateAudio = 0;
const send = (event: any) => { if (socket.readyState !== WebSocket.OPEN) return false; socket.send(JSON.stringify(event)); return true; };
const compactor = new RealtimeCompaction({ send, isBusy: () => false, lock: () => {}, turnDetection: () => null,
  userReply: () => { throw new Error("Unexpected spoken reply"); }, change: next => { state = next; }, record: () => {},
  fatal: message => { failure = new Error(message); } });
socket.addEventListener("message", ({ data }) => {
  const e = JSON.parse(String(data));
  const consumed = compactor.observe(e);
  if (consumed && /response\.(output_)?audio\.delta/.test(e.type)) privateAudio++;
  if (e.type === "error") failure = new Error(JSON.stringify(e.error).replaceAll(key, "[redacted]"));
  // Omit all media bytes from retained evidence.
  events.push(JSON.parse(JSON.stringify(e, (k, v) => ["image_url", "audio", "delta", "client_secret"].includes(k) ? "[omitted]" : v)));
});
socket.addEventListener("error", () => { failure = new Error("Provider transport error"); });
async function wait(match: (e: any) => boolean) {
  const deadline = Date.now() + 30_000;
  while (true) {
    if (failure) throw failure;
    const event = events.find(match); if (event) return event;
    if (Date.now() > deadline) throw new Error("Provider acknowledgement timed out");
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}
let serial = 0;
async function item(text: string, visual = false) {
  const id = `smoke${++serial}`;
  const content: any[] = [{ type: "input_text", text }];
  if (visual) {
    const canvas = createCanvas(512, 320); const ctx = canvas.getContext("2d");
    ctx.fillStyle = "white"; ctx.fillRect(0, 0, 512, 320);
    ctx.fillStyle = "red"; ctx.beginPath(); ctx.arc(100, 160, 48, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "blue"; ctx.fillRect(330, 112, 96, 96);
    content.push({ type: "input_image", image_url: canvas.toDataURL("image/png") });
  }
  send({ type: "conversation.item.create", item: { id, type: "message", role: "user", content } });
  await wait(e => ["conversation.item.added", "conversation.item.created"].includes(e.type) && e.item.id === id);
}
try {
  await wait(e => e.type === "session.created");
  send({ type: "session.update", session: { type: "realtime", output_modalities: ["text"],
    instructions: "Answer questions precisely from conversation evidence. Later corrections take precedence.",
    audio: { input: { turn_detection: null } }, tools: [] } });
  await wait(e => e.type === "session.updated");
  await item("Remember this picture and my locker code: PINE-73.", true);
  await item("My meeting is at 15:00.");
  await item("Correction: the meeting is at 16:00.");
  for (const text of ["I like tea.", "It is a quiet afternoon.", "I have a blue notebook.", "The notebook is on my desk."]) await item(text);
  await item("Most recent camera frame.", true);
  const work = compactor.compact();
  // Arrives after the snapshot: must survive replacement and take precedence.
  await item("Latest correction: the meeting is now at 17:00.");
  await work;
  if (state?.phase !== "complete" || privateAudio) throw new Error(`Compaction failed: ${JSON.stringify(state)}`);
  await item("What is my locker code, what two shapes/colors did you see in the first picture, and what is the latest meeting time? Answer concisely.");
  send({ type: "response.create", response: { output_modalities: ["text"], metadata: { smoke_followup: "yes" } } });
  const done = await wait(e => e.type === "response.done" && e.response.metadata?.smoke_followup === "yes");
  const answer = (done.response.output ?? []).flatMap((i: any) => i.content ?? []).map((p: any) => p.text ?? "").join("\n");
  const checks = { code: /PINE-73/i.test(answer), latestCorrection: /17:00|5\s*(?:pm|p\.m\.)/i.test(answer),
    visual: /red/i.test(answer) && /circle/i.test(answer) && /blue/i.test(answer) && /square/i.test(answer), noPrivateAudio: privateAudio === 0 };
  console.log(JSON.stringify({ model, state, answer, checks }, null, 2));
  if (Object.values(checks).some(v => !v)) process.exitCode = 1;
} catch (error) {
  console.error(error instanceof Error ? error.message.replaceAll(key, "[redacted]") : "Smoke test failed"); process.exitCode = 1;
} finally { compactor.dispose(); socket.close(); }
