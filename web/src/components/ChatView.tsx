import { useEffect, useLayoutEffect, useRef, useState, useCallback } from "react";
import { useSessionStore, type SessionMessage, type AgentStatus, type NotificationItem } from "../store/session-store";
import { useSocketStore } from "../store/socket-store";
import { ToolStep } from "./ToolStep";
import type { ToolLineData } from "./ToolLine";
import { Markdown } from "./Markdown";
import { NotificationCard } from "./NotificationCard";
import { PermissionDialog } from "./PermissionDialog";
import { AskUserDialog } from "./AskUserDialog";
import { exportSessionAsHtml } from "../lib/export-html";

// -----------------------------------------------------------------------------
// Formatting helpers
// -----------------------------------------------------------------------------

// Stable empty reference so the zustand selector doesn't return a new array
// on every render (would otherwise trigger React's "infinite loop" warning).
const EMPTY_NOTIFICATIONS: readonly NotificationItem[] = Object.freeze([]);

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatCostDisplay(usd: number): string {
  if (usd < 0.005) return "$0.00";
  return `$${usd.toFixed(2)}`;
}

// -----------------------------------------------------------------------------
// Action button — small icon with hover tooltip (Claude.ai end-of-response pattern)
// -----------------------------------------------------------------------------

function ActionButton({ label, onClick, icon }: {
  label: string;
  onClick: () => void;
  icon: React.ReactNode;
}) {
  const [showTip, setShowTip] = useState(false);
  return (
    <div className="relative" onMouseEnter={() => setShowTip(true)} onMouseLeave={() => setShowTip(false)}>
      <button
        onClick={onClick}
        className="p-2 rounded-lg text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
        aria-label={label}
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">{icon}</svg>
      </button>
      {showTip && (
        <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-1 px-2 py-1 rounded-md bg-stone-800 dark:bg-stone-200 text-white dark:text-stone-800 text-xs whitespace-nowrap shadow-md z-50">
          {label}
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Timestamp formatting — shown on hover (Claude.ai pattern)
// -----------------------------------------------------------------------------

function formatTimestamp(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return "";
  const now = new Date();
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (diffDays === 0) return time;
  if (diffDays < 7) return `${d.toLocaleDateString([], { weekday: "short" })} ${time}`;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}

// -----------------------------------------------------------------------------
// Message rendering — no bubble for assistant (Claude.ai/ChatGPT pattern)
// -----------------------------------------------------------------------------

const COPY_ICON = <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />;
const CHECK_ICON = <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M5 13l4 4L19 7" />;
// Pencil icon for the edit-message affordance on user bubbles.
const PENCIL_ICON = <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />;

/** Inline "edit message" affordance. Hidden on desktop until hover,
 *  always visible on touch devices (matches CopyButton's pattern). */
function EditButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`p-1 rounded transition-colors
        text-stone-400/0 group-hover:text-stone-400
        dark:text-stone-500/0 dark:group-hover:text-stone-500
        hover:!text-stone-600 dark:hover:!text-stone-400
        hover:bg-stone-100 dark:hover:bg-stone-800
        [@media(hover:none)]:text-stone-400 [@media(hover:none)]:dark:text-stone-500`}
      aria-label="Edit and resend"
      title="Edit and resend"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        {PENCIL_ICON}
      </svg>
    </button>
  );
}

/** Small inline copy button. Hidden on desktop (appears on hover via group-hover),
 *  always visible on touch devices (no hover capability). */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API failed (insecure origin, denied permission, etc.)
    }
  };
  return (
    <button
      onClick={handleCopy}
      className={`p-1 rounded transition-colors
        text-stone-400/0 group-hover:text-stone-400
        dark:text-stone-500/0 dark:group-hover:text-stone-500
        hover:!text-stone-600 dark:hover:!text-stone-400
        hover:bg-stone-100 dark:hover:bg-stone-800
        [@media(hover:none)]:text-stone-400 [@media(hover:none)]:dark:text-stone-500`}
      aria-label="Copy"
    >
      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        {copied ? CHECK_ICON : COPY_ICON}
      </svg>
    </button>
  );
}

