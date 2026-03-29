// =============================================================================
// Memory File View
//
// Displays a single workspace file in View mode (rendered markdown) or
// Edit mode (plain textarea). Auto-saves edits after 2s idle.
// =============================================================================

import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useSocketStore } from "../store/socket-store";

interface Props {
  path: string;
  editable: boolean;
  onBack: () => void;
}

type SaveStatus = "idle" | "saving" | "saved" | "error";

export function MemoryFileView({ path, editable, onBack }: Props) {
  const [content, setContent] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [loading, setLoading] = useState(true);
  const rpc = useSocketStore((s) => s.rpc);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  // Load file content — cancellation guard prevents stale responses from
  // overwriting content when the user switches files quickly.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setContent(null);
    setEditing(false);
    setSaveStatus("idle");

    void (async () => {
      try {
        const result = (await rpc("workspace.read", { path })) as {
          content: string;
          editable: boolean;
        };
        if (cancelled) return;
        setContent(result.content);
        setDraft(result.content);
      } catch {
        if (cancelled) return;
        setContent(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [path, rpc]);

  // Auto-grow textarea
  const adjustHeight = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  useEffect(() => {
    if (editing) {
      // Adjust height after React renders the textarea
      setTimeout(adjustHeight, 0);
    }
  }, [editing, adjustHeight]);

  // Save function — guarded against unmount to avoid React warnings.
  // Re-throws on failure so callers (handleBack) can detect errors.
  const save = useCallback(async (text: string): Promise<boolean> => {
    if (mountedRef.current) setSaveStatus("saving");
    try {
      await rpc("workspace.write", { path, content: text });
      if (!mountedRef.current) return true;
      setContent(text);
      setSaveStatus("saved");
      setTimeout(() => { if (mountedRef.current) setSaveStatus("idle"); }, 2000);
      return true;
    } catch {
      if (mountedRef.current) setSaveStatus("error");
      return false;
    }
  }, [path, rpc]);

  // Auto-save with debounce
  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const text = e.target.value;
    setDraft(text);
    setSaveStatus("idle");
    setTimeout(adjustHeight, 0);

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      void save(text);
    }, 2000);
  }, [save, adjustHeight]);

  // Save on blur
  const handleBlur = useCallback(() => {
    if (draft !== content) {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      void save(draft);
    }
  }, [draft, content, save]);

  // Enter edit mode
  const startEditing = useCallback(() => {
    setDraft(content ?? "");
    setEditing(true);
    setSaveStatus("idle");
  }, [content]);

  // Exit edit mode (Preview button) — save first, then switch to preview.
  // Content is updated only after save succeeds, so preview shows persisted state.
  const stopEditing = useCallback(async () => {
    if (draft !== content) {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const ok = await save(draft);
      if (!ok) return; // Save failed — stay in edit mode
    }
    setEditing(false);
  }, [draft, content, save]);

  // Back navigation — save unsaved changes before leaving.
  // If save fails, stay on the page so the user doesn't lose edits.
  const handleBack = useCallback(async () => {
    if (editing && draft !== content) {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      const ok = await save(draft);
      if (!ok) return; // Save failed — stay on page
    }
    onBack();
  }, [editing, draft, content, save, onBack]);

  const fileName = path.includes("/") ? path.split("/").pop() : path;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <header className="flex items-center gap-2 border-b border-border dark:border-border-dark px-4 py-3 shrink-0">
        <button
          onClick={handleBack}
          className="p-1 -ml-1 rounded-md hover:bg-gray-100 dark:hover:bg-gray-800"
          aria-label="Back to file list"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        <h2 className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex-1 truncate">
          {fileName}
          {!editable && <span className="ml-2 text-xs font-normal text-gray-400">read-only</span>}
        </h2>

        {/* Save status */}
        {editing && saveStatus !== "idle" && (
          <span className={`text-xs ${
            saveStatus === "saving" ? "text-gray-400 animate-pulse" :
            saveStatus === "saved" ? "text-green-500" :
            "text-red-500"
          }`}>
            {saveStatus === "saving" ? "Saving..." : saveStatus === "saved" ? "Saved" : "Error"}
          </span>
        )}

        {/* Edit/Preview toggle */}
        {editable && !loading && content !== null && (
          <button
            onClick={editing ? stopEditing : startEditing}
            className="text-sm text-stone-700 dark:text-stone-300 hover:underline"
          >
            {editing ? "Preview" : "Edit"}
          </button>
        )}
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-gray-400">
            Loading...
          </div>
        ) : content === null ? (
          <div className="flex items-center justify-center h-32 text-gray-400">
            File not found
          </div>
        ) : editing ? (
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={handleChange}
            onBlur={handleBlur}
            className="w-full min-h-full p-4 bg-transparent text-sm font-mono text-gray-800 dark:text-gray-200 outline-none resize-none"
            spellCheck={false}
            autoFocus
          />
        ) : (
          <div className="p-4 markdown-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
