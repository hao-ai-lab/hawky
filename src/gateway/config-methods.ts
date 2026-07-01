// =============================================================================
// Config RPC Method Handlers
//
// RPC methods for reading and updating global config from the web frontend:
//   config.get    — return sanitized config (no API keys)
//   config.update — validate and persist allowed config fields
// =============================================================================

import type { GatewayServer } from "./server.js";
import type { HeartbeatService } from "./heartbeat.js";
import type { AgentSessionManager } from "./agent-sessions.js";
import { loadConfig, updateConfig, resetConfig, DEFAULT_CONFIG, saveConfig } from "../storage/config.js";
import { normalizeProviderModels } from "../agent/model-compat.js";
import { MethodError } from "./methods.js";

// Fields that are NEVER exposed or settable via the web panel
const FORBIDDEN_KEYS = new Set([
  "api_keys", "api_base_url", "gateway_port", "gateway",
  "mcp_servers", "concurrency", "compaction",
  "logging", "setup_completed_at", "workspace_dir",
  "channels", // tokens must be set in config.json directly, not via web
]);

const VALID_EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function sanitizeConfig(config: ReturnType<typeof loadConfig>) {
  return {
    model: config.model ?? "claude-opus-4-7",
    provider: config.provider ?? "anthropic",
    openai_base_url: config.openai_base_url ?? "",
    vertex: {
      project_id: config.vertex?.project_id ?? "",
      region: config.vertex?.region ?? "global",
    },
    effort: config.effort ?? null,
    max_tokens: config.max_tokens ?? DEFAULT_CONFIG.max_tokens,
    max_iterations: config.max_iterations ?? DEFAULT_CONFIG.max_iterations,
    heartbeat: {
      enabled: config.heartbeat?.enabled ?? false,
      interval_minutes: config.heartbeat?.interval_minutes ?? 30,
      model: config.heartbeat?.model ?? null,
      active_hours: {
        start: config.heartbeat?.active_hours?.start ?? "08:00",
        end: config.heartbeat?.active_hours?.end ?? "22:00",
      },
      consolidation_enabled: false,
      delivery_target: config.heartbeat?.delivery_target ?? "web:general",
    },
    screenshots: {
      retention_days: config.screenshots?.retention_days ?? 30,
    },
    experiments: {
      agent_runtimes: config.experiments?.agent_runtimes === true,
    },
    channels: {
      slack: config.channels?.slack ? {
        enabled: config.channels.slack.enabled !== false,
        has_bot_token: !!config.channels.slack.bot_token,
        has_user_token: !!config.channels.slack.user_token,
        has_app_token: !!config.channels.slack.app_token,
        bind_to_session: config.channels.slack.bind_to_session ?? "web:general",
      } : null,
    },
    has_anthropic_key: Boolean(config.api_keys?.anthropic),
    has_openai_key: Boolean(config.api_keys?.openai),
    openai_compatible: {
      active_profile: config.openai_compatible?.active_profile ?? "",
      profile_names: Object.keys(config.openai_compatible?.profiles ?? {}),
      profiles: Object.fromEntries(
        Object.entries(config.openai_compatible?.profiles ?? {}).map(([name, p]) => [
          name,
          { model: p.model ?? "", base_url: p.base_url ?? "" },
        ]),
      ),
    },
  };
}

