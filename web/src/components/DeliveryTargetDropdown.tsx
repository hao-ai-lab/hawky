// =============================================================================
// DeliveryTargetDropdown — inline delivery target selector for the heartbeat
//
// Shown next to the heartbeat channel name in the header. A send icon that
// opens a dropdown of available user sessions; selecting one rebinds where
// the heartbeat's display-only notification card is rendered.
//
// Cron sessions used to share this surface, but cron's delivery_target was
// removed when cron sessions became chattable (the cron run lives in its
// own cron:<name> session now). The cron branches were dropped so this
// component carries no dead code path.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "../store/session-store";
import { useSocketStore } from "../store/socket-store";

interface Props {
  sessionKey: string;
}

/** Chat bubble icon matching sidebar style */
function ChatIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
    </svg>
  );
}

/** Send/paper-plane icon for the trigger button */
function SendIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M6 12L3.269 3.126A59.768 59.768 0 0121.485 12 59.77 59.77 0 013.27 20.876L5.999 12zm0 0h7.5" />
    </svg>
  );
}

export function DeliveryTargetDropdown({ sessionKey }: Props) {
  const rpc = useSocketStore((s) => s.rpc);
  const sessions = useSessionStore((s) => s.sessions);
  const [deliveryTarget, setDeliveryTarget] = useState<string>("");
  const [open, setOpen] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const isHeartbeat = sessionKey.startsWith("heartbeat:");

  // Fetch current heartbeat delivery_target. The component only renders for
  // heartbeat sessions today (App.tsx narrowed isSystem to "heartbeat:" in
  // the cron-chattable PR), but we keep the prefix guard so a future caller
  // doesn't accidentally hit config.update for an unrelated session.
  useEffect(() => {
    if (!isHeartbeat) return;
    rpc("config.get").then((config: any) => {
      setDeliveryTarget(config?.heartbeat?.delivery_target ?? "web:general");
    }).catch(() => {});
  }, [sessionKey, isHeartbeat, rpc]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const userSessions = sessions.filter((s) => !s.isSystem);

  async function selectTarget(key: string) {
    if (!isHeartbeat) return; // Defensive: cron path is gone; nothing else routes here.
    const newTarget = key === deliveryTarget ? "" : key;
    setOpen(false);

    try {
      await rpc("config.update", { heartbeat: { delivery_target: newTarget } });
      setDeliveryTarget(newTarget); // Only update after RPC succeeds
    } catch {
      // RPC failed — state unchanged, target stays as-is
    }
  }

  function displayName(key: string): string {
    if (!key) return "";
    const parts = key.split(":");
    return parts.length > 1 ? parts[1] : key;
  }

  const hasTarget = !!deliveryTarget;

  return (
    <span
      className="relative inline-flex items-center align-middle ml-3"
      ref={ref}
      onMouseEnter={() => { if (!open) setShowTooltip(true); }}
      onMouseLeave={() => setShowTooltip(false)}
    >
      <button
        onClick={() => { setOpen(!open); setShowTooltip(false); }}
        className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm transition-colors ${
          hasTarget
            ? "text-stone-600 dark:text-stone-300 hover:bg-stone-200/60 dark:hover:bg-stone-700/40"
            : "text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300 hover:bg-stone-200/60 dark:hover:bg-stone-700/40"
        }`}
        aria-label="Deliver to channel"
      >
        <SendIcon className={`w-4 h-4 ${hasTarget ? "text-stone-500 dark:text-stone-400" : "opacity-40"}`} />
        {hasTarget && (
          <span className="font-serif font-normal text-sm">{displayName(deliveryTarget)}</span>
        )}
      </button>

      {/* Tooltip — same style as HeaderIcon */}
      {showTooltip && (
        <div className="absolute left-1/2 -translate-x-1/2 top-full mt-1 px-2 py-1 rounded-md bg-stone-800 dark:bg-stone-200 text-white dark:text-stone-800 text-xs whitespace-nowrap shadow-md z-50">
          {hasTarget ? `Delivers to ${displayName(deliveryTarget)}` : "Deliver to channel"}
        </div>
      )}

      {open && (
        <div className="absolute left-0 top-full mt-2 z-50 w-52 rounded-xl border border-stone-200/80 dark:border-stone-700/60 bg-white dark:bg-stone-800 shadow-xl py-1.5 max-h-56 overflow-y-auto">
          {/* Header */}
          <div className="px-3 py-1.5 text-[11px] font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
            Deliver to
          </div>

          {/* "None" option */}
          <button
            onClick={() => selectTarget("")}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
              !hasTarget
                ? "text-stone-900 dark:text-stone-100 bg-stone-100/60 dark:bg-stone-700/40"
                : "text-stone-500 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-700/30"
            }`}
          >
            <svg className="w-4 h-4 opacity-40" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
            <span>No delivery</span>
          </button>

          {userSessions.length > 0 && (
            <div className="border-t border-stone-100 dark:border-stone-700/40 my-1" />
          )}

          {userSessions.map((s) => (
            <button
              key={s.key}
              onClick={() => selectTarget(s.key)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm transition-colors ${
                s.key === deliveryTarget
                  ? "text-stone-900 dark:text-stone-100 bg-stone-100/60 dark:bg-stone-700/40"
                  : "text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-700/30"
              }`}
            >
              <ChatIcon className="w-4 h-4 shrink-0 text-stone-400 dark:text-stone-500" />
              <span className="font-serif truncate">{displayName(s.key)}</span>
              {s.key === deliveryTarget && (
                <svg className="w-3.5 h-3.5 ml-auto text-stone-500 dark:text-stone-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
