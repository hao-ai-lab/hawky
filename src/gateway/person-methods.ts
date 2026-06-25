// =============================================================================
// person.* RPC methods — model-facing person contract over the legacy DeepFace DB.
//
// This is the logical split before service split: gateway owns the person-shaped
// contract and normalization while DeepFace remains the compatibility backend.
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";
import {
  buildFaceIdentitySignal,
  deepFaceProfileToPersonToolPerson,
  deepFaceProfilesToPersonToolPeople,
  normalizeLegacyDeepFaceProfile,
  type LegacyDeepFaceProfile,
  type IdentityCandidate,
  type PersonIdentifyResult,
  type PersonListResult,
  type PersonRecallResult,
  type PersonUpdateProfileResult,
} from "../identity/person/index.js";
import { allowedUsesForIdentitySignal } from "../identity/core/index.js";
import { resolveDeepFaceURL } from "../tools/face_recognize.js";
import type { GatewayServer } from "./server.js";
import { MethodError } from "./methods.js";

const log = createSubsystemLogger("gateway/person-methods");

const REQUEST_TIMEOUT_MS = 20_000;

export function registerPersonMethods(server: GatewayServer): void {
  server.registerMethod("person.identify_current_frame", async (_conn, params) => {
    return identifyCurrentFrame(params);
  });
  server.registerMethod("person.list", async (_conn, params) => {
    return listPeople(params);
  });
  server.registerMethod("person.recall", async (_conn, params) => {
    return recallPerson(params);
  });
  server.registerMethod("person.update_profile", async (_conn, params) => {
    return updatePersonProfile(params);
  });
  server.registerMethod("person.confirm_candidate", () => {
    throw new MethodError("NOT_IMPLEMENTED", "Identity candidate persistence is not available yet.");
  });
  server.registerMethod("person.reject_candidate", () => {
    throw new MethodError("NOT_IMPLEMENTED", "Identity candidate persistence is not available yet.");
  });
}

export async function identifyCurrentFrame(params: unknown): Promise<PersonIdentifyResult> {
  const p = recordParams(params);
  const imageBase64 = stringParam(p.image_base64, "image_base64");
  const sessionKey = optionalStringParam(p.session_key);
  const result = await callDeepFace("/identify", { image_base64: imageBase64 });
  if (!result.ok) {
    throw new MethodError("UNAVAILABLE", result.error);
  }
  const data = result.data;
  if (!truthy(data.found)) {
    return {
      ok: true,
      found: false,
      reason: "no_match",
      message: "No one on camera matches a person you've met.",
    };
  }

  const rawPerson = objectOrUndefined(data.person);
  if (!rawPerson) {
    throw new MethodError("INVALID_RESPONSE", "DeepFace identify response omitted person.");
  }
  const confidence = numberOr(data.similarity, 0.5);
  const person = deepFaceProfileToPersonToolPerson(rawPerson as LegacyDeepFaceProfile, {
    includeStructured: shouldIncludeStructured(p),
  });
  if (!person) {
    const normalized = normalizeLegacyDeepFaceProfile(rawPerson as LegacyDeepFaceProfile, {
      defaultConfidence: confidence,
    });
    if (normalized.candidate) {
      return {
        ok: true,
        found: false,
        candidate: normalized.candidate,
        candidate_id: normalized.candidate.id,
        reason: "candidate_like_legacy_unknown",
        message: "This face matches an unconfirmed identity candidate, not a named person yet.",
      };
    }
    return {
      ok: true,
      found: false,
      reason: "candidate_like_legacy_unknown",
      message: "The matching legacy profile is unknown and needs review before it becomes a person.",
    };
  }

  const subject = { type: "person" as const, personId: person.id };
  const identitySignal = buildFaceIdentitySignal({
    id: `face_sig_identify_${person.id}_${Date.now()}`,
    signalType: "face_match",
    subject,
    sourceSession: sessionKey ? { sessionKey } : undefined,
    evidenceRefs: sessionKey ? undefined : [{ type: "tool_result", id: `deepface_identify:${person.id}` }],
    confidence,
    review: { state: "unreviewed" },
    allowedUses: allowedUsesForIdentitySignal({
      subject,
      reviewState: "unreviewed",
      confidence,
    }),
    metadata: {
      personId: person.id,
      deepfaceProfileId: person.id,
      service: "deepface",
      similarity: typeof data.similarity === "number" ? data.similarity : undefined,
    },
  });

  return {
    ok: true,
    found: true,
    person,
    identity_signal: identitySignal,
  };
}

export async function listPeople(params: unknown = {}): Promise<PersonListResult> {
  const p = params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
  const includeStructured = shouldIncludeStructured(p);
  const includeCandidates = p.include_candidates === true;
  const result = await callDeepFace("/people", {});
  if (!result.ok) {
    log.debug("person.list service unavailable", { error: result.error });
    return {
      ok: true,
      available: false,
      people: [],
      note: "Face database service is not running.",
    };
  }
  const peopleRaw = Array.isArray(result.data.people) ? result.data.people : [];
  return {
    ok: true,
    available: true,
    people: deepFaceProfilesToPersonToolPeople(peopleRaw, { includeStructured }),
    ...(includeCandidates ? { candidates: deepFaceProfilesToIdentityCandidates(peopleRaw) } : {}),
  };
}

