// Queue/protocol tests use mocked RPCs and provider events. Fake timers advance
// retry backoff without waiting in real time; these are correctness tests, not
// measurements of camera encoding time, API latency, or live delivery success.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CameraArchive } from "../src/lib/camera-archive";

afterEach(() => vi.useRealTimers());
const frame = { frameId: "frame-1", capturedAt: "2026-09-22T00:00:00Z", image: "data:image/jpeg;base64,/9j/2Q==" };

describe("camera upload queue", () => {
  it("retries with stable IDs and pins uploads to the original session/run", async () => {
    vi.useFakeTimers();
    const rpc = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValue({ ok: true });
    const warn = vi.fn();
    const queue = new CameraArchive(rpc, "web:original", "run-1", warn);
    queue.enqueue(frame);
    queue.enqueue({ ...frame, frameId: "frame-2" });
    await vi.runAllTimersAsync();
    expect(rpc).toHaveBeenCalledTimes(3);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(rpc.mock.calls[2][1]).toMatchObject({ sessionKey: "web:original", runId: "run-1", frameId: "frame-2" });
    expect(warn).not.toHaveBeenCalled();
  });

  it("reports failed uploads and continues to the next frame", async () => {
    vi.useFakeTimers();
    const rpc = vi.fn().mockRejectedValueOnce(Error()).mockRejectedValueOnce(Error())
      .mockRejectedValueOnce(Error()).mockResolvedValue({ ok: true });
    const warn = vi.fn();
    const queue = new CameraArchive(rpc, "web:ios", "run-1", warn);
    queue.enqueue(frame);
    queue.enqueue({ ...frame, frameId: "frame-2" });
    await vi.runAllTimersAsync();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledTimes(4);
  });

  it("bounds queued frames while the backend is stalled", () => {
    // Never resolve the first RPC: capture can continue, but backlog must stop
    // growing and report incompleteness instead of consuming unbounded memory.
    const rpc = vi.fn(() => new Promise(() => {}));
    const warn = vi.fn();
    const queue = new CameraArchive(rpc, "web:ios", "run-1", warn);
    for (let i = 0; i < 80; i++) queue.enqueue({ ...frame, frameId: String(i) });
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each(["conversation.item.created", "conversation.item.added"])("matches %s by item ID, not the server event ID", async (type) => {
    const rpc = vi.fn().mockResolvedValue({ ok: true });
    const queue = new CameraArchive(rpc, "web:ios", "run-1", vi.fn());
    queue.enqueue({ ...frame, itemId: "image1" });
    queue.observe({ type, event_id: "server_event", item: { id: "unrelated" } });
    queue.observe({ type, event_id: "server_event", item: { id: "image1" } });
    queue.observe({ type, event_id: "duplicate_notification", item: { id: "image1" } });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(2));
    expect(rpc.mock.calls[1][0]).toBe("session.archiveCameraReceipt");
    expect(rpc.mock.calls[1][1]).toMatchObject({ frameId: "frame-1", itemId: "image1", status: "accepted", serverEventId: "server_event" });
  });

  it("matches errors using the nested client event ID and leaves missing acknowledgements unconfirmed", async () => {
    const rpc = vi.fn().mockResolvedValue({ ok: true });
    const queue = new CameraArchive(rpc, "web:ios", "run-1", vi.fn());
    queue.enqueue({ ...frame, itemId: "image1" });
    queue.enqueue({ ...frame, frameId: "frame-2", itemId: "image2" });
    queue.observe({ type: "error", event_id: "frame-1", error: { event_id: "unrelated" } });
    queue.observe({ type: "error", event_id: "server_error", error: { event_id: "frame-1", message: "Bad image" } });
    await vi.waitFor(() => expect(rpc).toHaveBeenCalledTimes(3));
    expect(rpc.mock.calls[2][1]).toMatchObject({ frameId: "frame-1", status: "rejected", errorMessage: "Bad image" });
    expect(rpc.mock.calls.filter(c => c[0] === "session.archiveCameraReceipt")).toHaveLength(1);
  });
});
