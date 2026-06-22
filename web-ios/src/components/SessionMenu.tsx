// =============================================================================
// SessionMenu — the Hawky agent-pill menu in the Live tab.
//
// Mirrors the iOS Live agent pill: New session, History (session list), and
// Status. Picking a session sets the active bridge session the Live agent
// talks to (session-store). Rendered as a left-side panel on desktop and a
// bottom sheet on mobile.
// =============================================================================

import { useEffect, useState } from "react";
import { useSessionStore, sessionDisplayName } from "../lib/session-store";
import { useSocketStore } from "../lib/socket-store";
import { Icon } from "../components/Icon";
import { Logo } from "../components/Logo";
import type { LivePhase } from "../lib/useRealtime";

type View = "menu" | "history" | "status";

export function SessionMenu({ phase, onClose }: { phase: LivePhase; onClose: () => void }) {
  const [view, setView] = useState<View>("menu");
  const activeKey = useSessionStore((s) => s.activeKey);
  const newSession = useSessionStore((s) => s.newSession);

  return (
    <div className="absolute inset-0 z-50" onClick={onClose}>
      <div className="absolute inset-0 bg-black/50" />
      <div
        className="absolute inset-x-0 bottom-0 max-h-[80%] overflow-y-auto rounded-t-glass border-t border-white/10 bg-canvas p-3 pb-safe md:inset-y-0 md:left-0 md:right-auto md:w-80 md:max-h-full md:rounded-none md:rounded-r-glass md:border-r md:border-t-0"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-2 h-1 w-10 rounded-full bg-white/25 md:hidden" />

        {view === "menu" && (
          <Menu
            activeKey={activeKey}
            phase={phase}
            onNew={() => { newSession(); onClose(); }}
            onHistory={() => setView("history")}
            onStatus={() => setView("status")}
            onClose={onClose}
          />
        )}
        {view === "history" && <History activeKey={activeKey} onBack={() => setView("menu")} onPicked={onClose} />}
        {view === "status" && <Status phase={phase} activeKey={activeKey} onBack={() => setView("menu")} />}
      </div>
    </div>
  );
}

function Menu({ activeKey, phase, onNew, onHistory, onStatus, onClose }: {
  activeKey: string; phase: LivePhase; onNew: () => void; onHistory: () => void; onStatus: () => void; onClose: () => void;
}) {
  const label = activeKey.includes(":") ? activeKey.split(":").slice(1).join(":") : activeKey;
  return (
    <div>
      <div className="px-3 py-2">
        <Logo size={22} textClass="text-white" />
        <div className="mt-0.5 text-xs text-white/45">Session: {label} · {phase}</div>
      </div>
      <Item icon="plus" label="New session" onClick={onNew} />
      <Item icon="chat" label="History" detail="Switch to a past session" onClick={onHistory} />
      <Item icon="settings" label="Status" detail="Gateway & session status" onClick={onStatus} />
      <button onClick={onClose} className="mt-1 w-full rounded-pill py-3 text-center text-sm font-medium text-white/60 hover:bg-white/5">Cancel</button>
    </div>
  );
}

