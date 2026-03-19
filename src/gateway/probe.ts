// =============================================================================
// Gateway Probe & Background Spawner
//
// Utilities for detecting a running gateway and spawning one in the background.
// Used by the `hawky` one-command startup and `hawky doctor`.
// =============================================================================

import { existsSync, mkdirSync, openSync, constants as fsConstants } from "node:fs";
import { join } from "node:path";
import { getConfigDir } from "../storage/config.js";

// -----------------------------------------------------------------------------
// Health check
// -----------------------------------------------------------------------------

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Check if a gateway is running on the given port by hitting its health endpoint.
 */
export async function isGatewayRunning(port: number): Promise<boolean> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

    const response = await fetch(`http://localhost:${port}/health`, {
      signal: controller.signal,
    });

    clearTimeout(timer);
    return response.ok;
  } catch {
    return false;
  }
}

// -----------------------------------------------------------------------------
// Background spawner
// -----------------------------------------------------------------------------

const SPAWN_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 300;

/**
 * Spawn the gateway as a detached background process.
 * Waits for the health endpoint to respond before returning.
 * Logs go to ~/.hawky/logs/gateway.log.
 *
 * @throws Error if the gateway doesn't become ready within the timeout
 */
export async function spawnGatewayBackground(port: number): Promise<void> {
  // Ensure log directory exists
  const logDir = join(getConfigDir(), "logs");
  if (!existsSync(logDir)) {
    mkdirSync(logDir, { recursive: true });
  }

  const logPath = join(logDir, "gateway.log");
  const logFd = openSync(logPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND);

  // Find the entry script — use process.argv[1] (the script that's currently running)
  const entryScript = process.argv[1];

  const proc = Bun.spawn(["bun", "run", entryScript, "gateway", "--port", String(port)], {
    stdio: ["ignore", logFd, logFd],
    env: { ...process.env },
  });

  // Detach so gateway survives TUI exit
  proc.unref();

  // Poll health endpoint until ready
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isGatewayRunning(port)) {
      console.log(`  Gateway started in background (port ${port})`);
      console.log(`  Logs: ${logPath}\n`);
      return;
    }
    await Bun.sleep(POLL_INTERVAL_MS);
  }

  throw new Error(
    `Gateway did not become ready within ${SPAWN_TIMEOUT_MS / 1000}s. Check logs: ${logPath}`,
  );
}
