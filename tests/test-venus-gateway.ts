import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerDelegationMethods } from "../src/gateway/delegation-methods";
import { registerLiveStreamMethods } from "../src/gateway/live-stream-methods";
import { VenusAdapter } from "../src/live/providers/venus";
import { setSessionsDir } from "../src/storage/session";

async function until(condition: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!condition()) { if (Date.now() > deadline) throw new Error("Fixture timed out"); await Bun.sleep(5); }
}

test("Venus native delegation persists frozen evidence, executes once and correlates actual playback through the gateway", async () => {
  const dir = mkdtempSync(join(tmpdir(), "venus-gateway-")), oldDir = setSessionsDir(dir);
  const methods = new Map<string, Function>(), events: any[] = [], prefill: any[] = [], acknowledgements: any[] = [];
  const conn = { clientId: "venus-fixture", deviceTokenId: "owner", bindSession() {}, sendEvent(e: any) { events.push(e); return true; } };
  const server = { registerMethod(n: string, f: Function) { methods.set(n, f); }, registerConnectionCleanup() {},
    broadcastToSession(_session: string, event: string, payload: any) { events.push({ event, payload: structuredClone(payload) }); } };
  let runs = 0, inputSequence = 0, audioInputs = 0, step = 0, closed = false, nativeRequest: any;
  writeFileSync(join(dir, "answer.txt"), "The fixture answer is 42.");
  const tasks = registerDelegationMethods(server as any, async (_c, task, observer) => {
    runs++; observer.started("fixture-reader");
    return { reply: readFileSync(join(dir, "answer.txt"), "utf8") };
  });
  const http = (async (url: string, init: RequestInit) => {
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    if (url.endsWith("/hawk/health")) return Response.json({ protocol: "hawk-venus/1" });
    if (url.endsWith("/sessions")) return Response.json({ incarnation: 1 });
    if (url.endsWith("/audio")) { audioInputs++; return Response.json({ input_seq: ++inputSequence }); }
    if (url.endsWith("/video_frame")) return Response.json({ input_seq: ++inputSequence });
    if (url.endsWith("/prefill")) { prefill.push(body); return Response.json({ generation_id: "backend:2", generation_epoch: 2 }); }
    if (url.endsWith("/playback_ack")) { acknowledgements.push(body); return Response.json({}); }
    if (init.method === "DELETE") { closed = true; return Response.json({}); }
    if (url.includes("/output?")) {
      await Bun.sleep(2);
      if (audioInputs && step === 0) {
        step++;
        return Response.json(nativeRequest = { generation_id: "foreground:1", generation_epoch: 1, step_seq: 1,
          at_ms: Date.now(), input_seq_cutoff: inputSequence, text_delta: "<delegate>Read answer.txt</delegate><|turn_eos|>", turn_finished: true });
      }
      if (prefill.length && step === 1) { step++; return Response.json({ generation_id: "backend:2", generation_epoch: 2,
        step_seq: 1, text_delta: "<|listen|></unit>", turn_finished: false, input_seq_cutoff: inputSequence }); }
      if (step === 2) { step++; return Response.json({ generation_id: "backend:2", generation_epoch: 2, step_seq: 2,
        text_delta: "<|speak|>The fixture answer is 42.<|turn_eos|>", turn_finished: true, input_seq_cutoff: inputSequence,
        audio: { data: "AAAA", sample_rate_hz: 24000 }, audio_chunk_seq: 1 }); }
      return new Response("{}", { status: 408 });
    }
    throw new Error(`Unexpected native request: ${url}`);
  }) as typeof fetch;
  registerLiveStreamMethods(server as any, tasks, () => {}, o => new VenusAdapter(o, { url: "http://fixture" }, http));
  const p = { id: "venus-fixture-connection", ownerSession: "web:venus-fixture", model: "realtime-venus-omni", runtime: "native", bridge: true, history: [], instructions: "" };
  const rpc = (method: string, params: any = p) => methods.get(method)!(conn, params);
  try {
    await rpc("live.stream.create");
    await rpc("live.stream.input", { ...p, input: { type: "image", data: Buffer.from("before-image").toString("base64"), at: Date.now() } });
    const pcm = Buffer.alloc(32000); for (let i = 0; i < pcm.length; i += 2) pcm.writeInt16LE(3000, i);
    await rpc("live.stream.input", { ...p, input: { type: "audio", data: pcm.toString("base64") } });
    await until(() => step === 2);
    const task = tasks.list(conn as any, p.ownerSession)[0];
    expect(task.status).toBe("completed"); expect(runs).toBe(1);
    expect(task.id).toMatch(/^[\w-]{1,128}$/); expect(task.delivery).toBe("injected");
    expect(task.brief).toContain(task.evidence!.manifest);
    expect(prefill).toHaveLength(1);
    expect(prefill[0].work_id).toBe(task.id);
    expect(prefill[0].text_list).toEqual(["<backend>The fixture answer is 42.</backend>"]);
    const capture = JSON.parse(readFileSync(task.evidence!.manifest, "utf8"));
    expect(capture.inputSequence).toBe(nativeRequest.input_seq_cutoff);
    expect(capture.audioTranscript).toBeNull(); expect(capture.history).toEqual([]);
    expect(readFileSync(capture.images[0].path, "utf8")).toBe("before-image");
    expect(readFileSync(capture.audio.path).subarray(0, 4).toString()).toBe("RIFF");
    expect(statSync(task.evidence!.manifest).mode & 0o777).toBe(0o600);
    // Media continues during the backend's one-second listening pause.
    await rpc("live.stream.input", { ...p, input: { type: "audio", data: pcm.toString("base64") } });
    await until(() => audioInputs === 2); expect(step).toBe(2);
    await until(() => events.some(e => e.payload?.type === "audio"));
    const result = tasks.list(conn as any, p.ownerSession)[0]; expect(result.delivery).toBe("generated");
    const audio = events.find(e => e.payload?.type === "audio").payload;
    await rpc("live.stream.input", { ...p, input: { type: "playback", id: audio.id, played: true } });
    await until(() => acknowledgements.length === 1);
    expect(tasks.list(conn as any, p.ownerSession)[0].delivery).toBe("played");
    expect(acknowledgements[0]).toMatchObject({ utterance_id: "backend:2", cumulative_played_chunks: 1, caused_by_work_id: task.id });
    await rpc("live.stream.close"); expect(closed).toBe(true);
    // Revision retains the original capture. Public JSON cannot supply or replace it.
    const revised = tasks.revise(conn as any, { ownerSession: p.ownerSession, id: task.id, revisionId: "revised", message: "Read it again", evidence: { manifest: "/spoofed" } });
    await until(() => tasks.lookup(conn as any, { ...p, id: revised.id }).status === "completed");
    expect(revised.evidence).toEqual(task.evidence);
    const spoof = await rpc("delegation.run", { ownerSession: p.ownerSession, id: "spoof", message: "Read", evidence: { manifest: "/spoofed" }, capture: { images: [] } });
    expect(spoof.evidence).toBeUndefined();
    expect(JSON.stringify(events.filter(e => e.event === "delegation.updated"))).not.toContain(pcm.toString("base64"));
  } finally {
    if (!closed) await rpc("live.stream.close").catch(() => {});
    setSessionsDir(oldDir); rmSync(dir, { recursive: true, force: true });
  }
});
