// =============================================================================
// E2E Tests — Where Reminder Pipeline (#481)
//
// Full end-to-end test of the "where reminder" chain, in-process, with NO real
// phone and NO network. A real Bun WebSocket client stands in for the iOS device
// and drives the production gateway + IntentionService wiring end to end:
//
//   "remind me to buy milk at Trader Joe's"
//     → intention.create RPC                          (gateway)
//     → buildObviousIntention + precision gate         (create-intention)
//     → store.create (pending_arm) + armIntention      (WhereAdapter.prepare)
//     → emitRegions → broadcast agent.regions.update   (gateway → device)
//   [device] geocodes + starts CoreLocation monitoring (simulated)
//     → region.armed { ok: true } RPC                  (device → gateway)
//     → WhereAdapter.resolveAck → intention "armed"    (create RPC resolves)
//   [device] CLLocationManager didEnterRegion          (simulated)
//     → region.entered RPC                             (device → gateway)
//     → fireIntention → broadcast agent.intention_surface into the session
//
// This is the automated mirror of scripts/probe-where-e2e.ts (which needs a live
// gateway over Tailscale). Here we spin the whole thing up in one process so CI
// exercises the link without a device.
//
// Run with: bun test --timeout 30000 --max-concurrency=1 ./tests/e2e-where-reminder.ts
// =============================================================================

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { GatewayServer, resetGatewayState } from "../src/gateway/server.js";
import { registerAgentMethods } from "../src/gateway/agent-methods.js";
import { IntentionService } from "../src/ambient/intention-service.js";
import type { RegionDescriptor } from "../src/ambient/arm-where.js";
import type { ResponseFrame, EventFrame } from "../src/gateway/protocol.js";
import type { HawkyConfig } from "../src/agent/types.js";
import { setSessionsDir, resetSessionsDir } from "../src/storage/session.js";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function getTestPort(): number {
  return 10000 + Math.floor(Math.random() * 50000);
}

function makeConfig(overrides?: Partial<HawkyConfig>): HawkyConfig {
  return {
    api_keys: { anthropic: "mock", brave_search: "", openai: "" },
    api_base_url: "https://api.anthropic.com",
    model: "mock-model",
    max_tokens: 1024,
    max_iterations: 10,
    max_tool_result_chars: 30000,
    workspace_dir: "/tmp",
    gateway_port: 4242,
    heartbeat: {
      enabled: false,
      interval_minutes: 30,
      keep_recent_messages: 8,
      active_hours: { start: "08:00", end: "22:00" },
    },
    ...overrides,
  } as HawkyConfig;
}

async function sendRequest(ws: WebSocket, method: string, params?: unknown): Promise<ResponseFrame> {
  const id = `req-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout: ${method}`)), 10000);
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "res" && data.id === id) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(data);
      }
    };
    ws.addEventListener("message", handler);
  });
}

async function connectAndHandshake(port: number, sessionKey: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("connect failed")));
    setTimeout(() => reject(new Error("connect timeout")), 3000);
  });
  const res = await sendRequest(ws, "connect", { version: "e2e-where", platform: "ios-sim", sessionKey });
  if (!res.ok) throw new Error(`Handshake failed: ${res.error?.message}`);
  await sendRequest(ws, "session.resolve", { sessionKey });
  return ws;
}

/**
 * #485: connect WITHOUT binding a session (no sessionKey in connect). The
 * connection is authenticated but unbound — used to test that region RPCs reject it.
 */
async function connectUnbound(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://localhost:${port}`);
  await new Promise<void>((resolve, reject) => {
    ws.addEventListener("open", () => resolve());
    ws.addEventListener("error", () => reject(new Error("connect failed")));
    setTimeout(() => reject(new Error("connect timeout")), 3000);
  });
  const res = await sendRequest(ws, "connect", { version: "e2e-where", platform: "ios-sim" });
  if (!res.ok) throw new Error(`Handshake failed: ${res.error?.message}`);
  return ws;
}

