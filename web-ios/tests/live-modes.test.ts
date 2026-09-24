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

  it("pre-session Stay Silent changes preference without creating transcript activity", () => {
    const { result } = renderHook(() => useRealtime({ sessionKey: "web:ios" }));
    act(() => result.current.toggleStaySilent());
    expect(result.current.staySilent).toBe(true);
    expect(useLiveSettings.getState().staySilent).toBe(true);
    expect(result.current.transcript).toEqual([]);
    act(() => result.current.toggleStaySilent());
    expect(result.current.staySilent).toBe(false);
  });

  it("pre-session Stay Silent release does not recap an unstarted conversation", () => {
    // Preflight selections must not trigger the connected-session recap flow.
    vi.useFakeTimers();
    const { result } = renderHook(() => useRealtime({ sessionKey: "web:ios" }));
    act(() => result.current.toggleStaySilent());          // on
    act(() => result.current.toggleStaySilent());          // off, still idle
    expect(result.current.staySilent).toBe(false);
    expect(result.current.transcript.some((e) => /summarizing what happened/i.test(e.text))).toBe(false);
    // The recap is fired after a settle window; advancing timers must not throw.
    act(() => vi.advanceTimersByTime(1300));
    expect(result.current.error).toBeNull();
    vi.useRealTimers();
  });

  it("toggling Stay Silent on with no active response never surfaces a cancellation error", () => {
    // Regression: toggleStaySilent used to fire response.cancel unconditionally,
    // and the Realtime API answers with "Cancellation failed: no active response
    // found", which the error handler showed as a warning bubble + error banner.
    const { result } = renderHook(() => useRealtime({ sessionKey: "web:ios" }));
    act(() => result.current.toggleStaySilent());
    expect(result.current.staySilent).toBe(true);
    expect(result.current.error).toBeNull();
    expect(result.current.transcript.some((e) => e.kind === "warning")).toBe(false);
    expect(result.current.transcript.some((e) => /cancellation failed/i.test(e.text))).toBe(false);
  });

  it("pre-session Cocktail Party saves its selection without contacting a model", () => {
    const { result } = renderHook(() => useRealtime({ sessionKey: "web:ios" }));
    act(() => result.current.toggleCocktailParty());
    expect(result.current.cocktailParty).toBe(true);
    expect(useLiveSettings.getState().cocktailParty).toBe(true);
    expect(result.current.transcript).toEqual([]);
    expect(result.current.transcript.some((e) => /greet/i.test(e.text))).toBe(false);
    expect(result.current.transcript.some((e) => /face_identify/i.test(e.text))).toBe(false);
  });

  it("pre-session Safety Check saves its selection without starting monitoring", () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRealtime({ sessionKey: "web:ios" }));
    act(() => result.current.toggleSafety());
    expect(result.current.safetyOn).toBe(true);
    expect(useLiveSettings.getState().safetyCheck).toBe(true);
    act(() => vi.advanceTimersByTime(5000));
    expect(rpcCalls.some(c => c.method === "tool.invoke")).toBe(false);
    expect(result.current.transcript).toEqual([]);
    act(() => result.current.toggleSafety());
    expect(result.current.safetyOn).toBe(false);
    vi.useRealTimers();
  });
});
