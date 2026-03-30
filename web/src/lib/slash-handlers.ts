// =============================================================================
// Slash command handlers
//
// One function per `/command`. Each is invoked with the user-supplied args
// string and a SlashContext (rpc, addSystemMessage, setView, etc.).
//
// Handlers should:
//   - keep output concise — the chat thread is not a debug console
//   - never throw — return error text via ctx.addSystemMessage
//   - use existing gateway RPCs where possible (cron.list, gateway.status,
//     gateway.usageHistory, config.get) and fall back to new RPCs added in
//     src/gateway/agent-methods.ts only when nothing fits
// =============================================================================

import type { SlashContext } from "./slash-commands.js";
import { SLASH_COMMANDS } from "./slash-commands.js";

// ---------------------------------------------------------------------------
// /help
// ---------------------------------------------------------------------------

export function runHelp(_args: string, ctx: SlashContext): void {
  const lines = ["Available slash commands:", ""];
  for (const c of SLASH_COMMANDS) {
    const usage = `/${c.name}${c.args ? " " + c.args : ""}`;
    lines.push(`  ${usage.padEnd(28)} ${c.description}`);
  }
  lines.push("");
  lines.push("Tip: tab to autocomplete, esc to dismiss the menu.");
  ctx.addSystemMessage(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// /setup — delegate to the agent (it knows the SETUP.md flow)
// ---------------------------------------------------------------------------

export function runSetup(_args: string, ctx: SlashContext): void {
  ctx.sendChatMessage("Run the /setup wizard from SETUP.md — guide me through any unconfigured sections (API keys, skills, heartbeat, memory warm-up).");
}

// ---------------------------------------------------------------------------
// /doctor — gateway-side health check
// ---------------------------------------------------------------------------

interface DoctorReport {
  sections: Array<{ title: string; lines: string[] }>;
}

export async function runDoctor(_args: string, ctx: SlashContext): Promise<void> {
  const r = await ctx.rpc<DoctorReport>("doctor.run");
  const out: string[] = ["Doctor:"];
  for (const s of r.sections) {
    out.push("", s.title);
    for (const line of s.lines) out.push(`  ${line}`);
  }
  ctx.addSystemMessage(out.join("\n"));
}

// ---------------------------------------------------------------------------
// /skills — show installed skills + readiness
// ---------------------------------------------------------------------------

interface SkillStatus {
  name: string;
  ready: boolean;
  eligible: boolean;
  missing: string[];
}

interface SkillsReport {
  total: number;
  eligible: number;
  missing: number;
  skills: SkillStatus[];
}

export async function runSkills(_args: string, ctx: SlashContext): Promise<void> {
  const r = await ctx.rpc<SkillsReport>("skills.status");
  const lines = [`Skills (${r.eligible}/${r.total} ready):`];
  for (const s of r.skills) {
    const icon = s.ready ? "✓" : s.eligible ? "⚠" : "✗";
    const missing = s.missing && s.missing.length > 0 ? ` (missing: ${s.missing.join(", ")})` : "";
    const note = !s.ready && s.eligible ? " (auth needed)" : "";
    lines.push(`  ${icon} ${s.name}${missing}${note}`);
  }
  if (r.skills.length === 0) lines.push("  (no skills configured)");
  ctx.addSystemMessage(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// /cost — today's spend summary
// ---------------------------------------------------------------------------

interface UsageEntry {
  date: string;
  costUSD: number;
  tokens: { input: number; output: number; cacheCreation: number; cacheRead: number };
  apiCalls: number;
}

interface UsageHistoryResponse {
  range: "7d" | "30d" | "all";
  entries: UsageEntry[];
  summary: {
    totalCostUSD: number;
    totalTokens: number;
    totalApiCalls: number;
    activeDays: number;
    dailyAvgCost: number;
  };
}

export async function runCost(_args: string, ctx: SlashContext): Promise<void> {
  const r = await ctx.rpc<UsageHistoryResponse>("gateway.usageHistory", { range: "7d" });
  if (!r?.entries || r.entries.length === 0) {
    ctx.addSystemMessage("No usage data yet.");
    return;
  }
  // Today is the last entry (entries are sorted ascending by date).
  const today = r.entries[r.entries.length - 1];
  const fmt = (n: number) => `$${n.toFixed(4)}`;
  const k = (n: number) => n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
  ctx.addSystemMessage([
    `Cost summary:`,
    `  Today: ${fmt(today.costUSD ?? 0)}  (${k(today.tokens?.input ?? 0)}↓ ${k(today.tokens?.output ?? 0)}↑, ${today.apiCalls ?? 0} calls)`,
    `  Last 7 days: ${fmt(r.summary.totalCostUSD ?? 0)} across ${r.summary.activeDays ?? 0} active days`,
    `  Daily avg: ${fmt(r.summary.dailyAvgCost ?? 0)}`,
  ].join("\n"));
}

// ---------------------------------------------------------------------------
// /compact — trigger context compaction
// ---------------------------------------------------------------------------

export async function runCompact(_args: string, ctx: SlashContext): Promise<void> {
  const r = await ctx.rpc<{ compacted: boolean; reason?: string }>(
    "session.compact",
    { sessionKey: ctx.sessionKey },
  );
  if (r.compacted) {
    ctx.addSystemMessage("Compaction complete — older context summarized.");
  } else {
    ctx.addSystemMessage(`Compaction skipped: ${r.reason ?? "no reason given"}`);
  }
}

// ---------------------------------------------------------------------------
// /heartbeat — show status, optionally trigger a run
// ---------------------------------------------------------------------------

interface HeartbeatStatus {
  enabled: boolean;
  // Times come back as epoch ms numbers from gateway/heartbeat.ts.
  lastStatus?: string | null;
  lastRunAt?: number | null;
  nextRunAt?: number | null;
  running?: boolean;
}

interface HawkyConfig {
  heartbeat?: { interval_minutes?: number; enabled?: boolean };
}

export async function runHeartbeat(args: string, ctx: SlashContext): Promise<void> {
  if (args.trim() === "run" || args.trim() === "trigger") {
    await ctx.rpc("heartbeat.trigger");
    ctx.addSystemMessage("Heartbeat run triggered.");
    return;
  }
  // The interval lives in config, not the live status — fetch both in parallel.
  const [s, cfg] = await Promise.all([
    ctx.rpc<HeartbeatStatus>("heartbeat.status"),
    ctx.rpc<HawkyConfig>("config.get"),
  ]);
  if (!s.enabled) {
    ctx.addSystemMessage("Heartbeat is disabled. Enable it via /setup.");
    return;
  }
  const interval = cfg.heartbeat?.interval_minutes;
  const header = interval ? `Heartbeat: enabled (every ${interval} min)` : `Heartbeat: enabled`;
  const lines = [header];
  if (s.lastRunAt) lines.push(`  Last run: ${formatEpoch(s.lastRunAt)} — ${s.lastStatus ?? "?"}`);
  if (s.nextRunAt) lines.push(`  Next run: ${formatEpoch(s.nextRunAt)}`);
  if (s.running) lines.push(`  Currently running.`);
  lines.push("", "Tip: /heartbeat run to trigger a manual run.");
  ctx.addSystemMessage(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// /cron — list jobs
// ---------------------------------------------------------------------------

interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: { kind: string };
  state: { lastStatus?: string | null; lastRunAtMs?: number | null; nextRunAtMs?: number | null };
}

interface CronListResponse {
  jobs: CronJob[];
}

export async function runCron(_args: string, ctx: SlashContext): Promise<void> {
  // gateway returns { jobs: [...] } — not a flat array.
  const r = await ctx.rpc<CronListResponse>("cron.list");
  const jobs = r?.jobs ?? [];
  if (jobs.length === 0) {
    ctx.addSystemMessage("No cron jobs scheduled.");
    return;
  }
  const lines = [`Cron jobs (${jobs.length}):`];
  for (const j of jobs) {
    const status = j.enabled ? "" : " (disabled)";
    const last = j.state.lastRunAtMs ? formatEpoch(j.state.lastRunAtMs) : "never";
    const next = j.state.nextRunAtMs ? formatEpoch(j.state.nextRunAtMs) : "—";
    lines.push(`  • ${j.name}${status}`);
    lines.push(`      last: ${last} (${j.state.lastStatus ?? "?"}), next: ${next}`);
  }
  ctx.addSystemMessage(lines.join("\n"));
}

// ---------------------------------------------------------------------------
// /mode — get or set permission mode
// ---------------------------------------------------------------------------

const VALID_MODES = ["default", "acceptedits", "accept-edits", "bypass"];

export async function runMode(args: string, ctx: SlashContext): Promise<void> {
  const arg = args.trim().toLowerCase();
  if (!arg) {
    const cur = await ctx.rpc<{ mode: string }>("permission.mode", { sessionKey: ctx.sessionKey });
    ctx.addSystemMessage(`Current permission mode: ${cur.mode}\n\nUsage: /mode default | acceptEdits | bypass`);
    return;
  }
  if (!VALID_MODES.includes(arg)) {
    ctx.addSystemMessage(`Unknown mode "${arg}". Valid: default, acceptEdits, bypass`);
    return;
  }
  // Normalize: TUI uses "acceptEdits"/"accept-edits" interchangeably; gateway expects "accept-edits".
  const normalized =
    arg === "acceptedits" || arg === "accept-edits" ? "accept-edits" :
    arg === "default" ? "default" : "bypass";
  const r = await ctx.rpc<{ mode: string; message?: string }>("permission.mode", { mode: normalized, sessionKey: ctx.sessionKey });
  ctx.addSystemMessage(r.message ?? `Permission mode set to: ${r.mode}`);
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function formatEpoch(ms: number): string {
  try {
    const d = new Date(ms);
    if (Number.isNaN(d.getTime())) return String(ms);
    return d.toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return String(ms);
  }
}
