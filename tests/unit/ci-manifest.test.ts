import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { commands, coreFiles, CORE_SHARDS, partition, tasks } from "../../scripts/ci/tasks";

test("every backend test is assigned exactly once", () => {
  const files = coreFiles(), assigned = partition(files, CORE_SHARDS).flat();
  expect(files.length).toBeGreaterThan(250);
  expect(assigned.length).toBe(files.length);
  expect([...new Set(assigned)].sort()).toEqual(files);
  expect(files.some(f => f.startsWith("tests/integration/"))).toBe(true);
});
test("Actions matrix includes every local task", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const matrix = JSON.parse(workflow.match(/        task: (\[.*\])/ )![1]);
  expect(matrix.slice().sort()).toEqual(tasks.slice().sort());
  for (const task of tasks) expect(commands(task).length).toBeGreaterThan(0);
  expect(() => commands("core:64")).toThrow();
  expect(() => commands("web-ios:9")).toThrow();
  expect(() => commands("typo")).toThrow();
});
