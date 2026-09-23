import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { useRealtime } from "../src/lib/useRealtime";
import { useSocketStore } from "../src/lib/socket-store";
import { useLiveSettings } from "../src/lib/live-settings";

vi.mock("../src/lib/media", () => ({ mediaUnavailableReason: () => null,
  getUserMediaSafe: async () => ({ getAudioTracks: () => [], getVideoTracks: () => [], getTracks: () => [] }) }));
import { TestPeer as Peer } from "./helpers/realtime-peer";
let rpc: ReturnType<typeof vi.fn>;
let history: () => Promise<unknown>;
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); Peer.all = []; Peer.autoAcknowledge = true;
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "answer" })));
  useLiveSettings.getState().reset();
  useLiveSettings.getState().set("visualCadence", "off");
  history = async () => ({ messages: [] });
  rpc = vi.fn(async (method: string) => {
    if (method === "session.history") return history();
    if (method === "live.openaiClientSecret") return { client_secret: "test-secret" };
    if (method === "realtime.archive.start") return { closed: false };
    return {};
  });
  useSocketStore.setState({ status: "connected", rpc });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function session(strict: boolean) {
  const hook = renderHook(() => useRealtime({ sessionKey: "web:trace" }), strict ? { wrapper: StrictMode } : {});
  await act(async () => { await hook.result.current.start(); Peer.all[0].channel.open(); });
  const send = async (...events: object[]) => {
    await act(async () => {
      for (const e of events) Peer.all[0].channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(e) }));
    });
  };
  const texts = () => hook.result.current.transcript.filter(e => e.kind === "assistant").map(e => e.text);
  return { ...hook, send, texts };
}
const start = (id = "r1") => ({ type: "response.created", response: { id } });
const delta = (text: string, response_id = "r1", item_id = "i1") => ({ type: "response.output_audio_transcript.delta", response_id, item_id, output_index: 0, content_index: 0, delta: text });
const done = (text: string, response_id = "r1", item_id = "i1") => ({ type: "response.output_audio_transcript.done", response_id, item_id, output_index: 0, content_index: 0, transcript: text });

it.each([false, true])("one completed reply produces one archive and history write (StrictMode=%s)", async strict => {
  const s = await session(strict);
  await s.send(start());
  await s.send(delta("Hello "));
  await s.send(delta("there."));
  expect(s.texts()).toEqual(["Hello there."]);
  await s.send(done("Hello there."));
  await s.send({ type: "response.done", response: { id: "r1", output: [] } });
  await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
  const archived = rpc.mock.calls.filter(c => c[0] === "realtime.archive.append" && (c as any)[1].event.type === "message.completed");
  const saved = rpc.mock.calls.filter(c => c[0] === "session.appendMessages").flatMap(c => (c as any)[1].messages);
  expect(archived).toHaveLength(1);
  expect(saved).toHaveLength(1);
});

it.each([false, true])("batched completion followed by a new reply preserves both texts (StrictMode=%s)", async strict => {
  const s = await session(strict);
  await s.send(start(), delta("First "));
  await s.send(delta("reply."), done("First reply."),
    { type: "response.done", response: { id: "r1", output: [] } },
    start("r2"), delta("Second reply.", "r2", "i2"));
  expect(s.texts()).toEqual(["First reply.", "Second reply."]);
  await s.send(done("Second reply.", "r2", "i2"));
  expect(s.texts()).toEqual(["First reply.", "Second reply."]);
});

it.each([false, true])("a final event for an older response must not overwrite the current reply (StrictMode=%s)", async strict => {
  const s = await session(strict);
  await s.send(start("r1"), delta("First reply."));
  await s.send(start("r2"), delta("New text still streaming", "r2", "i2"));
  await s.send(done("First reply.", "r1", "i1"));
  expect(s.texts()).toContain("New text still streaming");
});

it("demonstrates that a shorter final transcript replaces a longer preview", async () => {
  const s = await session(true);
  const prefix = "Let us find a quiet activity.";
  await s.send(start(), delta(prefix));
  await s.send(delta(" Extra text shown temporarily."));
  await s.send(done(prefix));
  expect(s.texts()).toEqual([prefix]);
});

it("late duplicate completion and deltas cannot change a finalized reply", async () => {
  const s = await session(true);
  await s.send(start(), delta("Complete."), done("Complete."));
  await s.send(done("Wrong replacement."), delta("late suffix"));
  await s.send({ type: "response.done", response: { id: "r1", output: [
    { id: "i1", type: "message", role: "assistant", content: [{ type: "audio", transcript: "Complete." }] },
  ] } });
  await s.send(done("Another late replacement."));
  expect(s.texts()).toEqual(["Complete."]);
  const archived = rpc.mock.calls.filter(c => c[0] === "realtime.archive.append" && (c as any)[1].event.type === "message.completed");
  expect(archived).toHaveLength(1);
  expect((archived[0] as any)[1].event.data).toMatchObject({ responseId: "r1", itemId: "i1", contentIndex: 0 });
});

