import { KNOWN_OPENAI_MODELS } from "./openai-models.js";
import type { HawkyConfig } from "./types.js";

export const DEFAULT_CLAUDE_MODEL = "claude-opus-4-7";
export const DEFAULT_CLAUDE_HEARTBEAT_MODEL = "claude-sonnet-4-6";
export const DEFAULT_OPENAI_MODEL = KNOWN_OPENAI_MODELS[0] ?? "gpt-5.5";
export const DEFAULT_OPENAI_MAX_OUTPUT_TOKENS = 32_768;

export type OpenAICompletionTokenParam = "max_tokens" | "max_completion_tokens";

interface OpenAIModelCapability {
  pattern: RegExp;
  maxOutputTokens?: number;
  completionTokenParam?: OpenAICompletionTokenParam;
}

const OPENAI_MODEL_CAPABILITIES: readonly OpenAIModelCapability[] = [
  {
    pattern: /^gpt-5(?:[.-]|$)/i,
    maxOutputTokens: DEFAULT_OPENAI_MAX_OUTPUT_TOKENS,
    completionTokenParam: "max_completion_tokens",
  },
  {
    pattern: /^o[1-9](?:-|$)/i,
    maxOutputTokens: DEFAULT_OPENAI_MAX_OUTPUT_TOKENS,
    completionTokenParam: "max_completion_tokens",
  },
  {
    pattern: /^gpt-4o(?:-|$)/i,
    maxOutputTokens: 16_384,
    completionTokenParam: "max_tokens",
  },
  {
    pattern: /^chatgpt-/i,
    maxOutputTokens: 16_384,
    completionTokenParam: "max_tokens",
  },
];

function trimmed(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function isClaudeModel(model: unknown): boolean {
  return /^claude(?:-|$)/i.test(trimmed(model));
}

export function isOpenAIModel(model: unknown): boolean {
  const value = trimmed(model);
  return KNOWN_OPENAI_MODELS.includes(value) ||
    /^(?:gpt-|o[1-9]|chatgpt-)/i.test(value);
}

function activeCompatProfile(config: HawkyConfig) {
  const active = config.openai_compatible?.active_profile;
  return active ? config.openai_compatible?.profiles?.[active] : undefined;
}

function openaiModelCapability(model: unknown): OpenAIModelCapability | null {
  const value = trimmed(model);
  return OPENAI_MODEL_CAPABILITIES.find((entry) => entry.pattern.test(value)) ?? null;
}

export function resolveOpenAICompletionTokenParam(model: unknown): OpenAICompletionTokenParam {
  return openaiModelCapability(model)?.completionTokenParam ?? "max_tokens";
}

export function resolveModelMaxOutputTokens(config: HawkyConfig): number | null {
  const provider = config.provider ?? "anthropic";
  if (provider !== "openai" && provider !== "openai_compatible") return null;
  return openaiModelCapability(config.model)?.maxOutputTokens ?? null;
}

function normalizeMaxOutputTokens(config: HawkyConfig): number {
  const configured = Number(config.max_tokens);
  if (!Number.isFinite(configured) || configured <= 0) {
    return config.max_tokens;
  }

  const modelLimit = resolveModelMaxOutputTokens(config);
  return modelLimit ? Math.min(configured, modelLimit) : configured;
}

function compatibleMainModel(config: HawkyConfig): string {
  const provider = config.provider ?? "anthropic";
  const model = trimmed(config.model);

  if (provider === "openai") {
    return model && !isClaudeModel(model) ? model : DEFAULT_OPENAI_MODEL;
  }

  if (provider === "openai_compatible") {
    if (model && !isClaudeModel(model)) return model;
    return trimmed(activeCompatProfile(config)?.model) || DEFAULT_OPENAI_MODEL;
  }

  return model && !isOpenAIModel(model) ? model : DEFAULT_CLAUDE_MODEL;
}

export function resolveHeartbeatModel(config: HawkyConfig): string {
  const provider = config.provider ?? "anthropic";
  const mainModel = compatibleMainModel(config);
  const heartbeatModel = trimmed(config.heartbeat?.model ?? "");
  if (!heartbeatModel) return mainModel;

  if (provider === "openai") {
    return !isClaudeModel(heartbeatModel) ? heartbeatModel : mainModel;
  }

  if (provider === "openai_compatible") {
    return isClaudeModel(heartbeatModel) ? mainModel : heartbeatModel;
  }

  return !isOpenAIModel(heartbeatModel) ? heartbeatModel : DEFAULT_CLAUDE_HEARTBEAT_MODEL;
}

export function normalizeProviderModels(config: HawkyConfig): HawkyConfig {
  const next: HawkyConfig = JSON.parse(JSON.stringify(config));
  const provider = next.provider ?? "anthropic";
  next.provider = provider;
  next.model = compatibleMainModel(next);
  next.heartbeat = { ...(next.heartbeat ?? {}) } as HawkyConfig["heartbeat"];

  const heartbeatModel = trimmed(next.heartbeat.model ?? "");
  if (!heartbeatModel) {
    next.heartbeat.model = null;
  } else if (provider === "openai" && isClaudeModel(heartbeatModel)) {
    next.heartbeat.model = null;
  } else if (provider === "openai_compatible" && isClaudeModel(heartbeatModel)) {
    next.heartbeat.model = trimmed(activeCompatProfile(next)?.model) || next.model;
  } else if ((provider === "anthropic" || provider === "vertex") && isOpenAIModel(heartbeatModel)) {
    next.heartbeat.model = DEFAULT_CLAUDE_HEARTBEAT_MODEL;
  }

  next.max_tokens = normalizeMaxOutputTokens(next);

  return next;
}
