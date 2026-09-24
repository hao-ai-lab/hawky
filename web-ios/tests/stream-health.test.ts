import { afterEach, expect, it, vi } from "vitest";
import { GatewayStreamProvider } from "../src/lib/live/providers/gateway-stream";

class Node {
  gain = { value: 1 };
  connect() {} disconnect() {}
}
class Context {
  state = "running"; currentTime = 0; destination = {};
  audioWorklet = { addModule: async () => {} };
  createGain() { return new Node(); }
  createMediaStreamSource() { return new Node(); }
  async resume() {} async close() {}
}
class Capture extends Node {
  static current: Capture;
  port = { onmessage: (_event: { data: ArrayBuffer }) => {} };
  onprocessorerror?: () => void;
  constructor() { super(); Capture.current = this; }
}
let connection: GatewayStreamProvider | undefined;
afterEach(async () => { await connection?.close(); connection = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });
async function fixture() {
  vi.useFakeTimers(); vi.stubGlobal("AudioContext", Context); vi.stubGlobal("AudioWorkletNode", Capture);
  const record = vi.fn(), warning = vi.fn(), onError = vi.fn(); let listener!: (event: any) => void;
  const rpc = vi.fn(async (method: string) => method === "live.stream.heartbeat" ? { diagnostics: { provider: "gemini", input: { audioPackets: 1 } } } : {});
  connection = new GatewayStreamProvider({ ownerSession: "web:test", rpc, record, warning, onError,
    caption() {}, subscribe: fn => { listener = fn; return () => {}; } });
  const track = { enabled: true, muted: false, readyState: "live" };
  await connection.connect({ getAudioTracks: () => [track] } as unknown as MediaStream,
    { model: "gemini-3.8-live", instructions: "", history: [], runtime: "native", bridge: false }, true, true);
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
it("archives provider and worklet errors before notifying the UI", async () => {
  const f = await fixture();
  f.onError.mockImplementation(message => expect(f.record).toHaveBeenCalledWith("provider.error", { message }));
  f.emit({ type: "error", message: "Quota exhausted" });
  Capture.current.onprocessorerror!();
  expect(f.onError).toHaveBeenCalledWith("Quota exhausted");
  expect(f.onError).toHaveBeenCalledWith(expect.stringContaining("audio processing stopped"));
  expect(JSON.stringify(f.record.mock.calls)).not.toContain("data");
});
