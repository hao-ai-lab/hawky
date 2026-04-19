// =============================================================================
// Tests for skill status report (src/skills/status.ts)
// =============================================================================

import { describe, expect, test } from "bun:test";
import {
  buildSkillStatusReport,
  formatSkillStatusReport,
  type SkillStatusReport,
} from "../src/skills/status.js";

// =============================================================================
// buildSkillStatusReport
// =============================================================================

describe("buildSkillStatusReport", () => {
  test("returns a report with total, eligible, and missing counts", () => {
    const report = buildSkillStatusReport();
    expect(typeof report.total).toBe("number");
    expect(typeof report.eligible).toBe("number");
    expect(typeof report.missing).toBe("number");
    expect(report.total).toBe(report.eligible + report.missing);
  });

  test("discovers bundled skills", () => {
    const report = buildSkillStatusReport();
    expect(report.total).toBeGreaterThan(0);

    const names = report.skills.map((s) => s.name);
    // These bundled skills should always be discovered
    expect(names).toContain("commit");
    expect(names).toContain("paper-search");
  });

  test("each skill entry has required fields", () => {
    const report = buildSkillStatusReport();
    for (const skill of report.skills) {
      expect(typeof skill.name).toBe("string");
      expect(typeof skill.description).toBe("string");
      expect(typeof skill.eligible).toBe("boolean");
      expect(typeof skill.authReady).toBe("boolean");
      expect(typeof skill.ready).toBe("boolean");
      expect(Array.isArray(skill.missing)).toBe(true);
      expect(Array.isArray(skill.install)).toBe(true);
      expect(["bundled", "user", "workspace"]).toContain(skill.source);
    }
  });

  test("commit skill is ready (git is always available, no auth needed)", () => {
    const report = buildSkillStatusReport();
    const commit = report.skills.find((s) => s.name === "commit");
    expect(commit).toBeDefined();
    expect(commit!.eligible).toBe(true);
    expect(commit!.authReady).toBe(true);
    expect(commit!.ready).toBe(true);
  });

  test("auth-requiring skills show auth status separately from binary", () => {
    const report = buildSkillStatusReport();
    const github = report.skills.find((s) => s.name === "github");
    if (github && github.eligible) {
      // Binary found — authReady depends on whether gh auth is configured
      expect(typeof github.authReady).toBe("boolean");
      expect(github.ready).toBe(github.eligible && github.authReady);
    }
  });

  test("skills with install metadata include install specs", () => {
    const report = buildSkillStatusReport();
    const gog = report.skills.find((s) => s.name === "gog");
    if (gog && !gog.eligible) {
      // If gog is not installed, it should have install instructions
      expect(gog.install.length).toBeGreaterThan(0);
      expect(gog.install[0].kind).toBe("brew");
    }
  });

  test("known skills have verification commands", () => {
    const report = buildSkillStatusReport();
    const commit = report.skills.find((s) => s.name === "commit");
    expect(commit?.verifyCommand).toBe("git --version");

    const github = report.skills.find((s) => s.name === "github");
    expect(github?.verifyCommand).toBe("gh auth status");
  });
});

// =============================================================================
// formatSkillStatusReport
// =============================================================================

describe("formatSkillStatusReport", () => {
  test("formats a readable string", () => {
    const report = buildSkillStatusReport();
    const formatted = formatSkillStatusReport(report);
    expect(typeof formatted).toBe("string");
    expect(formatted.length).toBeGreaterThan(0);
  });

  test("shows eligible/total count in header", () => {
    const report = buildSkillStatusReport();
    const formatted = formatSkillStatusReport(report);
    expect(formatted).toContain(`${report.eligible}/${report.total} ready`);
  });

  test("shows checkmark for eligible skills", () => {
    const report = buildSkillStatusReport();
    const formatted = formatSkillStatusReport(report);
    // commit skill (git) should always be eligible
    expect(formatted).toContain("✓");
    expect(formatted).toContain("commit");
  });

  test("shows X for ineligible skills with missing deps", () => {
    const report = buildSkillStatusReport();
    const ineligible = report.skills.filter((s) => !s.eligible);
    if (ineligible.length > 0) {
      const formatted = formatSkillStatusReport(report);
      expect(formatted).toContain("✗");
    }
  });

  test("shows install commands for missing skills", () => {
    const report = buildSkillStatusReport();
    const withInstall = report.skills.filter(
      (s) => !s.eligible && s.install.length > 0,
    );
    if (withInstall.length > 0) {
      const formatted = formatSkillStatusReport(report);
      expect(formatted).toContain("Install:");
    }
  });

  test("handles report with all ready skills", () => {
    const report: SkillStatusReport = {
      total: 2,
      eligible: 2,
      missing: 0,
      skills: [
        {
          name: "test-a",
          description: "Test A",
          source: "bundled",
          eligible: true,
          authReady: true,
          ready: true,
          missing: [],
          install: [],
        },
        {
          name: "test-b",
          description: "Test B",
          source: "bundled",
          eligible: true,
          authReady: true,
          ready: true,
          missing: [],
          install: [],
        },
      ],
    };
    const formatted = formatSkillStatusReport(report);
    expect(formatted).toContain("2/2 ready");
    expect(formatted).not.toContain("✗");
  });

  test("shows X for skills with binary but no auth", () => {
    const report: SkillStatusReport = {
      total: 1,
      eligible: 0,
      missing: 1,
      skills: [
        {
          name: "github",
          description: "GitHub ops",
          source: "bundled",
          eligible: true,
          authReady: false,
          ready: false,
          missing: ["auth: not configured"],
          install: [],
          verifyCommand: "gh auth status",
        },
      ],
    };
    const formatted = formatSkillStatusReport(report);
    expect(formatted).toContain("✗");
    expect(formatted).toContain("auth: not configured");
  });

  test("handles empty report", () => {
    const report: SkillStatusReport = {
      total: 0,
      eligible: 0,
      missing: 0,
      skills: [],
    };
    const formatted = formatSkillStatusReport(report);
    expect(formatted).toContain("0/0 ready");
  });
});

// =============================================================================
// /setup integration
// =============================================================================

describe("/setup includes skill status", () => {
  test("setup command skillMessage contains skill status", () => {
    // Import command system and execute /setup
    const { executeCommand } = require("../src/tui/commands.js");
    const ctx = {
      model: "test",
      workingDirectory: process.cwd(),
      sessionId: "test",
      tokenUsage: null,
      messageCount: 0,
      previousSessionKey: null,
      setPreviousSessionKey: () => {},
      exit: () => {},
      clearMessages: () => {},
      newSession: () => {},
      flushMemory: () => {},
      switchModel: () => {},
      resumeSession: () => {},
    };

    const result = executeCommand("/setup", ctx);
    expect(result.skillMessage).toContain("skill status");
    // Should contain actual skill names from the report
    expect(result.skillMessage).toContain("commit");
  });
});
