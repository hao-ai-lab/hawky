import { expect, spyOn, test } from "bun:test";
import { JoyAIAdapter, parseJoyOutput, parseJoyResponse } from "../src/live/providers/joyai";
import { JoyPlayback } from "../src/live/providers/joyai-playback";
import { CueAudio, joySpeech, pcmWav } from "../src/live/providers/joyai-speech";
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const voiced = Buffer.alloc(3200); for (let n = 0; n < voiced.length; n += 2) voiced.writeInt16LE(2500, n);
test("Joy action tokens never become speech or fabricated tools", () => {
  expect(parseJoyOutput("</silence>").text).toBe("");
  expect(parseJoyOutput("</response> Checking. </delegation> List files")).toEqual({ text: "Checking.", task: "List files" });
  expect(parseJoyOutput("</response> Checking. <delegation> List files").task).toBe("List files");
  expect(parseJoyOutput("I am doing something")).toEqual({ text: "I am doing something", task: undefined });
  expect(() => parseJoyOutput("</response> x </delegation> one </delegation> two")).toThrow();
  expect(() => parseJoyOutput("</response> x </delegation> ")).toThrow();
});
test("cue audio bounds utterances, ignores noise spikes, and writes PCM WAV", () => {
  const a = new CueAudio(); expect(a.push(Buffer.alloc(3200)).started).toBe(false);
  expect(a.push(voiced).started).toBe(true); a.push(voiced); a.push(voiced);
  let out: Buffer | undefined;
  for (let i = 0; i < 6; i++) out = a.push(Buffer.alloc(3200)).utterance;
  expect(out).toBeDefined(); expect(a.speaking).toBe(false);
  const wav = pcmWav(out!); expect(wav.toString("ascii", 0, 4)).toBe("RIFF"); expect(wav.readUInt32LE(24)).toBe(16000); expect(wav.readUInt32LE(40)).toBe(out!.length);
  a.push(voiced); expect(a.flush()).toBeUndefined();
  for (let i = 0; i < 120; i++) out = a.push(voiced).utterance;
  expect(out!.length).toBeLessThanOrEqual(384000);
});
test("Joy restores quietly, isolates HTTP state, coalesces images and delegates once", async () => {
  const requests: any[] = [], events: any[] = [], tools: any[] = [];
  let release: () => void = () => {};
  const blocked = new Promise<void>(r => { release = r; }); let inference = 0;
  const http = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined; requests.push({ url, body, headers: init.headers });
    if (url.endsWith("completions")) {
      if (++inference === 1) await blocked;
      return Response.json({ choices: [{ message: { content: "</response> Checking. </delegation> List files" } }], streamingharness: { timing: { adapter_total_ms: 123 }, memory: { mid_term_summaries: [{ summary_text: "private scene" }] } } });
    }
    return Response.json({});
  }) as typeof fetch;
  const a = new JoyAIAdapter({ id: "joy-fixture", model: "joyai-vl-interaction", instructions: "Hawk", history: [{ role: "user", text: "Test color turquoise" }], bridge: true, emit: e => events.push(e), tool: async (...args) => { tools.push(args); return { status: "queued" }; } }, { url: "http://fixture" }, http);
  try {
    await a.start(); a.input({ type: "image", data: "AAAA", at: Date.now() }); await tick();
    expect(inference).toBe(0);
    a.input({ type: "text", text: "List files" }); await tick();
    for (let i = 0; i < 50; i++) a.input({ type: "image", data: "AQAA", at: Date.now() });
    release(); await tick(1150);
    expect(inference).toBe(2); expect(tools).toHaveLength(1);
    const posts = requests.filter(r => r.url.endsWith("completions"));
    expect(posts[0].headers["x-streaming-session"]).toBe("joy-fixture");
    expect(posts[0].body.user).toBe("joy-fixture");
    expect(posts[0].body.messages[0].content).toContain("turquoise");
    expect(posts[1].body.messages[1].content[0].text).toBe("");
    expect(posts[1].body.messages[1].content[1].image_url.url).toContain("AQAA");
    expect(posts[0].body.frame_time_ranges[0]).toContain("seconds");
    expect(events.filter(e => e.role === "assistant").every(e => e.text === "Checking.")).toBe(true);
    expect(JSON.stringify(events)).not.toContain("private scene");
  } finally { release(); await a.close(); }
  expect(requests.at(-1).body.user).toBe("joy-fixture");
});
test("Joy microphone passes bounded WAV to configured ASR, then words to VLM", async () => {
  const requests: any[] = [], events: any[] = [];
  const http = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    if (url.endsWith("transcriptions")) return Response.json({ text: "Describe my cup" });
    if (url.endsWith("completions")) return Response.json({ choices: [{ message: { content: "</response> A blue cup." } }] });
    return Response.json({});
  }) as typeof fetch;
  const a = new JoyAIAdapter({ id: "speech-test", model: "joyai-vl-interaction", instructions: "", history: [], bridge: false, emit: e => events.push(e), tool: async () => {} }, { url: "http://fixture", asr_url: "http://asr/v1/audio/transcriptions" }, http);
  try {
    await a.start(); for (let n = 0; n < 3; n++) a.input({ type: "audio", data: voiced.toString("base64") });
    for (let n = 0; n < 6; n++) a.input({ type: "audio", data: Buffer.alloc(3200).toString("base64") });
    await tick();
    expect(requests.find(r => r.url.endsWith("transcriptions")).init.body.get("model")).toContain("Qwen3-ASR");
    expect(events.some(e => e.role === "user" && e.text === "Describe my cup")).toBe(true);
    expect(events.some(e => e.role === "assistant" && e.text === "A blue cup.")).toBe(true);
  } finally { await a.close(); }
});
test("new speech suppresses stale inference and delegation", async () => {
  let release: (r: Response) => void = () => {}; const events: any[] = [], calls: any[] = [];
  const http = (async (url: string) => url.endsWith("completions") ? await new Promise<Response>(r => { release = r; }) : Response.json({})) as typeof fetch;
  const a = new JoyAIAdapter({ id: "stale-test", model: "joyai-vl-interaction", instructions: "", history: [], bridge: true, emit: e => events.push(e), tool: async (...args) => { calls.push(args); } }, { url: "http://fixture", asr_url: "http://asr" }, http);
  await a.start(); a.input({ type: "text", text: "Old request" }); await tick();
  a.input({ type: "audio", data: voiced.toString("base64") });
  release(Response.json({ choices: [{ message: { content: "</response> Old answer </delegation> Old task" } }] })); await tick();
  expect(calls).toEqual([]); expect(events.filter(e => e.role === "assistant")).toEqual([]); await a.close();
});
test("Joy TTS speaks only visible text and closes on interrupt", async () => {
  class Socket extends EventTarget {
    binaryType = ""; sent: any[] = []; closed = false;
    send(s: string) { this.sent.push(JSON.parse(s)); }
    close() { this.closed = true; }
  }
  const ws = new Socket(), pcm: Buffer[] = [], abort = new AbortController();
  const done = joySpeech("ws://fixture/ws/tts", "Hello", "vivian", abort.signal, b => pcm.push(b), () => ws as any);
  ws.dispatchEvent(new Event("open"));
  expect(ws.sent.map(e => e.type)).toEqual([undefined, "input_text.append", "input_text.commit"]);
  ws.dispatchEvent(new MessageEvent("message", { data: new ArrayBuffer(24) }));
  abort.abort(); await done; expect(ws.closed).toBe(true); expect(pcm[0].length).toBe(24);
});

