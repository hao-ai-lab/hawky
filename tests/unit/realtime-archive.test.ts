import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, appendFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beginRealtimeArchive, appendRealtimeEvent, saveRealtimeImage, saveRealtimeReceipt } from "../../src/storage/realtime-archive.js";

let root: string;
const p = { sessionKey: "web:ios", liveSessionId: "2026-09-23T09-30-00.000Z_a1b2c3d4", startedAt: "2026-09-23T09:30:00.000Z" };
const event = (id: string, type: string, data: Record<string, unknown> = {}, connectionId = "connection-1") => ({ id, type, data, connectionId, timestamp: p.startedAt });
const log = async () => (await readFile(join(root, p.liveSessionId, "conversation.jsonl"), "utf8")).trim().split("\n").map(l => JSON.parse(l));
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "realtime-recording-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

test("one timestamped folder holds reconnects, transcript, exact JPEG and receipts", async () => {
  await beginRealtimeArchive(p, root);
  await appendRealtimeEvent({ ...p, event: event("connect1", "connection.started") }, root);
  await appendRealtimeEvent({ ...p, event: event("message1", "message.completed", { role: "user", text: "What color?" }) }, root);
  const image = "data:image/jpeg;base64,/9j/2Q==";
  const frame = { ...p, image, event: event("image:frame1", "image.sent", { frameId: "frame1", itemId: "item1" }) };
  const saved = await saveRealtimeImage(frame, root);
  expect(await readFile(join(root, p.liveSessionId, saved.asset))).toEqual(Buffer.from([255, 216, 255, 217]));
  const receipt = { ...p, event: event("receipt:accepted1", "image.accepted", { frameId: "frame1", itemId: "item1" }) };
  await saveRealtimeReceipt(receipt, root);
  expect((await saveRealtimeReceipt(receipt, root)).duplicate).toBe(true);
  await expect(saveRealtimeReceipt({ ...receipt, event: { ...receipt.event, id: "bad", data: { frameId: "frame1", itemId: "wrong" } } }, root)).rejects.toThrow();
  const resumed = await beginRealtimeArchive(p, root);
  expect(resumed.closed).toBe(false);
  expect(resumed.messages).toEqual([{ role: "user", text: "What color?" }]);
  await appendRealtimeEvent({ ...p, event: event("connect2", "connection.started", { resumed: true }, "connection-2") }, root);
  expect(await readdir(root)).toEqual([p.liveSessionId]);
  expect((await log()).map(e => e.type)).toEqual(["session.started", "connection.started", "message.completed", "image.sent", "image.accepted", "connection.started"]);
  const end = { ...p, event: event("session-end", "session.ended", { complete: true }) };
  await appendRealtimeEvent(end, root);
  expect((await appendRealtimeEvent(end, root)).duplicate).toBe(true);
  expect((await beginRealtimeArchive(p, root)).closed).toBe(true);
  expect(JSON.parse(await readFile(join(root, p.liveSessionId, "session.json"), "utf8")).status).toBe("ended");
  await expect(appendRealtimeEvent({ ...p, event: event("late", "message.completed") }, root)).rejects.toThrow("ended");
});

test("concurrent retry IDs yield one record and conflicting content is rejected", async () => {
  await beginRealtimeArchive(p, root);
  const request = { ...p, event: event("m1", "message.completed", { text: "Hi" }) };
  const results = await Promise.all(Array.from({ length: 5 }, () => appendRealtimeEvent(request, root)));
  expect(results.filter(r => !r.duplicate)).toHaveLength(1);
  expect(await log()).toHaveLength(2);
  await expect(appendRealtimeEvent({ ...request, event: { ...request.event, data: { text: "Different" } } }, root)).rejects.toThrow("different content");
  await expect(beginRealtimeArchive({ ...p, liveSessionId: "../escape" }, root)).rejects.toThrow();
  await expect(beginRealtimeArchive({ ...p, sessionKey: "another" }, root)).rejects.toThrow();
});

test("repeated resume does not mutate or duplicate the saved context packet", async () => {
  await beginRealtimeArchive(p, root);
  const context = { ...p, event: event("restore1", "context.restored", { messages: [{ role: "user", text: "Earlier" }] }) };
  await appendRealtimeEvent(context, root);
  await appendRealtimeEvent({ ...p, event: event("new1", "message.completed", { role: "assistant", text: "Later" }) }, root);
  const first = await beginRealtimeArchive(p, root);
  expect((await beginRealtimeArchive(p, root)).messages).toEqual(first.messages);
  expect(first.messages).toHaveLength(2);
  expect((await appendRealtimeEvent(context, root)).duplicate).toBe(true);
});

test("recovers a partial last line when opening an uncached archive", async () => {
  // Construct the disk snapshot of a terminated process; no cached state exists.
  const { mkdir, writeFile } = await import("node:fs/promises");
  const dir = join(root, p.liveSessionId); await mkdir(dir);
  await writeFile(join(dir, "session.json"), JSON.stringify({ ...p, status: "open" }));
  await appendFile(join(dir, "conversation.jsonl"), '{"unfinished":');
  await beginRealtimeArchive(p, root);
  expect((await log()).map(e => e.type)).toEqual(["session.started"]);
});
