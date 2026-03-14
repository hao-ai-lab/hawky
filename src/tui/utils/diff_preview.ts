// =============================================================================
// Diff Preview
//
// Generates a color-coded unified diff for permission prompts.
// Green for additions, red for removals.
// =============================================================================

const MAX_DIFF_LINES = 10;

/**
 * Generate a simple line-by-line diff between old and new content.
 * Returns ANSI-colored string.
 */
export function generateDiffPreview(
  oldContent: string | null,
  newContent: string,
): string {
  if (oldContent === null) {
    // New file — show first lines as additions
    const lines = newContent.split("\n").slice(0, MAX_DIFF_LINES);
    const result = lines.map((l) => `\x1b[32m+ ${l}\x1b[0m`);
    const remaining = newContent.split("\n").length - lines.length;
    if (remaining > 0) {
      result.push(`\x1b[90m  ... (${remaining} more lines)\x1b[0m`);
    }
    return result.join("\n");
  }

  const oldLines = oldContent.split("\n");
  const newLines = newContent.split("\n");

  // Simple diff: find changed regions
  const diffLines: string[] = [];
  let displayed = 0;

  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen && displayed < MAX_DIFF_LINES; i++) {
    const oldLine = i < oldLines.length ? oldLines[i] : undefined;
    const newLine = i < newLines.length ? newLines[i] : undefined;

    if (oldLine === newLine) {
      // Context line — skip unless adjacent to a change
      continue;
    }

    if (oldLine !== undefined && newLine !== undefined) {
      // Changed line
      diffLines.push(`\x1b[31m- ${oldLine}\x1b[0m`);
      diffLines.push(`\x1b[32m+ ${newLine}\x1b[0m`);
      displayed += 2;
    } else if (oldLine !== undefined) {
      // Removed line
      diffLines.push(`\x1b[31m- ${oldLine}\x1b[0m`);
      displayed++;
    } else if (newLine !== undefined) {
      // Added line
      diffLines.push(`\x1b[32m+ ${newLine}\x1b[0m`);
      displayed++;
    }
  }

  if (displayed >= MAX_DIFF_LINES) {
    diffLines.push(`\x1b[90m  ... (more changes)\x1b[0m`);
  }

  if (diffLines.length === 0) {
    return "\x1b[90m  (no visible changes)\x1b[0m";
  }

  return diffLines.join("\n");
}

/**
 * Format a diff preview for edit_file tool.
 * Shows old_string → new_string change.
 */
export function formatEditDiff(oldString: string, newString: string): string {
  const oldLines = oldString.split("\n");
  const newLines = newString.split("\n");
  const result: string[] = [];
  let displayed = 0;

  for (const line of oldLines) {
    if (displayed >= MAX_DIFF_LINES) break;
    result.push(`\x1b[31m- ${line}\x1b[0m`);
    displayed++;
  }
  for (const line of newLines) {
    if (displayed >= MAX_DIFF_LINES) break;
    result.push(`\x1b[32m+ ${line}\x1b[0m`);
    displayed++;
  }

  const total = oldLines.length + newLines.length;
  if (total > MAX_DIFF_LINES) {
    result.push(`\x1b[90m  ... (${total - displayed} more lines)\x1b[0m`);
  }

  return result.join("\n");
}