/** Wait for a specific broadcast event by name (default channel), returning its frame. */
async function waitForEvent(ws: WebSocket, eventName: string, timeoutMs = 8000): Promise<EventFrame> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timeout waiting for ${eventName}`)), timeoutMs);
    const handler = (event: MessageEvent) => {
      const data = JSON.parse(event.data as string);
      if (data.type === "event" && data.event === eventName) {
        clearTimeout(timeout);
        ws.removeEventListener("message", handler);
        resolve(data);
      }
    };
    ws.addEventListener("message", handler);
  });
}

// -----------------------------------------------------------------------------
// Test wiring — mirrors src/index.ts gateway setup for the ambient where path.
// -----------------------------------------------------------------------------

let server: GatewayServer;
let intentionLoop: IntentionService;
let port: number;
let testSessionsDir: string;
let prevAmbient: string | undefined;
let prevWhere: string | undefined;

beforeEach(() => {
  // The region RPCs and intention.create are flag-gated on these env vars
  // (same gates as production). The default-on flip for AMBIENT_WHERE lives in
  // src/index.ts main(), which this test does not call — so set them explicitly.
  prevAmbient = process.env.AMBIENT_INTENTIONS;
  prevWhere = process.env.AMBIENT_WHERE;
  process.env.AMBIENT_INTENTIONS = "1";
  process.env.AMBIENT_WHERE = "1";

  testSessionsDir = join(tmpdir(), `hawky-e2e-where-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testSessionsDir, { recursive: true });
  setSessionsDir(testSessionsDir);
  resetGatewayState();
  server = new GatewayServer();
  port = getTestPort();

  // emitRegions wired to the gateway broadcast exactly as src/index.ts does.
  intentionLoop = new IntentionService({
    broadcast: (k, e, pl) => server.broadcastToSession(k, e, pl),
    hasSession: (k) => [...server.getConnections().values()].some((c) => c.sessionKey === k),
    whereDeps: {
      emitRegions: (sessionKey: string, regions: RegionDescriptor[]) => {
        server.broadcastToSession(sessionKey, "agent.regions.update", { type: "regions.update", regions });
      },
      // Arm timeout: long enough that a prompt device ack (happy path) lands well
      // before it over a real WS round-trip, but short enough that the "device
      // takes too long to ack" (deferred) path is exercised without a 10s wait.
      // Production default is 10s (matches the log in #481).
      timeoutMs: 1500,
    },
  });
  intentionLoop.start();

  registerAgentMethods(server, undefined as never, makeConfig(), undefined, intentionLoop, undefined);
  server.start(port);
});

afterEach(async () => {
  intentionLoop.stop();
  await server.stop(2000);
  resetGatewayState();
  resetSessionsDir();
  try { rmSync(testSessionsDir, { recursive: true, force: true }); } catch {}
  if (prevAmbient === undefined) delete process.env.AMBIENT_INTENTIONS; else process.env.AMBIENT_INTENTIONS = prevAmbient;
  if (prevWhere === undefined) delete process.env.AMBIENT_WHERE; else process.env.AMBIENT_WHERE = prevWhere;
});

// =============================================================================
// Tests
// =============================================================================

