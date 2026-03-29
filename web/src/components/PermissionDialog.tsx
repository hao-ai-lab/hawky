// =============================================================================
// Permission Dialog (Inline Card)
//
// Inline card rendered in the chat area (not a full-screen modal).
// Shows tool name, input preview, diff preview for file edits, and
// approve/deny buttons. Deny shows a feedback input for the user to
// explain why (sent as tool result to the agent).
// =============================================================================

import { useSessionStore, type PendingPermission } from "../store/session-store";
import { useState, useEffect } from "react";

/**
 * What the suggested pattern would look like if the suggester just
 * wrapped the literal command with no wildcard. Used to suppress the
 * "Allow `<pattern>` always" button when it would be identical to the
 * existing "Always allow this command" — no broadening on offer.
 */
function formatLiteralPattern(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" && typeof input.command === "string") return `Bash(${input.command})`;
  if (toolName === "read_file" && typeof input.file_path === "string") return `Read(${input.file_path})`;
  if (toolName === "edit_file" && typeof input.file_path === "string") return `Edit(${input.file_path})`;
  if (toolName === "write_file" && typeof input.file_path === "string") return `Write(${input.file_path})`;
  return toolName;
}

function formatInput(toolName: string, input: Record<string, unknown>): string {
  if (toolName === "bash" && typeof input.command === "string") return input.command;
  if (["read_file", "write_file", "edit_file"].includes(toolName) && typeof input.file_path === "string")
    return input.file_path;
  return JSON.stringify(input, null, 2);
}

