import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RealtimeStartup } from "../src/lib/realtime-startup";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function harness(messages = [{ role: "user" as const, text: "The meeting is at three." }]) {
  const sent: any[] = [];
  const record = vi.fn();
  const ready = vi.fn();
  const failure = vi.fn();
  const detection = { type: "server_vad", create_response: true, interrupt_response: true };
  const startup = new RealtimeStartup({ session: { type: "realtime", instructions: "Hawk", tools: [], audio: { input: { turn_detection: detection } } },
    turnDetection: detection, messages, send: e => { sent.push(e); return true; }, record, onReady: ready, onFailure: failure });
  startup.start();
  const configure = () => startup.observe({ type: "session.updated", session: sent[0].session });
  const activate = () => startup.observe({ type: "session.updated", session: sent.at(-1).session });
  return { startup, sent, record, ready, failure, configure, activate };
}

it.each(["conversation.item.added", "conversation.item.created"])("waits for configuration, matching %s receipts, and final activation", type => {
  const h = harness();
  expect(h.sent).toHaveLength(1);
  expect(h.sent[0].session.audio.input.turn_detection).toBeNull();
  h.configure();
  const item = h.sent[1].item;
  expect(item.content[0].text).toBe("The meeting is at three.");
  h.startup.observe({ type, item: { id: "unrelated-item" } });
  expect(h.sent).toHaveLength(2);
  h.startup.observe({ type, item });
  h.startup.observe({ type, item }); // duplicate cannot release twice
  expect(h.sent).toHaveLength(3);
  expect(h.ready).not.toHaveBeenCalled();
  h.configure(); // old config acknowledgement must not count as activation
  expect(h.ready).not.toHaveBeenCalled();
  h.activate();
  expect(h.ready).toHaveBeenCalledOnce();
  expect(h.sent.some(e => e.type === "response.create")).toBe(false);
  expect(h.record.mock.calls.filter(c => c[0] === "context.restored")).toHaveLength(1);
});

it("waits for every item even when receipts arrive out of order", () => {
  const h = harness([{ role: "user", text: "One" }, { role: "user", text: "Two" }]);
  h.configure();
  h.startup.observe({ type: "conversation.item.added", item: h.sent[2].item });
  expect(h.sent).toHaveLength(3);
  h.startup.observe({ type: "conversation.item.added", item: h.sent[1].item });
  expect(h.sent).toHaveLength(4);
  h.activate();
  expect(h.ready).toHaveBeenCalledOnce();
});

it("handles a new conversation without requesting an opening response", () => {
  const h = harness([]);
  h.configure(); h.activate();
  expect(h.ready).toHaveBeenCalledOnce();
  expect(h.sent.every(e => e.type === "session.update")).toBe(true);
});

it("records rejection without claiming successful restoration", () => {
  const h = harness(); h.configure();
  h.startup.observe({ type: "error", error: { message: "invalid item" } });
  h.activate();
  expect(h.failure).toHaveBeenCalledWith(expect.stringContaining("invalid item"));
  expect(h.ready).not.toHaveBeenCalled();
  expect(h.record.mock.calls.some(c => c[0] === "context.restored")).toBe(false);
});

it.each(["configuration", "items", "activation"])("times out waiting for %s and ignores late receipts", stage => {
  const h = harness();
  if (stage !== "configuration") h.configure();
  if (stage === "activation") h.startup.observe({ type: "conversation.item.added", item: h.sent[1].item });
  vi.advanceTimersByTime(10_000);
  h.activate();
  expect(h.failure).toHaveBeenCalledOnce();
  expect(h.failure).toHaveBeenCalledWith(expect.stringContaining("Tap Start to retry"));
  expect(h.ready).not.toHaveBeenCalled();
});

it("cancelling prevents a late timeout or acknowledgement from activating", () => {
  const h = harness(); h.startup.cancel(); h.configure();
  vi.advanceTimersByTime(10_000);
  expect(h.ready).not.toHaveBeenCalled();
  expect(h.failure).not.toHaveBeenCalled();
  expect(h.sent).toHaveLength(1);
});

it.each([false, true])("a failed transport send fails startup promptly (throws=%s)", throws => {
  const failure = vi.fn();
  const ready = vi.fn();
  const startup = new RealtimeStartup({ session: {}, turnDetection: null, messages: [],
    send: () => { if (throws) throw new Error("channel closed"); return false; }, record: vi.fn(), onReady: ready, onFailure: failure });
  startup.start();
  vi.advanceTimersByTime(10_000);
  expect(failure).toHaveBeenCalledOnce();
  expect(ready).not.toHaveBeenCalled();
});

it("preserves manual turn detection without enabling automatic speech", () => {
  const sent: any[] = [];
  const ready = vi.fn();
  const startup = new RealtimeStartup({ session: {}, turnDetection: null, messages: [],
    send: event => { sent.push(event); return true; }, record: vi.fn(), onReady: ready, onFailure: vi.fn() });
  startup.start();
  startup.observe({ type: "session.updated", session: sent[0].session });
  expect(ready).not.toHaveBeenCalled();
  startup.observe({ type: "session.updated", session: sent[1].session });
  expect(ready).toHaveBeenCalledOnce();
  expect(sent[1].session.audio.input.turn_detection).toBeNull();
});