/** True if the message's content is a synthetic attachment placeholder
 *  (e.g. "(image attached)" when msg.images is the only real payload).
 *  Used to skip the edit affordance — there's no original text to edit. */
function isAttachmentPlaceholderMessage(msg: SessionMessage): boolean {
  if (typeof msg.content !== "string") return false;
  const hasImages = (msg.images && msg.images.length > 0) ?? false;
  const hasDocs = (msg.documents && msg.documents.length > 0) ?? false;
  if (msg.content === "(image attached)" && hasImages) return true;
  if (msg.content === "(PDF attached)" && hasDocs) return true;
  if (msg.content === "(attachments)" && (hasImages || hasDocs)) return true;
  return false;
}

function MessageBubble({ msg, isLastAssistant, agentStatus }: {
  msg: SessionMessage;
  isLastAssistant: boolean;
  agentStatus: AgentStatus;
}) {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState("");
  const rewindAndSend = useSessionStore((s) => s.rewindAndSend);

  // Tool messages are no longer rendered individually here — the parent
  // message list groups consecutive tools into a ToolStep. If one slips
  // through (unexpected), render nothing rather than duplicating.
  if (msg.role === "tool") return null;

  const isUser = msg.role === "user";
  const isSystem = msg.role === "system";
  const isStreaming = isLastAssistant && agentStatus === "streaming";

  // User message — right-aligned warm beige pill (Claude.ai style)
  if (isUser) {
    const ts = formatTimestamp(msg.timestamp);
    // `canEdit` gates the pencil affordance. Enabled when the message
    // has a backendIndex (i.e. it came from session.history, NOT a
    // just-typed optimistic bubble awaiting confirmation) and isn't an
    // attachment-only placeholder. Using the absolute backend index
    // means we don't care whether history is paginated — every loaded
    // user message carries its own true position.
    const hasAttachments = (msg.images && msg.images.length > 0) || (msg.documents && msg.documents.length > 0);
    const content = typeof msg.content === "string" ? msg.content : "";
    const isPlaceholderBubble = isAttachmentPlaceholderMessage(msg);
    const canEdit =
      typeof msg.backendIndex === "number" &&
      !isPlaceholderBubble;

    const enterEditMode = () => {
      setEditText(content);
      setIsEditing(true);
    };
    const commitEdit = () => {
      const trimmed = editText.trim();
      if (!trimmed || !canEdit || trimmed === content) {
        setIsEditing(false);
        return;
      }
      setIsEditing(false);
      void rewindAndSend(msg.backendIndex as number, trimmed);
    };
    const cancelEdit = () => {
      setIsEditing(false);
      setEditText("");
    };

    // EDIT MODE — swap bubble for an inline textarea. Pattern matches
    // ChatGPT / Claude.ai: same right-aligned column, roughly same width,
    // no modal.
    if (isEditing) {
      return (
        <div className="flex flex-col items-end">
          <div className="rounded-2xl px-4 py-2.5 text-body max-w-[80%] w-full bg-user-bubble dark:bg-user-bubble-dark text-stone-800 dark:text-stone-200">
            {hasAttachments && (
              <p className="text-xs text-stone-600/80 dark:text-stone-400 italic mb-2">
                Attachments from this message will be dropped on rewind.
              </p>
            )}
            <textarea
              value={editText}
              onChange={(e) => setEditText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  commitEdit();
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
              autoFocus
              rows={Math.min(10, Math.max(2, editText.split("\n").length))}
              className="w-full bg-transparent outline-none resize-none whitespace-pre-wrap break-words"
              aria-label="Edit message"
            />
          </div>
          <div className="flex items-center gap-2 mt-1.5 mr-1">
            <button
              onClick={cancelEdit}
              className="px-3 py-1 text-xs rounded-full text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={commitEdit}
              disabled={!editText.trim()}
              className="px-3 py-1 text-xs rounded-full bg-stone-800 dark:bg-stone-100 text-white dark:text-stone-800 hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Send
            </button>
          </div>
        </div>
      );
    }

    // NORMAL MODE — existing render plus an edit pencil in the footer.
    return (
      <div className="group flex flex-col items-end">
        <div className="rounded-2xl px-4 py-2.5 text-body max-w-[80%] bg-user-bubble dark:bg-user-bubble-dark text-stone-800 dark:text-stone-200">
          {msg.images && msg.images.length > 0 && (
            <div className="flex gap-2 mb-2 flex-wrap">
              {msg.images.map((img, i) => (
                <img
                  key={i}
                  src={`data:${img.media_type};base64,${img.base64}`}
                  alt={`Attachment ${i + 1}`}
                  className="max-w-[200px] max-h-[200px] rounded-lg object-contain"
                />
              ))}
            </div>
          )}
          {msg.documents && msg.documents.length > 0 && (
            <div className="flex gap-2 mb-2 flex-wrap">
              {msg.documents.map((doc, i) => (
                <div
                  key={i}
                  className="flex items-center gap-2 px-3 py-2 rounded-lg bg-stone-100/60 dark:bg-stone-900/40 border border-stone-200/80 dark:border-stone-700/40 max-w-full"
                >
                  <span className="text-lg" aria-hidden="true">📄</span>
                  <span className="flex flex-col leading-tight min-w-0">
                    <span className="text-sm truncate max-w-[220px]">{doc.filename}</span>
                    <span className="text-xs text-stone-500 dark:text-stone-400">
                      {doc.sizeBytes < 1024 * 1024
                        ? `${Math.round(doc.sizeBytes / 1024)} KB`
                        : `${(doc.sizeBytes / 1024 / 1024).toFixed(1)} MB`}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
          {!isPlaceholderBubble && (
            <p className="whitespace-pre-wrap break-words">{msg.content}</p>
          )}
        </div>
        <div className="flex items-center gap-1 mt-0.5 mr-1">
          {ts && (
            <span className="text-[11px] text-muted/0 group-hover:text-muted dark:text-muted-dark/0 dark:group-hover:text-muted-dark [@media(hover:none)]:text-muted [@media(hover:none)]:dark:text-muted-dark transition-colors duration-200">
              {ts}
            </span>
          )}
          {canEdit && content && (
            <EditButton onClick={enterEditMode} />
          )}
          <CopyButton text={msg.content} />
        </div>
      </div>
    );
  }

  // System message — two flavors:
  //   plain (errors, "agent disconnected"): small centered italic toast
  //   command output (msg.command set): body typography + chip + left rail
  if (isSystem) {
    if (msg.command) {
      return (
        <div className="border-l-2 border-stone-300 dark:border-stone-600 pl-4 py-1">
          <div className="text-xs font-mono text-muted dark:text-muted-dark mb-1.5">
            ▸ {msg.command}
          </div>
          <pre className="text-sm font-mono whitespace-pre-wrap break-words text-stone-700 dark:text-stone-300 leading-relaxed">
            {msg.content}
          </pre>
        </div>
      );
    }
    return (
      <div className="flex justify-center">
        <div className="rounded-lg px-3 py-1.5 text-xs max-w-[85%] text-muted dark:text-muted-dark italic">
          <p className="whitespace-pre-wrap break-words">{msg.content}</p>
        </div>
      </div>
    );
  }

  // Assistant message — NO bubble, serif font, flows on background (Claude.ai style)
  const assistantTs = formatTimestamp(msg.timestamp);
  return (
    <div className="group font-serif text-stone-800 dark:text-stone-100">
      <Markdown content={msg.content} isStreaming={isStreaming} />
      {!isStreaming && (
        <div className="flex items-center gap-1 mt-1">
          {assistantTs && (
            <span className="text-[11px] font-sans text-muted/0 group-hover:text-muted dark:text-muted-dark/0 dark:group-hover:text-muted-dark [@media(hover:none)]:text-muted [@media(hover:none)]:dark:text-muted-dark transition-colors duration-200">
              {assistantTs}
            </span>
          )}
          <CopyButton text={msg.content} />
        </div>
      )}
    </div>
  );
}

// -----------------------------------------------------------------------------
// Chat view
// -----------------------------------------------------------------------------

export function ChatView() {
  const messages = useSessionStore((s) => s.messages);
  const loading = useSessionStore((s) => s.loading);
  const activeKey = useSessionStore((s) => s.activeKey);
  const agentStatus = useSessionStore((s) => s.agentStatus);
  const statusLabel = useSessionStore((s) => s.statusLabel);
  const contextUsagePercent = useSessionStore((s) => s.contextUsagePercent);
  const sessionTokens = useSessionStore((s) => s.sessionTokens);
  const sessionCostUSD = useSessionStore((s) => s.sessionCostUSD);
  const lastTurnUsage = useSessionStore((s) => s.lastTurnUsage);
  const lastTurnCostUSD = useSessionStore((s) => s.lastTurnCostUSD);
  const pendingPermission = useSessionStore((s) => s.pendingPermission);
  const pendingAskUser = useSessionStore((s) => s.pendingAskUser);
  const historyMeta = useSessionStore((s) => s.historyMeta);
  const loadOlderMessages = useSessionStore((s) => s.loadOlderMessages);
  const switchSession = useSessionStore((s) => s.switchSession);
  const notifications = useSessionStore(
    (s) => s.notificationsBySession[s.activeKey] ?? EMPTY_NOTIFICATIONS,
  );
  const rpc = useSocketStore((s) => s.rpc);

  // Only heartbeat is truly read-only / system. Cron sessions are now
  // first-class chattable threads, so they get the regular Export action
  // (and DON'T need the "Fork to chat" affordance anymore).
  const isSystemSession = activeKey.startsWith("heartbeat:");
  const [forking, setForking] = useState(false);

  const handleFork = useCallback(async () => {
    if (!rpc || forking) return;
    setForking(true);
    try {
      const result = await rpc("session.fork", { sourceKey: activeKey, platform: "web" }) as any;
      if (result?.sessionKey) {
        void switchSession(result.sessionKey);
      }
    } catch (err) {
      console.error("Fork failed:", err);
    } finally {
      setForking(false);
    }
  }, [rpc, activeKey, forking, switchSession]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // --- Scroll position memory per channel. No auto-scroll ever. ---
  const scrollPositions = useRef<Map<string, number>>(new Map());
  const prevKeyRef = useRef<string>(activeKey);
  const [switching, setSwitching] = useState(false);
  const switchingRef = useRef(false);

  // On channel switch: save current position, show loading overlay
  useEffect(() => {
    const el = scrollRef.current;
    const prevKey = prevKeyRef.current;
    if (prevKey !== activeKey) {
      if (el && prevKey) {
        scrollPositions.current.set(prevKey, el.scrollTop);
      }
      switchingRef.current = true;
      setSwitching(true);
      setShowScrollButton(false);
      prevKeyRef.current = activeKey;
    }
  }, [activeKey]);

  // When messages are ready: restore scroll position BEFORE browser paints
  useLayoutEffect(() => {
    if (!switchingRef.current || loading) return;
    const el = scrollRef.current;
    if (!el) return;

    const savedPosition = scrollPositions.current.get(activeKey);
    if (savedPosition != null) {
      el.scrollTop = savedPosition;
    } else {
      // First visit: show bottom
      el.scrollTop = el.scrollHeight;
    }

    // Recompute atBottom after restoration so new-message pinning is correct
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = dist < 50;

    switchingRef.current = false;
    setSwitching(false);
  }, [messages, loading, activeKey]);

  // Track if user is at bottom (for pinning new messages into view)
  const atBottomRef = useRef(true);

  // Infinite scroll: when user scrolls near the top, fetch older messages.
  // prependRef records scroll geometry immediately before a load is triggered
  // so the layout effect below can restore the user's visual position after
  // older messages are prepended to the DOM.
  const LOAD_OLDER_THRESHOLD_PX = 200;
  const prependRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottomRef.current = distanceFromBottom < 50;
    setShowScrollButton(distanceFromBottom > 50 && messages.length > 0);

    // Trigger loading older messages when scrolled near the top.
    // Guarded by the store (loadingOlder flag + hasMore) so rapid scroll
    // events don't fire duplicate fetches.
    if (
      el.scrollTop < LOAD_OLDER_THRESHOLD_PX &&
      historyMeta?.hasMore &&
      !historyMeta.loadingOlder &&
      !switchingRef.current &&
      !loading
    ) {
      prependRef.current = { scrollHeight: el.scrollHeight, scrollTop: el.scrollTop };
      void loadOlderMessages();
    }
  }, [messages.length, historyMeta, loadOlderMessages, loading]);

  // Preserve visual scroll position when older messages are prepended.
  //
  // This effect runs on every `messages` change. We only want to apply the
  // height-delta shift when the change is the load-older RPC completing —
  // NOT when a live message appends during an in-flight fetch (otherwise we
  // shift the user's view unnecessarily).
  //
  // Strategy: while `loadingOlder` is true, any `messages` change must be a
  // live append (the RPC hasn't returned yet). Rebase prependRef's
  // scrollHeight baseline to the new height so the live message's size is
  // excluded from the final delta. When `loadingOlder` transitions to false,
  // the remaining delta is exactly the prepended chunk's height.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !prependRef.current) return;

    if (historyMeta?.loadingOlder) {
      // Live message arrived during load — rebase so we only shift for the prepend.
      prependRef.current.scrollHeight = el.scrollHeight;
      return;
    }

    const heightDelta = el.scrollHeight - prependRef.current.scrollHeight;
    if (heightDelta > 0) {
      el.scrollTop = el.scrollTop + heightDelta;
    }
    prependRef.current = null;
  }, [messages, historyMeta?.loadingOlder]);

  // If user is at the bottom, keep them there when new messages arrive.
  // Uses instant scrollTop (no animation — CSS smooth scroll is removed).
  // Does NOT fire during channel switches.
  useLayoutEffect(() => {
    if (switchingRef.current || loading) return;
    if (atBottomRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages, loading, pendingPermission, pendingAskUser]);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setShowScrollButton(false);
  }, []);

  if (loading && messages.length === 0) {
    return (
      <main className="flex-1 flex items-center justify-center bg-surface dark:bg-surface-dark">
        <div className="text-stone-400 dark:text-stone-500 animate-pulse text-sm">
          Loading...
        </div>
      </main>
    );
  }

  // Empty-state guard. Notifications live outside the message list, so a
  // session that has only notifications (e.g. fresh `web:general` that just
  // received a heartbeat card) should NOT render the placeholder — the user
  // would see "Send a message to get started" while the card sits invisible
  // below it. Codex flagged this as a high-severity regression.
  if (!loading && messages.length === 0 && notifications.length === 0 && agentStatus === "idle") {
    return (
      <main className="flex-1 flex items-center justify-center text-muted dark:text-muted-dark">
        <div className="text-center">
          <p className="text-2xl mb-1">🚀</p>
          <p className="text-lg font-medium text-stone-600 dark:text-stone-400">Hawky</p>
          <p className="text-sm mt-1">Send a message to get started</p>
        </div>
      </main>
    );
  }

  return (
    <main
      ref={scrollRef}
      className="flex-1 overflow-y-auto overflow-x-hidden px-4 py-6 relative"
      onScroll={handleScroll}
    >
      {/* Gray overlay during channel switch (Claude.ai style) */}
      {switching && (
        <div className="absolute inset-0 bg-surface/60 dark:bg-surface-dark/60 z-10 flex items-center justify-center backdrop-blur-[1px]">
          <div className="text-stone-400 dark:text-stone-500 text-sm animate-pulse">
            Loading...
          </div>
        </div>
      )}
      {historyMeta?.loadingOlder && (
        // Absolutely positioned so the indicator doesn't contribute to
        // scrollHeight — keeps the prepend scroll-restoration math clean.
        <div className="absolute top-2 left-0 right-0 z-20 flex justify-center pointer-events-none">
          <div className="px-3 py-1 rounded-full bg-stone-100/90 dark:bg-stone-800/90 text-xs text-stone-500 dark:text-stone-400 animate-pulse shadow-sm">
            Loading older messages…
          </div>
        </div>
      )}
      <div className="space-y-6 max-w-3xl mx-auto min-w-0">
        {(() => {
          let lastAssistantIdx = -1;
          for (let i = messages.length - 1; i >= 0; i--) {
            if (messages[i].role === "assistant") { lastAssistantIdx = i; break; }
          }

          // Precompute per-message-index notification insertion points.
          // Each notification slots in just before the first message whose
          // timestamp is strictly greater than the notification's — or at
          // the tail when none qualify. Messages without a timestamp don't
          // define a boundary, so older notifications naturally land at
          // the end for sessions whose history lacks timestamps.
          const insertBefore = new Map<number, NotificationItem[]>();
          const trailingNotifications: NotificationItem[] = [];
          for (const n of notifications) {
            const nTs = n.timestamp;
            let inserted = false;
            for (let i = 0; i < messages.length; i++) {
              const ts = messages[i].timestamp;
              if (ts && ts > nTs) {
                const list = insertBefore.get(i) ?? [];
                list.push(n);
                insertBefore.set(i, list);
                inserted = true;
                break;
              }
            }
            if (!inserted) trailingNotifications.push(n);
          }

          // Group consecutive tool messages (by batchId, falling back to
          // run-of-adjacent-tools for legacy messages that lack one) into
          // a single ToolStep. Non-tool messages render via MessageBubble
          // in their original order.
          const elements: React.ReactNode[] = [];
          const emittedBatchIds = new Set<string>();

          const toToolLineData = (m: SessionMessage): ToolLineData | null => {
            if (m.role !== "tool" || !m.tool) return null;
            return {
              name: m.tool.name,
              inputPreview: m.tool.inputPreview,
              fullInput: m.tool.fullInput,
              status: m.tool.status,
              output: m.tool.output,
              isError: m.tool.isError,
              metadata: m.tool.metadata,
              startedAt: m.tool.startedAt,
            };
          };

          for (let i = 0; i < messages.length; i++) {
            // Inject any notifications that belong just before this message.
            const pending = insertBefore.get(i);
            if (pending) {
              for (const n of pending) {
                elements.push(<NotificationCard key={`notif-${n.id}`} notification={n} />);
              }
            }
            const msg = messages[i];

            if (msg.role === "tool" && msg.tool) {
              const batchId = msg.tool.batchId;

              if (batchId) {
                if (emittedBatchIds.has(batchId)) continue;
                emittedBatchIds.add(batchId);
                const batchTools = messages
                  .filter((m) => m.role === "tool" && m.tool?.batchId === batchId)
                  .map(toToolLineData)
                  .filter((t): t is ToolLineData => t !== null);
                elements.push(<ToolStep key={`step-${batchId}`} tools={batchTools} />);
                continue;
              }

              // No batchId — this tool came from reconstructed history or
              // from a legacy backend. Render as a one-tool step so each
              // turn stays separate; merging adjacent tools would erase the
              // turn boundaries in persisted sessions.
              const single = toToolLineData(msg);
              if (single) {
                elements.push(<ToolStep key={`step-solo-${msg.id}`} tools={[single]} />);
              }
              continue;
            }

            elements.push(
              <MessageBubble
                key={msg.id}
                msg={msg}
                isLastAssistant={i === lastAssistantIdx}
                agentStatus={agentStatus}
              />,
            );
          }
          // Notifications whose timestamp is newer than every known message
          // — append to the tail. Also covers the empty-history case where
          // a notification arrives before any conversation exists.
          for (const n of trailingNotifications) {
            elements.push(<NotificationCard key={`notif-${n.id}`} notification={n} />);
          }
          return elements;
        })()}

        {/* Agent thinking indicator — icon hangs in the same left gutter
            as the ToolStep chevron (`sm:-ml-6`) so both "gutter glyph"
            rows align visually on desktop. On mobile/PWA the negative
            margin is dropped because the scroll container's narrow
            padding would otherwise push the icon off the left edge of
            the viewport (the `-ml-6` exceeds the container's `px-4`
            and gets clipped by `overflow-x-hidden`). */}
        {(agentStatus === "thinking" || agentStatus === "streaming" || agentStatus === "compacting") && (
          <div className="flex items-center gap-2 py-3 sm:-ml-6">
            <span className="w-4 h-4 flex items-center justify-center text-base animate-[spin_3s_ease-in-out_infinite] shrink-0">🚀</span>
            <span className="text-body italic text-[#7e7c77] dark:text-muted-dark">
              {statusLabel || (agentStatus === "thinking" ? "Thinking..." : agentStatus === "compacting" ? "Compacting context..." : "Generating...")}
            </span>
          </div>
        )}

        {/* Usage summary — appears after agent finishes. Cumulative session
            totals come first, followed by the most recent API call's billed
            numbers (useful for spot-checking cache hits and per-turn cost
            without doing math). One line, one type size.
            The cumulative ↓ is the SUM of all three input buckets (fresh +
            cache_read + cache_creation) so it represents total input the
            model has processed — and stays stable as caching engages
            instead of suddenly looking 10× smaller. */}
        {agentStatus === "idle" && sessionTokens && (() => {
          const totalInput = sessionTokens.input + (sessionTokens.cacheRead ?? 0) + (sessionTokens.cacheCreation ?? 0);
          if (totalInput === 0 && sessionTokens.output === 0) return null;
          return (
            <div className="flex justify-center py-3">
              <span
                className="text-[11px] text-muted/40 dark:text-muted-dark/40 font-mono tracking-wide"
                title={lastTurnUsage ? "Cumulative ↓ sums fresh + cached + cache-write input. After 'last turn:' is the most recent API call only — cached input is billed at a discount, cache_creation is the one-time write." : undefined}
              >
                {formatTokens(totalInput)}↓ {formatTokens(sessionTokens.output)}↑
                {sessionCostUSD != null && sessionCostUSD > 0 && ` · ${formatCostDisplay(sessionCostUSD)}`}
                {contextUsagePercent != null && contextUsagePercent > 0 && ` · ${contextUsagePercent}% ctx`}
                {lastTurnUsage && (lastTurnUsage.input > 0 || lastTurnUsage.cacheRead > 0 || lastTurnUsage.cacheCreation > 0) && (
                  <>
                    {" · last turn: "}
                    {formatTokens(lastTurnUsage.input)}↓
                    {lastTurnUsage.cacheRead > 0 && ` (+${formatTokens(lastTurnUsage.cacheRead)}↓ cached)`}
                    {lastTurnUsage.cacheCreation > 0 && ` (+${formatTokens(lastTurnUsage.cacheCreation)}↓ cache-write)`}
                    {" "}{formatTokens(lastTurnUsage.output)}↑
                    {lastTurnCostUSD != null && lastTurnCostUSD > 0 && ` · ${formatCostDisplay(lastTurnCostUSD)}`}
                  </>
                )}
              </span>
            </div>
          );
        })()}

        {/* Action row — left-aligned icons at end of last response */}
        {messages.length > 0 && agentStatus === "idle" && (
          <div className="flex items-center gap-1.5 pt-0.5 pb-2 max-w-3xl mx-auto">
            {!isSystemSession && (
              <ActionButton
                label="Export conversation"
                onClick={() => exportSessionAsHtml(messages, activeKey)}
                icon={<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0 0l-4-4m4 4l4-4" />}
              />
            )}
            {isSystemSession && (
              <ActionButton
                label="Fork to chat"
                onClick={handleFork}
                icon={<path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 12h6m0 0l5-5m-5 5l5 5m2-10h5m-5 10h5" />}
              />
            )}
          </div>
        )}

        {/* Inline dialogs */}
        <PermissionDialog />
        <AskUserDialog />
      </div>

      {/* Scroll to bottom — centered, white circle with border like Claude.ai */}
      {showScrollButton && (
        <div className="sticky bottom-4 flex justify-center z-10 pointer-events-none">
          <button
            className="pointer-events-auto rounded-full bg-white dark:bg-stone-800 border border-stone-200 dark:border-stone-600 shadow-sm w-10 h-10 flex items-center justify-center hover:bg-stone-50 dark:hover:bg-stone-700 transition-colors"
            onClick={scrollToBottom}
            aria-label="Scroll to bottom"
          >
            <svg className="w-4 h-4 text-stone-600 dark:text-stone-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 14l-7 7m0 0l-7-7m7 7V3" />
            </svg>
          </button>
        </div>
      )}
    </main>
  );
}