describe("E2E: where reminder — 'remind me to buy milk at Trader Joe's'", () => {
  test("arms via device ack and fires on region entry", async () => {
    const sessionKey = "e2e:where:buy-milk";
    const device = await connectAndHandshake(port, sessionKey);

    // Start listening for the regions.update event BEFORE create, since the
    // gateway blocks the create on the arm and emits the region synchronously.
    const regionsP = waitForEvent(device, "agent.regions.update");

    // Step 1: the user's natural-language reminder, parsed by the realtime model
    // into structured slots { content, where } and sent via intention.create.
    const createP = sendRequest(device, "intention.create", {
      sessionKey,
      content: "buy milk",
      where: "Trader Joe's",
    });

    // Step 2: the gateway emits a region descriptor for the device to arm.
    const regionsEvent = await regionsP;
    const payload = regionsEvent.payload as { type: string; regions: RegionDescriptor[] };
    expect(payload.type).toBe("regions.update");
    expect(payload.regions.length).toBe(1);
    const region = payload.regions[0]!;
    expect(region.place).toBe("Trader Joe's");
    expect(typeof region.intentionId).toBe("string");
    expect(region.intentionId.length).toBeGreaterThan(0);
    // #615: the descriptor must carry the intention content so the device's
    // region-entry notification can show the reminder ("buy milk"), not just
    // a generic "You've arrived".
    expect(region.content).toBe("buy milk");

    // Step 3: device geocodes + starts CoreLocation monitoring (simulated) and
    // acks success. resolveAck unblocks the arm; create should resolve "armed".
    const armedAck = await sendRequest(device, "region.armed", {
      intentionId: region.intentionId,
      ok: true,
      sessionKey,
    });
    expect(armedAck.ok).toBe(true);

    const created = await createP;
    expect(created.ok).toBe(true);
    expect((created.payload as { state: string }).state).toBe("armed");

    // Step 4: user walks into the store — CLLocationManager fires didEnterRegion,
    // the device reports region.entered, and the intention surfaces in-session.
    const surfaceP = waitForEvent(device, "agent.intention_surface");
    const entered = await sendRequest(device, "region.entered", {
      intentionId: region.intentionId,
      sessionKey,
    });
    expect(entered.ok).toBe(true);
    expect((entered.payload as { ok: boolean }).ok).toBe(true);

    const surface = await surfaceP;
    const sp = surface.payload as { type: string; body?: string; intentionId?: string };
    expect(sp.type).toBe("intention_surface");
    expect(sp.body).toContain("buy milk");

    // The store should reflect a terminal/surfaced state after firing.
    const stored = await intentionLoop.store.get(region.intentionId);
    expect(stored).not.toBeNull();
    expect(stored!.state).toBe("surfaced");

    device.close();
  });

  test("a failed device geocode (region.armed ok:false) fails the arm", async () => {
    const sessionKey = "e2e:where:arm-fail";
    const device = await connectAndHandshake(port, sessionKey);

    const regionsP = waitForEvent(device, "agent.regions.update");
    const createP = sendRequest(device, "intention.create", {
      sessionKey,
      content: "buy milk",
      where: "Trader Joe's",
    });

    const regionsEvent = await regionsP;
    const region = (regionsEvent.payload as { regions: RegionDescriptor[] }).regions[0]!;

    // Device could not geocode / could not start monitoring → ok:false.
    await sendRequest(device, "region.armed", {
      intentionId: region.intentionId,
      ok: false,
      reason: "geocode_failed",
      sessionKey,
    });

    const created = await createP;
    expect(created.ok).toBe(true);
    expect((created.payload as { state: string }).state).toBe("arm_failed");

    device.close();
  });

  // ---------------------------------------------------------------------------
  // #481 regression — reproduces the failure in the user's session log:
  //   create_intention {where:"Trader Joe's"} → arm hit the 10s device-ack
  //   timeout → state "arm_failed" (terminal) → "I couldn't arm that location
  //   reminder". Root cause: a hard where-region needs "Always" location auth,
  //   which the user can't grant within the arm timeout (multi-step OS prompt),
  //   so the device defers its ack — but the gateway had already buried the
  //   intention in terminal arm_failed, and the post-Always replay ack could not
  //   recover it. The fix makes device_ack_timeout RECOVERABLE: the intention
  //   stays pending_arm and a LATE region.armed ok:true arms it.
  // ---------------------------------------------------------------------------
  test("slow device ack (awaiting Always auth) → deferred pending_arm → LATE ack arms + fires", async () => {
    const sessionKey = "e2e:where:deferred-recover";
    const device = await connectAndHandshake(port, sessionKey);

    const regionsP = waitForEvent(device, "agent.regions.update");
    // Intentionally do NOT ack within the (short, 400ms) arm timeout — this is
    // the device waiting on the user to grant "Always" location authorization.
    const createP = sendRequest(device, "intention.create", {
      sessionKey,
      content: "buy milk",
      where: "Trader Joe's",
    });

    const regionsEvent = await regionsP;
    const region = (regionsEvent.payload as { regions: RegionDescriptor[] }).regions[0]!;
    expect(region.place).toBe("Trader Joe's");

    // create resolves once the arm times out. With the fix it is NOT arm_failed —
    // it is pending_arm (recoverable), so the model tells the user it's being set
    // up rather than that it failed (the bug surfaced as "I couldn't arm that").
    const created = await createP;
    expect(created.ok).toBe(true);
    expect((created.payload as { state: string }).state).toBe("pending_arm");

    // Confirm the store kept it recoverable, not terminal.
    let stored = await intentionLoop.store.get(region.intentionId);
    expect(stored!.state).toBe("pending_arm");

    // The user finishes granting Always; the device replays region.armed ok:true.
    // This LATE ack must now arm the (still pending_arm) intention.
    const lateAck = await sendRequest(device, "region.armed", {
      intentionId: region.intentionId,
      ok: true,
      sessionKey,
    });
    expect(lateAck.ok).toBe(true);

    stored = await intentionLoop.store.get(region.intentionId);
    expect(stored!.state).toBe("armed");

    // And it fires normally on region entry — the whole point of the reminder.
    const surfaceP = waitForEvent(device, "agent.intention_surface");
    const entered = await sendRequest(device, "region.entered", {
      intentionId: region.intentionId,
      sessionKey,
    });
    expect((entered.payload as { ok: boolean }).ok).toBe(true);

    const surface = await surfaceP;
    expect((surface.payload as { body?: string }).body).toContain("buy milk");

    stored = await intentionLoop.store.get(region.intentionId);
    expect(stored!.state).toBe("surfaced");

    device.close();
  });
});

