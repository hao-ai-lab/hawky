// =============================================================================
// Frontend Boot Context
//
// Deterministic startup context for lightweight frontend agents (for example,
// iOS Live Realtime). This path must stay cheap and reliable: it reads existing
// workspace memory files and returns a compact context block without invoking
// the backend agent loop.
// =============================================================================

import { WorkspaceManager, type BootstrapFile } from "../storage/workspace.js";
import type {
  ExtensionFrontendToolContribution,
  ExtensionManifest,
} from "../extensions/types.js";
import { MethodError } from "./methods.js";
import type { GatewayServer } from "./server.js";

export interface FrontendBootContextRequest {
  channel_id?: unknown;
  session_key?: unknown;
  participant_id?: unknown;
  mode?: unknown;
  capabilities?: unknown;
  tools?: unknown;
  max_chars?: unknown;
}

export interface FrontendBootContextResult {
  ok: true;
  channel_id: string;
  session_key: string;
  participant_id: string;
  mode: string;
  generated_at: string;
  context: string;
  sources: string[];
  warnings: string[];
  toolbox: FrontendToolboxManifest;
  first_contact: FrontendFirstContactState;
}

type JSONSchemaObject = {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
};

export interface OpenAIFunctionToolDefinition {
  type: "function";
  name: string;
  description: string;
  parameters: JSONSchemaObject;
  strict?: boolean;
}

export interface FrontendToolDefinition extends OpenAIFunctionToolDefinition {
  x_tool_metadata?: {
    category: "local_context" | "device_diagnostics" | "session_bridge" | "memory" | "media" | "shortcut";
    latency: "instant" | "fast" | "slow" | "background";
    durability: "ephemeral" | "session" | "durable";
    risk: "low" | "medium" | "high";
    visibility: "model" | "debug" | "hidden";
    whenToUse?: string[];
    whenNotToUse?: string[];
  };
}

export interface FrontendToolboxManifest {
  version: 1;
  frontend_tools: FrontendToolDefinition[];
  backend_tools: FrontendToolDefinition[];
}

export interface FrontendFirstContactState {
  active: boolean;
  reason: "bootstrap_present" | "initialized";
  marker_file?: string;
}

const BOOTSTRAP_FILES = ["BOOTSTRAP.md", "SOUL.md", "USER.md", "IDENTITY.md", "MEMORY.md"];

export const FRONTEND_BOOT_CONTEXT_TOOL: FrontendToolDefinition = {
  type: "function",
  name: "frontend_boot_context",
  description: "Build deterministic startup memory/context for a lightweight frontend realtime agent without invoking the backend agent loop.",
  parameters: {
    type: "object",
    properties: {
      channel_id: {
        type: "string",
        description: "Durable channel/session identifier the frontend agent is joining.",
      },
      session_key: {
        type: "string",
        description: "Backend Hawky session key bound to this frontend realtime session.",
      },
      participant_id: {
        type: "string",
        description: "Frontend participant identifier, for example ios-live.",
      },
      mode: {
        type: "string",
        description: "Frontend mode, for example realtime.",
      },
      capabilities: {
        type: "array",
        description: "Short capability labels advertised by the frontend client.",
        items: { type: "string" },
      },
      tools: {
        type: "array",
        description: "Optional OpenAI-format tool definitions available to the frontend agent.",
        items: { type: "object" },
      },
      max_chars: {
        type: "number",
        description: "Optional character cap for the returned context. Omit for the full untrimmed context.",
      },
    },
    required: ["session_key"],
    additionalProperties: false,
  },
  strict: true,
  x_tool_metadata: {
    category: "session_bridge",
    latency: "fast",
    durability: "session",
    risk: "low",
    visibility: "debug",
    whenToUse: [
      "before starting a frontend realtime model",
      "when a frontend participant needs backend memory context",
    ],
  },
};

