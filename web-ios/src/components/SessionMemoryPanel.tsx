import type { MemoryUpdate } from "../lib/session-memory";
export function SessionMemoryPanel({ state, onClose }: { state: MemoryUpdate; onClose: () => void }) {
  return <section aria-label="Session memory" className="mx-4 my-2 shrink-0 rounded-xl border border-white/15 bg-paper p-3 text-sm md:mx-6">
    <div className="flex items-center justify-between gap-3">
      <strong role="status">{state.phase === "updating" ? "Updating session memory…" : state.phase === "failed" ? "Memory update failed" : "Session memory"}</strong>
      <button onClick={onClose} aria-label="Hide session memory" className="rounded px-2 py-1 text-white/60 hover:bg-white/10">Hide</button>
    </div>
    <p className="mt-1 text-xs text-white/50">Saves conversation text for future sessions and daily memory. Your transcript stays intact.</p>
    <div className="mt-2 max-h-[28vh] overflow-y-auto overscroll-contain break-words" tabIndex={0}>
      {state.note && <p role={state.phase === "failed" ? "alert" : undefined}>{state.note}</p>}
      {state.revision !== undefined && <p className="my-2 text-xs text-white/50">Revision {state.revision} · {state.file}</p>}
      {state.summary && <p className="whitespace-pre-wrap">{state.summary}</p>}
    </div>
  </section>;
}
