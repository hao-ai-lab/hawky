import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  localStorage.clear();
  vi.resetModules();
});

it("ignores a legacy browser prompt while preserving supported saved settings", async () => {
  localStorage.setItem("hawky-ios-live-settings", JSON.stringify({
    systemPrompt: "Use this obsolete browser override.",
    voice: "cedar",
    backendBridge: false,
  }));
  vi.resetModules();
  const { useLiveSettings } = await import("../src/lib/live-settings");

  expect(useLiveSettings.getState()).not.toHaveProperty("systemPrompt");
  expect(useLiveSettings.getState().voice).toBe("cedar");
  expect(useLiveSettings.getState().backendBridge).toBe(false);

  useLiveSettings.getState().set("voice", "marin");
  const saved = JSON.parse(localStorage.getItem("hawky-ios-live-settings")!);
  expect(saved).not.toHaveProperty("systemPrompt");
  expect(saved.voice).toBe("marin");
  expect(saved.backendBridge).toBe(false);
});
