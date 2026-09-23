import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import type { DelegationTask } from "./delegation-types.js";

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
  event(owner: string, task: DelegationTask, type: string, data?: unknown) {
    const last = task.events.at(-1);
    const event = { seq: (last?.seq ?? 0) + 1, at: Date.now(), type, data };
    appendFileSync(this.path(owner, task.id).replace(/\.json$/, ".jsonl"), JSON.stringify(event) + "\n", { mode: 0o600 });
    // Keep UI payloads bounded. The journal retains the earlier events.
    task.events = [...task.events.slice(-99), event];
    this.save(owner, task);
  }
}
