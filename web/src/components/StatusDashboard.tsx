// =============================================================================
// Status Dashboard
//
// Gateway health dashboard with 5-second polling while open.
// Design: borderless sections with dividers (Linear/Vercel pattern),
// sans-serif labels, monospace numbers, 8px status dots.
// =============================================================================

import { useState, useEffect, useRef } from "react";
import { useSocketStore } from "../store/socket-store";

const POLL_INTERVAL_MS = 5000;

interface GatewayStatus {
  timestamp: number;
  uptimeSeconds: number;
  connections: {
    count: number;
    clients: Array<{ connId: string; platform: string; sessionKey: string | null }>;
  };
  nodes: Array<{
    nodeId: string;
    name: string;
    platform: string;
    commands: string[];
    connectedAt: number;
  }>;
  sessions: { count: number; keys: string[] };
  heartbeat: {
    enabled: boolean;
    lastRunAt: number | null;
    lastStatus: string | null;
    lastDurationMs: number | null;
    nextRunAt: number | null;
    running: boolean;
    lastConsolidatedAt: number | null;
  };
  cron: {
    enabled: boolean;
    jobCount: number;
    enabledJobCount: number;
    jobs: Array<{
      id: string;
      name: string;
      enabled: boolean;
      nextRunAt: number | null;
      lastRunAt: number | null;
      lastStatus: string | null;
      lastDurationMs: number | null;
    }>;
  };
  usage: {
    date: string;
    tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
    costUSD: number;
    byModel: Record<string, { input: number; output: number; costUSD: number }>;
    apiCalls: number;
  };
  recentErrors?: Array<{
    timestamp: number;
    subsystem: string;
    level: string;
    message: string;
    details?: string;
  }>;
}

// -----------------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------------

function fmtUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function fmtTime(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * Format a future timestamp with enough date context to be unambiguous.
 *  - Same calendar day → just the time: "07:00 PM"
 *  - Next calendar day → "Tomorrow 07:00 PM"
 *  - Within the next week → weekday + time: "Mon 07:00 PM"
 *  - Otherwise → short month/day + time: "Apr 28 07:00 PM"
 *
 * Always pairs a date qualifier with the time when it is not today, so the
 * cron list never reads as a bare clock time the user has to interpret.
 */
function fmtNextRun(ms: number | null): string {
  if (!ms) return "—";
  const target = new Date(ms);
  const now = new Date();
  const time = target.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const dayDelta = Math.round((startOfDay(target) - startOfDay(now)) / 86_400_000);

  if (dayDelta <= 0) return time;
  if (dayDelta === 1) return `Tomorrow ${time}`;
  if (dayDelta < 7) {
    const weekday = target.toLocaleDateString([], { weekday: "short" });
    return `${weekday} ${time}`;
  }
  const monthDay = target.toLocaleDateString([], { month: "short", day: "numeric" });
  return `${monthDay} ${time}`;
}

function fmtDuration(ms: number | null): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCost(usd: number): string {
  if (usd < 0.005) return "$0.00";
  return `$${usd.toFixed(2)}`;
}

function dotColor(status: string | null): string {
  if (status === "ran" || status === "ok") return "bg-emerald-500";
  if (status === "error" || status === "failed") return "bg-red-500";
  return "bg-stone-400 dark:bg-stone-500";
}

// -----------------------------------------------------------------------------
// Dashboard
// -----------------------------------------------------------------------------

export function StatusDashboard() {
  const [status, setStatus] = useState<GatewayStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const rpc = useSocketStore((s) => s.rpc);
  const connStatus = useSocketStore((s) => s.status);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clear status when disconnected
  useEffect(() => {
    if (connStatus !== "connected") {
      setStatus(null);
      setLoading(false);
      if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
    }
  }, [connStatus]);

  // Fetch + poll when connected
  useEffect(() => {
    if (connStatus !== "connected") return;
    let active = true;
    setLoading(true);

    const fetchStatus = async () => {
      try {
        const r = (await rpc("gateway.status")) as GatewayStatus;
        if (active) { setStatus(r); setLoading(false); }
      } catch {
        if (active) { setStatus(null); setLoading(false); }
      }
    };

    void fetchStatus();
    pollRef.current = setInterval(fetchStatus, POLL_INTERVAL_MS);
    return () => { active = false; if (pollRef.current) clearInterval(pollRef.current); };
  }, [connStatus, rpc]);

  return (
    <div className="flex flex-col h-full">
      {/* Content */}
      <div className="flex-1 overflow-y-auto" data-testid="status-dashboard">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-muted dark:text-muted-dark">Loading...</div>
        ) : !status ? (
          <div className="flex items-center justify-center h-32 text-muted dark:text-muted-dark">Unable to load status</div>
        ) : (
          <div className="max-w-xl mx-auto px-6 pt-6 pb-12">

            {/* Top metrics row */}
            <div className={`grid ${status.nodes?.length ? "grid-cols-4" : "grid-cols-3"} gap-6 pb-6`}>
              <Metric label="Uptime" value={fmtUptime(status.uptimeSeconds)} />
              <Metric label="Connections" value={String(status.connections.count)} />
              <Metric label="Sessions" value={String(status.sessions.count)} />
              {status.nodes?.length > 0 && (
                <Metric label="Nodes" value={String(status.nodes.length)} />
              )}
            </div>

            {/* Connections detail */}
            {status.connections.clients.length > 0 && (
              <Section>
                <SectionHeader>Connected Clients</SectionHeader>
                {status.connections.clients.map((c) => (
                  <KV key={c.connId} label={c.platform} value={c.sessionKey ?? "unbound"} />
                ))}
              </Section>
            )}

            {/* Connected Nodes */}
            {status.nodes && status.nodes.length > 0 && (
              <Section>
                <SectionHeader>Connected Nodes</SectionHeader>
                <div className="space-y-3">
                  {status.nodes.map((node) => (
                    <div key={node.nodeId} className="flex items-start gap-2.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0 mt-1.5" />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-sans text-stone-700 dark:text-stone-300">
                          {node.name}
                          <span className="ml-1.5 text-xs text-muted dark:text-muted-dark">({node.platform})</span>
                        </div>
                        <div className="text-[12px] text-muted dark:text-muted-dark font-sans">
                          {node.commands.join(", ")} · up {fmtUptime(Math.round((Date.now() - node.connectedAt) / 1000))}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* Heartbeat */}
            <Section>
              <SectionHeader>Heartbeat</SectionHeader>
              {!status.heartbeat.enabled ? (
                <p className="text-sm text-muted dark:text-muted-dark">Disabled</p>
              ) : (
                <>
                  <div className="flex items-center gap-2 py-2">
                    <span className={`w-2 h-2 rounded-full shrink-0 ${dotColor(status.heartbeat.lastStatus)}`} />
                    <span className="text-sm font-sans text-stone-700 dark:text-stone-300">
                      {status.heartbeat.running ? "Running now..." : status.heartbeat.lastStatus === "ran" ? "Healthy" : status.heartbeat.lastStatus ?? "No runs yet"}
                    </span>
                  </div>
                  <KV label="Last run" value={`${fmtTime(status.heartbeat.lastRunAt)} (${fmtDuration(status.heartbeat.lastDurationMs)})`} />
                  <KV label="Next" value={fmtNextRun(status.heartbeat.nextRunAt)} />
                  {status.heartbeat.lastConsolidatedAt && (
                    <KV label="Last consolidation" value={fmtTime(status.heartbeat.lastConsolidatedAt)} />
                  )}
                </>
              )}
            </Section>

            {/* Cron */}
            <Section>
              <SectionHeader>Cron Jobs</SectionHeader>
              {status.cron.jobs.length === 0 ? (
                <p className="text-sm text-muted dark:text-muted-dark">No jobs configured</p>
              ) : (
                <div className="space-y-3">
                  {status.cron.jobs.map((job) => (
                    <div key={job.id} className="flex items-start gap-2.5">
                      <span className={`w-2 h-2 rounded-full shrink-0 mt-1.5 ${job.enabled ? dotColor(job.lastStatus) : "bg-stone-300 dark:bg-stone-600"}`} />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-sans text-stone-700 dark:text-stone-300">
                          {job.name}
                          {!job.enabled && <span className="ml-1.5 text-xs text-muted dark:text-muted-dark">(disabled)</span>}
                        </div>
                        <div className="text-[12px] text-muted dark:text-muted-dark font-sans">
                          {job.lastRunAt ? `${fmtTime(job.lastRunAt)} · ${fmtDuration(job.lastDurationMs)}` : "Never run"}
                          {job.nextRunAt ? ` · Next ${fmtNextRun(job.nextRunAt)}` : ""}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </Section>

            {/* Usage stats */}
            <UsageStatsSection rpc={rpc} />

            {/* Sessions */}
            {status.sessions.keys.length > 0 && (
              <Section>
                <SectionHeader>Active Sessions</SectionHeader>
                {status.sessions.keys.map((key) => (
                  <div key={key} className="text-sm font-sans text-stone-600 dark:text-stone-400 py-1">
                    {key}
                  </div>
                ))}
              </Section>
            )}

            {/* Recent errors */}
            {status.recentErrors && status.recentErrors.length > 0 && (
              <Section last>
                <SectionHeader>Recent Errors ({status.recentErrors.length})</SectionHeader>
                <div className="space-y-2">
                  {status.recentErrors.map((err: any, i: number) => (
                    <div key={i} className="text-sm font-sans">
                      <div className="flex items-baseline gap-2">
                        <span className="w-2 h-2 rounded-full bg-red-500/70 shrink-0 mt-1" />
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-baseline">
                            <span className="text-stone-700 dark:text-stone-300 truncate">{err.message}</span>
                            <span className="text-[11px] text-muted dark:text-muted-dark shrink-0 ml-2">{fmtTime(err.timestamp)}</span>
                          </div>
                          <div className="text-[11px] text-muted dark:text-muted-dark">
                            {err.subsystem}
                            {err.details && <span className="ml-1">— {err.details.slice(0, 100)}</span>}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Usage Stats (7d / 30d / all-time)
// -----------------------------------------------------------------------------

type UsageRange = "7d" | "30d" | "all";

interface UsageHistory {
  range: UsageRange;
  entries: Array<{
    date: string;
    tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
    costUSD: number;
    apiCalls: number;
    byModel: Record<string, { input: number; output: number; costUSD: number }>;
  }>;
  summary: {
    totalCostUSD: number;
    totalTokens: number;
    totalApiCalls: number;
    activeDays: number;
    dailyAvgCost: number;
    peakDay: { date: string; costUSD: number } | null;
    byModel: Record<string, { tokens: number; costUSD: number }>;
  };
}

function UsageStatsSection({ rpc }: { rpc: (method: string, params?: unknown) => Promise<unknown> }) {
  const [range, setRange] = useState<UsageRange>("7d");
  const [history, setHistory] = useState<UsageHistory | null>(null);
  const [error, setError] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fetch on mount + range change, then poll every 15s (less frequent than status)
  useEffect(() => {
    let active = true;
    setError(false);

    const fetchHistory = async () => {
      try {
        const result = (await rpc("gateway.usageHistory", { range })) as UsageHistory;
        if (active) { setHistory(result); setError(false); }
      } catch {
        if (active) setError(true);
      }
    };

    void fetchHistory();
    pollRef.current = setInterval(fetchHistory, 15_000);
    return () => { active = false; if (pollRef.current) clearInterval(pollRef.current); };
  }, [range, rpc]);

  const ranges: UsageRange[] = ["7d", "30d", "all"];
  const rangeLabels: Record<UsageRange, string> = { "7d": "7 days", "30d": "30 days", "all": "All time" };

  return (
    <Section>
      {/* Header with tabs */}
      <div className="flex items-center justify-between mb-3">
        <SectionHeader>Usage</SectionHeader>
        <div className="flex gap-1">
          {ranges.map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={`px-2 py-0.5 text-[11px] font-sans rounded-md transition-colors ${
                range === r
                  ? "bg-stone-200/60 dark:bg-stone-700/40 text-stone-800 dark:text-stone-200 font-medium"
                  : "text-muted dark:text-muted-dark hover:text-stone-600 dark:hover:text-stone-400"
              }`}
            >
              {rangeLabels[r]}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="text-sm text-muted dark:text-muted-dark">Unable to load usage data</p>
      ) : !history ? (
        <p className="text-sm text-muted dark:text-muted-dark">Loading...</p>
      ) : history.entries.length === 0 ? (
        <p className="text-sm text-muted dark:text-muted-dark">No usage data yet</p>
      ) : (
        <>
          {/* Summary metrics */}
          <div className="grid grid-cols-3 gap-4 py-2">
            <Metric label="Total Cost" value={fmtCost(history.summary.totalCostUSD)} small />
            <Metric label="Tokens" value={fmtTokens(history.summary.totalTokens)} small />
            <Metric label="API Calls" value={String(history.summary.totalApiCalls)} small />
          </div>
          <div className="grid grid-cols-3 gap-4 py-1">
            <Metric label="Active Days" value={String(history.summary.activeDays)} small />
            <Metric label="Daily Avg" value={fmtCost(history.summary.dailyAvgCost)} small />
            {history.summary.peakDay && (
              <Metric label="Peak Day" value={fmtCost(history.summary.peakDay.costUSD)} small />
            )}
          </div>

          {/* Daily bars */}
          <div className="pt-4 mt-3 border-t border-stone-200/40 dark:border-stone-700/30">
            <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted dark:text-muted-dark font-sans mb-2">Daily Cost</p>
            <div className="space-y-1.5">
              {history.entries.slice(0, range === "all" ? 30 : undefined).map((entry) => {
                const maxCost = history.summary.peakDay?.costUSD ?? 1;
                const pct = maxCost > 0 ? Math.max(1, (entry.costUSD / maxCost) * 100) : 0;
                return (
                  <div key={entry.date} className="flex items-center gap-2">
                    <span className="text-[11px] font-mono text-muted dark:text-muted-dark w-16 shrink-0">
                      {entry.date.slice(5)} {/* MM-DD */}
                    </span>
                    <div className="flex-1 h-3 rounded-sm bg-stone-100 dark:bg-stone-800 overflow-hidden">
                      <div
                        className="h-full rounded-sm bg-stone-400/60 dark:bg-stone-500/50"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                    <span className="text-[11px] font-mono text-stone-600 dark:text-stone-400 w-12 text-right shrink-0">
                      {fmtCost(entry.costUSD)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Model breakdown */}
          {Object.keys(history.summary.byModel).length > 0 && (
            <div className="pt-3 mt-3 border-t border-stone-200/40 dark:border-stone-700/30">
              <p className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted dark:text-muted-dark font-sans mb-2">By Model</p>
              {Object.entries(history.summary.byModel)
                .sort(([, a], [, b]) => b.costUSD - a.costUSD)
                .map(([model, data]) => (
                  <div key={model} className="flex justify-between items-baseline py-1">
                    <span className="text-[13px] text-muted dark:text-muted-dark font-sans truncate">{model}</span>
                    <span className="text-sm text-stone-800 dark:text-stone-200 font-sans tabular-nums shrink-0 ml-2">
                      {fmtCost(data.costUSD)}
                      <span className="text-[11px] text-muted dark:text-muted-dark ml-1">({fmtTokens(data.tokens)})</span>
                    </span>
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </Section>
  );
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

function Section({ children, last }: { children: React.ReactNode; last?: boolean }) {
  return (
    <div className={`py-5 ${last ? "" : "border-b border-stone-200/50 dark:border-stone-700/30"}`}>
      {children}
    </div>
  );
}

function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted dark:text-muted-dark font-sans mb-3">
      {children}
    </h3>
  );
}

function KV({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between items-baseline py-1">
      <span className="text-[13px] text-muted dark:text-muted-dark font-sans">{label}</span>
      <span className="text-sm text-stone-800 dark:text-stone-200 font-sans tabular-nums">{value}</span>
    </div>
  );
}

function Metric({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div>
      <div className="text-[11px] font-semibold uppercase tracking-[0.06em] text-muted dark:text-muted-dark font-sans mb-1">{label}</div>
      <div className={`font-mono font-semibold tabular-nums tracking-tight text-stone-800 dark:text-stone-200 ${small ? "text-base" : "text-lg"}`}>
        {value}
      </div>
    </div>
  );
}
