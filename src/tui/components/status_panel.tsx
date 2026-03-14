// =============================================================================
// Status Panel
//
// Interactive tabbed panel showing Cost, Usage, and Errors.
// Opened via /status command. Left/Right arrows switch tabs.
// Escape closes and returns to chat.
//
// Pattern: same fullscreen overlay as TaskViewer.
// Design: Claude Code's /status → <Tabs> pattern.
// =============================================================================

import React, { useState, useEffect } from "react";
import { Box, Text, useInput } from "ink";
// We'll receive data via props from app.tsx (which calls the gateway RPC)
interface StatusPanelProps {
  onClose: () => void;
  initialTab?: Tab;
  rpc: (method: string, params?: unknown) => Promise<unknown>;
}

type Tab = "cost" | "usage" | "errors";
type UsageRange = "7d" | "30d" | "all";

const TABS: Tab[] = ["cost", "usage", "errors"];
const TAB_LABELS: Record<Tab, string> = { cost: "Cost", usage: "Usage", errors: "Errors" };

// -----------------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------------

function fmtTokens(n: number): string {
  if (n === 0) return "0";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function fmtCost(usd: number): string {
  if (usd < 0.005) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function fmtTime(ms: number | null): string {
  if (ms == null) return "—";
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h < 24) return `${h}h ${m}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

// Pad string to fixed width for alignment
function pad(str: string, width: number): string {
  return str.padEnd(width);
}

function rpad(str: string, width: number): string {
  return str.padStart(width);
}

// -----------------------------------------------------------------------------
// Main component
// -----------------------------------------------------------------------------

export function StatusPanel({ onClose, initialTab, rpc }: StatusPanelProps) {
  const [tab, setTab] = useState<Tab>(initialTab ?? "cost");
  const [usageRange, setUsageRange] = useState<UsageRange>("7d");
  const [status, setStatus] = useState<any>(null);
  const [history, setHistory] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  // Fetch data on mount
  useEffect(() => {
    void (async () => {
      try {
        const [s, h] = await Promise.all([
          rpc("gateway.status"),
          rpc("gateway.usageHistory", { range: usageRange }),
        ]);
        setStatus(s);
        setHistory(h);
      } catch {}
      setLoading(false);
    })();
  }, [usageRange, rpc]);

  // Keyboard navigation
  useInput((_input, key) => {
    if (key.escape || _input === "q") {
      onClose();
      return;
    }
    if (key.leftArrow) {
      const idx = TABS.indexOf(tab);
      setTab(TABS[(idx - 1 + TABS.length) % TABS.length]);
    }
    if (key.rightArrow) {
      const idx = TABS.indexOf(tab);
      setTab(TABS[(idx + 1) % TABS.length]);
    }
    // In usage tab: up/down switches range
    if (tab === "usage") {
      const ranges: UsageRange[] = ["7d", "30d", "all"];
      const ri = ranges.indexOf(usageRange);
      if (key.upArrow && ri > 0) setUsageRange(ranges[ri - 1]);
      if (key.downArrow && ri < ranges.length - 1) setUsageRange(ranges[ri + 1]);
    }
  });

  return (
    <Box flexDirection="column" paddingX={1}>
      {/* Cyan separator — between chat and panel */}
      <Box>
        <Text color="cyan">{"─".repeat(60)}</Text>
      </Box>

      {/* Tab header — Claude Code style: active tab has inverse bg */}
      <Box marginTop={1}>
        {TABS.map((t, i) => (
          <React.Fragment key={t}>
            {i > 0 && <Text>  </Text>}
            {tab === t ? (
              <Text bold inverse> {TAB_LABELS[t]} </Text>
            ) : (
              <Text> {TAB_LABELS[t]} </Text>
            )}
          </React.Fragment>
        ))}
      </Box>

      {/* Content */}
      <Box flexDirection="column" paddingY={1}>
        {loading ? (
          <Text color="gray">Loading...</Text>
        ) : tab === "cost" ? (
          <CostTab status={status} />
        ) : tab === "usage" ? (
          <UsageTab history={history} range={usageRange} />
        ) : (
          <ErrorsTab status={status} />
        )}
      </Box>

      {/* Footer */}
      <Box marginTop={1}>
        <Text color="gray">Esc to close</Text>
      </Box>
    </Box>
  );
}

// -----------------------------------------------------------------------------
// Cost tab
// -----------------------------------------------------------------------------

function CostTab({ status }: { status: any }) {
  if (!status) return <Text color="gray">No data available</Text>;

  const usage = status.usage;
  const uptime = status.uptimeSeconds;

  return (
    <Box flexDirection="column" gap={1}>
      {/* Gateway info */}
      <Box flexDirection="column">
        <Text bold>Gateway</Text>
        <Row label="Uptime" value={fmtUptime(uptime)} />
        <Row label="Connections" value={String(status.connections?.count ?? 0)} />
        <Row label="Sessions" value={String(status.sessions?.count ?? 0)} />
        {(status.nodes?.length ?? 0) > 0 && (
          <>
            <Row label="Nodes" value={`${status.nodes.length} connected`} />
            {status.nodes.map((n: any) => (
              <Row key={n.nodeId} label={`  ${n.name}`} value={`${n.platform} · ${n.commands.join(", ")}`} />
            ))}
          </>
        )}
      </Box>

      {/* Today's usage */}
      <Box flexDirection="column">
        <Text bold>Today ({usage?.date ?? "—"})</Text>
        <Row label="Input tokens" value={fmtTokens(usage?.tokens?.input ?? 0)} />
        <Row label="Output tokens" value={fmtTokens(usage?.tokens?.output ?? 0)} />
        {(usage?.tokens?.cacheRead ?? 0) > 0 && (
          <Row label="Cache read" value={fmtTokens(usage.tokens.cacheRead)} />
        )}
        <Row label="API calls" value={String(usage?.apiCalls ?? 0)} />
        <Row label="Cost" value={fmtCost(usage?.costUSD ?? 0)} highlight />
      </Box>

      {/* Model breakdown */}
      {usage?.byModel && Object.keys(usage.byModel).length > 0 && (
        <Box flexDirection="column">
          <Text bold>By Model</Text>
          {Object.entries(usage.byModel)
            .sort(([, a]: any, [, b]: any) => b.costUSD - a.costUSD)
            .map(([model, data]: [string, any]) => (
              <Row key={model} label={model} value={`${fmtCost(data.costUSD)}  (${fmtTokens(data.input + data.output)} tokens)`} />
            ))}
        </Box>
      )}
    </Box>
  );
}

// -----------------------------------------------------------------------------
// Usage tab
// -----------------------------------------------------------------------------

function UsageTab({ history, range }: { history: any; range: UsageRange }) {
  if (!history || !history.entries) return <Text color="gray">No usage data</Text>;

  const ranges: UsageRange[] = ["7d", "30d", "all"];
  const rangeLabels: Record<UsageRange, string> = { "7d": "7 days", "30d": "30 days", "all": "All time" };

  const summary = history.summary;
  const maxCost = summary?.peakDay?.costUSD ?? 1;

  return (
    <Box flexDirection="column" gap={1}>
      {/* Range selector */}
      <Box gap={1}>
        <Text>Range: </Text>
        {ranges.map((r) => (
          <React.Fragment key={r}>
            {range === r ? (
              <Text bold inverse> {rangeLabels[r]} </Text>
            ) : (
              <Text> {rangeLabels[r]} </Text>
            )}
          </React.Fragment>
        ))}
        <Text dimColor>  ↑↓ to change</Text>
      </Box>

      {/* Summary */}
      <Box flexDirection="column">
        <Text bold>Summary</Text>
        <Row label="Total cost" value={fmtCost(summary?.totalCostUSD ?? 0)} highlight />
        <Row label="Total tokens" value={fmtTokens(summary?.totalTokens ?? 0)} />
        <Row label="API calls" value={String(summary?.totalApiCalls ?? 0)} />
        <Row label="Active days" value={String(summary?.activeDays ?? 0)} />
        <Row label="Daily average" value={fmtCost(summary?.dailyAvgCost ?? 0)} />
        {summary?.peakDay && (
          <Row label="Peak day" value={`${summary.peakDay.date} (${fmtCost(summary.peakDay.costUSD)})`} />
        )}
      </Box>

      {/* Daily breakdown */}
      {history.entries.length > 0 && (
        <Box flexDirection="column">
          <Text bold>Daily</Text>
          {history.entries.slice(0, range === "7d" ? 7 : range === "30d" ? 30 : 60).map((entry: any) => {
            const barLen = maxCost > 0 ? Math.max(1, Math.round((entry.costUSD / maxCost) * 20)) : 0;
            const bar = "█".repeat(barLen) + "░".repeat(20 - barLen);
            return (
              <Box key={entry.date} gap={1}>
                <Text>{entry.date.slice(5)}</Text>
                <Text color="green">{bar}</Text>
                <Text color="green">{rpad(fmtCost(entry.costUSD), 8)}</Text>
                <Text dimColor>{rpad(String(entry.apiCalls), 3)} calls</Text>
              </Box>
            );
          })}
        </Box>
      )}

      {/* Model breakdown */}
      {summary?.byModel && Object.keys(summary.byModel).length > 0 && (
        <Box flexDirection="column">
          <Text bold>By Model</Text>
          {Object.entries(summary.byModel)
            .sort(([, a]: any, [, b]: any) => b.costUSD - a.costUSD)
            .map(([model, data]: [string, any]) => (
              <Row key={model} label={model} value={`${fmtCost(data.costUSD)}  (${fmtTokens(data.tokens)} tokens)`} />
            ))}
        </Box>
      )}
    </Box>
  );
}

// -----------------------------------------------------------------------------
// Errors tab
// -----------------------------------------------------------------------------

function ErrorsTab({ status }: { status: any }) {
  const errors = status?.recentErrors ?? [];

  if (errors.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color="green">No recent errors</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={0}>
      <Text bold>Recent Errors ({errors.length})</Text>
      <Box marginTop={1} flexDirection="column">
        {errors.map((err: any, i: number) => (
          <Box key={i} flexDirection="column" marginBottom={1}>
            <Box gap={1}>
              <Text color="red">●</Text>
              <Text dimColor>{fmtTime(err.timestamp)}</Text>
              <Text color="yellow">{err.subsystem}</Text>
            </Box>
            <Box paddingLeft={4}>
              <Text>{err.message}</Text>
            </Box>
            {err.details && (
              <Box paddingLeft={4}>
                <Text dimColor>{err.details.slice(0, 120)}</Text>
              </Box>
            )}
          </Box>
        ))}
      </Box>
    </Box>
  );
}

// -----------------------------------------------------------------------------
// Row helper
// -----------------------------------------------------------------------------

function Row({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <Box gap={1}>
      <Text bold>{pad(label + ":", 19)}</Text>
      {highlight ? (
        <Text bold color="green">{value}</Text>
      ) : (
        <Text color="green">{value}</Text>
      )}
    </Box>
  );
}
