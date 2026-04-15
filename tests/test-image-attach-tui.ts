// =============================================================================
// Tests: TUI Image Path Detection
//
// Covers: parseImagePaths — path detection, base64 conversion, mixed input,
// invalid paths, non-image files, oversized files, quoted paths with spaces,
// whitespace preservation
// =============================================================================

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseImagePaths } from "../src/tui/image-attach.js";

let testDir: string;

beforeEach(() => {
  testDir = join(tmpdir(), `hawky-img-tui-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(testDir, { recursive: true });
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch {}
});

// Create a tiny test image file
function createTestImage(name: string, sizeBytes = 100): string {
  const path = join(testDir, name);
  const buf = Buffer.alloc(sizeBytes);
  buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47; // PNG signature
  writeFileSync(path, buf);
  return path;
}

// =============================================================================
// Path detection
// =============================================================================

describe("parseImagePaths", () => {
  test("detects single image path", () => {
    const imgPath = createTestImage("test.png");
    const result = parseImagePaths(imgPath);
    expect(result.attachments.length).toBe(1);
    expect(result.attachments[0].media_type).toBe("image/png");
    expect(result.text).toBe("");
  });

  test("detects .jpg extension", () => {
    const imgPath = createTestImage("photo.jpg");
    const result = parseImagePaths(imgPath);
    expect(result.attachments.length).toBe(1);
    expect(result.attachments[0].media_type).toBe("image/jpeg");
  });

  test("detects .jpeg extension", () => {
    const imgPath = createTestImage("photo.jpeg");
    const result = parseImagePaths(imgPath);
    expect(result.attachments.length).toBe(1);
    expect(result.attachments[0].media_type).toBe("image/jpeg");
  });

  test("detects .gif extension", () => {
    const imgPath = createTestImage("anim.gif");
    const result = parseImagePaths(imgPath);
    expect(result.attachments.length).toBe(1);
    expect(result.attachments[0].media_type).toBe("image/gif");
  });

  test("detects .webp extension", () => {
    const imgPath = createTestImage("modern.webp");
    const result = parseImagePaths(imgPath);
    expect(result.attachments.length).toBe(1);
    expect(result.attachments[0].media_type).toBe("image/webp");
  });

  test("extracts text alongside image path", () => {
    const imgPath = createTestImage("test.png");
    const result = parseImagePaths(`What is in this image? ${imgPath}`);
    expect(result.attachments.length).toBe(1);
    expect(result.text).toBe("What is in this image?");
  });

  test("handles multiple image paths", () => {
    const img1 = createTestImage("a.png");
    const img2 = createTestImage("b.jpg");
    const result = parseImagePaths(`Compare ${img1} ${img2}`);
    expect(result.attachments.length).toBe(2);
    expect(result.text).toBe("Compare");
  });

  test("keeps non-existent .png paths as text", () => {
    const result = parseImagePaths("Check /nonexistent/file.png please");
    expect(result.attachments.length).toBe(0);
    expect(result.text).toContain("/nonexistent/file.png");
  });

  test("ignores non-image extensions", () => {
    const txtPath = join(testDir, "notes.txt");
    writeFileSync(txtPath, "hello");
    const result = parseImagePaths(`Read ${txtPath}`);
    expect(result.attachments.length).toBe(0);
    expect(result.text).toContain(txtPath);
  });

  test("plain text without paths returns unchanged", () => {
    const result = parseImagePaths("Hello, how are you?");
    expect(result.attachments.length).toBe(0);
    expect(result.text).toBe("Hello, how are you?");
  });

  test("empty input", () => {
    const result = parseImagePaths("");
    expect(result.attachments.length).toBe(0);
    expect(result.text).toBe("");
  });

  test("returns base64-encoded file content", () => {
    const imgPath = createTestImage("data.png", 50);
    const result = parseImagePaths(imgPath);
    expect(result.attachments[0].base64).toBeTruthy();
    const decoded = Buffer.from(result.attachments[0].base64, "base64");
    expect(decoded[0]).toBe(0x89); // PNG magic byte
  });
});

// =============================================================================
// Whitespace preservation (P1 fix)
// =============================================================================

describe("whitespace preservation", () => {
  test("preserves multiline text when no images present", () => {
    const input = "Line 1\n  Line 2\n    Line 3";
    const result = parseImagePaths(input);
    expect(result.text).toBe(input);
    expect(result.attachments.length).toBe(0);
  });

  test("preserves indentation in code blocks", () => {
    const input = "```python\ndef hello():\n    print('hi')\n```";
    const result = parseImagePaths(input);
    expect(result.text).toBe(input);
  });

  test("preserves multiple spaces", () => {
    const input = "word1    word2";
    const result = parseImagePaths(input);
    expect(result.text).toBe(input);
  });
});

// =============================================================================
// Quoted paths (P2 fix)
// =============================================================================

describe("quoted paths", () => {
  test("handles double-quoted paths", () => {
    const imgPath = createTestImage("test.png");
    const result = parseImagePaths(`"${imgPath}"`);
    expect(result.attachments.length).toBe(1);
  });

  test("handles single-quoted paths", () => {
    const imgPath = createTestImage("test.png");
    const result = parseImagePaths(`'${imgPath}'`);
    expect(result.attachments.length).toBe(1);
  });

  test("handles quoted paths with spaces in filename", () => {
    const imgPath = join(testDir, "my image.png");
    const buf = Buffer.alloc(50);
    buf[0] = 0x89;
    writeFileSync(imgPath, buf);
    const result = parseImagePaths(`Check "${imgPath}"`);
    expect(result.attachments.length).toBe(1);
    expect(result.text).toBe("Check");
  });
});

// =============================================================================
// Edge cases
// =============================================================================

describe("edge cases", () => {
  test("oversized image returns error", () => {
    const imgPath = createTestImage("huge.png", 6 * 1024 * 1024); // 6MB
    const result = parseImagePaths(imgPath);
    expect(result.attachments.length).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain("too large");
  });

  test("non-absolute paths without image extension pass through", () => {
    const result = parseImagePaths("Hello world no images here");
    expect(result.attachments.length).toBe(0);
    expect(result.text).toBe("Hello world no images here");
  });
});
