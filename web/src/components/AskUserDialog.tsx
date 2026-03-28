// =============================================================================
// Ask User Dialog (Soft Card)
//
// Inline chat card modeled on Claude Code browser's ask_user pattern: a single
// rounded container with hairline inner dividers (no separate bordered cards),
// option number chips on the right, sans-serif throughout for UI consistency,
// and soft warm-stone palette that fades into the chat surface.
// 1–9 keys select the corresponding option.
// =============================================================================

import { useState, useCallback, useEffect } from "react";
import { useSessionStore } from "../store/session-store";
import { Markdown } from "./Markdown";

const OTHER_SENTINEL = "__something_else__";

/**
 * The exact label the backend's `ask_user` tool auto-appends to the
 * options array (see `src/tools/ask_user.ts::SOMETHING_ELSE_OPTION`).
 * The dialog filters this out of the displayed options so it doesn't
 * duplicate the dialog's own "Type something else…" row, and so a
 * click doesn't echo the literal label back to the agent (which the
 * agent has no way to interpret — it expected a real choice or
 * free-form text).
 */
const BACKEND_OTHER_OPTION = "Something else (type your answer)";

/** Return-key (↵) icon for the free-form Submit button. */
function ReturnKeyIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="9 10 4 15 9 20" />
      <path d="M20 4v7a4 4 0 0 1-4 4H4" />
    </svg>
  );
}

/** Small numeric chip used at the right of each option row. */
function NumberChip({ label }: { label: string }) {
  return (
    <span
      aria-hidden
      className="inline-flex items-center justify-center shrink-0 min-w-[22px] h-[22px] rounded-md px-1.5 bg-stone-200/70 dark:bg-stone-700/60 text-[11px] font-medium text-stone-500 dark:text-stone-400"
    >
      {label}
    </span>
  );
}

