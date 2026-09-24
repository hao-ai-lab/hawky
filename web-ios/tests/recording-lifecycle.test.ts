import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useRealtime } from "../src/lib/useRealtime";
import { useSocketStore } from "../src/lib/socket-store";
import { useLiveSettings } from "../src/lib/live-settings";

vi.mock("../src/lib/media", () => ({ mediaUnavailableReason: () => null,
  getUserMediaSafe: async () => ({ getAudioTracks: () => [], getVideoTracks: () => [{ enabled: true }], getTracks: () => [] }) }));

import { TestPeer as Peer } from "./helpers/realtime-peer";
let rpc: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); Peer.all = []; Peer.autoAcknowledge = true;
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "answer" })));
  useLiveSettings.getState().reset(); useLiveSettings.getState().set("visualCadence", "off");
  rpc = vi.fn(async (method: string) => method === "live.openaiClientSecret" ? { client_secret: "test-secret" } : method === "realtime.archive.start" ? { closed: false } : {});
  useSocketStore.setState({ status: "connected", rpc });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("reconnects into the same folder, archives context/messages, then Stop -> Start creates a new one", async () => {
  const { result, unmount } = renderHook(() => useRealtime({ sessionKey: "web:lifecycle" }));
  await act(async () => { await result.current.start(); });
  await act(async () => { Peer.all[0].connectionState = "connected"; Peer.all[0].channel.open(); });
  await act(async () => { Peer.all[0].channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.item.input_audio_transcription.completed", transcript: "Remember blue" }) })); });
  await act(async () => { Peer.all[0].connectionState = "failed"; Peer.all[0].dispatchEvent(new Event("connectionstatechange")); await vi.advanceTimersByTimeAsync(3100); });
  expect(Peer.all).toHaveLength(2);
  await act(async () => { Peer.all[1].connectionState = "connected"; Peer.all[1].channel.open(); });
  const starts = rpc.mock.calls.filter(c => c[0] === "realtime.archive.start");
  expect((starts[0] as any)[1].liveSessionId).toBe((starts[1] as any)[1].liveSessionId);
  await act(async () => { void result.current.stop(); await vi.advanceTimersByTimeAsync(100); });
  await act(async () => { await result.current.start(); });
  const allStarts = rpc.mock.calls.filter(c => c[0] === "realtime.archive.start");
  expect((allStarts[2] as any)[1].liveSessionId).not.toBe((allStarts[0] as any)[1].liveSessionId);
  const events = rpc.mock.calls.filter(c => c[0] === "realtime.archive.append").map(c => (c as any)[1].event);
  expect(events.some(e => e.type === "message.completed" && e.data.text === "Remember blue")).toBe(true);
  expect(events.some(e => e.type === "context.updated" && e.data.session.instructions)).toBe(true);
  expect(events.some(e => e.type === "context.restored" && e.data.messages.some((m: any) => m.text === "Remember blue"))).toBe(true);
  expect(events.some(e => e.type === "session.ended")).toBe(true);
  unmount();
});

it("reload resumes the active recording without falsely ending it", async () => {
  const first = renderHook(() => useRealtime({ sessionKey: "web:reload" }));
  await act(async () => { await first.result.current.start(); });
  first.unmount();
  const second = renderHook(() => useRealtime({ sessionKey: "web:reload" }));
  expect(second.result.current.resumable).toBe(true);
  await act(async () => { await second.result.current.start(); });
  const starts = rpc.mock.calls.filter(c => c[0] === "realtime.archive.start");
  expect((starts[0] as any)[1].liveSessionId).toBe((starts[1] as any)[1].liveSessionId);
  expect(rpc.mock.calls.some(c => c[0] === "realtime.archive.append" && (c as any)[1].event.type === "session.ended")).toBe(false);
  second.unmount();
});

it("archives the exact image sent on the data channel and matches its receipt", async () => {
  const jpeg = "data:image/jpeg;base64,/9j/2Q==";
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as any);
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(jpeg);
  const { result, unmount } = renderHook(() => useRealtime({ sessionKey: "web:image-flow" }));
  const video = document.createElement("video");
  Object.defineProperties(video, { readyState: { value: 2 }, videoWidth: { value: 1280 }, videoHeight: { value: 720 } });
  result.current.videoElRef.current = video;
  await act(async () => { await result.current.start(); Peer.all[0].channel.open(); });
  await act(async () => { result.current.sendCameraFrame(); });
  const sent = Peer.all[0].channel.sent.find(e => e.item?.content?.[0]?.type === "input_image");
  expect(sent.item.content[0].image_url).toBe(jpeg);
  await act(async () => { Peer.all[0].channel.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "conversation.item.added", event_id: "ack1", item: { id: sent.item.id } }) })); });
  const image = (rpc.mock.calls.find(c => c[0] === "realtime.archive.image") as any)[1];
  const receipt = (rpc.mock.calls.find(c => c[0] === "realtime.archive.receipt") as any)[1];
  expect(image.image).toBe(jpeg);
  expect(image.event.data.frameId).toBe(sent.event_id);
  expect(receipt.event.data.itemId).toBe(sent.item.id);
  expect(receipt.liveSessionId).toBe(image.liveSessionId);
  unmount();
});
