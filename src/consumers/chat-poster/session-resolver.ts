// =============================================================================
// Per-node voice-memo session resolver.
//
// Each gateway node has a stable voice-memo session keyed by the shared
// install-salt-backed node id (see src/storage/node-id.ts).
//
// Session key: "voice:<node_id>". The session is created lazily on the first
// ASR final event for this process.
// =============================================================================

import { getNodeId, _resetNodeIdCacheForTesting } from "../../storage/node-id.js";

/** Re-export for callers that want the raw node id. */
export { getNodeId };

/** The per-node voice-memo session key. */
export function getVoiceMemoSessionKey(override?: string | null): string {
  if (override && override.trim()) return override.trim();
  return `voice:${getNodeId()}`;
}

/** Test-only — clear the cached node id so the next call recomputes. */
export function _resetNodeIdCache(): void {
  _resetNodeIdCacheForTesting();
}
