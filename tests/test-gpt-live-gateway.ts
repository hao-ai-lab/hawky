import { afterEach, expect, test } from "bun:test";
import { registerGptLiveMethods } from "../src/gateway/gpt-live-methods.js";

const originalFetch = globalThis.fetch, OriginalSocket = globalThis.WebSocket;
class Socket extends EventTarget {
  static OPEN = 1; static all: Socket[] = [];
  readyState = 0; sent: any[] = [];
  constructor() { super(); Socket.all.push(this); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
  receive(e: object) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(e) })); }
  send(text: string) { const e = JSON.parse(text); this.sent.push(e); if (e.type === "session.close") queueMicrotask(() => this.receive({ type: "session.closed" })); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event("close")); }
}
afterEach(() => { for (const socket of Socket.all) socket.close(); Socket.all = []; globalThis.fetch = originalFetch; globalThis.WebSocket = OriginalSocket; });
function fixture() {
  const methods = new Map<string, Function>(), requests: any[] = [], saved: any[] = [], events: any[] = [];
  globalThis.WebSocket = Socket as any;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(init.body)) });
    if (url.endsWith("/responses")) return new Response(JSON.stringify({ output: [{ content: [{ type: "output_text", text: JSON.stringify({ actions: [], clarification: "Which folder?" }) }] }] }));
    return new Response(JSON.stringify({ session: { id: `live_${requests.length}` }, transport: { sdp: "answer" } }));
  }) as any;
  registerGptLiveMethods({ registerMethod: (n: string, fn: Function) => methods.set(n, fn), broadcastToSession: (...args: any[]) => events.push(args) } as any,
    { subscribe() {}, list: () => [] } as any, (_key, turn) => saved.push(turn));
  const conn = { deviceTokenId: "owner-a", clientId: "test", bindSession() {} };
  return { requests, saved, events, call: (n: string, p: any, c = conn) => methods.get(n)!(c, p) };
}
const config = { model: "gpt-live-1", ownerSession: "web:fixture", instructions: "Wait silently", voice: "marin", runtime: "native", bridge: true, sdp: "v=0\r\n", history: [], byok_api_key: "sk-fixture-not-a-real-key-0000000000000000" };
test("sideband connection is private to its owner and app conversation; close flushes captions", async () => {
  const f = fixture(); const result = await f.call("live.gpt.create", config);
  expect(result).toEqual({ id: "live_1", sdp: "answer", model: "gpt-live-1" });
  expect(() => f.call("live.gpt.heartbeat", { id: result.id, ownerSession: "web:other" })).toThrow("not found");
  expect(() => f.call("live.gpt.ready", { id: result.id, ownerSession: config.ownerSession }, { deviceTokenId: "owner-b", clientId: "test", bindSession() {} })).toThrow("not found");
  Socket.all[0].receive({ type: "session.input_transcript.delta", event_id: "u1", delta: "turquoise", start_ms: 0, end_ms: 500 });
  await f.call("live.gpt.close", { id: result.id, ownerSession: config.ownerSession });
  expect(f.saved.map(t => t.text)).toEqual(["turquoise"]);
  expect(Socket.all[0].readyState).toBe(3);
  expect(() => f.call("live.gpt.heartbeat", { id: result.id, ownerSession: config.ownerSession })).toThrow("not found");
});
test("replacing a provider connection closes the old sideband without executing backend work", async () => {
  const f = fixture(); await f.call("live.gpt.create", config); await f.call("live.gpt.create", config);
  expect(Socket.all[0].readyState).toBe(3); expect(Socket.all[1].readyState).toBe(1);
  expect(f.requests.every(r => r.url.endsWith("/live/sessions"))).toBe(true);
  expect(f.requests[1].body.session.delegation).toEqual({ type: "client" });
});
test("typed requests are scoped, validated and acknowledged while interpretation runs", async () => {
  const f = fixture(); const live = await f.call("live.gpt.create", config);
  const scope = { id: live.id, ownerSession: config.ownerSession };
  expect(() => f.call("live.gpt.text", { ...scope, text: 123 })).toThrow("message");
  const receipt = f.call("live.gpt.text", { ...scope, text: "Read the folder" });
  expect(receipt).toEqual({ ok: true });
  await new Promise(r => setTimeout(r, 0));
  expect(f.saved.map(t => t.text)).toEqual(["Read the folder"]);
  expect(Socket.all[0].sent.some(e => e.type === "session.commentary.append" && e.content === "Which folder?")).toBe(true);
});
