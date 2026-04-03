// =============================================================================
// Tests: clientId minting and persistence
// =============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { getOrMintClientId, __resetClientIdForTests } from "../src/lib/client-id";

beforeEach(() => {
  __resetClientIdForTests();
});

describe("getOrMintClientId", () => {
  it("returns the same value on repeated calls within the same JS context", () => {
    const a = getOrMintClientId();
    const b = getOrMintClientId();
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it("mints a fresh id after the in-memory cache resets (simulates a new page load)", () => {
    const a = getOrMintClientId();
    __resetClientIdForTests();
    const b = getOrMintClientId();
    expect(b).not.toBe(a);
    expect(b.length).toBeGreaterThan(0);
  });

  it("ids start with the c- prefix for log greppability", () => {
    expect(getOrMintClientId().startsWith("c-")).toBe(true);
  });

  it("does NOT persist to localStorage or sessionStorage (avoids cross-tab and cloned-tab id sharing)", () => {
    // Cross-tab broadcasts (sidebar updates, sibling chat view) rely on
    // each tab having a distinct clientId. localStorage would share one
    // id across every tab in the browser profile; sessionStorage gets
    // CLONED into duplicated tabs ("Duplicate Tab", Cmd+Click a link).
    // Both regress sibling-tab sync. In-memory only is the right scope.
    getOrMintClientId();
    expect(sessionStorage.getItem("hawky:clientId")).toBeNull();
    expect(localStorage.getItem("hawky:clientId")).toBeNull();
  });
});
