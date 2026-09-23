import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RealtimeResponses } from "../src/lib/realtime-responses";
let sent: any[], record: ReturnType<typeof vi.fn>, replies: RealtimeResponses;
beforeEach(() => { vi.useFakeTimers(); sent = []; record = vi.fn(); replies = new RealtimeResponses(e => { sent.push(e); return true; }, record); });
afterEach(() => { replies.reset(); vi.useRealTimers(); });
const tick = () => vi.advanceTimersByTimeAsync(300);
it("waits for speech, generation and playback, then coalesces two completed tasks", async () => {
  replies.observe({ type: "input_audio_buffer.speech_started" });
  replies.request({ metadata: { task_id: "a" } }); replies.request({ metadata: { task_id: "b" } });
  await tick(); expect(sent).toHaveLength(0);
  replies.observe({ type: "input_audio_buffer.speech_stopped" });
  replies.observe({ type: "response.created", response: { id: "vad" } });
  await tick(); expect(sent).toHaveLength(0);
  replies.observe({ type: "output_audio_buffer.started" });
  replies.observe({ type: "response.done", response: { id: "vad" } });
  await tick(); expect(sent).toHaveLength(0);
  replies.observe({ type: "output_audio_buffer.stopped" });
  await tick(); expect(sent).toHaveLength(1);
  expect(sent[0].response.metadata.task_ids).toBe("a,b");
});
it("recovers the server-VAD race without losing a pending result", async () => {
  replies.request({ metadata: { task_id: "a" } }); await tick();
  const event_id = sent[0].event_id;
  replies.observe({ type: "response.created", response: { id: "automatic" } });
  expect(replies.observe({ type: "error", error: { event_id, code: "conversation_already_has_active_response" } })).toBe(true);
  await tick(); expect(sent).toHaveLength(1);
  replies.observe({ type: "response.done", response: { id: "automatic" } });
  await tick(); expect(sent).toHaveLength(2);
  expect(sent[1].response.metadata.task_ids).toBe("a");
  const metadata = sent[1].response.metadata;
  replies.observe({ type: "response.created", response: { id: "own", metadata } });
  replies.observe({ type: "response.done", response: { id: "own", metadata } });
  await tick(); expect(sent).toHaveLength(2);
});
it("does not suppress unrelated errors or start another request before acknowledgement", async () => {
  replies.request({}); await tick(); replies.request({}); await tick(); expect(sent).toHaveLength(1);
  expect(replies.observe({ type: "error", error: { event_id: "unrelated", message: "already has an active response" } })).toBe(false);
});
it("silence holds results; reset discards the old connection's pending speech", async () => {
  replies.setSilent(true); replies.request({}); await tick(); expect(sent).toHaveLength(0);
  replies.setSilent(false); await tick(); expect(sent).toHaveLength(1);
  replies.request({}); replies.reset(); await tick(); expect(sent).toHaveLength(1);
});
it.each([true, false])("handles busy errors before or after the other reply finishes (done first=%s)", async doneFirst => {
  replies.request({}); await tick();
  const done = { type: "response.done", response: { id: "racing-vad" } };
  const error = { type: "error", error: { event_id: sent[0].event_id, message: "Conversation already has an active response in progress" } };
  if (doneFirst) replies.observe(done);
  replies.observe(error);
  if (!doneFirst) replies.observe(done);
  await tick(); expect(sent).toHaveLength(2);
});
