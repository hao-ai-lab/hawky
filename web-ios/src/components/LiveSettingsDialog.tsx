import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./Icon";
import { LiveSettingsPanel } from "./LiveSettingsPanel";

export function LiveSettingsDialog({ active, onClose }: { active: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    return () => dialog.close();
  }, []);
  return createPortal(
    // Ignore a queued close event from StrictMode cleanup if already reopened.
    <dialog ref={ref} aria-labelledby="live-settings-title" onClose={e => { if (!e.currentTarget.open) onClose(); }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      className="m-auto w-[calc(100%_-_2rem)] max-w-2xl max-h-[85dvh] overflow-hidden rounded-2xl border border-white/15 bg-canvas p-0 text-white shadow-glass backdrop:bg-black/60">
      <div className="flex max-h-[85dvh] flex-col">
        <header className="flex shrink-0 items-center justify-between gap-4 border-b border-white/10 px-5 py-3">
          <div>
            <h1 id="live-settings-title" className="text-base font-semibold">Live settings</h1>
            <p className="mt-1 text-xs text-white/55">{active ? "Session settings are saved for your next start." : "Choose how your next session sees, listens, and responds."}</p>
          </div>
          <button autoFocus aria-label="Close Live settings" onClick={onClose} className="grid h-11 w-11 shrink-0 place-items-center rounded-full hover:bg-white/10">
            <Icon name="xmark" className="h-5 w-5" />
          </button>
        </header>
        <div className="min-h-0 overflow-y-auto overscroll-contain p-4 sm:p-5"><LiveSettingsPanel /></div>
      </div>
    </dialog>, document.body,
  );
}
