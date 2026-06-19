// =============================================================================
// RPC — fast-clock Intention write path (hard-Intention path).
// Method names + payloads the realtime bridge will call (M2 wires transport).
// =============================================================================

import type { IntentionEvidence, IntentionState, Sensitivity, TriggerPredicate } from "./intention.js";

export const INTENTION_CREATE  = "intention.create";
export const INTENTION_RESOLVE = "intention.resolve";

/** strength forced "hard", origin "obvious" server-side */
export interface IntentionCreateRequest {
  content: string;
  trigger: TriggerPredicate;
  evidence: IntentionEvidence;
  sensitivity?: Sensitivity;
}

export interface IntentionCreateResponse {
  id: string;
  state: IntentionState;
}

export interface IntentionResolveRequest {
  id: string;
}

export interface IntentionResolveResponse {
  id: string;
  state: IntentionState;
}
