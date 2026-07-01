import { timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";

import { getConfigDir, loadConfig } from "../storage/config.js";
import {
  LiveRealtimeBrokerError,
  mintOpenAIRealtimeClientSecret,
  type LiveRealtimeClientSecretParams,
} from "./live-realtime-broker.js";

const INTERNAL_OPENAI_REALTIME_PATH = "/internal/provider/openai/realtime/client-secret";
const INTERNAL_OPENAI_PREFIX = "/internal/provider/openai";
const INTERNAL_ANTHROPIC_PREFIX = "/internal/provider/anthropic";
const INTERNAL_CANARY_PATH = "/internal/provider/canary";

export function isProviderGatewayPath(pathname: string): boolean {
  return pathname === INTERNAL_OPENAI_REALTIME_PATH
    || pathname === INTERNAL_CANARY_PATH
    || pathname.startsWith(`${INTERNAL_OPENAI_PREFIX}/v1/`)
    || pathname.startsWith(`${INTERNAL_ANTHROPIC_PREFIX}/`);
}

export async function handleProviderGatewayRequest(req: Request, url: URL): Promise<Response> {
  if (!isAuthorizedProviderGatewayRequest(req)) {
    return Response.json({ ok: false, error: "Invalid or missing provider gateway token" }, { status: 401 });
  }

  if (url.pathname === INTERNAL_OPENAI_REALTIME_PATH && req.method === "POST") {
    return handleOpenAIRealtimeMint(req);
  }

  if (url.pathname === INTERNAL_CANARY_PATH && (req.method === "GET" || req.method === "POST")) {
    return handleProviderCanary(req, url);
  }

  if (url.pathname.startsWith(`${INTERNAL_OPENAI_PREFIX}/`)) {
    return proxyOpenAI(req, url);
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
    const budget = consumeProviderBudget({
      provider: "openai",
      subject,
      units: envFloat("HAWKY_PROVIDER_OPENAI_REALTIME_MINT_UNITS", 1),
    });
    const payload = await mintOpenAIRealtimeClientSecret(body, {
      quotaKey: `provider:${subject}`,
      allowProviderGatewayForward: false,
    });
    return Response.json({ ...payload, provider_budget: budget });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof LiveRealtimeBrokerError
      ? err.status
      : err instanceof ProviderBudgetExceededError
        ? err.status
        : 500;
    return Response.json({ ok: false, error: message }, { status });
  }
}

async function proxyOpenAI(req: Request, url: URL): Promise<Response> {
  try {
    const cfg = loadConfig();
    const apiKey = process.env.OPENAI_API_KEY || cfg.api_keys?.openai || "";
    if (!apiKey) {
      return Response.json({ ok: false, error: "OpenAI provider key is not configured on the control gateway" }, { status: 503 });
    }

    const upstreamPath = url.pathname.slice(INTERNAL_OPENAI_PREFIX.length) || "/";
    if (!upstreamPath.startsWith("/v1/")) {
      return Response.json({ ok: false, error: "OpenAI proxy only allows /v1 routes" }, { status: 404 });
    }
    const subject = sanitizeProviderSubject(req.headers.get("X-Hawky-Provider-Subject") ?? "");
    consumeProviderBudget({
      provider: "openai",
      subject,
      units: estimateOpenAIUnits(req),
    });

    const target = new URL(`${openAIUpstreamBaseURL()}${upstreamPath}${url.search}`);
    const headers = buildOpenAIUpstreamHeaders(req.headers, apiKey);
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof ProviderBudgetExceededError ? err.status : 500;
    return Response.json({ ok: false, error: message }, { status });
  }
}

async function proxyAnthropic(req: Request, url: URL): Promise<Response> {
  try {
    const cfg = loadConfig();
    const apiKey = process.env.ANTHROPIC_API_KEY || cfg.api_keys?.anthropic || "";
    if (!apiKey) {
      return Response.json({ ok: false, error: "Anthropic provider key is not configured on the control gateway" }, { status: 503 });
    }

    const upstreamPath = url.pathname.slice(INTERNAL_ANTHROPIC_PREFIX.length) || "/";
    if (!upstreamPath.startsWith("/v1/")) {
      return Response.json({ ok: false, error: "Anthropic proxy only allows /v1 routes" }, { status: 404 });
    }
    const subject = sanitizeProviderSubject(req.headers.get("X-Hawky-Provider-Subject") ?? "");
    consumeProviderBudget({
      provider: "anthropic",
      subject,
      units: estimateAnthropicUnits(req),
    });

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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof ProviderBudgetExceededError ? err.status : 500;
    return Response.json({ ok: false, error: message }, { status });
  }
}

async function handleProviderCanary(req: Request, url: URL): Promise<Response> {
  try {
    const provider = sanitizeProviderName(url.searchParams.get("provider") ?? "openai");
    const subject = sanitizeProviderSubject(
      req.headers.get("X-Hawky-Provider-Subject")
        ?? url.searchParams.get("subject")
        ?? "canary",
    );
    const units = envFloat("HAWKY_PROVIDER_CANARY_UNITS", 0.01);
    const budget = consumeProviderBudget({ provider, subject, units });
    const live = url.searchParams.get("live") === "1" || url.searchParams.get("live") === "true";
    if (!live) {
      return Response.json({
        ok: true,
        provider,
        subject,
        live: false,
        provider_budget: budget,
      });
    }

    if (provider === "openai") {
      const cfg = loadConfig();
      const apiKey = process.env.OPENAI_API_KEY || cfg.api_keys?.openai || "";
      if (!apiKey) return Response.json({ ok: false, error: "OpenAI provider key is not configured on the control gateway" }, { status: 503 });
      const upstream = await fetch(`${openAIUpstreamBaseURL()}/v1/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
      });
      return Response.json({ ok: upstream.ok, provider, subject, live: true, upstream_status: upstream.status, provider_budget: budget }, { status: upstream.ok ? 200 : 502 });
    }

    const cfg = loadConfig();
    const apiKey = process.env.ANTHROPIC_API_KEY || cfg.api_keys?.anthropic || "";
    if (!apiKey) return Response.json({ ok: false, error: "Anthropic provider key is not configured on the control gateway" }, { status: 503 });
    const upstream = await fetch(`${(process.env.HAWKY_ANTHROPIC_BASE_URL || cfg.api_base_url || "https://api.anthropic.com").replace(/\/+$/, "")}/v1/messages`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: process.env.HAWKY_PROVIDER_CANARY_ANTHROPIC_MODEL || "claude-haiku-4-5",
        max_tokens: 1,
        messages: [{ role: "user", content: "ok" }],
      }),
    });
    return Response.json({ ok: upstream.ok, provider, subject, live: true, upstream_status: upstream.status, provider_budget: budget }, { status: upstream.ok ? 200 : 502 });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const status = err instanceof ProviderBudgetExceededError ? err.status : 500;
    return Response.json({ ok: false, error: message }, { status });
  }
}

function buildOpenAIUpstreamHeaders(input: Headers, apiKey: string): Headers {
  const headers = new Headers();
  for (const name of [
    "accept",
    "content-type",
    "idempotency-key",
    "openai-beta",
    "openai-organization",
    "openai-project",
    "openai-safety-identifier",
  ]) {
    const value = input.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Authorization", `Bearer ${apiKey}`);
  return headers;
}

function openAIUpstreamBaseURL(): string {
  return (process.env.HAWKY_OPENAI_BASE_URL || "https://api.openai.com").replace(/\/+$/, "");
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
  for (const name of ["cache-control", "content-type", "request-id", "x-request-id"]) {
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

function sanitizeProviderName(raw: string): "openai" | "anthropic" {
  return raw.trim().toLowerCase() === "anthropic" ? "anthropic" : "openai";
}

type ProviderName = "openai" | "anthropic";

interface ProviderBudgetFile {
  days: Record<string, Record<string, { units: number; requests: number; updatedAt: string }>>;
}

interface ProviderBudgetUse {
  provider: ProviderName;
  subject: string;
  units: number;
}

class ProviderBudgetExceededError extends Error {
  readonly status = 429;
}

function consumeProviderBudget(use: ProviderBudgetUse): { subject: string; provider: ProviderName; day: string; units: number; units_remaining: number; requests: number } {
  const day = new Date().toISOString().slice(0, 10);
  const subject = use.subject || "unknown";
  const provider = use.provider;
  const units = Math.max(0, use.units);
  const limit = provider === "openai"
    ? envFloat("HAWKY_PROVIDER_OPENAI_DAILY_UNITS", envFloat("HAWKY_PROVIDER_DAILY_UNITS", 100))
    : envFloat("HAWKY_PROVIDER_ANTHROPIC_DAILY_UNITS", envFloat("HAWKY_PROVIDER_DAILY_UNITS", 100));
  const storePath = process.env.HAWKY_PROVIDER_BUDGET_STORE || join(getConfigDir(), "state", "provider-budget.json");
  const store = readBudgetStore(storePath);
  store.days[day] ??= {};
  const key = `${provider}:${subject}`;
  const entry = store.days[day][key] ?? { units: 0, requests: 0, updatedAt: new Date().toISOString() };
  if (limit > 0 && entry.units + units > limit) {
    throw new ProviderBudgetExceededError(`${provider} provider daily budget exceeded for ${subject}.`);
  }
  entry.units += units;
  entry.requests += 1;
  entry.updatedAt = new Date().toISOString();
  store.days[day][key] = entry;
  writeBudgetStore(storePath, pruneBudgetStore(store));
  return {
    subject,
    provider,
    day,
    units: roundBudget(entry.units),
    units_remaining: roundBudget(Math.max(0, limit - entry.units)),
    requests: entry.requests,
  };
}

function estimateAnthropicUnits(req: Request): number {
  const configured = envFloat("HAWKY_PROVIDER_ANTHROPIC_REQUEST_UNITS", Number.NaN);
  if (Number.isFinite(configured)) return configured;
  const maxTokens = Number(req.headers.get("X-Hawky-Estimated-Max-Tokens") || "");
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    return Math.max(1, Math.ceil(maxTokens / 10_000));
  }
  return 1;
}

function estimateOpenAIUnits(req: Request): number {
  const configured = envFloat("HAWKY_PROVIDER_OPENAI_REQUEST_UNITS", Number.NaN);
  if (Number.isFinite(configured)) return configured;
  const maxTokens = Number(req.headers.get("X-Hawky-Estimated-Max-Tokens") || "");
  if (Number.isFinite(maxTokens) && maxTokens > 0) {
    return Math.max(1, Math.ceil(maxTokens / 10_000));
  }
  return 1;
}

function readBudgetStore(path: string): ProviderBudgetFile {
  try {
    if (!existsSync(path)) return { days: {} };
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ProviderBudgetFile;
    return parsed && typeof parsed === "object" && parsed.days ? parsed : { days: {} };
  } catch {
    return { days: {} };
  }
}

function writeBudgetStore(path: string, store: ProviderBudgetFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2) + "\n", { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
}

function pruneBudgetStore(store: ProviderBudgetFile): ProviderBudgetFile {
  const days = Object.keys(store.days).sort();
  while (days.length > 14) {
    const day = days.shift();
    if (day) delete store.days[day];
  }
  return store;
}

function envFloat(name: string, fallback: number): number {
  const raw = Number.parseFloat(process.env[name] || "");
  return Number.isFinite(raw) ? raw : fallback;
}

function roundBudget(value: number): number {
  return Math.round(value * 1000) / 1000;
}
