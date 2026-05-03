// =============================================================================
// Prompt RPC Method Handlers (#512)
//
// CRUD over the prompt registry so clients (web/TUI/iOS) can read, edit, and
// reset prompts at runtime — no rebuild required. "Read" returns the resolved
// text (override or bundled default); "update" writes an override file; "delete"
// removes the override and falls back to the default. The bundled default is
// immutable, and only KNOWN prompt ids are accepted.
//
//   prompts.list   — all prompts with status (text, default, overridden)
//   prompts.get    — one prompt's status, by id
//   prompts.set    — write an override for id  { id, text }
//   prompts.delete — remove the override for id  { id }
// =============================================================================

import type { GatewayServer } from "./server.js";
import { MethodError } from "./methods.js";
import {
  isKnownPromptId,
  getPromptStatus,
  listPromptsWithStatus,
  setPromptOverride,
  deletePromptOverride,
} from "../prompts/index.js";

export function registerPromptMethods(server: GatewayServer): void {
  // prompts.list — every prompt + resolved/default/overridden status
  server.registerMethod("prompts.list", () => {
    return { prompts: listPromptsWithStatus() };
  });

  // prompts.get — one prompt's status
  server.registerMethod("prompts.get", (_conn, params) => {
    const id = (params as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !id.trim()) {
      throw new MethodError("INVALID_REQUEST", "id is required");
    }
    if (!isKnownPromptId(id)) {
      throw new MethodError("NOT_FOUND", `Unknown prompt id: "${id}"`);
    }
    return getPromptStatus(id);
  });

  // prompts.set — write an override
  server.registerMethod("prompts.set", (_conn, params) => {
    const p = params as { id?: unknown; text?: unknown } | undefined;
    const id = p?.id;
    const text = p?.text;
    if (typeof id !== "string" || !id.trim()) {
      throw new MethodError("INVALID_REQUEST", "id is required");
    }
    if (typeof text !== "string") {
      throw new MethodError("INVALID_REQUEST", "text is required (string)");
    }
    if (!isKnownPromptId(id)) {
      throw new MethodError("NOT_FOUND", `Unknown prompt id: "${id}"`);
    }
    setPromptOverride(id, text);
    return getPromptStatus(id);
  });

  // prompts.delete — remove the override (fall back to bundled default)
  server.registerMethod("prompts.delete", (_conn, params) => {
    const id = (params as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !id.trim()) {
      throw new MethodError("INVALID_REQUEST", "id is required");
    }
    if (!isKnownPromptId(id)) {
      throw new MethodError("NOT_FOUND", `Unknown prompt id: "${id}"`);
    }
    const removed = deletePromptOverride(id);
    return { ...getPromptStatus(id), removed };
  });
}
