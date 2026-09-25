// Deployment opt-in: local/self-hosted builds must not promise free API access.
export const hostedPreview = import.meta.env.VITE_HAWKY_HOSTED_PREVIEW === "true";

export function HostedPreviewNotice({ compact = false }: { compact?: boolean }) {
  if (!hostedPreview) return null;
  const explanation = <>Hawky provides API access and runs JoyAI and Venus on our servers during this free preview. No personal API key is needed for the included models. Capacity is limited; availability and pricing may change after the preview.</>;
  if (compact) return <details className="shrink-0 border-b border-accent/20 bg-accent/5 px-4 py-2 text-xs text-white/70 md:px-6">
    <summary className="cursor-pointer text-accent">Free preview · Model access provided by Hawky</summary>
    <p className="mt-2 max-w-2xl leading-relaxed">{explanation}</p>
  </details>;
  return <aside aria-label="Hosted model access" className="mb-5 rounded-xl border border-accent/25 bg-accent/5 p-4 text-sm">
    <p className="font-medium text-accent">Model access included · Free preview</p>
    <p className="mt-2 leading-relaxed text-white/70">{explanation}</p>
    <p className="mt-2 text-white/60">JoyAI includes speech recognition and spoken replies. Venus currently supports one live conversation at a time across this service.</p>
  </aside>;
}
