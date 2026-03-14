// =============================================================================
// Text Buffer Hook
//
// Core text editing engine with visual line wrapping. Inspired by COCO's
// text-buffer.ts but simplified (~400 lines vs 1,666).
//
// Key concepts:
// - Logical lines: raw text split by \n (what the user typed)
// - Visual lines: text wrapped at viewport width (what's displayed)
// - Bidirectional mapping between logical and visual coordinates
// - Cursor always tracked in logical coords, converted to visual for rendering
// - Viewport scrolling keeps cursor visible
// =============================================================================

import { useState, useCallback, useRef, useMemo, useEffect } from "react";

// We use string-width for proper emoji/CJK width calculation.
// Lazy-loaded to avoid import issues in test environments.
let _stringWidth: ((s: string) => number) | null = null;
function getStringWidth(s: string): number {
  if (!_stringWidth) {
    try {
      // string-width may not be available — fall back to .length
      _stringWidth = require("string-width");
      // Handle both default and named export
      if (typeof _stringWidth !== "function") {
        const mod = _stringWidth as any;
        _stringWidth = mod.default ?? mod.stringWidth ?? ((s: string) => s.length);
      }
    } catch {
      _stringWidth = (s: string) => s.length;
    }
  }
  return _stringWidth!(s);
}

// Cache string widths for performance
const widthCache = new Map<string, number>();
function cachedStringWidth(s: string): number {
  if (s.length <= 1) {
    if (s.length === 0) return 0;
    // Fast path for ASCII
    const code = s.charCodeAt(0);
    if (code >= 0x20 && code < 0x7f) return 1;
  }
  let w = widthCache.get(s);
  if (w === undefined) {
    w = getStringWidth(s);
    if (widthCache.size > 5000) widthCache.clear(); // Prevent unbounded growth
    widthCache.set(s, w);
  }
  return w;
}

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface Viewport {
  width: number;
  height: number;
}

export interface VisualLayout {
  visualLines: string[];
  /** For each logical line: array of [visualRowIndex, colOffsetInLogical] */
  logicalToVisualMap: Array<Array<[number, number]>>;
  /** For each visual row: [logicalRow, colOffsetInLogical] */
  visualToLogicalMap: Array<[number, number]>;
}

export interface TextBufferState {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
  /** Selection anchor in logical coords, null if no selection */
  selectionAnchor: [number, number] | null;
}

interface UndoEntry {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
}

export interface TextBuffer {
  /** Current logical lines */
  lines: string[];
  /** Cursor position in logical coords */
  cursorRow: number;
  cursorCol: number;
  /** Visual layout for rendering */
  layout: VisualLayout;
  /** Visual cursor position [visualRow, visualCol] */
  visualCursor: [number, number];
  /** Visual scroll offset (first visible visual row) */
  scrollRow: number;
  /** Selection anchor (null if no selection) */
  selectionAnchor: [number, number] | null;
  /** Get selected text range as [startOffset, endOffset], or null */
  getSelectionRange: () => [number, number] | null;
  /** Get selected text string, or null */
  getSelectedText: () => string | null;

  // -- Mutations --
  insert: (text: string) => void;
  backspace: () => void;
  deleteForward: () => void;
  newline: () => void;
  move: (dir: Direction) => void;
  selectMove: (dir: Direction) => void;
  selectAll: () => void;
  clearSelection: () => void;
  setText: (text: string) => void;
  clear: () => void;
  undo: () => void;
  redo: () => void;

  /** Full text content */
  getText: () => string;
}

export type Direction =
  | "left" | "right" | "up" | "down"
  | "wordLeft" | "wordRight"
  | "home" | "end"
  | "logicalHome" | "logicalEnd";

// -----------------------------------------------------------------------------
// Layout calculation
// -----------------------------------------------------------------------------

