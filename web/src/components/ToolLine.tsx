// =============================================================================
// ToolLine — a single tool row rendered inside a ToolStep.
//
// No card frame, no per-tool chevron: the parent ToolStep owns the expand
// affordance and shows the whole step at once. ToolLine is just: a small
// tool-name pill, the input preview, the status glyph, and — when the step
// is expanded and there is output/diff — the body inline underneath.
// =============================================================================

import {
  AnimatedSpinner,
  DiffView,
  LinkifiedText,
  hasDiffMetadata,
  tryFormatJson,
  useElapsed,
  formatToolSummary,
} from "../utils/toolDisplay";

export interface ToolLineData {
  name: string;
  inputPreview: string;
  /** Pre-rendered display string for the expanded row. When present, shows
   *  the full command / path / pattern instead of the capped inputPreview.
   *  Computed and bounded in transcript-view's buildFullInput — ToolLine
   *  just renders whatever string it gets. */
  fullInput?: string;
  status: "running" | "success" | "error";
  output: string;
  isError: boolean;
  metadata?: Record<string, unknown>;
  startedAt?: number;
}

export function ToolLine({ tool, showBody }: { tool: ToolLineData; showBody: boolean }) {
  const hasOutput = tool.output.trim().length > 0;
  const hasDiff = hasDiffMetadata(tool.metadata);
  const hasBody = hasOutput || hasDiff;
  const summary = tool.status !== "running"
    ? formatToolSummary(tool.name, tool.metadata, tool.isError, tool.output)
    : null;
  const elapsedText = useElapsed(tool.startedAt, tool.status === "running");
  const displayInput = tool.fullInput ?? tool.inputPreview;

  return (
    <div className="text-body">
      {/* Header row — name · input · summary. Colors: muted throughout to
          match the parent step header; error surfaces with a small dot
          prefix rather than red text.
          The input span wraps (whitespace-pre-wrap + break-all) so long bash
          commands and deep paths are visible in full, not cut off at 80 chars. */}
      <div className="flex items-baseline gap-2 flex-wrap">
        {tool.status === "running" && (
          <span className="text-xs text-stone-500 dark:text-stone-400 tabular-nums">
            <AnimatedSpinner />
          </span>
        )}
        {tool.isError && tool.status !== "running" && (
          <span
            aria-label="error"
            className="inline-block w-1.5 h-1.5 rounded-full bg-red-500 dark:bg-red-400 shrink-0 translate-y-[-1px]"
          />
        )}
        <span className="font-mono text-[0.82em] text-stone-500 dark:text-stone-400 shrink-0">
          {tool.name}
        </span>
        <span className="font-mono text-[0.82em] text-stone-500 dark:text-stone-400 whitespace-pre-wrap break-all flex-1 min-w-0">
          {displayInput}
        </span>
        {elapsedText && (
          <span className="text-xs text-stone-500 dark:text-stone-400 shrink-0 tabular-nums">
            ({elapsedText})
          </span>
        )}
        {summary && (
          <span className="text-xs text-stone-500 dark:text-stone-400 shrink-0">
            {summary}
          </span>
        )}
      </div>

      {/* Body — shown when parent step is expanded AND there is something to show */}
      {showBody && hasBody && (
        <div className="mt-1 ml-0 max-h-64 overflow-y-auto rounded-md bg-stone-50/70 dark:bg-stone-900/40 border border-stone-200/60 dark:border-stone-700/40 px-3 py-2">
          {hasDiff && tool.metadata ? (
            <DiffView
              metadata={tool.metadata}
              fallback={
                hasOutput ? (
                  <pre className="text-xs font-mono text-stone-600 dark:text-stone-400 whitespace-pre-wrap break-words">
                    <LinkifiedText text={tryFormatJson(tool.output)} />
                  </pre>
                ) : undefined
              }
            />
          ) : (
            <pre className="text-xs font-mono text-stone-600 dark:text-stone-400 whitespace-pre-wrap break-words">
              <LinkifiedText text={tryFormatJson(tool.output)} />
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
