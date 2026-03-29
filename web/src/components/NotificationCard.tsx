// =============================================================================
// NotificationCard — display-only event card
//
// Rendered inline in the chat area for events delivered via the
// `notification.received` gateway broadcast (heartbeat today, cron later).
// Visually outside the conversation flow — neutral background, a "NOTIFICATION"
// pill, the origin label, a small timestamp, body text, and a copy button.
//
// Never contributes to the conversation's context. Clicking "Copy" puts the
// body on the clipboard so the user can paste it into the input and chat
// about it if they want.
// =============================================================================

import { useState } from "react";
import { useSessionStore, type NotificationItem } from "../store/session-store";
import { Markdown } from "./Markdown";

function formatTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

/** Heartbeat and cron both go through this surface; map origin to a glyph. */
function originIcon(origin: string): string {
  if (origin === "heartbeat") return "\u2661"; // ♡
  if (origin.startsWith("cron:") || origin === "cron") return "\ud83d\udd50"; // 🕐
  return "\ud83d\udce1"; // 📡 — generic "signal"
}

/** Friendly label. Keep short — rendered inline in the header row. */
function originLabel(origin: string): string {
  if (origin === "heartbeat") return "heartbeat";
  if (origin.startsWith("cron:")) return origin.slice(5) || "cron";
  return origin;
}

export function NotificationCard({ notification }: { notification: NotificationItem }) {
  const dismissNotification = useSessionStore((s) => s.dismissNotification);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(notification.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable (insecure origin, permission denied, etc.).
      // Nothing to fall back to here — we're explicitly NOT wiring into the
      // input box for v1 to keep this component self-contained.
    }
  };

  const handleDismiss = () => {
    dismissNotification(notification.sessionKey, notification.id);
  };

  return (
    <div
      role="note"
      aria-label={`Notification from ${originLabel(notification.origin)}`}
      className="group rounded-lg border border-stone-200/60 dark:border-stone-700/40
                 bg-stone-50/60 dark:bg-stone-900/40
                 px-4 py-3 text-sm text-stone-700 dark:text-stone-300"
    >
      <div className="flex items-center gap-2 mb-1.5 text-xs">
        <span
          className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded
                     bg-stone-200/70 dark:bg-stone-800/70
                     text-stone-600 dark:text-stone-400
                     font-medium uppercase tracking-wide text-[10px]"
        >
          <span aria-hidden>{originIcon(notification.origin)}</span>
          Notification
        </span>
        <span className="text-stone-600 dark:text-stone-400 font-medium">
          {originLabel(notification.origin)}
        </span>
        <span className="text-stone-400 dark:text-stone-500">
          · {formatTime(notification.timestamp)}
        </span>
        <div className="ml-auto flex items-center gap-1 opacity-60 group-hover:opacity-100 transition-opacity">
          <button
            onClick={handleCopy}
            className="px-2 py-0.5 rounded text-[11px]
                       text-stone-500 dark:text-stone-400
                       hover:bg-stone-200/60 dark:hover:bg-stone-800/60
                       hover:text-stone-700 dark:hover:text-stone-200
                       transition-colors"
            aria-label="Copy notification to clipboard"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            onClick={handleDismiss}
            className="px-2 py-0.5 rounded text-[11px]
                       text-stone-500 dark:text-stone-400
                       hover:bg-stone-200/60 dark:hover:bg-stone-800/60
                       hover:text-stone-700 dark:hover:text-stone-200
                       transition-colors"
            aria-label="Dismiss notification"
          >
            Dismiss
          </button>
        </div>
      </div>
      <div className="prose-notification">
        <Markdown content={notification.body} />
      </div>
    </div>
  );
}
