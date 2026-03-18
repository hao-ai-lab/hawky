// =============================================================================
// Skill Frontmatter Parser
//
// Parses YAML frontmatter from SKILL.md files.
// Format: --- delimited block at top of file with key: value pairs.
// Supports both single-line and multi-line metadata values.
// Multi-line: when a key's value starts on the next line with indentation,
// all subsequent indented lines are accumulated (common in nested skill frontmatter).
// =============================================================================

import type { SkillMetadata, SkillConfig } from "./types.js";

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Returns null if no valid frontmatter found.
 */
export function parseFrontmatter(content: string): SkillMetadata | null {
  if (!content.startsWith("---")) return null;

  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) return null;

  const yamlBlock = content.slice(4, endIdx);
  const metadata: Record<string, string> = {};
  const lines = yamlBlock.split("\n");

  let currentKey: string | null = null;
  let currentValue = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Check if this is a top-level key (not indented, has colon)
    if (line.length > 0 && line[0] !== " " && line[0] !== "\t" && line.includes(":")) {
      // Flush previous key
      if (currentKey) {
        metadata[currentKey] = cleanValue(currentValue);
      }

      const colonIdx = line.indexOf(":");
      currentKey = line.slice(0, colonIdx).trim();
      currentValue = line.slice(colonIdx + 1).trim();
    } else if (currentKey && (line.startsWith("  ") || line.startsWith("\t") || line.trim() === "")) {
      // Continuation of previous key's value (indented or empty line)
      currentValue += "\n" + line;
    }
  }

  // Flush last key
  if (currentKey) {
    metadata[currentKey] = cleanValue(currentValue);
  }

  if (!metadata.name || !metadata.description) return null;

  return {
    name: metadata.name,
    description: metadata.description,
    metadata: metadata.metadata,
    "user-invocable": metadata["user-invocable"] === "false" ? false : true,
    "disable-model-invocation": metadata["disable-model-invocation"] === "true",
  };
}

/**
 * Clean a frontmatter value: strip quotes, trim whitespace.
 */
function cleanValue(raw: string): string {
  let value = raw.trim();
  // Strip surrounding quotes (single-line values)
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value;
}

/**
 * Parse the nested config block from frontmatter metadata JSON string.
 * Reads the "hawky" config key.
 * Handles multi-line JSON (from nested frontmatter).
 */
export function parseSkillConfig(metadataJson?: string): SkillConfig {
  if (!metadataJson) return {};

  try {
    // Clean up: remove trailing commas (some frontmatter uses them in JSON)
    const cleaned = metadataJson.replace(/,(\s*[}\]])/g, "$1");
    const parsed = JSON.parse(cleaned);
    if (typeof parsed !== "object" || parsed === null) return {};
    return parsed.hawky ?? {};
  } catch {
    return {};
  }
}

/**
 * Strip frontmatter from SKILL.md content, returning just the markdown body.
 */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) return content;
  return content.slice(endIdx + 4).trim();
}
