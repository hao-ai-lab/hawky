// =============================================================================
// face_recognize Tools — DeepFace-backed face signal compatibility (#627).
//
// DeepFace owns matching + retrieval (DeepFace.find/verify over a server-side face
// DB). These tools wrap the stateful DeepFace microservice (services/deepface) the
// same way web_search wraps Brave: outbound fetch, DEEPFACE_URL config, graceful
// degradation. This compatibility surface is face-index only: it must not expose
// or write person facts/recaps. Person profile ownership lives behind person.* RPCs.
//
//   face_identify → POST /identify   ({image_base64})       → {found, face_profile?, similarity?}
//   face_enroll   → POST /enroll      ({image_base64,name?,person_id?}) → {face_profile}
//   face_update   → POST /update      ({person_id,name})     → {face_profile}  (legacy label only)
//   face_people   → POST /people      ()                     → {face_profiles}
// =============================================================================

import { loadConfig } from "../storage/config.js";
import type { ToolDefinition, ToolContext, ToolResult } from "../agent/types.js";

const DEFAULT_DEEPFACE_URL = "http://127.0.0.1:8099";
const REQUEST_TIMEOUT_MS = 20_000;

export function resolveDeepFaceURL(): string {
  const fromEnv = process.env.DEEPFACE_URL?.trim();
  if (fromEnv) return fromEnv.replace(/\/$/, "");
  try {
    const cfg = loadConfig() as { api_urls?: { deepface?: string } };
    const fromCfg = cfg.api_urls?.deepface?.trim();
    if (fromCfg) return fromCfg.replace(/\/$/, "");
  } catch {
    /* config unavailable */
  }
  return DEFAULT_DEEPFACE_URL;
}

