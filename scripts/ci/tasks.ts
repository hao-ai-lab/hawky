import { Glob } from "bun";
import { statSync } from "node:fs";

export const CORE_SHARDS = 64;
export function coreFiles(): string[] {
  return [...new Set(["tests/test-*.ts", "tests/test-*.tsx", "tests/unit/*.test.ts", "tests/integration/*.ts"]
    .flatMap(pattern => [...new Glob(pattern).scanSync(".")]))].sort();
}
/** Largest files first balances cost better than alphabetical batches.
 * Every discovered file belongs to exactly one shard, including new tests.
 */
export function partition(files: string[], count: number): string[][] {
  if (!Number.isInteger(count) || count < 1) throw new Error("Invalid shard count");
  const bins = Array.from({ length: count }, () => ({ size: 0, files: [] as string[] }));
  const ordered = files.map(file => ({ file, size: statSync(file).size }))
    .sort((a, b) => b.size - a.size || a.file.localeCompare(b.file));
  for (const { file, size } of ordered) {
    const bin = bins.reduce((a, b) => a.size <= b.size ? a : b);
    bin.files.push(file); bin.size += size;
  }
  return bins.map(b => b.files);
}
export function commands(task: string): string[][] {
  if (task === "typecheck") return [["bun", "run", "typecheck"]];
  if (task === "build") return [["bun", "run", "build"]];
  if (task === "boundaries") return [["bun", "scripts/ci/boundaries.ts"]];
  if (task === "web-build" || task === "web-ios-build") return [["bun", "run", "--cwd", task.slice(0, -6), "build"]];
  const core = /^core:(\d+)$/.exec(task);
  if (core) {
    const index = Number(core[1]);
    if (index >= CORE_SHARDS) throw new Error("Invalid core shard");
    // Separate processes isolate mock.module, environment, and singleton state.
    return partition(coreFiles(), CORE_SHARDS)[index].map(file => ["bun", "test", "--timeout", "10000", `./${file}`]);
  }
  const web = /^(web|web-ios):(\d+)$/.exec(task);
  if (web) {
    const total = web[1] === "web" ? 4 : 8, index = Number(web[2]);
    if (index < 1 || index > total) throw new Error("Invalid web shard");
    const files = [...new Glob(`${web[1]}/tests/**/*.test.{ts,tsx}`).scanSync(".")];
    const selected = partition(files, total)[index - 1].map(file => file.slice(web[1].length + 1));
    if (!selected.length) throw new Error(`Empty web shard: ${task}`);
    return [["bun", "run", "--cwd", web[1], "test", ...selected, "--maxWorkers=2", "--minWorkers=1"]];
  }
  throw new Error(`Unknown CI task: ${task}`);
}
export const tasks = ["typecheck", "build", "boundaries", "web-build", "web-ios-build",
  ...Array.from({ length: CORE_SHARDS }, (_, i) => `core:${i}`),
  ...Array.from({ length: 4 }, (_, i) => `web:${i + 1}`),
  ...Array.from({ length: 8 }, (_, i) => `web-ios:${i + 1}`)];
