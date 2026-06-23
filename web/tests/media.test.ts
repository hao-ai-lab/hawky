import { describe, it, expect, vi, afterEach } from "vitest";
import { canUseMedia, mediaUnavailableReason, getUserMediaSafe } from "../src/lib/media";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubSecureContext(secure: boolean, hasMediaDevices: boolean) {
  vi.stubGlobal("window", {
    isSecureContext: secure,
    location: { origin: "http://100.85.232.28:5173" },
  });
  vi.stubGlobal("navigator", hasMediaDevices
    ? { mediaDevices: { getUserMedia: vi.fn(async () => ({ id: "stream" })) } }
    : {});
}

describe("media secure-context guard", () => {
  it("reports unavailable on a plain-HTTP (non-secure) origin", () => {
    stubSecureContext(false, false);
    expect(canUseMedia()).toBe(false);
    const reason = mediaUnavailableReason();
    expect(reason).toMatch(/secure context/i);
    expect(reason).toMatch(/https|localhost/i);
  });

  it("reports available in a secure context with mediaDevices", () => {
    stubSecureContext(true, true);
    expect(canUseMedia()).toBe(true);
    expect(mediaUnavailableReason()).toBeNull();
  });

  it("getUserMediaSafe throws a clear error instead of an undefined-property crash", async () => {
    stubSecureContext(false, false);
    await expect(getUserMediaSafe({ audio: true })).rejects.toThrow(/secure context/i);
  });

  it("getUserMediaSafe delegates to navigator.mediaDevices when usable", async () => {
    stubSecureContext(true, true);
    const stream = await getUserMediaSafe({ audio: true });
    expect((stream as unknown as { id: string }).id).toBe("stream");
  });
});
