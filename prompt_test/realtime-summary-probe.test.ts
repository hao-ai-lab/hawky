import { describe, expect, test } from "bun:test";
import { gradeSummary, summarizeAudio } from "./realtime-summary-probe";

describe("summary probe failure detection", () => {
  const ids = ["first", "second"];
  const valid = { meeting_time: "16:00", visual_changes: [
    { object: "red circle", from: "left", to: "right" },
    { object: "blue square", from: "right", to: "left" },
  ], evidence_ids: ids };
  test("accepts the observed changes and frozen correction", () => {
    expect(Object.values(gradeSummary(JSON.stringify(valid), ids)).every(Boolean)).toBe(true);
  });
  test("rejects malformed output, wrong direction, stale time, and invented evidence", () => {
    expect(gradeSummary("not JSON", ids).validJson).toBe(false);
    expect(gradeSummary("null", ids).validJson).toBe(false);
    expect(gradeSummary(`(${JSON.stringify(valid)})`, ids).validJson).toBe(false);
    expect(gradeSummary(`=${JSON.stringify(valid)}`, ids).validJson).toBe(false);
    expect(gradeSummary(JSON.stringify({ ...valid, visual_changes: [{ object: 123 }] }), ids).visualChanges).toBe(false);
    expect(gradeSummary(JSON.stringify({ ...valid, meeting_time: "15:00" }), ids).correctedTime).toBe(false);
    expect(gradeSummary(JSON.stringify({ ...valid, meeting_time: "17:00" }), ids).correctedTime).toBe(false);
    expect(gradeSummary(JSON.stringify({ ...valid, visual_changes: valid.visual_changes.slice(0, 1) }), ids).visualChanges).toBe(false);
    expect(gradeSummary(JSON.stringify({ ...valid, evidence_ids: [...ids, "invented"] }), ids).evidence).toBe(false);
  });
  test("audio timing excludes other responses and does not equate missing audio with zero latency", () => {
    const reply = { id: "speech", requestedMs: 100, createdMs: 150 };
    const events = [
      { ms: 200, event: { type: "response.output_audio.delta", response_id: "speech", audioBytes: 4800 } },
      { ms: 800, event: { type: "response.output_audio.delta", response_id: "other", audioBytes: 96000 } },
      { ms: 900, event: { type: "response.output_audio.delta", response_id: "speech", audioBytes: 4800 } },
    ];
    expect(summarizeAudio(events, reply, 1000)).toEqual({ firstAudioMs: 100, responseMs: 900, audioChunks: 2, generatedAudioMs: 200, maxChunkGapMs: 700 });
    expect(summarizeAudio([], reply, 1000).firstAudioMs).toBeNull();
  });
});
