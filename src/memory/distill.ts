// =============================================================================
// Memory distillation (#653)
//
// Models the user's memory system as four tiers, mapped onto existing workspace
// files:
//
//   soul     -> SOUL.md                  (stable personality / values)
//   identity -> IDENTITY.md              (who the agent is)
//   global   -> MEMORY.md                (curated long-term distilled facts)
//   daily    -> memory/YYYY-MM-DD.md     (per-day summaries / "daily log")
//
// Pipeline:
//   realtime conversation
//     -> session log (gateway-persisted realtime:*.jsonl)   [already exists]
//     -> daily summary (memory/YYYY-MM-DD.md)               [scope: "daily"]
//     -> consolidation into MEMORY.md (global)              [scope: "global"]
//
// Consolidation == distillation == ONE LLM call to Haiku via the existing
// provider factory. This is intentionally NOT super fault-tolerant — robustness
// (retries, partial-failure recovery) is a follow-up.
//
// A `mock` mode skips the LLM entirely and writes deterministic placeholder
// content, so the iOS testing tab and CI can exercise the file-writing path
// offline.
// =============================================================================

import { statSync } from "node:fs";
import { join } from "node:path";
import type { HawkyConfig } from "../agent/types.js";
import type { LLMProvider } from "../agent/provider.js";
import { createProvider } from "../agent/provider-factory.js";
import { AnthropicProvider } from "../agent/anthropic_provider.js";
import { LLMError } from "../agent/provider.js";
import { WorkspaceManager } from "../storage/workspace.js";
import { listSessions } from "../storage/session.js";
import { extractSessionText } from "./session-extract.js";
import { getPrompt } from "../prompts/index.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("memory/distill");

export const DISTILL_SCOPES = ["daily", "global"] as const;
export type DistillScope = (typeof DISTILL_SCOPES)[number];

/**
 * Default distillation model. Haiku, per the design ("1 LLM call to Haiku").
 * Overridable via config.memory.distill_model.
 */
export const DEFAULT_DISTILL_MODEL = "claude-haiku-4-5";

/** Resolve the distillation model from config (default Haiku). Exported for tests. */
export function resolveDistillModel(config: HawkyConfig): string {
  const configured = config.memory?.distill_model?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_DISTILL_MODEL;
}

/**
 * Build the provider for the distillation model. Distillation targets Haiku by
 * default, which is an Anthropic model — so when the model is a Claude model we
 * build an Anthropic provider directly from the Anthropic key, independent of
 * the user's default chat provider (which may be OpenAI/Vertex). For non-Claude
 * distill models we fall back to the configured provider via createProvider.
 */
function buildDistillProvider(config: HawkyConfig, model: string): LLMProvider {
  const isClaude = /claude/i.test(model);
  if (isClaude) {
    const apiKey = config.api_keys?.anthropic;
    if (apiKey && apiKey.trim().length > 0) {
      return new AnthropicProvider(apiKey, { baseURL: config.api_base_url });
    }
    // No Anthropic key but a Claude distill model — if the default provider is
    // Anthropic, createProvider will surface a clear auth error; otherwise it
    // would build the wrong provider, so fail loudly here.
    if ((config.provider ?? "anthropic") !== "anthropic") {
      throw new LLMError(
        "auth_error",
        `Memory distillation uses "${model}" (Anthropic) but no Anthropic API key is set. ` +
          `Set api_keys.anthropic, or set config.memory.distill_model to a model your "${config.provider}" provider serves.`,
      );
    }
  }
  return createProvider(config);
}

/** Cap the transcript so a long session can't blow the context window. */
const MAX_TRANSCRIPT_CHARS = 24_000;
/** Cap how much existing global memory we feed back in for consolidation. */
const MAX_GLOBAL_CHARS = 16_000;
const MAX_DAILY_OUTPUT_TOKENS = 1024;
const MAX_GLOBAL_OUTPUT_TOKENS = 2048;

export interface DistillRequest {
  /** Backend session key, e.g. "realtime:abc". Defaults to most recent realtime session. */
  session_key?: string;
  scope: DistillScope;
  /** Skip the LLM and write deterministic placeholder content (offline/CI). */
  mock?: boolean;
}

export interface DistillResult {
  ok: boolean;
  scope: DistillScope;
  /** Workspace-relative path that was written (e.g. "memory/2026-06-16.md" or "MEMORY.md"). */
  file: string;
  /** Short preview of what was written (first ~600 chars). */
  preview: string;
  /** True when the LLM was skipped. */
  mocked: boolean;
  /** Human-readable note (e.g. "no transcript found"). */
  note?: string;
}

