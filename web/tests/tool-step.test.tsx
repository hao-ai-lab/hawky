// =============================================================================
// ToolStep + ToolLine component tests.
//
// Covers:
//   - collapsed-by-default headline + chevron
//   - expand reveals each ToolLine
//   - single-tool vs multi-tool headlines
//   - inline body (output) appears when expanded
//   - running/error status surface as non-green/red affordances
// =============================================================================

import { describe, it, expect } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { ToolStep } from "../src/components/ToolStep";
import { ToolLine, type ToolLineData } from "../src/components/ToolLine";

function tool(overrides: Partial<ToolLineData> = {}): ToolLineData {
  return {
    name: "bash",
    inputPreview: "echo hi",
    status: "success",
    output: "hi",
    isError: false,
    ...overrides,
  };
}

describe("ToolStep — collapsed state", () => {
  it("shows deterministic headline for a single tool", () => {
    render(<ToolStep tools={[tool({ name: "read_file", inputPreview: "src/foo.ts" })]} />);
    expect(screen.getByText("Read foo.ts")).toBeInTheDocument();
  });

  it("shows multi-tool headline for a parallel group", () => {
    render(<ToolStep tools={[
      tool({ name: "read_file", inputPreview: "a.ts" }),
      tool({ name: "read_file", inputPreview: "b.ts" }),
      tool({ name: "read_file", inputPreview: "c.ts" }),
    ]} />);
    expect(screen.getByText("3 reads")).toBeInTheDocument();
  });

  it("hides tool bodies when collapsed", () => {
    render(<ToolStep tools={[tool({ output: "secret-stdout" })]} />);
    expect(screen.queryByText("secret-stdout")).toBeNull();
  });

  it("renders a chevron SVG in the collapsed state", () => {
    render(<ToolStep tools={[tool()]} />);
    const button = screen.getByRole("button", { expanded: false });
    const svg = button.querySelector("svg");
    expect(svg).not.toBeNull();
    // Collapsed chevron should NOT carry the rotate-90 class yet
    expect(svg!.className.baseVal).not.toContain("rotate-90");
  });
});

describe("ToolStep — expand / collapse", () => {
  it("click expands and reveals tool bodies", () => {
    render(<ToolStep tools={[tool({ output: "hello world" })]} />);
    fireEvent.click(screen.getByRole("button", { expanded: false }));
    const expanded = screen.getByRole("button", { expanded: true });
    // Expanded chevron rotates 90° (same SVG glyph, different transform)
    const svg = expanded.querySelector("svg");
    expect(svg!.className.baseVal).toContain("rotate-90");
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });

  it("renders all tool lines once expanded", () => {
    render(<ToolStep defaultExpanded tools={[
      tool({ name: "read_file", inputPreview: "a.ts", output: "content of a" }),
      tool({ name: "grep", inputPreview: "TODO", output: "match-1" }),
    ]} />);
    // Both tool names appear
    expect(screen.getByText("read_file")).toBeInTheDocument();
    expect(screen.getByText("grep")).toBeInTheDocument();
    // And both outputs
    expect(screen.getByText("content of a")).toBeInTheDocument();
    expect(screen.getByText("match-1")).toBeInTheDocument();
  });
});

describe("ToolStep — status affordances", () => {
  it("running tools surface a neutral 'running…' label (no green)", () => {
    render(<ToolStep tools={[tool({ status: "running", output: "" })]} />);
    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });

  it("error tools surface an aria-labeled error dot (no red text)", () => {
    render(<ToolStep tools={[tool({ isError: true, output: "boom" })]} />);
    expect(screen.getByLabelText("has error")).toBeInTheDocument();
  });

  it("returns nothing for an empty step", () => {
    const { container } = render(<ToolStep tools={[]} />);
    expect(container.firstChild).toBeNull();
  });
});

describe("ToolLine", () => {
  it("renders tool name and input preview without a card frame", () => {
    const { container } = render(
      <ToolLine tool={tool({ name: "edit_file", inputPreview: "web/src/app.tsx" })} showBody={false} />,
    );
    expect(within(container).getByText("edit_file")).toBeInTheDocument();
    expect(within(container).getByText("web/src/app.tsx")).toBeInTheDocument();
    // No rounded border container — ToolLine is just a flex row
    expect(container.querySelector(".rounded-lg.border")).toBeNull();
  });

  it("hides body when showBody=false even if output is present", () => {
    render(<ToolLine tool={tool({ output: "should stay hidden" })} showBody={false} />);
    expect(screen.queryByText("should stay hidden")).toBeNull();
  });

  it("renders body when showBody=true and output is present", () => {
    render(<ToolLine tool={tool({ output: "visible output" })} showBody />);
    expect(screen.getByText("visible output")).toBeInTheDocument();
  });
});

// =============================================================================
// Visual hierarchy — labels must read as secondary metadata, not body prose.
// Pinned because the user explicitly called out that hawky's labels were
// too prominent vs Claude Code (sans 13px stone-500 vs serif 16px stone-800).
// =============================================================================

