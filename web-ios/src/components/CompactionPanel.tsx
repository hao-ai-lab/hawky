import { type CompactionState, compactionBusy } from "../lib/realtime-compaction";

const labels: Record<CompactionState["phase"], string> = {
  idle: "Ready", summarizing: "Summarizing older messages and images…",
  waiting: "Summary ready — waiting for a quiet gap…", installing: "Replacing older context…",
  complete: "Context compacted", failed: "Compaction did not finish", cancelled: "Compaction stopped",
};
export function CompactionPanel({ state, onClose }: { state: CompactionState; onClose: () => void }) {
  return <section aria-label="Context compaction" className="mx-4 my-2 shrink-0 rounded-xl border border-white/15 bg-paper p-3 text-sm md:mx-6">
    <div className="flex items-center justify-between gap-3">
      <strong role="status" aria-live="polite">{labels[state.phase]}</strong>
      <button aria-label="Hide compaction details" onClick={onClose} className="rounded px-2 py-1 text-white/60 hover:bg-white/10">Hide</button>
    </div>
    <p className="mt-1 text-xs text-white/50">Current connection only. Recent turns and the newest image stay; your transcript stays intact. Reconnecting still uses the original history.</p>
    <div className="mt-2 max-h-[28vh] overflow-y-auto overscroll-contain break-words" tabIndex={0}>
      {!!state.selected && <p className="text-xs text-white/60">
        {state.selected} older items selected · {state.images} images · {state.deleted} removed from model context
        {state.remaining !== undefined && ` · ${state.remaining} message items remain`}
        {state.elapsedMs !== undefined && ` · ${(state.elapsedMs / 1000).toFixed(1)}s`}
      </p>}
      {state.error && <p role="alert" className="mt-2 text-amber-300">{state.error}</p>}
      {state.summary && <>
        <p className="mt-3 font-medium">{state.phase === "complete" ? "Installed summary" : "Generated summary"}</p>
        <p className="mt-1 whitespace-pre-wrap text-white/80">{state.summary}</p>
      </>}
      {compactionBusy(state) && <p className="mt-2 text-xs text-white/50">You can keep talking. Context replacement waits for a pause.</p>}
    </div>
  </section>;
}
