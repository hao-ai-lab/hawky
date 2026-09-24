import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TestPeer as Peer } from "./helpers/realtime-peer";
import { useRealtime } from "../src/lib/useRealtime";
import { useLiveSettings } from "../src/lib/live-settings";
import { useSocketStore } from "../src/lib/socket-store";
const capture = vi.hoisted(() => vi.fn());
vi.mock("../src/lib/media", () => ({ mediaUnavailableReason: () => null, getUserMediaSafe: capture }));
class Track {
  enabled = true;
  stop = vi.fn();
  constructor(public kind: string) {}
}
class Stream {
  constructor(public tracks: Track[] = []) {}
  getTracks() { return this.tracks; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === "audio"); }
  getVideoTracks() { return this.tracks.filter(t => t.kind === "video"); }
  addTrack(t: Track) { this.tracks.push(t); }
}
let rpc: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); Peer.all = []; Peer.autoAcknowledge = true;
  vi.stubGlobal("RTCPeerConnection", Peer); vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "answer" })));
  useLiveSettings.getState().reset();
  capture.mockReset().mockImplementation(async ({ audio, video }) => new Stream([
    ...(audio ? [new Track("audio")] : []), ...(video ? [new Track("video")] : []),
  ]));
  rpc = vi.fn(async (m: string) => m === "live.openaiClientSecret" ? { client_secret: "fixture" } : {});
  useSocketStore.setState({ status: "connected", rpc, eventListeners: new Set() });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
async function connect(h: ReturnType<typeof renderHook<ReturnType<typeof useRealtime>, unknown>>) {
  await act(async () => { await h.result.current.start(); Peer.all.at(-1)!.channel.open(); });
  return Peer.all.at(-1)!;
}

it.each([[true, false], [false, true], [false, false], [true, true]])("captures only selected inputs (mic=%s, camera=%s) while allowing spoken replies", async (mic, camera) => {
  useLiveSettings.getState().set("microphoneEnabled", mic);
  useLiveSettings.getState().set("cameraEnabled", camera);
  const h = renderHook(() => useRealtime({ sessionKey: "web:inputs" }));
  expect(capture).not.toHaveBeenCalled();
  const peer = await connect(h);
  if (mic || camera) expect(capture).toHaveBeenCalledWith({ audio: mic, video: camera ? expect.objectContaining({ facingMode: "user" }) : false });
  else expect(capture).not.toHaveBeenCalled();
  expect(peer.channel.sent[0].session.output_modalities).toEqual(["audio"]);
  if (!mic) expect(peer.transceivers).toEqual([{ kind: "audio", direction: "sendrecv" }]);
  await act(async () => { h.result.current.sendText("Hello"); await vi.advanceTimersByTimeAsync(300); });
  expect(peer.channel.sent.find(e => e.type === "response.create").response.output_modalities).toEqual(["audio"]);
});

it("pre-session controls save choices and modes without starting capture or backend work", async () => {
  const h = renderHook(() => useRealtime({ sessionKey: "web:inputs" }));
  await act(async () => {
    h.result.current.toggleMic(); h.result.current.toggleCamera(); h.result.current.toggleSpeaker();
    h.result.current.toggleStaySilent(); h.result.current.toggleCocktailParty(); h.result.current.toggleSafety();
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(capture).not.toHaveBeenCalled();
  expect(Peer.all).toHaveLength(0);
  expect(rpc.mock.calls.some(c => ["live.openaiClientSecret", "tool.invoke"].includes(c[0]))).toBe(false);
  expect(JSON.parse(localStorage.getItem("hawky-ios-live-settings")!)).toMatchObject({ microphoneEnabled: false, cameraEnabled: false, responseModality: "text", staySilent: true, cocktailParty: true, safetyCheck: true });
  const peer = await connect(h);
  expect(peer.channel.sent[0].session).toMatchObject({ output_modalities: ["text"], instructions: expect.stringContaining("COCKTAIL PARTY MODE") });
  expect(peer.channel.sent.filter(e => e.type === "session.update").at(-1).session.audio.input.turn_detection.create_response).toBe(false);
  expect(h.result.current.staySilent).toBe(true);
});

it("enables inputs acquired after Start and switches output independently from the mic", async () => {
  useLiveSettings.getState().set("microphoneEnabled", false); useLiveSettings.getState().set("cameraEnabled", false);
  const h = renderHook(() => useRealtime({ sessionKey: "web:inputs" }));
  const peer = await connect(h);
  await act(async () => { h.result.current.toggleMic(); });
  expect(capture).toHaveBeenCalledWith({ audio: true, video: false });
  expect(peer.senders[0].track?.kind).toBe("audio");
  expect(h.result.current.micOn).toBe(true);
  await act(async () => { h.result.current.toggleCamera(); });
  expect(capture).toHaveBeenLastCalledWith({ audio: false, video: { facingMode: "user" } });
  expect(h.result.current.cameraOn).toBe(true);
  await act(async () => { h.result.current.toggleSpeaker(); });
  expect(h.result.current.micOn).toBe(true);
  expect(peer.channel.sent.at(-1).session.output_modalities).toEqual(["text"]);
  await act(async () => { h.result.current.sendText("Show a text answer"); await vi.advanceTimersByTimeAsync(300); });
  expect(peer.channel.sent.find(e => e.type === "response.create").response.output_modalities).toEqual(["text"]);
});

it("does not enable an input when permission fails or belongs to a stopped connection", async () => {
  useLiveSettings.getState().set("microphoneEnabled", false); useLiveSettings.getState().set("cameraEnabled", false);
  const h = renderHook(() => useRealtime({ sessionKey: "web:inputs" }));
  const peer = await connect(h);
  capture.mockRejectedValueOnce(new Error("Permission denied"));
  await act(async () => { h.result.current.toggleMic(); });
  expect(h.result.current.micOn).toBe(false);
  expect(h.result.current.transcript.some(e => e.text.includes("Permission denied"))).toBe(true);
  let resolve!: (value: Stream) => void;
  capture.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  await act(async () => { h.result.current.toggleMic(); });
  await act(async () => { const stopped = h.result.current.stop(); await vi.advanceTimersByTimeAsync(100); await stopped; });
  const track = new Track("audio");
  await act(async () => { resolve(new Stream([track])); });
  expect(track.stop).toHaveBeenCalled(); expect(peer.senders[0].track).toBeNull();
  expect(h.result.current.micOn).toBe(false);
});