export function AskUserDialog() {
  const pending = useSessionStore((s) => s.pendingAskUser);
  const resolveAskUser = useSessionStore((s) => s.resolveAskUser);
  const [freeFormText, setFreeFormText] = useState("");
  const [showFreeForm, setShowFreeForm] = useState(false);

  useEffect(() => {
    setFreeFormText("");
    setShowFreeForm(false);
  }, [pending]);

  const handleSelectOption = useCallback(
    (option: string) => {
      if (option === OTHER_SENTINEL) {
        setShowFreeForm(true);
        return;
      }
      resolveAskUser([option]);
    },
    [resolveAskUser],
  );

  const handleSubmitFreeForm = useCallback(() => {
    const trimmed = freeFormText.trim();
    if (!trimmed) return;
    resolveAskUser([trimmed]);
  }, [freeFormText, resolveAskUser]);

  // The options list as we'll display it: filter out the backend's
  // auto-appended sentinel so the dialog's own "Type something else…"
  // row isn't duplicated and clicks resolve to a meaningful answer.
  const displayedOptions = pending
    ? pending.options.filter((o) => o !== BACKEND_OTHER_OPTION)
    : [];

  // Keyboard shortcuts: single digits 1..9 select the matching row.
  //   - Digits 1..min(N, 9) select the corresponding option.
  //   - Digit N+1 opens the free-form row — but only when N+1 ≤ 9
  //     (the UI shows an em-dash chip otherwise since no single keypress
  //     can trigger "10" or above).
  // Skipped while the free-form textbox is active so the user can type
  // digits into it.
  useEffect(() => {
    if (!pending || showFreeForm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const n = parseInt(e.key, 10);
      if (isNaN(n)) return;
      const maxOptionDigit = Math.min(displayedOptions.length, 9);
      if (n >= 1 && n <= maxOptionDigit) {
        e.preventDefault();
        handleSelectOption(displayedOptions[n - 1]);
      } else if (n === displayedOptions.length + 1 && n <= 9) {
        e.preventDefault();
        handleSelectOption(OTHER_SENTINEL);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pending, showFreeForm, handleSelectOption, displayedOptions]);

  if (!pending) return null;

  const hasOptions = displayedOptions.length > 0;

  return (
    <div role="dialog" aria-label="Agent question" className="my-4">
      {/* Question text sits above the card, like prose continuing the
          conversation — no label, no pre-header. Rendered as markdown
          because the model often writes structured questions with bold
          section headers, numbered lists, and code spans; rendering as
          plain <p> dumps the raw `**asterisks**` and runs every list
          item together as one paragraph (visible bug from a real session
          where a multi-section "give me X, Y, Z" question was unreadable).
          max-h+scroll keeps the input visible even on very long prompts. */}
      <div className="mb-3 max-h-[40vh] overflow-y-auto">
        {/* safeMode: ask_user questions are model-generated text that often
            mentions shell vars ($HOME, $PATH), prices, or regex anchors —
            we don't want remark-math to mangle them. Also blocks remote
            image fetches from model-emitted ![...](...) syntax. */}
        <Markdown content={pending.question} safeMode />
      </div>

      {hasOptions && !showFreeForm ? (
        <div
          role="list"
          className="rounded-xl border border-stone-200/80 dark:border-stone-700/50 bg-stone-50/40 dark:bg-stone-800/20 overflow-hidden"
        >
          {displayedOptions.map((option, i) => (
            <button
              key={i}
              role="listitem"
              onClick={() => handleSelectOption(option)}
              className="w-full flex items-center justify-between gap-3 text-left px-4 py-2.5 border-b border-stone-200/50 dark:border-stone-700/30 last:border-b-0 hover:bg-stone-200/70 dark:hover:bg-stone-700/50 transition-colors focus-visible:outline-none focus-visible:bg-stone-200/80 dark:focus-visible:bg-stone-700/60"
            >
              <span className="flex-1 text-[14px] text-stone-800 dark:text-stone-100">
                {option}
              </span>
              <NumberChip label={String(i + 1)} />
            </button>
          ))}
          <button
            onClick={() => handleSelectOption(OTHER_SENTINEL)}
            className="w-full flex items-center justify-between gap-3 text-left px-4 py-2.5 hover:bg-stone-200/70 dark:hover:bg-stone-700/50 transition-colors focus-visible:outline-none focus-visible:bg-stone-200/80 dark:focus-visible:bg-stone-700/60"
          >
            <span className="flex-1 text-[14px] text-stone-500 dark:text-stone-400 italic">
              Type something else…
            </span>
            {/* Only show a numeric shortcut chip when it fits a single digit
                (N+1 ≤ 9). For larger N, keyboard shortcut can't be triggered
                by a single keypress — show an em-dash instead of advertising
                a non-functional "10" shortcut. */}
            <NumberChip
              label={displayedOptions.length + 1 <= 9 ? String(displayedOptions.length + 1) : "—"}
            />
          </button>
        </div>
      ) : (
        <div className="flex gap-2 items-center">
          <input
            type="text"
            value={freeFormText}
            onChange={(e) => setFreeFormText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSubmitFreeForm();
              if (e.key === "Escape" && hasOptions) {
                setShowFreeForm(false);
                setFreeFormText("");
              }
            }}
            placeholder="Type your answer…"
            autoFocus
            className="flex-1 rounded-xl border border-stone-200/80 dark:border-stone-700/50 bg-stone-50/40 dark:bg-stone-800/20 px-4 py-2.5 text-[14px] text-stone-800 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500 focus:outline-none focus:border-stone-400/80 dark:focus:border-stone-500/70 transition-colors"
          />
          <button
            onClick={handleSubmitFreeForm}
            disabled={!freeFormText.trim()}
            aria-label="Submit"
            title="Submit (Enter)"
            className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 hover:bg-stone-200 dark:hover:bg-stone-700 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
          >
            <ReturnKeyIcon className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
