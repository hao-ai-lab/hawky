// =============================================================================
// Slash Command System
//
// Registry-based command system. Commands start with "/" and are parsed
// before being sent to the agent. Each command has a handler that receives
// args and a context object, and returns a result string to display.
// =============================================================================

import { listSessions, readLastSession } from "../storage/session.js";
import { loadAllSkills } from "../skills/loader.js";
// MCP status fetched via RPC (gateway-side), not local singleton
import { formatSkillsForDisplay } from "../skills/prompt.js";
import { buildSkillCommands, formatSkillInvocation } from "../skills/commands.js";
import { createSkill } from "../skills/create.js";
import { getWorkspaceDir } from "../storage/workspace.js";
import { getConfigPath } from "../storage/config.js";
import { buildSkillStatusReport, formatSkillStatusReport } from "../skills/status.js";
import { getHeartbeatConfigStatus, formatHeartbeatStatus } from "../gateway/heartbeat-setup.js";
import { runDoctorChecks, formatDoctorReport } from "../commands/doctor.js";
import { loadConfig } from "../storage/config.js";

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface CommandContext {
  /** Current model name */
  model: string;
  /** Current working directory */
  workingDirectory: string;
  /** Current session ID */
  sessionId: string;
  /**
   * Accumulated token usage. cache_read / cache_creation are present
   * once prompt caching engages — display sites should sum all three
   * input buckets to represent total input the model processed.
   */
  tokenUsage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | null;
  /** Number of display messages (user + assistant turns) */
  messageCount: number;
  /** Git info (if available) */
  gitBranch?: string;
  /** Previous session key (set by /heartbeat, read by /back) */
  previousSessionKey: string | null;
  /** Set the previous session key */
  setPreviousSessionKey: (key: string | null) => void;
  /** Callbacks for commands that modify state */
  exit: () => void;
  clearMessages: () => void;
  newSession: () => void;
  flushMemory: () => void;
  triggerCompaction: () => void;
  /** Fetch MCP server status from gateway and display as system message. */
  fetchMcpStatus: () => void;
  switchModel: (model: string) => void;
  resumeSession: (sessionId: string) => void;
  showStatusPanel: (tab?: "cost" | "usage" | "errors") => void;
  /** Toggle bypass mode (auto-approve all tools). Returns message or null if async. */
  toggleBypass: (enable: boolean) => string | null;
  /** Set effort level. */
  setEffort: (effort: string) => string | null;
  /** Get current effort level. */
  getEffort: () => void;
  /** Set/get permission mode. Returns message or null if async. */
  setPermissionMode: (mode: string) => string | null;
  /** Get current permission mode name (async — displays via system message). */
  getPermissionMode: () => string;
  /** Fork a system session's last run into a new interactive session. */
  forkSession: () => void;
  /** Rename a session (set display name). */
  renameSession: (sessionKey: string, displayName: string) => void;
  /** Archive a session (hide from list). */
  archiveSession: (sessionKey: string) => void;
  /** Delete a session permanently. */
  deleteSession: (sessionKey: string) => void;
  /** Pin/unpin a session. */
  pinSession: (sessionKey: string) => void;
  unpinSession: (sessionKey: string) => void;
  /** Provider management (async — result via system message). */
  swapProvider: (spec: { provider: string; active_profile?: string }) => void;
  addProfile: (params: { name: string; base_url: string; api_key?: string; api_key_env?: string; model?: string; overwrite?: boolean }) => void;
  removeProfile: (name: string) => void;
  renameProfile: (oldName: string, newName: string) => void;
  /** Return the current provider config (synchronous snapshot). */
  getProviderConfig: () => { provider: string; active_profile?: string; profiles?: Record<string, unknown> };
}

export interface CommandResult {
  /** Text to display as a system message (null = no output) */
  text: string | null;
  /** If true, the command handled everything (don't show error) */
  handled: boolean;
  /** If set, send this as a regular message to the agent (for skill commands) */
  skillMessage?: string;
}

interface CommandDef {
  name: string;
  description: string;
  aliases: string[];
  handler: (args: string[], ctx: CommandContext) => CommandResult;
}

// -----------------------------------------------------------------------------
// Command registry
// -----------------------------------------------------------------------------

const commands: CommandDef[] = [];
const commandMap = new Map<string, CommandDef>();

function register(def: CommandDef): void {
  commands.push(def);
  commandMap.set(def.name, def);
  for (const alias of def.aliases) {
    commandMap.set(alias, def);
  }
}

