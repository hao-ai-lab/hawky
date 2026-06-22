// =============================================================================
// Chart artifacts: a fullscreen zoom lightbox, a right-side artifacts panel
// (chronological thumbnail list), and the collapsed edge tab that reopens it.
//
// Artifacts are derived from the Live transcript (every tool entry that
// produced an image). The panel mirrors them in time order; clicking any chart
// — inline or in the panel — opens the lightbox to zoom/pan.
// =============================================================================

import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import type { Artifact } from "../lib/useRealtime";

// -----------------------------------------------------------------------------
// Lightbox — fullscreen zoom + pan for a single chart.
// -----------------------------------------------------------------------------

export function ChartLightbox({ artifact, onClose }: { artifact: Artifact; onClose: () => void }) {
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);

  const MIN = 0.5, MAX = 6;
  const clamp = (s: number) => Math.min(MAX, Math.max(MIN, s));
  const zoomBy = (f: number) => setScale((s) => clamp(s * f));
  const reset = () => { setScale(1); setOffset({ x: 0, y: 0 }); };

  // Esc to close; +/-/0 to zoom.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "+" || e.key === "=") zoomBy(1.25);
      else if (e.key === "-") zoomBy(0.8);
      else if (e.key === "0") reset();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    zoomBy(e.deltaY < 0 ? 1.1 : 0.9);
  };
  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
  };
  const onPointerUp = () => { dragRef.current = null; };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/85 backdrop-blur-sm"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <span className="truncate text-sm font-medium text-white/90">{artifact.title}</span>
        <div className="flex items-center gap-1.5">
          <button onClick={() => zoomBy(0.8)} aria-label="Zoom out" title="Zoom out (-)"
            className="pressable grid h-8 w-8 place-items-center rounded-md bg-white/10 text-white/80 hover:bg-white/20">
            <Icon name="minus" className="h-4 w-4" />
          </button>
          <button onClick={reset} title="Reset zoom (0)"
            className="pressable grid h-8 min-w-[3.5rem] place-items-center rounded-md bg-white/10 px-2 text-xs font-medium text-white/80 hover:bg-white/20">
            {Math.round(scale * 100)}%
          </button>
          <button onClick={() => zoomBy(1.25)} aria-label="Zoom in" title="Zoom in (+)"
            className="pressable grid h-8 w-8 place-items-center rounded-md bg-white/10 text-white/80 hover:bg-white/20">
            <Icon name="plus" className="h-4 w-4" />
          </button>
          <button onClick={onClose} aria-label="Close" title="Close (Esc)"
            className="pressable ml-1 grid h-8 w-8 place-items-center rounded-md bg-white/10 text-white/80 hover:bg-white/20">
            <Icon name="xmark" className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div
        className="relative flex-1 cursor-grab overflow-hidden active:cursor-grabbing"
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <img
          src={artifact.src}
          alt={artifact.title}
          draggable={false}
          className="absolute left-1/2 top-1/2 max-h-none select-none rounded-lg bg-white shadow-2xl"
          style={{
            transform: `translate(-50%, -50%) translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
            transformOrigin: "center",
            maxWidth: "90vw",
            transition: dragRef.current ? "none" : "transform 0.08s ease-out",
          }}
        />
      </div>
      <div className="pb-3 text-center text-[11px] text-white/40">
        Scroll or +/− to zoom · drag to pan · Esc to close · {artifact.at}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Artifacts panel — chronological thumbnail cards.
// -----------------------------------------------------------------------------

export function ArtifactsPanel({
  artifacts,
  onOpen,
}: {
  artifacts: Artifact[];
  onOpen: (a: Artifact) => void;
}) {
  return (
    <div className="hidden w-[320px] shrink-0 flex-col border-l border-white/10 bg-paper/30 md:flex">
      {/* Header — show/hide is controlled by the Artifacts button in the chat
          header, so the panel has no collapse control of its own. */}
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3 text-sm font-semibold text-white">
        <Icon name="chart" className="h-4 w-4 text-accent" />
        Artifacts
        <span className="rounded-full bg-white/10 px-1.5 text-[11px] font-medium text-white/60">{artifacts.length}</span>
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {artifacts.length === 0 ? (
          <div className="px-2 py-8 text-center text-xs text-white/35">
            Charts you generate appear here, newest at the bottom.
          </div>
        ) : (
          artifacts.map((a) => (
            <button
              key={a.id}
              onClick={() => onOpen(a)}
              className="pressable group block w-full overflow-hidden rounded-card border border-white/10 bg-white/[0.03] text-left hover:border-accent/40"
              title={`Open "${a.title}"`}
            >
              <img src={a.src} alt={a.title} className="aspect-[8/5] w-full bg-white object-contain" />
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                <span className="truncate text-xs font-medium text-white/80">{a.title}</span>
                <span className="shrink-0 text-[10px] text-white/40">{a.at}</span>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Artifacts bottom sheet (mobile) — the side panel has no room on a phone, so
// the header Artifacts button opens this sheet instead. Tapping a chart opens
// the same zoom lightbox. Hidden on md+ (the side panel takes over there).
// -----------------------------------------------------------------------------

export function ArtifactsSheet({
  open,
  artifacts,
  onOpen,
  onClose,
}: {
  open: boolean;
  artifacts: Artifact[];
  onOpen: (a: Artifact) => void;
  onClose: () => void;
}) {
  // Close on Esc for keyboard users (e.g. an external keyboard).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end md:hidden" role="dialog" aria-modal="true" aria-label="Artifacts">
      <button aria-label="Close artifacts" onClick={onClose} className="absolute inset-0 bg-black/55 backdrop-blur-sm" />
      <div className="relative max-h-[78dvh] overflow-hidden rounded-t-glass border-t border-white/10 bg-paper shadow-glass pb-safe">
        {/* Grabber + header */}
        <div className="flex flex-col items-center pt-2">
          <span className="h-1.5 w-10 rounded-full bg-white/25" />
        </div>
        <div className="flex items-center gap-2 px-4 py-3 text-sm font-semibold text-white">
          <Icon name="chart" className="h-4 w-4 text-accent" />
          Artifacts
          <span className="rounded-full bg-white/10 px-1.5 text-[11px] font-medium text-white/60">{artifacts.length}</span>
          <button onClick={onClose} aria-label="Close" className="pressable ml-auto grid h-8 w-8 place-items-center rounded-full bg-white/10 text-white/80 hover:bg-white/20">
            <Icon name="xmark" className="h-4 w-4" />
          </button>
        </div>
        <div className="max-h-[64dvh] space-y-2.5 overflow-y-auto px-3 pb-4">
          {artifacts.length === 0 ? (
            <div className="px-2 py-10 text-center text-xs text-white/35">
              Charts you generate appear here, newest at the bottom.
            </div>
          ) : (
            artifacts.map((a) => (
              <button
                key={a.id}
                onClick={() => { onOpen(a); onClose(); }}
                className="pressable block w-full overflow-hidden rounded-card border border-white/10 bg-white/[0.03] text-left"
                title={`Open "${a.title}"`}
              >
                <img src={a.src} alt={a.title} className="aspect-[8/5] w-full bg-white object-contain" />
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <span className="truncate text-sm font-medium text-white/80">{a.title}</span>
                  <span className="shrink-0 text-[10px] text-white/40">{a.at}</span>
                </div>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Collapsed edge tab — reopens the panel; shows a count badge.
// -----------------------------------------------------------------------------

export function ArtifactsTab({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <button
      onClick={onOpen}
      aria-label="Show artifacts"
      title="Show artifacts"
      className="pressable absolute right-0 top-1/2 z-10 hidden -translate-y-1/2 flex-col items-center gap-1 rounded-l-lg border border-r-0 border-white/15 bg-paper/80 px-1.5 py-3 text-white/70 backdrop-blur hover:text-white md:flex"
    >
      <Icon name="chevronLeft" className="h-4 w-4" />
      <Icon name="chart" className="h-4 w-4 text-accent" />
      {count > 0 && (
        <span className="rounded-full bg-accent/80 px-1 text-[10px] font-bold text-white">{count}</span>
      )}
      <span className="text-[10px] [writing-mode:vertical-rl]">Artifacts</span>
    </button>
  );
}