export async function recallPerson(params: unknown): Promise<PersonRecallResult> {
  const p = recordParams(params);
  const query = stringParam(p.name, "name").toLowerCase();
  const listed = await listPeople({ include_structured: shouldIncludeStructured(p) });
  if (!listed.available) {
    return { ok: true, found: false };
  }
  const exact = listed.people.find((person) => person.name.toLowerCase() === query);
  const partial = exact ?? listed.people.find((person) => person.name.toLowerCase().includes(query));
  return partial ? { ok: true, found: true, person: partial } : { ok: true, found: false };
}

export async function updatePersonProfile(params: unknown): Promise<PersonUpdateProfileResult> {
  const p = recordParams(params);
  let personId = optionalStringParam(p.id ?? p.person_id);
  const name = optionalStringParam(p.name);
  const imageBase64 = optionalStringParam(p.image_base64);
  const facts = stringArrayParam(p.facts);
  const recap = optionalStringParam(p.recap);
  if (!name && facts.length === 0 && !recap) {
    throw new MethodError("INVALID_REQUEST", "name, facts, or recap is required.");
  }
  if (!personId) {
    if (!name || !imageBase64) {
      throw new MethodError("INVALID_REQUEST", "id is required unless name and image_base64 are provided.");
    }
    const enrolled = await callDeepFace("/enroll", {
      image_base64: imageBase64,
      name,
      person_id: null,
    });
    if (!enrolled.ok) {
      throw new MethodError("UNAVAILABLE", enrolled.error);
    }
    const enrolledPerson = objectOrUndefined(enrolled.data.person);
    const enrolledId = enrolledPerson ? optionalStringParam(enrolledPerson.id) : undefined;
    if (!enrolledPerson || !enrolledId) {
      throw new MethodError("INVALID_RESPONSE", "DeepFace enroll response omitted person id.");
    }
    personId = enrolledId;
    if (facts.length === 0 && !recap) {
      const person = deepFaceProfileToPersonToolPerson(enrolledPerson as LegacyDeepFaceProfile, {
        includeStructured: shouldIncludeStructured(p),
      });
      if (!person) {
        throw new MethodError("INVALID_RESPONSE", "Enrolled profile did not become a named person.");
      }
      return { ok: true, person };
    }
  }

  const result = await callDeepFace("/update", {
    person_id: personId,
    name: name ?? null,
    facts: facts.length > 0 ? facts : null,
    recap: recap ?? null,
  });
  if (!result.ok) {
    throw new MethodError("UNAVAILABLE", result.error);
  }

  const rawPerson = objectOrUndefined(result.data.person);
  if (!rawPerson) {
    throw new MethodError("INVALID_RESPONSE", "DeepFace update response omitted person.");
  }
  const person = deepFaceProfileToPersonToolPerson(rawPerson as LegacyDeepFaceProfile, {
    includeStructured: shouldIncludeStructured(p),
  });
  if (!person) {
    throw new MethodError("INVALID_RESPONSE", "Updated legacy profile is still an unknown candidate.");
  }
  return { ok: true, person };
}

function shouldIncludeStructured(params: Record<string, unknown>): boolean {
  return params.include_structured === true;
}

function deepFaceProfilesToIdentityCandidates(rawProfiles: unknown[]): IdentityCandidate[] {
  return rawProfiles.flatMap((raw) => {
    const profile = objectOrUndefined(raw);
    if (!profile) return [];
    const normalized = normalizeLegacyDeepFaceProfile(profile as LegacyDeepFaceProfile);
    return normalized.candidate ? [normalized.candidate] : [];
  });
}

async function callDeepFace(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string }> {
  const url = `${resolveDeepFaceURL()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      return { ok: false, error: `DeepFace service HTTP ${resp.status}.` };
    }
    const data = await resp.json().catch(() => null);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return { ok: false, error: "DeepFace returned a malformed response." };
    }
    const record = data as Record<string, unknown>;
    if (record.ok === false) {
      return { ok: false, error: `DeepFace error: ${record.error ?? "unknown"}` };
    }
    return { ok: true, data: record };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

function recordParams(params: unknown): Record<string, unknown> {
  if (!params || typeof params !== "object" || Array.isArray(params)) {
    throw new MethodError("INVALID_REQUEST", "params must be an object.");
  }
  return params as Record<string, unknown>;
}

function stringParam(value: unknown, label: string): string {
  const text = optionalStringParam(value);
  if (!text) {
    throw new MethodError("INVALID_REQUEST", `${label} is required.`);
  }
  return text;
}

function optionalStringParam(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function stringArrayParam(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function truthy(value: unknown): boolean {
  return value === true;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
