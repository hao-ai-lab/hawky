/**
 * Disk side of browser camera archiving (no model call or memory extraction).
 *
 * session-archives/<sha256(sessionKey)>/
 *   assets/<sha256(JPEG bytes)>.jpg
 *   runs/<runId>/frames/<frameId>.json
 *   runs/<runId>/receipts/<frameId>/<serverEventId>.json
 *
 * sessionKey joins this archive to the existing text conversation. runId groups
 * one realtime connection; frameId is also the outgoing provider event_id.
 * A sent record and an acceptance receipt are separate evidence, never edits to
 * the same file. Absence of a receipt means unknown, not rejected.
 *
 * Performance: filesystem calls are asynchronous, but base64 decoding, hashing,
 * validation and JSON serialization still consume this process's CPU. No media
 * retention/cleanup policy exists here; disk use grows with recorded frames.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, readFile, link, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getSessionsDir } from "./session.js";

export type CameraFrame = {
  // Stable conversation identity, also used by session.appendMessages.
  sessionKey: string;
  // New UUID each time the browser starts a realtime connection.
  runId: string;
  // Stable across archive retries; changing it would create a second record.
  frameId: string;
  // Browser wall-clock time sampled after JPEG encoding, not a hardware timestamp.
  capturedAt: string;
  // The SAME JPEG data URL handed to the realtime API, not a second capture.
  image: string;
  // Provider conversation item identity, distinct from the request event ID.
  // Optional fields keep older archive clients compatible.
  itemId?: string;
  sentAt?: string;
};

/**
 * Publish a complete file once, including under concurrent RPC retries.
 * A hard link atomically creates the final name or fails if it already exists;
 * unlike overwrite-by-rename, two writers cannot replace each other's records.
 * The temporary file is in the same directory/filesystem as the destination.
 *
 * This prevents readers seeing partial JSON/JPEG files. It does NOT guarantee
 * survival of power loss (no fsync); a process crash can leave a temporary file.
 * Even duplicates write a temporary copy first: dedup saves retained disk space,
 * not upload bandwidth, hashing work, or all disk writes.
 */
async function createOnce(path: string, bytes: string | Buffer): Promise<boolean> {
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, bytes, { mode: 0o600 });
  try {
    await link(temp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temp);
  }
}

export async function archiveCameraFrame(input: unknown, root = join(dirname(getSessionsDir()), "session-archives")) {
  // Reject oversized input before decoding. 1 MB of binary becomes roughly
  // 1.4 million base64 characters. IDs are restricted before path construction.
  const p = input as Partial<CameraFrame> | null;
  if (!p || typeof p.sessionKey !== "string" || !p.sessionKey.trim() || p.sessionKey.length > 100 ||
      typeof p.runId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(p.runId) ||
      typeof p.frameId !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(p.frameId) ||
      typeof p.capturedAt !== "string" || !Number.isFinite(Date.parse(p.capturedAt)) ||
      (p.itemId !== undefined && (typeof p.itemId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(p.itemId))) ||
      (p.sentAt !== undefined && (typeof p.sentAt !== "string" || !Number.isFinite(Date.parse(p.sentAt)))) ||
      typeof p.image !== "string" || p.image.length > 1_400_000 ||
      !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(p.image)) {
    throw Object.assign(new Error("Invalid camera frame metadata or JPEG (maximum 1 MB)."), { code: "INVALID_REQUEST" });
  }
  const bytes = Buffer.from(p.image.slice("data:image/jpeg;base64,".length), "base64");
  // Cheap envelope check, not a full JPEG decoder. Avoid image processing in
  // the storage path; decoding/resizing already happened in the browser.
  if (bytes.length < 4 || bytes.length > 1_048_576 || bytes[0] !== 0xff || bytes[1] !== 0xd8 ||
      bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
    throw Object.assign(new Error("Invalid JPEG bytes."), { code: "INVALID_REQUEST" });
  }
  // Hash the session key to keep arbitrary user input out of filesystem paths.
  const sessionId = createHash("sha256").update(p.sessionKey).digest("hex");
  const hash = createHash("sha256").update(bytes).digest("hex");
  // Asset reuse is within a conversation, across its runs. Only byte-identical
  // JPEGs deduplicate; visually similar/noisy camera frames usually do not.
  const base = join(root, sessionId);
  const frames = join(base, "runs", p.runId, "frames");
  await mkdir(frames, { recursive: true, mode: 0o700 });
  await mkdir(join(base, "assets"), { recursive: true, mode: 0o700 });
  const asset = `assets/${hash}.jpg`;
  await createOnce(join(base, asset), bytes);
  // Save the asset before its reference. A failure between these writes can
  // leave an orphan JPEG, but never a newly published reference to missing bytes.
  const record = {
    version: 1, type: "input.image", sessionKey: p.sessionKey, runId: p.runId,
    frameId: p.frameId, capturedAt: p.capturedAt, status: "sent", asset,
    sha256: hash, bytes: bytes.length,
    ...(p.itemId ? { itemId: p.itemId } : {}),
    ...(p.sentAt ? { sentAt: p.sentAt } : {}),
  };
  const path = join(frames, `${p.frameId}.json`);
  const contents = JSON.stringify(record, null, 2) + "\n";
  const created = await createOnce(path, contents);
  if (!created && await readFile(path, "utf8") !== contents) {
    // Lost RPC responses can cause retries. Same ID + same payload succeeds;
    // same ID + different payload is a conflict, not an overwrite.
    throw Object.assign(new Error("Frame ID already exists with different content."), { code: "INVALID_REQUEST" });
  }
  return { ok: true, frameId: p.frameId, asset: `${sessionId}/${asset}`, duplicate: !created };
}

