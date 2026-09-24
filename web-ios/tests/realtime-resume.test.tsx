import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TestPeer as Peer } from "./helpers/realtime-peer";
import { useRealtime } from "../src/lib/useRealtime";
import { useSocketStore } from "../src/lib/socket-store";
import { useLiveSettings } from "../src/lib/live-settings";

const media = vi.hoisted(() => ({ audio: { enabled: true, stop: vi.fn() } }));
vi.mock("../src/lib/media", () => ({ mediaUnavailableReason: () => null,
  getUserMediaSafe: async () => ({ getAudioTracks: () => [media.audio], getVideoTracks: () => [], getTracks: () => [media.audio] }) }));
let history: (key: string) => Promise<unknown>;
let archiveMessages: Array<{ role: string; text: string }> | undefined;
let memoryPacket: unknown;
let rpc: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); Peer.all = []; Peer.autoAcknowledge = true;
  media.audio.enabled = true; media.audio.stop.mockClear(); archiveMessages = undefined; memoryPacket = { mode: "history", reason: "missing" };
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "answer" })));
  useLiveSettings.getState().reset(); useLiveSettings.getState().set("visualCadence", "off");
  history = async () => ({ messages: [{ role: "user", content: "My meeting is at three." }, { role: "assistant", content: "Three o'clock." }] });
  rpc = vi.fn(async (method: string, params: any) => {
    if (method === "session.history") return history(params.sessionKey);
    if (method === "memory.resume") return memoryPacket;
    if (method === "frontend.boot_context") return { context: "Test workspace context." };
    if (method === "live.openaiClientSecret") return { client_secret: "test-secret" };
    if (method === "realtime.archive.start") return { closed: false, messages: archiveMessages };
    return {};
  });
  useSocketStore.setState({ status: "connected", rpc });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const messages = (peer: Peer) => peer.channel.sent.filter(e => e.type === "conversation.item.create").map(e => e.item.content[0].text);
const events = () => rpc.mock.calls.filter(c => c[0] === "realtime.archive.append").map(c => c[1].event);
async function stop(hook: ReturnType<typeof renderHook<ReturnType<typeof useRealtime>, unknown>>) {
  await act(async () => { const stopped = hook.result.current.stop(); await vi.advanceTimersByTimeAsync(100); await stopped; });
}

it("keeps mic, typed messages, and live readiness blocked until replay and activation are acknowledged", async () => {
  Peer.autoAcknowledge = false;
  const hook = renderHook(() => useRealtime({ sessionKey: "web:ack" }));
  await act(async () => { await hook.result.current.start(); Peer.all[0].channel.open(); });
  const channel = Peer.all[0].channel;
  expect(hook.result.current.phase).toBe("restoring");
  expect(media.audio.enabled).toBe(false);
  await act(async () => { hook.result.current.sendText("Too early"); });
  expect(messages(Peer.all[0])).toEqual([]);
  await act(async () => { channel.receive({ type: "session.updated", session: channel.sent[0].session }); });
  const items = channel.sent.filter(e => e.type === "conversation.item.create");
  expect(items).toHaveLength(2);
  await act(async () => { channel.receive({ type: "conversation.item.added", item: items[0].item }); });
  expect(media.audio.enabled).toBe(false);
  await act(async () => { channel.receive({ type: "conversation.item.added", item: items[1].item }); });
  expect(hook.result.current.phase).toBe("restoring");
  await act(async () => { channel.receive({ type: "session.updated", session: channel.sent.at(-1).session }); });
  expect(hook.result.current.phase).toBe("connected");
  expect(media.audio.enabled).toBe(true);
  expect(channel.sent.some(e => e.type === "response.create")).toBe(false);
  expect(events().some(e => e.type === "context.ready" && e.data.restoredMessageCount === 2)).toBe(true);
});

it("retries a failed history request instead of starting a conversation with no context", async () => {
  history = async () => { throw new Error("history unavailable"); };
  const hook = renderHook(() => useRealtime({ sessionKey: "web:retry" }));
  await act(async () => { await hook.result.current.start(); });
  expect(hook.result.current.phase).toBe("failed");
  expect(Peer.all).toHaveLength(0);
  expect(hook.result.current.canStart).toBe(true);
  history = async () => ({ messages: [{ role: "user", content: "Recovered fact." }] });
  await act(async () => { await hook.result.current.start(); Peer.all[0].channel.open(); });
  expect(messages(Peer.all[0])).toEqual(["Recovered fact."]);
  expect(hook.result.current.phase).toBe("connected");
});

