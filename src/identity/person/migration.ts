import {
  normalizeLegacyDeepFaceProfile,
  type LegacyDeepFaceProfile,
} from "./legacy-deepface.js";
import type { PersonStore } from "./store.js";
import type { IsoTime } from "../core/index.js";

export interface LegacyDeepFaceImportResult {
  importedProfiles: number;
  importedFacts: number;
  importedRecaps: number;
  importedCandidates: number;
  skippedProfiles: number;
  warnings: string[];
}

export function importLegacyDeepFaceProfiles(
  store: PersonStore,
  rawProfiles: unknown[],
  options: {
    now?: IsoTime;
    defaultConfidence?: number;
  } = {},
): LegacyDeepFaceImportResult {
  const result: LegacyDeepFaceImportResult = {
    importedProfiles: 0,
    importedFacts: 0,
    importedRecaps: 0,
    importedCandidates: 0,
    skippedProfiles: 0,
    warnings: [],
  };

  for (const raw of rawProfiles) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      result.skippedProfiles += 1;
      continue;
    }

    const normalized = normalizeLegacyDeepFaceProfile(raw as LegacyDeepFaceProfile, options);
    result.warnings.push(...normalized.warnings);

    if (normalized.profile) {
      if (!store.getProfile(normalized.profile.id)) {
        store.putProfile(normalized.profile);
        result.importedProfiles += 1;
      }
      for (const fact of normalized.facts) {
        if (store.getFact(fact.id)) continue;
        store.putFact(fact);
        result.importedFacts += 1;
      }
      for (const recap of normalized.recaps) {
        if (store.getRecap(recap.id)) continue;
        store.putRecap(recap);
        result.importedRecaps += 1;
      }
    }

    if (normalized.candidate && !store.getCandidate(normalized.candidate.id)) {
      store.putCandidate(normalized.candidate);
      result.importedCandidates += 1;
    }
  }

  return result;
}
