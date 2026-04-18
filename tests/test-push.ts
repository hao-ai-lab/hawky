// =============================================================================
// Tests: Push Notification Service
//
// Unit tests for VAPID key management, subscription storage, push delivery,
// and delivery system integration. No real push endpoints — all mocked.
// =============================================================================

import { test, describe, expect, beforeEach, afterAll, mock } from "bun:test";
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  loadOrGenerateVapidKeys,
  readVapidKeys,
  loadSubscriptions,
  saveSubscriptions,
  addSubscription,
  removeSubscription,
  createPushService,
  setPushPaths,
  resetPushPaths,
  type PushSubscriptionJSON,
  type VapidKeys,
} from "../src/gateway/push.js";

// Test directory for isolation
const testDir = join(tmpdir(), `hawky-push-test-${Date.now()}`);
const vapidKeysPath = join(testDir, "vapid-keys.json");
const subscriptionsPath = join(testDir, "push-subscriptions.json");

beforeEach(() => {
  mkdirSync(testDir, { recursive: true });
  // Clean files from previous test
  try { rmSync(vapidKeysPath); } catch {}
  try { rmSync(subscriptionsPath); } catch {}
  setPushPaths({ vapidKeysPath, subscriptionsPath });
});

afterAll(() => {
  resetPushPaths();
  rmSync(testDir, { recursive: true, force: true });
});

// Helper: create a mock subscription
function makeSub(id: number): PushSubscriptionJSON {
  return {
    endpoint: `https://push.example.com/sub/${id}`,
    keys: {
      p256dh: `p256dh-key-${id}`,
      auth: `auth-key-${id}`,
    },
  };
}

// =============================================================================
// VAPID Key Management
// =============================================================================

describe("VAPID key management", () => {
  test("generates new keys when none exist", () => {
    const keys = loadOrGenerateVapidKeys();
    expect(keys.publicKey).toBeTruthy();
    expect(keys.privateKey).toBeTruthy();
    expect(typeof keys.publicKey).toBe("string");
    expect(typeof keys.privateKey).toBe("string");
  });

  test("persists generated keys to disk", () => {
    const keys = loadOrGenerateVapidKeys();
    expect(existsSync(vapidKeysPath)).toBe(true);

    const loaded = JSON.parse(readFileSync(vapidKeysPath, "utf-8"));
    expect(loaded.publicKey).toBe(keys.publicKey);
    expect(loaded.privateKey).toBe(keys.privateKey);
  });

  test("returns same keys on subsequent loads", () => {
    const keys1 = loadOrGenerateVapidKeys();
    const keys2 = loadOrGenerateVapidKeys();
    expect(keys1.publicKey).toBe(keys2.publicKey);
    expect(keys1.privateKey).toBe(keys2.privateKey);
  });

  test("regenerates if keys file is corrupt", () => {
    writeFileSync(vapidKeysPath, "not json", "utf-8");
    const keys = loadOrGenerateVapidKeys();
    expect(keys.publicKey).toBeTruthy();
    expect(keys.privateKey).toBeTruthy();
  });

  test("regenerates if keys file has empty values", () => {
    writeFileSync(vapidKeysPath, JSON.stringify({ publicKey: "", privateKey: "" }), "utf-8");
    const keys = loadOrGenerateVapidKeys();
    expect(keys.publicKey).toBeTruthy();
    expect(keys.privateKey).toBeTruthy();
  });

  test("readVapidKeys returns null when no file", () => {
    expect(readVapidKeys()).toBeNull();
  });

  test("readVapidKeys returns keys after generation", () => {
    const generated = loadOrGenerateVapidKeys();
    const read = readVapidKeys();
    expect(read).not.toBeNull();
    expect(read!.publicKey).toBe(generated.publicKey);
  });
});

// =============================================================================
// Subscription Storage
// =============================================================================

