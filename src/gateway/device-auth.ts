// =============================================================================
// Device Authentication
//
// Manages device tokens for authenticating TUI, web, and node host connections.
// Tokens are JWTs signed with HMAC-SHA256 using a gateway-local signing key.
//
// The signing key is auto-generated on first use and stored at
// ~/.hawky/state/auth-secret.key (chmod 600). Deleting the key invalidates
// all existing device tokens — every client must re-authenticate.
//
// Flow:
//   1. Client hits /auth/device (after passing Cloudflare Access or localhost)
//   2. Gateway generates a signed JWT (device token)
//   3. Client stores the token and sends it on every WebSocket connect
//   4. Gateway validates the JWT signature + expiry on every connect
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomBytes, createHmac, createHash } from "node:crypto";
import { getConfigDir } from "../storage/config.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("gateway/device-auth");

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const SIGNING_KEY_BYTES = 32; // 256-bit HMAC key
const TOKEN_EXPIRY_DAYS = 30;
const TOKEN_ALGORITHM = "HS256";

// -----------------------------------------------------------------------------
// Base64url helpers (no padding, URL-safe)
// -----------------------------------------------------------------------------

function base64urlEncode(data: Buffer | Uint8Array | string): string {
  const buf = typeof data === "string" ? Buffer.from(data) : Buffer.from(data);
  return buf.toString("base64url");
}

function base64urlDecode(str: string): Buffer {
  return Buffer.from(str, "base64url");
}

// -----------------------------------------------------------------------------
// JWT implementation (HMAC-SHA256 only, no external dependencies)
// -----------------------------------------------------------------------------

export interface DeviceTokenPayload {
  /** Subject — always "device" */
  sub: "device";
  /** Issued at (Unix seconds) */
  iat: number;
  /** Expiry (Unix seconds) */
  exp: number;
  /** Device label (e.g., "hao-macbook", "web-browser") */
  device: string;
  /** Unique token ID */
  jti: string;
}

function signJwt(payload: DeviceTokenPayload, secret: Buffer): string {
  const header = base64urlEncode(JSON.stringify({ alg: TOKEN_ALGORITHM, typ: "JWT" }));
  const body = base64urlEncode(JSON.stringify(payload));
  const data = `${header}.${body}`;
  const signature = createHmac("sha256", secret).update(data).digest();
  return `${data}.${base64urlEncode(signature)}`;
}

function verifyJwt(token: string, secret: Buffer): DeviceTokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [header, body, sig] = parts;

  // Verify signature
  const data = `${header}.${body}`;
  const expectedSig = createHmac("sha256", secret).update(data).digest();
  const actualSig = base64urlDecode(sig);

  if (expectedSig.length !== actualSig.length) return null;

  // Constant-time comparison to prevent timing attacks
  let diff = 0;
  for (let i = 0; i < expectedSig.length; i++) {
    diff |= expectedSig[i] ^ actualSig[i];
  }
  if (diff !== 0) return null;

  // Decode and validate header
  try {
    const headerObj = JSON.parse(base64urlDecode(header).toString("utf-8"));
    if (headerObj.alg !== TOKEN_ALGORITHM || headerObj.typ !== "JWT") return null;
  } catch {
    return null;
  }

  // Decode payload
  try {
    const payload = JSON.parse(base64urlDecode(body).toString("utf-8")) as DeviceTokenPayload;
    if (payload.sub !== "device") return null;
    if (typeof payload.iat !== "number") return null;
    if (typeof payload.exp !== "number") return null;
    if (typeof payload.jti !== "string") return null;
    return payload;
  } catch {
    return null;
  }
}

// -----------------------------------------------------------------------------
// DeviceAuth — signing key management + token operations
// -----------------------------------------------------------------------------

export class DeviceAuth {
  private signingKey: Buffer;

  constructor(signingKey: Buffer) {
    this.signingKey = signingKey;
  }

  /**
   * Load or generate the signing key from the state directory.
   * Creates the key file on first use (chmod 600).
   */
  static init(stateDir?: string): DeviceAuth {
    const dir = stateDir ?? join(getConfigDir(), "state");
    const keyPath = join(dir, "auth-secret.key");

    let key: Buffer;
    if (existsSync(keyPath)) {
      key = readFileSync(keyPath);
      if (key.length < SIGNING_KEY_BYTES) {
        log.warn("signing key too short, regenerating", { path: keyPath });
        key = randomBytes(SIGNING_KEY_BYTES);
        writeKey(keyPath, key);
      }
      log.debug("loaded signing key", { path: keyPath });
    } else {
      key = randomBytes(SIGNING_KEY_BYTES);
      mkdirSync(dir, { recursive: true });
      writeKey(keyPath, key);
      log.info("generated new signing key", { path: keyPath });
    }

    return new DeviceAuth(key);
  }

  /**
   * Create from an existing key buffer (for testing).
   */
  static fromKey(key: Buffer): DeviceAuth {
    return new DeviceAuth(key);
  }

  /**
   * Generate a device token.
   *
   * @param device - Human-readable device label (e.g., "hao-macbook")
   * @param expiryDays - Token lifetime in days (default: 30)
   * @returns Signed JWT string
   */
  createToken(device: string, expiryDays = TOKEN_EXPIRY_DAYS): string {
    const now = Math.floor(Date.now() / 1000);
    const payload: DeviceTokenPayload = {
      sub: "device",
      iat: now,
      exp: now + expiryDays * 24 * 60 * 60,
      device,
      jti: randomBytes(16).toString("hex"),
    };
    return signJwt(payload, this.signingKey);
  }