class SpeechSocket extends EventTarget {
  binaryType = ""; closed = false;
  send(_text: string) {} close() { this.closed = true; }
  audio(bytes: number) { this.dispatchEvent(new MessageEvent("message", { data: new ArrayBuffer(bytes) })); }
  done() { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "response.done" }) })); }
}
test("Joy TTS delivers a full minute of audio without truncating the reply", async () => {
  const ws = new SpeechSocket(); let bytes = 0;
  const done = joySpeech("ws://fixture", "Long reply", "vivian", new AbortController().signal,
    pcm => { bytes += pcm.length; }, () => ws as any).then(() => "completed", e => e.message);
  ws.dispatchEvent(new Event("open"));
  for (let i = 0; i < 6; i++) ws.audio(24000 * 2 * 10);
  ws.done();
  expect(await done).toBe("completed");
  expect(bytes).toBe(24000 * 2 * 60); expect(ws.closed).toBe(true);
});
test("Joy TTS still rejects incomplete PCM samples with a specific error", async () => {
  const ws = new SpeechSocket(); let chunks = 0;
  const done = joySpeech("ws://fixture", "Hello", "vivian", new AbortController().signal,
    () => { chunks++; }, () => ws as any).then(() => "completed", e => e.message);
  ws.audio(1);
  expect(await done).toContain("incomplete PCM sample");
  expect(chunks).toBe(0); expect(ws.closed).toBe(true);
});
test("Joy TTS allows ongoing generation beyond 30 seconds but stops an idle stream", async () => {
  let now = 0, nextId = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const set = spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms: number) => {
    const id = ++nextId; timers.set(id, { at: now + ms, fn }); return id;
  }) as any);
  const clear = spyOn(globalThis, "clearTimeout").mockImplementation(((id: number) => { timers.delete(id); }) as any);
  const advance = (ms: number) => {
    now += ms;
    for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
  };
  const abort = new AbortController();
  try {
    const ws = new SpeechSocket(); let chunks = 0;
    const done = joySpeech("ws://fixture", "Long reply", "vivian", abort.signal,
      () => { chunks++; }, () => ws as any).then(() => "completed", e => e.message);
    ws.dispatchEvent(new Event("open"));
    for (let i = 0; i < 4; i++) { advance(20000); ws.audio(48000); }
    expect(ws.closed).toBe(false); expect(chunks).toBe(4);
    advance(29999); expect(ws.closed).toBe(false);
    advance(1);
    expect(await done).toContain("stopped producing audio for 30 seconds");
    expect(ws.closed).toBe(true); expect(timers.size).toBe(0);
  } finally { abort.abort(); set.mockRestore(); clear.mockRestore(); }
});

