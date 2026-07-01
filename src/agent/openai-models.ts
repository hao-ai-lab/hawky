// =============================================================================
// OpenAI model catalog
//
// Probes GET /v1/models to enumerate IDs the user's key has access to.
// Falls back to a curated static list (KNOWN_OPENAI_MODELS, the 8 IDs that
// have pricing entries in cost-tracker.ts) when the probe is unavailable
// or hasn't fired yet.
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";
import type { HawkyConfig } from "./types.js";

const log = createSubsystemLogger("agent/api");
const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";

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

export interface OpenAIModelCatalogProbe {
  apiKey: string;
  baseURL?: string;
}

export interface FetchOpenAIModelCatalogOptions {
  baseURL?: string;
  timeoutMs?: number;
}

export function buildOpenAIModelCatalogURL(baseURL = DEFAULT_OPENAI_BASE_URL): string {
  const normalized = baseURL.trim() || DEFAULT_OPENAI_BASE_URL;
  const withTrailingSlash = normalized.endsWith("/") ? normalized : `${normalized}/`;
  return new URL("models", withTrailingSlash).toString();
}

export function resolveOpenAIModelCatalogProbe(config: HawkyConfig): OpenAIModelCatalogProbe | null {
  if (config.provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY || config.api_keys?.openai || "";
    if (!apiKey) return null;
    return {
      apiKey,
      baseURL: config.openai_base_url || undefined,
    };
  }

  if (config.provider === "openai_compatible") {
    const compat = config.openai_compatible;
    const profileName = compat?.active_profile;
    const profile = profileName ? compat?.profiles?.[profileName] : undefined;
    if (!profile?.base_url) return null;
    const apiKey =
      profile.api_key ||
      (profile.api_key_env ? process.env[profile.api_key_env] : "") ||
      config.api_keys?.openai ||
      process.env.OPENAI_API_KEY ||
      "";
    if (!apiKey) return null;
    return {
      apiKey,
      baseURL: profile.base_url,
    };
  }

  return null;
}

/** GET /models from the configured OpenAI-compatible base URL. */
export async function fetchOpenAIModelCatalog(
  apiKey: string,
  options: FetchOpenAIModelCatalogOptions = {},
): Promise<{ id: string }[]> {
  const res = await fetch(buildOpenAIModelCatalogURL(options.baseURL), {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(options.timeoutMs ?? 3000),
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
export function probeCatalogAsync(apiKey: string, options: FetchOpenAIModelCatalogOptions = {}): void {
  fetchOpenAIModelCatalog(apiKey, options)
    .then((models) => {
      setCachedCatalog(models);
      log.info(`OpenAI model catalog probe succeeded (${models.length} models)`);
    })
    .catch((err) => {
      log.warn(`OpenAI model catalog probe failed: ${err instanceof Error ? err.message : String(err)} — using fallback list`);
    });
}