  /**
   * Verify a device token. Returns the payload if valid, null if invalid or expired.
   */
  verifyToken(token: string): DeviceTokenPayload | null {
    const payload = verifyJwt(token, this.signingKey);
    if (!payload) return null;

    // Check expiry
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp <= now) return null;

    return payload;
  }

  /**
   * Check if a token is valid (convenience method).
   */
  isValid(token: string): boolean {
    return this.verifyToken(token) !== null;
  }
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function writeKey(path: string, key: Buffer): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, key, { mode: 0o600 });
  // Ensure permissions even if file existed with wrong mode
  try {
    chmodSync(path, 0o600);
  } catch {
    // Non-fatal on platforms that don't support chmod
  }
}

// -----------------------------------------------------------------------------
// Auth page HTML templates
// -----------------------------------------------------------------------------

/**
 * HTML page that auto-redirects to the TUI's local callback server with the token.
 */
export function callbackRedirectHtml(callbackPort: number, token: string): string {
  const callbackUrl = `http://localhost:${callbackPort}/callback?token=${encodeURIComponent(token)}`;
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Hawky — Authenticated</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5;">
<div style="text-align: center; max-width: 400px;">
  <h2>Authenticated</h2>
  <p>Redirecting to your terminal...</p>
  <p style="color: #888; font-size: 0.85em;">If nothing happens, <a href="${callbackUrl}" style="color: #60a5fa;">click here</a>.</p>
</div>
<script>window.location.href = ${JSON.stringify(callbackUrl)};</script>
</body>
</html>`;
}

/**
 * HTML page that displays the token for manual copy-paste (headless flow).
 */
export function manualTokenHtml(token: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Hawky — Device Token</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5;">
<div style="text-align: center; max-width: 600px;">
  <h2>Device Token</h2>
  <p>Copy this token and paste it into your terminal:</p>
  <pre id="token" style="background: #1a1a1a; padding: 16px; border-radius: 8px; word-break: break-all; cursor: pointer; user-select: all; font-size: 0.85em; border: 1px solid #333;">${escapeHtml(token)}</pre>
  <p id="status" style="color: #888; font-size: 0.85em;">Click the token to copy</p>
</div>
<script>
document.getElementById('token').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(${JSON.stringify(token)});
    document.getElementById('status').textContent = 'Copied!';
  } catch { document.getElementById('status').textContent = 'Select and copy manually'; }
});
</script>
</body>
</html>`;
}

/**
 * HTML page for web browser auth: stores token in localStorage and redirects
 * back to the app. Used when JS fetch("/auth/device") is blocked by Cloudflare
 * Access (expired session cookie, page served from service worker cache).
 * A full-page navigation to this endpoint triggers CF Access login first.
 */
export function webAuthRedirectHtml(token: string, returnUrl: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Hawky — Authenticated</title></head>
<body style="font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; background: #0a0a0a; color: #e5e5e5;">
<div style="text-align: center; max-width: 400px;">
  <h2>Authenticated</h2>
  <p>Redirecting to app...</p>
</div>
<script>
try { localStorage.setItem("hawky_device_token", ${JSON.stringify(token)}); } catch {}
window.location.href = ${JSON.stringify(returnUrl)};
</script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// -----------------------------------------------------------------------------
// Client-side token persistence
//
// Device tokens are scoped per gateway and stored at:
//   ~/.hawky/state/device-token-<hash>  (chmod 600)
// where <hash> is the first 12 hex chars of SHA-256(gatewayUrl).
// -----------------------------------------------------------------------------

/** Derive a stable filename suffix from a gateway URL. */
export function gatewayTokenFilename(gatewayUrl: string): string {
  const hash = createHash("sha256").update(gatewayUrl).digest("hex").slice(0, 12);
  return `device-token-${hash}`;
}

/** Save a device token to disk, scoped to a specific gateway URL. */
export function saveDeviceToken(token: string, gatewayUrl: string, stateDir?: string): void {
  const dir = stateDir ?? join(getConfigDir(), "state");
  const tokenPath = join(dir, gatewayTokenFilename(gatewayUrl));
  mkdirSync(dir, { recursive: true });
  writeFileSync(tokenPath, token, { mode: 0o600 });
  try { chmodSync(tokenPath, 0o600); } catch { /* non-fatal */ }
  log.debug("saved device token", { path: tokenPath });
}

/** Load a persisted device token for a specific gateway. Returns null if missing or unreadable. */
export function loadDeviceToken(gatewayUrl: string, stateDir?: string): string | null {
  const dir = stateDir ?? join(getConfigDir(), "state");
  const tokenPath = join(dir, gatewayTokenFilename(gatewayUrl));
  try {
    if (!existsSync(tokenPath)) return null;
    const token = readFileSync(tokenPath, "utf-8").trim();
    return token || null;
  } catch {
    // Corrupted file, permission issue, etc. — fall back to other auth methods
    log.warn("failed to read device token, ignoring", { path: tokenPath });
    return null;
  }
}

/** Delete the persisted device token for a specific gateway. */
export function clearDeviceToken(gatewayUrl: string, stateDir?: string): void {
  const dir = stateDir ?? join(getConfigDir(), "state");
  const tokenPath = join(dir, gatewayTokenFilename(gatewayUrl));
  try { unlinkSync(tokenPath); log.debug("cleared device token", { path: tokenPath }); } catch { /* ok */ }
}
