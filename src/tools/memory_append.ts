// =============================================================================
// memory.append tool
//
// Append-only write to a per-category daily JSONL log under the workspace's
// memory/ directory. Used by the voice-memo proposer + other action-proposers
// to capture "this happened" entries without going through the richer
// memory_search/memory_get indexing path.
//
// Layout:
//   <workspace>/memory/<category>/<YYYY-MM-DD>.jsonl
//
// Each line is a JSON object:
//   { ts_iso, category, text, source_session }
//
// NOTE on memory API reuse: src/memory/global.ts exposes getGlobalMemoryIndex,
// but its public surface is search/retrieval (hybrid embeddings + BM25), not
// append-to-daily-log. The MemoryWatcher watches the workspace memory/ tree
// and will pick up our JSONL files for future indexing. We deliberately
// write plain files here rather than go through the index API, matching how
// memory_get / memory_search interact with on-disk files today.
// =============================================================================

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ToolDefinition,
  ToolContext,
  ToolResult,
} from "../agent/types.js";
import { WorkspaceManager } from "../storage/workspace.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("tools/memory_append");

interface MemoryAppendInput {
  category: string;
  text: string;
  ts_iso?: string;
}

const CATEGORY_RE = /^[a-zA-Z0-9_\-]+$/;

function todayIso(): string {
  // Local-date YYYY-MM-DD — matches the daily-log convention in context.ts.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export async function executeMemoryAppend(
  input: MemoryAppendInput,
  context: ToolContext,
): Promise<ToolResult> {
  const category = typeof input.category === "string" ? input.category.trim() : "";
  const text = typeof input.text === "string" ? input.text : "";
  const tsIso =
    typeof input.ts_iso === "string" && input.ts_iso.trim()
      ? input.ts_iso.trim()
      : new Date().toISOString();

  if (!category) {
    return { type: "error", content: "Missing required parameter: category" };
  }
  if (!CATEGORY_RE.test(category)) {
    return {
      type: "error",
      content:
        `Invalid category "${category}". ` +
        "Allowed: alphanumerics, dash, and underscore (e.g., 'daily-log', 'observations').",
    };
  }
  if (!text.trim()) {
    return { type: "error", content: "Missing required parameter: text" };
  }

  try {
    const ws = new WorkspaceManager();
    const memRoot = ws.getMemoryDir();
    const categoryDir = join(memRoot, category);
    const fname = `${todayIso()}.jsonl`;
    const filePath = join(categoryDir, fname);

    if (!existsSync(dirname(filePath))) {
      mkdirSync(dirname(filePath), { recursive: true });
    }

    const entry = {
      ts_iso: tsIso,
      category,
      text,
      source_session: context.session_id,
    };
    appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");

    log.info("memory.append wrote entry", {
      category,
      file: filePath,
      chars: text.length,
    });

    return {
      type: "text",
      content: `ok: appended to memory/${category}/${fname}`,
      metadata: { file: filePath, category, ts_iso: tsIso },
    };
  } catch (err) {
    return {
      type: "error",
      content: `memory.append failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export const memoryAppendToolDefinition: ToolDefinition<MemoryAppendInput> = {
  name: "memory_append",
  description:
    "Append a text entry to a per-category daily JSONL log in the workspace " +
    "memory/ tree. Use for 'this happened' captures that aren't yet ready for " +
    "structured MEMORY.md curation. Example categories: 'daily-log', " +
    "'observations', 'reminders'. The category directory is created on first " +
    "write. Each day gets its own file (YYYY-MM-DD.jsonl). " +
    "NOTE: this does NOT replace memory_search / memory_get — those still own " +
    "retrieval of MEMORY.md and curated daily notes.",
  input_schema: {
    type: "object",
    properties: {
      category: {
        type: "string",
        description:
          "Category name (e.g., 'daily-log'). Alphanumerics, dash, underscore only.",
      },
      text: {
        type: "string",
        description: "The line to append. Plain text; no markdown required.",
      },
      ts_iso: {
        type: "string",
        description:
          "Optional ISO-8601 timestamp for the entry. Defaults to now.",
      },
    },
    required: ["category", "text"],
  },
  permission: "auto_approve",
  execute: executeMemoryAppend as any,
};
