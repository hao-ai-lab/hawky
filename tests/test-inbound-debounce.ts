import { describe, test, expect } from "bun:test";
import { createInboundDebouncer } from "../src/gateway/inbound-debounce.js";

interface TestMessage {
  sender: string;
  conversation: string;
  text: string;
}

describe("createInboundDebouncer", () => {
  test("single message flushes after debounce delay", async () => {
    const flushed: TestMessage[][] = [];

    const debouncer = createInboundDebouncer<TestMessage>({
      debounceMs: 50,
      buildKey: (m) => `${m.sender}:${m.conversation}`,
      onFlush: async (items) => { flushed.push(items); },
    });

    debouncer.push({ sender: "u1", conversation: "c1", text: "hello" });

    // Not flushed yet
    expect(flushed.length).toBe(0);

    // Wait for debounce
    await Bun.sleep(80);

    expect(flushed.length).toBe(1);
    expect(flushed[0].length).toBe(1);
    expect(flushed[0][0].text).toBe("hello");

    await debouncer.stop();
  });

  test("rapid messages with same key are coalesced", async () => {
    const flushed: TestMessage[][] = [];

    const debouncer = createInboundDebouncer<TestMessage>({
      debounceMs: 100,
      buildKey: (m) => `${m.sender}:${m.conversation}`,
      onFlush: async (items) => { flushed.push(items); },
    });

    debouncer.push({ sender: "u1", conversation: "c1", text: "hey" });
    debouncer.push({ sender: "u1", conversation: "c1", text: "can you" });
    debouncer.push({ sender: "u1", conversation: "c1", text: "check emails" });

    await Bun.sleep(150);

    expect(flushed.length).toBe(1);
    expect(flushed[0].length).toBe(3);
    expect(flushed[0].map(m => m.text)).toEqual(["hey", "can you", "check emails"]);

    await debouncer.stop();
  });

  test("different keys flush independently", async () => {
    const flushed: TestMessage[][] = [];

    const debouncer = createInboundDebouncer<TestMessage>({
      debounceMs: 50,
      buildKey: (m) => `${m.sender}:${m.conversation}`,
      onFlush: async (items) => { flushed.push(items); },
    });

    debouncer.push({ sender: "u1", conversation: "c1", text: "from u1" });
    debouncer.push({ sender: "u2", conversation: "c1", text: "from u2" });

    await Bun.sleep(80);

    expect(flushed.length).toBe(2);
    expect(flushed[0].length).toBe(1);
    expect(flushed[1].length).toBe(1);

    await debouncer.stop();
  });

  test("timer resets on each new message in the group", async () => {
    const flushed: TestMessage[][] = [];

    const debouncer = createInboundDebouncer<TestMessage>({
      debounceMs: 100,
      buildKey: (m) => m.conversation,
      onFlush: async (items) => { flushed.push(items); },
    });

    debouncer.push({ sender: "u1", conversation: "c1", text: "first" });
    await Bun.sleep(60);

    // Timer should reset — not flushed yet
    debouncer.push({ sender: "u1", conversation: "c1", text: "second" });
    await Bun.sleep(60);

    // First timer would have fired at 100ms, but it was reset
    expect(flushed.length).toBe(0);

    // Now wait for the reset timer
    await Bun.sleep(60);

    expect(flushed.length).toBe(1);
    expect(flushed[0].length).toBe(2);

    await debouncer.stop();
  });

  test("null key bypasses debouncing — flushes immediately", async () => {
    const flushed: TestMessage[][] = [];

    const debouncer = createInboundDebouncer<TestMessage>({
      debounceMs: 200,
      buildKey: () => null, // always bypass
      onFlush: async (items) => { flushed.push(items); },
    });

    debouncer.push({ sender: "u1", conversation: "c1", text: "immediate" });

    // Should flush immediately (async, give it a tick)
    await Bun.sleep(10);

    expect(flushed.length).toBe(1);
    expect(flushed[0].length).toBe(1);

    await debouncer.stop();
  });

  test("stop() flushes all pending groups", async () => {
    const flushed: TestMessage[][] = [];

    const debouncer = createInboundDebouncer<TestMessage>({
      debounceMs: 5000, // very long — won't fire naturally
      buildKey: (m) => m.conversation,
      onFlush: async (items) => { flushed.push(items); },
    });

    debouncer.push({ sender: "u1", conversation: "c1", text: "pending1" });
    debouncer.push({ sender: "u2", conversation: "c2", text: "pending2" });

    expect(flushed.length).toBe(0);

    await debouncer.stop();

    expect(flushed.length).toBe(2);
  });

  test("push after stop is ignored", async () => {
    const flushed: TestMessage[][] = [];

    const debouncer = createInboundDebouncer<TestMessage>({
      debounceMs: 50,
      buildKey: (m) => m.conversation,
      onFlush: async (items) => { flushed.push(items); },
    });

    await debouncer.stop();
    debouncer.push({ sender: "u1", conversation: "c1", text: "ignored" });

    await Bun.sleep(80);
    expect(flushed.length).toBe(0);
  });

  test("onError is called on flush failure", async () => {
    const errors: { err: unknown; items: TestMessage[] }[] = [];

    const debouncer = createInboundDebouncer<TestMessage>({
      debounceMs: 50,
      buildKey: (m) => m.conversation,
      onFlush: async () => { throw new Error("flush failed"); },
      onError: (err, items) => { errors.push({ err, items }); },
    });

    debouncer.push({ sender: "u1", conversation: "c1", text: "will fail" });

    await Bun.sleep(80);

    expect(errors.length).toBe(1);
    expect((errors[0].err as Error).message).toBe("flush failed");

    await debouncer.stop();
  });

  test("maxTrackedKeys evicts oldest group when exceeded", async () => {
    const flushed: TestMessage[][] = [];

    const debouncer = createInboundDebouncer<TestMessage>({
      debounceMs: 5000,
      buildKey: (m) => m.conversation,
      onFlush: async (items) => { flushed.push(items); },
      maxTrackedKeys: 2,
    });

    debouncer.push({ sender: "u1", conversation: "c1", text: "first" });
    debouncer.push({ sender: "u1", conversation: "c2", text: "second" });

    // No flush yet — both within limit
    expect(flushed.length).toBe(0);

    // Third key should evict c1 (oldest)
    debouncer.push({ sender: "u1", conversation: "c3", text: "third" });

    await Bun.sleep(10);

    expect(flushed.length).toBe(1);
    expect(flushed[0][0].text).toBe("first");

    await debouncer.stop();
  });
});
