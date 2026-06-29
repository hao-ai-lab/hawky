import { useState, useCallback, useRef, useEffect, useMemo } from "react";
import { useSessionStore } from "../store/session-store";
import { useSocketStore } from "../store/socket-store";
import { SlashMenu } from "./SlashMenu";
import {
  isSlashInput, parseSlash, filterCommands, dispatchSlash,
  type SlashCommand, type SlashView,
} from "../lib/slash-commands";

const MAX_IMAGE_DIMENSION = 1920; // Resize to fit within this (matches node screenshot)
const MAX_RESIZED_BYTES = 3 * 1024 * 1024; // 3MB after resize (matches gateway ingress)
const ACCEPTED_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

// PDFs are the only document type Anthropic's API natively reads.
// Per-file cap here is client-side UX — gateway enforces the real 20MB limit.
const ACCEPTED_DOCUMENT_TYPES = ["application/pdf"];
const MAX_DOCUMENT_RAW_BYTES = 20 * 1024 * 1024; // 20MB per PDF
const MAX_DOCUMENTS_PER_TURN = 3;

/**
 * Detect touch-primary devices (phones, tablets). On these devices the Enter
 * key inserts a newline and users must tap the send button — matches iOS
 * chat-app conventions (iMessage, WhatsApp, Slack). Desktop users keep the
 * Enter-to-send shortcut. Evaluated per keydown so tests can stub matchMedia.
 */
function isTouchDevice(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(hover: none) and (pointer: coarse)").matches;
}

/**
 * Resize an image to fit within MAX_IMAGE_DIMENSION and recompress as JPEG.
 * Returns { base64, media_type } ready for the API.
 */
function resizeImage(dataUrl: string): Promise<{ base64: string; media_type: string; preview: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      // Scale down if either dimension exceeds the max
      if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
        const scale = MAX_IMAGE_DIMENSION / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { reject(new Error("Canvas not supported")); return; }
      ctx.drawImage(img, 0, 0, width, height);

      // Try JPEG at decreasing quality until under size limit
      for (const quality of [0.85, 0.7, 0.5, 0.3]) {
        const jpeg = canvas.toDataURL("image/jpeg", quality);
        const base64 = jpeg.split(",")[1];
        const rawBytes = Math.round(base64.length * 0.75);
        if (rawBytes <= MAX_RESIZED_BYTES) {
          resolve({ base64, media_type: "image/jpeg", preview: jpeg });
          return;
        }
      }
      // Last resort — lowest quality
      const jpeg = canvas.toDataURL("image/jpeg", 0.2);
      const base64 = jpeg.split(",")[1];
      const finalBytes = Math.round(base64.length * 0.75);
      if (finalBytes > MAX_RESIZED_BYTES) {
        reject(new Error(`Image still too large after resize (${(finalBytes / 1024 / 1024).toFixed(1)}MB). Try a smaller image.`));
        return;
      }
      resolve({ base64, media_type: "image/jpeg", preview: jpeg });
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = dataUrl;
  });
}

// Input history — persisted in localStorage
const HISTORY_KEY = "hawky:inputHistory";
const MAX_HISTORY = 100;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === "string" && e.length > 0);
  } catch { return []; }
}

function saveHistory(history: string[]): void {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-MAX_HISTORY)));
  } catch {}
}

export interface ImageAttachment {
  id: string;
  base64: string;
  media_type: string;
  /** Data URL for thumbnail preview */
  preview: string;
  name: string;
}

export interface DocumentAttachment {
  id: string;
  base64: string;
  media_type: string;
  name: string;
  /** Raw file size in bytes — used for the pill label and pre-upload cap check. */
  sizeBytes: number;
}

let nextAttId = 0;

export interface InputBarProps {
  /** Switch the top-level web view (used by /memory, /status, /settings slash commands). */
  setView?: (view: SlashView) => void;
}