/**
 * Immutable provider receipt alongside the original sent record.
 * The browser forwards this evidence; the backend does not independently listen
 * to the provider or authenticate the provider event. Accepted means the item
 * was added, not that a particular answer used the image.
 */
export async function archiveCameraReceipt(input: unknown, root = join(dirname(getSessionsDir()), "session-archives")) {
  const p = input as Record<string, unknown> | null;
  const id = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
  if (!p || typeof p.sessionKey !== "string" || !p.sessionKey.trim() || p.sessionKey.length > 100 ||
      !id(p.runId) || !id(p.frameId) || !id(p.itemId) || !id(p.serverEventId) ||
      typeof p.receivedAt !== "string" || !Number.isFinite(Date.parse(p.receivedAt)) ||
      !["accepted", "rejected"].includes(String(p.status)) ||
      !["conversation.item.created", "conversation.item.added", "error"].includes(String(p.eventType)) ||
      (p.status === "rejected") !== (p.eventType === "error") ||
      (p.errorMessage !== undefined && (typeof p.errorMessage !== "string" || p.errorMessage.length > 2000))) {
    throw Object.assign(new Error("Invalid camera acknowledgement."), { code: "INVALID_REQUEST" });
  }
  const sessionId = createHash("sha256").update(p.sessionKey).digest("hex");
  const run = join(root, sessionId, "runs", p.runId);
  const frame = JSON.parse(await readFile(join(run, "frames", `${p.frameId}.json`), "utf8"));
  // The frontend's serial queue uploads the frame before its receipt. Requiring
  // it here also prevents attaching an acknowledgement to an unrelated item.
  if (frame.itemId !== p.itemId) {
    throw Object.assign(new Error("Acknowledgement item does not match the saved frame."), { code: "INVALID_REQUEST" });
  }
  const dir = join(run, "receipts", p.frameId);
  // One small file per observed receipt; no image bytes are uploaded again.
  // This makes retries simple, but high capture rates create many small files.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const record = { version: 1, sessionKey: p.sessionKey, runId: p.runId, frameId: p.frameId,
    itemId: p.itemId, serverEventId: p.serverEventId, receivedAt: p.receivedAt,
    status: p.status, eventType: p.eventType, ...(p.errorMessage ? { errorMessage: p.errorMessage } : {}) };
  const path = join(dir, `${p.serverEventId}.json`);
  const contents = JSON.stringify(record, null, 2) + "\n";
  const created = await createOnce(path, contents);
  if (!created && await readFile(path, "utf8") !== contents) {
    throw Object.assign(new Error("Receipt ID already exists with different content."), { code: "INVALID_REQUEST" });
  }
  return { ok: true, frameId: p.frameId, status: p.status, duplicate: !created };
}
