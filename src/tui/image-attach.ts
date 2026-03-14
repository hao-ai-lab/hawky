// =============================================================================
// TUI Image Attachment Detection
//
// Detects image file paths in user input text. When a user drags an image into
// the terminal or types a path, this extracts the image, reads it as base64,
// and returns it as an attachment alongside the remaining text.
//
// Supports: .png, .jpg, .jpeg, .gif, .webp
// =============================================================================

import { existsSync, readFileSync, statSync } from "node:fs";
import { extname } from "node:path";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

const MIME_MAP: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/** Regex to find potential image file paths — absolute paths ending in image extensions. */
const IMAGE_PATH_REGEX = /(?:^|\s)(?:["']([^"']+\.(?:png|jpe?g|gif|webp))["']|(\/[^\s"']+\.(?:png|jpe?g|gif|webp)))/gi;

export interface ParsedImageInput {
  /** Remaining text after image paths are extracted */
  text: string;
  /** Extracted image attachments */
  attachments: Array<{ base64: string; media_type: string }>;
  /** Errors for images that couldn't be read */
  errors: string[];
}

/**
 * Parse user input for image file paths.
 * Returns the text without image paths and any extracted attachments.
 *
 * Key design: preserve original text formatting (whitespace, newlines).
 * Only extract paths that look like image files AND exist on disk.
 */
export function parseImagePaths(input: string): ParsedImageInput {
  const attachments: Array<{ base64: string; media_type: string }> = [];
  const errors: string[] = [];

  // Quick check: if input doesn't contain any image extension, skip parsing entirely
  if (!IMAGE_EXTENSIONS.has(extname(input.trim().replace(/^['"]|['"]$/g, "")).toLowerCase()) &&
      !input.match(/\.(?:png|jpe?g|gif|webp)/i)) {
    return { text: input, attachments: [], errors: [] };
  }

  // Find all potential image paths (with or without quotes)
  let text = input;
  const matches: Array<{ fullMatch: string; path: string }> = [];

  let m: RegExpExecArray | null;
  const regex = new RegExp(IMAGE_PATH_REGEX.source, IMAGE_PATH_REGEX.flags);
  while ((m = regex.exec(input)) !== null) {
    const path = m[1] ?? m[2]; // m[1] = quoted path, m[2] = unquoted path
    if (path) {
      matches.push({ fullMatch: m[0], path });
    }
  }

  // Process matches in reverse order to preserve string indices when removing
  for (let i = matches.length - 1; i >= 0; i--) {
    const { fullMatch, path } = matches[i];

    if (!existsSync(path)) continue;

    try {
      const stat = statSync(path);
      if (stat.size > MAX_IMAGE_BYTES) {
        errors.push(`${path}: too large (${(stat.size / 1024 / 1024).toFixed(1)}MB, max 5MB)`);
        // Remove the path from text even on error
        text = text.replace(fullMatch, fullMatch[0] === " " ? " " : "");
        continue;
      }

      const data = readFileSync(path);
      const ext = extname(path).toLowerCase();
      const mediaType = MIME_MAP[ext] ?? "image/png";

      attachments.unshift({ // unshift since we're processing in reverse
        base64: data.toString("base64"),
        media_type: mediaType,
      });

      // Remove the matched path from the text, preserving surrounding whitespace
      text = text.replace(fullMatch, fullMatch[0] === " " ? " " : "");
    } catch (err) {
      errors.push(`${path}: ${err instanceof Error ? err.message : "read error"}`);
    }
  }

  return {
    text: text.trim(),
    attachments,
    errors,
  };
}
