import { useState, useCallback, useRef, useEffect } from "react";
import { useSessionStore, type RuntimeKind, type SessionInfo } from "../store/session-store";
import { useWebSettingsStore } from "../store/web-settings-store";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

/** Format display name for a session key.
 * web:general → "general"  (web prefix stripped — it's the user's own namespace)
 * tui:main → "tui:main"    (keep prefix for non-web sessions to disambiguate)
 * heartbeat:main → "heartbeat"  (system sessions: show type, not "main")
 * cron:abc123 → "cron:abc123"
 */
export function formatChannelName(session: SessionInfo): string {
  // Use display name if set
  if (session.displayName) return session.displayName;

  const key = session.key;
  const [prefix, name] = key.includes(":") ? [key.split(":")[0], key.split(":").slice(1).join(":")] : ["", key];

  // Web sessions: strip prefix (it's implied)
  if (prefix === "web") return name;

  // System sessions: show prefix for clarity
  if (prefix === "heartbeat") {
    return name === "main" ? "heartbeat" : `heartbeat:${name}`;
  }
  if (prefix === "cron") return name;

  // Other sessions (tui, dev, test): show full key so you know which client
  return key;
}

// -----------------------------------------------------------------------------
// Channel item
// -----------------------------------------------------------------------------

/** SVG icon for channel type — larger and cleaner than text characters */
function ChannelIcon({ session }: { session: SessionInfo }) {
  const cls = "w-5 h-5 shrink-0 text-muted dark:text-muted-dark";

  if (session.key.startsWith("heartbeat:")) {
    return (
      <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4.318 6.318a4.5 4.5 0 000 6.364L12 20.364l7.682-7.682a4.5 4.5 0 00-6.364-6.364L12 7.636l-1.318-1.318a4.5 4.5 0 00-6.364 0z" />
      </svg>
    );
  }
  if (session.key.startsWith("cron:")) {
    return (
      <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    );
  }
  if (session.runtimeKind === "codex" || session.runtimeKind === "hermes" || session.runtimeKind === "claude") {
    const label = session.runtimeKind === "codex"
      ? "Codex"
      : session.runtimeKind === "claude"
        ? "Claude Code"
        : "Hermes";
    const short = session.runtimeKind === "codex"
      ? "Cx"
      : session.runtimeKind === "claude"
        ? "Cl"
        : "Hx";
    return (
      <span
        className={`${cls} inline-flex items-center justify-center rounded border border-current font-mono text-[9px] leading-none`}
        aria-label={`${session.runtimeKind} session`}
        title={label}
      >
        {short}
      </span>
    );
  }
  // User channel — chat bubble icon
  return (
    <svg className={cls} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  );
}

/** Pin icon — small, filled circle/pin indicator */
function PinIcon() {
  return (
    <svg className="w-3 h-3 shrink-0 text-stone-400 dark:text-stone-500" viewBox="0 0 24 24" fill="currentColor">
      <path d="M16 12V4h1V2H7v2h1v8l-2 2v2h5.2v6h1.6v-6H18v-2l-2-2z" />
    </svg>
  );
}

/** Small circular ring showing % of context window used.
 * Replaces the raw message count on the right of each channel row.
 * Uses a React-driven hover tooltip (instant, matches HeaderIcon in App.tsx)
 * instead of the native `title` attribute (which has a ~500ms browser delay). */
export function ContextRing({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  const size = 14;
  const stroke = 2;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - clamped / 100);
  const warn = clamped >= 90;
  const arcClass = warn
    ? "stroke-amber-600 dark:stroke-amber-500"
    : "stroke-stone-700 dark:stroke-stone-300";
  const tooltipText = `${clamped}% of context used`;
  const [showTooltip, setShowTooltip] = useState(false);
  return (
    <span
      className="relative shrink-0 inline-flex items-center justify-center"
      data-context-percent={clamped}
      aria-label={tooltipText}
      role="img"
      onMouseEnter={() => setShowTooltip(true)}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="-rotate-90"
        aria-hidden="true"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          className="stroke-stone-300/70 dark:stroke-stone-600/70"
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          className={arcClass}
          strokeDasharray={circumference}
          strokeDashoffset={dashOffset}
        />
      </svg>
      {showTooltip && (
        <span className="absolute right-0 bottom-full mb-1 px-2 py-1 rounded-md bg-stone-800 dark:bg-stone-200 text-white dark:text-stone-800 text-xs whitespace-nowrap shadow-md z-50 pointer-events-none">
          {tooltipText}
        </span>
      )}
    </span>
  );
}

