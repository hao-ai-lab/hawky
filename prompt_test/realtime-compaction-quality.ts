/** Opt-in, paid eval of the browser's actual compactor. Synthetic inputs only.
 * bun run prompt_test/realtime-compaction-quality.ts --runs 2 --output /tmp/quality.json
 */
import { createCanvas } from "canvas";
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { RealtimeCompaction, type CompactionState } from "../web-ios/src/lib/realtime-compaction";
import { gradeChecks, summaryCases, type Message, type SummaryCase } from "./fixtures/compaction-cases";

function frame(kind: Message["image"]) {
  const canvas = createCanvas(512, 320), ctx = canvas.getContext("2d");
  ctx.fillStyle = "white"; ctx.fillRect(0, 0, 512, 320);
  if (kind !== "blank") {
    ctx.fillStyle = "red"; ctx.beginPath(); ctx.arc(kind === "before" ? 100 : 400, 160, 40, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = "blue"; ctx.fillRect(kind === "before" ? 360 : 60, 120, 80, 80);
  }
  return canvas.toDataURL("image/png");
}
const textOf = (response: any) => (response?.output ?? []).map((i: any) => i.arguments ?? (i.content ?? []).map((p: any) => p.text ?? "").join("\n")).join("\n");

async function trial(key: string, model: string, scenario: SummaryCase) {
  const socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, { headers: { Authorization: `Bearer ${key}` } });
  const events: any[] = [], sent: any[] = [];
  let state: CompactionState | undefined, failure: Error | undefined, disposed = false, privateAudio = 0;
  const send = (e: any) => {
    if (socket.readyState !== WebSocket.OPEN) return false;
    sent.push(e); socket.send(JSON.stringify(e)); return true;
  };
  const compactor = new RealtimeCompaction({ send, isBusy: () => false, lock: () => {}, turnDetection: () => null,
    userReply: () => { failure = new Error("Unexpected automatic reply"); }, change: s => { state = s; }, record: () => {},
    fatal: message => { failure = new Error(message); } });
  socket.addEventListener("message", ({ data }) => {
    const e = JSON.parse(String(data));
    if (compactor.observe(e) && /response\.(output_)?audio\.delta/.test(e.type)) privateAudio++;
    if (e.type === "error") failure = new Error(JSON.stringify(e.error).replaceAll(key, "[redacted]"));
    // Keep diagnostics, never image/audio bytes or credentials.
    events.push(JSON.parse(JSON.stringify(e, (k, v) => ["image_url", "audio", "delta", "client_secret"].includes(k) ? "[omitted]" : v)));
  });
  const fail = () => { if (!disposed) failure ??= new Error("Provider connection closed or failed"); };
  socket.addEventListener("error", fail); socket.addEventListener("close", fail);
  async function wait(match: (e: any) => boolean) {
    const deadline = Date.now() + 45_000;
    while (true) {
      if (failure) throw failure;
      const event = events.find(match); if (event) return event;
      if (Date.now() > deadline) throw new Error("Provider acknowledgement timed out");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  let serial = 0;
  async function item(message: Message) {
    const id = `quality_${++serial}`, role = message.role ?? "user";
    send({ type: "conversation.item.create", item: { id, type: "message", role, content: [
      { type: role === "user" ? "input_text" : "output_text", text: message.text },
      ...(message.image ? [{ type: "input_image", image_url: frame(message.image) }] : []),
    ] } });
    await wait(e => ["conversation.item.added", "conversation.item.created"].includes(e.type) && e.item.id === id);
  }
  try {
    const created = await wait(e => e.type === "session.created");
    send({ type: "session.update", session: { type: "realtime", output_modalities: ["text"], tools: [],
      instructions: "You are Hawk. Answer briefly using conversation evidence. Later user corrections take precedence; do not invent facts or task results.",
      audio: { input: { turn_detection: null } } } });
    await wait(e => e.type === "session.updated");
    for (const message of scenario.messages) await item(message);
    const work = compactor.compact();
    if (scenario.during) await item(scenario.during);
    await work;
    if (failure) throw failure;
    const summaryResponse = events.find(e => e.type === "response.done" && e.response.metadata?.hawk_compaction)?.response;
    const checks: Record<string, boolean> = {
      installed: state?.phase === "complete", privateSummarySilent: privateAudio === 0,
      ...gradeChecks(state?.summary ?? "", scenario.summaryChecks),
    };
    let answer = "";
    if (state?.phase === "complete") {
      await item({ text: scenario.recall });
      send({ type: "response.create", response: { output_modalities: ["text"], metadata: { quality_recall: "yes" } } });
      const done = await wait(e => e.type === "response.done" && e.response.metadata?.quality_recall === "yes");
      answer = textOf(done.response);
      checks.recallCompleted = done.response.status === "completed";
    }
    Object.assign(checks, gradeChecks(answer, scenario.recallChecks));
    return { id: scenario.id, model: created.session.model, pass: Object.values(checks).every(Boolean), checks,
      state, rawSummary: textOf(summaryResponse), summaryOutput: summaryResponse?.output, summaryUsage: summaryResponse?.usage, answer,
      deletionIds: sent.filter(e => e.type === "conversation.item.delete").map(e => e.item_id),
      rejectedWithoutDeletion: state?.phase === "failed" ? !sent.some(e => e.type === "conversation.item.delete") : undefined };
  } finally { disposed = true; compactor.dispose(); socket.close(); }
}

async function main() {
  const { values } = parseArgs({ options: { runs: { type: "string", default: "1" }, case: { type: "string" }, output: { type: "string" }, help: { type: "boolean" } } });
  if (values.help) {
    console.log("Set OPENAI_API_KEY; run with --runs 1..3 [--case case-id] [--output /tmp/report.json]. Paid synthetic sessions; no microphone, playback, or production state.");
    return;
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1 || runs > 3) throw new Error("--runs must be 1..3");
  const cases = summaryCases.filter(c => !values.case || c.id === values.case);
  if (!cases.length) throw new Error(`Unknown case. Choose: ${summaryCases.map(c => c.id).join(", ")}`);
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Set OPENAI_API_KEY; credentials are never printed or saved.");
  const model = process.env.HAWKY_REALTIME_MODEL ?? "gpt-realtime-2", results: any[] = [];
  for (let run = 1; run <= runs; run++) {
    for (const scenario of cases) {
      try {
        const result = { run, ...await trial(key, model, scenario) }; results.push(result);
        console.log(JSON.stringify({ id: result.id, run, pass: result.pass, phase: result.state?.phase,
          failed: Object.entries(result.checks).filter(([, pass]) => !pass).map(([name]) => name) }));
        if (!result.pass) console.log(JSON.stringify({ rawSummary: result.rawSummary, error: result.state?.error }));
      } catch (error) {
        results.push({ id: scenario.id, run, pass: false, error: String(error).replaceAll(key, "[redacted]") });
        console.error(JSON.stringify(results.at(-1))); break;
      }
    }
    if (results.at(-1)?.error) break; // Don't retry authentication/transport/protocol failures.
  }
  const report = { generatedAt: new Date().toISOString(), model, results,
    limitations: "Finite known-fact checks, not a general semantic judge. Synthetic WebSocket sessions; no microphone, ASR, WebRTC playback, long-session or reconnect durability coverage." };
  if (values.output) await writeFile(values.output, JSON.stringify(report, null, 2) + "\n");
  else console.log(JSON.stringify(report, null, 2));
  if (results.length !== runs * cases.length || results.some(r => !r.pass)) process.exitCode = 1;
}
if (import.meta.main) await main();
