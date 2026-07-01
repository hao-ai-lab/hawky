import type { HawkyConfig } from "./types.js";
import { KNOWN_OPENAI_MODELS } from "./openai-models.js";

export type ProviderName = NonNullable<HawkyConfig["provider"]>;

export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-7";
export const DEFAULT_CLAUDE_HEARTBEAT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_OPENAI_MODEL = KNOWN_OPENAI_MODELS[0];

export function isClaudeModel(model: string | null | undefined): boolean {
  return /^claude(?:-|$)/i.test((model ?? "").trim());
}

export function isOpenAIModel(model: string | null | undefined): boolean {
  const id = (model ?? "").trim().toLowerCase();
  return /^(gpt|o[1-9])(?:[-.]|$)/.test(id);
}

function trimmed(value: string | null | undefined): string {
  return (value ?? "").trim();
}

function activeCompatProfile(config: HawkyConfig) {
  const name = config.openai_compatible?.active_profile;
  return name ? config.openai_compatible?.profiles?.[name] : undefined;
}

export function defaultModelForProvider(
  provider: ProviderName,
  config: HawkyConfig,
): string {
  const current = trimmed(config.model);
  if (provider === "openai") {
    return current && isOpenAIModel(current) ? current : DEFAULT_OPENAI_MODEL;
  }
  if (provider === "openai_compatible") {
    const profileModel = trimmed(activeCompatProfile(config)?.model);
    if (profileModel) return profileModel;
    return current && !isClaudeModel(current) ? current : DEFAULT_OPENAI_MODEL;
  }
  return current && isClaudeModel(current) ? current : DEFAULT_CLAUDE_MODEL;
}

export function normalizeModelForProvider(config: HawkyConfig): string {
  const provider = config.provider ?? "anthropic";
  const current = trimmed(config.model);
  if (!current) return defaultModelForProvider(provider, config);

  if (provider === "openai") {
    return isOpenAIModel(current) ? current : DEFAULT_OPENAI_MODEL;
  }
  if (provider === "openai_compatible") {
    if (isClaudeModel(current)) {
      return defaultModelForProvider(provider, config);
    }
    return current;
  }
  return isClaudeModel(current) ? current : DEFAULT_CLAUDE_MODEL;
}

export function resolveHeartbeatModel(config: HawkyConfig): string {
  const provider = config.provider ?? "anthropic";
  const mainModel = normalizeModelForProvider(config);
  const heartbeatModel = trimmed(config.heartbeat?.model ?? null);

  if (!heartbeatModel) return mainModel;

  if (provider === "openai") {
    return isOpenAIModel(heartbeatModel) ? heartbeatModel : mainModel;
  }
  if (provider === "openai_compatible") {
    if (isClaudeModel(heartbeatModel)) {
      return trimmed(activeCompatProfile(config)?.model) || mainModel;
    }
    return heartbeatModel;
  }
  return isClaudeModel(heartbeatModel) ? heartbeatModel : DEFAULT_CLAUDE_HEARTBEAT_MODEL;
}

export function normalizeProviderModels(config: HawkyConfig): HawkyConfig {
  const next = JSON.parse(JSON.stringify(config)) as HawkyConfig;
  const provider = next.provider ?? "anthropic";
  next.model = normalizeModelForProvider(next);
  next.heartbeat = { ...next.heartbeat };

  const heartbeatModel = trimmed(next.heartbeat.model ?? null);
  if (!heartbeatModel) {
    next.heartbeat.model = null;
  } else if (provider === "openai" && !isOpenAIModel(heartbeatModel)) {
    next.heartbeat.model = null;
  } else if (provider === "openai_compatible" && isClaudeModel(heartbeatModel)) {
    next.heartbeat.model = trimmed(activeCompatProfile(next)?.model) || next.model;
  } else if ((provider === "anthropic" || provider === "vertex") && !isClaudeModel(heartbeatModel)) {
    next.heartbeat.model = DEFAULT_CLAUDE_HEARTBEAT_MODEL;
  }

  return next;
}
