import { test, expect } from "bun:test";
import { GptLiveCoordinator, liveSnippet, type LiveTaskPort } from "../src/live/gpt-live-coordinator.js";
import { GptLiveTranscript } from "../src/live/gpt-live-transcript.js";
import { gptLiveConfig } from "../src/gateway/gpt-live-methods.js";
import type { DelegationTask } from "../src/gateway/delegation-types.js";
import type { LiveRoute, RoutingSnapshot } from "../src/live/gpt-live-router.js";
const task = (id: string, status: DelegationTask["status"] = "running"): DelegationTask => ({ id, ownerSession: "web:test", backendSession: `work:${id}`, request: `Read ${id}`, runtime: "native", status, createdAt: 1, events: [], validity: "current", delivery: "pending" });
function fixture(route: (snapshot: RoutingSnapshot) => Promise<LiveRoute>, existing: DelegationTask[] = []) {
  const sent: any[] = [], persisted: any[] = [], errors: string[] = [], injected: string[] = [], submitted: any[] = [];
  const all = new Map(existing.map(t => [t.id, t]));
  const port: LiveTaskPort = {
    list: () => [...all.values()],
    submit: p => { submitted.push(p); const t = { ...task(String(p.id)), request: String(p.message) }; all.set(t.id, t); return t; },
    cancel: id => { const t = all.get(id)!; t.status = "cancelling"; return t; },
    revise: (id, message, next) => { all.get(id)!.validity = "superseded"; const t = { ...task(next), request: message }; all.set(next, t); return t; },
    injected: (id) => injected.push(id),
  };
  const coordinator = new GptLiveCoordinator({ id: "live_fixture", runtime: "codex", history: [{ role: "user", text: "Use folder A" }], bridge: true,
    tasks: port, send: e => sent.push(e), persist: c => persisted.push(c), error: e => errors.push(e), route });
  return { coordinator, sent, persisted, errors, injected, submitted, all };
}
const submit = (request: string) => ({ action: "submit" as const, request, taskId: "", readOnly: true });

test("timestamp fragments retain split words, spaces and repeats, deduplicate IDs only", () => {
  const saved: any[] = [], changed: any[] = [];
  const t = new GptLiveTranscript("live", c => changed.push(c), c => saved.push(c));
  const a = { type: "session.input_transcript.delta", event_id: "a", delta: "Go ", start_ms: 10, end_ms: 100 };
  t.accept(a); t.accept(a);
  t.accept({ ...a, event_id: "b", delta: "go go", start_ms: 100, end_ms: 200 });
  t.accept({ ...a, event_id: "c", type: "session.output_transcript.delta", delta: "Yes", start_ms: 80, end_ms: 150 });
  t.flush(); t.flush();
  expect(saved.map(c => c.text)).toEqual(["Go go go", "Yes"]);
  expect(t.snapshot().map(c => c.role)).toEqual(["user", "assistant"]);
  t.accept({ ...a, event_id: "d", delta: " again", start_ms: 210, end_ms: 300 }); t.flush();
  expect(saved.at(-1).text).toBe(" again");
  expect(changed.at(-1).id).not.toBe(changed[0].id);
});

test("new connection uses protocol input, client delegation, and a bounded explicit voice", () => {
  const config = gptLiveConfig({ model: "gpt-live-1", voice: "unsupported", instructions: "Wait", history: [{ role: "assistant", text: "turquoise" }] });
  expect(config.delegation).toEqual({ type: "client" });
  expect(config.input[0].content[0]).toEqual({ type: "output_text", text: "turquoise" });
  expect(config.audio.output.voice).toBe("marin");
  expect(() => gptLiveConfig({ model: "other", history: [] })).toThrow();
});