// -----------------------------------------------------------------------------
// Parser
// -----------------------------------------------------------------------------

export interface ParsedCommand {
  name: string;
  args: string[];
}

export function parseCommand(input: string): ParsedCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;

  const parts = trimmed.slice(1).split(/\s+/);
  const name = parts[0]?.toLowerCase() ?? "";
  const args = parts.slice(1);

  if (!name) return null;
  return { name, args };
}

export function isCommand(input: string): boolean {
  return input.trim().startsWith("/");
}

// -----------------------------------------------------------------------------
// Executor
// -----------------------------------------------------------------------------

export function executeCommand(input: string, ctx: CommandContext): CommandResult {
  const parsed = parseCommand(input);
  if (!parsed) {
    return { text: null, handled: false };
  }

  // Check built-in commands first
  const cmd = commandMap.get(parsed.name);
  if (cmd) {
    return cmd.handler(parsed.args, ctx);
  }

  // Check skill commands (dynamically loaded)
  try {
    const skills = loadAllSkills(ctx.workingDirectory);
    const skillCommands = buildSkillCommands(skills);
    const skillCmd = skillCommands.find((sc) => sc.name === parsed.name);
    if (skillCmd) {
      // Send as a regular message to the agent (via sendMessage callback if available)
      const message = formatSkillInvocation(skillCmd, parsed.args.join(" "));
      return { text: null, handled: false, skillMessage: message };
    }
  } catch { /* skill loading failure — fall through to unknown command */ }

  const available = commands.map((c) => `/${c.name}`).join(", ");
  return {
    text: `Unknown command: /${parsed.name}. Available: ${available}`,
    handled: true,
  };
}

/** Get all registered commands (for /help) */
export function getCommands(): CommandDef[] {
  return commands;
}

// -----------------------------------------------------------------------------
// Built-in commands
// -----------------------------------------------------------------------------

register({
  name: "help",
  description: "Show available commands",
  aliases: [],
  handler: () => {
    const lines = ["Available commands:", ""];
    for (const cmd of commands) {
      const aliases = cmd.aliases.length > 0 ? ` (${cmd.aliases.map((a) => `/${a}`).join(", ")})` : "";
      lines.push(`  /${cmd.name}${aliases} — ${cmd.description}`);
    }
    return { text: lines.join("\n"), handled: true };
  },
});

register({
  name: "exit",
  description: "Exit the TUI",
  aliases: ["quit"],
  handler: (_args, ctx) => {
    ctx.exit();
    return { text: null, handled: true };
  },
});

register({
  name: "clear",
  description: "Clear message display (agent history preserved)",
  aliases: [],
  handler: (_args, ctx) => {
    ctx.clearMessages();
    return { text: "Messages cleared.", handled: true };
  },
});

register({
  name: "flush",
  description: "Extract durable memories from this conversation into daily logs",
  aliases: [],
  handler: (_args, ctx) => {
    ctx.flushMemory();
    // No static text — live indicator in status bar shows progress.
    // If skipped (too short, already flushed, disabled), the server broadcasts
    // flush.skipped and the TUI shows the reason in the status bar.
    return { text: null, handled: true };
  },
});

register({
  name: "model",
  description: "Show or switch model (e.g., /model claude-haiku-4-5)",
  aliases: [],
  handler: (args, ctx) => {
    if (args.length === 0) {
      return { text: `Current model: ${ctx.model}`, handled: true };
    }
    ctx.switchModel(args[0]);
    return { text: `Model switched to: ${args[0]}`, handled: true };
  },
});

/** Convert a gateway session ID (gw-tui-main) to a user-friendly key (tui:main). */
function sessionIdToKey(id: string): string {
  if (id.startsWith("gw-")) {
    // Replace first hyphen after "gw-" section with ":" to restore key format
    // gw-tui-main → tui:main, gw-web-tab-abc → web:tab-abc
    const withoutPrefix = id.slice(3);
    const firstDash = withoutPrefix.indexOf("-");
    if (firstDash >= 0) {
      return withoutPrefix.slice(0, firstDash) + ":" + withoutPrefix.slice(firstDash + 1);
    }
    return withoutPrefix;
  }
  return id;
}

