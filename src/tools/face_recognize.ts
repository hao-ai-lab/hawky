// =============================================================================
// face_recognize Tools — DeepFace-backed face recognition (#627).
//
// DeepFace owns matching + retrieval (DeepFace.find/verify over a server-side face
// DB). These tools wrap the stateful DeepFace microservice (services/deepface) the
// same way web_search wraps Brave: outbound fetch, DEEPFACE_URL config, graceful
// degradation. iOS sends a face crop and gets back an identity; it enrolls new
// people and updates their profiles here.
//
//   face_identify → POST /identify   ({image_base64})       → {found, person?, similarity?}
//   face_enroll   → POST /enroll      ({image_base64,name?,person_id?}) → {person}
//   face_update   → POST /update      ({person_id,name?,facts?,recap?})  → {person}
//   face_people   → POST /people      ()                     → {people}
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
  const p = r.data.person;
  return {
    type: "text",
    content: `Matched ${p.name}.`,
    metadata: { found: true, person: p, similarity: r.data.similarity ?? null },
  };
}

export const faceIdentifyToolDefinition: ToolDefinition<IdentifyInput> = {
  name: "face_identify",
  description:
    "Identify a person from a face image against the on-server face database (DeepFace). " +
    "Returns the matched person (name, facts, recaps) or found:false.",
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
  return { type: "text", content: `Enrolled ${r.data.person.name}.`, metadata: { person: r.data.person } };
}

export const faceEnrollToolDefinition: ToolDefinition<EnrollInput> = {
  name: "face_enroll",
  description:
    "Enroll a face into the server face database (DeepFace). Creates a new identity, or adds a crop " +
    "to an existing one when person_id is given. Returns the person record.",
  input_schema: {
    type: "object",
    properties: {
      image_base64: { type: "string", description: "Base64 JPEG/PNG of the face." },
      name: { type: "string", description: "Person's name (default 'Unknown')." },
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
  const r = await callService(
    "/update",
    { person_id: id, name: input.name ?? null, facts: input.facts ?? null, recap: input.recap ?? null },
    context,
  );
  if (!r.ok) return r.result;
  return { type: "text", content: `Updated ${r.data.person.name}.`, metadata: { person: r.data.person } };
}

export const faceUpdateToolDefinition: ToolDefinition<UpdateInput> = {
  name: "face_update",
  description:
    "Update a person's profile in the face database: set their name, add facts, or append a one-line " +
    "recap of this conversation (to recall next time).",
  input_schema: {
    type: "object",
    properties: {
      person_id: { type: "string", description: "The person's id (from identify/enroll)." },
      name: { type: "string", description: "Set/update the name." },
      facts: { type: "array", items: { type: "string", description: "A fact about the person." }, description: "Facts to add." },
      recap: { type: "string", description: "One-line recap of this conversation." },
    },
    required: ["person_id"],
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
  const people = r.data.people ?? [];
  return { type: "text", content: `${people.length} known people.`, metadata: { people } };
}

export const facePeopleToolDefinition: ToolDefinition = {
  name: "face_people",
  description: "List everyone in the face database (names + facts + last recap).",
  input_schema: { type: "object", properties: {} },
  permission: "auto_approve",
  execute: executeFacePeople as any,
};

// -----------------------------------------------------------------------------
// face_clear — wipe the whole person database (People Database tab Clear button)
// -----------------------------------------------------------------------------
export async function executeFaceClear(_input: Record<string, never>, context: ToolContext): Promise<ToolResult> {
  const r = await callService("/clear", {}, context);
  if (!r.ok) return r.result;
  return { type: "text", content: `Cleared ${r.data.removed ?? 0} people.`, metadata: { removed: r.data.removed ?? 0 } };
}

export const faceClearToolDefinition: ToolDefinition = {
  name: "face_clear",
  description: "Erase ALL people from the face database. Destructive — only when the user explicitly asks to clear/reset the people database.",
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
