// In-app toast stack for fired reminders/notifications (notification.received).
import { useNotifications } from "../lib/notifications";
import { Icon } from "./Icon";

export function Toaster() {
  const toasts = useNotifications((s) => s.toasts);
  const dismiss = useNotifications((s) => s.dismiss);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
      {toasts.map((t) => (
        <div key={t.id} className="pointer-events-auto flex items-start gap-3 rounded-card border border-white/10 bg-paper/95 p-3 shadow-glass backdrop-blur">
          <Icon name="bell" className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium text-white">{t.title ?? "Reminder"}</div>
            <div className="mt-0.5 break-words text-sm text-white/70">{t.body}</div>
            <div className="mt-1 text-[10px] text-white/35">{t.origin ? `${t.origin} · ` : ""}{t.at}</div>
          </div>
          <button onClick={() => dismiss(t.id)} aria-label="Dismiss" className="grid h-6 w-6 shrink-0 place-items-center rounded-full hover:bg-white/10">
            <Icon name="xmark" className="h-4 w-4 text-white/50" />
          </button>
        </div>
      ))}
    </div>
  );
}
