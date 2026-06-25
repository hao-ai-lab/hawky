// =============================================================================
// Live preview overrides — DEV ONLY (presentation harness)
//
// Lets us render the Live screen's *connected* layouts (transcript, tool cards,
// chart artifacts, controls) without a real realtime session, so mobile layout
// work can be screenshotted deterministically. Activated by `?preview=<mode>`
// and ONLY when `import.meta.env.DEV` — it never runs in a production build.
//
// It does NOT touch `useRealtime`: the Live screen spreads the real hook result
// and overlays these presentation fields, so refs / sendText stay real and no
// realtime logic changes.
// =============================================================================

import type { LivePhase, TranscriptEntry } from "./useRealtime";

export type PreviewMode = "live-connected" | "live-charts" | "live-idle";

export function isPreviewMode(v: string | null): v is PreviewMode {
  return v === "live-connected" || v === "live-charts" || v === "live-idle";
}

/** Read the `?preview=` flag, honored only in DEV. */
export function previewModeFromLocation(): PreviewMode | null {
  if (!import.meta.env.DEV) return null;
  try {
    const v = new URLSearchParams(window.location.search).get("preview");
    return isPreviewMode(v) ? v : null;
  } catch {
    return null;
  }
}

// A small inline SVG "chart" so previews don't need a real chart tool result.
function fakeChart(title: string, bars: number[], color: string): string {
  const w = 520, h = 300, pad = 32;
  const max = Math.max(...bars, 1);
  const bw = (w - pad * 2) / bars.length;
  const rects = bars
    .map((b, i) => {
      const bh = ((b / max) * (h - pad * 2)) | 0;
      const x = pad + i * bw + bw * 0.15;
      const y = h - pad - bh;
      return `<rect x="${x}" y="${y}" width="${bw * 0.7}" height="${bh}" rx="4" fill="${color}"/>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
    <rect width="${w}" height="${h}" fill="#ffffff"/>
    <text x="${pad}" y="24" font-family="-apple-system,Inter,sans-serif" font-size="15" font-weight="600" fill="#111">${title}</text>
    <line x1="${pad}" y1="${h - pad}" x2="${w - pad}" y2="${h - pad}" stroke="#ddd"/>
    ${rects}
  </svg>`;
  return "data:image/svg+xml;utf8," + encodeURIComponent(svg);
}

function entry(e: Partial<TranscriptEntry> & { id: string; kind: TranscriptEntry["kind"]; text: string }): TranscriptEntry {
  return { at: "10:24", ...e };
}

const BASE: TranscriptEntry[] = [
  entry({ id: "p1", kind: "system", text: "Live session started" }),
  entry({ id: "p2", kind: "user", text: "Hey Hawky — how did our store sales trend this week?" }),
  entry({ id: "p3", kind: "assistant", text: "Let me pull the weekly numbers and chart them for you." }),
  entry({
    id: "p4",
    kind: "tool",
    text: "generate_chart(metric=\"sales\", range=\"7d\")",
    toolStatus: "ok",
    toolMs: 1840,
    toolDetail: "rendered weekly sales bar chart",
    imageTitle: "Weekly sales",
    imageData: fakeChart("Weekly sales ($k)", [12, 18, 9, 22, 27, 31, 24], "#f5a623"),
  }),
  entry({
    id: "p5",
    kind: "assistant",
    text: "Sales climbed through the week, peaking Friday at $31k — about 2.6× Wednesday's dip. Want me to break it down by category?",
  }),
];

const CHARTS_EXTRA: TranscriptEntry[] = [
  entry({ id: "p6", kind: "user", text: "Yes, by category please." }),
  entry({
    id: "p7",
    kind: "tool",
    text: "generate_chart(metric=\"sales\", by=\"category\")",
    toolStatus: "ok",
    toolMs: 1520,
    toolDetail: "rendered category breakdown",
    imageTitle: "Sales by category",
    imageData: fakeChart("Sales by category ($k)", [44, 31, 22, 14, 9], "#34c759"),
  }),
  entry({
    id: "p8",
    kind: "tool",
    text: "generate_chart(metric=\"returns\", range=\"7d\")",
    toolStatus: "ok",
    toolMs: 980,
    toolDetail: "rendered returns trend",
    imageTitle: "Returns this week",
    imageData: fakeChart("Returns this week", [3, 2, 4, 1, 2, 5, 2], "#ff3b30"),
  }),
];

/** Presentation fields to overlay onto the real useRealtime result in DEV. */
export function previewOverrides(mode: PreviewMode): {
  phase: LivePhase;
  transcript: TranscriptEntry[];
  micOn: boolean;
  cameraOn: boolean;
  staySilent: boolean;
  cocktailParty: boolean;
  safetyOn: boolean;
  speaking: boolean;
  canStart: boolean;
  bridgeOffline: boolean;
  error: string | null;
  historyLoading: boolean;
} {
  if (mode === "live-idle") {
    return base("idle", []);
  }
  if (mode === "live-charts") {
    return { ...base("connected", [...BASE, ...CHARTS_EXTRA]), cameraOn: true, speaking: true };
  }
  return { ...base("connected", BASE), cameraOn: true };
}

function base(phase: LivePhase, transcript: TranscriptEntry[]) {
  return {
    phase,
    transcript,
    micOn: phase === "connected",
    cameraOn: false,
    staySilent: false,
    cocktailParty: false,
    safetyOn: false,
    speaking: false,
    canStart: true,
    bridgeOffline: false,
    error: null,
    historyLoading: false,
  };
}