it("final response fills missing parts without duplicating legacy streamed text", async () => {
  const s = await session(true);
  await s.send(start(), { type: "response.output_audio_transcript.delta", delta: "First." });
  await s.send({ type: "response.done", response: { id: "r1", output: [
    { id: "i1", type: "message", role: "assistant", content: [{ type: "audio", transcript: "First." }] },
    { id: "i2", type: "message", role: "assistant", content: [{ type: "text", text: "Second." }] },
  ] } });
  expect(s.texts()).toEqual(["First.", "Second."]);
  const archived = rpc.mock.calls.filter(c => c[0] === "realtime.archive.append" && (c as any)[1].event.type === "message.completed");
  expect(archived).toHaveLength(2);
});

it("identical text from distinct items is preserved as distinct messages", async () => {
  const s = await session(true);
  await s.send(start(), delta("Yes."), done("Yes."));
  await s.send({ ...delta("Yes.", "r1", "i2"), output_index: 1 },
    { ...done("Yes.", "r1", "i2"), output_index: 1 });
  expect(s.texts()).toEqual(["Yes.", "Yes."]);
});

it("a late response.done preserves both a cancelled partial and the newer response", async () => {
  const s = await session(true);
  await s.send(start(), delta("Interrupted partial"));
  await s.send(start("r2"), delta("New response.", "r2", "i2"));
  await s.send({ type: "response.done", response: { id: "r1", status: "cancelled", output: [] } });
  await s.send(delta(" Still streaming.", "r2", "i2"));
  expect(s.texts()).toEqual(["Interrupted partial", "New response. Still streaming."]);
});

it.each([false, true])("Start waits for pending history before live text (StrictMode=%s)", async strict => {
  let resolveHistory!: (value: unknown) => void;
  history = () => new Promise(resolve => { resolveHistory = resolve; });
  const s = renderHook(() => useRealtime({ sessionKey: "web:slow" }), strict ? { wrapper: StrictMode } : {});
  let starting!: Promise<void>;
  await act(async () => { starting = s.result.current.start(); });
  expect(Peer.all).toHaveLength(0);
  expect(s.result.current.canStart).toBe(false);
  await act(async () => { resolveHistory({ messages: [{ role: "user", content: "Earlier fact." }] }); await starting; Peer.all[0].channel.open(); });
  expect(s.result.current.phase).toBe("connected");
  expect(Peer.all[0].channel.sent.some(e => e.item?.content?.[0]?.text === "Earlier fact.")).toBe(true);
  await act(async () => { Peer.all[0].channel.receive(start()); Peer.all[0].channel.receive(delta("Visible live reply.")); });
  expect(s.result.current.transcript.some(e => e.text === "Visible live reply.")).toBe(true);
});

it.each([false, true])("a stale chat history failure cannot clear the selected chat (StrictMode=%s)", async strict => {
  const rejects: Array<(reason: Error) => void> = [];
  history = () => new Promise((_, reject) => { rejects.push(reject); });
  const s = renderHook(({ key }) => useRealtime({ sessionKey: key }), { initialProps: { key: "web:old" }, ...(strict ? { wrapper: StrictMode } : {}) });
  history = async () => ({ messages: [{ role: "user", content: "Current chat fact." }] });
  s.rerender({ key: "web:new" });
  await act(async () => { await s.result.current.start(); Peer.all[0].channel.open(); });
  await act(async () => { rejects.forEach(reject => reject(new Error("stale history failed"))); });
  expect(s.result.current.phase).toBe("connected");
  expect(s.result.current.error).toBeNull();
  expect(s.result.current.transcript.some(e => e.text === "Current chat fact.")).toBe(true);
});

it("loads history while idle, but does not reload it on Stop", async () => {
  history = async () => ({ messages: [{ role: "assistant", content: "Earlier reply." }] });
  const s = renderHook(() => useRealtime({ sessionKey: "web:idle-history" }), { wrapper: StrictMode });
  await act(async () => {});
  expect(s.result.current.transcript.map(e => e.text)).toEqual(["Earlier reply."]);
  const historyRequests = rpc.mock.calls.filter(c => c[0] === "session.history").length;
  await act(async () => { await s.result.current.start(); Peer.all[0].channel.open(); });
  await act(async () => { void s.result.current.stop(); await vi.advanceTimersByTimeAsync(100); });
  expect(rpc.mock.calls.filter(c => c[0] === "session.history")).toHaveLength(historyRequests);
  expect(s.result.current.transcript.some(e => e.text === "Earlier reply.")).toBe(true);
});
