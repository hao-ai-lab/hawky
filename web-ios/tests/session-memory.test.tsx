import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { restoredMemory, useSessionMemory } from "../src/lib/session-memory";
afterEach(cleanup);

it("does not lose recovered recording turns absent from the summary snapshot", () => {
  const packet = { mode: "summary", summary: "Old fact.", revision: 1, messages: [], recent: [{ role: "user" as const, text: "Saved turn." }] };
  expect(restoredMemory(packet, [{ role: "user", text: "Unsaved turn." }]).turns).toBeUndefined();
  expect(restoredMemory(packet, [{ role: "user", text: "Saved turn." }]).revision).toBe(1);
  expect(restoredMemory({ mode: "history", reason: "stale" }).warning).toContain("no longer matches");
});

it("bounds backlog catch-up and prevents concurrent clicks", async () => {
  const rpc = vi.fn(async () => ({ ok: true, has_more: true, session_memory: "A summary.", revision: 1 }));
  const hook = renderHook(() => useSessionMemory("web:one", rpc, async () => true));
  await act(async () => { await Promise.all([hook.result.current.update(), hook.result.current.update()]); });
  expect(rpc).toHaveBeenCalledTimes(8);
  expect(hook.result.current.state.phase).toBe("complete");
  expect(hook.result.current.state.hasMore).toBe(true);
});

it("switching conversations ignores the old result and stops its catch-up loop", async () => {
  let finish!: (value: unknown) => void;
  const rpc = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const hook = renderHook(({ key }) => useSessionMemory(key, rpc, async () => true), { initialProps: { key: "web:one" } });
  let update!: Promise<void>;
  await act(async () => { update = hook.result.current.update(); });
  hook.rerender({ key: "web:two" });
  await act(async () => { finish({ ok: true, has_more: true, session_memory: "Other chat." }); await update; });
  expect(hook.result.current.state).toEqual({ phase: "idle" });
  expect(rpc).toHaveBeenCalledTimes(1);
});

it("a failed transcript save prevents memory extraction", async () => {
  const rpc = vi.fn();
  const hook = renderHook(() => useSessionMemory("web:one", rpc, async () => false));
  await act(async () => { await hook.result.current.update(); });
  expect(rpc).not.toHaveBeenCalled();
  expect(hook.result.current.state.phase).toBe("failed");
});
