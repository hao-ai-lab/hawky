import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessage, StreamEvent, TokenUsage } from "../agent/types.js";
import { createSubsystemLogger } from "../logging/index.js";
import type { SessionRuntimeKind } from "../storage/session.js";

type Emit = (event: StreamEvent) => void;
const log = createSubsystemLogger("gateway/external-runtime");

export interface ExternalAgentTurnOptions {
  runtimeKind: Exclude<SessionRuntimeKind, "native">;
  sessionKey: string;
  cwd: string;
  history: ChatMessage[];
  message: string;
  emit: Emit;
}

export interface ExternalAgentTurnResult {
  userMessage: ChatMessage;
  assistantMessage: ChatMessage;
  messages: ChatMessage[];
  assistantText: string;
}

export interface ExternalAgentCurrentTurn {
  busy: boolean;
  streaming: boolean;
  text: string;
}

function textOfMessage(message: ChatMessage): string {
  return message.content
    .map((block: any) => {
      if (block?.type === "text" && typeof block.text === "string") return block.text;
      if (block?.type === "tool_result" && typeof block.content === "string") return `[tool result]\n${block.content}`;
      if (block?.type === "tool_use") return `[tool use: ${block.name ?? "tool"}]`;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function buildPrompt(history: ChatMessage[], message: string, runtimeKind: SessionRuntimeKind): string {
  const recent = history.slice(-16);
  const transcript = recent
    .map((m) => `${m.role.toUpperCase()}:\n${textOfMessage(m)}`)
    .filter((s) => !s.endsWith(":\n"))
    .join("\n\n");
  const runtimeLabel = runtimeKind === "codex"
    ? "Codex"
    : runtimeKind === "claude"
      ? "Claude Code"
      : "Hermes";
  const hasReadOnlyHawkyMcp = runtimeKind === "codex" || runtimeKind === "claude";
  return [
    `You are running inside Hawky as the experimental ${runtimeLabel} agent runtime.`,
    "Answer the user's latest message. Use your own tools if needed, but keep the final response concise enough for a chat UI.",
    hasReadOnlyHawkyMcp
      ? "Read-only Hawky MCP tools may be available. Use hawky_session_list and hawky_session_read when you need persisted Hawky session context beyond the recent transcript."
      : "",
    transcript ? `Recent Hawky transcript:\n\n${transcript}` : "",
    `Latest user message:\n\n${message}`,
  ].filter(Boolean).join("\n\n---\n\n");
}

interface RuntimeCommand {
  cmd: string;
  args: string[];
  stdin?: string;
  env?: NodeJS.ProcessEnv;
  outputPath?: string;
  cleanupDir?: string;
  parseStdout?: (stdout: string, outputPath?: string) => ParsedRuntimeOutput;
  streamJson?: "codex" | "claude";
}

export interface ParsedRuntimeOutput {
  text: string;
  usage?: TokenUsage;
}

interface RuntimeTrace {
  startedAtMs: number;
  firstEventMs?: number;
  firstTextMs?: number;
  completedAtMs?: number;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
  timedOut?: boolean;
  cancelled?: boolean;
}

const HAWKY_HERMES_DEEPINFRA_PROVIDER = "hawky-deepinfra";
const DEFAULT_HERMES_DEEPINFRA_MODEL = "deepseek-ai/DeepSeek-V4-Flash";
const DEEPINFRA_BASE_URL = "https://api.deepinfra.com/v1/openai";
const LOCAL_BIN_DIRS = [
  join(homedir(), ".local", "bin"),
  join(homedir(), ".bun", "bin"),
  join(homedir(), ".hermes", "bin"),
  "/opt/homebrew/bin",
  "/usr/local/bin",
];

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeRuntimeUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const input = asNumber(u.input_tokens);
  const output = asNumber(u.output_tokens);
  const cacheRead = asNumber(u.cache_read_input_tokens) ?? asNumber(u.cached_input_tokens);
  const cacheCreation = asNumber(u.cache_creation_input_tokens);
  if (input == null && output == null && cacheRead == null && cacheCreation == null) return undefined;
  return {
    input_tokens: input ?? 0,
    output_tokens: output ?? 0,
    ...(cacheRead != null ? { cache_read_input_tokens: cacheRead } : {}),
    ...(cacheCreation != null ? { cache_creation_input_tokens: cacheCreation } : {}),
  };
}

export interface CodexJsonLineResult {
  assistantText?: string;
  usage?: TokenUsage;
  eventType?: string;
  itemType?: string;
  toolStarts?: RuntimeToolStart[];
  toolResults?: RuntimeToolResult[];
}

export interface RuntimeToolStart {
  tool_use_id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface RuntimeToolResult {
  tool_use_id: string;
  name: string;
  content: string;
  is_error: boolean;
}

export function parseCodexJsonLine(line: string): CodexJsonLineResult | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const event = JSON.parse(trimmed);
    const item = event?.item;
    const result: CodexJsonLineResult = {
      eventType: typeof event?.type === "string" ? event.type : undefined,
      itemType: typeof item?.type === "string" ? item.type : undefined,
    };
    if (event?.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
      result.assistantText = item.text.trim();
    }
    if (event?.type === "item.started") {
      const toolStart = codexToolStartFromItem(item);
      if (toolStart) result.toolStarts = [toolStart];
    }
    if (event?.type === "item.completed") {
      const toolResult = codexToolResultFromItem(item);
      if (toolResult) result.toolResults = [toolResult];
    }
    if (event?.type === "turn.completed") {
      result.usage = normalizeRuntimeUsage(event?.usage);
    }
    return result;
  } catch {
    // Codex may still write warnings around JSONL in some environments.
    return null;
  }
}

function codexToolStartFromItem(item: unknown): RuntimeToolStart | null {
  if (!isRecord(item)) return null;
  const id = toolIdFromRecord(item);
  if (!id) return null;
  const name = codexToolName(item);
  if (!name) return null;
  return {
    tool_use_id: id,
    name,
    input: codexToolInput(item),
  };
}

function codexToolResultFromItem(item: unknown): RuntimeToolResult | null {
  if (!isRecord(item)) return null;
  const id = toolIdFromRecord(item);
  if (!id) return null;
  const name = codexToolName(item);
  if (!name) return null;
  return {
    tool_use_id: id,
    name,
    content: codexToolOutput(item),
    is_error: codexToolFailed(item),
  };
}

function codexToolName(item: Record<string, unknown>): string | null {
  const type = typeof item.type === "string" ? item.type : "";
  if (type === "command_execution") return "bash";
  if (type === "web_search") return "web_search";
  const explicit = stringFromRecord(item, ["name", "tool_name", "server_tool_name"]);
  if (explicit) return externalToolDisplayName(explicit);
  if (type === "mcp_tool_call" || type === "tool_call" || type === "function_call") return type;
  return null;
}

function codexToolInput(item: Record<string, unknown>): Record<string, unknown> {
  if (typeof item.command === "string") return { command: item.command };
  const input = recordFromRecord(item, ["input", "arguments", "args"]);
  if (input) return input;
  const query = typeof item.query === "string" ? item.query : undefined;
  if (query) return { query };
  return {};
}

function codexToolOutput(item: Record<string, unknown>): string {
  const parts = [
    stringFromRecord(item, ["output", "aggregated_output", "stdout"]),
    stringFromRecord(item, ["stderr"]),
    stringFromRecord(item, ["error", "error_message"]),
  ].filter((part): part is string => !!part && part.trim().length > 0);
  if (parts.length > 0) return parts.join("\n");
  const result = item.result ?? item.response;
  if (result != null) return runtimeValueToText(result);
  const status = typeof item.status === "string" ? item.status : "";
  return status ? `[${status}]` : "";
}

function codexToolFailed(item: Record<string, unknown>): boolean {
  const status = typeof item.status === "string" ? item.status.toLowerCase() : "";
  const exitCode = asNumber(item.exit_code) ?? asNumber(item.exitCode);
  return Boolean(item.error || item.error_message) || (exitCode != null && exitCode !== 0) ||
    ["failed", "error", "cancelled", "canceled"].includes(status);
}

class JsonLineStreamParser<T> {
  private buffer = "";

  constructor(private readonly parseLine: (line: string) => T | null) {}

  push(chunk: string, onResult: (result: T) => void): void {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    for (const line of lines) {
      this.processLine(line, onResult);
    }
  }

  finish(onResult: (result: T) => void): void {
    if (this.buffer.trim()) {
      this.processLine(this.buffer, onResult);
      this.buffer = "";
    }
  }

  private processLine(line: string, onResult: (result: T) => void): void {
    const result = this.parseLine(line);
    if (!result) return;
    onResult(result);
  }
}

export function parseCodexJsonStdout(stdout: string, outputPath?: string): ParsedRuntimeOutput {
  let lastAgentText = "";
  let usage: TokenUsage | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    const result = parseCodexJsonLine(line);
    if (!result) continue;
    if (result.assistantText) lastAgentText = result.assistantText;
    if (result.usage) usage = result.usage;
  }

  if (lastAgentText.trim()) return { text: lastAgentText.trim(), usage };
  if (outputPath) {
    try {
      const saved = readFileSync(outputPath, "utf-8").trim();
      if (saved) return { text: saved, usage };
    } catch {
      // Fall through to raw stdout.
    }
  }
  return { text: stripAnsi(stdout).trim(), usage };
}

