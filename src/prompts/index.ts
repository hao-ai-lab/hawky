// =============================================================================
// Prompt resolver (#512)
//
// getPrompt(id) returns the per-deployment override from
// ~/.hawky/prompts/<id>.md if present, else the bundled default from
// registry.ts. Reads are synchronous (every caller is sync) and cached, mirroring
// loadPermissionsSync / loadConfig. Overrides are opt-in — the prompts/ dir is
// never created eagerly.
//
// Trim policy: bundled defaults are pre-baked to their exact bytes in the
// registry, so getPrompt does NO transformation on them. Override files are
// taken as-is (authoritative bytes) — author them with the exact desired text.
// =============================================================================

import { readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { getConfigDir } from "../storage/config.js";
import { createSubsystemLogger } from "../logging/index.js";
import { PROMPTS } from "./registry.js";

export { PROMPTS } from "./registry.js";
export type { PromptEntry } from "./registry.js";

const log = createSubsystemLogger("prompts");

// id → resolved text (override or default). Cleared by resetPromptCache().
const cache = new Map<string, string>();

function overridePath(id: string): string {
  return join(getConfigDir(), "prompts", `${id}.md`);
}

/**
 * Resolve a prompt id to its text. Override file wins over the bundled default;
 * result is cached. Unknown ids throw (programmer error — ids are compile-time
 * constants in callers).
 */
export function getPrompt(id: string): string {
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  const entry = PROMPTS[id];
  if (!entry) {
    throw new Error(`Unknown prompt id: "${id}"`);
  }

  let resolved = entry.template;
  try {
    // Override is authoritative bytes (no trim) — fall back on any read error
    // (missing file, permissions, etc.), exactly like loadPermissionsSync.
    resolved = readFileSync(overridePath(id), "utf-8");
    log.debug("using prompt override", { id });
  } catch {
    // No override — use the bundled default.
  }

  cache.set(id, resolved);
  return resolved;
}

/** All registered prompt ids (for `prompts list`, tests, doctor views). */
export function listPromptIds(): string[] {
  return Object.keys(PROMPTS);
}

/** Clear the resolution cache (tests / future hot-reload). */
export function resetPromptCache(): void {
  cache.clear();
}

// ---------------------------------------------------------------------------
// CRUD over overrides (#512) — read/update/delete the per-deployment override
// for a known prompt id. The bundled default is immutable; "delete" just
// removes the override and falls back to the default.
// ---------------------------------------------------------------------------

export interface PromptStatus {
  id: string;
  description: string;
  text: string;        // currently resolved text (override if present, else default)
  default: string;     // the bundled default
  overridden: boolean; // true iff an override file exists
}

/** True iff `id` is a registered prompt. */
export function isKnownPromptId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(PROMPTS, id);
}

/** Read-only check: does an override file exist for this id? */
export function hasPromptOverride(id: string): boolean {
  try {
    return existsSync(overridePath(id));
  } catch {
    return false;
  }
}

/** Full status for one prompt (resolved text + default + overridden flag). */
export function getPromptStatus(id: string): PromptStatus {
  const entry = PROMPTS[id];
  if (!entry) throw new Error(`Unknown prompt id: "${id}"`);
  return {
    id,
    description: entry.description,
    text: getPrompt(id),
    default: entry.template,
    overridden: hasPromptOverride(id),
  };
}

/** Status for every registered prompt (for the management/CRUD list view). */
export function listPromptsWithStatus(): PromptStatus[] {
  return listPromptIds().map(getPromptStatus);
}

/**
 * Write an override for a known prompt id (creates ~/.hawky/prompts/ lazily).
 * Throws on unknown id. Invalidates the cache so subsequent getPrompt reflects it.
 */
export function setPromptOverride(id: string, text: string): void {
  if (!isKnownPromptId(id)) {
    throw new Error(`Unknown prompt id: "${id}"`);
  }
  const path = overridePath(id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf-8");
  cache.delete(id);
  log.info("prompt override written", { id, chars: text.length });
}

/**
 * Remove the override for a prompt id (falls back to the bundled default).
 * No-op if no override exists. Returns true iff an override was removed.
 */
export function deletePromptOverride(id: string): boolean {
  if (!isKnownPromptId(id)) {
    throw new Error(`Unknown prompt id: "${id}"`);
  }
  let removed = false;
  try {
    rmSync(overridePath(id));
    removed = true;
  } catch {
    // no override file — nothing to remove
  }
  cache.delete(id);
  if (removed) log.info("prompt override removed", { id });
  return removed;
}