// ---------------------------------------------------------------------------
// #485 — region reporting RPCs must require a bound session that OWNS the
// intention. Previously the ownership check was guarded by `if (conn.sessionKey
// && …)`, so an authenticated-but-unbound connection skipped it entirely and
// could ack/fire region events for arbitrary (guessable, e.g. "intention_1")
// IDs. These tests lock in the fix: unbound → FORBIDDEN, cross-session → FORBIDDEN.
// ---------------------------------------------------------------------------
describe("E2E: region RPCs require bound-session ownership (#485)", () => {
  // Helper: create an armed-ish where intention in `sessionKey` and return its id.
  async function createWhereIntention(sessionKey: string): Promise<string> {
    const device = await connectAndHandshake(port, sessionKey);
    const regionsP = waitForEvent(device, "agent.regions.update");
    const createP = sendRequest(device, "intention.create", {
      sessionKey, content: "buy milk", where: "Trader Joe's",
    });
    const regionsEvent = await regionsP;
    const region = (regionsEvent.payload as { regions: RegionDescriptor[] }).regions[0]!;
    await createP; // let the create settle (pending_arm after the short timeout)
    device.close();
    return region.intentionId;
  }

  test("region.armed from an UNBOUND connection is rejected (FORBIDDEN)", async () => {
    const intentionId = await createWhereIntention("e2e:where:owner-a");
    const attacker = await connectUnbound(port);
    const res = await sendRequest(attacker, "region.armed", { intentionId, ok: true });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("FORBIDDEN");
    expect(res.error?.message ?? "").toContain("Unbound connection");
    attacker.close();
  });

  test("region.entered from an UNBOUND connection is rejected (FORBIDDEN)", async () => {
    const intentionId = await createWhereIntention("e2e:where:owner-b");
    const attacker = await connectUnbound(port);
    const res = await sendRequest(attacker, "region.entered", { intentionId });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("FORBIDDEN");
    expect(res.error?.message ?? "").toContain("Unbound connection");
    attacker.close();
  });

  test("region.armed from a DIFFERENT bound session is rejected (cross-session mismatch)", async () => {
    const intentionId = await createWhereIntention("e2e:where:owner-c");
    // A connection bound to a different session must not ack owner-c's intention.
    const other = await connectAndHandshake(port, "e2e:where:other-session");
    const res = await sendRequest(other, "region.armed", {
      intentionId, ok: true, sessionKey: "e2e:where:other-session",
    });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("FORBIDDEN");
    expect(res.error?.message ?? "").toContain("Session mismatch");
    other.close();
  });

  test("region.entered from a DIFFERENT bound session is rejected (cross-session mismatch)", async () => {
    const intentionId = await createWhereIntention("e2e:where:owner-d");
    const other = await connectAndHandshake(port, "e2e:where:other-session-2");
    const res = await sendRequest(other, "region.entered", { intentionId });
    expect(res.ok).toBe(false);
    expect(res.error?.code).toBe("FORBIDDEN");
    expect(res.error?.message ?? "").toContain("Session mismatch");
    other.close();
  });
});
