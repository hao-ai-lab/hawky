// =============================================================================
// Context Builder
//
// Builds the system prompt and formats conversation history for the API.
//
// System prompt structure (all in the `system` API parameter, cached):
//   1. Identity — Hawky dual-role identity (coding agent + PA)
//   2. Environment — OS, shell, git, model, date
//   3. Tool Usage Guidelines — bash avoidance, tool preferences
//   4. Memory Recall — instructions to use memory_search/memory_get
//   5. Git Safety — destructive operation warnings
//   6. Silent Replies & Heartbeats — HEARTBEAT_OK guidance
//   7. # Project Context — bootstrap files (AGENTS, SOUL, USER, IDENTITY,
//      MEMORY, TOOLS, HEARTBEAT, BOOTSTRAP) with per-file truncation
//   8. # Per-Repo Instructions — HAWKY.md / CLAUDE.md from project dir
//
// Per-turn reminders are injected into user messages (not system prompt).
// Daily logs (memory/*.md) are NOT in the prompt — accessed via tools.
// =============================================================================

import type {
  ChatMessage,
  ContentBlock,
} from "./types.js";
import type { LLMMessage } from "./provider.js";
import {
  detectEnvironment,
  loadProjectInstructions,
} from "./environment.js";
import { normalizeMessages } from "./normalize.js";
import { loadAllSkills } from "../skills/loader.js";
import { getMcpServerManager } from "../mcp/server-manager.js";
import { buildSkillsPromptSection } from "../skills/prompt.js";
import { getPrompt } from "../prompts/index.js";
import { isSkillsDirty, clearSkillsDirty } from "../skills/watcher.js";
import {
  WorkspaceManager,
  type BootstrapFile,
} from "../storage/workspace.js";

// -----------------------------------------------------------------------------
// System prompt
// -----------------------------------------------------------------------------

export interface SystemPromptOptions {
  working_directory: string;
  model: string;
  custom_instructions?: string;
  /** Workspace directory for bootstrap files. If not set, uses default. */
  workspace_dir?: string;
  /** If false, excludes MEMORY.md from bootstrap (security). Default: true. */
  main_session?: boolean;
  /** Pre-built skills prompt section (if already computed). */
  skills_prompt?: string;
  /** Headless mode: no interactive user, suppress ask_user guidance. */
  headless?: boolean;
}