it("switching chats and a late old history response cannot mix their replay packets", async () => {
  let resolveOld!: (value: unknown) => void;
  history = key => key === "web:old" ? new Promise(resolve => { resolveOld = resolve; })
    : Promise.resolve({ messages: [{ role: "user", content: "New chat only." }] });
  const hook = renderHook(({ key }) => useRealtime({ sessionKey: key }), { initialProps: { key: "web:old" } });
  hook.rerender({ key: "web:new" });
  await act(async () => { await hook.result.current.start(); Peer.all[0].channel.open(); });
  await act(async () => { resolveOld({ messages: [{ role: "user", content: "Private old chat." }] }); });
  expect(messages(Peer.all[0])).toEqual(["New chat only."]);
  expect(hook.result.current.transcript.some(e => e.text === "Private old chat.")).toBe(false);
});

it("Stop then Start retains fresh in-page turns without reloading stale history", async () => {
  const hook = renderHook(() => useRealtime({ sessionKey: "web:continue" }));
  await act(async () => { await hook.result.current.start(); Peer.all[0].channel.open(); });
  await act(async () => { hook.result.current.sendText("Actually it moved to four."); });
  await stop(hook);
  await act(async () => { await hook.result.current.start(); Peer.all[1].channel.open(); });
  expect(messages(Peer.all[1])).toEqual(["My meeting is at three.", "Three o'clock.", "Actually it moved to four."]);
  expect(rpc.mock.calls.filter(c => c[0] === "session.history")).toHaveLength(1);
});

it("picking another chat during a slow Start cancels the old startup", async () => {
  let resolveOld!: (value: unknown) => void;
  history = key => key === "web:old" ? new Promise(resolve => { resolveOld = resolve; })
    : Promise.resolve({ messages: [{ role: "user", content: "Selected chat fact." }] });
  const hook = renderHook(({ key }) => useRealtime({ sessionKey: key }), { initialProps: { key: "web:old" } });
  let oldStart!: Promise<void>;
  await act(async () => { oldStart = hook.result.current.start(); });
  hook.rerender({ key: "web:new" });
  await act(async () => { await hook.result.current.start(); Peer.all[0].channel.open(); });
  await act(async () => { resolveOld({ messages: [{ role: "user", content: "Old chat fact." }] }); await oldStart; });
  expect(Peer.all).toHaveLength(1);
  expect(messages(Peer.all[0])).toEqual(["Selected chat fact."]);
  expect(hook.result.current.phase).toBe("connected");
});

it("Stop during provider restoration cannot be undone by late acknowledgements", async () => {
  Peer.autoAcknowledge = false;
  const hook = renderHook(() => useRealtime({ sessionKey: "web:cancel-restore" }));
  await act(async () => { await hook.result.current.start(); Peer.all[0].channel.open(); });
  await stop(hook);
  await act(async () => {
    Peer.all[0].channel.receive({ type: "session.updated", session: Peer.all[0].channel.sent[0].session });
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(hook.result.current.phase).toBe("idle");
  expect(media.audio.enabled).toBe(false);
  expect(events().some(e => e.type === "context.restore_cancelled")).toBe(true);
  expect(events().some(e => e.type === "context.ready")).toBe(false);
});

it("a restoration timeout fails visibly, retries the recording, and ignores the old connection", async () => {
  Peer.autoAcknowledge = false;
  const hook = renderHook(() => useRealtime({ sessionKey: "web:timeout" }));
  await act(async () => { await hook.result.current.start(); Peer.all[0].channel.open(); await vi.advanceTimersByTimeAsync(10_000); });
  expect(hook.result.current.phase).toBe("failed");
  expect(hook.result.current.error).toContain("Tap Start to retry");
  expect(media.audio.enabled).toBe(false);
  expect(events().some(e => e.type === "context.restore_failed")).toBe(true);
  expect(events().some(e => e.type === "context.restored")).toBe(false);
  Peer.autoAcknowledge = true;
  await act(async () => { await hook.result.current.start(); Peer.all[1].channel.open(); });
  await act(async () => { Peer.all[0].channel.receive({ type: "error", error: { message: "late old failure" } }); });
  expect(hook.result.current.phase).toBe("connected");
  expect(hook.result.current.error).toBeNull();
  const starts = rpc.mock.calls.filter(c => c[0] === "realtime.archive.start");
  expect(starts[0][1].liveSessionId).toBe(starts[1][1].liveSessionId);
});

it("a provider rejection cannot display a successful resume", async () => {
  Peer.autoAcknowledge = false;
  const hook = renderHook(() => useRealtime({ sessionKey: "web:rejected" }));
  await act(async () => { await hook.result.current.start(); Peer.all[0].channel.open(); });
  await act(async () => { Peer.all[0].channel.receive({ type: "error", error: { message: "invalid configuration" } }); });
  expect(hook.result.current.phase).toBe("failed");
  expect(hook.result.current.transcript.some(e => e.text.startsWith("Resumed with"))).toBe(false);
  expect(media.audio.enabled).toBe(false);
});

it("Stop during history loading cannot create a connection when history arrives later", async () => {
  let resolve!: (value: unknown) => void;
  history = () => new Promise(done => { resolve = done; });
  const hook = renderHook(() => useRealtime({ sessionKey: "web:cancel" }));
  let starting!: Promise<void>;
  await act(async () => { starting = hook.result.current.start(); });
  await stop(hook);
  await act(async () => { resolve({ messages: [] }); await starting; });
  expect(Peer.all).toHaveLength(0);
  expect(hook.result.current.phase).toBe("idle");
  expect(rpc.mock.calls.some(c => c[0] === "realtime.archive.start")).toBe(false);
});

it.each([false, true])("reload restores archived turns; an empty archive preserves saved chat history (empty=%s)", async empty => {
  const first = renderHook(() => useRealtime({ sessionKey: "web:reload" }));
  await act(async () => { await first.result.current.start(); });
  first.unmount();
  archiveMessages = empty ? [] : [{ role: "user", text: "Most recent archived fact." }];
  const second = renderHook(() => useRealtime({ sessionKey: "web:reload" }));
  await act(async () => { await second.result.current.start(); Peer.all[1].channel.open(); });
  expect(messages(Peer.all[1])).toEqual(empty ? ["My meeting is at three.", "Three o'clock."] : ["Most recent archived fact."]);
});

it("keeps the existing 30-message replay limit explicit while displaying more history", async () => {
  history = async () => ({ messages: Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `Fact ${i}` })) });
  const hook = renderHook(() => useRealtime({ sessionKey: "web:bounded" }));
  await act(async () => { await hook.result.current.start(); Peer.all[0].channel.open(); });
  expect(messages(Peer.all[0])).toHaveLength(30);
  expect(messages(Peer.all[0])[0]).toBe("Fact 10");
  expect(hook.result.current.transcript.filter(e => e.kind === "user")).toHaveLength(40);
  expect(events().find(e => e.type === "context.initial").data.restoredMessageCount).toBe(30);
});

