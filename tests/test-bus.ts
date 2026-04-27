// =============================================================================
// Unit tests for the in-process bus (src/bus/index.ts).
// =============================================================================

import { describe, test, expect, beforeEach } from "bun:test";
import { getBus, resetBus } from "../src/bus/index.js";

beforeEach(() => {
  resetBus();
});

describe("bus — pattern matching", () => {
  test("exact topic delivery", () => {
    const bus = getBus();
    const received: string[] = [];
    bus.subscribe("asr.abc.final", (e: any) => received.push(e.text));
    bus.publish("asr.abc.final", { text: "hello" });
    bus.publish("asr.xyz.final", { text: "skip" });
    expect(received).toEqual(["hello"]);
  });

  test("single-level wildcard at middle", () => {
    const bus = getBus();
    const got: string[] = [];
    bus.subscribe("media.*.finalized", (_e, topic) => got.push(topic));
    bus.publish("media.c-1.finalized", {});
    bus.publish("media.c-2.finalized", {});
    bus.publish("media.c.1.finalized", {}); // two segments in middle → NO match
    expect(got.sort()).toEqual(["media.c-1.finalized", "media.c-2.finalized"]);
  });

  test("wildcard suffix matches one segment only", () => {
    const bus = getBus();
    const got: string[] = [];
    bus.subscribe("asr.*", (_e, topic) => got.push(topic));
    bus.publish("asr.partial", {});
    bus.publish("asr.abc", {});
    bus.publish("asr.a.b", {}); // multi-segment → NO match
    expect(got.sort()).toEqual(["asr.abc", "asr.partial"]);
  });
});

describe("bus — unsubscribe", () => {
  test("unsubscribe stops delivery", () => {
    const bus = getBus();
    const got: number[] = [];
    const un = bus.subscribe("x", () => got.push(1));
    bus.publish("x", {});
    un();
    bus.publish("x", {});
    expect(got).toEqual([1]);
  });
});

describe("bus — handler errors", () => {
  test("sync throw in one handler does not kill siblings", () => {
    const bus = getBus();
    const got: string[] = [];
    bus.subscribe("t", () => {
      throw new Error("boom");
    });
    bus.subscribe("t", () => got.push("still ran"));
    bus.publish("t", {});
    expect(got).toEqual(["still ran"]);
  });

  test("async rejection in one handler does not kill siblings", async () => {
    const bus = getBus();
    const got: string[] = [];
    bus.subscribe("t", async () => {
      throw new Error("async boom");
    });
    bus.subscribe("t", () => got.push("ok"));
    bus.publish("t", {});
    // async error is caught and logged; siblings already ran synchronously
    await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(["ok"]);
  });
});

describe("bus — multi-subscriber", () => {
  test("fan-out to all matching patterns", () => {
    const bus = getBus();
    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe("media.*.finalized", (_e, t) => a.push(t));
    bus.subscribe("media.xyz.finalized", (_e, t) => b.push(t));
    bus.publish("media.xyz.finalized", {});
    expect(a).toEqual(["media.xyz.finalized"]);
    expect(b).toEqual(["media.xyz.finalized"]);
  });
});
