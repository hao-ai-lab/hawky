// =============================================================================
// person.* RPC methods — model-facing person contract over the face backend.
//
// Gateway/PersonService own the person-shaped contract and normalization while
// DeepFace remains a compatibility backend for face matching/enrollment.
// =============================================================================

import { createSubsystemLogger } from "../logging/index.js";
import {
  FilePersonCandidateReviewStore,
  FilePersonStore,
  PersonService,
  PersonServiceError,
  type LegacyDeepFaceProfile,
  type LegacyPersonRepository,
  type PersonIdentifyResult,
  type PersonListResult,
  type PersonRecallResult,
  type PersonCandidateReviewResult,
  type PersonClearResult,
  type PersonUpdateProfileResult,
} from "../identity/person/index.js";
import { resolveDeepFaceURL } from "../tools/face_recognize.js";
import type { GatewayServer } from "./server.js";
import { MethodError } from "./methods.js";

const log = createSubsystemLogger("gateway/person-methods");

const REQUEST_TIMEOUT_MS = 20_000;

let defaultService: PersonService | undefined;

export function registerPersonMethods(server: GatewayServer, service?: PersonService): void {
  server.registerMethod("person.identify_current_frame", async (_conn, params) => {
    return identifyCurrentFrame(params, service ?? getDefaultPersonService());
  });
  server.registerMethod("person.list", async (_conn, params) => {
    return listPeople(params, service ?? getDefaultPersonService());
  });
  server.registerMethod("person.recall", async (_conn, params) => {
    return recallPerson(params, service ?? getDefaultPersonService());
  });
  server.registerMethod("person.update_profile", async (_conn, params) => {
    return updatePersonProfile(params, service ?? getDefaultPersonService());
  });
  server.registerMethod("person.confirm_candidate", async (_conn, params) => {
    return confirmCandidate(params, service ?? getDefaultPersonService());
  });
  server.registerMethod("person.reject_candidate", async (_conn, params) => {
    return rejectCandidate(params, service ?? getDefaultPersonService());
  });
  server.registerMethod("person.clear", async (_conn, params) => {
    return clearPeople(params, service ?? getDefaultPersonService());
  });
}

export async function identifyCurrentFrame(
  params: unknown,
  service = getDefaultPersonService(),
): Promise<PersonIdentifyResult> {
  const p = recordParams(params);
  try {
    return await service.identifyCurrentFrame({
      imageBase64: stringParam(p.image_base64, "image_base64"),
      sessionKey: optionalStringParam(p.session_key),
      includeStructured: shouldIncludeStructured(p),
    });
  } catch (error) {
    throw personMethodError(error);
  }
}

export async function listPeople(
  params: unknown = {},
  service = getDefaultPersonService(),
): Promise<PersonListResult> {
  const p = params && typeof params === "object" && !Array.isArray(params)
    ? (params as Record<string, unknown>)
    : {};
  return service.listPeople({
    includeStructured: shouldIncludeStructured(p),
    includeCandidates: p.include_candidates === true,
  });
}

export async function recallPerson(
  params: unknown,
  service = getDefaultPersonService(),
): Promise<PersonRecallResult> {
  const p = recordParams(params);
  return service.recallPerson({
    name: stringParam(p.name, "name"),
    includeStructured: shouldIncludeStructured(p),
  });
}

export async function updatePersonProfile(
  params: unknown,
  service = getDefaultPersonService(),
): Promise<PersonUpdateProfileResult> {
  const p = recordParams(params);
  try {
    return await service.updateProfile({
      id: optionalStringParam(p.id ?? p.person_id),
      name: optionalStringParam(p.name),
      imageBase64: optionalStringParam(p.image_base64),
      facts: stringArrayParam(p.facts),
      recap: optionalStringParam(p.recap),
      sessionKey: optionalStringParam(p.session_key),
      includeStructured: shouldIncludeStructured(p),
    });
  } catch (error) {
    throw personMethodError(error);
  }
}

