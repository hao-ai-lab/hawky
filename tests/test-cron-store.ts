// =============================================================================
// Tests: Cron Store Persistence
// =============================================================================

import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CronStore } from "../src/gateway/cron-store.js";

let testDir: string;

beforeAll(() => {
  testDir = join(tmpdir(), `hawky-cron-store-test-${Date.now()}`);
  mkdirSync(testDir, { recursive: true });
});

afterAll(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

function makeStore(name = "default"): CronStore {
  return new CronStore(join(testDir, name, "jobs.json"));
}

// -----------------------------------------------------------------------------
// CRUD
// -----------------------------------------------------------------------------

describe("CronStore CRUD", () => {
  test("add job and retrieve", () => {
    const store = makeStore("crud-add");
    const job = store.addJob({
      name: "test-job",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "Hello" },
    });

    expect(job.id).toBeTruthy();
    expect(job.name).toBe("test-job");
    expect(job.enabled).toBe(true);
    expect(job.payload.message).toBe("Hello");
    expect(job.state.nextRunAtMs).toBe(null);

    const retrieved = store.getJob(job.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(job.id);
  });

  test("list jobs", () => {
    const store = makeStore("crud-list");
    store.addJob({ name: "job-1", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "1" } });
    store.addJob({ name: "job-2", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "2" } });

    const jobs = store.getJobs();
    expect(jobs.length).toBe(2);
  });

  test("update job", () => {
    const store = makeStore("crud-update");
    const job = store.addJob({ name: "old-name", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "old" } });

    const updated = store.updateJob(job.id, { name: "new-name", payload: { message: "new" } });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe("new-name");
    expect(updated!.payload.message).toBe("new");
  });

  test("update nonexistent job returns null", () => {
    const store = makeStore("crud-update-null");
    expect(store.updateJob("nonexistent", { name: "x" })).toBeNull();
  });

  test("remove job", () => {
    const store = makeStore("crud-remove");
    const job = store.addJob({ name: "to-remove", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "bye" } });

    expect(store.removeJob(job.id)).toBe(true);
    expect(store.getJob(job.id)).toBeUndefined();
    expect(store.getJobs().length).toBe(0);
  });

  test("remove nonexistent job returns false", () => {
    const store = makeStore("crud-remove-false");
    expect(store.removeJob("nonexistent")).toBe(false);
  });

  test("update job state", () => {
    const store = makeStore("crud-state");
    const job = store.addJob({ name: "stateful", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "test" } });

    store.updateJobState(job.id, { lastRunAtMs: 12345, lastStatus: "ok", consecutiveErrors: 0 });
    const updated = store.getJob(job.id);
    expect(updated!.state.lastRunAtMs).toBe(12345);
    expect(updated!.state.lastStatus).toBe("ok");
  });

  test("rebindSessionKey updates sessionTarget, sessionKey, and delivery_target", () => {
    const store = makeStore("crud-rebind");
    const jobA = store.addJob({
      name: "a",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "hi" },
      sessionTarget: "session:web:email-triage",
      sessionKey: "web:email-triage",
      delivery_target: "web:email-triage",
    });
    const jobB = store.addJob({
      name: "b",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "hi" },
      sessionTarget: "session:web:other",
    });

    const n = store.rebindSessionKey("web:email-triage", "web:message-triage");
    expect(n).toBe(1);

    const a = store.getJob(jobA.id)!;
    expect(a.sessionTarget).toBe("session:web:message-triage");
    expect(a.sessionKey).toBe("web:message-triage");
    expect(a.delivery_target).toBe("web:message-triage");

    const b = store.getJob(jobB.id)!;
    expect(b.sessionTarget).toBe("session:web:other");
  });

  test("rebindSessionKey persists through reload", () => {
    const path = join(testDir, "rebind-persist", "jobs.json");
    const store1 = new CronStore(path);
    const job = store1.addJob({
      name: "persist",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "hi" },
      delivery_target: "web:old",
    });
    store1.rebindSessionKey("web:old", "web:new");

    const store2 = new CronStore(path);
    store2.reload();
    expect(store2.getJob(job.id)!.delivery_target).toBe("web:new");
  });

  test("rebindSessionKey with no matches returns 0", () => {
    const store = makeStore("crud-rebind-none");
    store.addJob({
      name: "a",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "hi" },
      sessionTarget: "isolated",
    });
    expect(store.rebindSessionKey("web:missing", "web:new")).toBe(0);
  });
});

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