describe("subscription storage", () => {
  test("loadSubscriptions returns empty array when no file", () => {
    expect(loadSubscriptions()).toEqual([]);
  });

  test("saveSubscriptions and loadSubscriptions roundtrip", () => {
    const subs = [makeSub(1), makeSub(2)];
    saveSubscriptions(subs);
    const loaded = loadSubscriptions();
    expect(loaded).toEqual(subs);
  });

  test("addSubscription appends new subscription", () => {
    addSubscription(makeSub(1));
    addSubscription(makeSub(2));
    const subs = loadSubscriptions();
    expect(subs.length).toBe(2);
    expect(subs[0].endpoint).toContain("/sub/1");
    expect(subs[1].endpoint).toContain("/sub/2");
  });

  test("addSubscription deduplicates by endpoint", () => {
    const sub = makeSub(1);
    addSubscription(sub);
    // Update keys for same endpoint
    const updated = { ...sub, keys: { p256dh: "new-p256dh", auth: "new-auth" } };
    addSubscription(updated);
    const subs = loadSubscriptions();
    expect(subs.length).toBe(1);
    expect(subs[0].keys.p256dh).toBe("new-p256dh");
  });

  test("removeSubscription removes by endpoint", () => {
    addSubscription(makeSub(1));
    addSubscription(makeSub(2));
    addSubscription(makeSub(3));

    const removed = removeSubscription(makeSub(2).endpoint);
    expect(removed).toBe(true);

    const subs = loadSubscriptions();
    expect(subs.length).toBe(2);
    expect(subs.find((s) => s.endpoint.includes("/sub/2"))).toBeUndefined();
  });

  test("removeSubscription returns false for unknown endpoint", () => {
    addSubscription(makeSub(1));
    const removed = removeSubscription("https://nonexistent.example.com");
    expect(removed).toBe(false);
  });

  test("loadSubscriptions handles corrupt file", () => {
    writeFileSync(subscriptionsPath, "not json", "utf-8");
    expect(loadSubscriptions()).toEqual([]);
  });

  test("loadSubscriptions handles non-array JSON", () => {
    writeFileSync(subscriptionsPath, JSON.stringify({ bad: true }), "utf-8");
    expect(loadSubscriptions()).toEqual([]);
  });
});

// =============================================================================
// Push Service
// =============================================================================

describe("createPushService", () => {
  test("returns disabled service when no vapidEmail", () => {
    const service = createPushService();
    expect(service.enabled).toBe(false);
    expect(service.vapidPublicKey).toBeNull();
    expect(service.getSubscriptionCount()).toBe(0);
  });

  test("disabled service sendToAll is a no-op", async () => {
    const service = createPushService();
    const result = await service.sendToAll({ title: "test", body: "msg" });
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.expired).toBe(0);
  });

  test("disabled service addSubscription is a no-op", () => {
    const service = createPushService();
    service.addSubscription(makeSub(1));
    expect(service.getSubscriptionCount()).toBe(0);
  });

  test("disabled service removeSubscription returns false", () => {
    const service = createPushService();
    expect(service.removeSubscription("x")).toBe(false);
  });

  test("enabled service has VAPID public key", () => {
    const service = createPushService("mailto:test@example.com");
    expect(service.enabled).toBe(true);
    expect(service.vapidPublicKey).toBeTruthy();
    expect(typeof service.vapidPublicKey).toBe("string");
  });

  test("enabled service manages subscriptions", () => {
    const service = createPushService("mailto:test@example.com");
    service.addSubscription(makeSub(1));
    service.addSubscription(makeSub(2));
    expect(service.getSubscriptionCount()).toBe(2);

    service.removeSubscription(makeSub(1).endpoint);
    expect(service.getSubscriptionCount()).toBe(1);
  });

  test("sendToAll returns zeros when no subscriptions", async () => {
    const service = createPushService("mailto:test@example.com");
    const result = await service.sendToAll({ title: "t", body: "b" });
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.expired).toBe(0);
  });
});

// =============================================================================
// Delivery Integration
// =============================================================================

describe("delivery integration", () => {
  // Import delivery module to test push wiring
  const { deliver, setPushService } = require("../src/gateway/delivery.js") as {
    deliver: (opts: any) => any;
    setPushService: (svc: any) => void;
  };

  test("push mode sends push only", () => {
    let pushPayload: any = null;
    const mockPush = {
      enabled: true,
      sendToAll: async (payload: any) => {
        pushPayload = payload;
        return { sent: 1, failed: 0, expired: 0 };
      },
    };

    setPushService(mockPush as any);
    const result = deliver({
      config: { mode: "push" as any },
      title: "Cron Done",
      message: "Summary here",
      sessionKey: "cron:daily",
    });

    expect(result.delivered).toBe(true);
    expect(result.mode).toBe("push");
    expect(pushPayload).not.toBeNull();
    expect(pushPayload.title).toBe("Cron Done");
    expect(pushPayload.data.sessionKey).toBe("cron:daily");

    setPushService(null);
  });

  test("push mode returns not delivered when push not configured", () => {
    setPushService(null);
    const result = deliver({
      config: { mode: "push" as any },
      title: "Test",
      message: "Msg",
    });
    expect(result.delivered).toBe(false);
    expect(result.error).toContain("not configured");
  });
});