register({
  name: "resume",
  description: "Switch to a different session (e.g., /resume tui:main)",
  aliases: [],
  handler: (args, ctx) => {
    if (args.length > 0) {
      ctx.resumeSession(args[0]);
      return { text: null, handled: true };
    }
    // No argument — list recent sessions
    const sessions = listSessions(10);
    if (sessions.length === 0) {
      return { text: "No previous sessions found.", handled: true };
    }
    const lines = ["Recent sessions:", ""];
    for (const s of sessions) {
      const key = sessionIdToKey(s.id);
      const date = s.createdAt ? new Date(s.createdAt).toLocaleDateString() : "unknown";
      lines.push(`  ${key}  (${s.messageCount} msgs, ${date})`);
    }
    lines.push("");
    lines.push("Use /resume <key> to switch to a session.");
    return { text: lines.join("\n"), handled: true };
  },
});

register({
  name: "sessions",
  description: "List recent sessions",
  aliases: [],
  handler: () => {
    const sessions = listSessions(10);
    if (sessions.length === 0) {
      return { text: "No sessions found.", handled: true };
    }
    const lines = ["Recent sessions:", ""];
    for (const s of sessions) {
      const key = sessionIdToKey(s.id);
      const date = s.createdAt ? new Date(s.createdAt).toLocaleDateString() : "unknown";
      lines.push(`  ${key}  (${s.messageCount} msgs, ${date})`);
    }
    return { text: lines.join("\n"), handled: true };
  },
});

register({
  name: "history",
  description: "Show conversation stats (turns, tokens)",
  aliases: [],
  handler: (_args, ctx) => {
    const lines = ["Conversation history:"];
    lines.push(`  Messages: ${ctx.messageCount}`);
    if (ctx.tokenUsage) {
      const cacheRead = ctx.tokenUsage.cache_read_input_tokens ?? 0;
      const cacheCreation = ctx.tokenUsage.cache_creation_input_tokens ?? 0;
      const totalInput = ctx.tokenUsage.input_tokens + cacheRead + cacheCreation;
      lines.push(`  Input tokens: ${totalInput.toLocaleString()} (fresh ${ctx.tokenUsage.input_tokens.toLocaleString()}, cached ${cacheRead.toLocaleString()}, cache-write ${cacheCreation.toLocaleString()})`);
      lines.push(`  Output tokens: ${ctx.tokenUsage.output_tokens.toLocaleString()}`);
      lines.push(`  Total tokens: ${(totalInput + ctx.tokenUsage.output_tokens).toLocaleString()}`);
    } else {
      lines.push("  Tokens: (no usage data yet)");
    }
    return { text: lines.join("\n"), handled: true };
  },
});

register({
  name: "status",
  description: "Open status panel (Cost / Usage / Errors)",
  aliases: [],
  handler: (_args, ctx) => {
    ctx.showStatusPanel("cost");
    return { text: null, handled: true };
  },
});

register({
  name: "cost",
  description: "Show cost & token usage",
  aliases: [],
  handler: (_args, ctx) => {
    ctx.showStatusPanel("cost");
    return { text: null, handled: true };
  },
});

register({
  name: "usage",
  description: "Show usage history",
  aliases: [],
  handler: (_args, ctx) => {
    ctx.showStatusPanel("usage");
    return { text: null, handled: true };
  },
});

register({
  name: "session",
  description: "Show current session info",
  aliases: [],
  handler: (_args, ctx) => {
    const lines = ["Session info:"];
    lines.push(`  Session ID:  ${ctx.sessionId}`);
    lines.push(`  Model:       ${ctx.model}`);
    lines.push(`  Working dir: ${ctx.workingDirectory}`);
    if (ctx.gitBranch) lines.push(`  Git branch:  ${ctx.gitBranch}`);
    lines.push(`  Messages:    ${ctx.messageCount}`);
    return { text: lines.join("\n"), handled: true };
  },
});

register({
  name: "errors",
  description: "Show recent errors",
  aliases: [],
  handler: (_args, ctx) => {
    ctx.showStatusPanel("errors");
    return { text: null, handled: true };
  },
});

register({
  name: "heartbeat",
  description: "Switch to the heartbeat session (view/interact with background agent)",
  aliases: ["hb"],
  handler: (_args, ctx) => {
    ctx.setPreviousSessionKey(ctx.sessionId);
    ctx.resumeSession("heartbeat:main");
    return { text: null, handled: true };
  },
});

register({
  name: "back",
  description: "Return to the previous session (after /heartbeat)",
  aliases: [],
  handler: (_args, ctx) => {
    if (ctx.previousSessionKey) {
      const target = ctx.previousSessionKey;
      ctx.setPreviousSessionKey(null);
      ctx.resumeSession(target);
      return { text: null, handled: true };
    }
    return { text: "No previous session to return to. Use /resume <key>.", handled: true };
  },
});

