// =============================================================================
// API Key Validators
//
// Lightweight validation functions for each supported API provider.
// Each makes a minimal test API call and returns { valid, error? }.
// Used by the /setup wizard and /doctor health check.
// =============================================================================

import Anthropic from "@anthropic-ai/sdk";
import { AuthenticationError } from "@anthropic-ai/sdk/error";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const VALIDATION_TIMEOUT_MS = 10_000;

const BRAVE_API_URL = "https://api.search.brave.com/res/v1/web/search";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

// -----------------------------------------------------------------------------
// Anthropic key validation
// -----------------------------------------------------------------------------

/**
 * Validate an Anthropic API key by making a minimal messages.create call.
 * Uses the cheapest model (haiku) with max_tokens: 1.
 */
export async function validateAnthropicKey(
  apiKey: string,
  baseURL?: string,
): Promise<ValidationResult> {
  if (!apiKey || !apiKey.trim()) {
    return { valid: false, error: "API key is empty" };
  }

  try {
    const client = new Anthropic({
      apiKey,
      baseURL: baseURL ?? "https://api.anthropic.com",
      timeout: VALIDATION_TIMEOUT_MS,
    });

    await client.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1,
      messages: [{ role: "user", content: "test" }],
    });

    return { valid: true };
  } catch (err: unknown) {
    if (err instanceof AuthenticationError) {
      return { valid: false, error: "Invalid API key" };
    }
    const message = err instanceof Error ? err.message : String(err);
    // Connection/timeout errors are not key-validity issues
    if (message.includes("timeout") || message.includes("ECONNREFUSED")) {
      return { valid: false, error: `Connection failed: ${message}` };
    }
    return { valid: false, error: message };
  }
}

// -----------------------------------------------------------------------------
// Brave Search key validation
// -----------------------------------------------------------------------------

/**
 * Validate a Brave Search API key by making a minimal search request.
 */
export async function validateBraveKey(
  apiKey: string,
): Promise<ValidationResult> {
  if (!apiKey || !apiKey.trim()) {
    return { valid: false, error: "API key is empty" };
  }

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), VALIDATION_TIMEOUT_MS);

    const url = new URL(BRAVE_API_URL);
    url.searchParams.set("q", "test");
    url.searchParams.set("count", "1");

    const response = await fetch(url.toString(), {
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (response.status === 401 || response.status === 403) {
      return { valid: false, error: "Invalid API key" };
    }
    if (!response.ok) {
      return { valid: false, error: `API returned status ${response.status}` };
    }

    return { valid: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("abort")) {
      return { valid: false, error: "Request timed out" };
    }
    return { valid: false, error: message };
  }
}

// -----------------------------------------------------------------------------
// OpenAI-compatible endpoint reachability
// -----------------------------------------------------------------------------

export interface EndpointReachabilityResult {
  valid: boolean;
  status?: number;
  modelCount?: number;
  latencyMs?: number;
  error?: string;
}

/**
 * Ping baseURL/v1/models and report reachability, model count, and latency.
 * Used by `hawky doctor` for openai / openai_compatible providers.
 */
export async function validateOpenAICompatibleEndpoint(
  baseURL: string,
  apiKey?: string,
): Promise<EndpointReachabilityResult> {
  // Strip trailing slash; append /models if baseURL already ends with /v1,
  // otherwise append /v1/models (covers both "http://host" and "http://host/v1" forms).
  const stripped = baseURL.replace(/\/+$/, "");
  const url = stripped.endsWith("/v1") ? `${stripped}/models` : `${stripped}/v1/models`;
  const headers: Record<string, string> = {};
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  const t0 = Date.now();
  try {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(3000),
    });
    const latencyMs = Date.now() - t0;
    const status = response.status;

    if (status === 404) {
      return {
        valid: true,
        status,
        latencyMs,
        error: "endpoint reachable but /v1/models not implemented (raw llama.cpp / older TGI)",
      };
    }
    if (status === 401) {
      return { valid: false, status, latencyMs, error: "auth rejected" };
    }
    if (!response.ok) {
      return { valid: false, status, latencyMs, error: `HTTP ${status}` };
    }

    let modelCount: number | undefined;
    let parseError: string | undefined;
    try {
      const body = await response.json() as { data?: unknown[] };
      if (Array.isArray(body.data)) {
        modelCount = body.data.length;
      } else {
        parseError = "endpoint returned 200 but no data array";
        modelCount = 0;
      }
    } catch {
      parseError = "endpoint returned 200 but response is not valid JSON";
      modelCount = 0;
    }

    return { valid: true, status, modelCount, latencyMs, error: parseError };
  } catch (err: unknown) {
    const latencyMs = Date.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    const isTimeout = msg.includes("timeout") || msg.includes("TimeoutError") ||
      (err instanceof Error && err.name === "TimeoutError");
    return {
      valid: false,
      latencyMs,
      error: isTimeout ? "timeout after 3s" : msg,
    };
  }
}

// -----------------------------------------------------------------------------
// OpenAI key validation
// -----------------------------------------------------------------------------

/**
 * Validate an OpenAI API key by listing models.
 */
export async function validateOpenAIKey(
  apiKey: string,
): Promise<ValidationResult> {
  if (!apiKey || !apiKey.trim()) {
    return { valid: false, error: "API key is empty" };
  }

  try {
    const response = await fetch(OPENAI_MODELS_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5_000),
    });

    if (response.status === 401) {
      return { valid: false, error: "Invalid API key" };
    }
    if (!response.ok) {
      return { valid: false, error: `API returned status ${response.status}` };
    }

    return { valid: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { valid: false, error: message };
  }
}
