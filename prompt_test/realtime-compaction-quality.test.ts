import { expect, test } from "bun:test";
import { gradeChecks, movement, observedBadSummary, summaryCases } from "./fixtures/compaction-cases";

test("the observed advice fails the mixed-history quality checks", () => {
  const checks = gradeChecks(observedBadSummary, summaryCases[0].summaryChecks);
  expect(checks["earlier directory"]).toBe(false);
  expect(checks["corrected meeting"]).toBe(false);
  expect(checks["not a fresh advice reply"]).toBe(false);
});
test("known-good summaries cover each scenario's required facts", () => {
  for (const scenario of summaryCases) expect(Object.values(gradeChecks(scenario.example, scenario.summaryChecks))).not.toContain(false);
});
test("fact mutations and missing topics fail independently of valid output format", () => {
  const mixed = summaryCases[0];
  expect(gradeChecks(mixed.example.replace("15:00", "11:00"), mixed.summaryChecks)["corrected meeting"]).toBe(false);
  expect(gradeChecks(mixed.example.replace("/workspace/cedar", "somewhere"), mixed.summaryChecks)["earlier directory"]).toBe(false);
  const visual = summaryCases.at(-1)!;
  expect(gradeChecks(visual.example.replace("from left to right", "from right to left"), visual.summaryChecks)["red circle moved right"]).toBe(false);
  const tasks = summaryCases[2];
  expect(gradeChecks(tasks.example.replace("requested but not confirmed", "confirmed"), tasks.summaryChecks)["cancellation unconfirmed"]).toBe(false);
});
test("visual checks accept frame-by-frame descriptions and reject incorrect positions", () => {
  const frames = "At 00:00, a red circle on the left and a blue square on the right.\nAt 00:30, a blue square on the left and a red circle on the right.";
  expect(movement(frames, "red circle", "left", "right")).toBe(true);
  expect(movement(frames, "blue square", "right", "left")).toBe(true);
  expect(movement(frames.replace("red circle on the right", "red circle on the left"), "red circle", "left", "right")).toBe(false);
  expect(movement("Red circle moved from right to left; blue square moved from left to right.", "red circle", "left", "right")).toBe(false);
});
