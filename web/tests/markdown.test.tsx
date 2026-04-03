// =============================================================================
// Tests: Markdown Component
//
// Unit tests for the Streamdown-based markdown renderer.
// Note: Streamdown wraps content in spans for animation, so we test
// content presence rather than exact HTML structure.
// =============================================================================

import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Markdown } from "../src/components/Markdown";

describe("Markdown rendering", () => {
  it("renders plain text", () => {
    render(<Markdown content="Hello world" />);
    expect(screen.getByText("Hello world")).toBeInTheDocument();
  });

  it("renders bold text content", () => {
    render(<Markdown content="This is **bold** text" />);
    // Streamdown wraps in spans — just verify the text is present
    expect(screen.getByText(/bold/)).toBeInTheDocument();
  });

  it("renders italic text content", () => {
    render(<Markdown content="This is *italic* text" />);
    expect(screen.getByText(/italic/)).toBeInTheDocument();
  });

  it("renders inline code", () => {
    render(<Markdown content="Use `npm install` to install" />);
    expect(screen.getByText("npm install")).toBeInTheDocument();
  });

  it("renders blockquote content", () => {
    render(<Markdown content="> This is a quote" />);
    expect(screen.getByText(/This is a quote/)).toBeInTheDocument();
  });

  it("renders strikethrough content", () => {
    render(<Markdown content="This is ~~deleted~~ text" />);
    expect(screen.getByText(/deleted/)).toBeInTheDocument();
  });

  it("renders empty content as null", () => {
    const { container } = render(<Markdown content="" />);
    expect(container.innerHTML).toBe("");
  });

  it("renders whitespace-only content as null", () => {
    const { container } = render(<Markdown content="   " />);
    expect(container.innerHTML).toBe("");
  });

  it("renders multi-paragraph content", () => {
    render(<Markdown content="Paragraph one.\n\nParagraph two." />);
    expect(screen.getByText(/Paragraph one/)).toBeInTheDocument();
    expect(screen.getByText(/Paragraph two/)).toBeInTheDocument();
  });

  it("renders content around horizontal rules", () => {
    render(<Markdown content="Above\n\n---\n\nBelow" />);
    expect(screen.getByText(/Above/)).toBeInTheDocument();
    expect(screen.getByText(/Below/)).toBeInTheDocument();
  });
});

describe("Single newlines become hard line breaks (remark-breaks)", () => {
  // Without remark-breaks, CommonMark soft-breaks a single `\n` into a space,
  // which collapses lines like:
  //   3 PRs need review.
  //   🔴 Conflict in 16 min...
  //   🔴 Conflict! overlapping meetings...
  // into one run-on paragraph. remark-breaks renders each single newline
  // as a visible <br> so chat-style text formats correctly.

  it("inserts a <br> for a single newline between two lines of prose", () => {
    const { container } = render(<Markdown content={"line one\nline two"} />);
    const brs = container.querySelectorAll("br");
    expect(brs.length).toBeGreaterThanOrEqual(1);
    expect(container.textContent).toContain("line one");
    expect(container.textContent).toContain("line two");
  });

  it("separates emoji-led lines instead of concatenating them", () => {
    // Real-world shape from a heartbeat delivery — three bullet-like lines.
    const input = "3 PRs need review.\n🔴 Conflict in 16 min\n🔴 Double-booked at 9 PM";
    const { container } = render(<Markdown content={input} />);
    const brs = container.querySelectorAll("br");
    // Two single newlines → at least two hard breaks inside one paragraph.
    expect(brs.length).toBeGreaterThanOrEqual(2);
  });

  it("does not insert <br> inside fenced code blocks", () => {
    // Inside a code block, remark-breaks must not touch internal newlines;
    // they're preserved as literal newlines in <pre><code>.
    const input = "before\n```\nline 1\nline 2\nline 3\n```\nafter";
    const { container } = render(<Markdown content={input} />);
    const code = container.querySelector("code");
    expect(code).not.toBeNull();
    // The code element contains literal newlines, not <br>.
    expect(code?.querySelectorAll("br").length).toBe(0);
    expect(code?.textContent).toContain("line 1");
    expect(code?.textContent).toContain("line 3");
  });
});

describe("Markdown streaming mode", () => {
  it("renders in streaming mode without error", () => {
    render(<Markdown content="This is being **streamed" isStreaming />);
    expect(screen.getByText(/This is being/)).toBeInTheDocument();
  });

  it("handles incomplete code fence in streaming", () => {
    // Should not crash — Streamdown handles incomplete fences
    const { container } = render(
      <Markdown content={"```javascript\nconst x = 1;"} isStreaming />,
    );
    expect(container.textContent).toContain("const");
  });

  it("renders complete markdown in static mode", () => {
    render(<Markdown content="**Bold** and *italic*" isStreaming={false} />);
    expect(screen.getByText(/Bold/)).toBeInTheDocument();
    expect(screen.getByText(/italic/)).toBeInTheDocument();
  });
});