describe("CronStore persistence", () => {
  test("jobs persist to disk and reload", () => {
    const path = join(testDir, "persist", "jobs.json");
    const store1 = new CronStore(path);
    store1.addJob({ name: "persisted", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "hello" } });

    // Create new store instance (simulates gateway restart)
    const store2 = new CronStore(path);
    store2.reload();
    const jobs = store2.getJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].name).toBe("persisted");
  });

  test("creates backup on structural changes", () => {
    const path = join(testDir, "backup", "jobs.json");
    const store = new CronStore(path);
    store.addJob({ name: "first", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "1" } });

    // Second add creates a backup
    store.addJob({ name: "second", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "2" } });
    expect(existsSync(`${path}.bak`)).toBe(true);
  });

  test("atomic write produces valid JSON", () => {
    const path = join(testDir, "atomic", "jobs.json");
    const store = new CronStore(path);
    store.addJob({ name: "atomic-test", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "test" } });

    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.version).toBe(1);
    expect(parsed.jobs.length).toBe(1);
  });

  test("empty store creates valid JSON", () => {
    const path = join(testDir, "empty-store", "jobs.json");
    const store = new CronStore(path);
    store.save();
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.jobs).toEqual([]);
  });
});

// -----------------------------------------------------------------------------
// Session targets
// -----------------------------------------------------------------------------

describe("CronStore session targets", () => {
  test("default session target is isolated", () => {
    const store = makeStore("session-default");
    const job = store.addJob({ name: "test", schedule: { kind: "every", everyMs: 60_000 }, payload: { message: "test" } });
    expect(job.sessionTarget).toBe("isolated");
  });

  test("current session target with sessionKey", () => {
    const store = makeStore("session-current");
    const job = store.addJob({
      name: "reminder",
      schedule: { kind: "at", at: "+1h" },
      payload: { message: "remind" },
      sessionTarget: "current",
      sessionKey: "tui:main",
    });
    expect(job.sessionTarget).toBe("current");
    expect(job.sessionKey).toBe("tui:main");
  });

  test("named session target", () => {
    const store = makeStore("session-named");
    const job = store.addJob({
      name: "standup",
      schedule: { kind: "cron", expr: "0 17 * * 1-5" },
      payload: { message: "generate standup" },
      sessionTarget: "session:standup",
    });
    expect(job.sessionTarget).toBe("session:standup");
  });
});

// -----------------------------------------------------------------------------
// Unique name enforcement
// -----------------------------------------------------------------------------

describe("CronStore unique name enforcement", () => {
  test("rejects duplicate job name", () => {
    const store = makeStore("unique-reject");
    store.addJob({
      name: "daily-digest",
      schedule: { kind: "every", everyMs: 86_400_000 },
      payload: { message: "digest" },
    });

    expect(() => {
      store.addJob({
        name: "daily-digest",
        schedule: { kind: "every", everyMs: 3_600_000 },
        payload: { message: "another digest" },
      });
    }).toThrow(/already exists/);
  });

  test("allows different names", () => {
    const store = makeStore("unique-allow");
    store.addJob({
      name: "job-alpha",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "alpha" },
    });

    const beta = store.addJob({
      name: "job-beta",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "beta" },
    });
    expect(beta.name).toBe("job-beta");
  });

  test("allows reuse of name after deletion", () => {
    const store = makeStore("unique-reuse");
    const job = store.addJob({
      name: "temp-job",
      schedule: { kind: "every", everyMs: 60_000 },
      payload: { message: "temp" },
    });
    store.removeJob(job.id);

    const reused = store.addJob({
      name: "temp-job",
      schedule: { kind: "every", everyMs: 120_000 },
      payload: { message: "reused" },
    });
    expect(reused.name).toBe("temp-job");
    expect(reused.id).not.toBe(job.id);
  });
});
