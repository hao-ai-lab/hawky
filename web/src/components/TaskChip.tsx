// =============================================================================
// TaskChip — chat-header pill showing the session's task state.
//
// Renders when the active session's TaskStore has at least one task.
// Collapsed form: "N tasks" pill with a chevron. Click expands an inline
// card below, listing each task with a status glyph (→ / ○ / ✓).
//
// State source: `taskSummary` on useSessionStore. Backend pushes updates
// via the "task.update" WebSocket event; initial snapshot comes from the
// `task.list` RPC called during switchSession. See src/agent/loop.ts
// (constructor) for the broadcast bridge, and
// src/gateway/agent-methods.ts for the RPC.
// =============================================================================

import { useEffect, useState } from "react";
import { useSessionStore } from "../store/session-store";
import type { SessionTask, TaskSummary } from "../store/session-store";

const STATUS_GLYPH: Record<SessionTask["status"], string> = {
  completed: "✓", // ✓
  in_progress: "→", // →
  pending: "○", // ○
};

const STATUS_CLASS: Record<SessionTask["status"], string> = {
  // Completed rows dim + strike-through so the eye lands on active work.
  completed: "text-stone-400 dark:text-stone-500 line-through",
  in_progress: "text-stone-700 dark:text-stone-200",
  pending: "text-stone-500 dark:text-stone-400",
};

function buildLabel(summary: TaskSummary): string {
  const active = summary.pending + summary.in_progress;
  // When anything is in-flight, highlight that vs total active.
  if (summary.in_progress > 0) return `${summary.in_progress} active / ${active}`;
  return active === 1 ? "1 task" : `${active} tasks`;
}

export function TaskChip() {
  const taskSummary = useSessionStore((s) => s.taskSummary);
  const activeKey = useSessionStore((s) => s.activeKey);
  const [expanded, setExpanded] = useState(false);

  // Hide when there's no OUTSTANDING work — even if the store still
  // has completed rows sitting around (they're pruned on the next
  // task_create). The chip is a signal about pending work, not a
  // historical receipt.
  const active = taskSummary ? taskSummary.pending + taskSummary.in_progress : 0;

  // Collapse on session switch — always. Without this, expanding the
  // chip in A and switching to B would show B's chip already open
  // with A's popover state leaking across.
  useEffect(() => {
    setExpanded(false);
  }, [activeKey]);

  // Also collapse when the chip is about to hide (nothing active) so
  // the next batch doesn't inherit an expanded popover from the prior
  // completed batch.
  useEffect(() => {
    if (active === 0) setExpanded(false);
  }, [active]);

  // Sub-agent sessions are internal scratch, not user-facing. If one
  // is ever surfaced in the main UI (e.g. via a hand-crafted URL),
  // don't expose its task chip — keeps internal ephemeral state out
  // of the header.
  if (activeKey.startsWith("subagent:")) return null;

  if (!taskSummary || active === 0) return null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-[12px] text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
        aria-expanded={expanded}
        aria-label={`${buildLabel(taskSummary)} — click to expand`}
      >
        <span>{buildLabel(taskSummary)}</span>
        <svg
          className={`w-3 h-3 transition-transform duration-150 ${expanded ? "rotate-180" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Expanded card — absolute so it doesn't push the header layout
          around. z-index above the chat scroll area but below modal
          dialogs (permission / ask_user sit at z-50). */}
      {expanded && (
        <div
          className="absolute right-0 top-full mt-1 w-80 max-h-80 overflow-y-auto rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 shadow-lg z-40"
          role="dialog"
          aria-label="Session tasks"
        >
          <div className="sticky top-0 bg-white dark:bg-stone-900 px-3 py-2 border-b border-stone-200 dark:border-stone-700 text-[11px] text-stone-500 dark:text-stone-400">
            Session tasks — {taskSummary.completed} / {taskSummary.total}
          </div>
          <ul className="px-1 py-1">
            {taskSummary.tasks.map((t) => (
              <li
                key={t.id}
                className={`flex items-start gap-2 px-2 py-1.5 text-[13px] ${STATUS_CLASS[t.status]}`}
              >
                <span className="font-mono text-[12px] shrink-0 w-4 pt-0.5">
                  {STATUS_GLYPH[t.status]}
                </span>
                <span className="flex-1 break-words">{t.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