function ChannelItem({
  session,
  isActive,
  unread,
  hasUnread,
  onClick,
  onContextMenu,
  isRenaming,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameCancel,
}: {
  session: SessionInfo;
  isActive: boolean;
  unread: number;
  hasUnread: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  isRenaming: boolean;
  renameValue: string;
  onRenameChange: (v: string) => void;
  onRenameSubmit: () => void;
  onRenameCancel: () => void;
}) {
  const isUnread = hasUnread || unread !== 0;
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isRenaming && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isRenaming]);

  return (
    <button
      className={`w-full flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-[15px] transition-colors relative
        ${isActive
          ? `bg-stone-300/70 dark:bg-stone-600/60 text-stone-900 dark:text-stone-50 ${isUnread ? "font-semibold" : "font-medium"}`
          : isUnread
            ? "text-stone-900 dark:text-stone-100 font-semibold hover:bg-stone-200/40 dark:hover:bg-stone-700/30"
            : "text-stone-600 dark:text-stone-400 hover:bg-stone-200/40 dark:hover:bg-stone-700/30"
        }`}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {isActive && (
        <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-r bg-stone-800 dark:bg-stone-200" />
      )}
      {session.pinned && !isRenaming && <PinIcon />}
      <ChannelIcon session={session} />

      {isRenaming ? (
        <input
          ref={inputRef}
          type="text"
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onRenameSubmit();
            if (e.key === "Escape") onRenameCancel();
          }}
          onBlur={onRenameSubmit}
          onClick={(e) => e.stopPropagation()}
          className="flex-1 min-w-0 bg-transparent border-b border-stone-400 dark:border-stone-500 outline-none text-[15px] py-0"
        />
      ) : (
        <span className="flex-1 truncate text-left">
          {formatChannelName(session)}
        </span>
      )}

      {unread === -1 ? (
        /* Permission prompt waiting — amber attention badge */
        <span className="w-2.5 h-2.5 rounded-full bg-amber-500" title="Needs attention" />
      ) : unread > 0 ? (
        /* Unread messages — stone number badge */
        <span className="min-w-[18px] h-[18px] flex items-center justify-center rounded-full bg-stone-700 dark:bg-stone-300 text-white dark:text-stone-900 text-[10px] font-medium">
          {unread > 99 ? "99+" : unread}
        </span>
      ) : !session.isSystem && !isRenaming && (session.contextUsagePercent ?? 0) > 0 ? (
        <ContextRing percent={session.contextUsagePercent!} />
      ) : null}
    </button>
  );
}

// -----------------------------------------------------------------------------
// Delete confirmation dialog
// -----------------------------------------------------------------------------

