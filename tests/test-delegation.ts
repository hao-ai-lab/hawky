import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDelegationMethods, type DelegationExecutor } from "../src/gateway/delegation-methods.js";
import { setSessionsDir } from "../src/storage/session.js";

let dir: string, old: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hawky-delegation-test-")); old = setSessionsDir(dir); });
afterEach(() => { setSessionsDir(old); rmSync(dir, { recursive: true, force: true }); });
function gateway(execute: DelegationExecutor) {
  const methods = new Map<string, Function>();
  const events: any[] = [];
  const conn = { deviceTokenId: "owner-a", bindSession() {} };
  registerDelegationMethods({ registerMethod: (n: string, f: Function) => methods.set(n, f),
    broadcastToSession: (_: string, _e: string, p: any) => events.push(structuredClone(p)) } as any, execute);
  return { events, call: (name: string, params: any, c = conn) => methods.get(name)!(c, params) };
}
const request = { id: "fixture-1", ownerSession: "web:test", message: "Read fixture.txt verbatim" };

test("archives an actual fixture file read, full request, tool result, model and timing", async () => {
  writeFileSync(join(dir, "fixture.txt"), "Unambiguous fixture value: 42");
  const g = gateway(async (_c, _t, observer) => {
    observer.started("fixture-model");
    observer.event({ type: "tool_use_start", tool_use_id: "read-1", name: "read_file", input: { path: "fixture.txt" } });
    const text = readFileSync(join(dir, "fixture.txt"), "utf8");
    observer.event({ type: "tool_result", tool_use_id: "read-1", name: "read_file", content: text });
    return { reply: text };
  });
  const task = await g.call("delegation.run", request);
  expect(task.status).toBe("completed");
  expect(task.result).toContain("42");
  expect(task.model).toBe("fixture-model");
  expect(task.firstOutputAt).toBeGreaterThanOrEqual(task.startedAt);
  expect(task.events.map((e: any) => e.type)).toEqual(["queued", "started", "agent.tool_use_start", "agent.tool_result", "completed"]);
  const reopened = gateway(async () => { throw new Error("Must not execute twice"); });
  expect((await reopened.call("delegation.run", request)).result).toBe(task.result);
  expect(reopened.call("delegation.list", { ownerSession: "web:test" }).tasks).toHaveLength(1);
});
test("provider errors remain failed even if the RPC returns", async () => {
  const g = gateway(async (_c, _t, observer) => {
    observer.started("fixture"); observer.event({ type: "error", content: "file unavailable" }); return { reply: "Could not read it" };
  });
  expect((await g.call("delegation.run", request)).status).toBe("failed");
});
test("does not deduplicate a different request or expose another session's task", async () => {
  const g = gateway(async () => ({ reply: "ok" }));
  await g.call("delegation.run", request);
  expect(() => g.call("delegation.run", { ...request, message: "Different work" })).toThrow("different request");
  expect(() => g.call("delegation.get", { ...request, ownerSession: "web:other" })).toThrow("not found");
  expect(() => g.call("delegation.get", request, { deviceTokenId: "owner-b", bindSession() {} })).toThrow("not found");
});
test("retries during execution share one operation", async () => {
  let finish!: () => void, runs = 0;
  const g = gateway(async () => { runs++; await new Promise<void>(r => finish = r); return { reply: "once" }; });
  const one = g.call("delegation.run", request), two = g.call("delegation.run", request);
  await new Promise(r => setTimeout(r, 0));
  finish();
  expect((await one).result).toBe((await two).result);
  expect(runs).toBe(1);
});