register({
  name: "fork",
  description: "Fork the current system session's last run into a new interactive chat",
  aliases: [],
  handler: (_args, ctx) => {
    const isSystem = ctx.sessionId.startsWith("cron:") || ctx.sessionId.startsWith("heartbeat:");
    if (!isSystem) {
      return { text: "/fork only works on system sessions (cron or heartbeat). Switch to one first.", handled: true };
    }
    ctx.forkSession();
    return { text: null, handled: true };
  },
});

register({
  name: "cron",
  description: "Manage cron jobs (list, add, delete, run, status, history)",
  aliases: [],
  handler: (args, _ctx) => {
    // /cron with no args → send as agent message to use cron tool
    if (args.length === 0) {
      return { text: null, handled: false, skillMessage: "List all my cron jobs using the cron tool." };
    }
    const sub = args[0].toLowerCase();
    if (sub === "list") {
      return { text: null, handled: false, skillMessage: "List all my cron jobs using the cron tool." };
    }
    if (sub === "status") {
      return { text: null, handled: false, skillMessage: "Show cron scheduler status using the cron tool." };
    }
    if (sub === "run") {
      if (!args[1]) {
        return { text: "Usage: /cron run <id-or-name>\n\nForce-run a cron job immediately. Use /cron list to see job IDs.", handled: true };
      }
      return { text: null, handled: false, skillMessage: `Force-run cron job "${args.slice(1).join(" ")}" using the cron tool.` };
    }
    if (sub === "delete" || sub === "remove") {
      if (!args[1]) {
        return { text: "Usage: /cron delete <id-or-name>\n\nRemove a cron job. Use /cron list to see job IDs.", handled: true };
      }
      return { text: null, handled: false, skillMessage: `Remove cron job "${args.slice(1).join(" ")}" using the cron tool.` };
    }
    if (sub === "history") {
      if (!args[1]) {
        return { text: "Usage: /cron history <id-or-name>\n\nShow run history for a cron job. Use /cron list to see job IDs.", handled: true };
      }
      return { text: null, handled: false, skillMessage: `Show run history for cron job "${args.slice(1).join(" ")}" using the cron tool.` };
    }
    if (sub === "add") {
      return { text: "To create a cron job, describe it in natural language:\n\n  \"Create a cron job to check PRs every morning at 9am\"\n  \"Remind me to review paper drafts every Friday at 3pm\"\n\nThe agent will set up the schedule and prompt for you.", handled: true };
    }
    return { text: `Unknown /cron subcommand: ${sub}.\n\nAvailable:\n  /cron           — list all jobs\n  /cron list      — list all jobs\n  /cron status    — scheduler status\n  /cron run <id>  — force-run a job\n  /cron delete <id> — remove a job\n  /cron history <id> — show run history\n  /cron add       — guidance on creating jobs`, handled: true };
  },
});

register({
  name: "compact",
  description: "Summarize old messages to free context space",
  aliases: [],
  handler: (_args, ctx) => {
    ctx.triggerCompaction();
    return { text: null, handled: true };
  },
});

register({
  name: "setup",
  description: "Run the setup wizard (API keys, skills, heartbeat, memory)",
  aliases: [],
  handler: (_args, ctx) => {
    const configPath = getConfigPath();
    const wsDir = getWorkspaceDir();
    const setupPath = `${wsDir}/SETUP.md`;

    // Build skill status report for the agent (use workspace root, not cwd)
    let skillStatus = "";
    try {
      const report = buildSkillStatusReport(wsDir);
      skillStatus = formatSkillStatusReport(report);
    } catch {
      skillStatus = "Could not detect skill status.";
    }

    // Build heartbeat config status
    let heartbeatStatus = "";
    try {
      const config = loadConfig();
      const hbStatus = getHeartbeatConfigStatus(config);
      heartbeatStatus = formatHeartbeatStatus(hbStatus);
    } catch {
      heartbeatStatus = "Could not read heartbeat config.";
    }

    return {
      text: null,
      handled: false,
      skillMessage: [
        "The user ran /setup. Read the setup wizard instructions from your workspace file and guide them through configuration.",
        "",
        `Config file path: ${configPath}`,
        `Workspace directory: ${wsDir}`,
        `Setup instructions: ${setupPath}`,
        "",
        "Current skill status:",
        skillStatus,
        "",
        "Current heartbeat status:",
        heartbeatStatus,
        "",
        "Start by reading the SETUP.md file, then check current configuration status.",
        "If setup has been completed before (setup_completed_at is set in config), ask what they'd like to reconfigure instead of running the full flow.",
      ].join("\n"),
    };
  },
});

