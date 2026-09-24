/** Scenario contracts with a fake provider/real hook. These do not judge model speech. */
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { summaryJson, summaryOutput } from "./fixtures/compaction-summary";
import { TestPeer as Peer } from "./helpers/realtime-peer";
import { useRealtime } from "../src/lib/useRealtime";
import { useSocketStore } from "../src/lib/socket-store";
import { useLiveSettings } from "../src/lib/live-settings";
import { buildRealtimePrompt } from "../src/lib/realtime-prompt";
import { LiveScreen } from "../src/screens/LiveScreen";

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

it("delegation acknowledges once, survives an interruption, and injects only current results", async () => {
  const task = { id: "", ownerSession: "web:scenario", backendSession: "web:scenario-bridge", runtime: "native",
    request: "Read the full file", status: "queued", validity: "current", createdAt: Date.now(), events: [] as any[] };
  const original = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (method: string, params: any) => {
    if (method === "delegation.submit") { task.id = params.id; return structuredClone(task); }
    return original(method, params);
  });
  const s = await session();
  await act(async () => { s.channel.receive(call("session_send_message", { message: task.request })); });
  expect(output(s.channel)[0]).toMatchObject({ accepted: true, status: "queued" });
  await act(async () => { s.channel.receive(call("session_send_message", { message: task.request })); });
  expect(rpc.mock.calls.filter(c => c[0] === "delegation.submit")).toHaveLength(1);
  await act(async () => {
    s.channel.receive({ type: "input_audio_buffer.speech_started" });
    const finished = { ...task, status: "completed", result: "Actual file contents", events: [{ seq: 2, at: Date.now(), type: "completed" }] };
    for (const listener of useSocketStore.getState().eventListeners) listener({ type: "event", event: "delegation.updated", payload: { task: finished } });
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(s.channel.sent.filter(e => e.item?.role === "system")).toHaveLength(1);
  expect(s.channel.sent.filter(e => e.type === "response.create")).toHaveLength(0);
  await act(async () => { s.channel.receive({ type: "input_audio_buffer.speech_stopped" }); await vi.advanceTimersByTimeAsync(500); });
  expect(s.channel.sent.filter(e => e.type === "response.create")).toHaveLength(1);
});

it("submission waits for push completion; status replies cannot start another tool loop", async () => {
  const task = { id: "", ownerSession: "web:scenario", backendSession: "web:scenario-bridge", runtime: "native",
    request: "Read alpha.txt", status: "running", validity: "current", createdAt: Date.now(), events: [] as any[] };
  const original = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (method: string, params: any) => {
    if (method === "delegation.submit") { task.id = params.id; return structuredClone(task); }
    if (method === "delegation.get") return structuredClone(task);
    return original(method, params);
  });
  useLiveSettings.getState().set("toolChoice", "required");
  const s = await session();
  await act(async () => { s.channel.receive(call("session_send_message", { message: task.request })); await vi.advanceTimersByTimeAsync(3000); });
  expect(output(s.channel)[0]).toMatchObject({ accepted: true, note: expect.stringContaining("Do not poll") });
  expect(s.channel.sent.filter(e => e.type === "response.create")).toHaveLength(0);
  expect(rpc.mock.calls.filter(c => c[0] === "delegation.get")).toHaveLength(0);

  // Explicit user progress question. The model gets one spoken continuation,
  // with tools disabled even if the session setting normally requires a tool.
  await act(async () => {
    s.channel.receive({ type: "conversation.item.input_audio_transcription.completed", transcript: "Is it done?" });
    s.channel.receive(call("session_task_control", { action: "status", task_id: task.id }));
    await vi.advanceTimersByTimeAsync(300);
  });
  const reply = s.channel.sent.filter(e => e.type === "response.create").at(-1)!;
  expect(reply.response.tool_choice).toBe("none");
  expect(output(s.channel).at(-1).status).toBe("running");
  expect(rpc).toHaveBeenCalledWith("delegation.get", expect.objectContaining({ id: task.id, statusCheck: "call-session_task_control" }));
  expect(s.result.current.transcript.filter(e => e.kind === "tool")).toHaveLength(1);

  await act(async () => {
    s.channel.receive({ type: "response.created", response: { id: "status-answer", metadata: reply.response.metadata } });
    s.channel.receive({ type: "response.done", response: { id: "status-answer", status: "completed", metadata: reply.response.metadata } });
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(s.channel.sent.filter(e => e.type === "response.create")).toHaveLength(1);

  // The backend notification still initiates a result reply, with no polling.
  await act(async () => {
    const finished = { ...task, status: "completed", result: "alpha-value=73", events: [{ seq: 1, at: Date.now(), type: "completed" }] };
    for (const listener of useSocketStore.getState().eventListeners) listener({ type: "event", event: "delegation.updated", payload: { task: finished } });
    await vi.advanceTimersByTimeAsync(300);
  });
  const replies = s.channel.sent.filter(e => e.type === "response.create");
  expect(replies).toHaveLength(2);
  expect(replies[1].response).toMatchObject({ tool_choice: "none", metadata: { task_ids: task.id } });
  expect(rpc.mock.calls.filter(c => c[0] === "delegation.get")).toHaveLength(1);
});

it("the recorded running/running/completed checks stay in diagnostics instead of three transcript bubbles", async () => {
  const original = rpc.getMockImplementation()!;
  let n = 0;
  rpc.mockImplementation(async (method: string, params: any) => {
    if (method === "delegation.get") return { id: "task-1", request: "Read alpha.txt", status: ++n < 3 ? "running" : "completed" };
    return original(method, params);
  });
  const s = await session();
  await act(async () => { s.channel.receive({ type: "conversation.item.input_audio_transcription.completed", transcript: "Is it done?" }); });
  for (const callId of ["check-1", "check-2", "check-3"]) await act(async () => {
    s.channel.receive({ ...call("session_task_control", { action: "status", task_id: "task-1" }), call_id: callId });
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(output(s.channel).map(o => o.status)).toEqual(["running", "running", "completed"]);
  expect(s.result.current.transcript.filter(e => e.kind === "tool")).toHaveLength(0);
  const persisted = rpc.mock.calls.filter(c => c[0] === "session.appendMessages").flatMap(c => c[1].messages);
  expect(persisted.some(m => m.text.includes("session_task_control"))).toBe(false);
  const logged = rpc.mock.calls.filter(c => c[0] === "realtime.archive.append" && c[1].event.type === "tool.completed");
  expect(logged.map(c => c[1].event.data.callId)).toEqual(["check-1", "check-2", "check-3"]);
  expect(s.channel.sent.filter(e => e.type === "response.create")).toHaveLength(1);
  expect(s.channel.sent.find(e => e.type === "response.create").response.tool_choice).toBe("none");
});

it("a failed status lookup remains visible and can be explained without retrying a tool", async () => {
  const original = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (method: string, params: any) => {
    if (method === "delegation.get") throw new Error("Delegation not found");
    return original(method, params);
  });
  const s = await session();
  await act(async () => {
    s.channel.receive({ type: "conversation.item.input_audio_transcription.completed", transcript: "Is it done?" });
    s.channel.receive(call("session_task_control", { action: "status", task_id: "missing" }));
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(output(s.channel)[0]).toMatchObject({ ok: false, error: "Delegation not found" });
  expect(s.result.current.transcript.some(e => e.kind === "warning" && e.text.includes("Delegation not found"))).toBe(true);
  expect(s.channel.sent.find(e => e.type === "response.create").response.tool_choice).toBe("none");
});

it.each([false, true])("restores interrupted results silently, including a late recovery snapshot (late=%s)", async late => {
  const tasks = ["listing", "path"].map(id => ({ id, ownerSession: "web:scenario", backendSession: `web:scenario-${id}`, runtime: "native",
    request: id, result: `Previously answered ${id}`, status: "completed", delivery: "interrupted", createdAt: 1, events: [] }));
  const original = rpc.getMockImplementation()!;
  let visible = !late;
  rpc.mockImplementation(async (method: string, params: any) => {
    if (method === "delegation.list") return { tasks: visible ? tasks : [] };
    return original(method, params);
  });
  const s = await session();
  visible = true;
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  const restored = s.channel.sent.filter(e => e.item?.role === "system");
  expect(restored).toHaveLength(2);
  expect(restored.every(e => e.item.content[0].text.startsWith("Restored backend task context."))).toBe(true);
  expect(s.channel.sent.some(e => e.type === "response.create")).toBe(false);
  expect(s.result.current.transcript.filter(e => e.delegation)).toHaveLength(2);

  // A user message gets a normal reply, not a deferred replay of old results.
  await act(async () => { s.result.current.sendText("Let's talk about something else."); await vi.advanceTimersByTimeAsync(300); });
  const replies = s.channel.sent.filter(e => e.type === "response.create");
  expect(replies).toHaveLength(1);
  expect(replies[0].response.metadata.task_ids).toBeUndefined();
  expect(replies[0].response.tool_choice).toBeUndefined();

  await act(async () => { const stopped = s.result.current.stop(); await vi.advanceTimersByTimeAsync(100); await stopped; });
  await act(async () => { await s.result.current.start(); Peer.all[1].channel.open(); await vi.advanceTimersByTimeAsync(5000); });
  expect(Peer.all[1].channel.sent.filter(e => e.item?.role === "system")).toHaveLength(2);
  expect(Peer.all[1].channel.sent.some(e => e.type === "response.create")).toBe(false);
  expect(rpc.mock.calls.some(c => c[0] === "delegation.submit" || c[0] === "delegation.delivery")).toBe(false);
});

it("holds fresh completions until the user speaks and current playback finishes, then delivers both task IDs", async () => {
  const tasks = ["a", "b"].map(id => ({ id, ownerSession: "web:scenario", backendSession: `web:scenario-${id}`, runtime: "native",
    request: `Read ${id}`, status: "running", validity: "current", createdAt: 1, events: [] as any[] }));
  const original = rpc.getMockImplementation()!;
  rpc.mockImplementation(async (method: string, params: any) => method === "delegation.list" ? { tasks } : original(method, params));
  const s = await session();
  const finish = (index: number) => {
    const task = { ...tasks[index], status: "completed", result: `Result ${tasks[index].id}`, events: [{ seq: 1, at: Date.now(), type: "completed" }] };
    for (const listener of useSocketStore.getState().eventListeners) listener({ type: "event", event: "delegation.updated", payload: { task } });
  };
  // A previously running job completes after reconnect, before the first word.
  await act(async () => { finish(0); await vi.advanceTimersByTimeAsync(5000); });
  expect(s.channel.sent.some(e => e.type === "response.create")).toBe(false);
  await act(async () => {
    s.channel.receive({ type: "input_audio_buffer.speech_started" });
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(s.channel.sent.some(e => e.type === "response.create")).toBe(false);
  await act(async () => {
    s.channel.receive({ type: "input_audio_buffer.speech_stopped" });
    s.channel.receive({ type: "response.created", response: { id: "conversation" } });
    s.channel.receive({ type: "output_audio_buffer.started", response_id: "conversation" });
    finish(1);
    s.channel.receive({ type: "response.done", response: { id: "conversation", status: "completed" } });
    await vi.advanceTimersByTimeAsync(3000);
  });
  // Generation ending must not be mistaken for the end of audible speech.
  expect(s.channel.sent.some(e => e.type === "response.create")).toBe(false);
  await act(async () => { s.channel.receive({ type: "output_audio_buffer.stopped", response_id: "conversation" }); await vi.advanceTimersByTimeAsync(100); });
  const replies = s.channel.sent.filter(e => e.type === "response.create");
  expect(replies).toHaveLength(1);
  expect(replies[0].response).toMatchObject({ tool_choice: "none", metadata: { task_ids: "a,b" } });
  await act(async () => {
    const metadata = replies[0].response.metadata;
    s.channel.receive({ type: "response.created", response: { id: "results", metadata } });
    s.channel.receive({ type: "response.done", response: { id: "results", status: "completed", metadata } });
    s.channel.receive({ type: "output_audio_buffer.stopped", response_id: "results" });
    await vi.advanceTimersByTimeAsync(3000);
  });
  expect(rpc.mock.calls.filter(c => c[0] === "delegation.delivery" && c[1].state === "played").map(c => c[1].id)).toEqual(["a", "b"]);
  expect(s.channel.sent.filter(e => e.type === "response.create")).toHaveLength(1);
});

it("keeps private compaction text and lifecycle out of the spoken conversation", async () => {
  const s = await session();
  await act(async () => {
    for (let n = 0; n < 6; n++) s.channel.receive({ type: "conversation.item.added", item: {
      id: `old-${n}`, type: "message", role: "user", content: [{ type: "input_text", text: `Fact ${n}` }],
    } });
    s.result.current.compactNow();
  });
  const request = s.channel.sent.find(e => e.type === "response.create");
  expect(request.response).toMatchObject({ output_modalities: ["text"], conversation: "none", tool_choice: { type: "function", name: "report_history_summary" } });
  const { metadata } = request.response;
  await act(async () => {
    s.channel.receive({ type: "response.created", response: { id: "summary", metadata } });
    s.channel.receive({ type: "response.output_item.added", response_id: "summary", item: { id: "summary-output", ...summaryOutput() } });
    s.channel.receive({ type: "response.function_call_arguments.done", response_id: "summary", item_id: "summary-output", name: "report_history_summary", call_id: "private-call", arguments: summaryJson("Private facts") });
    s.channel.receive({ type: "response.output_text.delta", response_id: "summary", item_id: "summary-output", delta: "Private facts" });
    s.channel.receive({ type: "response.done", response: { id: "summary", metadata, status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "I am compiling a private record." }] }, summaryOutput(summaryJson("Private facts"))] } });
  });
  for (let n = 0; n < 2; n++) await act(async () => {
    const deletion = s.channel.sent.at(-1);
    expect(deletion.type).toBe("conversation.item.delete");
    s.channel.receive({ type: "conversation.item.deleted", item_id: deletion.item_id });
  });
  expect(s.result.current.compaction).toMatchObject({ phase: "complete", deleted: 2, summary: "Facts:\n- Private facts" });
  expect(s.result.current.transcript.some(e => e.text.includes("Private facts"))).toBe(false);
  expect(s.result.current.transcript.some(e => e.text.includes("compiling a private record"))).toBe(false);
  expect(s.result.current.transcript.some(e => e.kind === "tool")).toBe(false);
  expect(s.channel.sent.some(e => e.item?.type === "function_call_output")).toBe(false);
  expect(s.channel.sent.filter(e => e.type === "response.create")).toHaveLength(1);
  // The ordinary speech coordinator was never occupied by the private response.
  await act(async () => { s.result.current.sendText("Continue"); await vi.advanceTimersByTimeAsync(300); });
  expect(s.channel.sent.filter(e => e.type === "response.create")).toHaveLength(2);
});

it("the Live button starts compaction and exposes completion without altering the conversation", async () => {
  await act(async () => { render(<LiveScreen onFullscreenChange={() => {}} />); });
  expect(screen.getByRole("button", { name: "Compact now" })).toBeDisabled();
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Start session|Resume session/ })); });
  const channel = Peer.all[0].channel;
  await act(async () => { channel.open(); });
  await act(async () => {
    for (let n = 0; n < 6; n++) channel.receive({ type: "conversation.item.added", item: {
      id: `ui-${n}`, type: "message", role: "user", content: [{ type: "input_text", text: `Fact ${n}` }],
    } });
    fireEvent.click(screen.getByRole("button", { name: "Compact now" }));
  });
  expect(screen.getByRole("button", { name: "Compacting…" })).toBeDisabled();
  const { metadata } = channel.sent.find(e => e.type === "response.create").response;
  await act(async () => {
    channel.receive({ type: "response.done", response: { id: "ui-summary", metadata, status: "completed",
      output: [summaryOutput(summaryJson("Inspect this summary."))] } });
  });
  for (let n = 0; n < 2; n++) await act(async () => {
    channel.receive({ type: "conversation.item.deleted", item_id: channel.sent.at(-1).item_id });
  });
  expect(screen.getByText("Context compacted")).toBeInTheDocument();
  expect(screen.getByText("Installed summary")).toBeInTheDocument();
  expect(screen.getByRole("region", { name: "Conversation" })).not.toHaveTextContent("Inspect this summary.");
  expect(screen.getByRole("button", { name: "Compact now" })).toBeEnabled();
});

it("rejects conversational advice without inserting, deleting, or speaking it", async () => {
  const s = await session();
  await act(async () => {
    for (let n = 0; n < 6; n++) s.channel.receive({ type: "conversation.item.added", item: {
      id: `reject-${n}`, type: "message", role: "user", content: [{ type: "input_text", text: `Fact ${n}` }],
    } });
    s.result.current.compactNow();
  });
  const count = s.channel.sent.length;
  const { metadata } = s.channel.sent.find(e => e.type === "response.create").response;
  await act(async () => {
    s.channel.receive({ type: "response.done", response: { id: "bad-summary", metadata, status: "completed",
      output: [{ type: "message", content: [{ type: "output_text", text: "Thanks for sharing. You should call a clinician." }] }] } });
  });
  expect(s.result.current.compaction).toMatchObject({ phase: "failed", deleted: 0 });
  expect(s.result.current.compaction.error).toContain("Original context retained");
  expect(s.channel.sent).toHaveLength(count);
  expect(s.result.current.transcript.some(e => e.text.includes("clinician"))).toBe(false);
});