export function buildSystemPrompt(options: SystemPromptOptions): string {
  const env = detectEnvironment(options.working_directory);
  const instructions = loadProjectInstructions(
    options.working_directory,
    env.git?.root ?? null,
  );

  const sections: string[] = [];

  // --- § Identity ---
  sections.push(getPrompt("agent.system.persona"));

  // Resolve workspace path for display
  const wsManager = new WorkspaceManager(options.workspace_dir);
  const workspacePath = wsManager.getWorkspacePath();

  // --- § Environment ---
  sections.push("");
  sections.push("# Environment");
  sections.push(`- Working directory: ${options.working_directory}`);
  sections.push(`- Workspace: ${workspacePath}`);
  sections.push(`- Platform: ${env.platform} (${env.osVersion})`);
  sections.push(`- Architecture: ${env.architecture}`);
  sections.push(`- Shell: ${env.shell}`);
  sections.push(`- Model: ${options.model}`);
  sections.push(`- Date: ${formatLocalDate(new Date())}`);

  if (env.git) {
    sections.push(`- Git: ${env.git.repoName} (branch: ${env.git.branch}, root: ${env.git.root})`);
  }

  // --- § Tool Usage Guidelines ---
  sections.push("");
  sections.push("# Tool Usage Guidelines");
  sections.push("- Read files before modifying them. Understand existing code before suggesting changes.");
  sections.push("- Use tools to accomplish tasks rather than just describing what to do.");
  sections.push("- Prefer the edit_file tool over write_file for modifying existing files.");
  sections.push("- Never create files unless absolutely necessary. Prefer editing existing files to creating new ones.");
  sections.push("- Do NOT use the bash tool for operations that have dedicated tools:");
  sections.push("  - File search: use glob (NOT find or ls)");
  sections.push("  - Content search: use grep (NOT grep or rg in bash)");
  sections.push("  - Read files: use read_file (NOT cat, head, tail, or sed)");
  sections.push("  - Edit files: use edit_file (NOT sed or awk)");
  sections.push("  - Write files: use write_file (NOT echo with redirection or cat with heredoc)");
  sections.push("- Be concise in your responses. Lead with the answer or action, not the reasoning.");
  if (options.headless) {
    sections.push("- This is a background/headless run. Interactive clarification is unavailable. If a task is unclear, skip it or proceed conservatively.");
  } else {
    sections.push("- If a task is unclear, ask the user for clarification using ask_user.");
  }
  sections.push("- When multiple independent tool calls are needed, execute them in parallel when possible.");

  // --- § Memory Recall ---
  sections.push("");
  sections.push("# Memory Recall");
  sections.push(
    `Workspace: ${workspacePath}. ` +
    "Read workspace files via memory_get (path relative to workspace, e.g., 'SOUL.md'). " +
    "Search via memory_search. " +
    `When writing/editing workspace files, ALWAYS use full absolute paths (e.g., ${workspacePath}/MEMORY.md). ` +
    "Do NOT write workspace files to the working directory.",
  );
  sections.push(
    "Before answering anything about prior work, decisions, dates, people, preferences, or todos: " +
    "run memory_search on MEMORY.md + memory/*.md; then use memory_get to pull only the needed lines. " +
    "If low confidence after search, say you checked.",
  );
  sections.push(
    "When writing to the memory/ directory, ONLY use the daily log format: memory/YYYY-MM-DD.md (e.g., memory/2026-04-15.md). " +
    "Do NOT create files with descriptive names (e.g., memory/2026-04-01-project-summary.md). " +
    "All memory notes go into the daily log for that date.",
  );

  // --- § Git Safety ---
  if (env.git) {
    sections.push("");
    sections.push("# Git Safety");
    sections.push("- Never use destructive git commands (push --force, reset --hard, checkout ., clean -f) without explicit user approval.");
    sections.push("- Create new commits rather than amending existing ones, unless the user explicitly asks to amend.");
    sections.push("- Never skip hooks (--no-verify) unless the user explicitly asks.");
    sections.push("- Before running destructive operations, consider safer alternatives.");
    sections.push("- Never force push to main/master.");
  }

  // --- § Task Tracking ---
  sections.push("");
  sections.push("# Task Tracking");
  sections.push(
    "When working on multi-step tasks (modifying 2+ files, implementing features, " +
    "refactoring, or non-trivial work), create tasks to track progress:\n" +
    "- Use task_create for each step\n" +
    "- Update status with task_update as you work: pending → in_progress → completed\n" +
    "- Mark completed IMMEDIATELY when done — do not batch\n" +
    "- Work sequentially unless you explain why you're skipping\n" +
    "When in doubt, create tasks. Better to track too much than lose your place.",
  );

  // --- § Skills ---
  // Note: bundled skills load from src/skill-templates/ regardless of workspace_dir,
  // but we only inject skills into the prompt when workspace_dir is set (PA mode active).
  // This is intentional: no workspace = no PA features = no skill discovery.
  if (options.workspace_dir || options.skills_prompt) {
    const skillsSection = options.skills_prompt ?? buildSkillsSection(options.workspace_dir);
    if (skillsSection) {
      sections.push("");
      sections.push(skillsSection);
    }
  }

  // --- § MCP Tools ---
  const mcpSection = buildMcpSection();
  if (mcpSection) {
    sections.push("");
    sections.push(mcpSection);
  }

  // --- § Silent Replies & Heartbeats ---
  sections.push("");
  sections.push("# Silent Replies & Heartbeats");
  sections.push(
    "When you receive a heartbeat poll, read HEARTBEAT.md and follow its instructions strictly. " +
    "If nothing needs attention, reply with exactly HEARTBEAT_OK — this will be suppressed from the user's view. " +
    "Do not infer or repeat old tasks from prior chats. Only act on what HEARTBEAT.md currently says.",
  );

  // --- # Project Context (bootstrap files) ---
  const bootstrapSection = formatBootstrapSection(wsManager, options.main_session);
  if (bootstrapSection) {
    sections.push("");
    sections.push(bootstrapSection);
  }

  // --- # Per-Repo Instructions (HAWKY.md / CLAUDE.md) ---
  if (instructions) {
    sections.push("");
    sections.push("# Per-Repo Instructions");
    sections.push(`Contents of ${instructions.filePath}:`);
    sections.push("");
    sections.push(instructions.content);
  }

  // --- Custom Instructions (from code, not file) ---
  if (options.custom_instructions) {
    sections.push("");
    sections.push("# Additional Instructions");
    sections.push(options.custom_instructions);
  }

  return sections.join("\n");
}