// Advertised so a frontend realtime agent knows the background agent can send
// messages to external apps (Slack today). The realtime agent doesn't call this
// directly — it asks the background agent (via the bridge / session tools).
export const SEND_MESSAGE_BACKEND_TOOL: FrontendToolDefinition = {
  type: "function",
  name: "send_message",
  description:
    "Background-agent capability: send a message to an external messaging app " +
    "(Slack today; DMs and channels). Ask the background agent to use this when " +
    "the user wants to reach someone outside the app.",
  parameters: {
    type: "object",
    properties: {
      platform: { type: "string", description: "Messaging platform, e.g. \"slack\"." },
      to: { type: "string", description: "Channel or user/DM target." },
      text: { type: "string", description: "Message body." },
      thread_id: { type: "string", description: "Optional thread to reply within." },
    },
    required: ["platform", "to", "text"],
    additionalProperties: false,
  },
  x_tool_metadata: {
    category: "shortcut",
    latency: "slow",
    durability: "ephemeral",
    risk: "medium",
    visibility: "model",
    whenToUse: [
      "when the user asks to send/post a message to Slack",
      "to proactively notify the user or their team outside the app",
    ],
    whenNotToUse: [
      "to move content between Hawky sessions (use channel_send)",
    ],
  },
};

// Memory feature (#653): advertised so the realtime agent knows it can ask the
// backend to distill the just-ended session into the user's memory. Executed via
// the memory.distill RPC (channel: realtime:memory_distill), not locally.
export const FRONTEND_MEMORY_DISTILL_TOOL: FrontendToolDefinition = {
  type: "function",
  name: "frontend_memory_distill",
  description:
    "Distill the current realtime session into the user's memory. scope=daily " +
    "writes a summary to today's daily log (memory/YYYY-MM-DD.md); scope=global " +
    "consolidates recent daily logs into long-term MEMORY.md. Typically called " +
    "once at the end of a session.",
  parameters: {
    type: "object",
    properties: {
      session_key: {
        type: "string",
        description: "Backend session key to distill. Omit to use the most recent realtime session.",
      },
      scope: {
        type: "string",
        description: "\"daily\" (session → daily log) or \"global\" (daily logs → MEMORY.md).",
      },
    },
    required: ["scope"],
    additionalProperties: false,
  },
  x_tool_metadata: {
    category: "memory",
    latency: "slow",
    durability: "durable",
    risk: "low",
    visibility: "model",
    whenToUse: [
      "at the end of a realtime session, to persist what was learned",
      "when the user asks to remember or save the conversation",
    ],
    whenNotToUse: [
      "mid-conversation for trivial small talk",
    ],
  },
};

export const FRONTEND_BOOT_CONTEXT_EXTENSION_MANIFEST: ExtensionManifest = {
  id: "frontend.boot-context",
  version: "0.1.0",
  displayName: "Frontend Boot Context",
  description: "Deterministic startup context and backend toolbox metadata for lightweight frontend agents.",
  capabilities: ["frontend.boot_context"],
  surfaces: ["frontend.boot_context"],
  frontendTools: [
    backendToolContribution(FRONTEND_BOOT_CONTEXT_TOOL),
    backendToolContribution(SEND_MESSAGE_BACKEND_TOOL),
    backendToolContribution(FRONTEND_MEMORY_DISTILL_TOOL),
  ],
};

export function getFrontendBootContextBackendTools(
  manifest: ExtensionManifest = FRONTEND_BOOT_CONTEXT_EXTENSION_MANIFEST,
): FrontendToolDefinition[] {
  return (manifest.frontendTools ?? [])
    .filter(isFrontendBootContextBackendContribution)
    .map((contribution) => cleanFrontendToolDefinition(contribution.definition))
    .filter((tool): tool is FrontendToolDefinition => Boolean(tool));
}

export function toOpenAIToolDefinition(tool: FrontendToolDefinition): OpenAIFunctionToolDefinition {
  return {
    type: tool.type,
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: tool.strict,
  };
}

