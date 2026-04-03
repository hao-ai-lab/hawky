// =============================================================================
// Tests: Settings Panel — model dropdowns and provider-aware UI
//
// Covers:
//   1. Heartbeat model custom-value regression (model pruned from KNOWN_MODELS).
//   2. Model list: Anthropic/Vertex credentials -> Claude options; OpenAI key -> GPT-family options.
// =============================================================================

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { useSocketStore } from "../src/store/socket-store";

function mockRpc(configOverride: Record<string, unknown> = {}) {
  const rpc = vi.fn(async (method: string) => {
    if (method === "config.get") return { ...baseConfig(), ...configOverride };
    return {};
  });
  useSocketStore.setState({
    status: "connected",
    rpc: rpc as any,
    subscribe: vi.fn(() => () => {}),
  } as any);
  return rpc;
}

function baseConfig() {
  return {
    model: "claude-opus-4-7",
    provider: "anthropic",
    effort: "medium",
    max_tokens: 8192,
    max_iterations: 80,
    heartbeat: {
      enabled: true,
      interval_minutes: 30,
      model: null,
      active_hours: { start: "00:00", end: "23:59" },
      consolidation_enabled: true,
    },
    screenshots: { retention_days: 7 },
    has_anthropic_key: false,
    has_openai_key: false,
    vertex: { project_id: "" },
  };
}

beforeEach(() => {
  useSocketStore.setState({
    status: "disconnected",
    rpc: vi.fn() as any,
    subscribe: vi.fn(() => () => {}),
  } as any);
});

// ---------------------------------------------------------------------------
// Heartbeat model dropdown regression (pre-existing tests, kept intact)
// ---------------------------------------------------------------------------

describe("SettingsPanel heartbeat model dropdown", () => {
  it("preserves a user's deprecated heartbeat model as a custom option", async () => {
    mockRpc({ heartbeat: { ...baseConfig().heartbeat, model: "claude-sonnet-4-5" } });
    render(<SettingsPanel onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("claude-sonnet-4-5 (custom)")).toBeInTheDocument();
    });
  });

  it("does not add a custom option when heartbeat model is a known ID", async () => {
    mockRpc({ heartbeat: { ...baseConfig().heartbeat, model: "claude-sonnet-4-6" } });
    render(<SettingsPanel onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByText(/\(custom\)/)).not.toBeInTheDocument();
    });
  });

  it("does not add a custom option when heartbeat override is empty (same as default)", async () => {
    mockRpc({ heartbeat: { ...baseConfig().heartbeat, model: null } });
    render(<SettingsPanel onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.queryByText(/\(custom\)/)).not.toBeInTheDocument();
    });
  });
});

// ---------------------------------------------------------------------------
// Unified model dropdown gated by configured keys
// ---------------------------------------------------------------------------