// -----------------------------------------------------------------------------
// Transcript assembly
// -----------------------------------------------------------------------------

/**
 * Assemble a transcript for memory distillation. When a session key is provided,
 * target that persisted session exactly; otherwise fall back to the newest
 * realtime session for legacy/manual callers.
 */
async function assembleTranscript(sessionKey?: string): Promise<{ text: string; sourceId: string | null }> {
  const sessions = listSessions(500);
  let chosen = sessions;
  if (sessionKey && sessionKey.trim()) {
    const key = sessionKey.trim();
    chosen = sessions.filter((s) => s.id === key || sessionIdAliases(s.id).includes(key));
    if (chosen.length === 0) return { text: "", sourceId: null };
  } else {
    chosen = sessions.filter((s) => s.id.startsWith("realtime:") || s.id.startsWith("realtime/"));
    if (chosen.length === 0) return { text: "", sourceId: null };
    chosen.sort((a, b) => b.lastModified - a.lastModified);
    chosen = [chosen[0]];
  }

  const session = chosen[0];
  try {
    const res = await extractSessionText(session.filePath);
    const text = res.text.trim().slice(0, MAX_TRANSCRIPT_CHARS);
    return { text, sourceId: session.id };
  } catch (err) {
    log.debug("extractSessionText failed", {
      id: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { text: "", sourceId: session.id };
  }
}

// -----------------------------------------------------------------------------
// LLM call (one streaming Haiku call, collected to text)
// -----------------------------------------------------------------------------

async function distillWithLLM(
  provider: LLMProvider,
  model: string,
  systemPrompt: string,
  userContent: string,
  maxTokens: number,
): Promise<string> {
  const abort = new AbortController();
  let out = "";
  for await (const event of provider.stream(
    {
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: userContent }],
      system: systemPrompt,
    } as any,
    abort.signal,
  )) {
    if (event.type === "text_delta") out += event.text;
  }
  return out.trim();
}

// -----------------------------------------------------------------------------
// Daily distillation: session transcript -> memory/YYYY-MM-DD.md
// -----------------------------------------------------------------------------

/** Lazily-built provider + the model to call. Built once per distillMemory(). */
interface DistillEngine {
  getProvider: () => LLMProvider;
  model: string;
}

async function distillDaily(
  engine: DistillEngine,
  workspace: WorkspaceManager,
  req: DistillRequest,
  now: Date,
): Promise<DistillResult> {
  const dateStr = formatDate(now);
  const file = `memory/${dateStr}.md`;
  const { text, sourceId } = await assembleTranscript(req.session_key);

  if (!text) {
    return {
      ok: false,
      scope: "daily",
      file,
      preview: "",
      mocked: Boolean(req.mock),
      note: "No readable realtime transcript found on the gateway to distill.",
    };
  }

  let summary: string;
  if (req.mock) {
    summary =
      `(mock) Distilled ${text.length} chars from ${sourceId ?? "unknown session"}. ` +
      `First line: ${text.split("\n")[0]?.slice(0, 120) ?? ""}`;
  } else {
    summary = await distillWithLLM(
      engine.getProvider(),
      engine.model,
      getPrompt("memory.distill.daily.system"),
      `Summarize this realtime session into a daily-log entry.\n\n` +
        `----- TRANSCRIPT -----\n${text}`,
      MAX_DAILY_OUTPUT_TOKENS,
    );
    if (!summary) {
      return {
        ok: false,
        scope: "daily",
        file,
        preview: "",
        mocked: false,
        note: "Distillation LLM call returned an empty summary.",
      };
    }
  }

  // Append as a timestamped daily-log entry (creates the file with a header).
  workspace.appendToDaily(summary, now);
  const written = workspace.readFile(file) ?? summary;

  log.info("daily distillation complete", { file, source: sourceId, mocked: Boolean(req.mock), chars: summary.length });
  return { ok: true, scope: "daily", file, preview: preview(written), mocked: Boolean(req.mock) };
}

// -----------------------------------------------------------------------------
// Global consolidation: recent daily logs + existing MEMORY.md -> MEMORY.md
// -----------------------------------------------------------------------------

