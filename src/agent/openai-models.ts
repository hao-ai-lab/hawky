// =============================================================================
// OpenAI model catalog
//
// Probes GET /v1/models to enumerate IDs the user's key has access to.
// Falls back to a curated static list (KNOWN_OPENAI_MODELS, the 8 IDs that
// have pricing entries in cost-tracker.ts) when the probe is unavailable
// or hasn't fired yet.
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("agent/api");

/** Curated fallback list — the 8 IDs that ship with pricing entries. */
export const KNOWN_OPENAI_MODELS: readonly string[] = [
  "gpt-5.5",
  "gpt-5.5-pro",
  "gpt-5.4",
  "gpt-5.4-pro",
  "gpt-5.4-mini",
  "gpt-5.4-nano",
  "gpt-5.3-chat-latest",
  "gpt-5.3-codex",
];

let cachedCatalog: { models: { id: string }[]; fetchedAt: Date } | null = null;

/** Returns the cached catalog (probe result) or null when no probe has fired. */
export function getCachedCatalog(): { id: string }[] | null {
  return cachedCatalog?.models ?? null;
}

export function setCachedCatalog(models: { id: string }[]): void {
  cachedCatalog = { models, fetchedAt: new Date() };
}

export function clearCachedCatalog(): void {
  cachedCatalog = null;
}

/** GET https://api.openai.com/v1/models with a 3-second timeout. */
export async function fetchOpenAIModelCatalog(apiKey: string): Promise<{ id: string }[]> {
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(3000),
  });
  if (!res.ok) {
    throw new Error(`OpenAI /v1/models returned ${res.status}`);
  }
  const body = (await res.json()) as { data?: { id: string }[] };
  if (!Array.isArray(body.data)) {
    throw new Error("OpenAI /v1/models response missing data array");
  }
  return body.data.map((m) => ({ id: m.id }));
}

/** Fire-and-forget catalog probe used at gateway boot. Failures don't throw. */
export function probeCatalogAsync(apiKey: string): void {
  fetchOpenAIModelCatalog(apiKey)
    .then((models) => {
      setCachedCatalog(models);
      log.info(`OpenAI model catalog probe succeeded (${models.length} models)`);
    })
    .catch((err) => {
      log.warn(`OpenAI model catalog probe failed: ${err instanceof Error ? err.message : String(err)} — using fallback list`);
    });
}
