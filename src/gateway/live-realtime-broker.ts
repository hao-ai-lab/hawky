import { loadConfig } from "../storage/config.js";
import { getPrompt } from "../prompts/index.js";

export type LiveRealtimeClientSecretParams = {
  model?: string;
  instructions?: string;
  reasoning_effort?: string;
  max_response_output_tokens?: number | "inf";
  tool_choice?: string;
  parallel_tool_calls?: boolean;
  expires_after_seconds?: number;
  /**
   * Optional "bring your own key" OpenAI API key supplied by a browser client
   * (the hosted web demo). When present and well-formed it is used to mint the
   * realtime client secret INSTEAD of the gateway's configured key, so a public
   * demo never has to ship or share a server-side key. The key is used for this
   * single upstream call and is never persisted or logged.
   */
  byok_api_key?: string;
};

export type LiveRealtimeClientSecretResponse = {
  ok: boolean;
  model?: string;
  websocket_url?: string;
  client_secret?: unknown;
  error?: string;
};

export type LiveRealtimeBrokerOptions = {
  quotaKey?: string;
  allowProviderGatewayForward?: boolean;
};

export class LiveRealtimeBrokerError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "LiveRealtimeBrokerError";
    this.status = status;
  }
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const realtimeMintQuotas = new Map<string, {
  hourStart: number;
  hourCount: number;
  dayStart: number;
  dayCount: number;
}>();

type RealtimeApiKeySelection = {
  apiKey: string;
  byokApiKey: string;
};

type RealtimeClientSecretRequest = {
  model: string;
  body: {
    session: Record<string, unknown>;
    expires_after: {
      anchor: "created_at";
      seconds: number;
    };
  };
};

export async function mintOpenAIRealtimeClientSecret(
  params: LiveRealtimeClientSecretParams,
  options: LiveRealtimeBrokerOptions = {},
): Promise<LiveRealtimeClientSecretResponse> {
  const cfg = loadConfig();
  const keySelection = selectRealtimeApiKey(params, cfg.api_keys?.openai);
  if (!keySelection.apiKey) {
    if (!keySelection.byokApiKey && options.allowProviderGatewayForward !== false) {
      const gatewayResponse = await mintViaProviderGateway(params, options);
      if (gatewayResponse) return gatewayResponse;
    }
    throw new LiveRealtimeBrokerError(
      "No OpenAI API key available. Add your own key in Settings (BYOK) or configure one on the gateway.",
      400,
    );
  }
  if (!keySelection.byokApiKey) {
    enforceRealtimeMintQuota(options.quotaKey ?? "unknown");
  }

  const request = buildRealtimeClientSecretRequest(params);

  const upstream = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${keySelection.apiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "hawky-live-lab",
    },
    body: JSON.stringify(request.body),
  });

  const payload = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const message = extractOpenAIError(payload) ?? `OpenAI returned HTTP ${upstream.status}`;
    throw new LiveRealtimeBrokerError(message, upstream.status);
  }

  return {
    ok: true,
    model: request.model,
    websocket_url: `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(request.model)}`,
    client_secret: payload,
  };
}

export function resetRealtimeMintQuotaForTests(): void {
  realtimeMintQuotas.clear();
}

function selectRealtimeApiKey(
  params: LiveRealtimeClientSecretParams,
  configuredKey: string | undefined,
): RealtimeApiKeySelection {
  // Prefer a caller-supplied "bring your own key" (hosted web demo) when it is
  // well-formed. If a non-empty BYOK value is supplied but malformed, reject it
  // instead of silently consuming the gateway's configured key.
  const byok = sanitizeByokKey(params.byok_api_key);
  return {
    apiKey: byok || process.env.OPENAI_API_KEY || configuredKey || "",
    byokApiKey: byok,
  };
}

function buildRealtimeClientSecretRequest(
  params: LiveRealtimeClientSecretParams,
): RealtimeClientSecretRequest {
  const model = sanitizeRealtimeModel(params.model);
  const session: Record<string, unknown> = {
    type: "realtime",
    model,
    instructions: params.instructions || getPrompt("realtime.live.default"),
    audio: {
      output: { voice: "alloy" },
    },
  };
  const reasoningEffort = sanitizeReasoningEffort(params.reasoning_effort);
  if (reasoningEffort) {
    session.reasoning = { effort: reasoningEffort };
  }
  // NOTE: `max_response_output_tokens` is intentionally NOT sent. The OpenAI
  // Realtime client-secrets session schema rejects it with
  // `Unknown parameter: 'session.max_response_output_tokens'` (verified live
  // against the API). The param is still accepted on the method for backward
  // compatibility but is sanitized-and-dropped here rather than forwarded.
  void sanitizeMaxResponseOutputTokens(params.max_response_output_tokens);
  session.tool_choice = sanitizeToolChoice(params.tool_choice);
  session.parallel_tool_calls = params.parallel_tool_calls !== false;

  return {
    model,
    body: {
      session,
      expires_after: {
        anchor: "created_at",
        seconds: sanitizeClientSecretTTL(params.expires_after_seconds),
      },
    },
  };
}