export function InputBar({ setView }: InputBarProps = {}) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<ImageAttachment[]>([]);
  const [documents, setDocuments] = useState<DocumentAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /** Count of PDF FileReaders started but not yet committed to `documents`.
   *  Without this, two rapid batches can each read up to the cap
   *  independently, and the second batch's overflow gets silently dropped
   *  instead of producing a user-visible error. */
  const pendingDocReadsRef = useRef(0);
  /** Generation counter. Bumped on send or manual removal so any in-flight
   *  FileReader that finishes *after* state was cleared does not attach its
   *  PDF to the next message. Each reader captures the generation at start
   *  and only commits if still current. */
  const docGenRef = useRef(0);
  const sendMessage = useSessionStore((s) => s.sendMessage);
  const cancelAgent = useSessionStore((s) => s.cancelAgent);
  const agentStatus = useSessionStore((s) => s.agentStatus);
  const activeKey = useSessionStore((s) => s.activeKey);
  const loading = useSessionStore((s) => s.loading);
  const connectionStatus = useSocketStore((s) => s.status);

  // Input history state
  const historyRef = useRef<string[]>(loadHistory());
  const historyIndexRef = useRef(-1); // -1 = not navigating
  const draftRef = useRef("");

  const rpc = useSocketStore((s) => s.rpc);
  const [sessionEffort, setSessionEffort] = useState("medium");
  const [showEffortMenu, setShowEffortMenu] = useState(false);

  // Fetch session effort on mount and when session changes
  useEffect(() => {
    if (connectionStatus !== "connected") return;
    let active = true;
    (async () => {
      try {
        const e = await rpc("config.effort", { sessionKey: activeKey }) as { effort: string };
        if (active) setSessionEffort(e.effort ?? "medium");
      } catch {}
    })();
    return () => { active = false; };
  }, [connectionStatus, activeKey, rpc]);

  // Close menu on click outside
  useEffect(() => {
    if (!showEffortMenu) return;
    const close = () => setShowEffortMenu(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [showEffortMenu]);

  const selectEffort = async (level: string) => {
    setSessionEffort(level);
    setShowEffortMenu(false);
    try { await rpc("config.effort", { effort: level, sessionKey: activeKey }); } catch {}
  };

  // ─── Slash-command menu state ──────────────────────────────────────────
  const addSystemMessage = useSessionStore((s) => s.addSystemMessage);
  const sendChatMessage = useSessionStore((s) => s.sendMessage);
  const showSlashMenu = isSlashInput(text);
  const slashCommands = useMemo<SlashCommand[]>(
    () => showSlashMenu ? filterCommands(text) : [],
    [text, showSlashMenu],
  );
  const [slashIdx, setSlashIdx] = useState(0);
  // Keep selection in range as the filter shrinks
  useEffect(() => {
    if (slashIdx >= slashCommands.length) setSlashIdx(0);
  }, [slashCommands.length, slashIdx]);

  /** Run a slash command and clear the input. */
  const runSlash = useCallback(async (rawText: string) => {
    const parsed = parseSlash(rawText);
    if (!parsed) return false;
    setText("");
    setTimeout(() => { if (inputRef.current) inputRef.current.style.height = "auto"; }, 0);
    await dispatchSlash(parsed, {
      rpc: rpc as any,
      sessionKey: activeKey,
      setView: setView ?? (() => {}),
      addSystemMessage,
      sendChatMessage: (t) => { void sendChatMessage(t); },
    });
    return true;
  }, [rpc, activeKey, setView, addSystemMessage, sendChatMessage]);

  /** Autocomplete from the highlighted menu row — fills the textarea but
   *  keeps the menu open so the user can append args. */
  const autocompleteSlash = useCallback((cmd: SlashCommand) => {
    setText(`/${cmd.name} `);
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  // Heartbeat is the only truly read-only session — singleton, no chat
  // affordance. Cron sessions are now first-class chattable threads: the
  // scheduled run opens the conversation, the user can reply right under it.
  const isReadOnlySession = activeKey.startsWith("heartbeat:");
  // Kept under the old name for the few places downstream that branch on
  // "anything not a regular user session" (icons, attachment UX). Cron still
  // shows the 🕐 visual treatment in headers; the input itself is enabled.
  const isSystem = isReadOnlySession;
  const isBusy = agentStatus === "thinking" || agentStatus === "streaming";
  const isCompacting = agentStatus === "compacting";
  const isDisabled = isBusy || isCompacting || loading || connectionStatus !== "connected";

  // Auto-focus input when agent finishes (idle after busy)
  const prevBusy = useRef(false);
  useEffect(() => {
    if (prevBusy.current && !isBusy && !isCompacting) {
      inputRef.current?.focus();
    }
    prevBusy.current = isBusy || isCompacting;
  }, [isBusy, isCompacting]);

  // Shift+Esc → focus input from anywhere on page
  useEffect(() => {
    function handleGlobalKey(e: KeyboardEvent) {
      if (e.key === "Escape" && e.shiftKey) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener("keydown", handleGlobalKey);
    return () => document.removeEventListener("keydown", handleGlobalKey);
  }, []);

  const adjustHeight = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, []);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setText(val);
    setTimeout(adjustHeight, 0);

    // Exit history navigation on any edit — user is now typing fresh text
    if (historyIndexRef.current !== -1) {
      historyIndexRef.current = -1;
      draftRef.current = "";
    }
  }, [adjustHeight]);

  // Process files into attachments — images are auto-resized, PDFs go as-is
  const processFiles = useCallback((files: FileList | File[]) => {
    setError(null);
    const fileArr = Array.from(files);

    // Pre-scan PDFs so we can enforce the per-turn cap SYNCHRONOUSLY.
    // FileReader callbacks race and react batches, so a purely async check
    // (inside reader.onload) drops silent overflow. We count committed PDFs
    // AND any that are currently mid-read, so two rapid batches cannot both
    // slip under the cap independently.
    const existingDocCount = documents.length + pendingDocReadsRef.current;
    const incomingPdfs = fileArr.filter((f) => ACCEPTED_DOCUMENT_TYPES.includes(f.type));
    const pdfCapacity = Math.max(0, MAX_DOCUMENTS_PER_TURN - existingDocCount);
    const acceptedPdfs = new Set<File>(incomingPdfs.slice(0, pdfCapacity));
    if (incomingPdfs.length > pdfCapacity) {
      setError(`Max ${MAX_DOCUMENTS_PER_TURN} PDFs per message.`);
    }

    for (const file of fileArr) {
      if (ACCEPTED_DOCUMENT_TYPES.includes(file.type)) {
        if (!acceptedPdfs.has(file)) continue; // dropped by cap above
        // PDF path — no resize, cap-check then base64 encode
        if (file.size > MAX_DOCUMENT_RAW_BYTES) {
          setError(`PDF too large: ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB). Max ${MAX_DOCUMENT_RAW_BYTES / 1024 / 1024} MB.`);
          continue;
        }
        const reader = new FileReader();
        pendingDocReadsRef.current++;
        const startedGen = docGenRef.current;
        const finish = () => { pendingDocReadsRef.current = Math.max(0, pendingDocReadsRef.current - 1); };
        reader.onload = () => {
          try {
            // Abandon the result if the composer was cleared (send/remove)
            // while we were still reading — this PDF is no longer relevant.
            if (docGenRef.current !== startedGen) return;
            const dataUrl = reader.result as string;
            const base64 = dataUrl.includes(",") ? dataUrl.split(",")[1] : dataUrl;
            setDocuments((prev) => {
              if (prev.length >= MAX_DOCUMENTS_PER_TURN) return prev;
              return [
                ...prev,
                {
                  id: `doc-${++nextAttId}`,
                  base64,
                  media_type: "application/pdf",
                  name: file.name,
                  sizeBytes: file.size,
                },
              ];
            });
          } finally { finish(); }
        };
        reader.onerror = () => {
          if (docGenRef.current === startedGen) setError(`Failed to read ${file.name}.`);
          finish();
        };
        reader.readAsDataURL(file);
        continue;
      }
      if (!ACCEPTED_TYPES.includes(file.type)) {
        setError(`Unsupported format: ${file.type || file.name}. Use PNG, JPEG, GIF, WebP, or PDF.`);
        continue;
      }
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        try {
          // Resize to max 1920px and recompress as JPEG
          const { base64, media_type, preview } = await resizeImage(dataUrl);
          setAttachments((prev) => [
            ...prev,
            {
              id: `att-${++nextAttId}`,
              base64,
              media_type,
              preview,
              name: file.name,
            },
          ]);
        } catch {
          setError(`Failed to process ${file.name}.`);
        }
      };
      reader.readAsDataURL(file);
    }
  }, [documents.length]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const removeDocument = useCallback((id: string) => {
    setDocuments((prev) => prev.filter((d) => d.id !== id));
  }, []);

  // File picker
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) processFiles(e.target.files);
    e.target.value = ""; // Reset so same file can be re-selected
  }, [processFiles]);

  // Drag-and-drop
  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    if (e.dataTransfer.files.length > 0) {
      processFiles(e.dataTransfer.files);
    }
  }, [processFiles]);

  // Clipboard paste — images and PDFs
  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.type.startsWith("image/") || item.type === "application/pdf") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault(); // Don't paste binary as text
      processFiles(files);
    }
  }, [processFiles]);

  const handleSend = useCallback(() => {
    const trimmed = text.trim();
    if ((!trimmed && attachments.length === 0 && documents.length === 0) || isDisabled) return;

    // Slash-command interception — runs locally instead of sending to the
    // agent. Image and PDF attachments are ignored when the command starts
    // with `/`.
    if (parseSlash(trimmed)) {
      const history = historyRef.current;
      if (history[history.length - 1] !== trimmed) {
        history.push(trimmed);
        saveHistory(history);
      }
      historyIndexRef.current = -1;
      draftRef.current = "";
      void runSlash(trimmed);
      return;
    }

    const atts = attachments.length > 0
      ? attachments.map((a) => ({ base64: a.base64, media_type: a.media_type }))
      : undefined;
    const docs = documents.length > 0
      ? documents.map((d) => ({ base64: d.base64, media_type: d.media_type, filename: d.name }))
      : undefined;

    // Save to input history
    if (trimmed) {
      const history = historyRef.current;
      if (history[history.length - 1] !== trimmed) {
        history.push(trimmed);
        saveHistory(history);
      }
    }
    historyIndexRef.current = -1;
    draftRef.current = "";

    // Choose a default placeholder based on what's attached
    const placeholder = atts && !docs
      ? "(image attached)"
      : docs && !atts
        ? "(PDF attached)"
        : "(attachments)";

    // Bump the doc generation so any in-flight FileReader that resolves
    // after this send doesn't leak its PDF onto the next composer. Also
    // reset the pending-reads counter — abandoned readers will no-op on
    // their decrement (clamped to 0) and shouldn't inflate the next
    // message's synchronous cap check.
    docGenRef.current++;
    pendingDocReadsRef.current = 0;

    setText("");
    setAttachments([]);
    setDocuments([]);
    setError(null);
    void sendMessage(trimmed || placeholder, atts, docs);
    setTimeout(() => {
      if (inputRef.current) inputRef.current.style.height = "auto";
      inputRef.current?.focus();
    }, 0);
  }, [text, attachments, documents, isDisabled, sendMessage, runSlash]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const el = inputRef.current;

      // IME composition guard — don't submit during CJK input
      if (e.nativeEvent.isComposing || (e.nativeEvent as any).keyCode === 229) return;

      // Slash-menu navigation takes precedence over history/Enter handling.
      if (showSlashMenu && slashCommands.length > 0) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          setSlashIdx((i) => Math.min(i + 1, slashCommands.length - 1));
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          setSlashIdx((i) => Math.max(i - 1, 0));
          return;
        }
        if (e.key === "Tab") {
          e.preventDefault();
          autocompleteSlash(slashCommands[slashIdx]);
          return;
        }
        if (e.key === "Escape") {
          e.preventDefault();
          // Clearing the slash hides the menu without losing whatever user typed.
          setText("");
          return;
        }
        // Enter: if the textarea contains exactly "/<name>" with no args,
        // autocomplete and let the user add args. If it already has args
        // (or matches a complete command name), fall through to Enter=send.
        if (e.key === "Enter" && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
          const trimmed = text.trim();
          const hasArgs = /\s/.test(trimmed);
          const exactMatch = slashCommands.some((c) => `/${c.name}` === trimmed);
          if (!hasArgs && !exactMatch) {
            e.preventDefault();
            autocompleteSlash(slashCommands[slashIdx]);
            return;
          }
          // else: fall through and let the Enter=send block run.
        }
      }

      // Enter key handling:
      //   Desktop: Enter=send, Shift+Enter=newline
      //   Touch (phone/tablet): Enter=newline (standard iOS chat UX — user
      //     taps the send button). Cmd/Ctrl+Enter still sends as a shortcut
      //     for external-keyboard users.
      if (e.key === "Enter") {
        const modifierSend = e.metaKey || e.ctrlKey;
        if (modifierSend) {
          e.preventDefault();
          handleSend();
          return;
        }
        if (!isTouchDevice() && !e.shiftKey) {
          e.preventDefault();
          handleSend();
          return;
        }
        // Touch device without modifiers, or desktop with Shift — fall through
        // so the browser inserts a newline.
      }

      if (!el) return;

      // Up arrow → input history (only when cursor is on the first visual row)
      if (e.key === "ArrowUp" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const pos = el.selectionStart;
        const beforeCursor = el.value.slice(0, pos);
        const hasLogicalNewline = beforeCursor.includes("\n");
        // Check if cursor is on the first visual row by comparing scroll position
        // If el.scrollTop > 0, there are rows above — don't trigger history
        // If there are newlines before cursor, cursor is below first line
        const isFirstVisualRow = !hasLogicalNewline && el.scrollTop === 0;
        if (isFirstVisualRow) {
          const history = historyRef.current;
          if (history.length === 0) return;
          e.preventDefault();
          if (historyIndexRef.current === -1) {
            draftRef.current = text;
            historyIndexRef.current = history.length - 1;
          } else if (historyIndexRef.current > 0) {
            historyIndexRef.current--;
          }
          setText(history[historyIndexRef.current]);
          setTimeout(adjustHeight, 0);
          return;
        }
      }

      // Down arrow → input history forward (when cursor on last line)
      if (e.key === "ArrowDown" && !e.shiftKey && !e.ctrlKey && !e.metaKey) {
        if (historyIndexRef.current === -1) return; // not navigating, let browser handle
        const pos = el.selectionEnd;
        const afterCursor = el.value.slice(pos);
        const isLastLine = !afterCursor.includes("\n");
        if (isLastLine) {
          e.preventDefault();
          const history = historyRef.current;
          if (historyIndexRef.current < history.length - 1) {
            historyIndexRef.current++;
            setText(history[historyIndexRef.current]);
          } else {
            historyIndexRef.current = -1;
            setText(draftRef.current);
          }
          setTimeout(adjustHeight, 0);
          return;
        }
      }

      // Ctrl+J → insert newline (matches TUI behavior)
      if (e.key === "j" && e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const pos = el.selectionStart;
        const before = text.slice(0, pos);
        const after = text.slice(el.selectionEnd);
        setText(before + "\n" + after);
        setTimeout(() => {
          el.selectionStart = el.selectionEnd = pos + 1;
          adjustHeight();
          // Scroll textarea so cursor is visible after newline insertion
          el.scrollTop = el.scrollHeight;
        }, 0);
        return;
      }

      // Home → move cursor to start of current line
      if (e.key === "Home" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const pos = el.selectionStart;
        const text = el.value;
        const lineStart = text.lastIndexOf("\n", pos - 1) + 1;
        if (e.shiftKey) {
          el.setSelectionRange(el.selectionEnd, lineStart, "backward");
        } else {
          el.setSelectionRange(lineStart, lineStart);
        }
        return;
      }

      // End → move cursor to end of current line
      if (e.key === "End" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        const pos = el.selectionStart;
        const text = el.value;
        let lineEnd = text.indexOf("\n", pos);
        if (lineEnd === -1) lineEnd = text.length;
        if (e.shiftKey) {
          el.setSelectionRange(el.selectionStart, lineEnd);
        } else {
          el.setSelectionRange(lineEnd, lineEnd);
        }
        return;
      }

      // Ctrl+Left → jump to previous word boundary
      if (e.key === "ArrowLeft" && e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const pos = el.selectionStart;
        const text = el.value;
        let i = pos - 1;
        // Skip whitespace/punctuation backward
        while (i > 0 && !/\w/.test(text[i])) i--;
        // Skip word chars backward
        while (i > 0 && /\w/.test(text[i - 1])) i--;
        if (e.shiftKey) {
          el.setSelectionRange(el.selectionEnd, i, "backward");
        } else {
          el.setSelectionRange(i, i);
        }
        return;
      }

      // Ctrl+Right → jump to next word boundary
      if (e.key === "ArrowRight" && e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const pos = el.selectionEnd;
        const text = el.value;
        let i = pos;
        // Skip word chars forward
        while (i < text.length && /\w/.test(text[i])) i++;
        // Skip whitespace/punctuation forward
        while (i < text.length && !/\w/.test(text[i])) i++;
        if (e.shiftKey) {
          el.setSelectionRange(el.selectionStart, i);
        } else {
          el.setSelectionRange(i, i);
        }
        return;
      }
    },
    [handleSend, text, adjustHeight, showSlashMenu, slashCommands, slashIdx, autocompleteSlash],
  );

  if (isSystem) {
    return (
      <div className="px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <div className="max-w-3xl mx-auto">
          <p className="text-center text-xs text-muted dark:text-muted-dark">
            System session — read only. Switch to a channel to chat.
          </p>
        </div>
      </div>
    );
  }

  // Cron sessions get a small contextual hint in the placeholder so the
  // first-time user understands they're replying inside a scheduled job's
  // thread, not starting a fresh chat. Heartbeat already returned above.
  const cronJobName = activeKey.startsWith("cron:") ? activeKey.slice(5) : null;
  const placeholder = connectionStatus !== "connected"
    ? "Connecting..."
    : isCompacting
      ? "Compacting context..."
      : isBusy
        ? "Agent working..."
        : cronJobName
          ? `Reply in 🕐 ${cronJobName}...`
          : "Message Hawky...";

  const hasContent = text.trim() || attachments.length > 0 || documents.length > 0;

  return (
    <div className="px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
      <div className="max-w-3xl mx-auto">
        {/* Error message */}
        {error && (
          <div className="mb-2 text-xs text-stone-500 dark:text-stone-400">
            {error}
          </div>
        )}

        <div
          className={`relative rounded-2xl border shadow-sm transition-all duration-200 ${
            dragOver
              ? "border-stone-500 dark:border-stone-400 bg-stone-50 dark:bg-stone-750"
              : "border-stone-300/60 dark:border-stone-600/40 bg-white dark:bg-stone-800 focus-within:border-stone-400 dark:focus-within:border-stone-500"
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {showSlashMenu && (
            <SlashMenu
              commands={slashCommands}
              selectedIndex={slashIdx}
              onSelect={autocompleteSlash}
              onHover={setSlashIdx}
            />
          )}
          {/* Attachment preview row */}
          {(attachments.length > 0 || documents.length > 0) && (
            <div className="flex gap-2 px-4 pt-3 pb-1 overflow-x-auto" data-testid="attachment-previews">
              {attachments.map((att) => (
                <div key={att.id} className="relative shrink-0 group">
                  <img
                    src={att.preview}
                    alt={att.name}
                    className="w-16 h-16 rounded-lg object-cover border border-stone-200 dark:border-stone-600"
                  />
                  <button
                    onClick={() => removeAttachment(att.id)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-stone-700 dark:bg-stone-300 text-white dark:text-stone-800 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label={`Remove ${att.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
              {documents.map((doc) => (
                <div
                  key={doc.id}
                  className="relative shrink-0 group flex items-center gap-2 px-3 h-16 rounded-lg border border-stone-200 dark:border-stone-600 bg-stone-50/80 dark:bg-stone-900/40"
                  data-testid="document-attachment"
                >
                  <span className="text-xl" aria-hidden="true">📄</span>
                  <span className="flex flex-col leading-tight">
                    <span className="text-sm text-stone-700 dark:text-stone-200 max-w-[160px] truncate">{doc.name}</span>
                    <span className="text-xs text-stone-500 dark:text-stone-400">
                      {doc.sizeBytes < 1024 * 1024
                        ? `${Math.round(doc.sizeBytes / 1024)} KB`
                        : `${(doc.sizeBytes / 1024 / 1024).toFixed(1)} MB`}
                    </span>
                  </span>
                  <button
                    onClick={() => removeDocument(doc.id)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-stone-700 dark:bg-stone-300 text-white dark:text-stone-800 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                    aria-label={`Remove ${doc.name}`}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* Drag overlay */}
          {dragOver && (
            <div className="px-4 py-3 text-center text-sm text-stone-500 dark:text-stone-400">
              Drop images or PDFs here
            </div>
          )}

          {/* Textarea — full width on top */}
          <div className="px-4 pt-3 pb-1">
            <textarea
              ref={inputRef}
              value={text}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={placeholder}
              disabled={isDisabled}
              rows={1}
              className="w-full resize-none bg-transparent text-body outline-none placeholder:text-muted dark:placeholder:text-muted-dark disabled:opacity-50 max-h-40 overflow-y-auto"
              style={{
                minHeight: "28px",
                fontSize: "16px",
                lineHeight: "1.5",
                // iOS needs these for native momentum scrolling inside a textarea
                // whose height is clamped by max-h. Without them Safari ignores
                // overflow-y:auto once the element is at its max height.
                WebkitOverflowScrolling: "touch",
                touchAction: "pan-y",
              }}
            />
          </div>

          {/* Toolbar row — attach left, effort + send right */}
          <div className="flex items-center justify-between px-3 pb-2">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isDisabled}
              className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors disabled:opacity-30"
              title="Attach image"
              data-testid="attach-button"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
              </svg>
            </button>

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,application/pdf"
              multiple
              onChange={handleFileSelect}
              className="hidden"
              data-testid="file-input"
            />

            {/* Right side: effort pill + send/stop button */}
            <div className="flex items-center gap-2">
              {/* Effort level dropdown — Claude.ai "Opus 4.6 Extended" style */}
              {!isSystem && (
                <div className="relative">
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowEffortMenu(!showEffortMenu); }}
                    disabled={isDisabled}
                    className="flex items-center gap-1.5 px-3.5 py-2 text-[13px] rounded-full bg-stone-100 dark:bg-stone-700 text-stone-600 dark:text-stone-300 hover:bg-stone-200 dark:hover:bg-stone-600 transition-colors disabled:opacity-30"
                  >
                    {sessionEffort}
                    <svg className="w-3.5 h-3.5 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {showEffortMenu && (
                    <div className="absolute bottom-full mb-1.5 right-0 rounded-xl border border-stone-200 dark:border-stone-600 bg-white dark:bg-stone-800 shadow-lg py-1.5 z-50 min-w-[140px]"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {["low", "medium", "high", "xhigh", "max"].map((level) => (
                        <button
                          key={level}
                          onClick={() => selectEffort(level)}
                          className={`w-full flex items-center justify-between px-3.5 py-2.5 text-[13px] transition-colors ${
                            sessionEffort === level
                              ? "text-stone-800 dark:text-stone-100 font-medium"
                              : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-700"
                          }`}
                        >
                          {level}
                          {sessionEffort === level && (
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                          )}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {isBusy ? (
                <button
                  onClick={cancelAgent}
                  className="shrink-0 w-10 h-10 rounded-full bg-red-500 text-white flex items-center justify-center hover:bg-red-600 transition-colors"
                  title="Stop"
                >
                  <svg className="w-3.5 h-3.5" fill="currentColor" viewBox="0 0 24 24">
                    <rect x="6" y="6" width="12" height="12" rx="1" />
                  </svg>
                </button>
              ) : (
                <button
                  onClick={handleSend}
                  disabled={connectionStatus !== "connected" || !hasContent}
                  className="shrink-0 w-10 h-10 rounded-full bg-stone-800 dark:bg-stone-200 text-white dark:text-stone-800 flex items-center justify-center hover:opacity-80 disabled:opacity-20 transition-opacity"
                  title="Send"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h14M12 5l7 7-7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
