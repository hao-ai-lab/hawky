import {
  normalizeLegacyDeepFaceProfile,
  type LegacyDeepFaceProfile,
} from "./legacy-deepface.js";
import type {
  PersonToolPerson,
  PersonToolRecapSummary,
  PersonToolStructuredRecords,
} from "./tool-contract.js";

const MAX_THUMBNAIL_BYTES = 400_000;

export function deepFaceProfileToPersonToolPerson(
  raw: LegacyDeepFaceProfile,
  options: {
    includeStructured?: boolean;
    now?: string;
  } = {},
): PersonToolPerson | undefined {
  const normalized = normalizeLegacyDeepFaceProfile(raw, { now: options.now });
  if (!normalized.profile) {
    return undefined;
  }

  const facts = stringArray(raw.facts);
  const recaps = recapArray(raw.recaps);
  const lastRecap = recaps.length > 0 ? recaps[recaps.length - 1]?.summary : undefined;
  const thumbnail = thumbnailOrUndefined(raw.thumbnail);
  const structured: PersonToolStructuredRecords | undefined =
    options.includeStructured === false
      ? undefined
      : {
          profile: normalized.profile,
          facts: normalized.facts,
          recaps: normalized.recaps,
          faceSignals: normalized.faceSignals,
          warnings: normalized.warnings,
        };

  return {
    id: normalized.profile.id,
    name: normalized.profile.displayName,
    facts,
    recaps,
    lastRecap,
    created_at: stringOrUndefined(raw.created_at),
    last_seen_at: stringOrUndefined(raw.last_seen_at),
    thumbnail,
    structured,
  };
}

export function deepFaceProfilesToPersonToolPeople(
  rawPeople: unknown[],
  options: {
    includeStructured?: boolean;
    now?: string;
  } = {},
): PersonToolPerson[] {
  const people: PersonToolPerson[] = [];
  for (const raw of rawPeople) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const person = deepFaceProfileToPersonToolPerson(raw as LegacyDeepFaceProfile, options);
    if (person) people.push(person);
  }
  return people;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string") continue;
    const text = item.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function recapArray(value: unknown): PersonToolRecapSummary[] {
  if (!Array.isArray(value)) return [];
  const recaps: PersonToolRecapSummary[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const summary = stringOrUndefined(record.summary);
    if (!summary) continue;
    const at = stringOrUndefined(record.at);
    recaps.push(at ? { summary, at } : { summary });
  }
  return recaps;
}

function thumbnailOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length < MAX_THUMBNAIL_BYTES
    ? value
    : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
