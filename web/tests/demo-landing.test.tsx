import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DemoLanding } from "../src/components/DemoLanding";

function renderLanding() {
  const handlers = {
    onStartLive: vi.fn(),
    onOpenTranscription: vi.fn(),
    onOpenPeople: vi.fn(),
    onOpenSettings: vi.fn(),
  };
  render(<DemoLanding {...handlers} />);
  return handlers;
}

describe("DemoLanding", () => {
  it("lists the three demo features", () => {
    renderLanding();
    expect(screen.getByText("Live")).toBeInTheDocument();
    expect(screen.getByText("Transcription")).toBeInTheDocument();
    expect(screen.getByText("People")).toBeInTheDocument();
  });

  it("states the iOS-only caveats (glasses, native safety)", () => {
    renderLanding();
    expect(screen.getByText(/smart-glasses/i)).toBeInTheDocument();
    expect(screen.getByText(/Safety-vision/i)).toBeInTheDocument();
  });

  it("invokes the right handler from each CTA", () => {
    const h = renderLanding();
    fireEvent.click(screen.getByText("Start Live"));
    fireEvent.click(screen.getByText("Open Transcription"));
    fireEvent.click(screen.getByText("Open People"));
    expect(h.onStartLive).toHaveBeenCalledTimes(1);
    expect(h.onOpenTranscription).toHaveBeenCalledTimes(1);
    expect(h.onOpenPeople).toHaveBeenCalledTimes(1);
  });

  it("links to settings for the BYOK key", () => {
    const h = renderLanding();
    fireEvent.click(screen.getByRole("button", { name: /settings/i }));
    expect(h.onOpenSettings).toHaveBeenCalledTimes(1);
  });
});