export interface ClaudeJsonLineResult {
  assistantText?: string;
  assistantTextDelta?: string;
  resultText?: string;
  usage?: TokenUsage;
  totalCostUSD?: number;
  eventType?: string;
  subtype?: string;
  streamEventType?: string;
  toolStarts?: RuntimeToolStart[];
  toolResults?: RuntimeToolResult[];
}

export function parseClaudeJsonLine(line: string): ClaudeJsonLineResult | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const event = JSON.parse(trimmed);
    const result: ClaudeJsonLineResult = {
      eventType: typeof event?.type === "string" ? event.type : undefined,
      subtype: typeof event?.subtype === "string" ? event.subtype : undefined,
    };

    if (event?.type === "assistant") {
      const text = claudeContentToText(event?.message?.content).trim();
      if (text) result.assistantText = text;
      result.usage = normalizeRuntimeUsage(event?.message?.usage);
      result.toolStarts = claudeToolStartsFromContent(event?.message?.content);
      result.toolResults = claudeToolResultsFromContent(event?.message?.content);
    } else if (event?.type === "user") {
      result.toolResults = claudeToolResultsFromContent(event?.message?.content);
    } else if (event?.type === "result") {
      if (typeof event?.result === "string") {
        const text = event.result.trim();
        if (text) result.resultText = text;
      }
      result.usage = normalizeRuntimeUsage(event?.usage);
      result.totalCostUSD = asNumber(event?.total_cost_usd);
    } else if (event?.type === "stream_event") {
      const streamEvent = event?.event;
      result.streamEventType = typeof streamEvent?.type === "string" ? streamEvent.type : undefined;
      if (streamEvent?.type === "content_block_start") {
        const block = streamEvent.content_block;
        const start = claudeToolStartFromBlock(block);
        const toolResult = claudeToolResultFromBlock(block);
        if (start) result.toolStarts = [start];
        if (toolResult) result.toolResults = [toolResult];
      }
      if (
        streamEvent?.type === "content_block_delta" &&
        streamEvent?.delta?.type === "text_delta" &&
        typeof streamEvent.delta.text === "string"
      ) {
        result.assistantTextDelta = streamEvent.delta.text;
      }
      result.usage = normalizeRuntimeUsage(streamEvent?.usage ?? streamEvent?.message?.usage);
    }

    return result;
  } catch {
    // Claude Code can emit non-JSON diagnostics around the JSON stream.
    return null;
  }
}

