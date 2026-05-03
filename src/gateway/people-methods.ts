// =============================================================================
// people.list — read-only People Database RPC for the web demo (#681).
//
// The iOS "People" tab (LivePeopleDatabaseView, Cocktail Party / #627) reads the
// server-side DeepFace person database. This method exposes the same data to the
// hosted web demo so the People viewer has real content when the DeepFace
// microservice (services/deepface) is running.
//
// Design notes:
//   - Reuses resolveDeepFaceURL() from the face_recognize tool so the URL/config
//     resolution stays in one place (DEEPFACE_URL env, config.api_urls.deepface,
//     or the local default).
//   - GRACEFUL DEGRADATION: when the DeepFace service is unreachable (the common
//     case for a generic demo deployment) this returns
//     { ok:true, available:false, people:[] } rather than erroring, so the demo
//     renders a clean "service not running" empty state instead of a failure.
//   - Strips face embeddings (large float vectors) from the wire — the viewer
//     only needs name/facts/recaps/timestamps.
// =============================================================================

import type { GatewayServer } from "./server.js";
import { createSubsystemLogger } from "../logging/index.js";
import { resolveDeepFaceURL } from "../tools/face_recognize.js";

const log = createSubsystemLogger("gateway/people-methods");

const REQUEST_TIMEOUT_MS = 8_000;

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

export function registerPeopleMethods(server: GatewayServer): void {
  server.registerMethod("people.list", async (): Promise<PeopleListResult> => {
    return fetchPeople();
  });
}

/**
 * Fetch the people list from the DeepFace service. Exported for tests.
 * Never throws — unreachable service degrades to { available:false, people:[] }.
 */
export async function fetchPeople(): Promise<PeopleListResult> {
  const url = `${resolveDeepFaceURL()}/people`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: controller.signal,
    });
    if (!resp.ok) {
      log.debug("people.list service HTTP error", { status: resp.status });
      return { ok: true, available: false, people: [], note: `DeepFace service HTTP ${resp.status}` };
    }
    const data = (await resp.json().catch(() => null)) as { people?: unknown } | null;
    const people = Array.isArray(data?.people) ? data!.people : [];
    return { ok: true, available: true, people: people.map(toPersonSummary) };
  } catch (err) {
    // Connection refused / DNS / timeout — service simply isn't running.
    const msg = err instanceof Error ? err.message : String(err);
    log.debug("people.list service unreachable", { url, error: msg });
    return {
      ok: true,
      available: false,
      people: [],
      note: "Face database service is not running.",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Map a raw DeepFace person record to the lean wire DTO, dropping embeddings. */
function toPersonSummary(raw: unknown): PersonSummary {
  const p = (raw ?? {}) as Record<string, unknown>;
  const facts = Array.isArray(p.facts) ? p.facts.filter((f): f is string => typeof f === "string") : [];
  const recapsRaw = Array.isArray(p.recaps) ? p.recaps : [];
  const recaps: Array<{ summary: string; at?: string }> = [];
  for (const r of recapsRaw) {
    const rr = (r ?? {}) as Record<string, unknown>;
    const summary = typeof rr.summary === "string" ? rr.summary : "";
    if (!summary) continue;
    const at = typeof rr.at === "string" ? rr.at : undefined;
    recaps.push(at ? { summary, at } : { summary });
  }

  // The DeepFace /people endpoint returns a base64 JPEG face crop in `thumbnail`
  // (no data: prefix). Pass it through so clients can render the face. Guard the
  // size so a malformed/huge value can't bloat the response.
  const thumbnail =
    typeof p.thumbnail === "string" && p.thumbnail.length > 0 && p.thumbnail.length < 400_000
      ? p.thumbnail
      : undefined;

  return {
    id: typeof p.id === "string" ? p.id : "",
    name: typeof p.name === "string" && p.name.trim() ? p.name : "Unknown",
    facts,
    recaps,
    created_at: typeof p.created_at === "string" ? p.created_at : undefined,
    last_seen_at: typeof p.last_seen_at === "string" ? p.last_seen_at : undefined,
    thumbnail,
  };
}
