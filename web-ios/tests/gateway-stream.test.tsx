import { act, cleanup, renderHook, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useRealtime } from "../src/lib/useRealtime";
import { useLiveSettings } from "../src/lib/live-settings";
import { useSocketStore } from "../src/lib/socket-store";
import { LiveSettingsPanel } from "../src/components/LiveSettingsPanel";
const capture = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/media", () => ({ mediaUnavailableReason: () => null, getUserMediaSafe: capture }));
class Stream { getTracks() { return []; } getAudioTracks() { return []; } getVideoTracks() { return []; } }
class Context {
  currentTime = 0; destination = {};
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  async resume() {} async close() {}
}
let rpc: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear(); useLiveSettings.getState().reset();
  useLiveSettings.setState({ model: "gemini-3.8-live", microphoneEnabled: false, cameraEnabled: false });
  vi.stubGlobal("AudioContext", Context); vi.stubGlobal("MediaStream", Stream);
  rpc = vi.fn(async (method: string) => method === "memory.resume" ? { mode: "summary", summary: "User prefers turquoise.", revision: 2, messages: [] } : {});
  useSocketStore.setState({ status: "connected", rpc, eventListeners: new Set() });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it("connects Gemini without an OpenAI secret or RTC connection and restores history", async () => {
  const h = renderHook(() => useRealtime({ sessionKey: "web:gemini" }));
  await act(async () => { await h.result.current.start(); });
  expect(h.result.current.phase).toBe("connected");
  const p = rpc.mock.calls.find(c => c[0] === "live.stream.create")![1] as any;
  expect(p.model).toBe("gemini-3.8-live"); expect(p.history[0].text).toContain("turquoise");
  expect(rpc.mock.calls.some(c => c[0] === "live.openaiClientSecret")).toBe(false);
  await act(async () => { h.result.current.sendText("Hello"); });
  expect(rpc).toHaveBeenCalledWith("live.stream.input", { id: p.id, ownerSession: "web:gemini", input: { type: "text", text: "Hello" } });
  await act(async () => {
    for (const listener of useSocketStore.getState().eventListeners) listener({ type: "event", event: "live.stream.event", payload: { connectionId: p.id, type: "caption", id: "u1", role: "user", text: "Hello", final: true } });
  });
  expect(h.result.current.transcript.filter(t => t.kind === "user").map(t => t.text)).toEqual(["Hello"]);
  expect(rpc.mock.calls.some(c => c[0] === "session.appendMessages")).toBe(false);
  await act(async () => { await h.result.current.stop(); });
  expect(rpc).toHaveBeenCalledWith("live.stream.close", { id: p.id, ownerSession: "web:gemini" });
});
it("late startup after Stop closes the provider and cannot reactivate media", async () => {
  let resolve!: (value: any) => void;
  const base = rpc.getMockImplementation()!;
  rpc.mockImplementation((m: string, p: unknown) => m === "live.stream.create" ? new Promise(r => resolve = r) : base(m,p));
  const h = renderHook(() => useRealtime({ sessionKey: "web:gemini" })); let pending!: Promise<void>;
  await act(async () => { pending = h.result.current.start(); });
  await act(async () => { await h.result.current.stop(); });
  await act(async () => { resolve({}); await pending; });
  expect(h.result.current.phase).toBe("idle"); expect(rpc.mock.calls.some(c => c[0] === "live.stream.close")).toBe(true);
});
it("Gemini settings expose the camera and a separate key, hiding unsupported controls", async () => {
  await act(async () => { render(<LiveSettingsPanel />); });
  expect(screen.getByLabelText("Gemini API key")).toBeInTheDocument();
  expect(screen.getByLabelText("Camera input")).toBeInTheDocument();
  expect(screen.queryByLabelText("VAD threshold")).toBeNull();
  expect(screen.queryByLabelText("Cocktail Party")).toBeNull();
});
