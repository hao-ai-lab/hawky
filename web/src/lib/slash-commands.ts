// =============================================================================
// Web slash commands
//
// Registry of `/command` invocations the user can run from the chat input.
// Mirrors the most useful commands from src/tui/commands.ts but limited to
// what makes sense in a browser context (skips terminal-idiom commands and
// commands already covered by sidebar/header buttons).
//
// Each command has either:
//   - a `run` function that returns a string (rendered as a system message
//     in the active session), OR
//   - a `navigate` action that switches the web view (status / memory / etc),
//     optionally with a string preview to show in the chat too.
//
// Commands run on the gateway via existing RPCs where possible; new RPCs
// are added in src/gateway/agent-methods.ts only when the data isn't
// already exposed.
// =============================================================================

export type SlashView = "chat" | "status" | "memory" | "settings";

export interface SlashContext {
  /** RPC client for gateway calls. */
  rpc: <T = unknown>(method: string, params?: unknown) => Promise<T>;
  /** Currently active session key (e.g. "web:general"). */
  sessionKey: string;
  /** Switch the top-level view (sidebar selection). */
  setView: (view: SlashView) => void;
  /**
   * Append a `system`-role message to the active session's chat thread.
   * The optional second arg attaches a `command` field so ChatView renders
   * the message with body typography + a `/command` chip instead of the
   * small italic notification styling.
   */
  addSystemMessage: (text: string, command?: string) => void;
  /** Send a regular chat message (used by /setup which delegates to agent). */
  sendChatMessage: (text: string) => void;
}

export interface SlashCommand {
  /** Bare name without the leading slash. */
  name: string;
  /** One-line description shown in the autocomplete menu. */
  description: string;
  /** Optional one-word usage hint for the menu (e.g. "<mode>"). */
  args?: string;
  /** Implementation. May be async; should NEVER throw — return error text instead. */
  run: (args: string, ctx: SlashContext) => Promise<void> | void;
}

// -----------------------------------------------------------------------------
// Registry
// -----------------------------------------------------------------------------

import { runHelp, runDoctor, runSkills, runCost, runCompact, runHeartbeat, runCron, runMode, runSetup } from "./slash-handlers.js";

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: "help",      description: "List all available slash commands",                run: runHelp },
  { name: "setup",     description: "Re-run guided setup (API keys, skills, heartbeat)", run: runSetup },
  { name: "doctor",    description: "Run system health checks",                          run: runDoctor },
  { name: "skills",    description: "Show installed skills + readiness",                 run: runSkills },
  { name: "compact",   description: "Compact session context to free tokens",            run: runCompact },
  { name: "cost",      description: "Show today's spend and token totals",               run: runCost },
  { name: "cron",      description: "List cron jobs and recent runs",                    run: runCron },
  { name: "heartbeat", description: "Show heartbeat status (or trigger run)",            args: "[run]", run: runHeartbeat },
  { name: "mode",      description: "Show or set permission mode",                       args: "[default|acceptEdits|bypass]", run: runMode },
];

// -----------------------------------------------------------------------------
// Dispatch
// -----------------------------------------------------------------------------

/**
 * Return true iff `text` looks like a slash command the user is composing.
 * Used by InputBar to decide whether to show the autocomplete menu.
 */
export function isSlashInput(text: string): boolean {
  // A leading slash with no whitespace before any args.
  if (!text.startsWith("/")) return false;
  // After the first word, allow space + args.
  return /^\/[A-Za-z][A-Za-z0-9_-]*( .*)?$/.test(text) || text === "/";
}

/**
 * Parse `/name args...` into name + args. Returns null if not a slash command.
 */
export function parseSlash(text: string): { name: string; args: string } | null {
  if (!isSlashInput(text)) return null;
  const m = /^\/([A-Za-z][A-Za-z0-9_-]*)(?:\s+(.*))?$/.exec(text.trim());
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: (m[2] ?? "").trim() };
}

/**
 * Filter the registry by the user's in-progress query (e.g. "/he" matches
 * "/help" and "/heartbeat"). Empty query returns the full list.
 */
export function filterCommands(query: string): SlashCommand[] {
  const q = query.replace(/^\//, "").toLowerCase().trim();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((c) => c.name.startsWith(q) || c.name.includes(q));
}

/**
 * Look up a command by bare name. Returns null on unknown name.
 */
export function findCommand(name: string): SlashCommand | null {
  const n = name.toLowerCase();
  return SLASH_COMMANDS.find((c) => c.name === n) ?? null;
}

/**
 * Run a parsed slash command. Catches any thrown error and surfaces it as a
 * system message so the chat never crashes from a bad command.
 */
export async function dispatchSlash(
  parsed: { name: string; args: string },
  ctx: SlashContext,
): Promise<void> {
  const cmd = findCommand(parsed.name);
  if (!cmd) {
    ctx.addSystemMessage(`Unknown command: /${parsed.name}. Type /help for the list.`);
    return;
  }
  // Wrap addSystemMessage so each handler's output is automatically tagged
  // with the originating /command — handlers don't have to remember to do this.
  const cmdCtx: SlashContext = {
    ...ctx,
    addSystemMessage: (text, command) => ctx.addSystemMessage(text, command ?? `/${cmd.name}`),
  };
  try {
    await cmd.run(parsed.args, cmdCtx);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    ctx.addSystemMessage(`/${cmd.name} failed: ${msg}`, `/${cmd.name}`);
  }
}