/** POST JSON to a DeepFace endpoint, returning the parsed body or an error result. */
async function callService(
  path: string,
  body: Record<string, unknown>,
  context: ToolContext,
): Promise<{ ok: true; data: any } | { ok: false; result: ToolResult }> {
  if (context.abort_signal.aborted) {
    return { ok: false, result: { type: "error", content: "cancelled before starting." } };
  }
  const url = `${resolveDeepFaceURL()}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  context.abort_signal.addEventListener("abort", onAbort, { once: true });
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      return { ok: false, result: { type: "error", content: `DeepFace service HTTP ${resp.status}.` } };
    }
    const data = await resp.json();
    if (data && data.ok === false) {
      return { ok: false, result: { type: "error", content: `DeepFace error: ${data.error ?? "unknown"}` } };
    }
    return { ok: true, data };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      result: {
        type: "error",
        content: `Could not reach the DeepFace service at ${url} (${msg}). Start it (services/deepface/README.md) or set DEEPFACE_URL.`,
      },
    };
  } finally {
    clearTimeout(timer);
    context.abort_signal.removeEventListener("abort", onAbort);
  }
}

// -----------------------------------------------------------------------------
// face_identify
// -----------------------------------------------------------------------------
interface IdentifyInput { image_base64: string }

export async function executeFaceIdentify(input: IdentifyInput, context: ToolContext): Promise<ToolResult> {
  const image = typeof input.image_base64 === "string" ? input.image_base64.trim() : "";
  if (!image) return { type: "error", content: "Missing required parameter: image_base64" };
  const r = await callService("/identify", { image_base64: image }, context);
  if (!r.ok) return r.result;
  if (!r.data.found) {
    return { type: "text", content: "No known person matched this face.", metadata: { found: false } };
  }
  const parsed = sanitizeFaceProfile(r.data.person, "/identify person");
  if (!parsed.ok) return parsed.result;
  const p = parsed.profile;
  return {
    type: "text",
    content: `Matched ${p.name}.`,
    metadata: {
      found: true,
      person: p,
      face_profile: p,
      similarity: r.data.similarity ?? null,
    },
  };
}

export const faceIdentifyToolDefinition: ToolDefinition<IdentifyInput> = {
  name: "face_identify",
  description:
    "Identify a face image against the on-server face index (DeepFace). " +
    "Returns a sanitized face profile/match only; use person.* tools for facts and recaps.",
  input_schema: {
    type: "object",
    properties: { image_base64: { type: "string", description: "Base64 JPEG/PNG of a face crop or frame." } },
    required: ["image_base64"],
  },
  permission: "auto_approve",
  execute: executeFaceIdentify as any,
};

// -----------------------------------------------------------------------------
// face_enroll
// -----------------------------------------------------------------------------
interface EnrollInput { image_base64: string; name?: string; person_id?: string }

export async function executeFaceEnroll(input: EnrollInput, context: ToolContext): Promise<ToolResult> {
  const image = typeof input.image_base64 === "string" ? input.image_base64.trim() : "";
  if (!image) return { type: "error", content: "Missing required parameter: image_base64" };
  const r = await callService(
    "/enroll",
    { image_base64: image, name: input.name ?? "Unknown", person_id: input.person_id ?? null },
    context,
  );
  if (!r.ok) return r.result;
  const parsed = sanitizeFaceProfile(r.data.person, "/enroll person");
  if (!parsed.ok) return parsed.result;
  const p = parsed.profile;
  return { type: "text", content: `Enrolled ${p.name}.`, metadata: { person: p, face_profile: p } };
}

export const faceEnrollToolDefinition: ToolDefinition<EnrollInput> = {
  name: "face_enroll",
  description:
    "Enroll a face into the server face index (DeepFace). Creates or updates a face-profile label only. " +
    "Use person.update_profile for person facts and recaps.",
  input_schema: {
    type: "object",
    properties: {
      image_base64: { type: "string", description: "Base64 JPEG/PNG of the face." },
      name: { type: "string", description: "Legacy face-profile label (default 'Unknown')." },
      person_id: { type: "string", description: "Add the crop to this existing identity instead of creating one." },
    },
    required: ["image_base64"],
  },
  permission: "auto_approve",
  execute: executeFaceEnroll as any,
};

// -----------------------------------------------------------------------------
// face_update
// -----------------------------------------------------------------------------
interface UpdateInput { person_id: string; name?: string; facts?: string[]; recap?: string }

export async function executeFaceUpdate(input: UpdateInput, context: ToolContext): Promise<ToolResult> {
  const id = typeof input.person_id === "string" ? input.person_id.trim() : "";
  if (!id) return { type: "error", content: "Missing required parameter: person_id" };
  if ((Array.isArray(input.facts) && input.facts.length > 0) || (typeof input.recap === "string" && input.recap.trim())) {
    return {
      type: "error",
      content: "face_update no longer writes person facts or recaps; use person.update_profile instead.",
    };
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) {
    return {
      type: "error",
      content: "face_update only supports legacy face-profile labels; use person.update_profile for person data.",
    };
  }
  const r = await callService(
    "/update",
    { person_id: id, name, facts: null, recap: null },
    context,
  );
  if (!r.ok) return r.result;
  const parsed = sanitizeFaceProfile(r.data.person, "/update person");
  if (!parsed.ok) return parsed.result;
  const p = parsed.profile;
  return { type: "text", content: `Updated face profile ${p.name}.`, metadata: { person: p, face_profile: p } };
}

export const faceUpdateToolDefinition: ToolDefinition<UpdateInput> = {
  name: "face_update",
  description:
    "Compatibility-only face-profile label update. Does not write person facts or recaps; " +
    "use person.update_profile for person data.",
  input_schema: {
    type: "object",
    properties: {
      person_id: { type: "string", description: "The person's id (from identify/enroll)." },
      name: { type: "string", description: "Set/update the legacy face-profile label." },
    },
    required: ["person_id", "name"],
  },
  permission: "auto_approve",
  execute: executeFaceUpdate as any,
};

// -----------------------------------------------------------------------------
// face_people
// -----------------------------------------------------------------------------
export async function executeFacePeople(_input: Record<string, never>, context: ToolContext): Promise<ToolResult> {
  const r = await callService("/people", {}, context);
  if (!r.ok) return r.result;
  if (!Array.isArray(r.data.people)) {
    return malformedFaceProfileResult("/people people must be an array");
  }
  const people: Record<string, unknown>[] = [];
  for (const [index, raw] of r.data.people.entries()) {
    const parsed = sanitizeFaceProfile(raw, `/people people[${index}]`);
    if (!parsed.ok) return parsed.result;
    people.push(parsed.profile);
  }
  return {
    type: "text",
    content: `${people.length} face profiles.`,
    metadata: { people, face_profiles: people },
  };
}

export const facePeopleToolDefinition: ToolDefinition = {
  name: "face_people",
  description: "List sanitized face-index profiles only. Use people.list or person.list for person facts and recaps.",
  input_schema: { type: "object", properties: {} },
  permission: "auto_approve",
  execute: executeFacePeople as any,
};

function sanitizeFaceProfile(
  value: unknown,
  label: string,
): { ok: true; profile: Record<string, unknown> } | { ok: false; result: ToolResult } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, result: malformedFaceProfileResult(`${label} must be an object`) };
  }
  const raw = value as Record<string, unknown>;
  const id = stringOrUndefined(raw.id);
  if (!id) {
    return { ok: false, result: malformedFaceProfileResult(`${label} is missing id`) };
  }
  const name = stringOrUndefined(raw.name) ?? "Unknown";
  const profile: Record<string, unknown> = { id, name };
  const thumbnail = stringOrUndefined(raw.thumbnail);
  if (thumbnail) profile.thumbnail = thumbnail;
  const createdAt = stringOrUndefined(raw.created_at);
  if (createdAt) profile.created_at = createdAt;
  const lastSeenAt = stringOrUndefined(raw.last_seen_at);
  if (lastSeenAt) profile.last_seen_at = lastSeenAt;
  return { ok: true, profile };
}

function malformedFaceProfileResult(message: string): ToolResult {
  return {
    type: "error",
    content: `DeepFace returned a malformed face profile (${message}).`,
  };
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

// -----------------------------------------------------------------------------
// face_clear — wipe the whole legacy face index
// -----------------------------------------------------------------------------
export async function executeFaceClear(_input: Record<string, never>, context: ToolContext): Promise<ToolResult> {
  const r = await callService("/clear", {}, context);
  if (!r.ok) return r.result;
  return { type: "text", content: `Cleared ${r.data.removed ?? 0} face profiles.`, metadata: { removed: r.data.removed ?? 0 } };
}

export const faceClearToolDefinition: ToolDefinition = {
  name: "face_clear",
  description: "Erase ALL entries from the legacy face index. Destructive — only when the user explicitly asks to clear/reset face recognition data.",
  input_schema: { type: "object", properties: {} },
  permission: "auto_approve",
  execute: executeFaceClear as any,
};

// -----------------------------------------------------------------------------
// assess_hazard — Safety Check (#648)
//
// A SILENT vision classifier that runs OFF the realtime model. iOS samples camera
// frames and calls this directly (via the gateway tool RPC); the vision service
// (POST /assess_hazard) returns {severity, kind, warning}. The realtime
// conversation never sees this — it's a separate pipeline that only surfaces a
// spoken warning on a real, gated hazard.
// -----------------------------------------------------------------------------
interface AssessHazardInput { image_base64: string }

export async function executeAssessHazard(input: AssessHazardInput, context: ToolContext): Promise<ToolResult> {
  const image = typeof input.image_base64 === "string" ? input.image_base64.trim() : "";
  if (!image) return { type: "error", content: "Missing required parameter: image_base64" };
  const r = await callService("/assess_hazard", { image_base64: image }, context);
  if (!r.ok) return r.result;
  const severity = typeof r.data.severity === "string" ? r.data.severity : "none";
  const kind = typeof r.data.kind === "string" ? r.data.kind : "";
  const warning = typeof r.data.warning === "string" ? r.data.warning : "";
  return {
    type: "text",
    content: severity === "none" ? "No hazard." : `Hazard (${severity}): ${warning}`,
    metadata: { severity, kind, warning },
  };
}

export const assessHazardToolDefinition: ToolDefinition<AssessHazardInput> = {
  name: "assess_hazard",
  description:
    "Safety Check (#648): classify a single camera frame for a dangerous situation (fire, gas, sharp/hot " +
    "kitchen hazards, etc). Silent vision check off the realtime model. Returns {severity: none|low|medium|high, " +
    "kind, warning}. severity:'none' means nothing concerning.",
  input_schema: {
    type: "object",
    properties: { image_base64: { type: "string", description: "Base64 JPEG/PNG of the camera frame." } },
    required: ["image_base64"],
  },
  permission: "auto_approve",
  execute: executeAssessHazard as any,
};
