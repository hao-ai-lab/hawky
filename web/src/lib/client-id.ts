// =============================================================================
// Per-page-load clientId (in-memory only)
//
// Mints a random `clientId` on first call and caches it for the lifetime of
// this JavaScript context. The gateway uses the id to suppress echoes of a
// client's own broadcast (`user.message`, `session.rewound`).
//
// Why no persistence (not localStorage, not sessionStorage):
//
//   - localStorage would share one id across every tab in the browser
//     profile, suppressing legitimate cross-tab sync broadcasts.
//   - sessionStorage is per-tab BUT browsers clone sessionStorage when a
//     tab is duplicated (Cmd+Click a link, "Duplicate Tab" menu), so the
//     two windows would inherit the same id and again silently lose
//     sibling-tab sync.
//   - The only case persistence was meant to handle was a WS reconnect
//     overlap (transient network flap, the new socket opens before the
//     old one's close handler has fired). That happens entirely inside a
//     single JavaScript context — the same WebSocketClient instance just
//     assigns a new `this.ws`. An in-memory module-level cache covers it
//     perfectly: both sockets read the same `cached` value.
//
// Page reload, fresh tab, duplicated tab → each is a fresh JS context, the
// previous socket is already closed (or about to be closed by page unload),
// so re-minting is correct: there's nothing on the server to overlap with.
// =============================================================================

let cached: string | null = null;

function generate(): string {
  // Prefer the platform UUID; fall back to a short random string when crypto
  // is unavailable (e.g. very old browsers, certain test runners).
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return `c-${crypto.randomUUID()}`;
    }
  } catch { /* fall through */ }
  return `c-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

/**
 * Get this JavaScript context's clientId, minting one on first use. Safe to
 * call repeatedly — subsequent calls return the same value until the page
 * unloads (or until __resetClientIdForTests is called in a test).
 */
export function getOrMintClientId(): string {
  if (cached) return cached;
  cached = generate();
  return cached;
}

/** Test-only: clear the cached id so the next call mints fresh. */
export function __resetClientIdForTests(): void {
  cached = null;
}
