/** One live interaction (Start -> Stop) owns one readable directory and log.
 * Reconnects append connection events to that log. Legacy archives are untouched.
 * A single gateway process serializes writes per directory. This is not a
 * multi-process writer; multiple gateways must not share the same archive root.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, open, truncate } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSessionsDir } from "./session.js";

type Event = { id: string; type: string; timestamp: string; connectionId: string; data: Record<string, unknown> };
type Params = { liveSessionId: string; sessionKey: string };
type Stored = Event & { sequence: number };
type State = { events: Map<string, Stored>; metadata: Record<string, unknown> };
const locks = new Map<string, Promise<unknown>>();
const cache = new Map<string, State>();
const rootDir = () => join(dirname(getSessionsDir()), "realtime-sessions");
const invalid = (message: string) => Object.assign(new Error(message), { code: "INVALID_REQUEST" });

function directory(p: Params, root: string) {
  if (!p || typeof p.sessionKey !== "string" || !p.sessionKey.trim() || p.sessionKey.length > 100 ||
      typeof p.liveSessionId !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z_[a-f0-9]{8}$/.test(p.liveSessionId)) {
    throw invalid("Invalid realtime session identity.");
  }
  return join(root, p.liveSessionId);
}

async function serial<T>(dir: string, work: () => Promise<T>): Promise<T> {
  const before = locks.get(dir) ?? Promise.resolve();
  const next = before.catch(() => {}).then(work);
  locks.set(dir, next);
  try { return await next; } finally { if (locks.get(dir) === next) locks.delete(dir); }
}

async function state(dir: string): Promise<State> {
  const known = cache.get(dir);
  if (known) return known;
  const metadata = JSON.parse(await readFile(join(dir, "session.json"), "utf8"));
  let bytes: Buffer;
  try { bytes = await readFile(join(dir, "conversation.jsonl")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; bytes = Buffer.alloc(0); }
  // A crash may leave the last line partial. Keep complete records; a retry
  // with the same event ID can safely replace the discarded incomplete tail.
  const end = bytes.lastIndexOf(10) + 1;
  if (end < bytes.length) await truncate(join(dir, "conversation.jsonl"), end);
  const events = new Map<string, Stored>();
  for (const line of bytes.subarray(0, end).toString("utf8").split("\n").filter(Boolean)) {
    const event = JSON.parse(line) as Stored;
    events.set(event.id, event);
    if (event.type === "session.ended") Object.assign(metadata, { status: event.data.complete ? "ended" : "incomplete", endedAt: event.timestamp });
  }
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  const loaded = { metadata, events }; cache.set(dir, loaded); return loaded;
}

async function manifest(dir: string, metadata: Record<string, unknown>) {
  const temp = join(dir, `session.${randomUUID()}.tmp`);
  await writeFile(temp, JSON.stringify(metadata, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, join(dir, "session.json"));
}

function checkEvent(event: Event) {
  if (!event || typeof event.id !== "string" || event.id.length > 150 || !event.id ||
      typeof event.type !== "string" || !/^[a-z]+(?:\.[a-z_]+)+$/.test(event.type) ||
      typeof event.connectionId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(event.connectionId) ||
      typeof event.timestamp !== "string" || !Number.isFinite(Date.parse(event.timestamp)) ||
      !event.data || typeof event.data !== "object" || Array.isArray(event.data) || JSON.stringify(event).length > 2_000_000) {
    throw invalid("Invalid realtime archive event.");
  }
}

async function append(dir: string, p: Params, event: Event) {
  checkEvent(event);
  const s = await state(dir);
  if (s.metadata.sessionKey !== p.sessionKey) throw invalid("Session belongs to another conversation.");
  const previous = s.events.get(event.id);
  if (previous) {
    const { sequence, ...body } = previous;
    if (JSON.stringify(body) !== JSON.stringify(event)) throw invalid("Event ID has different content.");
    return { ok: true, sequence, duplicate: true };
  }
  if (s.metadata.status !== "open") throw invalid("Live session has ended.");
  const record = { ...event, sequence: s.events.size + 1 };
  const file = await open(join(dir, "conversation.jsonl"), "a", 0o600);
  try {
    await file.writeFile(JSON.stringify(record) + "\n");
    await file.sync(); // Acknowledge only after flushing the log, not merely queuing a write.
  } catch (e) { cache.delete(dir); throw e; } finally { await file.close(); }
  s.events.set(event.id, record);
  if (event.type === "session.ended") {
    Object.assign(s.metadata, { status: event.data.complete ? "ended" : "incomplete", endedAt: event.timestamp });
    await manifest(dir, s.metadata);
  }
  return { ok: true, sequence: record.sequence, duplicate: false };
}

export async function beginRealtimeArchive(p: Params & { startedAt: string }, root = rootDir()) {
  const dir = directory(p, root);
  if (typeof p.startedAt !== "string" || !Number.isFinite(Date.parse(p.startedAt))) throw invalid("Invalid start time.");
  return serial(dir, async () => {
    await mkdir(join(dir, "images"), { recursive: true, mode: 0o700 });
    let s: State;
    try { s = await state(dir); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      await manifest(dir, { version: 1, liveSessionId: p.liveSessionId, sessionKey: p.sessionKey, startedAt: p.startedAt, status: "open" });
      s = await state(dir);
    }
    if (s.metadata.sessionKey !== p.sessionKey) throw invalid("Session belongs to another conversation.");
    if (s.metadata.status !== "open") return { ...s.metadata, closed: true };
    await append(dir, p, { id: "session-start", type: "session.started", timestamp: String(s.metadata.startedAt), connectionId: "none", data: {} });
    // Resume from the archive, not from whichever history view loaded first in
    // the browser. Start with the last replay packet, then add subsequent turns.
    let messages: Array<{ role: string; text: string }> = [];
    for (const e of s.events.values()) {
      if (e.type === "context.restored" && Array.isArray(e.data.messages)) {
        messages = e.data.messages.filter(m => m && ["user", "assistant"].includes(m.role) && typeof m.text === "string")
          .map(m => ({ role: m.role, text: m.text }));
      }
      if (e.type === "message.completed" && ["user", "assistant"].includes(String(e.data.role)) && typeof e.data.text === "string") {
        messages.push({ role: String(e.data.role), text: e.data.text });
      }
    }
    return { ...s.metadata, closed: false, messages: messages.slice(-30) };
  });
}

export async function appendRealtimeEvent(p: Params & { event: Event }, root = rootDir()) {
  const dir = directory(p, root);
  return serial(dir, () => append(dir, p, p.event));
}

export async function saveRealtimeImage(p: Params & { event: Event; image: string }, root = rootDir()) {
  const dir = directory(p, root);
  if (typeof p.image !== "string" || p.image.length > 1_400_000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(p.image)) throw invalid("Invalid JPEG upload.");
  const bytes = Buffer.from(p.image.slice(23), "base64");
  if (bytes.length < 4 || bytes.length > 1_048_576 || bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw invalid("Invalid JPEG bytes.");
  checkEvent(p.event);
  if (p.event.type !== "image.sent") throw invalid("Expected image.sent event.");
  const hash = createHash("sha256").update(bytes).digest("hex");
  return serial(dir, async () => {
    const s = await state(dir);
    if (s.metadata.sessionKey !== p.sessionKey) throw invalid("Session belongs to another conversation.");
    const asset = `images/${hash}.jpg`;
    // Atomic publication; exact-byte dedup is per live session. Encoding/hash
    // CPU and network uploads still happen even for duplicate image content.
    const temp = join(dir, `image.${randomUUID()}.tmp`);
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, join(dir, asset));
    const result = await append(dir, p, { ...p.event, data: { ...p.event.data, asset, sha256: hash, bytes: bytes.length } });
    return { ...result, asset };
  });
}

export async function saveRealtimeReceipt(p: Params & { event: Event }, root = rootDir()) {
  const dir = directory(p, root);
  checkEvent(p.event);
  return serial(dir, async () => {
    const s = await state(dir);
    const frame = s.events.get(`image:${p.event.data.frameId}`);
    if (!frame || frame.type !== "image.sent" || frame.connectionId !== p.event.connectionId || frame.data.itemId !== p.event.data.itemId ||
        !["image.accepted", "image.rejected"].includes(p.event.type)) throw invalid("Receipt does not match an archived image.");
    return append(dir, p, p.event);
  });
}
