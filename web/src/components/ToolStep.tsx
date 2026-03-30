// =============================================================================
// ToolStep — a Claude.ai-style collapsible group of tool invocations.
//
// Each step represents one "turn" of the agent: all tool calls issued in a
// single batchId appear inside one step. A step renders as:
//
//   ▸ Read foo.ts                          ← collapsed (default)
//
// Click to expand:
//
//   ▾ Read foo.ts
//     └─ read_file  src/foo.ts             42 lines
//        (body with output/diff if any)
//
// For N>1 tools (parallel calls inside a batch) the headline summarises
// the group ("3 tools: Read, Grep, Bash") and each ToolLine appears as a
// sibling under the left rail, producing the tree visual the user asked
// for — replacing the old "⚡ N tools" row + separate cards.
// =============================================================================

import { useState } from "react";
import { ToolLine, type ToolLineData } from "./ToolLine";
import { formatStepHeadline } from "../utils/toolDisplay";

interface ToolStepProps {
  tools: ToolLineData[];
  /** Whether this step starts expanded. Default: false. */
  defaultExpanded?: boolean;
}

export function ToolStep({ tools, defaultExpanded = false }: ToolStepProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (tools.length === 0) return null;

  const anyRunning = tools.some((t) => t.status === "running");
  const anyError = tools.some((t) => t.isError);
  const headline = formatStepHeadline(tools);

  return (
    <div className="tool-step">
      {/* Header row — chevron sits in the column's left gutter (negative
          margin) so the headline text aligns with normal prose at the
          column edge, and the row extends slightly to the left of
          assistant text. Hover ring hugs content (inline-flex). */}
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="inline-flex items-center gap-2 text-left py-1 pr-1 pl-1 sm:-ml-6 rounded hover:bg-stone-100/60 dark:hover:bg-stone-800/40 transition-colors max-w-full"
        aria-expanded={expanded}
      >
        {/* SVG chevron — sized down + thinner stroke so the row reads as
            secondary metadata, matching Claude Code's visual hierarchy where
            tool labels recede behind the assistant's prose. */}
        <svg
          className={`w-3.5 h-3.5 shrink-0 text-stone-400 dark:text-stone-500 transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.75"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <polyline points="9 6 15 12 9 18" />
        </svg>
        <span className="text-[13px] text-stone-500 dark:text-stone-400 truncate">
          {headline}
        </span>
        {anyRunning && (
          <span className="text-[13px] text-stone-500 dark:text-stone-400 italic shrink-0">
            running…
          </span>
        )}
        {!anyRunning && anyError && (
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 dark:bg-red-400 shrink-0" aria-label="has error" />
        )}
      </button>

      {/* Body — tree-branch rail (T / L glyphs per child via .tree-branch
          pseudo-elements in globals.css). Each ToolLine is wrapped in a
          branch div so parallel tools read as a tree rather than a single
          continuous rail. */}
      {expanded && (
        <div className="mt-1 ml-2 space-y-2">
          {tools.map((tool, i) => (
            <div key={`${tool.name}-${i}`} className="tree-branch">
              <ToolLine tool={tool} showBody />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