function History({ activeKey, onBack, onPicked }: { activeKey: string; onBack: () => void; onPicked: () => void }) {
  const sessions = useSessionStore((s) => s.sessions);
  const loading = useSessionStore((s) => s.loading);
  const fetchSessions = useSessionStore((s) => s.fetchSessions);
  const setActive = useSessionStore((s) => s.setActive);
  const renameSession = useSessionStore((s) => s.rename);
  const removeSession = useSessionStore((s) => s.remove);
  const togglePin = useSessionStore((s) => s.togglePin);
  const status = useSocketStore((s) => s.status);

  const [editing, setEditing] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  useEffect(() => { if (status === "connected") void fetchSessions(); }, [status, fetchSessions]);

  return (
    <div>
      <SubHeader title="History" onBack={onBack} />
      {status !== "connected" ? (
        <Empty body="Connect to the gateway to load sessions." />
      ) : loading && sessions.length === 0 ? (
        <Empty body="Loading…" />
      ) : sessions.length === 0 ? (
        <Empty body="No conversations yet. Start one with the call button." />
      ) : (
        <ul className="px-1 pb-2">
          {sessions.map((s) => {
            const name = sessionDisplayName(s);
            const active = s.key === activeKey;
            const isEditing = editing === s.key;
            return (
              <li key={s.key} className={`group rounded-pill ${active ? "bg-accent/15" : "hover:bg-white/5"}`}>
                {isEditing ? (
                  <div className="flex items-center gap-2 px-3 py-2">
                    <input autoFocus value={editName} onChange={(e) => setEditName(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") { void renameSession(s.key, editName); setEditing(null); } if (e.key === "Escape") setEditing(null); }}
                      className="min-w-0 flex-1 rounded-md border border-white/15 bg-black/30 px-2 py-1 text-sm text-white outline-none focus:border-accent" />
                    <button onClick={() => { void renameSession(s.key, editName); setEditing(null); }} className="text-xs font-medium text-accent">Save</button>
                    <button onClick={() => setEditing(null)} className="text-xs text-white/50">Cancel</button>
                  </div>
                ) : confirmDelete === s.key ? (
                  <div className="flex items-center gap-2 px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1 truncate text-white/70">Delete “{name}”?</span>
                    <button onClick={() => { void removeSession(s.key); setConfirmDelete(null); }} className="text-xs font-medium text-danger">Delete</button>
                    <button onClick={() => setConfirmDelete(null)} className="text-xs text-white/50">Cancel</button>
                  </div>
                ) : (
                  <div className="flex items-center gap-1 pr-1">
                    <button onClick={() => { setActive(s.key); onPicked(); }}
                      className={`flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left text-sm ${active ? "text-accent" : "text-white/80"}`}>
                      {s.pinned && <Icon name="pin" className="h-3.5 w-3.5 shrink-0 text-accent" filled />}
                      <span className="min-w-0 flex-1 truncate">{name}</span>
                      <span className="shrink-0 text-[10px] text-white/30">{s.messageCount} msg</span>
                      {active && <Icon name="checkmark" className="h-4 w-4 shrink-0" />}
                    </button>
                    {/* Row actions (always visible on touch; hover on desktop) */}
                    <div className="flex shrink-0 items-center opacity-100 md:opacity-0 md:group-hover:opacity-100">
                      <IconBtn icon="pin" label={s.pinned ? "Unpin" : "Pin"} active={s.pinned} onClick={() => void togglePin(s.key, !s.pinned)} />
                      <IconBtn icon="settings" label="Rename" onClick={() => { setEditing(s.key); setEditName(name); }} />
                      <IconBtn icon="trash" label="Delete" danger onClick={() => setConfirmDelete(s.key)} />
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function IconBtn({ icon, label, onClick, active, danger }: {
  icon: import("../components/Icon").IconName; label: string; onClick: () => void; active?: boolean; danger?: boolean;
}) {
  return (
    <button onClick={onClick} aria-label={label} title={label}
      className={`grid h-7 w-7 place-items-center rounded-full hover:bg-white/10 ${danger ? "text-white/50 hover:text-danger" : active ? "text-accent" : "text-white/45 hover:text-white/80"}`}>
      <Icon name={icon} className="h-4 w-4" filled={active} />
    </button>
  );
}

function Status({ phase, activeKey, onBack }: { phase: LivePhase; activeKey: string; onBack: () => void }) {
  const gw = useSocketStore((s) => s.status);
  const rpc = useSocketStore((s) => s.rpc);
  const [info, setInfo] = useState<Record<string, unknown> | null>(null);

  useEffect(() => {
    if (gw !== "connected") return;
    let active = true;
    void (async () => {
      try { const r = (await rpc("gateway.status")) as Record<string, unknown>; if (active) setInfo(r); }
      catch { /* ignore */ }
    })();
    return () => { active = false; };
  }, [gw, rpc]);

  return (
    <div>
      <SubHeader title="Status" onBack={onBack} />
      <div className="space-y-2 px-3 pb-3 text-sm">
        <StatRow label="Gateway" value={gw} ok={gw === "connected"} />
        <StatRow label="Live session" value={phase} ok={phase === "connected"} />
        <StatRow label="Bridge session" value={activeKey} />
        {info && typeof info.version === "string" && <StatRow label="Server version" value={info.version} />}
        {info && typeof info.activeSessions === "number" && <StatRow label="Active sessions" value={String(info.activeSessions)} />}
        {info && typeof info.connections === "number" && <StatRow label="Connections" value={String(info.connections)} />}
      </div>
    </div>
  );
}

function StatRow({ label, value, ok }: { label: string; value: string; ok?: boolean }) {
  return (
    <div className="flex items-center justify-between rounded-md bg-paper/60 px-3 py-2">
      <span className="text-white/60">{label}</span>
      <span className="flex items-center gap-2 font-mono text-xs text-white/85">
        {ok !== undefined && <span className={`h-2 w-2 rounded-full ${ok ? "bg-ok" : "bg-white/30"}`} />}
        {value}
      </span>
    </div>
  );
}

function Item({ icon, label, detail, onClick }: { icon: import("../components/Icon").IconName; label: string; detail?: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 rounded-pill px-3 py-3 text-left hover:bg-white/5">
      <Icon name={icon} className="h-5 w-5 text-white/70" />
      <span className="min-w-0">
        <span className="block text-sm text-white">{label}</span>
        {detail && <span className="block text-xs text-white/40">{detail}</span>}
      </span>
    </button>
  );
}

function SubHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="flex items-center gap-2 px-2 py-2">
      <button onClick={onBack} aria-label="Back" className="grid h-8 w-8 place-items-center rounded-full hover:bg-white/10">
        <Icon name="chevronLeft" className="h-5 w-5 text-white/70" />
      </button>
      <span className="text-sm font-semibold text-white">{title}</span>
    </div>
  );
}

function Empty({ body }: { body: string }) {
  return <div className="px-4 py-8 text-center text-sm text-white/50">{body}</div>;
}
