import { mkdirSync, writeFileSync } from "node:fs";
import { commands } from "./tasks";

const task = process.argv[2];
const plan = commands(task); // Reject invalid/misspelled tasks before reporting success.
const budgetMs = 28_000;
const start = performance.now();
let failed = false;
const results: Array<{ command: string[]; seconds: number; exitCode: number; timedOut: boolean }> = [];
for (const command of plan) {
  const remaining = budgetMs - (performance.now() - start);
  if (remaining <= 0) { failed = true; break; }
  const began = performance.now();
  let timedOut = false;
  const child = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, remaining);
  const exitCode = await child.exited;
  clearTimeout(timer);
  results.push({ command, seconds: (performance.now() - began) / 1000, exitCode, timedOut });
  if (exitCode !== 0 || timedOut) failed = true;
}
const seconds = (performance.now() - start) / 1000;
failed ||= results.length !== plan.length || seconds >= 30;
mkdirSync("test-results", { recursive: true });
writeFileSync(`test-results/${task.replaceAll(":", "-")}.json`, JSON.stringify({ task, seconds, budgetMs, failed, results }, null, 2));
console.log(`CI ${task}: ${seconds.toFixed(2)}s; ${failed ? "FAIL (test error or time budget)" : "PASS"}`);
process.exit(failed ? 1 : 0);
