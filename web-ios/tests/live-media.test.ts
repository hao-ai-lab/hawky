import { afterEach, expect, it, vi } from "vitest";
import { createMediaConnection } from "../src/lib/live/media-connection";
import { TestPeer } from "./helpers/realtime-peer";
afterEach(() => vi.unstubAllGlobals());
it("continuous mode supplies a silent track without requesting microphone permission, and disposes it", () => {
  const silent = { stop: vi.fn() }, close = vi.fn(), resume = vi.fn(), start = vi.fn();
  const source = { offset: { value: 1 }, connect: vi.fn(), start };
  const destination = { stream: { getAudioTracks: () => [silent], getTracks: () => [silent] } };
  const Clock = vi.fn(function(this: any) { Object.assign(this, { createMediaStreamDestination: () => destination, createConstantSource: () => source, resume, close }); });
  vi.stubGlobal("AudioContext", Clock); vi.stubGlobal("RTCPeerConnection", TestPeer);
  const c = createMediaConnection({ getAudioTracks: () => [] } as any, () => {}, true);
  expect(source.offset.value).toBe(0); expect(start).toHaveBeenCalledOnce(); expect(resume).toHaveBeenCalledOnce();
  expect((c.pc as any).senders[0].track).toBe(silent);
  c.dispose(); expect(silent.stop).toHaveBeenCalledOnce(); expect(close).toHaveBeenCalledOnce();
});
it("a real microphone starts disabled until provider restoration, and Realtime needs no synthetic track", () => {
  const Clock = vi.fn(); vi.stubGlobal("AudioContext", Clock); vi.stubGlobal("RTCPeerConnection", TestPeer);
  const track = { enabled: true };
  createMediaConnection({ getAudioTracks: () => [track] } as any, () => {}, true);
  expect(track.enabled).toBe(false); expect(Clock).not.toHaveBeenCalled();
  const c = createMediaConnection({ getAudioTracks: () => [] } as any, () => {});
  expect((c.pc as any).transceivers).toEqual([{ kind: "audio", direction: "sendrecv" }]);
  expect(Clock).not.toHaveBeenCalled();
});