export function registerConfigMethods(
  server: GatewayServer,
  heartbeat?: HeartbeatService,
  agentSessions?: AgentSessionManager,
): void {
  // -------------------------------------------------------------------------
  // config.get — return sanitized config (no API keys)
  // -------------------------------------------------------------------------
  server.registerMethod("config.get", () => {
    return sanitizeConfig(loadConfig());
  });

  // -------------------------------------------------------------------------
  // config.update — validate and persist allowed config fields
  // -------------------------------------------------------------------------
  server.registerMethod("config.update", (_conn, params) => {
    const p = params as Record<string, unknown> | undefined;
    if (!p) throw new MethodError("INVALID_REQUEST", "params required");

    // Reject forbidden keys
    for (const key of Object.keys(p)) {
      if (FORBIDDEN_KEYS.has(key)) {
        throw new MethodError("FORBIDDEN", `Cannot update '${key}' via web panel`);
      }
    }

    // Build validated update payload
    const updates: Record<string, unknown> = {};

    if (p.model !== undefined) {
      if (typeof p.model !== "string" || !p.model.trim()) {
        throw new MethodError("INVALID_REQUEST", "model must be a non-empty string");
      }
      updates.model = p.model.trim();
    }

    if (p.provider !== undefined) {
      const VALID_PROVIDERS = new Set(["anthropic", "vertex", "openai", "openai_compatible"]);
      if (typeof p.provider !== "string" || !VALID_PROVIDERS.has(p.provider)) {
        throw new MethodError("INVALID_REQUEST", `provider must be one of: ${[...VALID_PROVIDERS].join(", ")}`);
      }
      updates.provider = p.provider;
    }

    if (p.openai_api_key !== undefined) {
      if (typeof p.openai_api_key !== "string") {
        throw new MethodError("INVALID_REQUEST", "openai_api_key must be a string");
      }
      updates.api_keys = { openai: p.openai_api_key };
    }

    if (p.openai_base_url !== undefined) {
      if (typeof p.openai_base_url !== "string") {
        throw new MethodError("INVALID_REQUEST", "openai_base_url must be a string");
      }
      updates.openai_base_url = p.openai_base_url;
    }

    if (p.openai_compatible !== undefined) {
      if (
        typeof p.openai_compatible !== "object" ||
        p.openai_compatible === null ||
        Array.isArray(p.openai_compatible)
      ) {
        throw new MethodError("INVALID_REQUEST", "openai_compatible must be an object");
      }
      const compat = p.openai_compatible as Record<string, unknown>;
      if (compat.profiles !== undefined) {
        throw new MethodError("FORBIDDEN", "openai_compatible.profiles cannot be updated via web panel");
      }
      if (compat.active_profile !== undefined) {
        if (typeof compat.active_profile !== "string") {
          throw new MethodError("INVALID_REQUEST", "openai_compatible.active_profile must be a string");
        }
        updates.openai_compatible = { active_profile: compat.active_profile };
      }
    }

    if (p.provider === "openai") {
      const incomingKey = typeof p.openai_api_key === "string" ? p.openai_api_key : undefined;
      const existingConfig = loadConfig();
      const resolvedKey = incomingKey || existingConfig.api_keys?.openai || process.env.OPENAI_API_KEY;
      if (!resolvedKey) {
        throw new MethodError(
          "INVALID_REQUEST",
          "OpenAI key required: set openai_api_key in this update or OPENAI_API_KEY env or api_keys.openai in config.json",
        );
      }
    }

    if (p.provider === "openai_compatible" || (p.openai_compatible !== undefined && loadConfig().provider === "openai_compatible")) {
      const existingConfig = loadConfig();
      const activeProfile =
        (typeof (updates.openai_compatible as Record<string, unknown> | undefined)?.active_profile === "string"
          ? (updates.openai_compatible as Record<string, unknown>).active_profile as string
          : undefined) ?? existingConfig.openai_compatible?.active_profile ?? "";
      const profiles = existingConfig.openai_compatible?.profiles ?? {};
      const profile = activeProfile ? (profiles[activeProfile] as unknown as Record<string, unknown> | undefined) : undefined;
      if (!activeProfile || !profile || !profile.base_url) {
        throw new MethodError(
          "INVALID_REQUEST",
          "openai_compatible requires an active_profile with a configured base_url; edit ~/.hawky/config.json or use /provider in a follow-up release",
        );
      }
    }

    if (p.effort !== undefined) {
      if (p.effort !== null && !VALID_EFFORTS.has(p.effort as string)) {
        throw new MethodError("INVALID_REQUEST", `effort must be one of: ${[...VALID_EFFORTS].join(", ")}`);
      }
      updates.effort = p.effort;
    }

    if (p.max_tokens !== undefined) {
      const n = Number(p.max_tokens);
      if (isNaN(n) || n < 1024 || n > 128000) {
        throw new MethodError("INVALID_REQUEST", "max_tokens must be 1024-128000");
      }
      updates.max_tokens = n;
    }

    if (p.max_iterations !== undefined) {
      const n = Number(p.max_iterations);
      if (isNaN(n) || n < 1 || n > 200) {
        throw new MethodError("INVALID_REQUEST", "max_iterations must be 1-200");
      }
      updates.max_iterations = n;
    }

    if (p.heartbeat !== undefined) {
      const hb = p.heartbeat as Record<string, unknown>;
      const hbUpdate: Record<string, unknown> = {};

      if (hb.enabled !== undefined) {
        hbUpdate.enabled = !!hb.enabled;
      }
      if (hb.interval_minutes !== undefined) {
        const mins = Number(hb.interval_minutes);
        if (isNaN(mins) || mins < 1 || mins > 1440) {
          throw new MethodError("INVALID_REQUEST", "interval_minutes must be 1-1440");
        }
        hbUpdate.interval_minutes = mins;
      }
      if (hb.model !== undefined) {
        hbUpdate.model = hb.model || null; // empty string = unset
      }
      if (hb.consolidation_enabled !== undefined) {
        hbUpdate.consolidation_enabled = !!hb.consolidation_enabled;
      }
      if (hb.delivery_target !== undefined) {
        if (typeof hb.delivery_target !== "string") {
          throw new MethodError("INVALID_REQUEST", "delivery_target must be a string");
        }
        hbUpdate.delivery_target = hb.delivery_target;
      }
      if (hb.active_hours !== undefined) {
        const ah = hb.active_hours as Record<string, unknown>;
        const timeRe = /^[0-2]\d:[0-5]\d$/;
        if (ah.start !== undefined) {
          if (typeof ah.start !== "string" || !timeRe.test(ah.start)) {
            throw new MethodError("INVALID_REQUEST", "active_hours.start must be HH:MM format");
          }
        }
        if (ah.end !== undefined) {
          if (typeof ah.end !== "string" || !timeRe.test(ah.end)) {
            throw new MethodError("INVALID_REQUEST", "active_hours.end must be HH:MM format");
          }
        }
        hbUpdate.active_hours = ah;
      }

      updates.heartbeat = hbUpdate;
    }

    if (p.screenshots !== undefined) {
      const ss = p.screenshots as Record<string, unknown>;
      if (ss.retention_days !== undefined) {
        const days = Number(ss.retention_days);
        if (isNaN(days) || days < 1 || days > 365) {
          throw new MethodError("INVALID_REQUEST", "retention_days must be 1-365");
        }
        updates.screenshots = { retention_days: days };
      }
    }

    if (p.experiments !== undefined) {
      if (
        typeof p.experiments !== "object" ||
        p.experiments === null ||
        Array.isArray(p.experiments)
      ) {
        throw new MethodError("INVALID_REQUEST", "experiments must be an object");
      }
      const exp = p.experiments as Record<string, unknown>;
      const expUpdate: Record<string, unknown> = {};
      if (exp.agent_runtimes !== undefined) {
        expUpdate.agent_runtimes = exp.agent_runtimes === true;
      }
      if (Object.keys(expUpdate).length > 0) {
        updates.experiments = expUpdate;
      }
    }

    if (Object.keys(updates).length === 0) {
      return { ok: true, config: sanitizeConfig(loadConfig()) };
    }

    const updated = updateConfig(updates);
    const normalized = normalizeProviderModels(updated);
    if (JSON.stringify(normalized) !== JSON.stringify(updated)) {
      saveConfig(normalized);
    }
    resetConfig(); // Clear cache so next loadConfig() reads the new file
    const refreshed = loadConfig();

    // Live-reload heartbeat if its config changed
    if (updates.heartbeat && heartbeat) {
      heartbeat.updateConfig(refreshed);
    }

    // Propagate any model / max_tokens / max_iterations / effort default
    // changes to live agent sessions so open chats pick up the new values
    // on the next turn — no gateway restart needed. AgentLoop reads these
    // fields off the shared config object each turn, so mutating in place
    // is sufficient.
    if (agentSessions) {
      agentSessions.updateConfig(refreshed);
    }

    return { ok: true, config: sanitizeConfig(refreshed) };
  });
}