register({
  name: "doctor",
  description: "Check system health (API keys, skills, heartbeat, memory)",
  aliases: ["health"],
  handler: (_args, ctx) => {
    try {
      const report = runDoctorChecks(ctx.model);
      return { text: formatDoctorReport(report), handled: true };
    } catch (err) {
      return {
        text: `Health check failed: ${err instanceof Error ? err.message : String(err)}`,
        handled: true,
      };
    }
  },
});

register({
  name: "mcp",
  description: "Show connected MCP servers and their tools",
  aliases: [],
  handler: (_args, ctx) => {
    ctx.fetchMcpStatus();
    return { text: null, handled: true };
  },
});

register({
  name: "skills",
  description: "List available skills and their status",
  aliases: [],
  handler: (_args, ctx) => {
    try {
      const skills = loadAllSkills(ctx.workingDirectory);
      return { text: formatSkillsForDisplay(skills), handled: true };
    } catch (err) {
      return { text: `Error loading skills: ${err instanceof Error ? err.message : String(err)}`, handled: true };
    }
  },
});

register({
  name: "skill-create",
  description: "Create a custom skill skeleton",
  aliases: [],
  handler: (args, ctx) => {
    const name = args[0];
    if (!name) {
      return {
        text: "Usage: /skill-create <name> [description]\n\nCreates a new skill in your workspace skills/ directory.",
        handled: true,
      };
    }
    const description = args.slice(1).join(" ") || undefined;
    const result = createSkill(name, description, "workspace", getWorkspaceDir());
    if (result.ok) {
      return { text: `✓ Created skill '${name}' at ${result.path}\n\nEdit the SKILL.md to add your instructions. The skill will be auto-discovered on next prompt.`, handled: true };
    }
    return { text: `✗ ${result.error}`, handled: true };
  },
});

register({
  name: "mode",
  description: "Show or switch permission mode (default / accept-edits / bypass)",
  aliases: [],
  handler: (args, ctx) => {
    if (args.length === 0) {
      ctx.getPermissionMode();
      return { text: null, handled: true };
    }
    const mode = args[0];
    const validModes = ["default", "accept-edits", "bypass"];
    if (!validModes.includes(mode)) {
      return { text: `Invalid mode: ${mode}. Must be one of: ${validModes.join(", ")}`, handled: true };
    }
    const result = ctx.setPermissionMode(mode);
    return { text: result, handled: true };
  },
});

register({
  name: "effort",
  description: "Show or set effort level (low / medium / high / xhigh / max)",
  aliases: ["think"],
  handler: (args, ctx) => {
    if (args.length === 0) {
      ctx.getEffort();
      return { text: null, handled: true };
    }
    const valid = ["low", "medium", "high", "xhigh", "max"];
    if (!valid.includes(args[0])) {
      return { text: `Invalid: ${args[0]}. Must be one of: ${valid.join(", ")}`, handled: true };
    }
    const result = ctx.setEffort(args[0]);
    return { text: result, handled: true };
  },
});

register({
  name: "bypass",
  description: "Auto-approve all tools (⚠ dangerous). Same as /mode bypass",
  aliases: [],
  handler: (_args, ctx) => {
    const result = ctx.setPermissionMode("bypass");
    return { text: result, handled: true };
  },
});

register({
  name: "bypass-off",
  description: "Restore permission prompts. Same as /mode default",
  aliases: [],
  handler: (_args, ctx) => {
    const result = ctx.setPermissionMode("default");
    return { text: result, handled: true };
  },
});

register({
  name: "rename",
  description: "Set a display name for the current session",
  aliases: [],
  handler: (args, ctx) => {
    const name = args.join(" ").trim();
    if (!name) {
      return { text: "Usage: /rename <display name>", handled: true };
    }
    ctx.renameSession(ctx.sessionId, name);
    return { text: `Session renamed to: ${name}`, handled: true };
  },
});

register({
  name: "archive",
  description: "Archive the current session (hide from list, keep log)",
  aliases: [],
  handler: (_args, ctx) => {
    ctx.archiveSession(ctx.sessionId);
    return { text: "Session archived.", handled: true };
  },
});

