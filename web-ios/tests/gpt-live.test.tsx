import { act, cleanup, renderHook, render, screen, fireEvent } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TestPeer as Peer } from "./helpers/realtime-peer";
import { useRealtime } from "../src/lib/useRealtime";
import { useLiveSettings } from "../src/lib/live-settings";
import { useSocketStore } from "../src/lib/socket-store";
import { LiveSettingsPanel } from "../src/components/LiveSettingsPanel";
const capture = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/media", () => ({ mediaUnavailableReason: () => null, getUserMediaSafe: capture }));
class SilentClock {
  static closed = 0;
  createMediaStreamDestination() { return { stream: new Stream() }; }
  createConstantSource() { return { offset: { value: 0 }, connect() {}, start() {} }; }
  async resume() {} async close() { SilentClock.closed++; }
}
class Stream {
  getTracks() { return []; } getAudioTracks() { return []; } getVideoTracks() { return []; }
}
let rpc: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); Peer.all = []; Peer.autoAcknowledge = true; capture.mockReset(); capture.mockResolvedValue(new Stream());
  vi.stubGlobal("AudioContext", SilentClock); vi.stubGlobal("RTCPeerConnection", Peer); vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "answer" })));
  useLiveSettings.getState().reset(); useLiveSettings.getState().set("model", "gpt-live-1");
  useLiveSettings.getState().set("microphoneEnabled", false);
  rpc = vi.fn(async (method: string) => {
    if (method === "live.gpt.create") return { id: `live_${Peer.all.length}`, sdp: "answer" };
    if (method === "live.openaiClientSecret") return { client_secret: "fixture" };
    if (method === "memory.resume") return { mode: "summary", summary: "User prefers turquoise.", revision: 2, messages: [{ role: "user", text: "Read A" }] };
    return {};
  });
  useSocketStore.setState({ status: "connected", rpc, eventListeners: new Set() });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function connect(h: ReturnType<typeof renderHook<ReturnType<typeof useRealtime>, unknown>>) {
  await act(async () => { await h.result.current.start(); Peer.all.at(-1)!.channel.open(); Peer.all.at(-1)!.channel.receive({ type: "session.started" }); });
  return Peer.all.at(-1)!;
}
it("restores summary and tail at creation, stays quiet, uses no Realtime wire commands or camera", async () => {
  const h = renderHook(() => useRealtime({ sessionKey: "web:gpt" }));
  h.result.current.audioElRef.current = document.createElement("audio");
  const peer = await connect(h);
  expect(h.result.current.audioElRef.current.muted).toBe(true);
  expect(h.result.current.phase).toBe("connected"); expect(h.result.current.cameraOn).toBe(false); expect(capture).not.toHaveBeenCalled();
  const params = rpc.mock.calls.find(c => c[0] === "live.gpt.create")![1] as any;
  expect(params.ownerSession).toBe("web:gpt"); expect(params.history[0].text).toContain("turquoise"); expect(params.history[1].text).toBe("Read A");
  expect(params.instructions).toContain("Wait silently");
  expect(peer.channel.sent.map(e => e.type)).toEqual(["session.input_audio.mute"]);
  await act(async () => { peer.channel.receive({ type: "session.output_transcript.delta", event_id: "unsolicited", delta: "Welcome back", start_ms: 0, end_ms: 100 }); });
  expect(h.result.current.transcript.some(t => t.text === "Welcome back")).toBe(false);
  expect(h.result.current.audioElRef.current!.muted).toBe(true);
  await act(async () => { h.result.current.compactNow(); h.result.current.toggleCamera(); h.result.current.toggleStaySilent(); });
  expect(peer.channel.sent.some(e => e.type.startsWith("conversation.") || e.type === "response.create")).toBe(false);
});
it("browser captions never dispatch or persist the gateway-owned task/transcript twice", async () => {
  const h = renderHook(() => useRealtime({ sessionKey: "web:gpt" })); const peer = await connect(h);
  await act(async () => {
    peer.channel.receive({ type: "session.input_transcript.delta", event_id: "user-1", delta: "What color?", start_ms: 0, end_ms: 50 });
    const e = { type: "session.output_transcript.delta", event_id: "part-1", delta: "tur", start_ms: 100, end_ms: 200 };
    peer.channel.receive(e); peer.channel.receive(e);
    peer.channel.receive({ ...e, event_id: "part-2", delta: "quoise", start_ms: 200, end_ms: 300 });
    peer.channel.receive({ type: "session.delegation.created", delegation: { id: "delegate1", target: "client" } });
    await vi.advanceTimersByTimeAsync(2200);
  });
  expect(h.result.current.transcript.filter(t => t.kind === "assistant").map(t => t.text)).toEqual(["turquoise"]);
  expect(rpc.mock.calls.some(c => c[0] === "session.appendMessages" || c[0] === "delegation.submit")).toBe(false);
});
it("typed input uses the selected backend and Stop closes both connections without cancelling tasks", async () => {
  const h = renderHook(() => useRealtime({ sessionKey: "web:gpt" })); const peer = await connect(h);
  await act(async () => { h.result.current.sendText("Read A"); });
  expect(rpc).toHaveBeenCalledWith("live.gpt.text", { id: "live_1", ownerSession: "web:gpt", text: "Read A" });
  await act(async () => { const stopping = h.result.current.stop(); await vi.advanceTimersByTimeAsync(100); await stopping; });
  expect(rpc).toHaveBeenCalledWith("live.gpt.close", { id: "live_1", ownerSession: "web:gpt" });
  expect(peer.channel.sent.at(-1).type).toBe("session.close"); expect(peer.connectionState).toBe("closed");
  expect(rpc.mock.calls.some(c => c[0] === "delegation.cancel")).toBe(false);
});
it("switch opens a new provider connection under the same conversation with restored history", async () => {
  const h = renderHook(() => useRealtime({ sessionKey: "web:gpt" })); const old = await connect(h);
  await act(async () => { useLiveSettings.getState().set("model", "gpt-realtime-2"); });
  expect(h.result.current.activeModel).toBe("gpt-live-1");
  await act(async () => { const switching = h.result.current.reconnect(); await vi.advanceTimersByTimeAsync(100); await switching; });
  const next = Peer.all.at(-1)!;
  expect(next).not.toBe(old); expect(old.connectionState).toBe("closed");
  await act(async () => { next.channel.open(); });
  expect(h.result.current.activeModel).toBe("gpt-realtime-2");
  expect(next.channel.sent.filter(e => e.type === "conversation.item.create").some(e => e.item.content[0].text.includes("turquoise"))).toBe(true);
  expect(rpc.mock.calls.some(c => c[0] === "session.appendMessages")).toBe(false);
});
it("late startup after Stop closes the orphan session and cannot activate it", async () => {
  let resolve!: (value: any) => void;
  const base = rpc.getMockImplementation()!;
  rpc.mockImplementation((m: string, p: unknown) => m === "live.gpt.create" ? new Promise(r => resolve = r) : base(m,p));
  const h = renderHook(() => useRealtime({ sessionKey: "web:gpt" }));
  let pending!: Promise<void>;
  await act(async () => { pending = h.result.current.start(); });
  await act(async () => { const stopping = h.result.current.stop(); await vi.advanceTimersByTimeAsync(100); await stopping; });
  await act(async () => { resolve({ id: "live_late", sdp: "answer" }); await pending; });
  expect(h.result.current.phase).toBe("idle"); expect(rpc).toHaveBeenCalledWith("live.gpt.close", { id: "live_late", ownerSession: "web:gpt" });
});
it("settings hide unsupported controls without discarding other provider preferences", async () => {
  await act(async () => { render(<LiveSettingsPanel />); });
  expect(screen.queryByLabelText("VAD threshold")).toBeNull(); expect(screen.queryByLabelText("Camera input")).toBeNull();
  expect(screen.getByText(/Task interpretation uses gpt-5.4-mini/)).toBeInTheDocument();
  await act(async () => { fireEvent.change(screen.getByLabelText("Realtime model"), { target: { value: "gpt-realtime-2" } }); });
  expect(screen.getByLabelText("Camera input")).toBeChecked();
});
