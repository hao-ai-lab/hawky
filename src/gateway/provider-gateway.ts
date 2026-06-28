import { timingSafeEqual } from "node:crypto";

import { loadConfig } from "../storage/config.js";
import {
  LiveRealtimeBrokerError,
  mintOpenAIRealtimeClientSecret,
  type LiveRealtimeClientSecretParams,
} from "./live-realtime-broker.js";

const INTERNAL_OPENAI_REALTIME_PATH = "/internal/provider/openai/realtime/client-secret";
const INTERNAL_ANTHROPIC_PREFIX = "/internal/provider/anthropic";

export function isProviderGatewayPath(pathname: string): boolean {
  return pathname === INTERNAL_OPENAI_REALTIME_PATH || pathname.startsWith(`${INTERNAL_ANTHROPIC_PREFIX}/`);
}

export async function handleProviderGatewayRequest(req: Request, url: URL): Promise<Response> {
  if (!isAuthorizedProviderGatewayRequest(req)) {
    return Response.json({ ok: false, error: "Invalid or missing provider gateway token" }, { status: 401 });
  }

  if (url.pathname === INTERNAL_OPENAI_REALTIME_PATH && req.method === "POST") {
    return handleOpenAIRealtimeMint(req);
  }

  if (url.pathname.startsWith(`${INTERNAL_ANTHROPIC_PREFIX}/`)) {
    return proxyAnthropic(req, url);
  }

  return Response.json({ ok: false, error: "Provider gateway route not found" }, { status: 404 });
}

function isAuthorizedProviderGatewayRequest(req: Request): boolean {
  const expected = (process.env.HAWKY_PROVIDER_GATEWAY_TOKEN || "").trim();
  if (!expected) return false;

  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice("Bearer ".length).trim() : "";
  const xApiKey = (req.headers.get("X-API-Key") ?? req.headers.get("x-api-key") ?? "").trim();
  return secureEqual(bearer, expected) || secureEqual(xApiKey, expected);
}

function secureEqual(actual: string, expected: string): boolean {
  if (!actual || !expected) return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

async function handleOpenAIRealtimeMint(req: Request): Promise<Response> {
  try {
    const body = (await req.json().catch(() => ({}))) as LiveRealtimeClientSecretParams;
    const subject = sanitizeProviderSubject(req.headers.get("X-Hawky-Provider-Subject") ?? "");
    const payload = await mintOpenAIRealtimeClientSecret(body, {
      quotaKey: `provider:${subject}`,
      allowProviderGatewayForward: false,
    });
    return Response.json(payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof LiveRealtimeBrokerError ? err.status : 500;
    return Response.json({ ok: false, error: message }, { status });
  }
}

async function proxyAnthropic(req: Request, url: URL): Promise<Response> {
  const cfg = loadConfig();
  const apiKey = process.env.ANTHROPIC_API_KEY || cfg.api_keys?.anthropic || "";
  if (!apiKey) {
    return Response.json({ ok: false, error: "Anthropic provider key is not configured on the control gateway" }, { status: 503 });
  }

  const upstreamPath = url.pathname.slice(INTERNAL_ANTHROPIC_PREFIX.length) || "/";
  if (!upstreamPath.startsWith("/v1/")) {
    return Response.json({ ok: false, error: "Anthropic proxy only allows /v1 routes" }, { status: 404 });
  }

  const baseURL = (process.env.HAWKY_ANTHROPIC_BASE_URL || cfg.api_base_url || "https://api.anthropic.com").replace(/\/+$/, "");
  const target = new URL(`${baseURL}${upstreamPath}${url.search}`);
  const headers = buildAnthropicUpstreamHeaders(req.headers, apiKey);
  const upstream = await fetch(target, {
    method: req.method,
    headers,
    body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body,
    signal: req.signal,
  });

  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: filterUpstreamResponseHeaders(upstream.headers),
  });
}

function buildAnthropicUpstreamHeaders(input: Headers, apiKey: string): Headers {
  const headers = new Headers();
  for (const name of ["accept", "anthropic-beta", "anthropic-version", "content-type"]) {
    const value = input.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("x-api-key", apiKey);
  return headers;
}

function filterUpstreamResponseHeaders(input: Headers): Headers {
  const headers = new Headers();
  for (const name of ["cache-control", "content-type", "request-id"]) {
    const value = input.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function sanitizeProviderSubject(raw: string): string {
  const subject = raw.trim();
  if (/^[a-zA-Z0-9:._@-]{1,120}$/.test(subject)) return subject;
  return "unknown";
}
