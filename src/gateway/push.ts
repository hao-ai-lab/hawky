// =============================================================================
// Web Push Notification Service
//
// VAPID key management, subscription storage, and push delivery.
// Uses the Web Push protocol (RFC 8030 + VAPID) via the `web-push` library.
//
// Works on: iOS 16.4+ (from installed PWA), Chrome, Edge, Firefox.
// Gracefully disabled when vapid_email is not configured.
//
// Pattern: a proven push-apns.ts — but using standard Web Push instead of
// Apple-proprietary APNs, since Hawky is a PWA not a native app.
// =============================================================================

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createSubsystemLogger } from "../logging/index.js";
import { getConfigDir } from "../storage/config.js";

const log = createSubsystemLogger("gateway/push");

// web-push is a CJS module without types — use require-style import
// eslint-disable-next-line @typescript-eslint/no-var-requires
const webpush = require("web-push") as {
  generateVAPIDKeys: () => { publicKey: string; privateKey: string };
  setVapidDetails: (subject: string, publicKey: string, privateKey: string) => void;
  sendNotification: (
    subscription: PushSubscriptionJSON,
    payload: string,
    options?: { timeout?: number },
  ) => Promise<{ statusCode: number; body: string }>;
};

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

/** Standard Web Push subscription (matches browser's PushSubscription.toJSON()) */
export interface PushSubscriptionJSON {
  endpoint: string;
  keys: {
    p256dh: string;
    auth: string;
  };
  expirationTime?: number | null;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushNotificationPayload {
  title: string;
  body: string;
  data?: {
    sessionKey?: string;
    url?: string;
  };
}

// -----------------------------------------------------------------------------
// File paths
// -----------------------------------------------------------------------------

// Defaults derive from the configured Hawky root (honors HAWKY_HOME).
const defaultVapidKeysPath = (): string => join(getConfigDir(), "vapid-keys.json");
const defaultSubscriptionsPath = (): string => join(getConfigDir(), "push-subscriptions.json");

/** Override paths for testing (null = use the configured default). */
let vapidKeysOverride: string | null = null;
let subscriptionsOverride: string | null = null;

const vapidKeysPath = (): string => vapidKeysOverride ?? defaultVapidKeysPath();
const subscriptionsPath = (): string => subscriptionsOverride ?? defaultSubscriptionsPath();

export function setPushPaths(opts: { vapidKeysPath?: string; subscriptionsPath?: string }): void {
  if (opts.vapidKeysPath) vapidKeysOverride = opts.vapidKeysPath;
  if (opts.subscriptionsPath) subscriptionsOverride = opts.subscriptionsPath;
}

export function resetPushPaths(): void {
  vapidKeysOverride = null;
  subscriptionsOverride = null;
}

// -----------------------------------------------------------------------------
// VAPID key management
// -----------------------------------------------------------------------------

/**
 * Load or generate VAPID keys. Keys are persisted to disk so they survive
 * gateway restarts (subscriptions are bound to the key pair).
 */
export function loadOrGenerateVapidKeys(): VapidKeys {
  const path = vapidKeysPath();
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const keys = JSON.parse(raw) as VapidKeys;
      if (keys.publicKey && keys.privateKey) {
        log.debug("loaded VAPID keys from disk");
        return keys;
      }
    } catch {
      log.warn("corrupt vapid-keys.json, regenerating");
    }
  }

  const keys = webpush.generateVAPIDKeys();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(keys, null, 2), { encoding: "utf-8", mode: 0o600 });
  log.info("generated new VAPID keys", { path });
  return keys;
}

/** Read VAPID keys from disk without generating. Returns null if not found. */
export function readVapidKeys(): VapidKeys | null {
  const path = vapidKeysPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const keys = JSON.parse(raw) as VapidKeys;
    return keys.publicKey && keys.privateKey ? keys : null;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Subscription storage (in-memory with disk persistence)
//
// Subscriptions are kept in memory as the source of truth. Disk is written
// as a side-effect after mutations. This prevents stale-snapshot races where
// a concurrent sendToAll + addSubscription could overwrite each other.
// -----------------------------------------------------------------------------

/** Load all push subscriptions from disk. */
export function loadSubscriptions(): PushSubscriptionJSON[] {
  const path = subscriptionsPath();
  if (!existsSync(path)) return [];
  try {
    const raw = readFileSync(path, "utf-8");
    const subs = JSON.parse(raw);
    return Array.isArray(subs) ? subs : [];
  } catch {
    return [];
  }
}

/** Save subscriptions to disk. */
export function saveSubscriptions(subs: PushSubscriptionJSON[]): void {
  const path = subscriptionsPath();
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(subs, null, 2), "utf-8");
}

/** Standalone add (used in tests). For production, use PushService methods. */
export function addSubscription(sub: PushSubscriptionJSON): void {
  const subs = loadSubscriptions();
  const idx = subs.findIndex((s) => s.endpoint === sub.endpoint);
  if (idx >= 0) {
    subs[idx] = sub;
  } else {
    subs.push(sub);
  }
  saveSubscriptions(subs);
}