export async function confirmCandidate(
  params: unknown,
  service = getDefaultPersonService(),
): Promise<PersonCandidateReviewResult> {
  const p = recordParams(params);
  try {
    return await service.confirmCandidate({
      candidateId: stringParam(p.candidate_id ?? p.candidateId, "candidate_id"),
      name: optionalStringParam(p.name),
      personId: optionalStringParam(p.person_id ?? p.personId),
      reason: optionalStringParam(p.reason),
      sessionKey: optionalStringParam(p.session_key),
      includeStructured: shouldIncludeStructured(p),
    });
  } catch (error) {
    throw personMethodError(error);
  }
}

export async function rejectCandidate(
  params: unknown,
  service = getDefaultPersonService(),
): Promise<PersonCandidateReviewResult> {
  const p = recordParams(params);
  try {
    return await service.rejectCandidate({
      candidateId: stringParam(p.candidate_id ?? p.candidateId, "candidate_id"),
      reason: optionalStringParam(p.reason),
      sessionKey: optionalStringParam(p.session_key),
    });
  } catch (error) {
    throw personMethodError(error);
  }
}

export async function clearPeople(
  params: unknown = {},
  service = getDefaultPersonService(),
): Promise<PersonClearResult> {
  if (params !== undefined && params !== null && (typeof params !== "object" || Array.isArray(params))) {
    throw new MethodError("INVALID_REQUEST", "params must be an object.");
  }
  try {
    return await service.clearPeople();
  } catch (error) {
    throw personMethodError(error);
  }
}

function shouldIncludeStructured(params: Record<string, unknown>): boolean {
  return params.include_structured === true;
}

export function getDefaultPersonService(): PersonService {
  defaultService ??= new PersonService(
    new DeepFaceLegacyPersonRepository(),
    new FilePersonCandidateReviewStore(),
    { personStore: new FilePersonStore() },
  );
  return defaultService;
}

export function resetDefaultPersonServiceForTests(): void {
  defaultService = undefined;
}

class DeepFaceLegacyPersonRepository implements LegacyPersonRepository {
  async identify(imageBase64: string) {
    const result = await callDeepFace("/identify", { image_base64: imageBase64 });
    if (!result.ok) return result;
    if (!truthy(result.data.found)) return { ok: true as const, found: false as const };
    const person = objectOrUndefined(result.data.person);
    if (!person) {
      return { ok: false as const, code: "INVALID_RESPONSE" as const, error: "DeepFace identify response omitted person." };
    }
    return {
      ok: true as const,
      found: true as const,
      person: person as LegacyDeepFaceProfile,
      similarity: numberOrUndefined(result.data.similarity),
    };
  }

  async listPeople() {
    const result = await callDeepFace("/people", {});
    if (!result.ok) {
      log.debug("person.list service unavailable", { error: result.error });
      return result;
    }
    return {
      ok: true as const,
      people: Array.isArray(result.data.people) ? result.data.people : [],
    };
  }

  async enroll(input: { imageBase64: string; name: string; personId?: string | null }) {
    const result = await callDeepFace("/enroll", {
      image_base64: input.imageBase64,
      name: input.name,
      person_id: input.personId ?? null,
    });
    return writeResult(result, "DeepFace enroll response omitted person.");
  }

  async update(input: { personId: string; name?: string | null }) {
    const result = await callDeepFace("/update", {
      person_id: input.personId,
      name: input.name ?? null,
      facts: null,
      recap: null,
    });
    return writeResult(result, "DeepFace update response omitted person.");
  }

  async clearPeople() {
    const result = await callDeepFace("/clear", {});
    if (!result.ok) return result;
    return {
      ok: true as const,
      removed: numberOrUndefined(result.data.removed) ?? 0,
    };
  }
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

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function writeResult(
  result: Awaited<ReturnType<typeof callDeepFace>>,
  missingMessage: string,
) {
  if (!result.ok) return result;
  const person = objectOrUndefined(result.data.person);
  if (!person) {
    return { ok: false as const, code: "INVALID_RESPONSE" as const, error: missingMessage };
  }
  return { ok: true as const, person: person as LegacyDeepFaceProfile };
}

function personMethodError(error: unknown): MethodError {
  if (error instanceof MethodError) return error;
  if (error instanceof PersonServiceError) {
    return new MethodError(error.code, error.message);
  }
  return new MethodError("INVALID_REQUEST", error instanceof Error ? error.message : String(error));
}
