import { expect, it } from "vitest";
import { readSummary, summaryResponse } from "../src/lib/realtime-compaction-summary";
import { summaryJson, summaryOutput } from "./fixtures/compaction-summary";

const response = (text: string) => ({ status: "completed", output: [summaryOutput(text)] });
it.each([
  "Thanks for sharing that. You should contact a clinician.",
  "I'll set a reminder for you.",
  `\`\`\`json\n${summaryJson()}\n\`\`\``,
  `(${summaryJson()}) Here's my advice.`,
  `(${summaryJson()})`,
  `= ${summaryJson()}`,
  `(${summaryJson().slice(0, -1)})`,
  JSON.stringify({ type: "history_summary", facts: ["Only one field"] }),
  summaryJson().replace('"facts":["Earlier facts and image observations."]', '"facts":[]'),
  summaryJson().replace('"corrections":[]', '"corrections":[false]'),
  summaryJson(" "),
  summaryJson("word ".repeat(601)),
])("rejects invalid output without trying to repair it: %s", text => {
  expect(() => readSummary(response(text))).toThrow("Original context retained");
});
it("keeps facts, corrections, pending work and uncertainty distinct", () => {
  const text = JSON.stringify({ type: "history_summary", facts: ["The agent is Hawk."],
    corrections: ["The user corrected meeting time to 16:00."], open_threads: ["Reminder requested; no success confirmed."],
    uncertainties: ["Meeting date is unknown."] });
  expect(readSummary(response(text))).toBe("Facts:\n- The agent is Hawk.\n\nCorrections:\n- The user corrected meeting time to 16:00.\n\nOpen threads:\n- Reminder requested; no success confirmed.\n\nUncertainties:\n- Meeting date is unknown.");
});
it("rejects incomplete output, other tools, text replies, and audio even with valid summary text", () => {
  expect(() => readSummary({ ...response(summaryJson()), status: "incomplete" })).toThrow();
  expect(() => readSummary({ status: "completed", output: [{ type: "function_call", arguments: summaryJson() }] })).toThrow();
  expect(() => readSummary({ status: "completed", output: [{ ...summaryOutput(), name: "backend_agent" }] })).toThrow();
  expect(() => readSummary({ status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: summaryJson() }] }] })).toThrow();
  expect(() => readSummary({ status: "completed", output: [{ type: "message", content: [{ type: "output_audio", text: summaryJson() }] }] })).toThrow();
  expect(() => readSummary({ status: "completed", output: [summaryOutput(), summaryOutput()] })).toThrow();
});
it("discards a private preamble and reads only the named function arguments", () => {
  expect(readSummary({ status: "completed", output: [
    { type: "message", content: [{ type: "output_text", text: "I will compile the record now." }] }, summaryOutput(),
  ] })).toBe("Facts:\n- Earlier facts and image observations.");
});
it("includes retained corrections as evidence, and finishes with a summarization task", () => {
  const result = summaryResponse([{ id: "misheard", compact: true }, { id: "correction", compact: false }], "job");
  expect(result.input.filter(i => i.type === "item_reference")).toEqual([
    { type: "item_reference", id: "misheard" }, { type: "item_reference", id: "correction" },
  ]);
  expect(JSON.stringify(result.input)).toContain("will NOT be deleted");
  expect(JSON.stringify(result.input.at(-1))).toContain("Do not continue the conversation");
});
