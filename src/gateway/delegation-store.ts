import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { DelegationTask } from "./delegation-types.js";
import type { StreamCapture } from "../live/stream-contracts.js";

/** Local gateway-owned snapshots plus an append-only diagnostic event journal. */
export class DelegationStore {
  constructor(private root: string) { mkdirSync(root, { recursive: true }); }
  private directory(owner: string) {
    const dir = join(this.root, createHash("sha256").update(owner).digest("hex").slice(0, 32));
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  private path(owner: string, id: string) {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid delegation ID");
    return join(this.directory(owner), `${id}.json`);
  }
  get(owner: string, id: string): DelegationTask | undefined {
    const path = this.path(owner, id);
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch (e: any) { if (e.code === "ENOENT") return undefined; throw e; }
  }
  list(owner: string, session: string): DelegationTask[] {
    return readdirSync(this.directory(owner)).filter(p => p.endsWith(".json"))
      .map(p => this.get(owner, p.slice(0, -5))!)
      .filter(t => t.ownerSession === session).sort((a, b) => a.createdAt - b.createdAt);
  }
  save(owner: string, task: DelegationTask) {
    const path = this.path(owner, task.id);
    writeFileSync(`${path}.tmp`, JSON.stringify(task), { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
  }
  /** Only the gateway's trusted capture path calls this, never client RPC data. */
  capture(owner: string, id: string, snapshot: StreamCapture): NonNullable<DelegationTask["evidence"]> {
    const dir = this.path(owner, id).replace(/\.json$/, ".evidence");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const images = snapshot.images.map((image, index) => {
      const path = join(dir, `frame-${index}.jpg`);
      writeFileSync(path, Buffer.from(image.data, "base64"), { mode: 0o600 });
      return { path, at: image.at, sequence: image.sequence };
    });
    let audio: { path: string; start: number; end: number } | undefined;
    if (snapshot.audio.length) {
      const start = Math.max(snapshot.at - 30_000, Math.min(...snapshot.audio.map(a => a.start)));
      const end = Math.min(snapshot.at, Math.max(...snapshot.audio.map(a => a.end)));
      const pcm = Buffer.alloc(Math.max(0, Math.ceil((end - start) * 16)) * 2);
      for (const a of snapshot.audio) {
        const offset = Math.max(0, Math.round((a.start - start) * 16) * 2);
        if (offset < pcm.length) Buffer.from(a.data, "base64").copy(pcm, offset, 0, pcm.length - offset);
      }
      const header = Buffer.alloc(44);
      header.write("RIFF", 0); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
      header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
      header.writeUInt32LE(16000, 24); header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32);
      header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
      audio = { path: join(dir, "audio.wav"), start, end };
      writeFileSync(audio.path, Buffer.concat([header, pcm]), { mode: 0o600 });
    }
    const manifest = join(dir, "manifest.json");
    writeFileSync(manifest, JSON.stringify({ version: 1, at: snapshot.at, inputSequence: snapshot.inputSequence,
      history: snapshot.history, images, audio, audioTranscript: null }, null, 2), { mode: 0o600 });
    return { manifest, at: snapshot.at, inputSequence: snapshot.inputSequence, images: images.length, audioMs: audio ? audio.end - audio.start : 0 };
  }
  event(owner: string, task: DelegationTask, type: string, data?: unknown) {
    const last = task.events.at(-1);
    const event = { seq: (last?.seq ?? 0) + 1, at: Date.now(), type, data };
    appendFileSync(this.path(owner, task.id).replace(/\.json$/, ".jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
    // Keep UI payloads bounded. The journal retains the earlier events.
    task.events = [...task.events.slice(-99), event];
    this.save(owner, task);
  }
  trace(owner: string, session: string, connection: string, type: string, data: unknown) {
    const name = createHash("sha256").update(session).digest("hex").slice(0, 32);
    appendFileSync(join(this.directory(owner), `routing-${name}.jsonl`),
      JSON.stringify({ at: Date.now(), session, connection, type, data }) + "\n", { mode: 0o600 });
  }
}
