import { expect, test } from "bun:test";
import { JoyAIAdapter, parseJoyOutput } from "../src/live/providers/joyai";
import { CueAudio, joySpeech, pcmWav } from "../src/live/providers/joyai-speech";
const tick = (ms = 20) => new Promise(r => setTimeout(r, ms));
const voiced = Buffer.alloc(3200); for (let n = 0; n < voiced.length; n += 2) voiced.writeInt16LE(2500, n);
test("Joy action tokens never become speech or fabricated tools", () => {
  expect(parseJoyOutput("</silence>").text).toBe("");
  expect(parseJoyOutput("</response> Checking. </delegation> List files")).toEqual({ text: "Checking.", task: "List files" });
  expect(parseJoyOutput("</response> Checking. <delegation> List files").task).toBe("List files");
  expect(() => parseJoyOutput("I am doing something")).toThrow();
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
    expect(posts[0].body.messages[0].content).toContain("turquoise");
    expect(posts[1].body.messages[1].content[0].text).toBe("List files");
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
