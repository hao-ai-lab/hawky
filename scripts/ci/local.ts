/** Run the exact CI tasks locally with bounded CPU use, keeping each job's log. */
import { mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import { tasks } from "./tasks";
const concurrency = Number(process.env.CI_WORKERS || 4);
if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error("Invalid CI_WORKERS");
mkdirSync("test-results/logs", { recursive: true });
const queue = [...tasks];
const results: Array<{ task: string; exit: number }> = [];
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (queue.length) {
    const task = queue.shift()!;
    const fd = openSync(`test-results/logs/${task.replaceAll(":", "-")}.log`, "w");
    const child = Bun.spawn(["bun", "scripts/ci/run.ts", task], { stdout: fd, stderr: fd });
    const exit = await child.exited; closeSync(fd);
    results.push({ task, exit }); console.log(`${task}: ${exit === 0 ? "PASS" : "FAIL"}`);
  }
}));
writeFileSync("test-results/local.json", JSON.stringify(results, null, 2));
process.exit(results.some(r => r.exit !== 0) ? 1 : 0);
