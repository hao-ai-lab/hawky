// Storage contract tests: temporary directories isolate them from ~/.hawky.
// They cover byte preservation, immutable records and retry/concurrency safety;
// they do not measure filesystem throughput or contact the realtime provider.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { archiveCameraFrame, archiveCameraReceipt } from "../../src/storage/camera-archive.js";

let root: string;
// Minimal JPEG-envelope fixture, not a decodable photograph. The storage layer
// intentionally checks markers only; a real JPEG was used in the gateway probe.
const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 2, 0xff, 0xd9]);
const frame = { sessionKey: "web:ios", runId: "run-1", frameId: "frame-1",
  capturedAt: "2026-09-22T12:00:00.000Z", image: `data:image/jpeg;base64,${bytes.toString("base64")}` };
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "camera-archive-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe("camera archive", () => {
  test("saves matched receipts separately, deduplicates retries, and preserves sent evidence", async () => {
    const saved = await archiveCameraFrame({ ...frame, itemId: "image1", sentAt: frame.capturedAt }, root);
    const receipt = { sessionKey: frame.sessionKey, runId: frame.runId, frameId: frame.frameId,
      itemId: "image1", serverEventId: "event_server1", receivedAt: frame.capturedAt,
      status: "accepted", eventType: "conversation.item.added" };
    expect((await archiveCameraReceipt(receipt, root)).duplicate).toBe(false);
    expect((await archiveCameraReceipt(receipt, root)).duplicate).toBe(true);
    const run = join(root, saved.asset.split("/")[0], "runs/run-1");
    const record = JSON.parse(await readFile(join(run, "receipts/frame-1/event_server1.json"), "utf8"));
    expect(record.status).toBe("accepted");
    expect(JSON.parse(await readFile(join(run, "frames/frame-1.json"), "utf8")).status).toBe("sent");
    await expect(archiveCameraReceipt({ ...receipt, itemId: "wrong" }, root)).rejects.toThrow("does not match");
    await expect(archiveCameraReceipt({ ...receipt, runId: "../escape" }, root)).rejects.toThrow();
    await expect(archiveCameraReceipt({ ...receipt, status: "rejected" }, root)).rejects.toThrow();
    await archiveCameraFrame({ ...frame, frameId: "frame-2", itemId: "image2" }, root);
    const rejected = { ...receipt, frameId: "frame-2", itemId: "image2", status: "rejected", eventType: "error", errorMessage: "Invalid image" };
    expect((await archiveCameraReceipt(rejected, root)).status).toBe("rejected");
  });
  test("preserves bytes and metadata; concurrent retries create one record", async () => {
    const results = await Promise.all(Array.from({ length: 4 }, () => archiveCameraFrame(frame, root)));
    // Simulates several retries reaching the backend together after lost ACKs.
    expect(results.filter(r => !r.duplicate)).toHaveLength(1);
    expect(await readFile(join(root, results[0].asset))).toEqual(bytes);
    const session = results[0].asset.split("/")[0];
    const dir = join(root, session, "runs/run-1/frames");
    expect(await readdir(dir)).toEqual(["frame-1.json"]);
    const record = JSON.parse(await readFile(join(dir, "frame-1.json"), "utf8"));
    expect(record).toMatchObject({ sessionKey: "web:ios", capturedAt: frame.capturedAt, status: "sent" });
    await archiveCameraFrame({ ...frame, frameId: "frame-2" }, root);
    expect(await readdir(join(root, session, "assets"))).toHaveLength(1);
  });

  test("rejects conflicting IDs, traversal, malformed and oversized input", async () => {
    await archiveCameraFrame(frame, root);
    await expect(archiveCameraFrame({ ...frame, capturedAt: "2026-09-23T00:00:00Z" }, root)).rejects.toThrow("different content");
    for (const invalid of [null, { ...frame, runId: "../escape" }, { ...frame, frameId: "../escape" },
      { ...frame, image: "data:image/jpeg;base64,YWJj" }, { ...frame, image: "a".repeat(1_400_001) }]) {
      await expect(archiveCameraFrame(invalid, root)).rejects.toThrow();
    }
  });
});