export function buildFrontendBootContext(
  request: FrontendBootContextRequest = {},
  options?: {
    workspace?: WorkspaceManager;
    now?: Date;
    maxChars?: number;
  },
): FrontendBootContextResult {
  const workspace = options?.workspace ?? new WorkspaceManager();
  const now = options?.now ?? new Date();
  const maxChars = cleanPositiveInteger(request.max_chars) ?? options?.maxChars;

  const sessionKey = cleanString(request.session_key) || "realtime:unknown";
  const channelId = cleanString(request.channel_id) || sessionKey;
  const participantId = cleanString(request.participant_id) || "ios-live";
  const mode = cleanString(request.mode) || "realtime";
  const capabilities = cleanStringArray(request.capabilities);
  const tools = cleanToolDefinitions(request.tools);
  const toolbox: FrontendToolboxManifest = {
    version: 1,
    frontend_tools: tools,
    backend_tools: getFrontendBootContextBackendTools(),
  };

  const warnings: string[] = [];
  const sources: string[] = [];
  const sections: string[] = [
    "# Backend Boot Context",
    "",
    "You are joining an existing Hawky-backed realtime session. Use this context silently unless the user asks about it.",
    "",
    "## Session",
    `- Channel: ${channelId}`,
    `- Backend session: ${sessionKey}`,
    `- Frontend participant: ${participantId}`,
    `- Mode: ${mode}`,
    `- Capabilities: ${capabilities.length > 0 ? capabilities.join(", ") : "unspecified"}`,
  ];

  if (tools.length > 0) {
    sections.push("", "## Toolbox");
    sections.push("The frontend realtime agent has these callable tools. Prefer fast local tools for simple facts and delegate durable work to the backend session bridge.");
    for (const tool of tools) {
      sections.push(formatToolForPrompt(tool));
    }
  }

  const bootstrapFiles = loadUntrimmedBootstrapFiles(workspace);
  const firstContact = buildFirstContactState(bootstrapFiles);

  if (firstContact.active) {
    sections.push(
      "",
      "## First Contact",
      "BOOTSTRAP.md is present in the Hawky workspace. This is a first-contact onboarding state.",
      "Do not use a canned greeting. Follow BOOTSTRAP.md naturally: the agent has just come online and should figure out who it is and who the user is through conversation.",
      "The frontend realtime agent may speak first only to begin that identity-discovery conversation.",
    );
  }

  if (bootstrapFiles.length > 0) {
    sections.push("", "## Relevant Memory");
    for (const file of bootstrapFiles) {
      sources.push(file.filename);
      sections.push(formatBootstrapFile(file));
    }
  } else {
    warnings.push("No bootstrap memory files were found in the Hawky workspace.");
  }

  const dailyLogs = workspace.listDailyLogs().slice(-2).reverse();
  if (dailyLogs.length > 0) {
    sections.push("", "## Recent Daily Logs");
    for (const log of dailyLogs) {
      const path = `memory/${log}`;
      const content = workspace.readFile(path);
      if (!content?.trim()) continue;
      sources.push(path);
      sections.push(`### ${path}\n${content.trim()}`);
    }
  }

  sections.push(
    "",
    "## Behavior Notes",
    "- Treat this boot context as private context, not as a user message.",
    "- Do not recite this context at startup.",
    "- If the user asks for durable work, use the Hawky bridge tools instead of pretending the frontend can do it locally.",
    "- If memory seems missing or stale, ask the backend agent or search memory through the available tools.",
  );

  const fullContext = sections.join("\n");
  const context = maxChars ? truncateMiddle(fullContext, maxChars) : fullContext;

  return {
    ok: true,
    channel_id: channelId,
    session_key: sessionKey,
    participant_id: participantId,
    mode,
    generated_at: now.toISOString(),
    context,
    sources,
    warnings,
    toolbox,
    first_contact: firstContact,
  };
}

export function registerFrontendBootContextMethods(server: GatewayServer): void {
  server.registerMethod("frontend.boot_context.tool", () => ({
    tool: toOpenAIToolDefinition(FRONTEND_BOOT_CONTEXT_TOOL),
    x_tool_metadata: FRONTEND_BOOT_CONTEXT_TOOL.x_tool_metadata,
  }));

  server.registerMethod("frontend.boot_context", (_conn, params) => {
    if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params))) {
      throw new MethodError("INVALID_REQUEST", "params must be an object");
    }
    return buildFrontendBootContext(params as FrontendBootContextRequest | undefined);
  });
}

function backendToolContribution(
  definition: FrontendToolDefinition,
): ExtensionFrontendToolContribution<FrontendToolDefinition> {
  return {
    surface: "frontend.boot_context",
    role: "backend",
    definition,
  };
}