it("quietly restores saved memory followed by the exact tail while keeping the visible transcript", async () => {
  memoryPacket = { mode: "summary", revision: 3, summary: "Meeting at three.", messages: [{ role: "user", text: "Correction: four." }] };
  const hook = renderHook(() => useRealtime({ sessionKey: "web:memory" }));
  await act(async () => { await hook.result.current.start(); Peer.all[0].channel.open(); });
  const restored = messages(Peer.all[0]);
  expect(restored).toHaveLength(2); expect(restored[0]).toContain("Historical session memory");
  expect(restored[0]).toContain("Meeting at three."); expect(restored[1]).toBe("Correction: four.");
  expect(hook.result.current.transcript.some(e => e.text === "My meeting is at three.")).toBe(true);
  expect(hook.result.current.transcript.some(e => e.text.startsWith("Historical session memory"))).toBe(false);
  expect(Peer.all[0].channel.sent.some(e => e.type === "response.create")).toBe(false);
  expect(events().find(e => e.type === "context.initial").data.memoryRevision).toBe(3);
});

it("requires updating an oversized tail instead of reconnecting with silently missing turns", async () => {
  memoryPacket = { mode: "needs_update", note: "Click Update session memory, then Start." };
  const hook = renderHook(() => useRealtime({ sessionKey: "web:backlog" }));
  await act(async () => { await hook.result.current.start(); });
  expect(hook.result.current.phase).toBe("failed"); expect(Peer.all).toHaveLength(0);
  expect(hook.result.current.error).toContain("Update session memory");
});

it("flushes in-flight and newer turns before fetching the resume snapshot", async () => {
  const original = rpc.getMockImplementation()!;
  let saved!: () => void;
  rpc.mockImplementation(async (method: string, params: any) => {
    if (method === "session.appendMessages") await new Promise<void>(resolve => { saved = resolve; });
    return original(method, params);
  });
  const hook = renderHook(() => useRealtime({ sessionKey: "web:flush" }));
  await act(async () => { await hook.result.current.start(); Peer.all[0].channel.open(); });
  await act(async () => { hook.result.current.sendText("Fresh fact."); await vi.advanceTimersByTimeAsync(1200); });
  await stop(hook);
  let restarting!: Promise<void>;
  await act(async () => { restarting = hook.result.current.start(); });
  expect(rpc.mock.calls.filter(c => c[0] === "memory.resume")).toHaveLength(1);
  await act(async () => { saved(); await restarting; });
  expect(rpc.mock.calls.filter(c => c[0] === "memory.resume")).toHaveLength(2);
});
