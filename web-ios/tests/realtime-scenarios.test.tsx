/** Scenario contracts with a fake provider/real hook. These do not judge model speech. */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TestPeer as Peer } from "./helpers/realtime-peer";
import { useRealtime } from "../src/lib/useRealtime";
import { useSocketStore } from "../src/lib/socket-store";
import { useLiveSettings } from "../src/lib/live-settings";
import { buildRealtimePrompt } from "../src/lib/realtime-prompt";

vi.mock("../src/lib/media", () => ({ mediaUnavailableReason: () => null,
  getUserMediaSafe: async () => ({ getAudioTracks: () => [], getVideoTracks: () => [], getTracks: () => [] }) }));
let rpc: ReturnType<typeof vi.fn>;
let toolResult: () => Promise<unknown>;
beforeEach(() => {
  vi.useFakeTimers(); localStorage.clear(); Peer.all = []; Peer.autoAcknowledge = true;
  vi.stubGlobal("RTCPeerConnection", Peer);
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, text: async () => "answer" })));
  useLiveSettings.getState().reset(); useLiveSettings.getState().set("visualCadence", "off");
  toolResult = async () => ({ ok: true });
  rpc = vi.fn(async (method: string) => {
    if (method === "frontend.boot_context") return { context: "Your name is Hawk. Silence is comfortable." };
    if (method === "live.openaiClientSecret") return { client_secret: "test-secret" };
    if (method === "realtime.archive.start") return { closed: false };
    if (method === "tool.invoke" || method.startsWith("person.")) return toolResult();
    return {};
  });
  useSocketStore.setState({ status: "connected", rpc });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
async function session() {
  const hook = renderHook(() => useRealtime({ sessionKey: "web:scenario" }));
  await act(async () => { await hook.result.current.start(); Peer.all[0].channel.open(); });
  return { ...hook, channel: Peer.all[0].channel };
}
const call = (name: string, args: object = {}) => ({ type: "response.function_call_arguments.done", call_id: `call-${name}`, name, arguments: JSON.stringify(args) });
const output = (channel: Peer["channel"]) => channel.sent.filter(e => e.item?.type === "function_call_output").map(e => JSON.parse(e.item.output));

it("sends and archives the same constructed prompt and actual tool definitions", async () => {
  const s = await session();
  const initial = rpc.mock.calls.find(c => c[0] === "realtime.archive.append" && c[1].event.type === "context.initial")![1].event.data;
  const broker = rpc.mock.calls.find(c => c[0] === "live.openaiClientSecret")![1];
  const sessionConfig = s.channel.sent[0].session;
  const expected = buildRealtimePrompt("Your name is Hawk. Silence is comfortable.");
  expect(broker.instructions).toBe(expected);
  expect(sessionConfig.instructions).toBe(expected);
  expect(initial.instructions).toBe(expected);
  expect(initial.tools).toEqual(sessionConfig.tools);
  expect(initial.instructions).not.toContain("test-secret");
});

it("keeps the current bridge setting's tool availability without changing capability wording", async () => {
  useLiveSettings.getState().set("backendBridge", false);
  const s = await session();
  expect(s.channel.sent[0].session.tools.some((tool: any) => tool.name === "session_send_message")).toBe(false);
  // Prompt/tool capability alignment is intentionally deferred in this batch.
  expect(s.channel.sent[0].session.instructions).toContain("delegate");
});

it.each([false, true])("a tool stays pending until its real result, then reports success/failure (failed=%s)", async failed => {
  let resolve!: (value: unknown) => void;
  toolResult = () => new Promise(done => { resolve = done; });
  const s = await session();
  await act(async () => { s.channel.receive(call("generate_chart", { series: [{ data: [1, 2] }] })); });
  expect(s.result.current.transcript.find(e => e.kind === "tool")?.toolStatus).toBe("running");
  expect(output(s.channel)).toEqual([]);
  await act(async () => { resolve(failed ? { ok: false, error: "renderer unavailable" } : { ok: true, result: { type: "text", content: "Chart ready." } }); });
  expect(output(s.channel)[0].ok).toBe(!failed);
  expect(s.result.current.transcript.find(e => e.kind === "tool")?.toolStatus).toBe(failed ? "error" : "ok");
  const completion = rpc.mock.calls.find(c => c[0] === "realtime.archive.append" && c[1].event.type === "tool.completed")![1].event.data;
  expect(completion.status).toBe(failed ? "error" : "ok");
  if (failed) expect(output(s.channel)[0].error).toBe("renderer unavailable");
});

it("face identification without a frame returns an error and never calls recognition", async () => {
  const s = await session();
  await act(async () => { s.channel.receive(call("identify_person")); });
  expect(output(s.channel)[0]).toMatchObject({ ok: false, error: expect.stringContaining("No camera frame") });
  expect(rpc.mock.calls.some(c => c[0] === "person.identify_current_frame")).toBe(false);
});

it("person confirmation and profile saving forward the selected identity to the backend", async () => {
  toolResult = async () => ({ ok: true, person: { id: "person-1", name: "Alex" } });
  const s = await session();
  await act(async () => { s.channel.receive(call("confirm_identity_candidate", { candidate_id: "candidate-1", name: "Alex" })); });
  await act(async () => { s.channel.receive(call("update_person_profile", { id: "person-1", name: "Alex" })); });
  expect(rpc).toHaveBeenCalledWith("person.confirm_candidate", { candidate_id: "candidate-1", name: "Alex", session_key: "web:scenario" });
  expect(rpc).toHaveBeenCalledWith("person.update_profile", { id: "person-1", name: "Alex", session_key: "web:scenario" });
  expect(output(s.channel).every(result => result.ok)).toBe(true);
});

it("an uneventful connection requests no unsolicited reply; Stay Silent release requests one recap", async () => {
  const s = await session();
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
  expect(s.channel.sent.some(e => e.type === "response.create")).toBe(false);
  await act(async () => { s.result.current.toggleStaySilent(); });
  expect(s.channel.sent.at(-1).session.audio.input.turn_detection.create_response).toBe(false);
  await act(async () => { s.channel.receive({ type: "conversation.item.input_audio_transcription.completed", transcript: "We discussed tomorrow's meeting." }); });
  expect(s.channel.sent.some(e => e.type === "response.create")).toBe(false);
  await act(async () => { s.result.current.toggleStaySilent(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1300); });
  expect(s.channel.sent.filter(e => e.type === "response.create")).toHaveLength(1);
  expect(s.channel.sent.some(e => e.item?.content?.[0]?.text?.includes("tomorrow's meeting"))).toBe(true);
});