function DeleteConfirmDialog({
  sessionName,
  isCronSession,
  onConfirm,
  onCancel,
}: {
  sessionName: string;
  isCronSession?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const canConfirm = isCronSession ? confirmText === sessionName : true;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <div className="relative bg-white dark:bg-stone-800 rounded-xl border border-stone-200 dark:border-stone-700 shadow-xl p-5 max-w-sm mx-4">
        <h3 className="text-base font-medium text-stone-800 dark:text-stone-200 mb-2">
          {isCronSession ? "Delete cron job?" : "Delete session?"}
        </h3>
        <p className="text-sm text-stone-600 dark:text-stone-400 mb-3">
          This will permanently delete <strong>{sessionName}</strong>
          {isCronSession
            ? " — including the scheduled job, run history, and session log."
            : " and its conversation log."}
          {" "}This cannot be undone.
        </p>
        {isCronSession && (
          <div className="mb-4">
            <p className="text-xs text-stone-500 dark:text-stone-400 mb-1.5">
              Type <strong>{sessionName}</strong> to confirm:
            </p>
            <input
              type="text"
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className="w-full px-2.5 py-1.5 text-sm rounded-lg border border-stone-300 dark:border-stone-600 bg-stone-50 dark:bg-stone-900 text-stone-800 dark:text-stone-200 outline-none focus:border-stone-500 dark:focus:border-stone-400"
              placeholder={sessionName}
              autoFocus
            />
          </div>
        )}
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 text-sm rounded-lg text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-700 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`px-3 py-1.5 text-sm rounded-lg transition-colors ${
              canConfirm
                ? "bg-red-600 text-white hover:bg-red-700"
                : "bg-stone-300 dark:bg-stone-600 text-stone-500 dark:text-stone-400 cursor-not-allowed"
            }`}
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Create channel input
// -----------------------------------------------------------------------------

function CreateChannelInput({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [runtimeKind, setRuntimeKind] = useState<RuntimeKind>("native");
  const createChannel = useSessionStore((s) => s.createChannel);
  const agentRuntimesEnabled = useWebSettingsStore((s) => s.agentRuntimesEnabled);
  const runtimeOptions: Array<{ kind: RuntimeKind; label: string }> = [
    { kind: "native", label: "Native" },
    { kind: "codex", label: "Codex" },
    { kind: "claude", label: "Claude" },
    { kind: "hermes", label: "Hermes" },
  ];

  const handleSubmit = useCallback(async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    await createChannel(trimmed, runtimeKind);
    setName("");
    onClose();
  }, [name, runtimeKind, createChannel, onClose]);

  return (
    <div className="px-2 py-1 space-y-2">
      {agentRuntimesEnabled && (
        <div className="grid grid-cols-4 rounded border border-stone-200 dark:border-stone-700 overflow-hidden text-xs">
          {runtimeOptions.map(({ kind, label }) => (
            <button
              key={kind}
              type="button"
              onClick={() => setRuntimeKind(kind)}
              className={`px-2 py-1.5 transition-colors ${
                runtimeKind === kind
                  ? "bg-stone-800 text-white dark:bg-stone-200 dark:text-stone-900"
                  : "bg-white dark:bg-stone-800 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void handleSubmit();
          if (e.key === "Escape") onClose();
        }}
        placeholder="channel-name"
        className="w-full rounded border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-800 px-2 py-1 text-sm outline-none focus:border-stone-500"
        autoFocus
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// Channel list
// -----------------------------------------------------------------------------

export function ChannelList({ onChannelClick }: { onChannelClick?: () => void } = {}) {
  const sessions = useSessionStore((s) => s.sessions);
  const activeKey = useSessionStore((s) => s.activeKey);
  const switchSession = useSessionStore((s) => s.switchSession);
  const renameSession = useSessionStore((s) => s.renameSession);
  const archiveSession = useSessionStore((s) => s.archiveSession);
  const deleteSession = useSessionStore((s) => s.deleteSession);
  const pinSession = useSessionStore((s) => s.pinSession);
  const unpinSession = useSessionStore((s) => s.unpinSession);
  const unreadCounts = useSessionStore((s) => s.unreadCounts);
  const hasUnreadMap = useSessionStore((s) => s.hasUnread);
  const [showCreate, setShowCreate] = useState(false);
  const [systemCollapsed, setSystemCollapsed] = useState(() => {
    try { return localStorage.getItem("hawky:systemCollapsed") !== "false"; }
    catch { return true; }
  });

  // Context menu state
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; session: SessionInfo } | null>(null);

  // Rename state
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");

  // Delete confirmation
  const [deleteTarget, setDeleteTarget] = useState<SessionInfo | null>(null);

  const toggleSystem = useCallback(() => {
    setSystemCollapsed((prev) => {
      const next = !prev;
      try { localStorage.setItem("hawky:systemCollapsed", String(next)); } catch {}
      return next;
    });
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent, session: SessionInfo) => {
    // Heartbeat is the only fully-managed singleton — no context menu, no
    // chat. Cron sessions are now ordinary chattable threads and get the
    // full menu (Rename / Pin / Archive / Delete), same as user sessions.
    if (session.key.startsWith("heartbeat:")) return;
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, session });
  }, []);

  const startRename = useCallback((session: SessionInfo) => {
    setRenamingKey(session.key);
    setRenameValue(session.displayName || formatChannelName(session));
  }, []);

  const submitRename = useCallback(() => {
    if (renamingKey) {
      const trimmed = renameValue.trim();
      void renameSession(renamingKey, trimmed);
      setRenamingKey(null);
      setRenameValue("");
    }
  }, [renamingKey, renameValue, renameSession]);

  const cancelRename = useCallback(() => {
    setRenamingKey(null);
    setRenameValue("");
  }, []);

  const buildMenuItems = useCallback((session: SessionInfo): ContextMenuItem[] => {
    const items: ContextMenuItem[] = [];

    // Heartbeat is the only fully-managed singleton — no actions surface.
    if (session.key.startsWith("heartbeat:")) return items;

    items.push({ label: "Rename", onClick: () => startRename(session) });

    if (session.pinned) {
      items.push({ label: "Unpin", onClick: () => void unpinSession(session.key) });
    } else {
      items.push({ label: "Pin to top", onClick: () => void pinSession(session.key) });
    }

    // Archive is hidden on cron sessions until there's an Unarchive surface
    // in the web UI. The backing cron job keeps firing after archive, so
    // exposing it here would orphan an active job into a hidden thread the
    // user can't reach again from the sidebar. Codex caught this. Cron's
    // way to silence a thread today is Delete (the job goes too) or
    // disabling the underlying cron via the cron tool.
    const isCron = session.key.startsWith("cron:");
    if (!isCron) {
      items.push({ label: "Archive", onClick: () => void archiveSession(session.key) });
    }
    items.push({ label: "Delete", onClick: () => setDeleteTarget(session), danger: true });

    return items;
  }, [startRename, pinSession, unpinSession, archiveSession]);

  // Filter out internal sessions (flush:*) and split into user vs system
  const visible = sessions.filter((s) => !s.key.startsWith("flush:"));
  const userSessions = visible.filter((s) => !s.isSystem);
  const systemSessions = visible.filter((s) => s.isSystem);

  return (
    <nav className="flex-1 overflow-y-auto px-3 py-2" data-testid="channel-list">
      {/* New chat button — prominent, like Claude.ai */}
      <button
        className="w-full flex items-center gap-2.5 rounded-lg px-3 py-3 mb-3 text-[15px] text-stone-600 dark:text-stone-400 hover:bg-stone-200/50 dark:hover:bg-stone-700/30 transition-colors"
        onClick={() => setShowCreate((v) => !v)}
        aria-label="Create channel"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 4v16m8-8H4" />
        </svg>
        New chat
      </button>

      {/* User channels */}
      <div className="mb-4">
        <div className="flex items-center justify-between px-2 py-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted dark:text-muted-dark">
            Channels
          </p>
        </div>

        {showCreate && (
          <CreateChannelInput onClose={() => setShowCreate(false)} />
        )}

        {userSessions.length === 0 && !showCreate && (
          <p className="px-2 py-1 text-xs text-muted dark:text-muted-dark italic">
            No channels yet
          </p>
        )}

        {userSessions.map((session) => (
          <ChannelItem
            key={session.key}
            session={session}
            isActive={activeKey === session.key}
            unread={unreadCounts[session.key] ?? 0}
            hasUnread={hasUnreadMap[session.key] ?? false}
            onClick={() => { void switchSession(session.key); onChannelClick?.(); }}
            onContextMenu={(e) => handleContextMenu(e, session)}
            isRenaming={renamingKey === session.key}
            renameValue={renameValue}
            onRenameChange={setRenameValue}
            onRenameSubmit={submitRename}
            onRenameCancel={cancelRename}
          />
        ))}
      </div>

      {/* System channels — collapsible */}
      {systemSessions.length > 0 && (
        <div>
          <button
            className="w-full flex items-center justify-between px-2 py-2 group"
            onClick={toggleSystem}
          >
            <p className="text-xs font-semibold uppercase tracking-wider text-muted dark:text-muted-dark">
              System ({systemSessions.length})
            </p>
            <svg
              className={`w-3.5 h-3.5 text-muted dark:text-muted-dark transition-transform ${systemCollapsed ? "-rotate-90" : ""}`}
              fill="none" stroke="currentColor" viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {!systemCollapsed && systemSessions.map((session) => (
            <ChannelItem
              key={session.key}
              session={session}
              isActive={activeKey === session.key}
              unread={unreadCounts[session.key] ?? 0}
              hasUnread={hasUnreadMap[session.key] ?? false}
              onClick={() => { void switchSession(session.key); onChannelClick?.(); }}
              onContextMenu={(e) => handleContextMenu(e, session)}
              isRenaming={false}
              renameValue=""
              onRenameChange={() => {}}
              onRenameSubmit={() => {}}
              onRenameCancel={() => {}}
            />
          ))}
        </div>
      )}

      {/* Context menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={buildMenuItems(contextMenu.session)}
          onClose={() => setContextMenu(null)}
        />
      )}

      {/* Delete confirmation dialog */}
      {deleteTarget && (
        <DeleteConfirmDialog
          sessionName={deleteTarget.displayName || formatChannelName(deleteTarget)}
          isCronSession={deleteTarget.key.startsWith("cron:") || deleteTarget.key.startsWith("session:")}
          onConfirm={() => {
            void deleteSession(deleteTarget.key);
            setDeleteTarget(null);
          }}
          onCancel={() => setDeleteTarget(null)}
        />
      )}
    </nav>
  );
}