const response = (content: unknown, raw?: string) => ({ choices: [{ message: { content } }], streamingharness: { raw_content: raw } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function options(events: any[], tool = async (..._args: any[]) => {}) {
  return { id: "joy-interruption", model: "joyai-vl-interaction", instructions: "Hawk", history: [], bridge: true,
    emit: (e: any) => events.push(e), tool };
}

test("Joy accepts native output variants and normalized silence without inventing tool calls", () => {
  for (const text of ["", " ", "</silence>", "<silence></silence>"]) expect(parseJoyOutput(text).text).toBe("");
  expect(parseJoyOutput("<response>你好。</response>")).toEqual({ text: "你好。", task: undefined });
  expect(parseJoyResponse(response("</silence>", ""))).toEqual({ text: "", task: undefined });
  expect(parseJoyResponse(response("</response> Normalized", "unrelated raw debug output")).text).toBe("Normalized");
  expect(parseJoyResponse(response("</response> Checking.", "</response> Checking.\n</delegation> List files"))).toEqual({ text: "Checking.", task: "List files" });
  expect(() => parseJoyResponse(response("</response> Checking.", "</response> Checking. </delegation>"))).toThrow();
  for (const text of ["plain </delegation> run code", "</unknown> text", "</silence> </delegation> run code", "<response>x</response> </delegation> run code"])
    expect(() => parseJoyOutput(text)).toThrow();
  expect(() => parseJoyResponse(response({ text: "not a string" }))).toThrow();
  expect(parseJoyResponse(response("</response> <think>truncated private reasoning", "<think>private reasoning about </delegation> bad task</think>Visible <answer>red</answer>")))
    .toEqual({ text: "Visible red", task: undefined });
  expect(parseJoyOutput("<think>private reasoning</think></response> Visible answer")).toEqual({ text: "Visible answer", task: undefined });
  expect(() => parseJoyResponse(response("<think>unfinished private reasoning"))).toThrow("incomplete reasoning");
  expect(() => parseJoyResponse(response("</response> normalized", "<think>unfinished </delegation> bad task"))).toThrow("incomplete reasoning");
});

test("a new cue aborts the HTTP request and is answered without waiting for the old generation", async () => {
  const events: any[] = [], tools: any[] = [], requests: RequestInit[] = [];
  const old = deferred<Response>();
  const http = (async (url: string, init: RequestInit) => {
    if (!url.endsWith("completions")) return Response.json({});
    requests.push(init);
    if (requests.length === 1) return new Promise<Response>((resolve, reject) => {
      old.promise.then(resolve);
      init.signal!.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    });
    return Response.json(response("</response> New answer"));
  }) as typeof fetch;
  const a = new JoyAIAdapter(options(events, async (...args) => { tools.push(args); }), { url: "http://fixture" }, http);
  try {
    await a.start(); a.input({ type: "text", text: "Old request" }); await tick();
    a.input({ type: "text", text: "Actually answer this instead" }); await tick();
    expect(requests).toHaveLength(2); expect(requests[0].signal!.aborted).toBe(true);
    expect(events.filter(e => e.role === "assistant").map(e => e.text)).toEqual(["New answer"]);
    old.resolve(Response.json(response("</response> Old answer </delegation> Old task"))); await tick();
    expect(tools).toHaveLength(0); expect(events.filter(e => e.type === "error")).toHaveLength(0);
    expect(a.diagnostics().inference.cancelled).toBe(1);
  } finally { old.resolve(Response.json(response("</silence>"))); await a.close(); }
});

test("visual inference continues during synthesis and playback; only the latest unsaid observation speaks", async () => {
  const events: any[] = [], speech: { text: string; done: ReturnType<typeof deferred<void>> }[] = [];
  const requests: any[] = [];
  const http = (async (url: string, init: RequestInit) => {
    if (!url.endsWith("completions")) return Response.json({});
    requests.push(JSON.parse(String(init.body)));
    return Response.json(response(`</response> Scene ${requests.length}`));
  }) as typeof fetch;
  const synth = (async (_url, text, _voice, signal, emit) => {
    const done = deferred<void>(); speech.push({ text, done });
    signal.addEventListener("abort", () => done.resolve(), { once: true });
    emit(Buffer.alloc(2400)); await done.promise;
  }) as typeof joySpeech;
  const a = new JoyAIAdapter(options(events), { url: "http://fixture", tts_url: "ws://fixture" }, http, synth);
  try {
    await a.start(); a.input({ type: "image", data: "AAAA", at: Date.now() });
    a.input({ type: "text", text: "Describe changes" }); await tick();
    a.input({ type: "image", data: "AQAA", at: Date.now() }); await tick(1050);
    expect(requests).toHaveLength(2); expect(speech.map(s => s.text)).toEqual(["Scene 1"]);
    speech[0].done.resolve(); await tick(); // Synthesis finishes, but playback is not acknowledged yet.
    a.input({ type: "image", data: "AgAA", at: Date.now() }); await tick(1050);
    expect(requests).toHaveLength(3); expect(speech).toHaveLength(1);
    expect(requests[1].messages[1].content[0].text).toBe("");
    const audio = events.find(e => e.type === "audio");
    a.input({ type: "playback", id: audio.id, played: true }); await tick();
    expect(speech.map(s => s.text)).toEqual(["Scene 1", "Scene 3"]);
    expect(a.diagnostics().inference.completed).toBe(3);
  } finally { await a.close(); }
});

test("speech interruption cancels synthesis, drops pending observations and ignores late PCM and receipts", async () => {
  const events: any[] = [], speech: any[] = [];
  const synth = (async (_url, text, _voice, signal, emit) => {
    const done = deferred<void>(); speech.push({ text, signal, emit, done });
    emit(Buffer.alloc(2400)); await done.promise;
  }) as typeof joySpeech;
  const q = new JoyPlayback("ws://fixture", "vivian", e => events.push(e), synth);
  try {
    q.enqueue("Old reply", true); q.enqueue("Old observation", false);
    const oldAudio = events[0].id;
    q.interrupt(); q.enqueue("New reply", true);
    expect(speech[0].signal.aborted).toBe(true);
    const count = events.length; speech[0].emit(Buffer.alloc(2400)); speech[0].done.resolve(); await tick();
    q.acknowledge(oldAudio); q.enqueue("Latest scene", false);
    expect(events).toHaveLength(count); expect(speech.map(s => s.text)).toEqual(["Old reply", "New reply"]);
    speech[1].done.resolve(); await tick();
    expect(speech).toHaveLength(2); // Old receipt did not release new playback.
    q.acknowledge(events[1].id); await tick();
    expect(speech[2].text).toBe("Latest scene");
    q.close(); const before = events.length; speech[2].emit(Buffer.alloc(2400));
    expect(events).toHaveLength(before);
  } finally { q.close(); speech.forEach(s => s.done.resolve()); }
});

test("backend replies have speech priority over coalesced visual updates", async () => {
  const events: any[] = [], spoken: string[] = [];
  const q = new JoyPlayback("ws://fixture", "vivian", e => events.push(e), (async (_url, text, _voice, _signal, emit) => {
    spoken.push(text); emit(Buffer.alloc(24));
  }) as typeof joySpeech);
  try {
    q.enqueue("Speaking", true); await tick();
    q.enqueue("Old observation", false); q.enqueue("Backend finished", true); q.enqueue("Newest observation", false);
    q.acknowledge(events[0].id); await tick();
    expect(spoken).toEqual(["Speaking", "Backend finished"]);
    q.acknowledge(events[1].id); await tick();
    expect(spoken).toEqual(["Speaking", "Backend finished", "Newest observation"]);
  } finally { q.close(); }
});

test("a malformed model response warns without disconnecting and the next cue can recover", async () => {
  const events: any[] = [], calls: any[] = []; let count = 0;
  const http = (async (url: string) => url.endsWith("completions")
    ? Response.json(response(++count === 1 ? "</response> x </delegation>" : "<response>Recovered</response>")) : Response.json({})) as typeof fetch;
  const a = new JoyAIAdapter(options(events, async (...args) => { calls.push(args); }), { url: "http://fixture" }, http);
  try {
    await a.start(); a.input({ type: "text", text: "First cue" }); await tick();
    expect(events.some(e => e.type === "warning" && e.message.includes("invalid delegation"))).toBe(true);
    expect(events.some(e => e.type === "error")).toBe(false); expect(calls).toHaveLength(0);
    a.input({ type: "text", text: "Try again" }); await tick();
    expect(events.some(e => e.role === "assistant" && e.text === "Recovered")).toBe(true);
    expect(a.diagnostics().inference.consecutiveErrors).toBe(0);
    const diagnostic = events.find(e => e.detail?.phase === "output.rejected");
    expect(diagnostic.detail.contentLength).toBeGreaterThan(0);
    expect(JSON.stringify(diagnostic)).not.toContain("</delegation>");
  } finally { await a.close(); }
});

test("repeated bad frames back off with one warning instead of faulting or flooding the transcript", async () => {
  const events: any[] = []; let requests = 0;
  const http = (async (url: string) => {
    if (url.endsWith("completions")) { requests++; return Response.json(response("</unexpected> private text")); }
    return Response.json({});
  }) as typeof fetch;
  const a = new JoyAIAdapter(options(events), { url: "http://fixture", asr_url: "http://asr", tts_url: "ws://tts" }, http);
  try {
    await a.start(); a.input({ type: "text", text: "Describe changes" }); await tick();
    for (let n = 0; n < 50; n++) a.input({ type: "image", data: "AAAA", at: Date.now() });
    await tick(100); expect(requests).toBe(1);
    await tick(2050); expect(requests).toBe(2);
    expect(events.filter(e => e.type === "warning")).toHaveLength(1);
    expect(events.filter(e => e.type === "error")).toHaveLength(0);
    expect(JSON.stringify(events.filter(e => e.type === "diagnostic"))).not.toContain("private text");
  } finally { await a.close(); }
});

test("interrupting a backend update while reading its response body preserves the pending announcement", async () => {
  const events: any[] = [], requests: any[] = [];
  let bodySignal!: AbortSignal;
  const http = (async (url: string, init: RequestInit) => {
    if (!url.endsWith("completions")) return Response.json({});
    requests.push(JSON.parse(String(init.body)));
    if (requests.length !== 2) return Response.json(response("</silence>"));
    bodySignal = init.signal!;
    return { ok: true, json: () => new Promise((_resolve, reject) => {
      bodySignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }) } as unknown as Response;
  }) as typeof fetch;
  const a = new JoyAIAdapter(options(events), { url: "http://fixture" }, http);
  try {
    await a.start(); a.input({ type: "text", text: "Hello" }); await tick();
    a.context("Task completed: 42", true); await tick(1050);
    expect(requests).toHaveLength(2);
    a.input({ type: "text", text: "What happened?" }); await tick();
    expect(bodySignal.aborted).toBe(true); expect(requests).toHaveLength(3);
    expect(requests[2].messages[0].content).toContain("There is a new backend update");
    expect(requests[2].messages[0].content).toContain("Task completed: 42");
  } finally { await a.close(); }
});

test("closing Joy aborts active inference without publishing errors and resets only its connection", async () => {
  const events: any[] = [], resets: string[] = []; let inferenceSignal!: AbortSignal;
  const http = (async (url: string, init: RequestInit) => {
    if (url.endsWith("completions")) {
      inferenceSignal = init.signal!;
      return new Promise<Response>((_resolve, reject) => inferenceSignal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError"))));
    }
    if (url.endsWith("reset")) resets.push(JSON.parse(String(init.body)).user);
    return Response.json({});
  }) as typeof fetch;
  const a = new JoyAIAdapter(options(events), { url: "http://fixture" }, http);
  await a.start(); a.input({ type: "text", text: "Hello" }); await tick();
  await a.close(); await a.close();
  expect(inferenceSignal.aborted).toBe(true); expect(resets).toEqual(["joy-interruption"]);
  expect(events.filter(e => e.type === "error")).toHaveLength(0);
  const count = events.length;
  a.context("late task result", true); a.input({ type: "text", text: "late cue" }); await tick();
  expect(events).toHaveLength(count);
});

test("a cue before the first image is also delivered to the stateful visual session", async () => {
  const events: any[] = [], bodies: any[] = [];
  const http = (async (url: string, init: RequestInit) => {
    if (url.endsWith("completions")) { bodies.push(JSON.parse(String(init.body))); return Response.json(response("</silence>", "")); }
    return Response.json({});
  }) as typeof fetch;
  const a = new JoyAIAdapter(options(events), { url: "http://fixture" }, http);
  try {
    await a.start(); a.input({ type: "text", text: "Describe changes" }); await tick();
    a.input({ type: "image", data: "AAAA", at: Date.now() }); await tick(1050);
    expect(bodies).toHaveLength(2); expect(bodies[1].messages[1].content[0].text).toBe("Describe changes");
    expect(events.filter(e => e.type === "error")).toHaveLength(0);
  } finally { await a.close(); }
});

test("a filler cue followed by camera frames cannot repeat an answered cue into the transcript or TTS", async () => {
  const events: any[] = [], bodies: any[] = [], spoken: string[] = [];
  const replies = ["在呢，随时可以聊。", "在呢，随时可以聊。", "", "在呢，随时可以聊。"];
  const http = (async (url: string, init: RequestInit) => {
    if (!url.endsWith("completions")) return Response.json({});
    bodies.push(JSON.parse(String(init.body)));
    const text = replies.shift();
    return Response.json(response(text ? `</response> ${text}` : "</silence>"));
  }) as typeof fetch;
  const a = new JoyAIAdapter(options(events), { url: "http://fixture", tts_url: "ws://fixture" }, http,
    async (_url, text) => { spoken.push(text); });
  try {
    await a.start(); a.input({ type: "text", text: "嗯。" }); await tick();
    a.input({ type: "mic", enabled: false });
    for (let n = 0; n < 3; n++) {
      a.input({ type: "image", data: "AAAA", at: Date.now() }); await tick(1050);
    }
    expect(bodies).toHaveLength(4); // Perception continues, even while the mic is muted.
    expect(bodies[1].messages[0].content).toContain("Do not repeat conversational acknowledgements");
    expect(events.filter(e => e.role === "assistant").map(e => e.text)).toEqual(["在呢，随时可以聊。"]);
    expect(spoken).toEqual(["在呢，随时可以聊。"]);
    expect(a.diagnostics().inference.suppressedReplies).toBe(2);
    const diagnostics = events.filter(e => e.detail?.phase === "output.duplicate_suppressed");
    expect(diagnostics).toHaveLength(2);
    expect(JSON.stringify(diagnostics)).not.toContain("在呢");
  } finally { await a.close(); }
});

test("duplicate suppression preserves visual changes, requested repetitions, and new backend results", async () => {
  const events: any[] = [], spoken: string[] = [];
  const replies = ["Red.", "Blue.", "Red.", "</silence>", "Red.", "Red."];
  const http = (async (url: string) => url.endsWith("completions")
    ? Response.json(response(replies[0] === "</silence>" ? replies.shift() : `</response> ${replies.shift()}`)) : Response.json({})) as typeof fetch;
  const a = new JoyAIAdapter(options(events), { url: "http://fixture", tts_url: "ws://fixture" }, http,
    async (_url, text) => { spoken.push(text); });
  try {
    await a.start(); a.input({ type: "text", text: "Continuously describe the color" }); await tick();
    for (const data of ["AQAA", "AgAA"]) {
      a.input({ type: "image", data, at: Date.now() }); await tick(1050);
    }
    a.input({ type: "text", text: "Repeat that" }); await tick();
    // A question still awaiting its answer can be satisfied on the next frame,
    // even when the answer happens to match the previous turn.
    a.input({ type: "image", data: "AgAA", at: Date.now() }); await tick(1050);
    a.context("New backend result: Red.", true); await tick(1050);
    expect(spoken).toEqual(["Red.", "Blue.", "Red.", "Red.", "Red."]);
    expect(events.filter(e => e.role === "assistant").map(e => e.text)).toEqual(spoken);
    expect(a.diagnostics().inference.suppressedReplies).toBe(0);
  } finally { await a.close(); }
});

// Exercise the real server-side WebSocket implementation, not just a mock factory.
test("Joy TTS authenticates the WebSocket upgrade with its configured key", async () => {
  let auth = "", chunks = 0;
  const server = Bun.serve({ port: 0,
    fetch(req, server) { auth = req.headers.get("authorization") || "";
      if (server.upgrade(req)) return; return new Response("Upgrade required", { status: 400 }); },
    websocket: { message(ws, message) {
      if (JSON.parse(String(message)).type === "input_text.commit") {
        ws.send(Buffer.alloc(48)); ws.send(JSON.stringify({ type: "response.done" }));
      }
    } },
  });
  try {
    await joySpeech(`ws://127.0.0.1:${server.port}/tts`, "Hello", "vivian", new AbortController().signal,
      () => { chunks++; }, undefined, "test-only-key");
    expect(auth).toBe("Bearer test-only-key"); expect(chunks).toBe(1);
  } finally { server.stop(true); }
});