export function parseClaudeJsonStdout(stdout: string): ParsedRuntimeOutput {
  let finalText = "";
  let lastAssistantText = "";
  let streamedText = "";
  let usage: TokenUsage | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    const result = parseClaudeJsonLine(line);
    if (!result) continue;
    if (result.assistantTextDelta) streamedText += result.assistantTextDelta;
    if (result.assistantText) lastAssistantText = result.assistantText;
    if (result.resultText) finalText = result.resultText;
    if (result.usage) usage = result.usage;
  }

  const text = finalText || lastAssistantText || streamedText || stripAnsi(stdout).trim();
  return { text: text.trim(), usage };
}

function claudeContentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (!isRecord(block)) return "";
      if (block.type === "text" && typeof block.text === "string") return block.text;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function claudeToolStartsFromContent(content: unknown): RuntimeToolStart[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const starts = content
    .map(claudeToolStartFromBlock)
    .filter((start): start is RuntimeToolStart => !!start);
  return starts.length > 0 ? starts : undefined;
}

function claudeToolResultsFromContent(content: unknown): RuntimeToolResult[] | undefined {
  if (!Array.isArray(content)) return undefined;
  const results = content
    .map(claudeToolResultFromBlock)
    .filter((result): result is RuntimeToolResult => !!result);
  return results.length > 0 ? results : undefined;
}

function claudeToolStartFromBlock(block: unknown): RuntimeToolStart | null {
  if (!isRecord(block)) return null;
  const type = typeof block.type === "string" ? block.type : "";
  if (type !== "tool_use" && type !== "server_tool_use") return null;
  const id = toolIdFromRecord(block);
  const rawName = stringFromRecord(block, ["name", "tool_name"]);
  if (!id || !rawName) return null;
  return {
    tool_use_id: id,
    name: externalToolDisplayName(rawName),
    input: recordFromRecord(block, ["input"]) ?? {},
  };
}