test("submit acknowledges immediately; a correction supersedes old results and preserves source words", async () => {
  let finish!: () => void;
  const g = gateway(async (_c, t, observer) => {
    observer.started("fixture");
    if (t.id === request.id) await new Promise<void>(r => finish = r);
    return { reply: t.request };
  });
  const accepted = g.call("delegation.submit", { ...request, originalRequest: "Read the whole file", constraints: "No summary" });
  expect(accepted.status).toBe("queued");
  await new Promise(r => setTimeout(r, 0));
  const next = g.call("delegation.revise", { ...request, revisionId: "corrected", message: "Read tomorrow.txt in full" });
  expect(next.originalRequest).toBe("Read the whole file");
  expect(next.brief).toContain("No summary");
  expect(g.call("delegation.get", request).validity).toBe("superseded");
  finish(); await new Promise(r => setTimeout(r, 0));
  expect(g.call("delegation.get", request).status).toBe("cancelled");
  expect(g.call("delegation.get", { ...request, id: "corrected" }).status).toBe("completed");
});

test("cancelled queued work never starts, while reconnect reads the same active task", async () => {
  let runs = 0;
  const g = gateway(async () => { runs++; return { reply: "done" }; });
  g.call("delegation.submit", request);
  g.call("delegation.cancel", request);
  await new Promise(r => setTimeout(r, 0));
  expect(runs).toBe(0);
  expect(g.call("delegation.get", request).status).toBe("cancelled");
});

test("a gateway restart marks unfinished work interrupted without repeating side effects", async () => {
  let finish!: () => void;
  const g = gateway(async () => { await new Promise<void>(r => finish = r); return { reply: "done" }; });
  g.call("delegation.submit", request); await new Promise(r => setTimeout(r, 0));
  const reopened = gateway(async () => { throw new Error("must not run"); });
  expect(reopened.call("delegation.get", request).status).toBe("interrupted");
  finish(); await new Promise(r => setTimeout(r, 0));
});

test("two independent readers run concurrently, a third queues, and out-of-order results keep identity", async () => {
  const finishes = new Map<string, () => void>(), started: string[] = [], completed: string[] = [];
  const g = gateway(async (_c, t, observer) => {
    observer.started("fixture"); started.push(t.id);
    await new Promise<void>(r => finishes.set(t.id, r)); completed.push(t.id);
    return { reply: `result-${t.id}` };
  });
  const run = (id: string) => g.call("delegation.run", { ...request, id, execution: "read_only" });
  const a = run("a"), b = run("b"), c = run("c");
  await new Promise(r => setTimeout(r, 0));
  expect(started).toEqual(["a", "b"]);
  finishes.get("b")!(); expect((await b).result).toBe("result-b");
  await new Promise(r => setTimeout(r, 0)); expect(started).toEqual(["a", "b", "c"]);
  finishes.get("a")!(); finishes.get("c")!(); await Promise.all([a, c]);
  expect(completed[0]).toBe("b");
  expect(g.call("delegation.get", { ...request, id: "a" }).result).toBe("result-a");
});

test("mutable tasks wait for readers and never overlap one another", async () => {
  const finishes = new Map<string, () => void>(), started: string[] = [];
  const g = gateway(async (_c, t) => { started.push(t.id); await new Promise<void>(r => finishes.set(t.id, r)); return { reply: "done" }; });
  const a = g.call("delegation.run", { ...request, id: "reader", execution: "read_only" });
  const b = g.call("delegation.run", { ...request, id: "writer" });
  const c = g.call("delegation.run", { ...request, id: "other-writer" });
  await new Promise(r => setTimeout(r, 0)); expect(started).toEqual(["reader"]);
  finishes.get("reader")!(); await a; await new Promise(r => setTimeout(r, 0)); expect(started).toEqual(["reader", "writer"]);
  finishes.get("writer")!(); await b; await new Promise(r => setTimeout(r, 0)); expect(started.at(-1)).toBe("other-writer");
  finishes.get("other-writer")!(); await c;
});