test("restore and pre-speech completion remain quiet; injection ack is not playback", async () => {
  const f = fixture(async () => ({ actions: [], clarification: "" }), [task("a", "completed")]);
  f.coordinator.restore();
  expect(f.sent.every(e => e.type === "session.thinking.append")).toBe(true);
  f.coordinator.update(task("b", "completed")); expect(f.sent).toHaveLength(1);
  await f.coordinator.typed("Is it done?");
  // typed evidence is a new interaction; no completion is claimed as played.
  f.coordinator.update(task("c", "completed"));
  const last = f.sent.at(-1); expect(last.type).toBe("session.commentary.append");
  f.coordinator.observe({ type: "session.commentary.appended", client_event_id: last.event_id });
  expect(f.injected).toEqual(["c"]);
  f.coordinator.close();
});

test("two requested tasks preserve runtime, context and separate IDs; out of order results inject once", async () => {
  const f = fixture(async () => ({ actions: [submit("Read A"), submit("Read B")], clarification: "" }));
  await f.coordinator.typed("Read A and B separately");
  expect(f.submitted).toHaveLength(2); expect(f.submitted[0].id).not.toBe(f.submitted[1].id);
  expect(f.submitted[0].runtime).toBe("codex"); expect(f.submitted[0].context[0].text).toBe("Use folder A");
  for (const t of [...f.all.values()].reverse()) { t.status = "completed"; f.coordinator.update(t); f.coordinator.update(t); }
  expect(f.sent.filter(e => e.type === "session.commentary.append")).toHaveLength(2);
  f.coordinator.close();
});

test("late user correction during routing discards the stale plan", async () => {
  let release!: (p: LiveRoute) => void, calls = 0;
  const f = fixture(async () => ++calls === 1 ? new Promise(r => release = r) : { actions: [submit("Read B")], clarification: "" });
  const pending = f.coordinator.typed("Read A");
  f.coordinator.observe({ type: "session.input_transcript.delta", event_id: "correction", delta: "Actually B", start_ms: 500, end_ms: 900 });
  release({ actions: [submit("Read A")], clarification: "" }); await pending;
  expect(f.submitted.map(t => t.message)).toEqual(["Read B"]); f.coordinator.close();
});

test("correction supersedes old task and suppresses its result; cancel never means completed", async () => {
  const f = fixture(async () => ({ actions: [{ action: "revise", taskId: "a", request: "Read B", readOnly: true }], clarification: "" }), [task("a")]);
  await f.coordinator.typed("Actually read B");
  f.coordinator.update({ ...f.all.get("a")!, status: "completed", result: "obsolete" });
  expect(f.sent.some(e => e.type === "session.commentary.append" && e.content.includes("obsolete"))).toBe(false);
  expect(f.all.get("a")?.validity).toBe("superseded"); f.coordinator.close();
  const c = fixture(async () => ({ actions: [{ action: "cancel", taskId: "a", request: "", readOnly: false }], clarification: "" }), [task("a")]);
  await c.coordinator.typed("Cancel that task");
  expect(c.all.get("a")?.status).toBe("cancelling"); expect(c.sent.at(-1).content).toContain("cancelling"); c.coordinator.close();
});

test("disconnect aborts routing but preserves task execution and flushes captured evidence", async () => {
  let release!: (p: LiveRoute) => void;
  const f = fixture(async () => new Promise(r => release = r), [task("a")]);
  const pending = f.coordinator.typed("Read B"); f.coordinator.close();
  release({ actions: [submit("Read B")], clarification: "" }); await pending;
  expect(f.submitted).toHaveLength(0); expect(f.all.get("a")?.status).toBe("running"); expect(f.persisted).toHaveLength(1);
});

test("validate every target before mutating anything; errors are visible", async () => {
  const f = fixture(async () => ({ actions: [submit("Read A"), { action: "cancel", taskId: "foreign", request: "", readOnly: false }], clarification: "" }));
  await f.coordinator.typed("Read A and cancel that"); expect(f.submitted).toHaveLength(0); expect(f.errors).toHaveLength(1); f.coordinator.close();
});

test("spoken context respects the protocol budget even for Unicode and large backend output", () => {
  expect(new TextEncoder().encode(liveSnippet("记忆🙂".repeat(2000), 480)).length).toBeLessThan(500);
});