function claudeToolResultFromBlock(block: unknown): RuntimeToolResult | null {
  if (!isRecord(block)) return null;
  const type = typeof block.type === "string" ? block.type : "";
  if (type !== "tool_result") return null;
  const id = stringFromRecord(block, ["tool_use_id", "id"]);
  if (!id) return null;
  const content = runtimeValueToText(block.content);
  return {
    tool_use_id: id,
    name: externalToolDisplayName(stringFromRecord(block, ["name", "tool_name"]) ?? "tool"),
    content,
    is_error: block.is_error === true,
  };
}

function toolIdFromRecord(record: Record<string, unknown>): string | null {
  return stringFromRecord(record, ["id", "tool_use_id", "call_id", "callId"]);
}

function stringFromRecord(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function recordFromRecord(record: Record<string, unknown>, keys: string[]): Record<string, unknown> | null {
  for (const key of keys) {
    const value = record[key];
    if (isRecord(value)) return value;
    if (typeof value === "string" && value.trim()) {
      try {
        const parsed = JSON.parse(value);
        if (isRecord(parsed)) return parsed;
      } catch {
        return { value };
      }
    }
  }
  return null;
}

function externalToolDisplayName(name: string): string {
  if (name.startsWith("mcp__")) {
    const parts = name.split("__").filter(Boolean);
    if (parts.length >= 3) return parts.slice(2).join("__");
  }
  return name;
}

function runtimeValueToText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (isRecord(part)) {
          if (part.type === "text" && typeof part.text === "string") return part.text;
          if (typeof part.content === "string") return part.content;
        }
        return safeJson(part);
      })
      .filter(Boolean)
      .join("\n");
  }
  return safeJson(value);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "[unserializable]";
  }
}

function parseHermesStdout(stdout: string): ParsedRuntimeOutput {
  const lines = stripAnsi(stdout)
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (trimmed.startsWith("session_id:")) return false;
      if (trimmed.includes("tirith security scanner enabled but not available")) return false;
      return true;
    });
  return { text: lines.join("\n").trim() };
}

function maybeCreateDeepInfraHermesHome(model: string): { home: string; env: NodeJS.ProcessEnv } | null {
  const deepinfraKey = process.env.DEEPINFRA_API_KEY ?? process.env.DEEPINFRA_TOKEN ?? process.env.DEEPINFRA_KEY;
  if (!deepinfraKey) return null;

  const home = mkdtempSync(join(tmpdir(), "hawky-hermes-"));
  const config = [
    "model:",
    `  default: ${model}`,
    `  provider: ${HAWKY_HERMES_DEEPINFRA_PROVIDER}`,
    "  max_tokens: 4096",
    "  base_url: ''",
    "providers:",
    `  ${HAWKY_HERMES_DEEPINFRA_PROVIDER}:`,
    "    name: DeepInfra",
    `    base_url: ${DEEPINFRA_BASE_URL}`,
    "    key_env: DEEPINFRA_API_KEY",
    `    model: ${model}`,
    "    api_mode: chat_completions",
    "    models:",
    `      ${model}: {}`,
    "fallback_providers: []",
    "toolsets:",
    "- hermes-cli",
    "agent:",
    "  max_turns: 3",
    "  api_max_retries: 1",
    "  reasoning_effort: medium",
    "terminal:",
    "  backend: local",
    "  cwd: .",
    "  timeout: 180",
    "",
  ].join("\n");
  writeFileSync(join(home, "config.yaml"), config, "utf-8");
  writeFileSync(join(home, ".env"), `DEEPINFRA_API_KEY=${deepinfraKey}\nDEEPINFRA_TOKEN=${deepinfraKey}\n`, "utf-8");
  return {
    home,
    env: {
      ...process.env,
      HERMES_HOME: home,
      DEEPINFRA_API_KEY: deepinfraKey,
      DEEPINFRA_TOKEN: deepinfraKey,
    },
  };
}

function executableExists(path: string): boolean {
  try {
    return existsSync(path);
  } catch {
    return false;
  }
}

function pathWithLocalBins(env: NodeJS.ProcessEnv = process.env): string {
  return [...LOCAL_BIN_DIRS, env.PATH ?? ""].filter(Boolean).join(":");
}

export function resolveRuntimeExecutable(binaryName: string, env: NodeJS.ProcessEnv = process.env): string {
  const overrideKey = `HAWKY_${binaryName.toUpperCase()}_BIN`;
  const override = env[overrideKey]?.trim() || env[`${binaryName.toUpperCase()}_BIN`]?.trim();
  if (override) return override;

  const pathParts = pathWithLocalBins(env).split(":").filter(Boolean);
  for (const dir of pathParts) {
    const candidate = join(dir, binaryName);
    if (executableExists(candidate)) return candidate;
  }
  return binaryName;
}

function runtimeEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const base = extra ?? process.env;
  return {
    ...base,
    PATH: pathWithLocalBins(base),
  };
}

function runtimeTurnTimeoutMs(): number {
  const raw = process.env.HAWKY_EXTERNAL_RUNTIME_TIMEOUT_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return 180_000;
}

function runtimeKillGraceMs(): number {
  const raw = process.env.HAWKY_EXTERNAL_RUNTIME_KILL_GRACE_MS?.trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  return 2_000;
}

export interface CodexMcpServerCommand {
  command: string;
  args: string[];
  cwd?: string;
}

function codexMcpEnabled(): boolean {
  return process.env.HAWKY_CODEX_MCP?.trim() !== "0";
}

function claudeMcpEnabled(): boolean {
  return process.env.HAWKY_CLAUDE_MCP?.trim() !== "0";
}

function resolveHawkyMcpServerCommand(runtimeKind: "codex" | "claude" = "codex"): CodexMcpServerCommand {
  const envPrefix = runtimeKind === "claude" ? "HAWKY_CLAUDE_MCP" : "HAWKY_CODEX_MCP";
  const overrideCommand = process.env[`${envPrefix}_COMMAND`]?.trim();
  if (overrideCommand) {
    return {
      command: overrideCommand,
      args: parseEnvStringArray(process.env[`${envPrefix}_ARGS`]),
      cwd: process.env[`${envPrefix}_CWD`]?.trim() || undefined,
    };
  }

  const entrypoint = process.argv[1];
  if (entrypoint) {
    return {
      command: process.execPath,
      args: [entrypoint, "mcp"],
      cwd: process.cwd(),
    };
  }

  return {
    command: resolveRuntimeExecutable("hawky"),
    args: ["mcp"],
    cwd: process.cwd(),
  };
}