describe("ToolStep / ToolLine — secondary-text styling", () => {
  it("ToolStep headline uses 13px (text-[13px]) stone-500 to recede behind prose", () => {
    render(<ToolStep tools={[tool({ name: "read_file", inputPreview: "src/foo.ts" })]} />);
    const label = screen.getByText("Read foo.ts");
    expect(label.className).toContain("text-[13px]");
    expect(label.className).toContain("text-stone-500");
    expect(label.className).not.toContain("text-[#7e7c77]");
  });

  it("ToolStep chevron uses thinner stroke (1.75) and smaller box (w-3.5)", () => {
    render(<ToolStep tools={[tool()]} />);
    const svg = screen.getByRole("button").querySelector("svg")!;
    expect(svg.getAttribute("stroke-width")).toBe("1.75");
    expect(svg.className.baseVal).toContain("w-3.5");
    expect(svg.className.baseVal).toContain("h-3.5");
  });

  it("ToolLine inline tool-name pill uses stone-500 (not the old #7e7c77)", () => {
    const { container } = render(
      <ToolLine tool={tool({ name: "edit_file", inputPreview: "x.ts" })} showBody={false} />,
    );
    const pill = within(container).getByText("edit_file");
    expect(pill.className).toContain("text-stone-500");
    expect(pill.className).not.toContain("text-[#7e7c77]");
  });
});

// =============================================================================
// Full-input visibility — the expanded row must show the COMPLETE command /
// path / pattern, not the 80-char-clipped preview label.
// =============================================================================

describe("ToolLine — full input is visible when expanded", () => {
  const LONG_CMD =
    "mkdir -p /home/hao/.hawky/state/student-triage/2026-04-22-trial-25-26/scored " +
    "&& echo 'ok, ok, ok' && find /home/hao -type f -name '*.yaml' -print0 | xargs -0 grep -l xyz";

  it("renders the full bash command from tool.fullInput (no ellipsis)", () => {
    const { container } = render(
      <ToolLine
        tool={tool({
          name: "bash",
          // inputPreview is intentionally truncated (formatToolPreview caps at 80)
          inputPreview: LONG_CMD.slice(0, 80) + "...",
          fullInput: LONG_CMD,
        })}
        showBody={false}
      />,
    );
    // Full command must appear somewhere
    expect(container.textContent).toContain(LONG_CMD);
    // The short preview's trailing ellipsis must NOT be rendered (we used fullInput)
    expect(container.textContent).not.toContain("...");
  });

  it("renders full file_path for edit_file from tool.fullInput", () => {
    const longPath = "/home/hao/projects/haoskills/student-triage/deeply/nested/" +
      "some-really-long-file-name-that-blows-past-80-chars.ts";
    const { container } = render(
      <ToolLine
        tool={tool({
          name: "edit_file",
          inputPreview: longPath.slice(0, 80) + "...",
          fullInput: longPath,
        })}
        showBody={false}
      />,
    );
    expect(container.textContent).toContain(longPath);
  });

  it("falls back to inputPreview when tool.fullInput is missing (legacy data)", () => {
    const { container } = render(
      <ToolLine
        tool={tool({
          name: "bash",
          inputPreview: "some legacy preview",
          // no fullInput
        })}
        showBody={false}
      />,
    );
    expect(container.textContent).toContain("some legacy preview");
  });

  it("wraps the input span instead of truncating (no `truncate` class)", () => {
    const { container } = render(
      <ToolLine
        tool={tool({ name: "bash", inputPreview: "echo hi", fullInput: "echo hi" })}
        showBody={false}
      />,
    );
    const span = within(container).getByText("echo hi");
    expect(span.className).not.toContain("truncate");
    expect(span.className).toContain("whitespace-pre-wrap");
    expect(span.className).toContain("break-all");
  });
});

// =============================================================================
// Tree-branch rail — parallel tools must render with T/L glyph connectors,
// not a single continuous border-left rail.
// =============================================================================

describe("ToolStep — tree-branch rail", () => {
  it("each expanded ToolLine is wrapped in a .tree-branch div", () => {
    const { container } = render(
      <ToolStep
        defaultExpanded
        tools={[
          tool({ name: "read_file", inputPreview: "a.ts" }),
          tool({ name: "read_file", inputPreview: "b.ts" }),
          tool({ name: "read_file", inputPreview: "c.ts" }),
        ]}
      />,
    );
    const branches = container.querySelectorAll(".tree-branch");
    expect(branches.length).toBe(3);
  });

  it("container no longer uses a single border-left rail", () => {
    // The old implementation put `border-l border-stone-200` on the children
    // container. The new tree visual draws per-child glyphs instead, so that
    // class must not be on the parent anymore (if it was, the two would
    // overlap into a muddled visual).
    const { container } = render(
      <ToolStep defaultExpanded tools={[tool(), tool()]} />,
    );
    const parent = container.querySelector(".tree-branch")?.parentElement;
    expect(parent).not.toBeNull();
    expect(parent!.className).not.toContain("border-l");
  });

  it("a single-tool step still wraps its child as a tree-branch", () => {
    // Consistency: we render the same glyph (an L-corner, since the sole
    // child is also the last-child) whether there's 1 tool or many.
    const { container } = render(
      <ToolStep defaultExpanded tools={[tool({ name: "bash", inputPreview: "ls" })]} />,
    );
    expect(container.querySelectorAll(".tree-branch").length).toBe(1);
  });
});
