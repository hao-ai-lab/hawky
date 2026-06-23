// =============================================================================
// generate_chart tool
//
// Renders a chart (bar/line/pie/doughnut/scatter) from data the AGENT supplies
// and returns it as a PNG image. The agent fetches/derives the numbers (via
// web_search/web_fetch or its own knowledge) and calls this with a structured
// spec; we draw it with chart.js onto a node-canvas surface — IN-PROCESS under
// bun (canvas@3 loads natively) — and return ToolResult{type:"image"}.
//
// The web-ios Live model can call it via tool.invoke (whitelisted); the backend
// chat agent can call it via the normal loop (registered in builtin.ts). In
// both cases the resulting image surfaces in the conversation (and the web app
// also mirrors the latest chart in a side panel).
// =============================================================================

import { createCanvas } from "canvas";
import { Chart, registerables, type ChartConfiguration, type ChartType } from "chart.js";
import type { ToolDefinition, ToolContext, ToolResult } from "../agent/types.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("tools/generate_chart");

Chart.register(...registerables);
// Sane global defaults for text/grid on the white background. Dataset colors
// are always passed explicitly below.
Chart.defaults.color = "#374151";
Chart.defaults.borderColor = "#e5e7eb";

// Accent-family palette (matches the app).
const PALETTE = [
  "#7c5cff", "#22d3ee", "#34d399", "#fbbf24", "#f87171",
  "#a78bfa", "#60a5fa", "#f472b6", "#4ade80", "#fb923c",
];

const ALLOWED_TYPES = ["bar", "line", "pie", "doughnut", "scatter"] as const;
type ChartKind = (typeof ALLOWED_TYPES)[number];

interface Series {
  label?: string;
  data: number[];
  color?: string;
}

interface GenerateChartInput {
  type?: ChartKind;
  title?: string;
  labels?: string[];
  series: Series[];
  xLabel?: string;
  yLabel?: string;
  width?: number;
  height?: number;
}

/** Build the chart.js config from the validated input. Exported for testing. */
export function buildChartConfig(input: GenerateChartInput): ChartConfiguration {
  const type = (input.type || "bar") as ChartKind;
  const isCircular = type === "pie" || type === "doughnut";
  const series = input.series;

  const datasets = series.map((s, i) => {
    const base = s.color || PALETTE[i % PALETTE.length];
    if (isCircular) {
      const colors = (s.data || []).map((_, j) => PALETTE[j % PALETTE.length]);
      return { label: s.label || "", data: s.data || [], backgroundColor: colors, borderColor: "#ffffff", borderWidth: 2 };
    }
    if (type === "line") {
      return { label: s.label || `series ${i + 1}`, data: s.data || [], borderColor: base, backgroundColor: base + "33", borderWidth: 2, pointRadius: 3, tension: 0.25, fill: false };
    }
    if (type === "scatter") {
      return { label: s.label || `series ${i + 1}`, data: s.data || [], backgroundColor: base, borderColor: base, pointRadius: 4 };
    }
    return { label: s.label || `series ${i + 1}`, data: s.data || [], backgroundColor: base, borderColor: base, borderWidth: 1 };
  });

  const showLegend = isCircular || series.length > 1;

  return {
    type: type as ChartType,
    data: { labels: input.labels || [], datasets: datasets as any },
    options: {
      responsive: false,
      animation: false,
      devicePixelRatio: 1,
      layout: { padding: 16 },
      plugins: {
        legend: { display: showLegend, labels: { color: "#1f2430", font: { size: 13 } } },
        title: input.title
          ? { display: true, text: String(input.title), color: "#111827", font: { size: 18, weight: "bold" } }
          : { display: false },
      },
      scales: isCircular
        ? {}
        : {
            x: {
              title: input.xLabel ? { display: true, text: String(input.xLabel) } : { display: false },
              grid: { color: "#e5e7eb" },
            },
            y: {
              title: input.yLabel ? { display: true, text: String(input.yLabel) } : { display: false },
              grid: { color: "#e5e7eb" },
              beginAtZero: true,
            },
          },
    },
  };
}