describe("SettingsPanel unified model dropdown", () => {
  it("shows all Claude + GPT-5 models when both keys are set", async () => {
    mockRpc({ has_anthropic_key: true, has_openai_key: true });
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getAllByRole("option", { name: "claude-opus-4-7" }).length).toBeGreaterThan(0);
      expect(screen.getByRole("option", { name: "gpt-5.5" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "gpt-5.4-pro" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "gpt-5.4-mini" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "gpt-5.4-nano" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "gpt-5.3-chat-latest (ChatGPT instant)" })).toBeInTheDocument();
      expect(screen.getByRole("option", { name: "gpt-5.3-codex (coding)" })).toBeInTheDocument();
    });
  });

  it("shows only Claude models when only anthropic key is set", async () => {
    mockRpc({ has_anthropic_key: true, has_openai_key: false });
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getAllByRole("option", { name: "claude-opus-4-7" }).length).toBeGreaterThan(0);
      expect(screen.queryByRole("option", { name: "gpt-5.5" })).not.toBeInTheDocument();
    });
  });

  it("shows only GPT-5 models when only openai key is set", async () => {
    mockRpc({ has_anthropic_key: false, has_openai_key: true, model: "gpt-5.5" });
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => {
      const mainSelect = screen.getAllByRole("combobox")[0];
      expect(mainSelect.querySelector("option[value='gpt-5.5']")).toBeTruthy();
      expect(mainSelect.querySelector("option[value='claude-opus-4-7']")).toBeFalsy();
    });
  });

  it("shows Claude models when vertex is configured (no anthropic key)", async () => {
    mockRpc({
      has_anthropic_key: false,
      has_openai_key: false,
      provider: "vertex",
      vertex: { project_id: "my-project" },
    });
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getAllByRole("option", { name: "claude-opus-4-7" }).length).toBeGreaterThan(0);
      expect(screen.queryByRole("option", { name: "gpt-5.5" })).not.toBeInTheDocument();
    });
  });

  it("shows empty state hint when no keys and no special config", async () => {
    mockRpc({
      has_anthropic_key: false,
      has_openai_key: false,
      provider: "anthropic",
      vertex: { project_id: "" },
    });
    render(<SettingsPanel onClose={() => {}} />);
    await waitFor(() => {
      expect(screen.getByText(/Configure an API key/)).toBeInTheDocument();
    });
  });

  it("picking a claude-* model when provider is openai sends provider: anthropic", async () => {
    const rpc = mockRpc({
      has_anthropic_key: true,
      has_openai_key: true,
      provider: "openai",
      model: "gpt-5.5",
    });
    render(<SettingsPanel onClose={() => {}} />);

    const select = await waitFor(() => screen.getAllByRole("combobox")[0]);
    await waitFor(() => {
      expect((select as HTMLSelectElement).querySelector("option[value='claude-opus-4-7']")).toBeTruthy();
    });
    fireEvent.change(select, { target: { value: "claude-opus-4-7" } });

    const saveBtn = await waitFor(() => screen.getByRole("button", { name: /save/i }));
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const calls = (rpc.mock.calls as [string, ...unknown[]][]);
      const swapCall = calls.find((c) => c[0] === "gateway.swapProvider");
      expect(swapCall).toBeDefined();
      expect(swapCall![1]).toMatchObject({ provider: "anthropic", model: "claude-opus-4-7" });
      const updateCall = calls.find((c) => c[0] === "config.update");
      expect(updateCall).toBeUndefined();
    });
  });

  it("picking a claude-* model when provider is vertex keeps provider: vertex", async () => {
    const rpc = mockRpc({
      has_anthropic_key: false,
      has_openai_key: true,
      provider: "vertex",
      vertex: { project_id: "my-project" },
      model: "gpt-5.5",
    });
    render(<SettingsPanel onClose={() => {}} />);

    const select = await waitFor(() => screen.getAllByRole("combobox")[0]);
    await waitFor(() => {
      expect((select as HTMLSelectElement).querySelector("option[value='claude-opus-4-7']")).toBeTruthy();
    });
    fireEvent.change(select, { target: { value: "claude-opus-4-7" } });

    const saveBtn = await waitFor(() => screen.getByRole("button", { name: /save/i }));
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const calls = (rpc.mock.calls as [string, ...unknown[]][]);
      const updateCall = calls.find((c) => c[0] === "config.update");
      expect(updateCall).toBeDefined();
      // provider stays vertex (unchanged) so it is NOT included in the update payload
      expect(updateCall![1]).toMatchObject({ model: "claude-opus-4-7" });
      expect((updateCall![1] as Record<string, unknown>).provider).toBeUndefined();
      const swapCall = calls.find((c) => c[0] === "gateway.swapProvider");
      expect(swapCall).toBeUndefined();
    });
  });

  it("picking a gpt-* model when provider is anthropic sends provider: openai", async () => {
    const rpc = mockRpc({
      has_anthropic_key: true,
      has_openai_key: true,
      provider: "anthropic",
      model: "claude-opus-4-7",
    });
    render(<SettingsPanel onClose={() => {}} />);

    const select = await waitFor(() => screen.getAllByRole("combobox")[0]);
    await waitFor(() => {
      expect((select as HTMLSelectElement).querySelector("option[value='gpt-5.5']")).toBeTruthy();
    });
    fireEvent.change(select, { target: { value: "gpt-5.5" } });

    const saveBtn = await waitFor(() => screen.getByRole("button", { name: /save/i }));
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const calls = (rpc.mock.calls as [string, ...unknown[]][]);
      const swapCall = calls.find((c) => c[0] === "gateway.swapProvider");
      expect(swapCall).toBeDefined();
      expect(swapCall![1]).toMatchObject({ provider: "openai", model: "gpt-5.5" });
      const updateCall = calls.find((c) => c[0] === "config.update");
      expect(updateCall).toBeUndefined();
    });
  });

  it("switches openai_compatible profiles even when provider is unchanged", async () => {
    const rpc = mockRpc({
      provider: "openai_compatible",
      model: "llama-3.1-70b",
      openai_compatible: {
        active_profile: "local-a",
        profile_names: ["local-a", "local-b"],
        profiles: {
          "local-a": { model: "llama-3.1-70b", base_url: "http://localhost:8000/v1" },
          "local-b": { model: "llama-3.1-70b", base_url: "http://localhost:9000/v1" },
        },
      },
    });
    render(<SettingsPanel onClose={() => {}} />);

    const select = await waitFor(() => screen.getAllByRole("combobox")[0]);
    fireEvent.change(select, { target: { value: "compat:local-b" } });

    const saveBtn = await waitFor(() => screen.getByRole("button", { name: /save/i }));
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const calls = (rpc.mock.calls as [string, ...unknown[]][]);
      const swapCall = calls.find((c) => c[0] === "gateway.swapProvider");
      expect(swapCall).toBeDefined();
      expect(swapCall![1]).toMatchObject({
        provider: "openai_compatible",
        active_profile: "local-b",
      });
      const updateCall = calls.find((c) => c[0] === "config.update");
      expect(updateCall).toBeUndefined();
    });
  });

  it("uses live swap before persisting when openai base URL changes", async () => {
    const rpc = mockRpc({
      has_openai_key: true,
      provider: "openai",
      model: "gpt-5.5",
      openai_base_url: "",
    });
    render(<SettingsPanel onClose={() => {}} />);

    const input = await waitFor(() => screen.getByPlaceholderText("https://api.openai.com/v1"));
    fireEvent.change(input, { target: { value: "http://localhost:8000/v1" } });

    const saveBtn = await waitFor(() => screen.getByRole("button", { name: /save/i }));
    fireEvent.click(saveBtn);

    await waitFor(() => {
      const calls = (rpc.mock.calls as [string, ...unknown[]][]);
      const swapCall = calls.find((c) => c[0] === "gateway.swapProvider");
      expect(swapCall).toBeDefined();
      expect(swapCall![1]).toMatchObject({
        provider: "openai",
        openai_base_url: "http://localhost:8000/v1",
      });
      const updateCall = calls.find((c) => c[0] === "config.update");
      expect(updateCall).toBeUndefined();
    });
  });
});
