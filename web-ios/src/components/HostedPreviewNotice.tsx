import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";

// Deployment opt-in: local/self-hosted builds must not promise free API access.
export const hostedPreview = import.meta.env.VITE_HAWKY_HOSTED_PREVIEW === "true";

export function HostedPreviewNotice({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event: PointerEvent) => {
      if (!container.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  if (!hostedPreview) return null;
  const explanation = <>Hawky provides API access and runs JoyAI and Venus on our servers during this free preview. No personal API key is needed for the included models. Capacity is limited; availability and pricing may change after the preview.</>;
  if (compact) return <div ref={container} className="min-w-max flex-1 text-center"
    onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false); }}
    onKeyDown={event => { if (event.key === "Escape") { setOpen(false); button.current?.focus(); } }}>
    <button ref={button} onClick={() => setOpen(value => !value)} aria-expanded={open} aria-controls="hosted-preview-details"
      className="pressable inline-flex min-h-11 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-1 text-xs text-accent hover:bg-accent/10">
      Free preview <Icon name="chevronDown" className={`h-3 w-3 transition-transform ${open ? "rotate-180" : ""}`} />
    </button>
    {open && <div id="hosted-preview-details" className="absolute inset-x-3 top-full z-50 mx-auto mt-2 max-w-lg rounded-xl border border-accent/25 bg-paper p-4 text-left text-sm shadow-xl">
      <p className="font-medium text-accent">Model access provided by Hawky</p>
      <p className="mt-2 leading-relaxed text-white/70">{explanation}</p>
    </div>}
  </div>;
  return <aside aria-label="Hosted model access" className="mb-5 rounded-xl border border-accent/25 bg-accent/5 p-4 text-sm">
    <p className="font-medium text-accent">Model access included · Free preview</p>
    <p className="mt-2 leading-relaxed text-white/70">{explanation}</p>
    <p className="mt-2 text-white/60">JoyAI includes speech recognition and spoken replies. Venus currently supports one live conversation at a time across this service.</p>
  </aside>;
}
