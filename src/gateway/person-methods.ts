// =============================================================================
// person.* RPC methods — model-facing person contract over the face backend.
//
// Gateway/PersonService own the person-shaped contract and normalization while
// DeepFace remains a compatibility backend for face matching/enrollment.
// =============================================================================

import {
  FilePersonCandidateReviewStore,
  FilePersonStore,
  PersonService,
  PersonServiceError,
  type PersonIdentifyResult,
  type PersonListResult,
  type PersonRecallResult,
  type PersonCandidateReviewResult,
  type PersonClearResult,
  type PersonUpdateProfileResult,
} from "../identity/person/index.js";
import { DeepFaceFaceSignalProvider } from "../identity/face/index.js";
import type { GatewayServer } from "./server.js";
import { MethodError } from "./methods.js";

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
    new DeepFaceFaceSignalProvider(),
    new FilePersonCandidateReviewStore(),
    { personStore: new FilePersonStore() },
  );
  return defaultService;
}

export function resetDefaultPersonServiceForTests(): void {
  defaultService = undefined;
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

function personMethodError(error: unknown): MethodError {
  if (error instanceof MethodError) return error;
  if (error instanceof PersonServiceError) {
    return new MethodError(error.code, error.message);
  }
  return new MethodError("INVALID_REQUEST", error instanceof Error ? error.message : String(error));
}