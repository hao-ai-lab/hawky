import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { AskUserDialog } from "../src/components/AskUserDialog";
import { useSessionStore } from "../src/store/session-store";
import { useSocketStore } from "../src/store/socket-store";

beforeEach(() => {
  useSessionStore.setState({ pendingAskUser: null });
  useSocketStore.setState({
    rpc: vi.fn(async () => ({})) as any,
  } as any);
});

describe("AskUserDialog", () => {
  it("renders nothing when no pending ask_user", () => {
    const { container } = render(<AskUserDialog />);
    expect(container.innerHTML).toBe("");
  });

  it("shows dialog with question", () => {
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-1",
        question: "Which language do you prefer?",
        options: ["Python", "TypeScript", "Rust"],
      },
    });
    render(<AskUserDialog />);
    // The dialog renders the question directly as prose — no "Question" label.
    expect(screen.getByText("Which language do you prefer?")).toBeInTheDocument();
    expect(screen.getByRole("dialog", { name: /agent question/i })).toBeInTheDocument();
  });

  it("shows option buttons when options provided", () => {
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-1",
        question: "Pick one",
        options: ["Option A", "Option B"],
      },
    });
    render(<AskUserDialog />);
    expect(screen.getByText("Option A")).toBeInTheDocument();
    expect(screen.getByText("Option B")).toBeInTheDocument();
  });

  it("shows 'Type something else…' escape option", () => {
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-1",
        question: "Pick one",
        options: ["Option A"],
      },
    });
    render(<AskUserDialog />);
    expect(screen.getByText("Type something else…")).toBeInTheDocument();
  });

  it("clears pending on option click", () => {
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-1",
        question: "Pick one",
        options: ["Option A", "Option B"],
      },
    });
    render(<AskUserDialog />);
    fireEvent.click(screen.getByText("Option A"));
    expect(useSessionStore.getState().pendingAskUser).toBeNull();
  });

  it("shows free-form input when no options", () => {
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-1",
        question: "What is your name?",
        options: [],
      },
    });
    render(<AskUserDialog />);
    expect(screen.getByPlaceholderText("Type your answer…")).toBeInTheDocument();
  });

  it("shows free-form input on 'Something else' click", () => {
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-1",
        question: "Pick one",
        options: ["Option A"],
      },
    });
    render(<AskUserDialog />);
    fireEvent.click(screen.getByText("Type something else…"));
    expect(screen.getByPlaceholderText("Type your answer…")).toBeInTheDocument();
  });

  it("submits free-form text on Enter", () => {
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-1",
        question: "What is your name?",
        options: [],
      },
    });
    render(<AskUserDialog />);
    const input = screen.getByPlaceholderText("Type your answer…");
    fireEvent.change(input, { target: { value: "Hao" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(useSessionStore.getState().pendingAskUser).toBeNull();
  });

  it("renders options as a vertical list with number chips (1, 2, 3)", () => {
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-1",
        question: "Pick one",
        options: ["A", "B", "C"],
      },
    });
    const { container } = render(<AskUserDialog />);
    const listItems = container.querySelectorAll('[role="listitem"]');
    expect(listItems.length).toBe(3);
    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    // "Something else" row also gets a chip — here number 4
    expect(screen.getByText("4")).toBeInTheDocument();
  });

  it("selects option via numeric keyboard shortcut (1–9)", () => {
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-1",
        question: "Pick one",
        options: ["A", "B", "C"],
      },
    });
    render(<AskUserDialog />);
    fireEvent.keyDown(window, { key: "2" });
    // Option B is at index 1 → "2" selects it and clears pending
    expect(useSessionStore.getState().pendingAskUser).toBeNull();
  });

  it("ignores numeric keypresses out of range", () => {
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-1",
        question: "Pick one",
        options: ["A", "B"],
      },
    });
    render(<AskUserDialog />);
    // Options are 1, 2; free-form chip is 3; "5" is past all of them.
    fireEvent.keyDown(window, { key: "5" });
    expect(useSessionStore.getState().pendingAskUser).not.toBeNull();
  });

  it("opens free-form input when the chip-N+1 digit is pressed", () => {
    // Free-form row is labelled with chip (options.length + 1).
    // Pressing that digit should match UI affordance and open the textbox.
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-1",
        question: "Pick one",
        options: ["A", "B"],
      },
    });
    render(<AskUserDialog />);
    fireEvent.keyDown(window, { key: "3" }); // N+1 where N=2
    expect(screen.getByPlaceholderText("Type your answer…")).toBeInTheDocument();
    // Pending stays (free-form not yet submitted)
    expect(useSessionStore.getState().pendingAskUser).not.toBeNull();
  });

  it("renders em-dash (no keyboard shortcut) on free-form row when N ≥ 9", () => {
    // With 9 options the free-form chip would be "10" — a two-digit label
    // no single keypress can trigger. Should render "—" instead.
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-1",
        question: "Pick one",
        options: ["A", "B", "C", "D", "E", "F", "G", "H", "I"],
      },
    });
    render(<AskUserDialog />);
    expect(screen.getByText("—")).toBeInTheDocument();
    // No "10" chip should appear
    expect(screen.queryByText("10")).toBeNull();
  });

  it("ignores numeric keypresses while free-form input is active", () => {
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-1",
        question: "Pick one",
        options: ["A", "B"],
      },
    });
    render(<AskUserDialog />);
    fireEvent.click(screen.getByText("Type something else…"));
    // Now the input is showing — digits should NOT trigger selection
    fireEvent.keyDown(window, { key: "1" });
    expect(useSessionStore.getState().pendingAskUser).not.toBeNull();
  });

  it("disables Submit button when empty", () => {
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-1",
        question: "Name?",
        options: [],
      },
    });
    render(<AskUserDialog />);
    // Submit is now an icon button with aria-label
    expect(screen.getByLabelText("Submit")).toBeDisabled();
  });

  // ---------------------------------------------------------------------------
  // Markdown rendering — pinned because a real session showed an unreadable
  // multi-section question with `**Travel/timing:**` literals + run-together
  // numbered lists. Question must render as markdown, not plain text.
  // ---------------------------------------------------------------------------

  it("renders **bold** as <strong> rather than printing literal asterisks", () => {
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-md-bold",
        question: "I need **two things** from you.",
        options: [],
      },
    });
    const { container } = render(<AskUserDialog />);
    expect(container.querySelector("strong")?.textContent).toBe("two things");
    // The literal asterisks must NOT appear anywhere in the rendered text.
    expect(container.textContent).not.toContain("**");
  });

  it("renders numbered list items as a real <ol> instead of a single run-on paragraph", () => {
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-md-list",
        question: "Pick one of:\n\n1. Apples\n2. Bananas\n3. Cherries\n",
        options: [],
      },
    });
    const { container } = render(<AskUserDialog />);
    const ol = container.querySelector("ol");
    expect(ol).not.toBeNull();
    expect(ol!.querySelectorAll("li").length).toBe(3);
  });

  // Codex P2 regression guards: safeMode on ask-user markdown.
  it("does NOT turn `$HOME and $PATH` into math (shell-var preservation)", () => {
    // Without safeMode, remark-math would pair the two `$` and render
    // `HOME and` as a math expression, dropping the closing `$` from the
    // user's instruction. Coding prompts routinely mention env vars, so
    // the dialog must preserve them literally.
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-shellvar",
        question: "Use $HOME and $PATH before continuing.",
        options: [],
      },
    });
    const { container } = render(<AskUserDialog />);
    // Both dollar signs must survive intact in the DOM text.
    expect(container.textContent).toContain("$HOME");
    expect(container.textContent).toContain("$PATH");
    // No KaTeX math node should have been rendered.
    expect(container.querySelector(".katex")).toBeNull();
  });

  it("filters the backend's auto-appended 'Something else (type your answer)' option to avoid duplicating the dialog's free-form row", () => {
    // The backend `ask_user` tool auto-appends
    // `"Something else (type your answer)"` to options. The dialog
    // already renders its own "Type something else…" row at the
    // bottom. Without filtering, the user sees both and clicking the
    // backend's variant submits the literal string back to the agent
    // (which has no way to interpret it — agent gets a confusing
    // answer / appears to hang).
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-dup",
        question: "Pick one or describe your own:",
        options: ["A", "B", "C", "Something else (type your answer)"],
      },
    });
    render(<AskUserDialog />);
    // Real options visible.
    expect(screen.getByText("A")).toBeInTheDocument();
    expect(screen.getByText("B")).toBeInTheDocument();
    expect(screen.getByText("C")).toBeInTheDocument();
    // Backend sentinel is filtered out — only the dialog's own
    // italic "Type something else…" row remains.
    expect(screen.queryByText("Something else (type your answer)")).toBeNull();
    expect(screen.getByText("Type something else…")).toBeInTheDocument();
    // Number chips renumber accordingly: 1, 2, 3 for real options +
    // 4 for the free-form row. No 5.
    expect(screen.queryByText("5")).toBeNull();
  });

  it("does not echo the backend sentinel back to the agent if the user clicks the free-form row", () => {
    const rpc = vi.fn(async () => ({}));
    useSocketStore.setState({
      status: "connected", error: null, client: null, rpc: rpc as any,
      connect: vi.fn() as any, disconnect: vi.fn(),
      subscribe: vi.fn(() => () => {}), eventListeners: new Set(),
    });
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-dup",
        question: "Pick one:",
        options: ["A", "B", "Something else (type your answer)"],
      },
    });
    render(<AskUserDialog />);

    // Click the dialog's "Type something else…" row → opens free-form input.
    fireEvent.click(screen.getByText("Type something else…"));

    // No RPC has fired yet — we're now in free-form mode.
    expect(rpc).not.toHaveBeenCalled();
    // The free-form input is now visible.
    expect(screen.getByPlaceholderText("Type your answer…")).toBeInTheDocument();
  });

  it("renders image syntax as a text placeholder (no remote fetch)", () => {
    // ask_user content is model-generated — rendering `![x](https://...)`
    // as a real <img> would fire an unsolicited network request on display.
    // safeMode overrides the img component to show "[image: alt]" text.
    useSessionStore.setState({
      pendingAskUser: {
        requestId: "ask-img",
        question: "Need confirmation. ![preview](https://evil.example/pixel.png)",
        options: [],
      },
    });
    const { container } = render(<AskUserDialog />);
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("[image: preview]");
  });
});
