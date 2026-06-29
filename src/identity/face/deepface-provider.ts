import { loadConfig } from "../../storage/config.js";
import type {
  FaceIndexProfile,
  FaceIndexClearResult,
  FaceProfileWriteResult,
  FaceSignalProvider,
  FaceProviderErrorCode,
  FaceProviderRequestOptions,
} from "./provider.js";

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

export class DeepFaceFaceSignalProvider implements FaceSignalProvider {
  async identifyFrame(input: { imageBase64: string; abortSignal?: AbortSignal }) {
    const result = await callDeepFace("/identify", { image_base64: input.imageBase64 }, input.abortSignal);
    if (!result.ok) return result;
    if (result.data.found !== true) return { ok: true as const, found: false as const };
    const profile = objectOrUndefined(result.data.person);
    if (!profile) {
      return {
        ok: false as const,
        code: "INVALID_RESPONSE" as const,
        error: "DeepFace returned a malformed face profile (/identify person must be an object).",
      };
    }
    return {
      ok: true as const,
      found: true as const,
      profile: profile as FaceIndexProfile,
      similarity: numberOrUndefined(result.data.similarity),
    };
  }

  async listFaceProfiles(input: FaceProviderRequestOptions = {}) {
    const result = await callDeepFace("/people", {}, input.abortSignal);
    if (!result.ok) return result;
    if (!Array.isArray(result.data.people)) {
      return {
        ok: false as const,
        code: "INVALID_RESPONSE" as const,
        error: "DeepFace returned a malformed face profile (/people people must be an array).",
      };
    }
    return {
      ok: true as const,
      profiles: result.data.people,
    };
  }

  async enrollOrLinkTemplate(input: {
    imageBase64: string;
    label: string;
    profileId?: string | null;
    abortSignal?: AbortSignal;
  }) {
    const result = await callDeepFace(
      "/enroll",
      {
        image_base64: input.imageBase64,
        name: input.label,
        person_id: input.profileId ?? null,
      },
      input.abortSignal,
    );
    return writeProfileResult(result, "/enroll person");
  }

  async updateFaceProfileLabel(input: { profileId: string; label: string; abortSignal?: AbortSignal }) {
    const result = await callDeepFace(
      "/update",
      {
        person_id: input.profileId,
        name: input.label,
        facts: null,
        recap: null,
      },
      input.abortSignal,
    );
    return writeProfileResult(result, "/update person");
  }

  async clearIndex(input: FaceProviderRequestOptions = {}): Promise<FaceIndexClearResult> {
    const result = await callDeepFace("/clear", {}, input.abortSignal);
    if (!result.ok) return result;
    return {
      ok: true,
      removed: numberOrUndefined(result.data.removed) ?? 0,
    };
  }
}

async function callDeepFace(
  path: string,
  body: Record<string, unknown>,
  abortSignal?: AbortSignal,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; error: string; code?: FaceProviderErrorCode }> {
  const url = `${resolveDeepFaceURL()}${path}`;
  if (abortSignal?.aborted) {
    return { ok: false, code: "UNAVAILABLE", error: "cancelled before starting." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  abortSignal?.addEventListener("abort", onAbort, { once: true });

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
      return { ok: false, code: "INVALID_RESPONSE", error: "DeepFace returned a malformed response." };
    }
    const record = data as Record<string, unknown>;
    if (record.ok === false) {
      return { ok: false, error: `DeepFace error: ${record.error ?? "unknown"}` };
    }
    return { ok: true, data: record };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error: `Could not reach the DeepFace service at ${url} (${msg}). Start it (services/deepface/README.md) or set DEEPFACE_URL.`,
    };
  } finally {
    clearTimeout(timer);
    abortSignal?.removeEventListener("abort", onAbort);
  }
}

function objectOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function writeProfileResult(
  result: Awaited<ReturnType<typeof callDeepFace>>,
  profileLabel: string,
): FaceProfileWriteResult {
  if (!result.ok) return result;
  const profile = objectOrUndefined(result.data.person);
  if (!profile) {
    return {
      ok: false,
      code: "INVALID_RESPONSE",
      error: `DeepFace returned a malformed face profile (${profileLabel} must be an object).`,
    };
  }
  return { ok: true, profile: profile as FaceIndexProfile };
}