// -----------------------------------------------------------------------------
// Bootstrap file formatting
// -----------------------------------------------------------------------------

/**
 * Load and format workspace bootstrap files for the system prompt.
 * Returns the formatted section, or null if no workspace exists.
 */
export function formatBootstrapSection(
  workspaceDirOrManager?: string | WorkspaceManager,
  mainSession?: boolean,
): string | null {
  const ws = workspaceDirOrManager instanceof WorkspaceManager
    ? workspaceDirOrManager
    : new WorkspaceManager(workspaceDirOrManager);

  // Only load if workspace has been initialized
  if (!ws.exists("SOUL.md") && !ws.exists("AGENTS.md")) {
    return null;
  }

  const files = ws.loadBootstrapFiles({ mainSession: mainSession ?? true });
  if (files.length === 0) return null;

  const lines: string[] = [];
  lines.push("# Project Context");
  lines.push("");
  lines.push(`Workspace location: ${ws.getWorkspacePath()}`);
  lines.push("The following workspace files have been loaded from the workspace directory.");
  lines.push("IMPORTANT: When editing these files, always use their FULL ABSOLUTE PATH (e.g., " +
    `${ws.getWorkspacePath()}/SOUL.md). Do NOT write to the working directory.`);

  // BOOTSTRAP.md — first-run onboarding takes highest priority
  if (files.some((f) => f.filename === "BOOTSTRAP.md")) {
    lines.push(
      "BOOTSTRAP.md is present — this is a first-run session. " +
      "Follow the instructions in BOOTSTRAP.md as your HIGHEST PRIORITY. " +
      "Initiate the onboarding conversation before doing anything else. " +
      "Do not respond as a generic assistant — start the identity discovery flow.",
    );
  }

  // SOUL.md guidance (a proven design pattern)
  if (files.some((f) => f.filename === "SOUL.md")) {
    lines.push(
      "If SOUL.md is present, embody its persona and tone. " +
      "Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
    );
  }
  lines.push("");

  // Truncation warnings
  const truncatedFiles = files.filter((f) => f.truncated);
  if (truncatedFiles.length > 0) {
    lines.push("⚠ Bootstrap truncation warning:");
    for (const f of truncatedFiles) {
      lines.push(`- ${f.filename} was truncated. Use memory_get to read the full file.`);
    }
    lines.push("");
  }

  // Inject each file
  for (const file of files) {
    lines.push(`## ${file.filename}`);
    lines.push("");
    lines.push(file.content);
    lines.push("");
  }

  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Skills prompt builder (with cache + dirty-flag invalidation)
// -----------------------------------------------------------------------------

let cachedSkillsPrompt: string | null | undefined = undefined;
let cachedSkillsWorkspace: string | undefined;

function buildSkillsSection(workspaceDir?: string): string | null {
  // Return cached if clean and same workspace
  if (cachedSkillsPrompt !== undefined && cachedSkillsWorkspace === workspaceDir && !isSkillsDirty()) {
    return cachedSkillsPrompt;
  }

  try {
    const skills = loadAllSkills(workspaceDir);
    cachedSkillsPrompt = skills.length === 0 ? null : buildSkillsPromptSection(skills);
    cachedSkillsWorkspace = workspaceDir;
    clearSkillsDirty();
    return cachedSkillsPrompt;
  } catch {
    cachedSkillsPrompt = null;
    return null;
  }
}

// -----------------------------------------------------------------------------
// MCP tools prompt section
// -----------------------------------------------------------------------------

function buildMcpSection(): string | null {
  const manager = getMcpServerManager();
  const states = manager.getAllStates();
  const connected = states.filter((s) => s.status === "connected" && s.toolNames.length > 0);
  if (connected.length === 0) return null;

  const lines: string[] = ["# MCP Tools", ""];
  lines.push("Connected MCP servers and their tools:");
  for (const server of connected) {
    const toolList = server.toolNames.map((n) => n.replace(`mcp_${server.name.toLowerCase().replace(/[^a-z0-9]/g, "_")}_`, "")).join(", ");
    lines.push(`- **${server.name}**: ${toolList}`);
  }
  lines.push("");
  lines.push("These tools are available with the mcp_ prefix (e.g., mcp_github_create_issue).");
  return lines.join("\n");
}

// -----------------------------------------------------------------------------
// Per-turn reminders
// -----------------------------------------------------------------------------

export interface PerTurnReminderOptions {
  /** Current session tasks (ephemeral, in-memory) */
  tasks?: Array<{ description: string; status: string }>;
  /** Force include date even if not midnight crossing */
  includeDate?: boolean;
}

/**
 * Build per-turn reminders for injection into user messages.
 * These are lightweight, dynamic state that changes every turn.
 * Returns empty string if nothing to remind.
 */
export function buildPerTurnReminders(options?: PerTurnReminderOptions): string {
  const parts: string[] = [];

  // Current date/time (local time, not UTC — prevents date mismatch after 5pm Pacific)
  if (options?.includeDate) {
    const now = new Date();
    const dateStr = formatLocalDate(now);
    const dayName = now.toLocaleDateString("en-US", { weekday: "long" });
    parts.push(`Current date: ${dateStr} (${dayName})`);
  }

  // Incomplete session tasks
  const tasks = options?.tasks;
  if (tasks && tasks.length > 0) {
    const incomplete = tasks.filter((t) => t.status !== "completed");
    if (incomplete.length > 0) {
      parts.push("Active session tasks:");
      for (const task of incomplete) {
        const marker = task.status === "in_progress" ? "→" : "○";
        parts.push(`  ${marker} ${task.description} (${task.status})`);
      }
    }
  }

  if (parts.length === 0) return "";

  return `<system-reminder>\n${parts.join("\n")}\n</system-reminder>`;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Format a Date as YYYY-MM-DD using local time (not UTC). */
function formatLocalDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// -----------------------------------------------------------------------------
// Message formatting for the API
// -----------------------------------------------------------------------------

/**
 * Convert our ChatMessage[] to the format expected by LLMProvider.
 *
 * ContentBlock[] is compatible with the Anthropic API format, so this is
 * mostly a passthrough. We strip internal-only fields.
 */
export function formatMessagesForApi(messages: ChatMessage[]): LLMMessage[] {
  // Normalize first (fix structural issues), then strip internal fields
  const normalized = normalizeMessages(messages);
  return normalized.map((msg) => ({
    role: msg.role,
    content: msg.content
      .map(stripInternalFields)
      .filter((b): b is ContentBlock => b !== null),
  }));
}

function stripInternalFields(block: ContentBlock): ContentBlock | null {
  if (block.type === "text") {
    const { display_text, internal_only, ...rest } = block;
    return rest;
  }
  if (block.type === "tool_result") {
    const { display_content, ...rest } = block;
    return rest;
  }
  // Strip thinking blocks without signatures — API requires them
  if (block.type === "thinking" && !(block as any).signature) {
    return null;
  }
  return block;
}

// -----------------------------------------------------------------------------
// Context window management (MVP: simple truncation)
// -----------------------------------------------------------------------------

/**
 * Drop oldest messages to keep history within a budget.
 * Always keeps the last `keepTurns` pairs.
 *
 * A "turn" = one user message + one assistant message.
 */
export function truncateHistory(
  messages: ChatMessage[],
  keepTurns: number,
): ChatMessage[] {
  // Each turn is ~2 messages (user + assistant), but tool result messages
  // are also "user" role. So we count by pairs roughly.
  const keepCount = keepTurns * 2;

  if (messages.length <= keepCount) {
    return messages;
  }

  // Keep the last keepCount messages
  return messages.slice(-keepCount);
}
