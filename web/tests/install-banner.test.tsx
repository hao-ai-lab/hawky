// =============================================================================
// Tests: Install Banner
//
// Unit tests for the iOS "Add to Home Screen" install banner.
// =============================================================================

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { InstallBanner } from "../src/components/InstallBanner";

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, value: string) => { store[key] = value; },
    removeItem: (key: string) => { delete store[key]; },
    clear: () => { store = {}; },
  };
})();

beforeEach(() => {
  localStorageMock.clear();
  Object.defineProperty(window, "localStorage", { value: localStorageMock, writable: true });
  // Default: not iOS, not standalone
  Object.defineProperty(navigator, "userAgent", { value: "Mozilla/5.0", writable: true, configurable: true });
  Object.defineProperty(window, "matchMedia", {
    value: vi.fn(() => ({ matches: false })),
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("InstallBanner", () => {
  it("does not show on non-iOS devices", () => {
    const { container } = render(<InstallBanner />);
    expect(container.querySelector("[data-testid='install-banner']")).toBeNull();
  });

  it("shows on iOS Safari when not standalone", () => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      configurable: true,
    });
    render(<InstallBanner />);
    expect(screen.getByText("Install Hawky")).toBeInTheDocument();
  });

  it("does not show on iOS Chrome (CriOS)", () => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1",
      configurable: true,
    });
    const { container } = render(<InstallBanner />);
    expect(container.querySelector("[data-testid='install-banner']")).toBeNull();
  });

  it("does not show on iOS when already in standalone mode", () => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      configurable: true,
    });
    Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
    const { container } = render(<InstallBanner />);
    expect(container.querySelector("[data-testid='install-banner']")).toBeNull();
  });

  it("dismiss hides the banner and stores in localStorage", () => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      configurable: true,
    });
    Object.defineProperty(navigator, "standalone", { value: false, configurable: true });
    render(<InstallBanner />);
    expect(screen.getByText("Install Hawky")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Dismiss install banner"));
    expect(screen.queryByText("Install Hawky")).not.toBeInTheDocument();
    expect(localStorageMock.getItem("hawky-install-dismissed")).toBe("true");
  });

  it("does not show if previously dismissed", () => {
    localStorageMock.setItem("hawky-install-dismissed", "true");
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      configurable: true,
    });
    Object.defineProperty(navigator, "standalone", { value: false, configurable: true });
    const { container } = render(<InstallBanner />);
    expect(container.querySelector("[data-testid='install-banner']")).toBeNull();
  });

  it("shows instructions text", () => {
    Object.defineProperty(navigator, "userAgent", {
      value: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
      configurable: true,
    });
    Object.defineProperty(navigator, "standalone", { value: false, configurable: true });
    render(<InstallBanner />);
    // "Share → Add to Home Screen" text — may be split across elements
    expect(screen.getByText(/Add to Home Screen/)).toBeInTheDocument();
  });
});
