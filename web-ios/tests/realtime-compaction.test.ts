import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RealtimeCompaction, type CompactionState } from "../src/lib/realtime-compaction";
import { summaryJson, summaryOutput } from "./fixtures/compaction-summary";
import { observedBadSummary } from "../../prompt_test/fixtures/compaction-cases";
let sent: any[], c: RealtimeCompaction, state: CompactionState, busy: boolean;
let lock: ReturnType<typeof vi.fn>, fatal: ReturnType<typeof vi.fn>, userReply: ReturnType<typeof vi.fn>;
let detection: Record<string, unknown> | null;
const message = (id: string, image = false) => ({ type: "conversation.item.added", item: { id, type: "message", role: "user", status: "completed", content: [{ type: image ? "input_image" : "input_text", text: id }] } });
beforeEach(() => {
  vi.useFakeTimers(); sent = []; busy = false; lock = vi.fn(); fatal = vi.fn(); userReply = vi.fn();
  detection = { type: "server_vad", create_response: true, interrupt_response: true };
  c = new RealtimeCompaction({ send: e => { sent.push(e); return true; }, isBusy: () => busy, lock, userReply,
    turnDetection: () => detection, change: s => { state = s; }, record: vi.fn(), fatal });
  for (const id of ["a", "b", "c", "d", "e", "f"]) c.observe(message(id));
  c.observe(message("old-image", true)); c.observe(message("new-image", true));
});
afterEach(() => { c.dispose(); vi.useRealTimers(); });
const tick = () => vi.advanceTimersByTimeAsync(0);
function finish(status = "completed", text = summaryJson(), plainReply = false) {
  const metadata = sent.find(e => e.type === "response.create").response.metadata;
  expect(c.observe({ type: "response.created", response: { id: "private", metadata } })).toBe(true);
  c.observe({ type: "response.done", response: { id: "private", metadata, status,
    output: [plainReply ? { type: "message", content: [{ type: "output_text", text }] } : summaryOutput(text)] } });
}
async function ackDetection() {
  c.observe({ type: "session.updated", session: sent.at(-1).session }); await tick();
}
async function summaryAck() {
  const create = sent.at(-1);
  expect(create.type).toBe("conversation.item.create");
  c.observe({ type: "conversation.item.added", item: create.item }); await tick();
  return create;
}
async function deleteAll() {
  while (sent.at(-1).type === "conversation.item.delete") {
    c.observe({ type: "conversation.item.deleted", item_id: sent.at(-1).item_id }); await tick();
  }
}
it("summarizes a frozen snapshot, installs before deletion, preserves new items and stays silent", async () => {
  const work = c.compact();
  const request = sent[0].response;
  expect(request).toMatchObject({ conversation: "none", output_modalities: ["text"], tool_choice: { type: "function", name: "report_history_summary" } });
  expect(request.tools.map((tool: any) => tool.name)).toEqual(["report_history_summary"]);
  expect(request.input.filter((i: any) => i.type === "item_reference").map((i: any) => i.id))
    .toEqual(["a", "b", "c", "d", "e", "f", "old-image", "new-image"]);
  expect(request.input.at(-1).content[0].text).toContain("Do not continue the conversation");
  c.observe(message("late-correction")); c.observe(message("late-image", true));
  finish(); await tick();
  expect(sent.filter(e => e.type === "conversation.item.delete")).toEqual([]);
  await ackDetection();
  const create = await summaryAck();
  expect(create.previous_item_id).toBe("root");
  expect(create.item.content[0].text).toContain("Later messages take precedence");
  await deleteAll(); await ackDetection(); await work;
  expect(sent.filter(e => e.type === "conversation.item.delete").map(e => e.item_id)).toEqual(["a", "b", "old-image"]);
  expect(state!).toMatchObject({ phase: "complete", selected: 3, deleted: 3, images: 1, remaining: 8 });
  expect(sent.filter(e => e.type === "response.create")).toHaveLength(1);
  expect(userReply).not.toHaveBeenCalled();
  expect(lock.mock.calls).toEqual([[true], [false]]);
});
it("waits for audible speech, and for a response racing the quiet acknowledgement", async () => {
  busy = true;
  const work = c.compact(); finish(); await vi.advanceTimersByTimeAsync(500);
  expect(state!.phase).toBe("waiting"); expect(sent).toHaveLength(1);
  busy = false; await vi.advanceTimersByTimeAsync(100);
  busy = true; await ackDetection();
  expect(sent.at(-1).type).toBe("session.update");
  busy = false; await vi.advanceTimersByTimeAsync(100);
  await summaryAck(); await deleteAll(); await ackDetection(); await work;
  expect(state!.phase).toBe("complete");
});
it("rejects incomplete summaries without touching context or turn detection", async () => {
  const work = c.compact(); finish("incomplete"); await work;
  expect(state!.phase).toBe("failed"); expect(sent).toHaveLength(1); expect(lock).not.toHaveBeenCalled();
});
it("rejects the observed advice response before replacing any historical context", async () => {
  const work = c.compact();
  finish("completed", observedBadSummary, true);
  await tick();
  expect(state!).toMatchObject({ phase: "failed", deleted: 0 });
  expect(sent.map(e => e.type)).toEqual(["response.create"]);
  expect(lock).not.toHaveBeenCalled();
  c.dispose(); await work;
});
it("retains original context when the summary insertion fails", async () => {
  const work = c.compact(); finish(); await tick(); await ackDetection();
  const create = sent.at(-1);
  c.observe({ type: "error", error: { event_id: create.event_id, message: "insertion refused" } }); await tick();
  await ackDetection(); await work;
  expect(state!).toMatchObject({ phase: "failed", deleted: 0, error: "insertion refused" });
  expect(sent.some(e => e.type === "conversation.item.delete")).toBe(false);
});
it("keeps an accepted summary on partial deletion failure and restores turn detection", async () => {
  const work = c.compact(); finish(); await tick(); await ackDetection(); await summaryAck();
  c.observe({ type: "conversation.item.deleted", item_id: sent.at(-1).item_id }); await tick();
  c.observe({ type: "error", error: { event_id: sent.at(-1).event_id, message: "delete refused" } }); await tick();
  expect(sent.at(-1).session.audio.input.turn_detection.create_response).toBe(true);
  await ackDetection(); await work;
  expect(state!).toMatchObject({ phase: "failed", deleted: 1 });
  expect(sent.filter(e => e.type === "conversation.item.delete").map(e => e.item_id)).toEqual(["a", "b"]);
});
it("cancels on stop without installing anything on a later connection", async () => {
  const work = c.compact(); c.dispose(); await work;
  const before = sent.length;
  c.observe({ type: "response.done", response: { id: "late", metadata: sent[0].response.metadata } }); await tick();
  expect(state!.phase).toBe("cancelled"); expect(sent).toHaveLength(before);
});
it("does not delete source items changed while summarizing", async () => {
  const work = c.compact(); c.observe({ type: "conversation.item.truncated", item_id: "a" });
  finish(); await tick(); await ackDetection(); await ackDetection(); await work;
  expect(state!.error).toContain("Source context changed");
  expect(sent.some(e => e.type === "conversation.item.delete")).toBe(false);
});
it("aborts when a retained clarification changes while summarizing", async () => {
  const work = c.compact();
  c.observe({ type: "conversation.item.input_audio_transcription.completed", item_id: "f" });
  finish(); await tick(); await ackDetection(); await ackDetection(); await work;
  expect(state!).toMatchObject({ phase: "failed", deleted: 0 });
  expect(state!.error).toContain("Source context changed");
  expect(sent.some(e => e.type === "conversation.item.create")).toBe(false);
});
it("times out before deleting unacknowledged summary context", async () => {
  const work = c.compact(); finish(); await tick(); await ackDetection();
  await vi.advanceTimersByTimeAsync(15_001); await ackDetection(); await work;
  expect(state!.phase).toBe("failed"); expect(state!.deleted).toBe(0);
});
it("respects settings edits during installation and responds to speech committed while VAD replies were paused", async () => {
  const work = c.compact(); finish(); await tick(); await ackDetection(); await summaryAck();
  c.observe({ type: "input_audio_buffer.committed", item_id: "late-audio" });
  const edit = { type: "session.update", session: { audio: { input: { turn_detection: detection } } } };
  expect(c.prepare(edit).session.audio.input.turn_detection.create_response).toBe(false);
  await deleteAll(); await ackDetection(); await work;
  expect(userReply).toHaveBeenCalledOnce();
});
it("preserves Stay silent changed during compaction", async () => {
  const work = c.compact(); finish(); await tick(); await ackDetection(); await summaryAck();
  c.observe({ type: "input_audio_buffer.committed", item_id: "silent-audio" });
  detection = { ...detection, create_response: false };
  await deleteAll(); await ackDetection(); await work;
  expect(userReply).not.toHaveBeenCalled();
  expect(sent.at(-1).session.audio.input.turn_detection.create_response).toBe(false);
});
it("recompacts the previous summary ahead of newer source material", async () => {
  let work = c.compact(); finish(); await tick(); await ackDetection(); const previous = await summaryAck();
  await deleteAll(); await ackDetection(); await work;
  c.observe(message("g")); c.observe(message("h"));
  work = c.compact();
  expect(sent.at(-1).response.input.filter((i: any) => i.type === "item_reference").map((i: any) => i.id))
    .toEqual([previous.item.id, "c", "d", "e", "f", "new-image", "g", "h"]);
  c.dispose(); await work;
});
