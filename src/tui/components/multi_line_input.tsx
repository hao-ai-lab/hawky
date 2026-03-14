// =============================================================================
// Multi-Line Input Component
//
// Production-quality text input with visual line wrapping.
// Built on useTextBuffer hook for cursor tracking + layout.
//
// Features:
// - Visual line wrapping at terminal width
// - Cursor never disappears (inverse char with space fallback)
// - Arrow keys navigate visual lines (not logical)
// - Home/End, Ctrl+A/E, Ctrl+Left/Right word jump
// - Selection with Shift+Arrow, rendered with background highlight
// - Undo/Redo (Ctrl+Z / Ctrl+Shift+Z)
// - Ctrl+J newline, Enter submit
// - Long paste compression (>5 lines → marker)
// - History navigation (Up/Down on first/last line)
// =============================================================================

import React, { useRef, useEffect, useCallback, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  useTextBuffer,
  logicalToVisual,
  logicalPosToOffset,
  type Viewport,
} from "../hooks/use_text_buffer.js";
import { getCommands } from "../commands.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const MAX_VISIBLE_LINES = 15;
const PASTE_THRESHOLD_LINES = 5;
const PASTE_TIMEOUT_MS = 50;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

interface MultiLineInputProps {
  onSubmit: (text: string) => void;
  placeholder?: string;
  onHistoryBack?: (draft: string) => string | null;
  onHistoryForward?: () => string | null;
  externalValue?: string | null;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export function MultiLineInput({
  onSubmit,
  placeholder,
  onHistoryBack,
  onHistoryForward,
  externalValue,
}: MultiLineInputProps) {
  // Terminal width for wrapping (subtract 4 for border/padding/prompt)
  const cols = (process.stdout.columns ?? 80) - 4;
  const viewport: Viewport = { width: Math.max(cols, 20), height: MAX_VISIBLE_LINES };

  const buf = useTextBuffer(viewport);

  // Long paste storage
  const pastedContentRef = useRef<string | null>(null);
  const pasteBufferRef = useRef<string>("");
  const pasteTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Tab completion state
  const [tabHints, setTabHints] = useState<string[]>([]);
  const tabCandidatesRef = useRef<string[]>([]);
  const tabCycleIndexRef = useRef<number>(-1);

  // Handle external value changes (from history navigation)
  useEffect(() => {
    if (externalValue !== null && externalValue !== undefined) {
      buf.setText(externalValue);
      pastedContentRef.current = null;
    }
  }, [externalValue]);

  const getValue = useCallback((): string => {
    if (pastedContentRef.current !== null) return pastedContentRef.current;
    return buf.getText();
  }, [buf]);

  const clearAll = useCallback(() => {
    buf.clear();
    pastedContentRef.current = null;
  }, [buf]);

  // Process paste buffer
  const flushPasteBuffer = useCallback(() => {
    const text = pasteBufferRef.current;
    pasteBufferRef.current = "";
    if (!text) return;

    const pasteLines = text.split("\n").filter((l, i, a) => i < a.length - 1 || l.length > 0);

    if (pasteLines.length > PASTE_THRESHOLD_LINES) {
      // Store full pasted text, show marker
      const currentText = buf.getText();
      const offset = buf.lines.slice(0, buf.cursorRow).join("\n").length +
        (buf.cursorRow > 0 ? 1 : 0) + buf.cursorCol;
      const before = currentText.slice(0, offset);
      const after = currentText.slice(offset);
      pastedContentRef.current = before + pasteLines.join("\n") + after;
      const marker = `[Pasted ${pasteLines.length} lines from clipboard]`;
      buf.setText(marker);
    } else {
      buf.insert(pasteLines.join("\n"));
    }
  }, [buf]);

  useInput((input, key) => {
    // --- Submit ---
    if (key.return && !key.ctrl && !key.shift && !key.meta) {
      const value = getValue().trim();
      if (value.length === 0) return;
      onSubmit(value);
      clearAll();
      return;
    }

    // --- Newline (Ctrl+J) ---
    // Ctrl+J sends \n (0x0A). Ink parses this as key.name='enter' (not ctrl+j).
    // We detect it as: single \n character, no other content, no modifiers.
    if (key.ctrl && input === "j") {
      pastedContentRef.current = null;
      buf.newline();
      return;
    }
    // Ink 6 legacy path: Ctrl+J arrives as input="\n" with no ctrl flag
    if (input === "\n" && !key.return && !key.meta) {
      pastedContentRef.current = null;
      buf.newline();
      return;
    }

    // --- Undo (Ctrl+Z) ---
    if (key.ctrl && input === "z") {
      buf.undo();
      return;
    }

    // --- Redo (Ctrl+Shift+Z or Ctrl+Y) ---
    if (key.ctrl && input === "y") {
      buf.redo();
      return;
    }

    // --- Select All (Ctrl+A with Meta — some terminals send meta+a) ---
    // Note: In Ink, Ctrl+A is tricky. We use Meta+A as alternative.
    if (key.meta && input === "a") {
      buf.selectAll();
      return;
    }

    // --- Ctrl+A → home of logical line ---
    if (key.ctrl && input === "a") {
      buf.move("logicalHome");
      return;
    }

    // --- Ctrl+E → end of logical line ---
    if (key.ctrl && input === "e") {
      buf.move("logicalEnd");
      return;
    }

    // --- Tab → slash command completion ---
    if (key.tab) {
      const text = getValue();
      if (text.startsWith("/") && !text.includes(" ")) {
        const partial = text.slice(1).toLowerCase();
        const commands = getCommands();
        const matches = commands.filter((c) =>
          c.name.startsWith(partial) || c.aliases.some((a) => a.startsWith(partial))
        );

        if (matches.length === 1) {
          // Single match — complete it
          buf.setText("/" + matches[0].name + " ");
          buf.move("logicalEnd");
          setTabHints([]);
          tabCandidatesRef.current = [];
          tabCycleIndexRef.current = -1;
        } else if (matches.length > 1) {
          const names = matches.map((c) => c.name);

          // Check if we're cycling (same candidates as last Tab press)
          const prevCandidates = tabCandidatesRef.current;
          const isCycling = prevCandidates.length === names.length &&
            prevCandidates.every((n, i) => n === names[i]);

          if (isCycling) {
            // Cycle to next candidate
            tabCycleIndexRef.current = (tabCycleIndexRef.current + 1) % names.length;
            buf.setText("/" + names[tabCycleIndexRef.current]);
            buf.move("logicalEnd");
          } else {
            // First Tab — complete common prefix and show hints
            let prefix = names[0];
            for (const name of names.slice(1)) {
              while (!name.startsWith(prefix)) prefix = prefix.slice(0, -1);
            }
            if (prefix.length > partial.length) {
              buf.setText("/" + prefix);
              buf.move("logicalEnd");
            }
            tabCandidatesRef.current = names;
            tabCycleIndexRef.current = -1;
            setTabHints(names.map((n) => "/" + n));
          }
        } else {
          setTabHints([]);
        }
      }
      return;
    }

    // Any non-Tab key clears the tab hints
    if (tabHints.length > 0) {
      setTabHints([]);
      tabCandidatesRef.current = [];
      tabCycleIndexRef.current = -1;
    }

    // --- Arrow keys (with shift = select) ---
    if (key.leftArrow) {
      const dir = key.ctrl || key.meta ? "wordLeft" : "left";
      if (key.shift) buf.selectMove(dir);
      else buf.move(dir);
      return;
    }
    if (key.rightArrow) {
      const dir = key.ctrl || key.meta ? "wordRight" : "right";
      if (key.shift) buf.selectMove(dir);
      else buf.move(dir);
      return;
    }
    if (key.upArrow) {
      if (key.shift) {
        buf.selectMove("up");
        return;
      }
      // Check if cursor is on first visual line → history
      const [visRow] = logicalToVisual(buf.layout, buf.cursorRow, buf.cursorCol);
      if (visRow <= 0 && onHistoryBack) {
        const prev = onHistoryBack(getValue());
        if (prev !== null) {
          buf.setText(prev);
          pastedContentRef.current = null;
          // Move cursor to start
          buf.move("home");
        }
        return;
      }
      buf.move("up");
      return;
    }
    if (key.downArrow) {
      if (key.shift) {
        buf.selectMove("down");
        return;
      }
      const [visRow] = logicalToVisual(buf.layout, buf.cursorRow, buf.cursorCol);
      if (visRow >= buf.layout.visualLines.length - 1 && onHistoryForward) {
        const next = onHistoryForward();
        if (next !== null) {
          buf.setText(next);
          pastedContentRef.current = null;
        }
        return;
      }
      buf.move("down");
      return;
    }

    // --- Home / End ---
    if ((key as any).home) {
      if (key.shift) buf.selectMove("home");
      else buf.move("home");
      return;
    }
    if ((key as any).end) {
      if (key.shift) buf.selectMove("end");
      else buf.move("end");
      return;
    }

    // --- Backspace ---
    if (key.backspace || key.delete) {
      pastedContentRef.current = null;
      buf.backspace();
      return;
    }

    // --- Regular character input ---
    if (input && !key.ctrl && !key.meta) {
      // Paste detection (contains newlines)
      if (input.includes("\n") || input.includes("\r")) {
        const normalized = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

        if (pastedContentRef.current !== null) {
          pastedContentRef.current += normalized;
          const lineCount = pastedContentRef.current.split("\n").length;
          buf.setText(`[Pasted ${lineCount} lines from clipboard]`);
          return;
        }

        pasteBufferRef.current += normalized;
        if (pasteTimerRef.current) clearTimeout(pasteTimerRef.current);
        pasteTimerRef.current = setTimeout(flushPasteBuffer, PASTE_TIMEOUT_MS);
        return;
      }

      pastedContentRef.current = null;
      buf.insert(input);
    }
  });

  // --- Rendering ---
  const { layout, visualCursor, scrollRow, selectionAnchor } = buf;
  const visibleLines = layout.visualLines.slice(scrollRow, scrollRow + viewport.height);
  const isEmpty = buf.lines.length === 1 && buf.lines[0] === "";

  // Compute selection range in text offsets for highlighting
  const selRange = selectionAnchor ? buf.getSelectionRange() : null;

  // Convert text offset to position in the full text for selection rendering
  const fullText = buf.getText();

  if (isEmpty && placeholder) {
    return (
      <Box>
        <Text color="gray">{placeholder}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {visibleLines.map((visLine, idx) => {
        const visRowAbs = scrollRow + idx;
        const [curVisRow, curVisCol] = visualCursor;
        const isCursorLine = visRowAbs === curVisRow;
        const chars = Array.from(visLine);

        // Calculate this visual line's offset in full text for selection
        const mapping = layout.visualToLogicalMap[visRowAbs];
        let lineStartOffset = 0;
        if (mapping) {
          lineStartOffset = logicalPosToOffset(buf.lines, mapping[0], mapping[1]);
        }

        // Build rendered line with cursor and selection
        let rendered = "";
        for (let ci = 0; ci <= chars.length; ci++) {
          const ch = ci < chars.length ? chars[ci] : "";
          const charOffset = lineStartOffset + ci;
          const isSelected = selRange && charOffset >= selRange[0] && charOffset < selRange[1];
          const isCursor = isCursorLine && ci === curVisCol;

          if (isCursor) {
            const displayChar = ch || " ";
            if (isSelected) {
              rendered += `\x1b[7;46m${displayChar}\x1b[0m`; // inverse + cyan bg
            } else {
              rendered += `\x1b[7m${displayChar}\x1b[0m`; // inverse
            }
          } else if (isSelected) {
            if (ch) rendered += `\x1b[46;30m${ch}\x1b[0m`; // cyan bg, black text
          } else {
            rendered += ch;
          }
        }

        return (
          <Box key={visRowAbs} height={1}>
            <Text>{rendered || (isCursorLine ? "\x1b[7m \x1b[0m" : " ")}</Text>
          </Box>
        );
      })}
      {layout.visualLines.length > viewport.height && (
        <Text color="gray" dimColor>
          {`  (${layout.visualLines.length} lines, showing ${scrollRow + 1}-${Math.min(scrollRow + viewport.height, layout.visualLines.length)})`}
        </Text>
      )}
      {tabHints.length > 0 && (
        <Text color="#949494" dimColor>
          {"  " + tabHints.join("  ")}
        </Text>
      )}
    </Box>
  );
}

