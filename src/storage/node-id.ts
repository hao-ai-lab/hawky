// =============================================================================
// Stable, non-PII node identifier.
//
//   node_id = first 12 hex chars of sha256(config_dir + install_salt)
//   install_salt lives in ~/.hawky/workspace/.node-id, written on first run.
//
// Hostname is intentionally NOT mixed in: a hostname rename should not mint a
// new identity, and we do not want to leak the hostname through the
// (publicly surfaced) node_id field on bus events. The persisted install_salt
// is the sole source of cross-restart identity.
// =============================================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createSubsystemLogger } from "../logging/index.js";
import { getConfigDir } from "./config.js";

const log = createSubsystemLogger("storage/node-id");

function saltPath(): string {
  // Prefer HAWKY_WORKSPACE override, fall back to <configDir>/workspace.
  const wsOverride = process.env.HAWKY_WORKSPACE;
  const dir = wsOverride ?? join(getConfigDir(), "workspace");
  return join(dir, ".node-id");
}

function readOrCreateSalt(): string {
  const path = saltPath();
  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8").trim();
      if (raw) return raw;
    } catch {
      /* fallthrough — regenerate */
    }
  }
  const salt = randomBytes(16).toString("hex");
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, salt + "\n", "utf-8");
  } catch (err) {
    log.warn("could not persist node-id salt — using ephemeral", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return salt;
}

let cachedNodeId: string | null = null;

/**
 * Derive a stable, non-PII node id (first 12 hex chars of sha256).
 *
 * Derived from `config_dir` + persisted `install_salt` only — no hostname is
 * mixed in. This keeps node_id stable across hostname changes and avoids
 * exposing the hostname via the published node_id field on bus events.
 */
export function getNodeId(): string {
  if (cachedNodeId) return cachedNodeId;
  const salt = readOrCreateSalt();
  const input = `${getConfigDir()}|${salt}`;
  cachedNodeId = createHash("sha256").update(input).digest("hex").slice(0, 12);
  return cachedNodeId;
}

/** Test-only — clear the cached node id so the next call recomputes. */
export function _resetNodeIdCacheForTesting(): void {
  cachedNodeId = null;
}