test("dependent work consumes the completed result and does not run after a failed dependency", async () => {
  const started: string[] = [];
  const g = gateway(async (_c, t) => { started.push(t.id); if (t.id === "bad") throw new Error("fixture failure"); return { reply: t.brief }; });
  await g.call("delegation.run", { ...request, id: "first", message: "evidence 123" });
  const next = await g.call("delegation.run", { ...request, id: "next", dependsOn: ["first"] });
  expect(next.result).toContain("Dependency first result"); expect(next.result).toContain("evidence 123");
  await g.call("delegation.run", { ...request, id: "bad" });
  const failed = await g.call("delegation.run", { ...request, id: "blocked", dependsOn: ["bad"] });
  expect(failed.status).toBe("failed"); expect(started).not.toContain("blocked");
});

test("external runtime choices retain their own conversation and serialize even read-only requests", async () => {
  const g = gateway(async (_c, t, observer) => {
    observer.started(undefined); observer.runtime?.({ sessionId: `cli-${t.runtime}`, model: t.runtime === "claude" ? "reported-model" : undefined });
    return { reply: t.backendSession };
  });
  const a = await g.call("delegation.run", { ...request, runtime: "codex", execution: "read_only" });
  expect(a.runtime).toBe("codex"); expect(a.model).toBeUndefined(); expect(a.runtimeSessionId).toBe("cli-codex");
  expect(a.backendSession).toBe("web:test-codex-bridge"); expect(a.readOnly).toBe(false);
  const b = await g.call("delegation.run", { ...request, id: "second", runtime: "claude", continueTask: a.id });
  expect(b.runtime).toBe("codex"); expect(b.backendSession).toBe(a.backendSession);
  const c = await g.call("delegation.run", { ...request, id: "claude", runtime: "claude" });
  expect(c.backendSession).not.toBe(a.backendSession); expect(c.model).toBe("reported-model");
  expect(() => g.call("delegation.submit", { ...request, id: "bad", runtime: "made-up" })).toThrow("Unknown backend runtime");
});

test("cancelling a dependent task settles before its prerequisite, without starting it", async () => {
  let finish!: () => void;
  const started: string[] = [];
  const g = gateway(async (_c, task) => { started.push(task.id); await new Promise<void>(r => finish = r); return { reply: "done" }; });
  const prerequisite = g.call("delegation.run", request);
  const dependent = g.call("delegation.run", { ...request, id: "dependent", dependsOn: [request.id] });
  await new Promise(r => setTimeout(r, 0));
  g.call("delegation.cancel", { ...request, id: "dependent" });
  expect((await dependent).status).toBe("cancelled"); expect(started).toEqual([request.id]);
  finish(); await prerequisite;
});

test("late generation completion cannot turn interrupted audio into delivered work", async () => {
  const g = gateway(async () => ({ reply: "answer" })); await g.call("delegation.run", request);
  const deliver = (state: string, responseId = "response-1") => g.call("delegation.delivery", { ...request, state, responseId });
  deliver("interrupted"); expect(deliver("generated").delivery).toBe("interrupted");
  expect(deliver("played").delivery).toBe("interrupted");
  expect(deliver("generated", "response-2").delivery).toBe("generated");
  expect(deliver("played", "response-2").delivery).toBe("played");
  expect(deliver("generated", "response-2").delivery).toBe("played");
  expect(g.call("delegation.get", request).status).toBe("completed");
});

test("streamed output is batched without losing text or event order", async () => {
  const g = gateway(async (_c, _t, observer) => {
    observer.started("fixture");
    for (let i = 0; i < 100; i++) observer.event({ type: "text", content: `word${i} ` });
    observer.event({ type: "tool_use_start", name: "read_file", tool_use_id: "read", input: {} });
    observer.event({ type: "text", content: "Final output", replace: true });
    return { reply: "Final output" };
  });
  const task = await g.call("delegation.run", request);
  expect(task.preview).toBe("Final output");
  expect(task.events.map((e: any) => e.type)).toEqual(["queued", "started", "agent.text", "agent.tool_use_start", "agent.text", "completed"]);
  expect(task.events[2].data.events).toHaveLength(100);
});
