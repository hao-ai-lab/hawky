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
  await expect(g.call("delegation.run", { ...request, message: "Different work" })).rejects.toThrow("different request");
  expect(() => g.call("delegation.get", { ...request, ownerSession: "web:other" })).toThrow("not found");
  expect(() => g.call("delegation.get", request, { deviceTokenId: "owner-b", bindSession() {} })).toThrow("not found");
});
test("retries during execution share one operation", async () => {
  let finish!: () => void, runs = 0;
  const g = gateway(async () => { runs++; await new Promise<void>(r => finish = r); return { reply: "once" }; });
  const one = g.call("delegation.run", request), two = g.call("delegation.run", request);
  finish();
  expect((await one).result).toBe((await two).result);
  expect(runs).toBe(1);
});
