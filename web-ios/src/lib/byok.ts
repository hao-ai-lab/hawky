// =============================================================================
// BYOK — "bring your own key" OpenAI key storage (web demo, #681).
//
// The hosted demo never ships a shared OpenAI key. Instead each visitor can
// paste their own key in Settings; it is stored ONLY in this browser's
// localStorage and sent to the gateway broker per-session to mint a short-lived
// realtime client secret (see live.openaiClientSecret + the broker's
// byok_api_key param). It is never sent anywhere else and never logged.
//
// Storage key uses the same "hawky-…" convention as the theme/live-lab flags.
// =============================================================================

const BYOK_STORAGE_KEY = "hawky-openai-byok-key";

/** Read the stored BYOK key, or empty string if none / storage unavailable. */
export function loadByokKey(): string {
  try {
    return localStorage.getItem(BYOK_STORAGE_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

/** Persist (or clear, when blank) the BYOK key in this browser only. */
export function saveByokKey(key: string): void {
  try {
    const trimmed = key.trim();
    if (trimmed) localStorage.setItem(BYOK_STORAGE_KEY, trimmed);
    else localStorage.removeItem(BYOK_STORAGE_KEY);
  } catch {
    /* localStorage may be unavailable (private mode) — no-op */
  }
}

/** Remove the stored BYOK key. */
export function clearByokKey(): void {
  try {
    localStorage.removeItem(BYOK_STORAGE_KEY);
  } catch {
    /* no-op */
  }
}

/** True when the key looks like an OpenAI secret key (`sk-…`). */
export function looksLikeOpenAIKey(key: string): boolean {
  return /^sk-[A-Za-z0-9_-]{20,200}$/.test(key.trim());
}

/**
 * Mask a key for display: keep the `sk-` prefix and the last 4 chars, replace
 * the middle with dots. Short/blank values render as a fixed dot run so the
 * real length never leaks.
 */
export function maskKey(key: string): string {
  const k = key.trim();
  if (!k) return "";
  if (k.length <= 11) return "•".repeat(8);
  const prefix = k.startsWith("sk-") ? "sk-" : k.slice(0, 3);
  return `${prefix}${"•".repeat(6)}${k.slice(-4)}`;
}

/**
 * Build the `byok_api_key` param for a `live.openaiClientSecret` RPC call.
 * Returns an empty object when no (valid-looking) key is stored, so callers can
 * spread it unconditionally: rpc("live.openaiClientSecret", { ...byokParam(), … }).
 */
export function byokParam(): { byok_api_key?: string } {
  const key = loadByokKey();
  return looksLikeOpenAIKey(key) ? { byok_api_key: key } : {};
}