/** Render diff hunks from server-computed preview */
function DiffPreview({ diffPreview }: { diffPreview: NonNullable<PendingPermission["diffPreview"]> }) {
  const { hunks, matchLine } = diffPreview;
  if (!hunks || hunks.length === 0) return null;

  const lineOffset = matchLine - 1;

  return (
    <div className="font-mono text-xs leading-relaxed whitespace-pre max-h-48 overflow-y-auto">
      {hunks.map((hunk, hi) => {
        const adjOldStart = hunk.oldStart + lineOffset;
        const adjNewStart = hunk.newStart + lineOffset;
        let oldLine = adjOldStart;
        let newLine = adjNewStart;

        return (
          <div key={hi}>
            {hi > 0 && <div className="text-stone-400 dark:text-stone-600 select-none">...</div>}
            <div className="text-cyan-600 dark:text-cyan-400 select-none">
              @@ -{adjOldStart},{hunk.oldLines} +{adjNewStart},{hunk.newLines} @@
            </div>
            {hunk.lines.map((line: string, li: number) => {
              const marker = line[0];
              const content = line.substring(1);

              if (marker === "\\") return null;

              const maxGutter = 4;
              let num: string;
              let type: "add" | "del" | "ctx";

              if (marker === "+") {
                num = String(newLine++).padStart(maxGutter);
                type = "add";
              } else if (marker === "-") {
                num = String(oldLine++).padStart(maxGutter);
                type = "del";
              } else {
                num = String(oldLine++).padStart(maxGutter);
                newLine++;
                type = "ctx";
              }

              return (
                <div
                  key={`${hi}-${li}`}
                  className={
                    type === "add"
                      ? "bg-green-50 dark:bg-green-950/30 text-green-800 dark:text-green-300"
                      : type === "del"
                        ? "bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-300"
                        : "text-stone-500 dark:text-stone-500"
                  }
                >
                  <span className="inline-block w-10 text-right pr-2 text-stone-400 dark:text-stone-600 select-none">
                    {num}
                  </span>
                  <span className="inline-block w-4 select-none">
                    {type === "add" ? "+" : type === "del" ? "-" : " "}
                  </span>
                  <span>{content}</span>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

export function PermissionDialog() {
  const pending = useSessionStore((s) => s.pendingPermission);
  const resolvePermission = useSessionStore((s) => s.resolvePermission);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");

  useEffect(() => {
    if (!pending) { setShowFeedback(false); setFeedback(""); return; }
    setShowFeedback(false);
    setFeedback("");
  }, [pending]);

  if (!pending) return null;

  const preview = formatInput(pending.toolName, pending.toolInput);
  const isBash = pending.toolName === "bash";
  const isNodesSystemRun = pending.toolName === "nodes"
    && pending.toolInput?.action === "invoke"
    && pending.toolInput?.command === "system.run";
  // edit_file and write_file are one permission class — the button label
  // should reflect that instead of exposing the individual tool name.
  const isFileEdit = pending.toolName === "edit_file" || pending.toolName === "write_file";
  const hasDiff = pending.diffPreview && pending.diffPreview.hunks && pending.diffPreview.hunks.length > 0;

  // "One-off" bash commands — multiline scripts, heredocs, very long
  // one-shot invocations — aren't a meaningful unit to "always allow."
  // Locking in the exact 30-line script as an exact-match grant won't
  // ever match a future invocation, and the broader pattern would be
  // either a giant button label or a useless wildcard. Hide both
  // always-allow buttons; "Allow once" + "Deny" remain. Mirrors
  // backend isOneOffBashCommand in src/agent/permission-patterns.ts.
  const bashCmd = isBash && typeof pending.toolInput?.command === "string"
    ? (pending.toolInput.command as string)
    : "";
  const isOneOffBash = isBash && (
    bashCmd.trim().length > 200
    || bashCmd.includes("\n")
    || /<<-?\s*(['"]?\w)/.test(bashCmd)
  );
  const showAlwaysAllowExact = !isOneOffBash;

  const handleDeny = () => {
    setShowFeedback(true);
  };

  const submitDeny = () => {
    resolvePermission("deny", feedback.trim() || undefined);
  };

  // Button style tokens — primary uses stone-700 (softer, warmer than pure
  // black; user feedback: "too black / not soft enough"). Ghost is a subtle
  // bordered pill. Deny is a text-only link, pushed to the right.
  const primaryBtn =
    "rounded-md bg-stone-700 dark:bg-stone-200 text-stone-50 dark:text-stone-800 px-3.5 py-1.5 text-[13px] font-medium hover:bg-stone-800 dark:hover:bg-stone-100 transition-colors";
  const ghostBtn =
    "rounded-md border border-stone-200/80 dark:border-stone-600/50 bg-transparent text-stone-600 dark:text-stone-300 px-3.5 py-1.5 text-[13px] font-medium hover:bg-stone-100/70 dark:hover:bg-stone-800/40 transition-colors";
  const denyBtn =
    "text-[13px] text-stone-500 dark:text-stone-400 hover:text-red-600 dark:hover:text-red-400 px-2 py-1.5 transition-colors";

  return (
    <div
      role="dialog"
      aria-label={`Permission request: ${pending.toolName}`}
      className="my-4 rounded-xl border border-stone-200/80 dark:border-stone-700/50 bg-stone-50/40 dark:bg-stone-800/20 p-4"
    >
      {/* Preview with a small tool-name tag anchored inside the frame —
          no separate caption line. */}
      <div className="relative mb-3">
        <span className="absolute top-2 right-2 text-[10px] font-mono font-medium tracking-wide text-stone-500 dark:text-stone-400 bg-stone-100/80 dark:bg-stone-800/80 rounded px-1.5 py-0.5 pointer-events-none select-none">
          {pending.toolName}
        </span>
        <pre className="bg-white/60 dark:bg-stone-900/40 rounded-lg border border-stone-200/60 dark:border-stone-700/40 p-3 pr-16 text-xs font-mono text-stone-700 dark:text-stone-300 overflow-x-auto max-h-40 overflow-y-auto whitespace-pre-wrap break-words">
          {preview}
        </pre>
      </div>

      {hasDiff && (
        <div className="mb-3">
          <div className="rounded-lg border border-stone-200/60 dark:border-stone-700/40 bg-white/60 dark:bg-stone-900/40 p-2 overflow-x-auto">
            <DiffPreview diffPreview={pending.diffPreview!} />
          </div>
        </div>
      )}

      {showFeedback ? (
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") submitDeny(); }}
            placeholder="Reason (optional)"
            autoFocus
            className="flex-1 rounded-md border border-stone-200/80 dark:border-stone-600/50 bg-white/70 dark:bg-stone-900/40 px-3 py-1.5 text-[13px] text-stone-700 dark:text-stone-200 placeholder:text-stone-400 focus:outline-none focus:border-stone-400/80 dark:focus:border-stone-500/70 transition-colors"
          />
          <button onClick={submitDeny} className={primaryBtn}>
            Deny
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 flex-wrap">
          <button onClick={() => resolvePermission("allow_once")} className={primaryBtn}>
            Allow once
          </button>
          {showAlwaysAllowExact && (
            <button onClick={() => resolvePermission("allow_always")} className={ghostBtn}>
              {(isBash || isNodesSystemRun)
                ? "Always allow this command"
                : isFileEdit
                  ? "Always allow file edits"
                  : `Always allow ${pending.toolName}`}
            </button>
          )}
          {pending.suggestedPattern && pending.suggestedPattern !== formatLiteralPattern(pending.toolName, pending.toolInput) && (
            // The "Allow as pattern" button — broader than the exact-
            // match grant above. Stores the pattern in the cache so
            // future variants of the same command auto-approve too.
            // Hidden when the suggested pattern is the literal form
            // (no broadening on offer — would be redundant).
            <button
              onClick={() => resolvePermission("allow_always", undefined, pending.suggestedPattern)}
              className={ghostBtn}
              title={`Adds the rule \`${pending.suggestedPattern}\` to ~/.hawky/permissions.json`}
            >
              Always allow{" "}
              <code className="font-mono text-[12px] bg-stone-100/60 dark:bg-stone-800/60 px-1.5 py-0.5 rounded">
                {pending.suggestedPattern}
              </code>
            </button>
          )}
          {pending.suggestions?.map((s, i) => {
            if (s.type === "setMode" && s.mode === "accept-edits") {
              return (
                <button key={`s-${i}`} onClick={() => resolvePermission("accept_edits")} className={ghostBtn}>
                  Allow all edits in project
                </button>
              );
            }
            if (s.type === "addDirectory" && s.directory) {
              const dir = s.directory;
              const shortDir = dir.length > 30 ? "..." + dir.slice(-27) : dir;
              return (
                <button
                  key={`s-${i}`}
                  onClick={() => resolvePermission("allow_directory")}
                  className={ghostBtn}
                  title={dir}
                >
                  Allow edits in {shortDir}
                </button>
              );
            }
            return null;
          })}
          <button onClick={handleDeny} className={`${denyBtn} ml-auto`}>
            Deny
          </button>
        </div>
      )}
    </div>
  );
}