async function distillGlobal(
  engine: DistillEngine,
  workspace: WorkspaceManager,
  req: DistillRequest,
): Promise<DistillResult> {
  const file = "MEMORY.md";
  const existing = (workspace.readFile(file) ?? "").slice(0, MAX_GLOBAL_CHARS);

  // Feed the last few daily logs back in for consolidation.
  const recentLogs = workspace.listDailyLogs().slice(-5);
  const dailyBlocks: string[] = [];
  for (const logName of recentLogs) {
    const content = workspace.readFile(`memory/${logName}`);
    if (content?.trim()) dailyBlocks.push(`### ${logName}\n${content.trim()}`);
  }

  if (dailyBlocks.length === 0) {
    return {
      ok: false,
      scope: "global",
      file,
      preview: preview(existing),
      mocked: Boolean(req.mock),
      note: "No daily logs found to consolidate into global memory.",
    };
  }

  const dailyText = dailyBlocks.join("\n\n");

  let consolidated: string;
  if (req.mock) {
    const stamp = recentLogs[recentLogs.length - 1] ?? "unknown";
    consolidated =
      `${existing.trimEnd()}\n\n- (mock) Consolidated ${dailyBlocks.length} daily log(s); latest ${stamp}.\n`;
  } else {
    consolidated = await distillWithLLM(
      engine.getProvider(),
      engine.model,
      getPrompt("memory.distill.global.system"),
      `Here is the current long-term memory (MEMORY.md):\n\n${existing || "(empty)"}\n\n` +
        `Here are recent daily logs to consolidate into it:\n\n${dailyText}\n\n` +
        `Return the FULL updated MEMORY.md.`,
      MAX_GLOBAL_OUTPUT_TOKENS,
    );
    if (!consolidated) {
      return {
        ok: false,
        scope: "global",
        file,
        preview: preview(existing),
        mocked: false,
        note: "Consolidation LLM call returned empty output; MEMORY.md left unchanged.",
      };
    }
  }

  workspace.writeFile(file, consolidated.trimEnd() + "\n");
  log.info("global consolidation complete", {
    file,
    dailyLogs: dailyBlocks.length,
    mocked: Boolean(req.mock),
    chars: consolidated.length,
  });
  return { ok: true, scope: "global", file, preview: preview(consolidated), mocked: Boolean(req.mock) };
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export async function distillMemory(
  config: HawkyConfig,
  req: DistillRequest,
  options?: { workspace?: WorkspaceManager; now?: Date; provider?: LLMProvider },
): Promise<DistillResult> {
  const workspace = options?.workspace ?? new WorkspaceManager();
  const now = options?.now ?? new Date();
  workspace.init();

  // Lazy provider: in mock mode the provider is never built, so distillation
  // works offline / without an API key. Tests can inject a stub provider.
  // Distillation targets Haiku (Anthropic) by default, independent of the user's
  // default chat provider — see buildDistillProvider.
  const model = resolveDistillModel(config);
  let cachedProvider: LLMProvider | undefined = options?.provider;
  const engine: DistillEngine = {
    model,
    getProvider: () => {
      if (!cachedProvider) cachedProvider = buildDistillProvider(config, model);
      return cachedProvider;
    },
  };

  if (req.scope === "global") {
    return distillGlobal(engine, workspace, req);
  }
  return distillDaily(engine, workspace, req, now);
}

// -----------------------------------------------------------------------------
// Bulk sweep: distill ALL substantive realtime sessions, then consolidate
// -----------------------------------------------------------------------------

export interface SweepOptions {
  workspace?: WorkspaceManager;
  now?: Date;
  provider?: LLMProvider;
  /** Skip sessions with fewer than this many messages (stubs). Default 4. */
  minMessages?: number;
  /** Skip sessions whose transcript is shorter than this. Default 200 chars. */
  minTranscriptChars?: number;
  /** Hard cap on how many sessions to distill (cost guard). Default 40. */
  maxSessions?: number;
  /** Run global consolidation after distilling. Default true. */
  consolidate?: boolean;
  /** mock mode (no LLM). Default false. */
  mock?: boolean;
}

export interface SweepResult {
  scanned: number;
  skippedStubs: number;
  distilled: number;
  failed: number;
  consolidated: boolean;
  perSession: Array<{ sessionId: string; ok: boolean; note?: string }>;
}

/**
 * Distill every SUBSTANTIVE realtime session into the daily logs, then (by
 * default) consolidate into MEMORY.md. "Substantive" = enough messages and
 * transcript length to be worth a Haiku call; short bootstrap stubs are skipped.
 *
 * This is the manual "catch up my memory from history" sweep — the opposite of
 * the one-session-at-a-time RPC. Cost-guarded by maxSessions.
 */
export async function distillAllSessions(
  config: HawkyConfig,
  options?: SweepOptions,
): Promise<SweepResult> {
  const workspace = options?.workspace ?? new WorkspaceManager();
  const now = options?.now ?? new Date();
  workspace.init();

  const minMessages = options?.minMessages ?? 4;
  const minTranscriptChars = options?.minTranscriptChars ?? 200;
  const maxSessions = options?.maxSessions ?? 40;
  const consolidate = options?.consolidate ?? true;
  const mock = options?.mock ?? false;

  // Newest first; only realtime sessions.
  const realtime = listSessions(500)
    .filter((s) => s.id.startsWith("realtime:") || s.id.startsWith("realtime/"))
    .sort((a, b) => b.lastModified - a.lastModified);

  const result: SweepResult = {
    scanned: realtime.length,
    skippedStubs: 0,
    distilled: 0,
    failed: 0,
    consolidated: false,
    perSession: [],
  };

  let processed = 0;
  for (const session of realtime) {
    if (processed >= maxSessions) break;

    // Cheap stub filter by message count first, then verify transcript length.
    if (session.messageCount < minMessages) {
      result.skippedStubs++;
      continue;
    }

    const { text } = await assembleTranscript(session.id);
    if (text.length < minTranscriptChars) {
      result.skippedStubs++;
      continue;
    }

    processed++;
    const r = await distillMemory(
      config,
      { scope: "daily", session_key: session.id, mock },
      { workspace, now, provider: options?.provider },
    );
    if (r.ok) result.distilled++;
    else result.failed++;
    result.perSession.push({ sessionId: session.id, ok: r.ok, note: r.note });
  }

  if (consolidate && result.distilled > 0) {
    const g = await distillMemory(
      config,
      { scope: "global", mock },
      { workspace, now, provider: options?.provider },
    );
    result.consolidated = g.ok;
  }

  log.info("session sweep complete", {
    scanned: result.scanned,
    distilled: result.distilled,
    skippedStubs: result.skippedStubs,
    failed: result.failed,
    consolidated: result.consolidated,
  });
  return result;
}

// -----------------------------------------------------------------------------
// Snapshot: the four tiers for the testing tab
// -----------------------------------------------------------------------------

export interface MemorySnapshot {
  soul: string;
  identity: string;
  global: string;
  daily: Array<{ date: string; content: string }>;
}

/** Read the current four-tier memory state for the current workspace. */
export function readMemorySnapshot(options?: { workspace?: WorkspaceManager; dailyLimit?: number }): MemorySnapshot {
  const workspace = options?.workspace ?? new WorkspaceManager();
  const dailyLimit = options?.dailyLimit ?? 5;

  const daily: Array<{ date: string; content: string }> = [];
  for (const logName of workspace.listDailyLogs().slice(-dailyLimit).reverse()) {
    const content = workspace.readFile(`memory/${logName}`);
    daily.push({ date: logName.replace(/\.md$/, ""), content: content?.trim() ?? "" });
  }

  return {
    soul: (workspace.readFile("SOUL.md") ?? "").trim(),
    identity: (workspace.readFile("IDENTITY.md") ?? "").trim(),
    global: (workspace.readFile("MEMORY.md") ?? "").trim(),
    daily,
  };
}

// -----------------------------------------------------------------------------
// Change detection: latest mtime across daily logs (memory/*.md)
// -----------------------------------------------------------------------------

/**
 * Newest modification time (ms) across the daily logs (memory/YYYY-MM-DD.md).
 * Returns 0 when there are no daily logs. Used by the 6h consolidation
 * scheduler to skip work when nothing changed since the last run.
 */
export function latestDailyMtimeMs(options?: { workspace?: WorkspaceManager }): number {
  const workspace = options?.workspace ?? new WorkspaceManager();
  const memoryDir = workspace.getMemoryDir();
  let latest = 0;
  for (const logName of workspace.listDailyLogs()) {
    try {
      const stat = statSync(join(memoryDir, logName));
      if (stat.mtimeMs > latest) latest = stat.mtimeMs;
    } catch {
      // File vanished between listing and stat — ignore.
    }
  }
  return latest;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function preview(text: string, max = 600): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max) + "…";
}

function formatDate(d: Date): string {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function sessionIdAliases(id: string): string[] {
  const aliases = new Set<string>();
  aliases.add(id.replaceAll("/", ":"));
  aliases.add(id.replaceAll(":", "/"));
  return [...aliases];
}
