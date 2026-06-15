import { describe, test, expect } from "bun:test";
import {
  executeGenerateChart,
  generateChartToolDefinition,
  renderChartPng,
  buildChartConfig,
} from "../src/tools/generate_chart.js";
import type { ToolContext } from "../src/agent/types.js";

// ---------------------------------------------------------------------------
// generate_chart unit tests. Render runs in-process (canvas@3 + chart.js under
// bun). We assert valid PNG output, the ToolResult shape, and validation.
// ---------------------------------------------------------------------------

const ctx: ToolContext = {
  session_id: "test",
  working_directory: process.cwd(),
  abort_signal: new AbortController().signal,
  emit: () => {},
  headless: true,
};

function isPng(buf: Buffer): boolean {
  return buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
}

describe("generate_chart definition", () => {
  test("is auto-approve and requires series", () => {
    expect(generateChartToolDefinition.name).toBe("generate_chart");
    expect(generateChartToolDefinition.permission).toBe("auto_approve");
    expect(generateChartToolDefinition.input_schema.required).toContain("series");
  });
});

describe("renderChartPng", () => {
  test("renders a non-empty valid PNG for a bar chart", () => {
    const png = renderChartPng({ type: "bar", labels: ["A", "B"], series: [{ data: [1, 2] }] });
    expect(isPng(png)).toBe(true);
    expect(png.length).toBeGreaterThan(1000);
  });

  test("respects width/height bounds (clamped)", () => {
    const png = renderChartPng({ type: "bar", series: [{ data: [1] }], width: 50, height: 99999 });
    // 50 → clamped up to 200, 99999 → clamped to 2000; still a valid PNG.
    expect(isPng(png)).toBe(true);
  });

  test("buildChartConfig assigns palette colors per series for bar", () => {
    const cfg = buildChartConfig({ type: "bar", series: [{ data: [1] }, { data: [2] }] });
    const ds = cfg.data.datasets as any[];
    expect(ds).toHaveLength(2);
    expect(ds[0].backgroundColor).toBe("#7c5cff");
    expect(ds[1].backgroundColor).toBe("#22d3ee");
  });

  test("buildChartConfig gives pie a per-slice color array", () => {
    const cfg = buildChartConfig({ type: "pie", labels: ["x", "y", "z"], series: [{ data: [1, 2, 3] }] });
    const ds = cfg.data.datasets as any[];
    expect(Array.isArray(ds[0].backgroundColor)).toBe(true);
    expect(ds[0].backgroundColor).toHaveLength(3);
  });
});

describe("executeGenerateChart", () => {
  test("returns an image ToolResult with base64 PNG + metadata", async () => {
    const r = await executeGenerateChart(
      { type: "bar", title: "Q", labels: ["Q1", "Q2"], series: [{ label: "s", data: [3, 6] }] },
      ctx,
    );
    expect(r.type).toBe("image");
    if (r.type === "image") {
      expect(r.media_type).toBe("image/png");
      expect(isPng(Buffer.from(r.base64, "base64"))).toBe(true);
      expect(r.metadata?.chart_type).toBe("bar");
      expect(r.metadata?.points).toBe(2);
      expect(r.content).toContain("bar chart");
    }
  });

  test("errors on empty series", async () => {
    const r = await executeGenerateChart({ series: [] } as any, ctx);
    expect(r.type).toBe("error");
    expect(r.content).toMatch(/series|data/i);
  });

  test("errors on unsupported chart type", async () => {
    const r = await executeGenerateChart({ type: "donut3d" as any, series: [{ data: [1] }] }, ctx);
    expect(r.type).toBe("error");
    expect(r.content).toMatch(/unsupported/i);
  });

  test("coerces non-finite numbers to 0 rather than failing", async () => {
    const r = await executeGenerateChart(
      { type: "bar", series: [{ data: [1, NaN as any, Infinity as any, 4] }] },
      ctx,
    );
    expect(r.type).toBe("image");
  });
});
