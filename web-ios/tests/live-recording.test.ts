import { beforeEach, expect, it, vi } from "vitest";
import { clearLiveRecording, openLiveRecording } from "../src/lib/live-recording";
import { CameraArchive } from "../src/lib/camera-archive";

beforeEach(() => localStorage.clear());

it("reload/retry resumes an open folder; Stop -> Start allocates a new folder", async () => {
  const rpc = vi.fn().mockResolvedValue({ closed: false });
  const first = await openLiveRecording(rpc, "web:ios");
  const resumed = await openLiveRecording(rpc, "web:ios");
  expect(resumed.liveSessionId).toBe(first.liveSessionId);
  expect(resumed.resumed).toBe(true);
  clearLiveRecording("web:ios", first.liveSessionId);
  expect((await openLiveRecording(rpc, "web:ios")).liveSessionId).not.toBe(first.liveSessionId);
});

it("an uncertain start response retries the same ID; backend-ended sessions cannot resume", async () => {
  const rpc = vi.fn().mockRejectedValueOnce(Error("reply lost")).mockResolvedValue({ closed: false });
  await expect(openLiveRecording(rpc, "web:ios")).rejects.toThrow();
  const restored = await openLiveRecording(rpc, "web:ios");
  expect(rpc.mock.calls[0][1].liveSessionId).toBe(restored.liveSessionId);
  rpc.mockResolvedValueOnce({ closed: true });
  expect((await openLiveRecording(rpc, "web:ios")).liveSessionId).not.toBe(restored.liveSessionId);
});

it("records context, messages and image receipts in one session with distinct connections", async () => {
  const rpc = vi.fn().mockResolvedValue({ ok: true });
  const first = new CameraArchive(rpc, "web:ios", "connection1", vi.fn(), "live-1");
  first.record("context.updated", { instructions: "Be concise" });
  first.record("message.completed", { role: "user", text: "Hello" });
  first.enqueue({ frameId: "frame1", itemId: "item1", capturedAt: "2026-09-23T00:00:00Z", image: "data:image/jpeg;base64,/9j/2Q==" });
  first.observe({ type: "conversation.item.added", event_id: "accepted1", item: { id: "item1" } });
  expect(await first.drain()).toBe(true);
  const second = new CameraArchive(rpc, "web:ios", "connection2", vi.fn(), "live-1");
  second.record("connection.started", { resumed: true });
  expect(await second.drain()).toBe(true);
  await second.end(true);
  expect(rpc.mock.calls.map(c => c[1].event.type)).toEqual(["context.updated", "message.completed", "image.sent", "image.accepted", "connection.started", "session.ended"]);
  expect(rpc.mock.calls.every(c => c[1].liveSessionId === "live-1")).toBe(true);
  expect(rpc.mock.calls[4][1].event.connectionId).toBe("connection2");
});