/** Render a chart spec to a PNG buffer. Exported for testing. */
export function renderChartPng(input: GenerateChartInput): Buffer {
  const width = Math.min(Math.max(Number(input.width) || 800, 200), 2000);
  const height = Math.min(Math.max(Number(input.height) || 500, 150), 2000);

  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  // chart.js touches canvas.style under DOM; shim it for node-canvas.
  (canvas as unknown as { style: unknown }).style = {};
  // Opaque white background — a transparent PNG is invisible on dark chat.
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);

  const chart = new Chart(ctx as unknown as CanvasRenderingContext2D, buildChartConfig(input));
  try {
    return canvas.toBuffer("image/png");
  } finally {
    chart.destroy();
  }
}

export async function executeGenerateChart(
  input: GenerateChartInput,
  _context: ToolContext,
): Promise<ToolResult> {
  // --- validate ---
  const type = (typeof input.type === "string" ? input.type.trim().toLowerCase() : "bar") as ChartKind;
  if (!ALLOWED_TYPES.includes(type)) {
    return { type: "error", content: `Unsupported chart type "${type}". Allowed: ${ALLOWED_TYPES.join(", ")}.` };
  }
  const series = Array.isArray(input.series) ? input.series : [];
  const usable = series.filter((s) => s && Array.isArray(s.data) && s.data.length > 0);
  if (usable.length === 0) {
    return { type: "error", content: "generate_chart needs at least one series with a non-empty `data` array of numbers." };
  }
  // Coerce/guard the numbers — drop NaN/non-finite, keep the shape.
  for (const s of usable) {
    s.data = s.data.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0));
  }

  try {
    const png = renderChartPng({ ...input, type, series: usable });
    const base64 = png.toString("base64");
    const seriesDesc = usable.map((s) => s.label).filter(Boolean).join(", ");
    log.info("generate_chart rendered", { type, series: usable.length, bytes: png.length });
    return {
      type: "image",
      content: `Generated a ${type} chart${input.title ? ` titled "${input.title}"` : ""}${seriesDesc ? ` (${seriesDesc})` : ""}.`,
      base64,
      media_type: "image/png",
      metadata: {
        chart_type: type,
        title: input.title ?? null,
        series_count: usable.length,
        points: usable[0].data.length,
      },
    };
  } catch (err) {
    return { type: "error", content: `Chart render failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const generateChartToolDefinition: ToolDefinition<GenerateChartInput> = {
  name: "generate_chart",
  description:
    "Render a chart/graph as an image from data you provide. Use this when the user asks to " +
    "see, plot, visualize, or graph statistics or numbers (e.g. \"show me a chart of X\", " +
    "\"plot these values\", \"compare A vs B\"). YOU supply the data points — gather them FIRST, " +
    "then ALWAYS call this to visualize (don't just report numbers as text). For US public-company " +
    "financials, prefer SEC EDGAR's structured JSON (data.sec.gov) over a long article. Otherwise " +
    "use web_search → web_fetch, or your own knowledge. Then call this with a `series`. Supports " +
    "bar, line, pie, doughnut, and scatter. The chart appears in the conversation.",
  input_schema: {
    type: "object",
    properties: {
      type: {
        type: "string",
        enum: [...ALLOWED_TYPES],
        description: "Chart type. Default \"bar\". Use \"line\" for trends/time series, \"pie\"/\"doughnut\" for parts of a whole, \"scatter\" for x/y points.",
      },
      title: { type: "string", description: "Chart title shown at the top." },
      labels: {
        type: "array",
        items: { type: "string", description: "A category/x-axis label." },
        description: "Category or x-axis labels, one per data point (e.g. [\"Q1\",\"Q2\",\"Q3\",\"Q4\"]).",
      },
      series: {
        type: "array",
        items: { type: "object", description: "A series object: { label?: string, data: number[], color?: string (hex) }." },
        description:
          "One or more data series to plot. Each item is an object of the form " +
          "{ \"label\": \"2025\", \"data\": [12, 19, 8, 25], \"color\": \"#7c5cff\" } where `data` is " +
          "an array of numbers aligned with `labels`, `label` is the series name (legend), and " +
          "`color` is an optional hex color (auto-assigned if omitted). For pie/doughnut, use a single series.",
      },
      xLabel: { type: "string", description: "Optional x-axis title." },
      yLabel: { type: "string", description: "Optional y-axis title." },
      width: { type: "number", description: "Optional pixel width (200–2000, default 800)." },
      height: { type: "number", description: "Optional pixel height (150–2000, default 500)." },
    },
    required: ["series"],
  },
  // Rendering a chart from supplied data is a pure, side-effect-free computation.
  permission: "auto_approve",
  execute: executeGenerateChart as any,
};