function isFrontendBootContextBackendContribution(
  contribution: ExtensionFrontendToolContribution,
): boolean {
  return (
    contribution.surface === "frontend.boot_context" &&
    contribution.role === "backend"
  );
}

function cleanFrontendToolDefinition(value: unknown): FrontendToolDefinition | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (raw.type !== "function") return undefined;
  const name = cleanString(raw.name);
  const description = cleanString(raw.description);
  const parameters = raw.parameters;
  if (!name || !description || !isJSONSchemaObject(parameters)) return undefined;
  const tool: FrontendToolDefinition = {
    type: "function",
    name,
    description,
    parameters,
  };
  if (typeof raw.strict === "boolean") {
    tool.strict = raw.strict;
  }
  const metadata = cleanToolMetadata(raw.x_tool_metadata);
  if (metadata) {
    tool.x_tool_metadata = metadata;
  }
  return tool;
}

function formatBootstrapFile(file: BootstrapFile): string {
  return `### ${file.filename}\n${file.content.trim()}`;
}

function loadUntrimmedBootstrapFiles(workspace: WorkspaceManager): BootstrapFile[] {
  const files: BootstrapFile[] = [];
  for (const filename of BOOTSTRAP_FILES) {
    const content = workspace.readFile(filename);
    if (!content?.trim()) continue;
    files.push({ filename, content, truncated: false });
  }
  return files;
}

function buildFirstContactState(files: BootstrapFile[]): FrontendFirstContactState {
  const hasBootstrap = files.some((file) => file.filename === "BOOTSTRAP.md");
  if (hasBootstrap) {
    return {
      active: true,
      reason: "bootstrap_present",
      marker_file: "BOOTSTRAP.md",
    };
  }
  return {
    active: false,
    reason: "initialized",
  };
}

function cleanString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function cleanStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function cleanPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function cleanToolDefinitions(value: unknown): FrontendToolDefinition[] {
  if (!Array.isArray(value)) return [];
  const tools: FrontendToolDefinition[] = [];
  for (const item of value) {
    const tool = cleanFrontendToolDefinition(item);
    if (tool) tools.push(tool);
  }
  return tools.slice(0, 32);
}

function cleanToolMetadata(value: unknown): FrontendToolDefinition["x_tool_metadata"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  const category = enumValue(raw.category, ["local_context", "device_diagnostics", "session_bridge", "memory", "media", "shortcut"]);
  const latency = enumValue(raw.latency, ["instant", "fast", "slow", "background"]);
  const durability = enumValue(raw.durability, ["ephemeral", "session", "durable"]);
  const risk = enumValue(raw.risk, ["low", "medium", "high"]);
  const visibility = enumValue(raw.visibility, ["model", "debug", "hidden"]);
  if (!category || !latency || !durability || !risk || !visibility) return undefined;
  const metadata: NonNullable<FrontendToolDefinition["x_tool_metadata"]> = {
    category,
    latency,
    durability,
    risk,
    visibility,
  };
  const whenToUse = cleanStringArray(raw.whenToUse);
  if (whenToUse.length > 0) metadata.whenToUse = whenToUse;
  const whenNotToUse = cleanStringArray(raw.whenNotToUse);
  if (whenNotToUse.length > 0) metadata.whenNotToUse = whenNotToUse;
  return metadata;
}

function enumValue<const T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function isJSONSchemaObject(value: unknown): value is JSONSchemaObject {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "object" &&
    typeof (value as Record<string, unknown>).properties === "object" &&
    (value as Record<string, unknown>).properties !== null &&
    !Array.isArray((value as Record<string, unknown>).properties),
  );
}

function formatToolForPrompt(tool: OpenAIFunctionToolDefinition): string {
  const required = Array.isArray(tool.parameters.required) && tool.parameters.required.length > 0
    ? ` Required: ${tool.parameters.required.join(", ")}.`
    : "";
  return `- ${tool.name}: ${tool.description}${required}`;
}

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  if (maxChars < 64) return text.slice(0, maxChars);
  const headChars = Math.floor(maxChars * 0.72);
  const tailChars = Math.max(0, maxChars - headChars - 48);
  return `${text.slice(0, headChars)}\n\n[... boot context truncated ...]\n\n${text.slice(text.length - tailChars)}`;
}
