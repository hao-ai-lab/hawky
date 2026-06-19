// =============================================================================
// Broker — assemble a PushItem from a fired Intention / task / external event.
// M1 minimal: maps surface fields from the source; memory-retrieval enrichment
// is a later milestone.
// =============================================================================

import type { Intention } from "./intention.js";
import { findWhenTerm } from "./intention.js";
import type { PushItem } from "./delivery.js";

// -----------------------------------------------------------------------------
// Input union
// -----------------------------------------------------------------------------

export interface IntentionInput {
  kind: "intention";
  intention: Intention;
}

export interface TaskInput {
  kind: "task";
  id: string;
  title: string;
  body: string;
}

export interface ExternalInput {
  kind: "external";
  id: string;
  title: string;
  body: string;
  itemKind?: string;
}

export type BrokerInput = IntentionInput | TaskInput | ExternalInput;

// -----------------------------------------------------------------------------
// buildPushItem
// -----------------------------------------------------------------------------

/**
 * Map a fired Intention (or task / external event) to a PushItem.
 *
 * For Intention inputs:
 *   - title: first 80 chars of intention.content (trimmed)
 *   - body: intention.content
 *   - source: "intention"
 *   - intentionId: intention.id
 *   - at: the `when.at` value from the first TriggerWhen term in trigger.all, if present
 *   - strength: the intention's strength (hard = must-deliver, soft = optional)
 */
export function buildPushItem(input: BrokerInput): PushItem {
  if (input.kind === "intention") {
    const { intention } = input;
    const title = intention.content.length > 80 ? intention.content.slice(0, 80).trimEnd() : intention.content;

    // Extract `at` from the first when-term in trigger.all
    const at = findWhenTerm(intention.trigger)?.at;

    return {
      id: intention.id,
      title,
      body: intention.content,
      source: "intention",
      intentionId: intention.id,
      at,
      strength: intention.strength,
      origin: intention.origin,
      confidence: intention.confidence,
    };
  }

  if (input.kind === "task") {
    return {
      id: input.id,
      title: input.title,
      body: input.body,
      source: "task",
    };
  }

  // external
  return {
    id: input.id,
    title: input.title,
    body: input.body,
    source: "external",
    kind: input.itemKind,
  };
}
