import { SUMMARY_TOOL } from "../../src/lib/realtime-compaction-summary";
export const summaryJson = (text = "Earlier facts and image observations.") => JSON.stringify({
  type: "history_summary", facts: [text], corrections: [], open_threads: [], uncertainties: [],
});
export const summaryOutput = (text = summaryJson()) => ({
  type: "function_call", name: SUMMARY_TOOL.name, arguments: text,
});
