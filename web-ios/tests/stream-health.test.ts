import { afterEach, expect, it, vi } from "vitest";
import { GatewayStreamProvider } from "../src/lib/live/providers/gateway-stream";

class Node {
  gain = { value: 1 };
  connect() {} disconnect() {}
}
class Context {
  static current: Context;
  state = "running"; currentTime = 0; destination = {};
  outputs: Output[] = [];
  constructor() { Context.current = this; }
  audioWorklet = { addModule: async () => {} };
  createGain() { return new Node(); }
  createMediaStreamSource() { return new Node(); }
  createBuffer(_channels: number, length: number, rate: number) { return { duration: length / rate, copyToChannel() {} }; }
  createBufferSource() { const source = new Output(); this.outputs.push(source); return source; }
  async resume() {} close = vi.fn(async () => { this.state = "closed"; });
}
class Output extends Node {
  buffer: unknown; onended: (() => void) | null = null;
  start() {} stop = vi.fn();
}
class Capture extends Node {
  static current: Capture;
  port = { onmessage: (_event: { data: ArrayBuffer }) => {} };
  onprocessorerror?: () => void;
  constructor() { super(); Capture.current = this; }
}
let connection: GatewayStreamProvider | undefined;
afterEach(async () => { await connection?.close(); connection = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
async function fixture(model = "gemini-3.8-live") {
  vi.useFakeTimers(); vi.stubGlobal("AudioContext", Context); vi.stubGlobal("AudioWorkletNode", Capture);
  const record = vi.fn(), warning = vi.fn(), onError = vi.fn(); let listener!: (event: any) => void;
  const rpc = vi.fn(async (method: string, _params?: any) => method === "live.stream.heartbeat" ? { diagnostics: { provider: "gemini", input: { audioPackets: 1 } } } : {});
  connection = new GatewayStreamProvider({ ownerSession: "web:test", rpc, record, warning, onError,
    caption() {}, subscribe: fn => { listener = fn; return () => {}; } });
  const track = { enabled: true, muted: false, readyState: "live" };
  await connection.connect({ getAudioTracks: () => [track] } as unknown as MediaStream,
    { model, instructions: "", history: [], runtime: "native", bridge: false }, true, true);
  return { record, warning, onError, rpc, track, emit: (e: any) => listener({ event: "live.stream.event", payload: { ...e, connectionId: connection!.id } }) };
}
it("distinguishes silent but flowing audio from a stalled capture, then records recovery", async () => {
  const f = await fixture();
  await vi.advanceTimersByTimeAsync(4900);
  Capture.current.port.onmessage({ data: new ArrayBuffer(3200) });
  await vi.advanceTimersByTimeAsync(100);
  expect(f.warning).not.toHaveBeenCalled();
  expect(f.record).toHaveBeenCalledWith("media.health", expect.objectContaining({ capturePackets: 1, forwardedPackets: 1, peakSinceLastCheck: 0, captureGapMs: 100 }));
  expect(f.record).toHaveBeenCalledWith("provider.health", expect.objectContaining({ input: { audioPackets: 1 } }));
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.warning).toHaveBeenCalledOnce(); // no repeated warning every heartbeat
  expect(f.warning.mock.calls[0][0]).toContain("stopped producing audio packets");
  Capture.current.port.onmessage({ data: new Int16Array([16384, -16384]).buffer });
  await vi.advanceTimersByTimeAsync(1);
  Capture.current.port.onmessage({ data: new ArrayBuffer(3200) });
  await vi.advanceTimersByTimeAsync(4999);
  expect(f.record).toHaveBeenCalledWith("media.recovered", {});
  expect(f.record).toHaveBeenCalledWith("media.health", expect.objectContaining({ peakSinceLastCheck: 0.5 }));
  await connection!.close(); const count = f.record.mock.calls.length;
  await vi.advanceTimersByTimeAsync(20000); expect(f.record).toHaveBeenCalledTimes(count);
});
it("reports browser-muted tracks but never treats an intentional mic-off as a capture failure", async () => {
  const f = await fixture(); f.track.muted = true;
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.warning.mock.calls[0][0]).toContain("browser has muted");
  connection!.mic(false); f.warning.mockClear();
  await vi.advanceTimersByTimeAsync(20000); expect(f.warning).not.toHaveBeenCalled();
});
it.each(["provider", "worklet"])("archives the first %s error before notifying the UI and ignores later errors", async kind => {
  const f = await fixture();
  f.onError.mockImplementation(message => expect(f.record).toHaveBeenCalledWith("provider.error", { message }));
  if (kind === "provider") f.emit({ type: "error", message: "Quota exhausted" });
  Capture.current.onprocessorerror!();
  f.emit({ type: "error", message: "Another error" });
  expect(f.onError).toHaveBeenCalledOnce();
  expect(f.onError).toHaveBeenCalledWith(kind === "provider" ? "Quota exhausted" : expect.stringContaining("audio processing stopped"));
  expect(JSON.stringify(f.record.mock.calls)).not.toContain("data");
});

function queueSpeech(emit: (event: any) => void, count = 60) {
  // Joy TTS splits a spoken answer into many small PCM chunks.
  const data = btoa("\0".repeat(12000));
  for (let i = 0; i < count; i++) emit({ type: "audio", id: `chunk-${i}`, data, rate: 24000 });
}
const receipts = (rpc: ReturnType<typeof vi.fn>) => rpc.mock.calls
  .filter(([method, p]) => method === "live.stream.input" && p.input.type === "playback")
  .map(([, p]) => p.input);

