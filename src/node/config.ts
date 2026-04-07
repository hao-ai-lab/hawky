// =============================================================================
// Node Host Configuration
//
// Persists node identity and gateway connection settings to
// ~/.hawky/state/node.json. Auto-generates a stable nodeId on first run.
//
// Pattern: a proven node-host/config.ts.
// =============================================================================

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { getConfigDir } from "../storage/config.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface NodeConfig {
  /** Stable node identifier (auto-generated UUID). */
  nodeId: string;
  /** Human-readable display name (defaults to hostname). */
  displayName: string;
  /** Gateway WebSocket URL. */
  gateway: string;
}

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

function getNodeConfigPath(): string {
  return join(getConfigDir(), "state", "node.json");
}

/**
 * Load node config from disk, creating defaults if it doesn't exist.
 */
export function loadNodeConfig(): NodeConfig {
  const path = getNodeConfigPath();

  if (existsSync(path)) {
    try {
      const raw = readFileSync(path, "utf-8");
      const data = JSON.parse(raw) as Partial<NodeConfig>;
      return {
        nodeId: data.nodeId ?? randomUUID(),
        displayName: data.displayName ?? hostname(),
        gateway: data.gateway ?? "ws://localhost:4242",
      };
    } catch {
      // Corrupt file — regenerate
    }
  }

  const config: NodeConfig = {
    nodeId: randomUUID(),
    displayName: hostname(),
    gateway: "ws://localhost:4242",
  };
  saveNodeConfig(config);
  return config;
}

/**
 * Persist node config to disk.
 */
export function saveNodeConfig(config: NodeConfig): void {
  const path = getNodeConfigPath();
  const dir = join(getConfigDir(), "state");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf-8");
}