export function buildCodexMcpConfigOverrides(
  server: CodexMcpServerCommand = resolveHawkyMcpServerCommand(),
): string[] {
  const overrides = [
    ["mcp_servers.hawky.enabled", "true"],
    ["mcp_servers.hawky.command", tomlString(server.command)],
    ["mcp_servers.hawky.args", tomlStringArray(server.args)],
    ["mcp_servers.hawky.startup_timeout_sec", "10"],
    ["mcp_servers.hawky.tool_timeout_sec", "30"],
    ["mcp_servers.hawky.default_tools_approval_mode", tomlString("auto")],
    ["mcp_servers.hawky.enabled_tools", tomlStringArray([
      "hawky_echo",
      "hawky_session_list",
      "hawky_session_read",
    ])],
  ];

  if (server.cwd) {
    overrides.splice(3, 0, ["mcp_servers.hawky.cwd", tomlString(server.cwd)]);
  }

  return overrides.flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

export function buildClaudeMcpConfig(
  server: CodexMcpServerCommand = resolveHawkyMcpServerCommand("claude"),
): string {
  return JSON.stringify({
    mcpServers: {
      hawky: {
        type: "stdio",
        command: server.command,
        args: server.args,
        env: {},
        alwaysLoad: true,
        timeout: 30_000,
      },
    },
  });
}

function parseEnvStringArray(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Fall through to whitespace splitting.
  }
  return raw.split(/\s+/).filter(Boolean);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function tomlStringArray(values: string[]): string {
  return `[${values.map(tomlString).join(", ")}]`;
}

function commandForRuntime(runtimeKind: Exclude<SessionRuntimeKind, "native">, prompt: string, cwd: string): RuntimeCommand {
  if (runtimeKind === "codex") {
    const cleanupDir = mkdtempSync(join(tmpdir(), "hawky-codex-"));
    const outputPath = join(cleanupDir, "last-message.txt");
    const sandbox = process.env.HAWKY_CODEX_SANDBOX?.trim() || "workspace-write";
    return {
      cmd: resolveRuntimeExecutable("codex"),
      args: [
        "exec",
        ...(codexMcpEnabled() ? buildCodexMcpConfigOverrides() : []),
        "--json",
        "--output-last-message", outputPath,
        "--color", "never",
        "-C", cwd,
        "-s", sandbox,
        "--skip-git-repo-check",
        "-",
      ],
      stdin: prompt,
      env: runtimeEnv(),
      outputPath,
      cleanupDir,
      parseStdout: parseCodexJsonStdout,
      streamJson: "codex",
    };
  }
  if (runtimeKind === "claude") {
    const maxTurns = process.env.HAWKY_CLAUDE_MAX_TURNS?.trim() || "3";
    const tools = process.env.HAWKY_CLAUDE_TOOLS ?? "Read,Grep,Glob";
    const permissionMode = process.env.HAWKY_CLAUDE_PERMISSION_MODE?.trim() || "default";
    const allowedTools = process.env.HAWKY_CLAUDE_ALLOWED_TOOLS?.trim() || "mcp__hawky__*";
    const model = process.env.HAWKY_CLAUDE_MODEL?.trim();
    const args = [
      "-p",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--max-turns", maxTurns,
      "--tools", tools,
      "--permission-mode", permissionMode,
    ];
    if (process.env.HAWKY_CLAUDE_SESSION_PERSISTENCE?.trim() !== "1") {
      args.push("--no-session-persistence");
    }
    if (model) {
      args.push("--model", model);
    }
    if (claudeMcpEnabled()) {
      args.push(
        "--mcp-config", buildClaudeMcpConfig(),
        "--strict-mcp-config",
        "--allowedTools", allowedTools,
      );
    } else {
      args.push("--strict-mcp-config");
    }
    args.push("--", prompt);
    return {
      cmd: resolveRuntimeExecutable("claude"),
      args,
      env: runtimeEnv({
        ...process.env,
        ENABLE_TOOL_SEARCH: process.env.ENABLE_TOOL_SEARCH ?? "false",
      }),
      parseStdout: parseClaudeJsonStdout,
      streamJson: "claude",
    };
  }
  const provider = process.env.HAWKY_HERMES_PROVIDER?.trim();
  const model = process.env.HAWKY_HERMES_MODEL?.trim() || DEFAULT_HERMES_DEEPINFRA_MODEL;
  const maxTurns = process.env.HAWKY_HERMES_MAX_TURNS?.trim();
  const deepinfraHome = provider ? null : maybeCreateDeepInfraHermesHome(model);
  const args = [
    "chat",
    "-q", prompt,
    "-Q",
    "--source", "hawky",
    "--accept-hooks",
    "--yolo",
  ];
  if (provider) args.push("--provider", provider);
  else if (deepinfraHome) args.push("--provider", HAWKY_HERMES_DEEPINFRA_PROVIDER);
  if (model) args.push("-m", model);
  if (maxTurns) args.push("--max-turns", maxTurns);
  return {
    cmd: resolveRuntimeExecutable("hermes", deepinfraHome?.env ?? process.env),
    args,
    env: runtimeEnv(deepinfraHome?.env),
    cleanupDir: deepinfraHome?.home,
    parseStdout: parseHermesStdout,
  };
}

export class ExternalAgentRuntime {
  private child: ChildProcessWithoutNullStreams | null = null;
  private currentText = "";
  private forceKillTimer: ReturnType<typeof setTimeout> | null = null;

  getCurrentTurn(): ExternalAgentCurrentTurn {
    return {
      busy: this.child !== null,
      streaming: this.child !== null && this.currentText.length > 0,
      text: this.currentText,
    };
  }

  cancel(): boolean {
    if (!this.child) return false;
    this.killChild("SIGTERM");
    if (!this.forceKillTimer) {
      this.forceKillTimer = setTimeout(() => this.killChild("SIGKILL"), runtimeKillGraceMs());
    }
    return true;
  }

  private killChild(signal: NodeJS.Signals): void {
    const child = this.child;
    if (!child) return;
    try {
      if (child.pid) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Process may already be gone.
      }
    }
  }

  async sendMessage(opts: ExternalAgentTurnOptions): Promise<ExternalAgentTurnResult> {
    if (this.child) throw new Error(`${opts.runtimeKind} runtime is already running`);

    const timestamp = new Date().toISOString();
    const userMessage: ChatMessage = {
      role: "user",
      content: [{ type: "text", text: opts.message }],
      timestamp,
    };
    const prompt = buildPrompt(opts.history, opts.message, opts.runtimeKind);
    const command = commandForRuntime(opts.runtimeKind, prompt, opts.cwd);
    let stderr = "";
    let stdout = "";
    let runtimeUsage: TokenUsage | undefined;
    let runtimeSessionCostUSD: number | undefined;
    let emittedAssistantText = "";
    const startedToolIds = new Set<string>();
    const completedToolIds = new Set<string>();
    const messages: ChatMessage[] = [userMessage];
    const jsonParser = command.streamJson
      ? new JsonLineStreamParser<CodexJsonLineResult | ClaudeJsonLineResult>(
        command.streamJson === "codex" ? parseCodexJsonLine : parseClaudeJsonLine,
      )
      : null;
    const trace: RuntimeTrace = { startedAtMs: Date.now() };
    this.currentText = "";

    opts.emit({
      type: "system_message",
      subtype: "info",
      content: `Starting experimental ${opts.runtimeKind} agent runtime...`,
    });

    let assistantText: string;
    try {
      assistantText = await new Promise<string>((resolve, reject) => {
        const child = spawn(command.cmd, command.args, {
          cwd: opts.cwd,
          env: command.env ?? process.env,
          detached: true,
        });
        this.child = child;
        let timedOut = false;
        const timeout = setTimeout(() => {
          timedOut = true;
          trace.timedOut = true;
          this.killChild("SIGTERM");
          if (!this.forceKillTimer) {
            this.forceKillTimer = setTimeout(() => this.killChild("SIGKILL"), runtimeKillGraceMs());
          }
        }, runtimeTurnTimeoutMs());

        let nextTextShouldReplace = false;

        const emitTextDelta = (text: string): void => {
          if (!text) return;
          if (nextTextShouldReplace) {
            emitTextReplacement(text);
            return;
          }
          emittedAssistantText += text;
          this.currentText = emittedAssistantText;
          if (trace.firstTextMs == null) trace.firstTextMs = Date.now() - trace.startedAtMs;
          opts.emit({ type: "text", content: text });
        };

        const resetTextSegment = (): void => {
          nextTextShouldReplace = nextTextShouldReplace || emittedAssistantText.trim().length > 0;
          emittedAssistantText = "";
          this.currentText = "";
        };

        const emitTextReplacement = (text: string): void => {
          if (!text) return;
          emittedAssistantText = text;
          this.currentText = text;
          nextTextShouldReplace = false;
          if (trace.firstTextMs == null) trace.firstTextMs = Date.now() - trace.startedAtMs;
          opts.emit({ type: "text", content: text, replace: true });
        };

        const reconcileFinalText = (text: string): void => {
          const finalText = text.trim();
          if (!finalText) return;
          const currentText = emittedAssistantText.trim();
          if (!currentText) {
            if (nextTextShouldReplace) emitTextReplacement(finalText);
            else emitTextDelta(finalText);
            return;
          }
          if (currentText === finalText) {
            emittedAssistantText = finalText;
            this.currentText = finalText;
            return;
          }
          if (finalText.startsWith(emittedAssistantText)) {
            emitTextDelta(finalText.slice(emittedAssistantText.length));
            return;
          }
          emitTextReplacement(finalText);
        };

        const emitToolStart = (tool: RuntimeToolStart): void => {
          if (!tool.tool_use_id || startedToolIds.has(tool.tool_use_id)) return;
          startedToolIds.add(tool.tool_use_id);
          resetTextSegment();
          messages.push({
            role: "assistant",
            content: [{
              type: "tool_use",
              id: tool.tool_use_id,
              name: tool.name,
              input: tool.input,
            }],
            timestamp: new Date().toISOString(),
          });
          if (trace.firstEventMs == null) trace.firstEventMs = Date.now() - trace.startedAtMs;
          opts.emit({
            type: "tool_use_start",
            tool_use_id: tool.tool_use_id,
            name: tool.name,
            input: tool.input,
            approvalReason: "auto_approve",
          });
        };

        const emitToolResult = (tool: RuntimeToolResult): void => {
          if (!tool.tool_use_id || completedToolIds.has(tool.tool_use_id)) return;
          if (!startedToolIds.has(tool.tool_use_id)) {
            emitToolStart({
              tool_use_id: tool.tool_use_id,
              name: tool.name,
              input: {},
            });
          }
          completedToolIds.add(tool.tool_use_id);
          messages.push({
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: tool.tool_use_id,
              content: tool.content,
              is_error: tool.is_error,
            }],
            timestamp: new Date().toISOString(),
          });
          opts.emit({
            type: "tool_result",
            tool_use_id: tool.tool_use_id,
            name: tool.name,
            content: tool.content,
            is_error: tool.is_error,
          });
        };

        const handleCodexResult = (result: CodexJsonLineResult) => {
          if (trace.firstEventMs == null) trace.firstEventMs = Date.now() - trace.startedAtMs;
          if (result.usage) runtimeUsage = result.usage;
          for (const tool of result.toolStarts ?? []) emitToolStart(tool);
          for (const tool of result.toolResults ?? []) emitToolResult(tool);
          if (result.assistantText) {
            reconcileFinalText(result.assistantText);
          }
          if (result.eventType && result.eventType !== "item.completed") {
            log.debug("codex runtime event", {
              sessionKey: opts.sessionKey,
              eventType: result.eventType,
              itemType: result.itemType,
            });
          }
        };

        const handleClaudeResult = (result: ClaudeJsonLineResult) => {
          if (trace.firstEventMs == null) trace.firstEventMs = Date.now() - trace.startedAtMs;
          if (result.usage) runtimeUsage = result.usage;
          if (result.totalCostUSD != null) runtimeSessionCostUSD = result.totalCostUSD;
          for (const tool of result.toolStarts ?? []) emitToolStart(tool);
          for (const tool of result.toolResults ?? []) emitToolResult(tool);
          if (result.assistantTextDelta) {
            emitTextDelta(result.assistantTextDelta);
          } else if (result.assistantText) {
            reconcileFinalText(result.assistantText);
          } else if (result.resultText) {
            reconcileFinalText(result.resultText);
          }
          if (
            result.eventType &&
            result.eventType !== "stream_event" &&
            result.eventType !== "assistant" &&
            result.eventType !== "result"
          ) {
            log.debug("claude runtime event", {
              sessionKey: opts.sessionKey,
              eventType: result.eventType,
              subtype: result.subtype,
              streamEventType: result.streamEventType,
            });
          }
        };

        const handleJsonResult = (result: CodexJsonLineResult | ClaudeJsonLineResult) => {
          if (command.streamJson === "claude") handleClaudeResult(result as ClaudeJsonLineResult);
          else handleCodexResult(result as CodexJsonLineResult);
        };

        child.stdout.on("data", (chunk: Buffer) => {
          const text = chunk.toString("utf8");
          stdout += text;
          if (trace.firstEventMs == null) trace.firstEventMs = Date.now() - trace.startedAtMs;
          jsonParser?.push(text, handleJsonResult);
        });

        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });

        child.on("error", (err) => {
          clearTimeout(timeout);
          this.child = null;
          const executable = opts.runtimeKind === "hermes"
            ? "Hermes"
            : opts.runtimeKind === "claude"
              ? "Claude Code"
              : "Codex";
          reject(new Error(`${executable} runtime failed to start (${command.cmd}): ${err.message}`));
        });

        child.on("close", (code, signal) => {
          clearTimeout(timeout);
          if (this.forceKillTimer) {
            clearTimeout(this.forceKillTimer);
            this.forceKillTimer = null;
          }
          trace.completedAtMs = Date.now();
          trace.exitCode = code;
          trace.signal = signal;
          trace.cancelled = signal === "SIGTERM" || signal === "SIGKILL";
          this.child = null;
          jsonParser?.finish(handleJsonResult);
          if (timedOut) {
            reject(new Error(`${opts.runtimeKind} runtime timed out after ${runtimeTurnTimeoutMs()}ms`));
            return;
          }
          if (code === 0) {
            const parsed = command.parseStdout?.(stdout, command.outputPath) ?? { text: stripAnsi(stdout).trim() };
            if (parsed.usage) runtimeUsage = parsed.usage;
            const parsedText = parsed.text.trim();
            if (parsedText && parsedText !== emittedAssistantText.trim()) {
              reconcileFinalText(parsedText);
            }
            log.info("external runtime completed", {
              sessionKey: opts.sessionKey,
              runtimeKind: opts.runtimeKind,
              durationMs: trace.completedAtMs - trace.startedAtMs,
              firstEventMs: trace.firstEventMs,
              firstTextMs: trace.firstTextMs,
              exitCode: code,
            });
            resolve(parsedText || emittedAssistantText);
            return;
          }
          const output = [stderr.trim(), stdout.trim()].filter(Boolean).join("\n\n");
          const suffix = output ? `\n\n${output}` : "";
          reject(new Error(`${command.cmd} exited with ${signal ?? code}${suffix}`));
        });

        if (typeof command.stdin === "string") {
          child.stdin.end(command.stdin);
        } else {
          child.stdin.end();
        }
      });
    } finally {
      if (this.forceKillTimer) {
        clearTimeout(this.forceKillTimer);
        this.forceKillTimer = null;
      }
      if (command.cleanupDir) rmSync(command.cleanupDir, { recursive: true, force: true });
    }

    const assistantMessage: ChatMessage = {
      role: "assistant",
      content: [{ type: "text", text: assistantText }],
      timestamp: new Date().toISOString(),
    };
    messages.push(assistantMessage);
    this.currentText = "";
    opts.emit({
      type: "done",
      ...(runtimeUsage ? { usage: runtimeUsage } : {}),
      ...(runtimeSessionCostUSD != null ? { sessionCostUSD: runtimeSessionCostUSD } : {}),
    });
    return { userMessage, assistantMessage, messages, assistantText };
  }
}
