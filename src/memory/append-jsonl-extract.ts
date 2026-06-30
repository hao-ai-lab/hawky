import { readFileSync } from "node:fs";

export interface MemoryAppendJsonlTextResult {
  text: string;
  entryCount: number;
}

export function extractMemoryAppendJsonlText(filePath: string): MemoryAppendJsonlTextResult {
  const lines = readFileSync(filePath, "utf-8").split("\n").filter((line) => line.trim());
  const parts: string[] = [];

  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text.trim() : "";
    if (!text) continue;

    const category = typeof record.category === "string" && record.category.trim()
      ? record.category.trim()
      : "memory";
    const tsIso = typeof record.ts_iso === "string" && record.ts_iso.trim()
      ? `${record.ts_iso.trim()} `
      : "";
    parts.push(`${tsIso}[${category}] ${text}`);
  }

  return { text: parts.join("\n"), entryCount: parts.length };
}
