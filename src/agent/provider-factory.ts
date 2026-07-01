// =============================================================================
// LLM Provider Factory
//
// Single source of truth for instantiating the right provider based on
// config. Two call sites today (src/index.ts for the main gateway and
// src/gateway/heartbeat.ts for the background heartbeat service) —
// keep them consistent by going through here.
// =============================================================================

import type { HawkyConfig } from "./types.js";
import type { LLMProvider } from "./provider.js";
import { AnthropicProvider } from "./anthropic_provider.js";
import { VertexProvider } from "./vertex_provider.js";
import { OpenAIProvider } from "./openai_provider.js";
import { LLMError } from "./provider.js";

function providerSubjectHeaders(): Record<string, string> | undefined {
  const subject = (process.env.HAWKY_PROVIDER_SUBJECT || "").trim();
  if (!subject) return undefined;
  if (!/^[a-zA-Z0-9:._@-]{1,120}$/.test(subject)) return undefined;
  return { "X-Hawky-Provider-Subject": subject };
}

/**
 * Build an LLM provider from config. Throws a friendly LLMError with
 * a link to deploy/VERTEX_SETUP.md when the Vertex path is requested
 * but missing required config.
 */
export function createProvider(config: HawkyConfig): LLMProvider {
  const provider = config.provider ?? "anthropic";

  if (provider === "openai_compatible") {
    const compat = config.openai_compatible;
    if (!compat?.active_profile) {
      throw new LLMError("auth_error", "openai_compatible: active_profile is empty");
    }
    const profile = compat.profiles?.[compat.active_profile];
    if (!profile) {
      throw new LLMError("auth_error", `openai_compatible: profile "${compat.active_profile}" not found`);
    }
    if (!profile.base_url) {
      throw new LLMError("auth_error", `openai_compatible: profile "${compat.active_profile}" has empty base_url`);
    }
    // Key resolution chain: literal -> env-var-by-name -> api_keys.openai -> OPENAI_API_KEY env -> error.
    const apiKey =
      profile.api_key ||
      (profile.api_key_env ? process.env[profile.api_key_env] : "") ||
      config.api_keys?.openai ||
      process.env.OPENAI_API_KEY ||
      "";
    if (!apiKey) {
      throw new LLMError(
        "auth_error",
        `openai_compatible: no API key resolvable for profile "${compat.active_profile}" (set api_key, api_key_env, api_keys.openai, or OPENAI_API_KEY)`,
      );
    }
    return new OpenAIProvider(apiKey, { baseURL: profile.base_url });
  }

  if (provider === "openai") {
    const apiKey = process.env.OPENAI_API_KEY || config.api_keys?.openai || "";
    if (!apiKey) {
      throw new LLMError(
        "auth_error",
        "OpenAI API key is empty. Set OPENAI_API_KEY env var or api_keys.openai in ~/.hawky/config.json.",
      );
    }
    const baseURL = config.openai_base_url || undefined;
    return new OpenAIProvider(apiKey, { baseURL });
  }

  if (provider === "vertex") {
    const vertex = config.vertex;
    if (!vertex?.project_id) {
      throw new LLMError(
        "auth_error",
        "provider is set to 'vertex' but vertex.project_id is empty. " +
          "Set it in ~/.hawky/config.json. See deploy/VERTEX_SETUP.md " +
          "for the full GCP setup.",
      );
    }
    return new VertexProvider({
      projectId: vertex.project_id,
      region: vertex.region ?? "global",
    });
  }

  // Default: direct Anthropic API
  const apiKey = config.api_keys?.anthropic;
  if (!apiKey) {
    throw new LLMError(
      "auth_error",
      "Anthropic API key is empty. Set api_keys.anthropic in " +
        "~/.hawky/config.json, or switch to the Vertex provider " +
        "(see deploy/VERTEX_SETUP.md).",
    );
  }
  return new AnthropicProvider(apiKey, {
    baseURL: config.api_base_url,
    defaultHeaders: providerSubjectHeaders(),
  });
}
