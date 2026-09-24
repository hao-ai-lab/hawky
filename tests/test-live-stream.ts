import { afterEach, expect, test } from "bun:test";
import { GeminiLiveAdapter, geminiSetup } from "../src/live/providers/gemini";
import { registerLiveStreamMethods, validateStreamInput } from "../src/gateway/live-stream-methods";
import type { StreamEvent, StreamOptions } from "../src/live/stream-contracts";
class Socket extends EventTarget {
  readyState = 1; sent: any[] = [];
  send(s: string) { this.sent.push(JSON.parse(s)); }
  receive(e: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(e) })); }
  close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
const adapters: GeminiLiveAdapter[] = [];
afterEach(() => adapters.splice(0).forEach(a => a.close()));
async function fixture(tool = async (..._args: any[]) => ({ task_id: "work-1", status: "queued" })) {
  const events: StreamEvent[] = [], socket = new Socket();
  const options: StreamOptions = { id: "connection1", model: "gemini-3.8-live", bridge: true, instructions: "Wait silently", history: [{ role: "user", text: "test color is turquoise" }], emit: e => events.push(e), tool };
  const adapter = new GeminiLiveAdapter(options, "fixture-key", () => socket as any); adapters.push(adapter);
  const start = adapter.start(); socket.dispatchEvent(new Event("open")); socket.receive({ setupComplete: {} }); await start;
  return { adapter, socket, events, options };
}
test("Gemini uses native setup and restores text without generating or passing OpenAI thinking fields", async () => {
  const f = await fixture();
  const setup = f.socket.sent[0].setup;
  expect(setup.model).toBe("models/gemini-3.8-live");
  expect(setup.generationConfig.thinkingConfig).toBeUndefined();
  expect(setup.realtimeInputConfig.automaticActivityDetection.disabled).toBe(false);
  expect(setup.realtimeInputConfig.turnCoverage).toBe("TURN_INCLUDES_ALL_INPUT");
  expect(setup.tools[0].functionDeclarations[0].name).toBe("session_send_message");
  expect(f.socket.sent[1].clientContent.turnComplete).toBe(false);
  f.socket.receive({ serverContent: { outputTranscription: { text: "old answer" }, modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } }] }, turnComplete: true } });
  expect(f.events).toEqual([]);
});
test("tool receipts are idempotent; provider cancellation does not cancel durable work", async () => {
  let count = 0; let resolve: (value: unknown) => void = () => {};
  const f = await fixture(async () => { count++; return new Promise(r => { resolve = r; }); });
  f.adapter.input({ type: "text", text: "Read files" });
  const event = { toolCall: { functionCalls: [{ id: "call1", name: "session_send_message", args: { message: "Read files" } }] } };
  f.socket.receive(event); f.socket.receive(event);
  f.socket.receive({ toolCallCancellation: { ids: ["call1"] } });
  resolve({ status: "queued" }); await Promise.resolve(); await Promise.resolve();
  expect(count).toBe(1); expect(f.socket.sent.filter(e => e.toolResponse)).toEqual([]);
});
test("completion waits for generation and audio drain; interruption releases queued work", async () => {
  const f = await fixture(); f.adapter.input({ type: "text", text: "Hello" });
  f.socket.receive({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAAA" } }] }, outputTranscription: { text: "Hello there" } } });
  f.adapter.context("Task completed", true);
  const before = f.socket.sent.length;
  f.socket.receive({ serverContent: { turnComplete: true } }); expect(f.socket.sent).toHaveLength(before);
  const audio = f.events.find(e => e.type === "audio")!;
  f.adapter.input({ type: "playback", id: (audio as any).id, played: true });
  expect(f.socket.sent.at(-1).clientContent.turns[0].parts[0].text).toContain("Task completed");
  expect(f.events.filter(e => e.type === "caption" && e.final).map(e => (e as any).text)).toEqual(["Hello", "Hello there"]);
  f.socket.receive({ serverContent: { interrupted: true } }); expect(f.events.at(-1)?.type).toBe("interrupt");
});
test("mic flush and images use documented native fields", async () => {
  const f = await fixture(); f.adapter.input({ type: "mic", enabled: false });
  expect(f.socket.sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } });
  f.adapter.input({ type: "image", data: "AAAA", at: 1 });
  expect(f.socket.sent.at(-1)).toEqual({ realtimeInput: { video: { data: "AAAA", mimeType: "image/jpeg" } } });
  expect(geminiSetup({ ...f.options, bridge: false }).setup.tools).toBeUndefined();
});
test("typed camera questions pin a fresh image to the same turn, never a stale image", async () => {
  const f = await fixture();
  f.adapter.input({ type: "image", data: "AAAA", at: Date.now() });
  f.adapter.input({ type: "text", text: "What color?" });
  expect(f.socket.sent.at(-1).clientContent.turns[0].parts).toEqual([{ inlineData: { mimeType: "image/jpeg", data: "AAAA" } }, { text: "What color?" }]);
  f.adapter.input({ type: "image", data: "AAAA", at: Date.now() - 10000 });
  f.adapter.input({ type: "text", text: "What now?" });
  expect(f.socket.sent.at(-1).clientContent.turns[0].parts).toEqual([{ text: "What now?" }]);
});
test("media validation rejects unsupported commands, oversized packets, and partial PCM", () => {
  expect(() => validateStreamInput({ type: "audio", data: "AA==" })).toThrow();
  expect(() => validateStreamInput({ type: "audio", data: "A".repeat(90004) })).toThrow();
  expect(() => validateStreamInput({ type: "raw", data: { setup: {} } })).toThrow();
  expect(() => validateStreamInput({ type: "text", text: "" })).toThrow();
  expect(() => validateStreamInput({ type: "audio", data: "AAA=" })).not.toThrow();
});
test("gateway media is connection scoped, transcripts persist once, stop closes provider", async () => {
  const methods = new Map<string, Function>(), events: any[] = [], saved: any[] = []; let options!: StreamOptions; let closed = 0;
  const conn = { clientId: "fixture", deviceTokenId: "a", bindSession() {}, sendEvent: (e: any) => { events.push(e); return true; } };
  registerLiveStreamMethods({ registerMethod: (n: string, f: Function) => methods.set(n, f) } as any,
    { subscribe() {}, list: () => [] } as any, (_key, turn) => saved.push(turn), o => { options = o; return { start: async () => {}, input() {}, context() {}, close: () => { closed++; } }; });
  const p = { id: "fixture-connection", ownerSession: "web:test", model: "gemini-3.8-live", runtime: "native", instructions: "", history: [], gemini_api_key: "test" };
  await methods.get("live.stream.create")!(conn, p);
  await expect(methods.get("live.stream.input")!({ ...conn }, { ...p, input: { type: "text", text: "Hello" } })).rejects.toThrow("not found");
  options.emit({ type: "caption", id: "turn1", role: "user", text: "Hello", final: true }); options.emit({ type: "caption", id: "turn1", role: "user", text: "Hello", final: true });
  expect(saved).toHaveLength(1); expect(events[0].payload.connectionId).toBe(p.id); expect(events[0].payload.id).toBe("turn1");
  await methods.get("live.stream.close")!(conn, p); expect(closed).toBe(1);
});
