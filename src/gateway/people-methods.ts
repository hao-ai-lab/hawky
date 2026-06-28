// =============================================================================
// people.list — legacy People Database RPC for the web demo and iOS People tab.
//
// Keep the public method name for existing clients, but delegate to PersonService
// so this list uses the same person-layer normalization and candidate-review
// filtering as the model-facing person.* contract. That prevents legacy DeepFace
// Unknown/rejected candidates from resurfacing in user-visible People screens.
// =============================================================================

import type { GatewayServer } from "./server.js";
import { createSubsystemLogger } from "../logging/index.js";
import { getDefaultPersonService } from "./person-methods.js";
import type {
  PersonService,
  PersonToolPerson,
} from "../identity/person/index.js";

const log = createSubsystemLogger("gateway/people-methods");

/** Lean person DTO sent to clients (no embeddings). */
export interface PersonSummary {
  id: string;
  name: string;
  facts: string[];
  recaps: Array<{ summary: string; at?: string }>;
  created_at?: string;
  last_seen_at?: string;
  /** Base64-encoded JPEG face crop (no data: prefix), when the service provides one. */
  thumbnail?: string;
}

export interface PeopleListResult {
  ok: true;
  /** False when the DeepFace service is unreachable (demo without the service). */
  available: boolean;
  people: PersonSummary[];
  /** Present only when available is false — a short human-readable reason. */
  note?: string;
}

export function registerPeopleMethods(server: GatewayServer, service?: PersonService): void {
  server.registerMethod("people.list", async (): Promise<PeopleListResult> => {
    return fetchPeople(service ?? getDefaultPersonService());
  });
}

/**
 * Fetch the people list through the person layer. Exported for tests.
 * Never throws — unreachable service degrades to { available:false, people:[] }.
 */
export async function fetchPeople(service = getDefaultPersonService()): Promise<PeopleListResult> {
  try {
    const result = await service.listPeople({
      includeStructured: false,
      includeCandidates: false,
    });
    return {
      ok: true,
      available: result.available,
      people: result.people.map(toPersonSummary),
      ...(result.note ? { note: result.note } : {}),
    };
  } catch (err) {
    // Connection refused / DNS / timeout — service simply isn't running.
    const msg = err instanceof Error ? err.message : String(err);
    log.debug("people.list service unavailable", { error: msg });
    return {
      ok: true,
      available: false,
      people: [],
      note: "Face database service is not running.",
    };
  }
}

function toPersonSummary(person: PersonToolPerson): PersonSummary {
  return {
    id: person.id,
    name: person.name,
    facts: person.facts,
    recaps: person.recaps,
    created_at: person.created_at,
    last_seen_at: person.last_seen_at,
    thumbnail: person.thumbnail,
  };
}