it.each(["joyai-vl-interaction", "gemini-3.8-live", "realtime-venus-omni"])("plays a full minute from %s without a duration cutoff", async model => {
  const f = await fixture(model); queueSpeech(f.emit, 240);
  await vi.advanceTimersByTimeAsync(5000);
  expect(f.onError).not.toHaveBeenCalled();
  expect(f.record).toHaveBeenCalledWith("media.health", expect.objectContaining({ playbackChunks: 240, playbackQueuedMs: 60000 }));
  for (const output of Context.current.outputs) output.onended?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(receipts(f.rpc)).toHaveLength(240);
  expect(receipts(f.rpc).every(receipt => receipt.played)).toBe(true);
  expect(f.onError).not.toHaveBeenCalled();
});

it.each(["interrupt", "mute", "finished"])("drains a burst of playback receipts on %s without failing the media connection", async action => {
  const f = await fixture(); queueSpeech(f.emit);
  if (action === "interrupt") f.emit({ type: "interrupt" });
  else if (action === "mute") connection!.speaker(false);
  else for (const output of Context.current.outputs) output.onended?.();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.onError).not.toHaveBeenCalled();
  expect(receipts(f.rpc)).toEqual(Array.from({ length: 60 }, (_, i) => ({ type: "playback", id: `chunk-${i}`, played: action === "finished" })));
  connection!.text("Still connected");
  expect(f.rpc).toHaveBeenCalledWith("live.stream.input", expect.objectContaining({ input: { type: "text", text: "Still connected" } }));
});

it("Stop with queued speech closes once without sending interruption receipts or errors", async () => {
  const f = await fixture(); queueSpeech(f.emit);
  f.onError.mockImplementation(() => { void connection!.close(); });
  const closing = connection!.close(); expect(connection!.close()).toBe(closing);
  await closing;
  expect(f.onError).not.toHaveBeenCalled();
  expect(receipts(f.rpc)).toHaveLength(0);
  expect(Context.current.close).toHaveBeenCalledOnce();
  expect(Context.current.outputs.every(output => output.stop.mock.calls.length === 1)).toBe(true);
  expect(f.rpc.mock.calls.filter(([method]) => method === "live.stream.close")).toHaveLength(1);
});

it("a genuinely stalled gateway fails once and releases playback and capture without recursion", async () => {
  const f = await fixture(); queueSpeech(f.emit); await vi.advanceTimersByTimeAsync(0);
  const base = f.rpc.getMockImplementation()!;
  const pending: (() => void)[] = [];
  f.rpc.mockImplementation((method: string) => method === "live.stream.input"
    ? new Promise(resolve => pending.push(() => resolve({}))) : base(method));
  f.onError.mockImplementation(() => { void connection!.close(); });
  for (let i = 0; i < 25; i++) Capture.current.port.onmessage({ data: new ArrayBuffer(3200) });
  pending.forEach(resolve => resolve()); await vi.advanceTimersByTimeAsync(0);
  expect(f.onError).toHaveBeenCalledOnce();
  expect(f.onError).toHaveBeenCalledWith(expect.stringContaining("falling behind"));
  expect(Context.current.close).toHaveBeenCalledOnce();
  expect(receipts(f.rpc)).toHaveLength(0);
  const count = f.rpc.mock.calls.length;
  Capture.current.port.onmessage({ data: new ArrayBuffer(3200) });
  await vi.advanceTimersByTimeAsync(10000);
  expect(f.rpc).toHaveBeenCalledTimes(count);
});

it("slow playback acknowledgements stay bounded without blocking microphone or typed input", async () => {
  const f = await fixture(); await vi.advanceTimersByTimeAsync(0);
  const base = f.rpc.getMockImplementation()!;
  const pending: (() => void)[] = [];
  let active = 0, peak = 0;
  f.rpc.mockImplementation((method: string, params: any) => {
    if (method !== "live.stream.input" || params.input.type !== "playback") return base(method, params);
    active++; peak = Math.max(peak, active);
    return new Promise(resolve => pending.push(() => { active--; resolve({}); }));
  });
  queueSpeech(f.emit); f.emit({ type: "interrupt" });
  expect(receipts(f.rpc)).toHaveLength(4);
  Capture.current.port.onmessage({ data: new ArrayBuffer(3200) });
  connection!.text("Next question");
  expect(f.rpc).toHaveBeenCalledWith("live.stream.input", expect.objectContaining({ input: expect.objectContaining({ type: "audio" }) }));
  expect(f.rpc).toHaveBeenCalledWith("live.stream.input", expect.objectContaining({ input: { type: "text", text: "Next question" } }));
  for (let i = 0; i < 15; i++) {
    pending.splice(0).forEach(resolve => resolve()); await vi.advanceTimersByTimeAsync(0);
  }
  expect(peak).toBe(4); expect(active).toBe(0);
  expect(receipts(f.rpc)).toHaveLength(60);
  expect(new Set(receipts(f.rpc).map(receipt => receipt.id)).size).toBe(60);
  expect(f.onError).not.toHaveBeenCalled();
});

it("closing with receipts in flight discards the queue and ignores late RPC failures", async () => {
  const f = await fixture(); await vi.advanceTimersByTimeAsync(0);
  const base = f.rpc.getMockImplementation()!;
  const pending: ((reason: Error) => void)[] = [];
  f.rpc.mockImplementation((method: string, params: any) => method === "live.stream.input" && params.input.type === "playback"
    ? new Promise((_, reject) => pending.push(reject)) : base(method, params));
  queueSpeech(f.emit); f.emit({ type: "interrupt" });
  await connection!.close();
  pending.forEach(reject => reject(new Error("Socket closed"))); await vi.advanceTimersByTimeAsync(0);
  expect(receipts(f.rpc)).toHaveLength(4);
  expect(f.onError).not.toHaveBeenCalled();
  expect(Context.current.close).toHaveBeenCalledOnce();
});
