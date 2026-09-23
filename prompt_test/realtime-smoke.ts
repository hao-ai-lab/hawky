/** Opt-in, paid provider smoke test: OPENAI_API_KEY=... bun run prompt_test/realtime-smoke.ts
 * Uses synthetic memory, actual character templates/builders, and the browser's
 * restoration handshake over WebSocket. Does not test microphone, VAD, or vision.
 */
import { readFileSync } from "node:fs";
import { renderFrontendBootPrompt } from "../src/gateway/frontend-boot-prompt";
import { buildRealtimePrompt } from "../web-ios/src/lib/realtime-prompt";
import { RealtimeStartup, type RestoredTurn } from "../web-ios/src/lib/realtime-startup";
import { DEFAULT_LIVE_SETTINGS } from "../web-ios/src/lib/live-settings";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Set OPENAI_API_KEY in your environment before running the opt-in provider tests.");
const model = process.env.HAWKY_REALTIME_MODEL || DEFAULT_LIVE_SETTINGS.model;
// Exercise the default live activation settings, although no audio is streamed.
const turnDetection = { type: "server_vad", threshold: DEFAULT_LIVE_SETTINGS.vadThreshold,
  prefix_padding_ms: DEFAULT_LIVE_SETTINGS.prefixPaddingMs, silence_duration_ms: DEFAULT_LIVE_SETTINGS.silenceMs,
  create_response: true, interrupt_response: true };
const instructions = buildRealtimePrompt(renderFrontendBootPrompt({
  identity: readFileSync(new URL("../src/templates/IDENTITY.md", import.meta.url), "utf8"),
  soul: readFileSync(new URL("../src/templates/SOUL.md", import.meta.url), "utf8"),
  memory: [], dailyLogs: [], mode: "realtime-web", capabilities: ["text_input", "text_output"], tools: [],
}));

const scenarios: Array<{ id: string; history: RestoredTurn[]; question: string; expected: RegExp }> = [
  { id: "identity", history: [], question: "What is your name?", expected: /\bHawk\b/i },
  { id: "resume-correction", history: [
    { role: "user", text: "My meeting is at three." },
    { role: "assistant", text: "Your meeting is at three." },
    { role: "user", text: "Actually, it moved to four." },
    { role: "assistant", text: "Your meeting is now at four." },
  ], question: "What time is my meeting? Reply with just the time.", expected: /\b(?:4|four)\b/i },
];

async function run(scenario: typeof scenarios[number]) {
  return new Promise<{ id: string; model: string; pass: boolean; response: string; restoreMs: number; firstTextMs?: number; responseMs: number }>((resolve, reject) => {
    const socket = new WebSocket(`wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    let startup: RealtimeStartup;
    let settled = false;
    let queryStarted = 0;
    let restoreMs = 0;
    let firstTextMs: number | undefined;
    let response = "";
    const startedAt = performance.now();
    const finish = (error?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      startup?.cancel();
      socket.close();
      if (error) reject(new Error(error.replaceAll(apiKey!, "[redacted]")));
      else resolve({ id: scenario.id, model, pass: scenario.expected.test(response), response, restoreMs,
        firstTextMs, responseMs: Math.round(performance.now() - queryStarted) });
    };
    const timeout = setTimeout(() => finish("Provider smoke test timed out after 30 seconds."), 30_000);
    const send = (event: object) => {
      if (socket.readyState !== WebSocket.OPEN) return false;
      socket.send(JSON.stringify(event));
      return true;
    };
    socket.addEventListener("message", ({ data }) => {
      const event = JSON.parse(String(data));
      if (event.type === "session.created") {
        startup = new RealtimeStartup({
          session: { type: "realtime", instructions, output_modalities: ["text"], tools: [], audio: { input: { turn_detection: null } } },
          turnDetection, messages: scenario.history, send, record: () => {},
          onFailure: finish,
          onReady: () => {
            restoreMs = Math.round(performance.now() - startedAt);
            queryStarted = performance.now();
            send({ type: "conversation.item.create", item: { type: "message", role: "user", content: [{ type: "input_text", text: scenario.question }] } });
            send({ type: "response.create", response: { output_modalities: ["text"] } });
          },
        });
        startup.start();
      } else startup?.observe(event);
      if (event.type === "error") finish(event.error?.message ?? "Provider error");
      if (event.type === "response.output_text.delta") {
        firstTextMs ??= Math.round(performance.now() - queryStarted);
        response += event.delta;
      }
      if (event.type === "response.output_text.done") response = event.text;
      if (event.type === "response.done") {
        if (event.response?.status === "failed") finish("Provider response failed.");
        else finish();
      }
    });
    socket.addEventListener("error", () => finish("Provider WebSocket connection failed."));
    socket.addEventListener("close", () => { if (!settled) finish("Provider closed before the scenario completed."); });
  });
}

for (const scenario of scenarios) {
  try {
    const result = await run(scenario);
    console.log(JSON.stringify(result));
    if (!result.pass) process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ id: scenario.id, model, pass: false, error: String(error) }));
    process.exitCode = 1;
  }
}
