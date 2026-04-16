// =============================================================================
// Node Config Tests
//
// Tests for node host configuration persistence.
// =============================================================================

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadNodeConfig, saveNodeConfig } from "../src/node/config.js";
import { existsSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";

// We override getConfigDir to use a temp directory
const TEST_DIR = join(import.meta.dir, ".test-node-config");

// Override config dir for tests
import { setConfigDir, resetConfigDir } from "../src/storage/config.js";

describe("Node Config", () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
    mkdirSync(TEST_DIR, { recursive: true });
    setConfigDir(TEST_DIR);
  });

  afterEach(() => {
    resetConfigDir();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true });
  });

  test("creates default config on first load", () => {
    const config = loadNodeConfig();
    expect(config.nodeId).toBeTruthy();
    expect(config.nodeId.length).toBeGreaterThan(10); // UUID
    expect(config.displayName).toBeTruthy();
    expect(config.gateway).toBe("ws://localhost:4242");
  });

  test("persists and reloads config", () => {
    const config1 = loadNodeConfig();
    const config2 = loadNodeConfig();
    expect(config2.nodeId).toBe(config1.nodeId);
  });

  test("saves custom config", () => {
    saveNodeConfig({
      nodeId: "custom-id",
      displayName: "my-mac",
      gateway: "ws://cloud:4242",
    });

    const config = loadNodeConfig();
    expect(config.nodeId).toBe("custom-id");
    expect(config.displayName).toBe("my-mac");
    expect(config.gateway).toBe("ws://cloud:4242");
  });

  test("handles corrupt config file", () => {
    // Create corrupt file
    const dir = join(TEST_DIR, "state");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "node.json");
    require("fs").writeFileSync(path, "not json");

    const config = loadNodeConfig();
    expect(config.nodeId).toBeTruthy(); // Regenerated
    expect(config.gateway).toBe("ws://localhost:4242");
  });
});
