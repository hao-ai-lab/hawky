import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../storage/config.js";

const DEFAULT_MEDIA_ROOT = join(homedir(), ".hawky", "workspace", "media");

export function resolveMediaRoot(): string {
  if (process.env.HAWKY_MEDIA_ROOT) return process.env.HAWKY_MEDIA_ROOT;
  try {
    const cfg = loadConfig();
    const mediaRoot = cfg.media?.root;
    if (typeof mediaRoot === "string" && mediaRoot.trim()) return mediaRoot;
  } catch {
    // Fall through to the default path when config is unavailable.
  }
  return DEFAULT_MEDIA_ROOT;
}
