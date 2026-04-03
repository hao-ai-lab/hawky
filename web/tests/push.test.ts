// =============================================================================
// Tests: Client-side Push Subscription
//
// Unit tests for push state detection, VAPID key conversion, and subscription
// lifecycle. Uses mocked browser APIs (no real service worker or push service).
// =============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getPushState,
  urlBase64ToUint8Array,
} from "../src/lib/push";

// Mock browser APIs
beforeEach(() => {
  // Default: desktop Chrome (not iOS, not standalone)
  Object.defineProperty(navigator, "userAgent", {
    value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    writable: true,
    configurable: true,
  });
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn(() => ({ matches: false })),
    writable: true,
    configurable: true,
  });

  // Mock PushManager and Notification existence
  (window as any).PushManager = {};
  (window as any).Notification = { permission: "default" };

  // Mock serviceWorker
  Object.defineProperty(navigator, "serviceWorker", {
    value: { addEventListener: vi.fn() },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as any).PushManager;
});

// =============================================================================
// getPushState
// =============================================================================

describe("getPushState", () => {
  it("returns 'unsupported' when PushManager not available", () => {
    delete (window as any).PushManager;
    expect(getPushState(true)).toBe("unsupported");
  });

  it("returns 'unsupported' when Notification not available", () => {
    delete (window as any).Notification;
    expect(getPushState(true)).toBe("unsupported");
  });

  it("returns 'not-standalone' on iOS Safari tab", () => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      configurable: true,
    });
    // Not standalone
    Object.defineProperty(window, "matchMedia", {
      value: vi.fn(() => ({ matches: false })),
      configurable: true,
    });
    expect(getPushState(true)).toBe("not-standalone");
  });

  it("returns 'prompt' on iOS standalone (PWA installed)", () => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      configurable: true,
    });
    // Standalone mode
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    (window as any).Notification = { permission: "default" };
    expect(getPushState(true)).toBe("prompt");
  });

  it("returns 'disabled' when gateway has no VAPID configured", () => {
    expect(getPushState(false)).toBe("disabled");
  });

  it("returns 'denied' when permission is denied", () => {
    (window as any).Notification = { permission: "denied" };
    expect(getPushState(true)).toBe("denied");
  });

  it("returns 'prompt' when permission is default", () => {
    (window as any).Notification = { permission: "default" };
    expect(getPushState(true)).toBe("prompt");
  });

  it("returns 'prompt' when permission is granted (caller checks subscription)", () => {
    (window as any).Notification = { permission: "granted" };
    expect(getPushState(true)).toBe("prompt");
  });

  it("returns 'prompt' on desktop Chrome with push enabled", () => {
    (window as any).Notification = { permission: "default" };
    expect(getPushState(true)).toBe("prompt");
  });
});

// =============================================================================
// urlBase64ToUint8Array
// =============================================================================

describe("urlBase64ToUint8Array", () => {
  it("converts a base64url string to Uint8Array", () => {
    // Known base64url value
    const input = "AAEC"; // bytes: 0, 1, 2
    const result = urlBase64ToUint8Array(input);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result[0]).toBe(0);
    expect(result[1]).toBe(1);
    expect(result[2]).toBe(2);
  });

  it("handles base64url characters (- and _)", () => {
    // base64url uses - instead of + and _ instead of /
    const input = "ab-c_d"; // should become ab+c/d in standard base64
    const result = urlBase64ToUint8Array(input);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result.length).toBeGreaterThan(0);
  });

  it("handles padding correctly", () => {
    // Input without padding (length not multiple of 4)
    const input = "AA"; // needs == padding
    const result = urlBase64ToUint8Array(input);
    expect(result).toBeInstanceOf(Uint8Array);
    expect(result[0]).toBe(0);
  });

  it("converts a real VAPID-like key", () => {
    // 65-byte uncompressed EC P-256 public key in base64url
    const vapidKey = "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM";
    const result = urlBase64ToUint8Array(vapidKey);
    expect(result.length).toBe(65);
    expect(result[0]).toBe(0x04); // Uncompressed point prefix
  });
});
