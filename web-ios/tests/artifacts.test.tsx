import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { artifactsFromTranscript, type TranscriptEntry, type Artifact } from "../src/lib/useRealtime";
import { ChartLightbox, ArtifactsPanel, ArtifactsTab } from "../src/components/ChartArtifacts";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

function toolEntry(id: string, opts: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return { id, kind: "tool", text: "Charting: X", at: "10:00 PM", toolStatus: "ok", ...opts };
}

describe("artifactsFromTranscript", () => {
  it("collects only tool entries with imageData, in transcript (chronological) order", () => {
    const transcript: TranscriptEntry[] = [
      { id: "u1", kind: "user", text: "hi", at: "10:00 PM" },
      toolEntry("t1", { imageData: PNG, imageTitle: "Apple Revenue", at: "10:01 PM" }),
      { id: "a1", kind: "assistant", text: "here", at: "10:01 PM" },
      toolEntry("t2", { imageData: PNG, imageTitle: "Tesla Deliveries", at: "10:02 PM" }),
      toolEntry("t3", { /* no image */ at: "10:03 PM" }),
    ];
    const arts = artifactsFromTranscript(transcript);
    expect(arts.map((a) => a.id)).toEqual(["t1", "t2"]);
    expect(arts.map((a) => a.title)).toEqual(["Apple Revenue", "Tesla Deliveries"]);
    expect(arts[0].at).toBe("10:01 PM");
  });

  it("falls back to the entry text when no imageTitle", () => {
    const arts = artifactsFromTranscript([toolEntry("t1", { imageData: PNG, text: "Charting: Fallback" })]);
    expect(arts[0].title).toBe("Charting: Fallback");
  });
});

describe("ArtifactsPanel", () => {
  const arts: Artifact[] = [
    { id: "t1", src: PNG, title: "Apple Revenue", at: "10:01 PM" },
    { id: "t2", src: PNG, title: "Tesla Deliveries", at: "10:02 PM" },
  ];

  it("lists every artifact with its title + time and a count badge", () => {
    render(<ArtifactsPanel artifacts={arts} onOpen={() => {}} />);
    expect(screen.getByText("Apple Revenue")).toBeInTheDocument();
    expect(screen.getByText("Tesla Deliveries")).toBeInTheDocument();
    expect(screen.getByText("10:01 PM")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument(); // count badge
  });

  it("opens an artifact on card click", () => {
    const onOpen = vi.fn();
    render(<ArtifactsPanel artifacts={arts} onOpen={onOpen} />);
    fireEvent.click(screen.getByTitle('Open "Apple Revenue"'));
    expect(onOpen).toHaveBeenCalledWith(arts[0]);
  });

  it("has no collapse control of its own (toggled from the chat header)", () => {
    render(<ArtifactsPanel artifacts={arts} onOpen={() => {}} />);
    expect(screen.queryByLabelText("Collapse artifacts")).toBeNull();
  });

  it("shows an empty hint when there are no artifacts", () => {
    render(<ArtifactsPanel artifacts={[]} onOpen={() => {}} />);
    expect(screen.getByText(/Charts you generate appear here/)).toBeInTheDocument();
  });
});

describe("ArtifactsTab (collapsed)", () => {
  it("shows the count and opens on click", () => {
    const onOpen = vi.fn();
    render(<ArtifactsTab count={3} onOpen={onOpen} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Show artifacts"));
    expect(onOpen).toHaveBeenCalled();
  });
});

describe("ChartLightbox zoom", () => {
  const art: Artifact = { id: "t1", src: PNG, title: "Apple Revenue", at: "10:01 PM" };

  it("renders the chart title and starts at 100%", () => {
    render(<ChartLightbox artifact={art} onClose={() => {}} />);
    expect(screen.getByText("Apple Revenue")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("zooms in and out with the buttons", () => {
    render(<ChartLightbox artifact={art} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(screen.getByText("125%")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Zoom out"));
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("resets zoom via the percentage button", () => {
    render(<ChartLightbox artifact={art} onClose={() => {}} />);
    fireEvent.click(screen.getByLabelText("Zoom in"));
    fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(screen.queryByText("100%")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/^\d+%$/)); // the reset button
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("closes on the close button and on Escape", () => {
    const onClose = vi.fn();
    const { unmount } = render(<ChartLightbox artifact={art} onClose={onClose} />);
    fireEvent.click(screen.getByLabelText("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount();

    const onClose2 = vi.fn();
    render(<ChartLightbox artifact={art} onClose={onClose2} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose2).toHaveBeenCalled();
  });

  it("does not zoom below 50% or above 600%", () => {
    render(<ChartLightbox artifact={art} onClose={() => {}} />);
    // many zoom-outs → clamp at 50%
    for (let i = 0; i < 10; i++) fireEvent.click(screen.getByLabelText("Zoom out"));
    expect(screen.getByText("50%")).toBeInTheDocument();
    // many zoom-ins → clamp at 600%
    for (let i = 0; i < 30; i++) fireEvent.click(screen.getByLabelText("Zoom in"));
    expect(screen.getByText("600%")).toBeInTheDocument();
  });
});