export function calculateLayout(
  logicalLines: string[],
  viewportWidth: number,
): VisualLayout {
  const visualLines: string[] = [];
  const logicalToVisualMap: Array<Array<[number, number]>> = [];
  const visualToLogicalMap: Array<[number, number]> = [];

  const effectiveWidth = Math.max(viewportWidth, 4);

  for (let logIdx = 0; logIdx < logicalLines.length; logIdx++) {
    const logLine = logicalLines[logIdx];
    logicalToVisualMap[logIdx] = [];

    if (logLine.length === 0) {
      logicalToVisualMap[logIdx].push([visualLines.length, 0]);
      visualToLogicalMap.push([logIdx, 0]);
      visualLines.push("");
      continue;
    }

    // Split into characters (Array.from handles surrogate pairs)
    const chars = Array.from(logLine);
    let pos = 0;

    while (pos < chars.length) {
      let chunk = "";
      let chunkWidth = 0;
      let chunkChars = 0;
      let lastSpaceChars = -1;

      for (let i = pos; i < chars.length; i++) {
        const ch = chars[i];
        const chWidth = cachedStringWidth(ch);

        if (chunkWidth + chWidth > effectiveWidth) {
          // Try to break at last space
          if (lastSpaceChars > 0 && pos + lastSpaceChars < i) {
            chunk = chars.slice(pos, pos + lastSpaceChars).join("");
            chunkChars = lastSpaceChars;
          } else if (chunkChars === 0) {
            // Single char wider than viewport — take it anyway
            chunk = ch;
            chunkChars = 1;
          }
          break;
        }

        chunk += ch;
        chunkWidth += chWidth;
        chunkChars++;

        if (ch === " ") {
          lastSpaceChars = chunkChars;
        }
      }

      if (chunkChars === 0 && pos < chars.length) {
        chunk = chars[pos];
        chunkChars = 1;
      }

      logicalToVisualMap[logIdx].push([visualLines.length, pos]);
      visualToLogicalMap.push([logIdx, pos]);
      visualLines.push(chunk);

      pos += chunkChars;
      // Skip leading space on next visual line after word wrap
      if (pos < chars.length && chars[pos] === " " && chunkChars > 1) {
        pos++;
      }
    }
  }

  // Ensure at least one visual line
  if (visualLines.length === 0) {
    visualLines.push("");
    logicalToVisualMap[0] = [[0, 0]];
    visualToLogicalMap.push([0, 0]);
  }

  return { visualLines, logicalToVisualMap, visualToLogicalMap };
}

// -----------------------------------------------------------------------------
// Coordinate conversion
// -----------------------------------------------------------------------------

export function logicalToVisual(
  layout: VisualLayout,
  logRow: number,
  logCol: number,
): [number, number] {
  const segments = layout.logicalToVisualMap[logRow];
  if (!segments || segments.length === 0) return [0, 0];

  let segIdx = segments.findIndex(([, startCol], i) => {
    const nextStart = i + 1 < segments.length ? segments[i + 1][1] : Infinity;
    return logCol >= startCol && logCol < nextStart;
  });

  if (segIdx === -1) {
    segIdx = logCol === 0 ? 0 : segments.length - 1;
  }

  const [visRow, startCol] = segments[segIdx];
  const visCol = logCol - startCol;
  const lineLen = Array.from(layout.visualLines[visRow] ?? "").length;
  return [visRow, Math.min(visCol, lineLen)];
}

export function visualToLogical(
  layout: VisualLayout,
  visRow: number,
  visCol: number,
): [number, number] {
  const mapping = layout.visualToLogicalMap[visRow];
  if (!mapping) return [0, 0];
  const [logRow, colOffset] = mapping;
  return [logRow, colOffset + visCol];
}

// -----------------------------------------------------------------------------
// Offset ↔ logical position conversion
// -----------------------------------------------------------------------------

export function logicalPosToOffset(lines: string[], row: number, col: number): number {
  let offset = 0;
  const r = Math.min(row, lines.length - 1);
  for (let i = 0; i < r; i++) {
    offset += Array.from(lines[i]).length + 1; // +1 for \n
  }
  if (r >= 0 && r < lines.length) {
    offset += Math.min(col, Array.from(lines[r]).length);
  }
  return offset;
}

function offsetToLogicalPos(lines: string[], offset: number): [number, number] {
  let remaining = offset;
  for (let i = 0; i < lines.length; i++) {
    const lineLen = Array.from(lines[i]).length;
    if (remaining <= lineLen) return [i, remaining];
    remaining -= lineLen + 1;
  }
  const last = lines.length - 1;
  return [Math.max(last, 0), Array.from(lines[Math.max(last, 0)] ?? "").length];
}

// -----------------------------------------------------------------------------
// Word boundary detection
// -----------------------------------------------------------------------------

function isWordChar(ch: string): boolean {
  return /[\w\p{L}\p{N}]/u.test(ch);
}

function findWordLeft(line: string, col: number): number {
  const chars = Array.from(line);
  let i = col - 1;
  // Skip whitespace
  while (i >= 0 && /\s/.test(chars[i])) i--;
  // Skip word chars
  if (i >= 0 && isWordChar(chars[i])) {
    while (i >= 0 && isWordChar(chars[i])) i--;
  } else {
    while (i >= 0 && !isWordChar(chars[i]) && !/\s/.test(chars[i])) i--;
  }
  return i + 1;
}

