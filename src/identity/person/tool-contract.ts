import type {
  FaceIdentitySignal,
  IdentityCandidate,
  PersonFact,
  PersonProfile,
  PersonRecap,
} from "./contracts.js";

export const PERSON_MODEL_TOOL_NAMES = [
  "identify_person",
  "list_people",
  "recall_person",
  "update_person_profile",
  "confirm_identity_candidate",
  "reject_identity_candidate",
] as const;
export type PersonModelToolName = (typeof PERSON_MODEL_TOOL_NAMES)[number];

export const PERSON_RPC_METHODS = [
  "person.identify_current_frame",
  "person.list",
  "person.recall",
  "person.update_profile",
  "person.confirm_candidate",
  "person.reject_candidate",
  "person.clear",
] as const;
export type PersonRpcMethod = (typeof PERSON_RPC_METHODS)[number];

export interface PersonToolJsonSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties: false;
}

export interface PersonModelToolDefinition {
  type: "function";
  name: PersonModelToolName;
  description: string;
  parameters: PersonToolJsonSchema;
}

export const PERSON_MODEL_TOOLS: readonly PersonModelToolDefinition[] = [
  {
    type: "function",
    name: "identify_person",
    description:
      "Identify the person currently on camera when the user asks who someone is. The client attaches the current frame; the model does not provide image bytes.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "list_people",
    description: "List people the assistant has met, with compact facts and last recap.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    type: "function",
    name: "recall_person",
    description: "Recall a person by name. Use identify_person instead for the person currently on camera.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "The person's name." },
      },
      required: ["name"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "update_person_profile",
    description:
      "Save or update information about a person: set their name, add facts, or append a one-line recap. Use this for other people, not memory_append.",
    parameters: {
      type: "object",
      properties: {
        id: { type: "string", description: "The person id from identify_person, list_people, or a candidate promotion." },
        name: { type: "string", description: "The person's name." },
        facts: { type: "array", items: { type: "string" }, description: "Facts to add about this person." },
        recap: { type: "string", description: "One-line recap to remember about the interaction." },
      },
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "confirm_identity_candidate",
    description: "Confirm or promote an identity candidate after the user explicitly verifies who it is. Current implementation requires a name; merging into a different existing person is not available yet.",
    parameters: {
      type: "object",
      properties: {
        candidate_id: { type: "string", description: "The candidate id to confirm." },
        person_id: { type: "string", description: "Optional existing person id to merge into." },
        name: { type: "string", description: "Name to use when creating a new person profile." },
      },
      required: ["candidate_id", "name"],
      additionalProperties: false,
    },
  },
  {
    type: "function",
    name: "reject_identity_candidate",
    description: "Reject or suppress an identity candidate that should not become a person profile.",
    parameters: {
      type: "object",
      properties: {
        candidate_id: { type: "string", description: "The candidate id to reject." },
        reason: { type: "string", description: "Optional reason for audit/debugging." },
      },
      required: ["candidate_id"],
      additionalProperties: false,
    },
  },
] as const;

export interface PersonToolRecapSummary {
  summary: string;
  at?: string;
}

export interface PersonToolStructuredRecords {
  profile?: PersonProfile;
  candidate?: IdentityCandidate;
  facts: PersonFact[];
  recaps: PersonRecap[];
  faceSignals: FaceIdentitySignal[];
  warnings: string[];
}

export interface PersonToolPerson {
  id: string;
  name: string;
  facts: string[];
  recaps: PersonToolRecapSummary[];
  lastRecap?: string;
  created_at?: string;
  last_seen_at?: string;
  thumbnail?: string;
  structured?: PersonToolStructuredRecords;
}

export type PersonIdentifyResult =
  | {
      ok: true;
      found: true;
      person: PersonToolPerson;
      identity_signal?: FaceIdentitySignal;
      say_to_user?: string;
    }
  | {
      ok: true;
      found: false;
      candidate?: IdentityCandidate;
      candidate_id?: string;
      reason?: string;
      suppressed?: boolean;
      no_enroll?: boolean;
      message?: string;
    };

export interface PersonListResult {
  ok: true;
  available: boolean;
  people: PersonToolPerson[];
  candidates?: IdentityCandidate[];
  note?: string;
}

export type PersonRecallResult =
  | { ok: true; found: true; person: PersonToolPerson }
  | { ok: true; found: false };

export interface PersonUpdateProfileResult {
  ok: true;
  person: PersonToolPerson;
}

export type PersonCandidateReviewResult =
  | { ok: false; error: string }
  | { ok: true; candidate: IdentityCandidate; person?: PersonToolPerson };

export interface PersonClearResult {
  ok: true;
  cleared: {
    profiles: number;
    facts: number;
    recaps: number;
    candidates: number;
    tombstones: number;
    candidate_reviews: number;
    legacy_face_profiles?: number;
  };
  legacy?: { ok: true; removed: number } | { ok: false; error: string };
}

export function personToolForName(name: PersonModelToolName): PersonModelToolDefinition {
  const tool = PERSON_MODEL_TOOLS.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Unknown person model tool: ${name}`);
  }
  return tool;
}