/**
 * Validate a caller-supplied BYOK key. Returns the trimmed key when it looks
 * like an OpenAI secret key (`sk-…`). Missing or blank input is treated as
 * absent; malformed non-empty input is rejected so it cannot accidentally fall
 * back to the gateway-configured key.
 */
function sanitizeByokKey(raw: string | undefined): string {
  const key = (raw ?? "").trim();
  if (!key) return "";
  // OpenAI keys start with "sk-" (incl. "sk-proj-…"); enforce a sane length and
  // charset so we never forward obviously-bogus input to the OpenAI API.
  if (/^sk-[A-Za-z0-9_-]{20,200}$/.test(key)) return key;
  throw new LiveRealtimeBrokerError("Invalid BYOK OpenAI API key format.", 400);
}

function sanitizeRealtimeModel(raw: string | undefined): string {
  const model = (raw || "gpt-realtime-2").trim();
  if (/^gpt-realtime[\w.-]*$/.test(model)) {
    return model;
  }
  return "gpt-realtime-2";
}

function sanitizeReasoningEffort(raw: string | undefined): "none" | "low" | "medium" | "high" | "xhigh" | null {
  const effort = (raw || "low").trim().toLowerCase();
  switch (effort) {
  case "none":
  case "low":
  case "medium":
  case "high":
  case "xhigh":
    return effort as "none" | "low" | "medium" | "high" | "xhigh";
  default:
    return null;
  }
}

function sanitizeMaxResponseOutputTokens(raw: number | "inf" | undefined): number | "inf" {
  if (raw === "inf") return "inf";
  if (!Number.isFinite(raw)) return "inf";
  return Math.min(Math.max(Math.round(raw!), 1), 4096);
}

function sanitizeToolChoice(raw: string | undefined): "auto" | "none" | "required" {
  const choice = (raw || "auto").trim().toLowerCase();
  switch (choice) {
  case "none":
  case "required":
    return choice;
  default:
    return "auto";
  }
}

function clampClientSecretTTL(value: number): number {
  return Math.min(Math.max(Math.round(value), 10), 7200);
}

function sanitizeClientSecretTTL(raw: number | undefined): number {
  const max = clampClientSecretTTL(envInt("HAWKY_REALTIME_MAX_CLIENT_SECRET_TTL_SECONDS", 600));
  if (!Number.isFinite(raw)) return max;
  return Math.min(clampClientSecretTTL(raw!), max);
}

function extractOpenAIError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (!error || typeof error !== "object") return null;
  const message = (error as { message?: unknown }).message;
  return typeof message === "string" && message.trim() ? message : null;
}

async function mintViaProviderGateway(
  params: LiveRealtimeClientSecretParams,
  options: LiveRealtimeBrokerOptions,
): Promise<LiveRealtimeClientSecretResponse | null> {
  const baseUrl = (process.env.HAWKY_PROVIDER_GATEWAY_URL || "").trim();
  const token = (process.env.HAWKY_PROVIDER_GATEWAY_TOKEN || "").trim();
  if (!baseUrl || !token) return null;

  const target = new URL("/internal/provider/openai/realtime/client-secret", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const upstream = await fetch(target, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-Hawky-Provider-Subject": options.quotaKey ?? "unknown",
    },
    body: JSON.stringify({ ...params, byok_api_key: undefined }),
  });
  const payload = await upstream.json().catch(() => null);
  if (!upstream.ok) {
    const message = extractOpenAIError(payload) ?? extractJsonError(payload) ?? `Provider gateway returned HTTP ${upstream.status}`;
    throw new LiveRealtimeBrokerError(message, upstream.status);
  }
  return payload as LiveRealtimeClientSecretResponse;
}

function extractJsonError(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  return typeof error === "string" && error.trim() ? error : null;
}

function enforceRealtimeMintQuota(rawKey: string): void {
  const perHour = envInt("HAWKY_REALTIME_MINTS_PER_HOUR", 12);
  const perDay = envInt("HAWKY_REALTIME_MINTS_PER_DAY", 50);
  if (perHour <= 0 && perDay <= 0) return;

  const now = Date.now();
  const key = rawKey.trim() || "unknown";
  const entry = realtimeMintQuotas.get(key) ?? {
    hourStart: now,
    hourCount: 0,
    dayStart: now,
    dayCount: 0,
  };
  if (now - entry.hourStart >= HOUR_MS) {
    entry.hourStart = now;
    entry.hourCount = 0;
  }
  if (now - entry.dayStart >= DAY_MS) {
    entry.dayStart = now;
    entry.dayCount = 0;
  }
  if (perHour > 0 && entry.hourCount >= perHour) {
    throw new LiveRealtimeBrokerError("Realtime gateway hourly limit reached.", 429);
  }
  if (perDay > 0 && entry.dayCount >= perDay) {
    throw new LiveRealtimeBrokerError("Realtime gateway daily limit reached.", 429);
  }
  entry.hourCount += 1;
  entry.dayCount += 1;
  realtimeMintQuotas.set(key, entry);
}

function envInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}
