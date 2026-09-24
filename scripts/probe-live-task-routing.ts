/** Opt-in semantic eval. Calls gpt-5.4-mini, but never executes routed tasks.
 * bun scripts/probe-live-task-routing.ts
 */
import { loadConfig } from "../src/storage/config.js";
import { routeLiveDelegation } from "../src/live/gpt-live-router.js";
import type { DelegationTask } from "../src/gateway/delegation-types.js";

const key = process.env.OPENAI_API_KEY || loadConfig().api_keys?.openai;
if (!key) throw new Error("Set OPENAI_API_KEY or configure the gateway OpenAI key.");
const task = (id: string, request: string, status: DelegationTask["status"] = "running", result?: string): DelegationTask => ({
  id, request, status, result, ownerSession: "eval", backendSession: `eval-${id}`, runtime: "codex", validity: "current", createdAt: 0, events: [],
});
const robotics = task("robotics", "Search robotics research directions");
const papers = task("papers", "Find recursive self-improvement papers", "completed", "1. STaR. 2. AlphaEvolve. 3. Self-Refine.");
const files = task("files", "Read alpha.txt");
const cases = [
  { name: "additional search", text: "Meanwhile, also search recursive self-improvement.", tasks: [robotics], action: "submit", target: "" },
  { name: "explicit separate directory", text: "In a separate task, list the current directory.", tasks: [robotics], action: "submit", target: "" },
  { name: "missing request is additional", text: "I also told you to search recursive self-improvement.", tasks: [robotics], action: "submit", target: "" },
  { name: "follow-up identifies result", text: "Explain the second paper you found.", tasks: [papers, task("directory", "List directory", "completed", "alpha.txt, beta.txt")], action: "submit", target: "papers" },
  { name: "explicit replacement", text: "Instead of robotics, search recursive self-improvement.", tasks: [robotics], action: "revise", target: "robotics" },
  { name: "file correction", text: "I meant beta.txt, not alpha.txt.", tasks: [robotics, files], action: "revise", target: "files" },
  { name: "ambiguous cancellation", text: "Cancel that one.", tasks: [robotics, files], clarify: true },
  { name: "speech interruption only", text: "Stop talking for a moment.", tasks: [robotics], none: true },
];
let failed = 0;
for (const c of cases) {
  const start = Date.now();
  const result = await routeLiveDelegation(key, { conversation: [{ role: "user", text: c.text }], tasks: c.tasks }, AbortSignal.timeout(30000));
  const a = result.actions[0];
  const pass = c.clarify ? !!result.clarification && !result.actions.length : c.none ? !result.actions.length :
    !result.clarification && result.actions.length === 1 && a.action === c.action && a.taskId === c.target && a.readOnly;
  if (!pass) failed++;
  console.log(JSON.stringify({ case: c.name, pass, ms: Date.now() - start, ...result }));
}
console.log(`${cases.length - failed}/${cases.length} semantic routing cases passed (no tasks executed).`);
if (failed) process.exitCode = 1;
