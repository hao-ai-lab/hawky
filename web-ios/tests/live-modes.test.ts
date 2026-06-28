import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { WEB_PERSON_TOOL_NAME_LIST, useRealtime } from "../src/lib/useRealtime";
import { useSocketStore } from "../src/lib/socket-store";
import { useLiveSettings } from "../src/lib/live-settings";

let rpcCalls: { method: string; params: any }[] = [];

beforeEach(() => {
  rpcCalls = [];
  useLiveSettings.getState().reset();
  useSocketStore.setState({
    status: "connected" as any,
    rpc: (async (method: string, params: any) => {
      rpcCalls.push({ method, params });
      if (method === "tool.invoke") return { result: { type: "text", content: "ok", metadata: {} } };
      return {};
    }) as any,
    error: null, client: null, eventListeners: new Set(),
    connect: vi.fn() as any, disconnect: vi.fn(), subscribe: vi.fn(() => () => {}),
  });
});

describe("Live modes", () => {
  it("Cocktail Party exposes shared person tools — wiring present", () => {
    // We can't open a real WebRTC channel in jsdom, but we can assert the tool
    // definitions + handler exist by checking the hook exposes the toggles.
    const { result } = renderHook(() => useRealtime({ sessionKey: "web:ios" }));
    expect(typeof result.current.toggleCocktailParty).toBe("function");
    expect(typeof result.current.toggleSafety).toBe("function");
    expect(typeof result.current.toggleStaySilent).toBe("function");
    expect(result.current.cocktailParty).toBe(false);
    expect(result.current.safetyOn).toBe(false);
    expect(result.current.staySilent).toBe(false);
    expect(WEB_PERSON_TOOL_NAME_LIST).toEqual([
      "identify_person",
      "list_people",
      "recall_person",
      "update_person_profile",
      "confirm_identity_candidate",
      "reject_identity_candidate",
    ]);
  });

  it("toggling Stay Silent flips state and emits a system marker in the transcript", () => {
    const { result } = renderHook(() => useRealtime({ sessionKey: "web:ios" }));
    act(() => result.current.toggleStaySilent());
    expect(result.current.staySilent).toBe(true);
    expect(result.current.transcript.some((e) => e.kind === "system" && /Stay Silent on/i.test(e.text))).toBe(true);
    act(() => result.current.toggleStaySilent());
    expect(result.current.staySilent).toBe(false);
  });

  it("toggling Cocktail Party flips state + uses on-demand recognition copy", () => {
    const { result } = renderHook(() => useRealtime({ sessionKey: "web:ios" }));
    act(() => result.current.toggleCocktailParty());
    expect(result.current.cocktailParty).toBe(true);
    expect(result.current.transcript.some((e) => /recognizing people on request/i.test(e.text))).toBe(true);
    expect(result.current.transcript.some((e) => /greet/i.test(e.text))).toBe(false);
    expect(result.current.transcript.some((e) => /face_identify/i.test(e.text))).toBe(false);
  });

  it("toggling Safety Check on shows a warning and starts watching; off stops", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRealtime({ sessionKey: "web:ios" }));
    act(() => result.current.toggleSafety());
    expect(result.current.safetyOn).toBe(true);
    expect(result.current.transcript.some((e) => e.kind === "warning" && /Safety Check on/i.test(e.text))).toBe(true);
    act(() => result.current.toggleSafety());
    expect(result.current.safetyOn).toBe(false);
    vi.useRealTimers();
  });
});