function findWordRight(line: string, col: number): number {
  const chars = Array.from(line);
  let i = col;
  if (i >= chars.length) return chars.length;
  // Skip current word/punct
  if (isWordChar(chars[i])) {
    while (i < chars.length && isWordChar(chars[i])) i++;
  } else if (!/\s/.test(chars[i])) {
    while (i < chars.length && !isWordChar(chars[i]) && !/\s/.test(chars[i])) i++;
  }
  // Skip whitespace
  while (i < chars.length && /\s/.test(chars[i])) i++;
  return i;
}

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

const MAX_UNDO = 50;

export function useTextBuffer(viewport: Viewport): TextBuffer {
  const [state, setState] = useState<TextBufferState>({
    lines: [""],
    cursorRow: 0,
    cursorCol: 0,
    selectionAnchor: null,
  });

  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const lastSavedRef = useRef<string>("");

  // Save undo checkpoint (debounced — only saves if text actually changed)
  const saveUndo = useCallback((s: TextBufferState) => {
    const text = s.lines.join("\n");
    if (text === lastSavedRef.current) return;
    lastSavedRef.current = text;
    undoStack.current.push({ lines: [...s.lines], cursorRow: s.cursorRow, cursorCol: s.cursorCol });
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
    redoStack.current = [];
  }, []);

  // Compute layout from current state
  const layout = useMemo(
    () => calculateLayout(state.lines, viewport.width),
    [state.lines, viewport.width],
  );

  const visualCursor = useMemo(
    () => logicalToVisual(layout, state.cursorRow, state.cursorCol),
    [layout, state.cursorRow, state.cursorCol],
  );

  // Viewport scrolling
  const [scrollRow, setScrollRow] = useState(0);
  const scrollRowRef = useRef(0);
  scrollRowRef.current = scrollRow;

  // Auto-scroll to keep cursor visible
  useEffect(() => {
    const [visRow] = visualCursor;
    let sr = scrollRowRef.current;
    if (visRow < sr) sr = visRow;
    else if (visRow >= sr + viewport.height) sr = visRow - viewport.height + 1;
    sr = Math.max(0, Math.min(sr, Math.max(0, layout.visualLines.length - viewport.height)));
    if (sr !== scrollRowRef.current) setScrollRow(sr);
  }, [visualCursor, viewport.height, layout.visualLines.length]);

  // -- Selection helpers --
  const getSelectionRange = useCallback((): [number, number] | null => {
    if (!state.selectionAnchor) return null;
    const anchorOff = logicalPosToOffset(state.lines, state.selectionAnchor[0], state.selectionAnchor[1]);
    const cursorOff = logicalPosToOffset(state.lines, state.cursorRow, state.cursorCol);
    return anchorOff <= cursorOff ? [anchorOff, cursorOff] : [cursorOff, anchorOff];
  }, [state]);

  const getSelectedText = useCallback((): string | null => {
    const range = getSelectionRange();
    if (!range) return null;
    const text = state.lines.join("\n");
    const chars = Array.from(text);
    return chars.slice(range[0], range[1]).join("");
  }, [getSelectionRange, state.lines]);

  const deleteSelection = useCallback((s: TextBufferState): TextBufferState | null => {
    if (!s.selectionAnchor) return null;
    const anchorOff = logicalPosToOffset(s.lines, s.selectionAnchor[0], s.selectionAnchor[1]);
    const cursorOff = logicalPosToOffset(s.lines, s.cursorRow, s.cursorCol);
    const start = Math.min(anchorOff, cursorOff);
    const end = Math.max(anchorOff, cursorOff);
    if (start === end) return { ...s, selectionAnchor: null };

    const text = s.lines.join("\n");
    const chars = Array.from(text);
    const newText = chars.slice(0, start).join("") + chars.slice(end).join("");
    const newLines = newText.split("\n");
    if (newLines.length === 0) newLines.push("");
    const [newRow, newCol] = offsetToLogicalPos(newLines, start);
    return { lines: newLines, cursorRow: newRow, cursorCol: newCol, selectionAnchor: null };
  }, []);

  // -- Mutation functions --
  const insert = useCallback((text: string) => {
    setState((s) => {
      saveUndo(s);
      // Delete selection first if any
      const base = deleteSelection(s) ?? s;
      const { lines, cursorRow, cursorCol } = base;
      const before = lines[cursorRow].slice(0, cursorCol);
      const after = lines[cursorRow].slice(cursorCol);
      const insertLines = text.split("\n");

      const newLines = [...lines];
      if (insertLines.length === 1) {
        newLines[cursorRow] = before + insertLines[0] + after;
        return { ...base, lines: newLines, cursorCol: cursorCol + insertLines[0].length, selectionAnchor: null };
      } else {
        newLines[cursorRow] = before + insertLines[0];
        const middle = insertLines.slice(1, -1);
        const lastInsert = insertLines[insertLines.length - 1] + after;
        newLines.splice(cursorRow + 1, 0, ...middle, lastInsert);
        const newRow = cursorRow + insertLines.length - 1;
        return { ...base, lines: newLines, cursorRow: newRow, cursorCol: insertLines[insertLines.length - 1].length, selectionAnchor: null };
      }
    });
  }, [saveUndo, deleteSelection]);

  const backspace = useCallback(() => {
    setState((s) => {
      saveUndo(s);
      // If selection, delete it
      const deleted = deleteSelection(s);
      if (deleted) return deleted;

      const { lines, cursorRow, cursorCol } = s;
      if (cursorCol > 0) {
        const newLines = [...lines];
        newLines[cursorRow] = newLines[cursorRow].slice(0, cursorCol - 1) + newLines[cursorRow].slice(cursorCol);
        return { ...s, lines: newLines, cursorCol: cursorCol - 1, selectionAnchor: null };
      } else if (cursorRow > 0) {
        const newLines = [...lines];
        const prevLen = newLines[cursorRow - 1].length;
        newLines[cursorRow - 1] += newLines[cursorRow];
        newLines.splice(cursorRow, 1);
        return { ...s, lines: newLines, cursorRow: cursorRow - 1, cursorCol: prevLen, selectionAnchor: null };
      }
      return s;
    });
  }, [saveUndo, deleteSelection]);

  const deleteForward = useCallback(() => {
    setState((s) => {
      saveUndo(s);
      const deleted = deleteSelection(s);
      if (deleted) return deleted;

      const { lines, cursorRow, cursorCol } = s;
      if (cursorCol < lines[cursorRow].length) {
        const newLines = [...lines];
        newLines[cursorRow] = newLines[cursorRow].slice(0, cursorCol) + newLines[cursorRow].slice(cursorCol + 1);
        return { ...s, lines: newLines, selectionAnchor: null };
      } else if (cursorRow < lines.length - 1) {
        const newLines = [...lines];
        newLines[cursorRow] += newLines[cursorRow + 1];
        newLines.splice(cursorRow + 1, 1);
        return { ...s, lines: newLines, selectionAnchor: null };
      }
      return s;
    });
  }, [saveUndo, deleteSelection]);

  const newline = useCallback(() => {
    setState((s) => {
      saveUndo(s);
      const base = deleteSelection(s) ?? s;
      const { lines, cursorRow, cursorCol } = base;
      const newLines = [...lines];
      const before = newLines[cursorRow].slice(0, cursorCol);
      const after = newLines[cursorRow].slice(cursorCol);
      newLines[cursorRow] = before;
      newLines.splice(cursorRow + 1, 0, after);
      return { ...base, lines: newLines, cursorRow: cursorRow + 1, cursorCol: 0, selectionAnchor: null };
    });
  }, [saveUndo, deleteSelection]);

  // -- Movement --
  const moveLogical = useCallback((s: TextBufferState, dir: Direction): TextBufferState => {
    const { lines, cursorRow, cursorCol } = s;
    const lineLen = (r: number) => lines[r]?.length ?? 0;

    switch (dir) {
      case "left":
        if (cursorCol > 0) return { ...s, cursorCol: cursorCol - 1 };
        if (cursorRow > 0) return { ...s, cursorRow: cursorRow - 1, cursorCol: lineLen(cursorRow - 1) };
        return s;
      case "right":
        if (cursorCol < lineLen(cursorRow)) return { ...s, cursorCol: cursorCol + 1 };
        if (cursorRow < lines.length - 1) return { ...s, cursorRow: cursorRow + 1, cursorCol: 0 };
        return s;
      case "up": {
        // Move up on visual lines
        const [visRow, visCol] = logicalToVisual(layout, cursorRow, cursorCol);
        if (visRow <= 0) return s;
        const [logR, logC] = visualToLogical(layout, visRow - 1, visCol);
        const clamped = Math.min(logC, lineLen(logR));
        return { ...s, cursorRow: logR, cursorCol: clamped };
      }
      case "down": {
        const [visRow, visCol] = logicalToVisual(layout, cursorRow, cursorCol);
        if (visRow >= layout.visualLines.length - 1) return s;
        const [logR, logC] = visualToLogical(layout, visRow + 1, visCol);
        const clamped = Math.min(logC, lineLen(logR));
        return { ...s, cursorRow: logR, cursorCol: clamped };
      }
      case "home": {
        // Move to start of visual line
        const [visRow] = logicalToVisual(layout, cursorRow, cursorCol);
        const [logR, logC] = visualToLogical(layout, visRow, 0);
        return { ...s, cursorRow: logR, cursorCol: logC };
      }
      case "end": {
        // Move to end of visual line
        const [visRow] = logicalToVisual(layout, cursorRow, cursorCol);
        const visLineLen = Array.from(layout.visualLines[visRow] ?? "").length;
        const [logR, logC] = visualToLogical(layout, visRow, visLineLen);
        const clamped = Math.min(logC, lineLen(logR));
        return { ...s, cursorRow: logR, cursorCol: clamped };
      }
      case "wordLeft": {
        const newCol = findWordLeft(lines[cursorRow], cursorCol);
        if (newCol < cursorCol) return { ...s, cursorCol: newCol };
        // Jump to end of previous line
        if (cursorRow > 0) return { ...s, cursorRow: cursorRow - 1, cursorCol: lineLen(cursorRow - 1) };
        return s;
      }
      case "wordRight": {
        const newCol = findWordRight(lines[cursorRow], cursorCol);
        if (newCol > cursorCol) return { ...s, cursorCol: newCol };
        // Jump to start of next line
        if (cursorRow < lines.length - 1) return { ...s, cursorRow: cursorRow + 1, cursorCol: 0 };
        return s;
      }
      case "logicalHome":
        return { ...s, cursorCol: 0 };
      case "logicalEnd":
        return { ...s, cursorCol: lineLen(cursorRow) };
    }
  }, [layout]);

  const move = useCallback((dir: Direction) => {
    setState((s) => ({ ...moveLogical(s, dir), selectionAnchor: null }));
  }, [moveLogical]);

  const selectMove = useCallback((dir: Direction) => {
    setState((s) => {
      const anchor = s.selectionAnchor ?? [s.cursorRow, s.cursorCol];
      const moved = moveLogical(s, dir);
      return { ...moved, selectionAnchor: anchor };
    });
  }, [moveLogical]);

  const selectAll = useCallback(() => {
    setState((s) => {
      const lastRow = s.lines.length - 1;
      const lastCol = s.lines[lastRow].length;
      return { ...s, selectionAnchor: [0, 0], cursorRow: lastRow, cursorCol: lastCol };
    });
  }, []);

  const clearSelection = useCallback(() => {
    setState((s) => ({ ...s, selectionAnchor: null }));
  }, []);

  const setText = useCallback((text: string) => {
    const newLines = text.split("\n");
    if (newLines.length === 0) newLines.push("");
    const lastRow = newLines.length - 1;
    setState({
      lines: newLines,
      cursorRow: lastRow,
      cursorCol: newLines[lastRow].length,
      selectionAnchor: null,
    });
    lastSavedRef.current = text;
  }, []);

  const clear = useCallback(() => {
    setState({ lines: [""], cursorRow: 0, cursorCol: 0, selectionAnchor: null });
    undoStack.current = [];
    redoStack.current = [];
    lastSavedRef.current = "";
  }, []);

  const undo = useCallback(() => {
    setState((s) => {
      const entry = undoStack.current.pop();
      if (!entry) return s;
      redoStack.current.push({ lines: [...s.lines], cursorRow: s.cursorRow, cursorCol: s.cursorCol });
      lastSavedRef.current = entry.lines.join("\n");
      return { lines: entry.lines, cursorRow: entry.cursorRow, cursorCol: entry.cursorCol, selectionAnchor: null };
    });
  }, []);

  const redo = useCallback(() => {
    setState((s) => {
      const entry = redoStack.current.pop();
      if (!entry) return s;
      undoStack.current.push({ lines: [...s.lines], cursorRow: s.cursorRow, cursorCol: s.cursorCol });
      lastSavedRef.current = entry.lines.join("\n");
      return { lines: entry.lines, cursorRow: entry.cursorRow, cursorCol: entry.cursorCol, selectionAnchor: null };
    });
  }, []);

  const getText = useCallback(() => state.lines.join("\n"), [state.lines]);

  return {
    lines: state.lines,
    cursorRow: state.cursorRow,
    cursorCol: state.cursorCol,
    layout,
    visualCursor,
    scrollRow,
    selectionAnchor: state.selectionAnchor,
    getSelectionRange,
    getSelectedText,
    insert,
    backspace,
    deleteForward,
    newline,
    move,
    selectMove,
    selectAll,
    clearSelection,
    setText,
    clear,
    undo,
    redo,
    getText,
  };
}
