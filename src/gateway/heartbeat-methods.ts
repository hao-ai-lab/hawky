// =============================================================================
// Heartbeat RPC Method Handlers
//
// RPC methods for heartbeat control:
//   heartbeat.status  — get current heartbeat status
//   heartbeat.trigger — request an immediate heartbeat execution
// =============================================================================

import type { GatewayServer } from "./server.js";
import type { HeartbeatService } from "./heartbeat.js";

// -----------------------------------------------------------------------------
// Register heartbeat methods
// -----------------------------------------------------------------------------

export function registerHeartbeatMethods(
  server: GatewayServer,
  heartbeat: HeartbeatService,
): void {
  // -------------------------------------------------------------------------
  // heartbeat.status — get current heartbeat status
  // -------------------------------------------------------------------------
  server.registerMethod("heartbeat.status", () => {
    return heartbeat.getStatus();
  });

  // -------------------------------------------------------------------------
  // heartbeat.trigger — request an immediate heartbeat execution
  // -------------------------------------------------------------------------
  server.registerMethod("heartbeat.trigger", (_conn, params) => {
    const p = params as { reason?: string } | undefined;
    heartbeat.requestNow(p?.reason);
    return { triggered: true };
  });
}