register({
  name: "delete",
  description: "Permanently delete the current session and its log",
  aliases: [],
  handler: (args, ctx) => {
    // Require --confirm flag to prevent accidental deletion
    if (!args.includes("--confirm")) {
      return {
        text: "This will permanently delete the session and its conversation log.\nRe-run with --confirm to proceed: /delete --confirm",
        handled: true,
      };
    }
    ctx.deleteSession(ctx.sessionId);
    return { text: "Session deleted.", handled: true };
  },
});

register({
  name: "pin",
  description: "Pin the current session to the top of the list",
  aliases: [],
  handler: (_args, ctx) => {
    ctx.pinSession(ctx.sessionId);
    return { text: "Session pinned.", handled: true };
  },
});

register({
  name: "unpin",
  description: "Unpin the current session",
  aliases: [],
  handler: (_args, ctx) => {
    ctx.unpinSession(ctx.sessionId);
    return { text: "Session unpinned.", handled: true };
  },
});

register({
  name: "provider",
  description: "Show or swap LLM provider. Sub-commands: list, add, remove, rename",
  aliases: [],
  handler: (args, ctx) => {
    const sub = args[0]?.toLowerCase();

    // /provider or /provider list — show current state
    if (!sub || sub === "list") {
      const cfg = ctx.getProviderConfig();
      const lines = [`Provider: ${cfg.provider}`];
      if (cfg.active_profile) lines.push(`Active profile: ${cfg.active_profile}`);
      if (cfg.profiles && Object.keys(cfg.profiles).length > 0) {
        lines.push("Profiles:");
        for (const [name, prof] of Object.entries(cfg.profiles)) {
          const p = prof as { base_url?: string; model?: string; api_key?: string; api_key_env?: string };
          const keySource = p.api_key ? "api_key" : p.api_key_env ? `env:${p.api_key_env}` : "shared";
          lines.push(`  ${name}  ${p.base_url ?? ""}  model=${p.model ?? "(default)"}  key=${keySource}`);
        }
      }
      return { text: lines.join("\n"), handled: true };
    }

    // /provider add <name> [--base-url X] [--api-key Y] [--api-key-env E] [--model M] [--overwrite]
    if (sub === "add") {
      const name = args[1];
      if (!name) {
        return { text: "Usage: /provider add <name> --base-url <url> [--api-key <key>] [--api-key-env <ENV>] [--model <id>] [--overwrite]", handled: true };
      }
      const buIdx = args.indexOf("--base-url");
      const baseUrl = buIdx >= 0 ? (args[buIdx + 1] ?? "") : "";
      if (!baseUrl || baseUrl.startsWith("--")) {
        return { text: "Missing --base-url <url>", handled: true };
      }
      const apiKeyIdx = args.indexOf("--api-key");
      const apiKey = apiKeyIdx >= 0 ? args[apiKeyIdx + 1] : undefined;
      const apiKeyEnvIdx = args.indexOf("--api-key-env");
      const apiKeyEnv = apiKeyEnvIdx >= 0 ? args[apiKeyEnvIdx + 1] : undefined;
      const modelIdx = args.indexOf("--model");
      const model = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
      const overwrite = args.includes("--overwrite");
      ctx.addProfile({ name, base_url: baseUrl, api_key: apiKey, api_key_env: apiKeyEnv, model, overwrite });
      return { text: null, handled: true };
    }

    // /provider remove <name>
    if (sub === "remove" || sub === "delete") {
      const name = args[1];
      if (!name) return { text: `Usage: /provider ${sub} <name>`, handled: true };
      ctx.removeProfile(name);
      return { text: null, handled: true };
    }

    // /provider rename <old> <new>
    if (sub === "rename") {
      const oldName = args[1];
      const newName = args[2];
      if (!oldName || !newName) return { text: "Usage: /provider rename <old> <new>", handled: true };
      ctx.renameProfile(oldName, newName);
      return { text: null, handled: true };
    }

    // /provider <spec> — swap provider
    // spec: anthropic | vertex | openai | openai_compatible:<profile>
    const spec = args[0];
    const colonIdx = spec.indexOf(":");
    const providerName = colonIdx >= 0 ? spec.slice(0, colonIdx) : spec;
    const profileName = colonIdx >= 0 ? spec.slice(colonIdx + 1) : undefined;
    const valid = ["anthropic", "vertex", "openai", "openai_compatible"];
    if (!valid.includes(providerName)) {
      return {
        text: `Unknown provider "${providerName}". Valid: ${valid.join(", ")}\nFor openai_compatible: /provider openai_compatible:<profile>`,
        handled: true,
      };
    }
    ctx.swapProvider({ provider: providerName, active_profile: profileName });
    return { text: null, handled: true };
  },
});