describe("Currency dollar sign escaping", () => {
  it("renders single $amount as literal dollar sign, not math", () => {
    const { container } = render(
      <Markdown content="Price is $100.00 today" />,
    );
    expect(container.textContent).toContain("$100.00");
    expect(container.querySelector(".katex")).toBeNull();
  });

  it("renders parenthesized $amounts without remark-math pairing", () => {
    // Bug: $amount1 prose ($amount2) got paired by remark-math because `(` is
    // non-whitespace before the closing $, rendering prose in math font.
    const { container } = render(
      <Markdown content="The item costs $10.00, with tax ($11.00) above the base ($9.50)." />,
    );
    expect(container.textContent).toContain("$10.00");
    expect(container.textContent).toContain("$11.00");
    expect(container.textContent).toContain("$9.50");
    const katexElements = container.querySelectorAll(".katex");
    expect(katexElements.length).toBe(0);
  });

  it("renders bold $amount followed by another amount without breaking bold", () => {
    // Bug: **$amount1** prose $amount2 was paired as math because `*` before
    // the second $ is non-whitespace, consuming $ and breaking bold markers.
    const { container } = render(
      <Markdown content="需要降到 **$50.00** 从 $60 跌到 $40" />,
    );
    const strong = container.querySelector("strong");
    expect(strong).not.toBeNull();
    expect(strong!.textContent).toContain("$50.00");
    expect(container.querySelectorAll(".katex").length).toBe(0);
  });

  it("preserves display math ($$...$$)", () => {
    const { container } = render(
      <Markdown content="The formula: $$x^2 + y^2 = r^2$$" />,
    );
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("preserves inline math with non-digit content", () => {
    const { container } = render(
      <Markdown content="The variable $x$ is important" />,
    );
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("preserves inline math starting with a digit and letter", () => {
    // e.g. $2x + 3$ — digit followed by letter (no word boundary after digit)
    const { container } = render(
      <Markdown content="The equation $2x + 3$ is linear" />,
    );
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("preserves inline math with only digits", () => {
    // e.g. $2024$ — closing $ is not followed by more digits
    const { container } = render(
      <Markdown content="Year $2024$ was notable" />,
    );
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("preserves inline math with digit followed by backslash command", () => {
    // e.g. $0.5\alpha$ — backslash is not word, not dollar, and closing $ not followed by digit
    const { container } = render(
      <Markdown content={"Half alpha is $0.5\\alpha$ units"} />,
    );
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("preserves inline math with digit, space, and LaTeX commands", () => {
    // e.g. $1.5 \times 10^{23}$ — closing $ has no currency after it
    const { container } = render(
      <Markdown content={"Avogadro's number is $1.5 \\times 10^{23}$ per mole"} />,
    );
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("does not escape $ inside inline code", () => {
    const { container } = render(
      <Markdown content="Run `echo $100 and $200` in terminal" />,
    );
    expect(container.textContent).toContain("echo $100 and $200");
  });

  it("does not escape $ inside code blocks", () => {
    const { container } = render(
      <Markdown content={"```\nprice1=$50; price2=$100\n```"} />,
    );
    expect(container.textContent).toContain("price1=$50; price2=$100");
  });

  it("does not render CJK text between parenthesized currency amounts in math font", () => {
    // Bug: two currency $ paired by remark-math caused CJK characters
    // between them to render in KaTeX serif/math font.
    const { container } = render(
      <Markdown content="总价从 $10.00 降到 **$5.00** 一共省了 $5" />,
    );
    expect(container.textContent).toContain("$10.00");
    expect(container.textContent).toContain("$5.00");
    expect(container.textContent).toContain("总价");
    const katexElements = container.querySelectorAll(".katex");
    expect(katexElements.length).toBe(0);
  });

  it("preserves digit-only math when currency appears later in same paragraph", () => {
    // The lazy `[^$]*?` cannot cross the inner `$` of `$2024$`, so the regex
    // does NOT match `$2024$ costs $10`. Math is preserved, $10 is literal.
    const { container } = render(
      <Markdown content="Year $2024$ costs $10 today" />,
    );
    expect(container.querySelector(".katex")).not.toBeNull();
    expect(container.textContent).toContain("$10");
  });

  it("escapes currency pairs but preserves adjacent math after the pair", () => {
    // Currency-currency pair gets escaped; standalone math after the pair
    // is untouched (separate scan position, no `$` between them was crossed).
    const { container } = render(
      <Markdown content="Items ($10 each, $20 total), formula $2024$" />,
    );
    expect(container.textContent).toContain("$10");
    expect(container.textContent).toContain("$20");
    // Math $2024$ should still render
    expect(container.querySelector(".katex")).not.toBeNull();
  });

  it("does not intervene when second $ is preceded by whitespace", () => {
    // remark-math already rejects this case (closing $ can't have ws before it)
    // so no escaping needed — and escaping would be wrong.
    const { container } = render(
      <Markdown content="Costs $10.00 and $20.00 today" />,
    );
    expect(container.textContent).toContain("$10.00");
    expect(container.textContent).toContain("$20.00");
    expect(container.querySelectorAll(".katex").length).toBe(0);
  });

  it("handles $amount in table cells", () => {
    const { container } = render(
      <Markdown content="| Item | Price |\n|------|-------|\n| A | $10.00 |\n| B | $20 |" />,
    );
    expect(container.textContent).toContain("$10.00");
    expect(container.textContent).toContain("$20");
    expect(container.querySelectorAll(".katex").length).toBe(0);
  });
});

describe("Markdown className prop", () => {
  it("applies custom className", () => {
    const { container } = render(
      <Markdown content="Hello" className="custom-class" />,
    );
    expect(container.querySelector(".custom-class")).toBeInTheDocument();
  });

  it("always has markdown-content class", () => {
    const { container } = render(<Markdown content="Hello" />);
    expect(container.querySelector(".markdown-content")).toBeInTheDocument();
  });
});
