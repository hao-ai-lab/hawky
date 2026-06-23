import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useRealtime } from "../src/lib/useRealtime";
import { useSocketStore } from "../src/lib/socket-store";
import { useLiveSettings } from "../src/lib/live-settings";

beforeEach(() => {
  useSocketStore.setState({
    status: "connected" as any,
    rpc: (async () => ({})) as any,
    error: null, client: null, eventListeners: new Set(),
    connect: vi.fn() as any, disconnect: vi.fn(), subscribe: vi.fn(() => () => {}),
  });
  useLiveSettings.getState().reset();
});

function feed(handle: (raw: string) => void, events: object[]) {
  for (const e of events) act(() => { handle(JSON.stringify(e)); });
}

describe("Live transcript — assistant audio transcript (no duplicates)", () => {
  it("renders a streamed audio transcript exactly once (no dup from response.done)", () => {
    const { result } = renderHook(() => useRealtime({ sessionKey: "web:ios" }));
    const h = (result.current as any).__handleMessage as (raw: string) => void;

    feed(h, [
      { type: "response.created" },
      { type: "response.output_audio_transcript.delta", delta: "Hello " },
      { type: "response.output_audio_transcript.delta", delta: "there." },
      { type: "response.output_audio_transcript.done", transcript: "Hello there." },
      // The dup-causing event: the final response also carries the transcript.
      { type: "response.done", response: { output: [{ content: [{ type: "audio", transcript: "Hello there." }] }] } },
    ]);

    const assistant = result.current.transcript.filter((e) => e.kind === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].text).toBe("Hello there.");
  });

  it("handles the legacy event name too, still once", () => {
    const { result } = renderHook(() => useRealtime({ sessionKey: "web:ios" }));
    const h = (result.current as any).__handleMessage as (raw: string) => void;

    feed(h, [
      { type: "response.created" },
      { type: "response.audio_transcript.delta", delta: "Hi" },
      { type: "response.audio_transcript.done", transcript: "Hi" },
      { type: "response.done", response: { output: [{ content: [{ transcript: "Hi" }] }] } },
    ]);

    expect(result.current.transcript.filter((e) => e.kind === "assistant")).toHaveLength(1);
  });

  it("falls back to response.done text only when nothing streamed", () => {
    const { result } = renderHook(() => useRealtime({ sessionKey: "web:ios" }));
    const h = (result.current as any).__handleMessage as (raw: string) => void;

    feed(h, [
      { type: "response.created" },
      // No transcript deltas/done at all (unusual API variant).
      { type: "response.done", response: { output: [{ content: [{ type: "text", text: "Only fallback." }] }] } },
    ]);

    const assistant = result.current.transcript.filter((e) => e.kind === "assistant");
    expect(assistant).toHaveLength(1);
    expect(assistant[0].text).toBe("Only fallback.");
  });

  it("orders a late spoken user transcript ABOVE the assistant reply of the same turn", () => {
    const { result } = renderHook(() => useRealtime({ sessionKey: "web:ios" }));
    const h = (result.current as any).__handleMessage as (raw: string) => void;

    // Realistic order: the model starts replying BEFORE the user's audio
    // transcript is delivered.
    feed(h, [
      { type: "response.created" },
      { type: "response.output_audio_transcript.delta", delta: "The answer is 42." },
      { type: "conversation.item.input_audio_transcription.completed", transcript: "What is the answer?" },
      { type: "response.output_audio_transcript.done", transcript: "The answer is 42." },
      { type: "response.done", response: { output: [] } },
    ]);

    const convo = result.current.transcript.filter((e) => e.kind === "user" || e.kind === "assistant");
    expect(convo.map((e) => [e.kind, e.text])).toEqual([
      ["user", "What is the answer?"],
      ["assistant", "The answer is 42."],
    ]);
  });

  it("persists an assistant turn only ONCE even when text.done AND audio_transcript.done both fire", () => {
    // Capture session.appendMessages payloads.
    const appended: any[] = [];
    useSocketStore.setState({
      status: "connected" as any,
      rpc: (async (method: string, params: any) => {
        if (method === "session.appendMessages") appended.push(...(params?.messages ?? []));
        return {};
      }) as any,
      error: null, client: null, eventListeners: new Set(),
      connect: vi.fn() as any, disconnect: vi.fn(), subscribe: vi.fn(() => () => {}),
    });

    vi.useFakeTimers();
    const { result } = renderHook(() => useRealtime({ sessionKey: "web:ios" }));
    const h = (result.current as any).__handleMessage as (raw: string) => void;

    feed(h, [
      { type: "response.created" },
      { type: "response.output_audio_transcript.delta", delta: "Hi there." },
      { type: "response.output_audio_transcript.done", transcript: "Hi there." },
      // Audio mode can ALSO emit a text done for the same turn — must not re-persist.
      { type: "response.output_text.done", text: "Hi there." },
      { type: "response.done", response: { output: [{ content: [{ transcript: "Hi there." }] }] } },
    ]);
    act(() => { vi.runAllTimers(); }); // flush the debounced persist

    const assistantPersists = appended.filter((m) => m.role === "assistant");
    expect(assistantPersists).toHaveLength(1);
    expect(assistantPersists[0].text).toBe("Hi there.");
    vi.useRealTimers();
  });

  it("two responses produce two separate bubbles (not merged or duplicated)", () => {
    const { result } = renderHook(() => useRealtime({ sessionKey: "web:ios" }));
    const h = (result.current as any).__handleMessage as (raw: string) => void;

    feed(h, [
      { type: "response.created" },
      { type: "response.output_audio_transcript.delta", delta: "First." },
      { type: "response.output_audio_transcript.done", transcript: "First." },
      { type: "response.done", response: { output: [] } },
      { type: "response.created" },
      { type: "response.output_audio_transcript.delta", delta: "Second." },
      { type: "response.output_audio_transcript.done", transcript: "Second." },
      { type: "response.done", response: { output: [] } },
    ]);

    const assistant = result.current.transcript.filter((e) => e.kind === "assistant").map((e) => e.text);
    expect(assistant).toEqual(["First.", "Second."]);
  });
});