/** Standalone remove (used in tests). For production, use PushService methods. */
export function removeSubscription(endpoint: string): boolean {
  const subs = loadSubscriptions();
  const filtered = subs.filter((s) => s.endpoint !== endpoint);
  if (filtered.length === subs.length) return false;
  saveSubscriptions(filtered);
  return true;
}

// -----------------------------------------------------------------------------
// Push Service
// -----------------------------------------------------------------------------

export interface PushService {
  /** Whether push is configured and ready */
  readonly enabled: boolean;
  /** VAPID public key (for client subscription) */
  readonly vapidPublicKey: string | null;
  /** Send push notification to all subscriptions */
  sendToAll(payload: PushNotificationPayload): Promise<PushSendResult>;
  /** Add a subscription */
  addSubscription(sub: PushSubscriptionJSON): void;
  /** Remove a subscription */
  removeSubscription(endpoint: string): boolean;
  /** Get subscription count */
  getSubscriptionCount(): number;
}

export interface PushSendResult {
  sent: number;
  failed: number;
  expired: number;
}

/**
 * Create and initialize the push service.
 * Returns a disabled service if vapidEmail is not provided (graceful degradation).
 *
 * Subscriptions are held in memory to prevent stale-snapshot races.
 * Disk persistence is a side-effect of mutations.
 */
/** No-op PushService used for all graceful-degradation paths (no/invalid vapid_email, VAPID setup failure). */
function createDisabledPushService(): PushService {
  return {
    enabled: false,
    vapidPublicKey: null,
    async sendToAll() { return { sent: 0, failed: 0, expired: 0 }; },
    addSubscription() {},
    removeSubscription() { return false; },
    getSubscriptionCount() { return 0; },
  };
}

export function createPushService(vapidEmail?: string): PushService {
  if (!vapidEmail) {
    log.info("push notifications disabled (no vapid_email configured)");
    return createDisabledPushService();
  }

  // Validate vapid_email format
  if (!vapidEmail.startsWith("mailto:")) {
    log.warn("push disabled: vapid_email must start with 'mailto:' (got: " + vapidEmail + ")");
    return createDisabledPushService();
  }

  // Load or generate VAPID keys
  let vapidKeys: VapidKeys;
  try {
    vapidKeys = loadOrGenerateVapidKeys();
    webpush.setVapidDetails(vapidEmail, vapidKeys.publicKey, vapidKeys.privateKey);
  } catch (err) {
    log.error("push disabled: VAPID setup failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return createDisabledPushService();
  }

  // In-memory subscription list — source of truth. Prevents stale-snapshot
  // races where concurrent sendToAll + addSubscription could overwrite each other.
  let subs: PushSubscriptionJSON[] = loadSubscriptions();

  /** Persist current in-memory state to disk. */
  function persistToDisk(): void {
    try {
      saveSubscriptions(subs);
    } catch (err) {
      log.warn("failed to persist push subscriptions", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("push notifications enabled", {
    vapidEmail,
    subscriptions: subs.length,
  });

  return {
    enabled: true,
    vapidPublicKey: vapidKeys.publicKey,

    async sendToAll(payload: PushNotificationPayload): Promise<PushSendResult> {
      // Snapshot current in-memory list (mutations during send won't affect this send)
      const snapshot = [...subs];
      if (snapshot.length === 0) {
        return { sent: 0, failed: 0, expired: 0 };
      }

      const jsonPayload = JSON.stringify(payload);
      let sent = 0;
      let failed = 0;
      let expired = 0;
      const expiredEndpoints: string[] = [];

      const results = await Promise.allSettled(
        snapshot.map((sub) =>
          webpush.sendNotification(sub, jsonPayload, { timeout: 10000 }),
        ),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled") {
          sent++;
        } else {
          const err = result.reason as any;
          const statusCode = typeof err?.statusCode === "number" ? err.statusCode : 0;
          if (statusCode === 404 || statusCode === 410) {
            expired++;
            expiredEndpoints.push(snapshot[i].endpoint);
          } else {
            failed++;
            log.warn("push delivery failed", {
              statusCode,
              error: err?.message ?? String(err),
            });
          }
        }
      }

      // Remove expired from the in-memory list (not the snapshot)
      if (expiredEndpoints.length > 0) {
        subs = subs.filter((s) => !expiredEndpoints.includes(s.endpoint));
        persistToDisk();
        log.info("removed expired push subscriptions", { count: expiredEndpoints.length });
      }

      log.debug("push delivery complete", { sent, failed, expired, total: snapshot.length });
      return { sent, failed, expired };
    },

    addSubscription(sub: PushSubscriptionJSON): void {
      const idx = subs.findIndex((s) => s.endpoint === sub.endpoint);
      if (idx >= 0) {
        subs[idx] = sub;
      } else {
        subs.push(sub);
      }
      persistToDisk();
      log.info("push subscription added/updated", { total: subs.length });
    },

    removeSubscription(endpoint: string): boolean {
      const before = subs.length;
      subs = subs.filter((s) => s.endpoint !== endpoint);
      if (subs.length === before) return false;
      persistToDisk();
      log.info("push subscription removed", { total: subs.length });
      return true;
    },

    getSubscriptionCount(): number {
      return subs.length;
    },
  };
}
