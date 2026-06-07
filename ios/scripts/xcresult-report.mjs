#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = parseArgs(process.argv.slice(2));
const xcresultPath = args.xcresult || process.env.IOS_XCRESULT_PATH;
if (!xcresultPath) {
  throw new Error("Missing --xcresult <path>");
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(args.output || "reports/ios-test-report");
const attachmentsDir = path.join(outputDir, "attachments");
const screenManifestPath = path.resolve(
  args["screen-manifest"]
    || process.env.IOS_SCREEN_MANIFEST
    || path.join(scriptDir, "..", "hawkyUITests", "ScreenManifest.json")
);
mkdirSync(outputDir, { recursive: true });
mkdirSync(attachmentsDir, { recursive: true });

const imageExtensions = new Set([".png", ".jpg", ".jpeg", ".heic"]);
const textExtensions = new Set([".json", ".txt", ".log", ".md"]);

const summary = xcresultJSON(["get", "test-results", "summary", "--path", xcresultPath, "--compact"]);
const tests = xcresultJSON(["get", "test-results", "tests", "--path", xcresultPath, "--compact"]);

writeFileSync(path.join(outputDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
writeFileSync(path.join(outputDir, "tests.json"), `${JSON.stringify(tests, null, 2)}\n`);

let attachmentExportError = null;
try {
  execFileSync("xcrun", [
    "xcresulttool",
    "export",
    "attachments",
    "--path",
    xcresultPath,
    "--output-path",
    attachmentsDir,
  ], { stdio: "pipe" });
} catch (error) {
  attachmentExportError = error.stderr?.toString() || error.message;
}

const testCases = collectTestCases(tests.testNodes || []);
const failures = testCases.filter((test) => !["Passed", "Skipped", "Expected Failure"].includes(test.result || ""));
const passes = testCases.filter((test) => test.result === "Passed");
const skipped = testCases.filter((test) => test.result === "Skipped");
const attachments = collectAttachments(attachmentsDir);
const attachmentGroups = collectAttachmentGroups(attachmentsDir, attachments);
const screenManifest = loadScreenManifest(screenManifestPath);
const screenCoverage = buildScreenCoverage(screenManifest, attachmentGroups);
const executionScope = buildExecutionScope(attachmentGroups);
const groupedAttachmentNames = new Set(
  [...new Set(attachmentGroups.values())].flatMap((group) => group.all.map((attachment) => attachment.name))
);
const ungroupedAttachments = attachmentGroups.size > 0
  ? attachments.filter((attachment) => !groupedAttachmentNames.has(attachment.name) && attachment.name !== "manifest.json")
  : attachments.filter((attachment) => attachment.name !== "manifest.json");
const device = summary.devicesAndConfigurations?.[0]?.device || tests.devices?.[0] || {};
const generatedAt = new Date().toISOString();
const durationSeconds = (summary.finishTime && summary.startTime) ? summary.finishTime - summary.startTime : null;

const html = renderHTML({
  summary,
  testCases,
  failures,
  passes,
  skipped,
  attachments,
  attachmentGroups,
  ungroupedAttachments,
  attachmentExportError,
  screenCoverage,
  executionScope,
  device,
  generatedAt,
  durationSeconds,
  xcresultPath,
});

writeFileSync(path.join(outputDir, "index.html"), html);

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = true;
    } else {
      parsed[key] = next;
      index += 1;
    }
  }
  return parsed;
}

function xcresultJSON(commandArgs) {
  const output = execFileSync("xcrun", ["xcresulttool", ...commandArgs], { encoding: "utf8" });
  return JSON.parse(output);
}

function loadScreenManifest(manifestPath) {
  if (!existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!Array.isArray(manifest.screens)) return null;
    return {
      path: manifestPath,
      screens: manifest.screens
        .filter((screen) => screen?.id)
        .map((screen) => ({
          id: screen.id,
          title: screen.title || screen.id,
          expectedIdentifier: screen.expectedIdentifier || "",
          catalog: screen.catalog || "",
        })),
    };
  } catch {
    return null;
  }
}

function collectTestCases(nodes, suitePath = []) {
  const cases = [];
  for (const node of nodes) {
    const currentPath = node.name ? [...suitePath, node.name] : suitePath;
    if (node.nodeType === "Test Case") {
      cases.push({
        name: node.name || "(unnamed test)",
        suitePath,
        result: node.result || "Unknown",
        duration: node.duration || "",
        durationInSeconds: node.durationInSeconds,
        identifier: node.nodeIdentifier || "",
        identifierURL: node.nodeIdentifierURL || "",
      });
    }
    if (Array.isArray(node.children)) {
      cases.push(...collectTestCases(node.children, currentPath));
    }
  }
  return cases;
}

function collectAttachments(rootDir) {
  if (!existsSync(rootDir)) return [];
  const files = walk(rootDir)
    .filter((filePath) => statSync(filePath).isFile())
    .filter((filePath) => {
      const ext = path.extname(filePath).toLowerCase();
      return imageExtensions.has(ext) || textExtensions.has(ext);
    })
    .map((filePath) => {
      const relativePath = path.relative(path.dirname(rootDir), filePath);
      const ext = path.extname(filePath).toLowerCase();
      return {
        path: filePath,
        relativePath,
        name: path.basename(filePath),
        kind: imageExtensions.has(ext) ? "image" : "text",
        mediaType: mediaTypeFor(ext),
      };
    });
  return files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}

function collectAttachmentGroups(rootDir, attachments) {
  const manifestPath = path.join(rootDir, "manifest.json");
  if (!existsSync(manifestPath)) return new Map();

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return new Map();
  }
  if (!Array.isArray(manifest)) return new Map();

  const filesByName = new Map(attachments.map((attachment) => [attachment.name, attachment]));
  const groups = new Map();
  for (const testEntry of manifest) {
    const group = {
      spec: null,
      steps: new Map(),
      activities: new Map(),
      other: [],
      all: [],
    };

    for (const manifestAttachment of testEntry.attachments || []) {
      const file = filesByName.get(manifestAttachment.exportedFileName);
      if (!file) continue;

      const attachment = {
        ...file,
        suggestedName: manifestAttachment.suggestedHumanReadableName || file.name,
        timestamp: manifestAttachment.timestamp || 0,
        isFailure: Boolean(manifestAttachment.isAssociatedWithFailure),
      };
      group.all.push(attachment);

      if (attachment.suggestedName.startsWith("test-spec-")) {
        group.spec = attachment;
        continue;
      }

      const activityPart = activityPartFrom(attachment.suggestedName);
      if (activityPart) {
        const item = group.activities.get(activityPart.id) || {
          id: activityPart.id,
          spec: null,
          note: null,
          screenshot: null,
          other: [],
          timestamp: attachment.timestamp,
        };
        item.timestamp = Math.min(item.timestamp, attachment.timestamp);
        if (activityPart.kind === "spec") {
          item.spec = attachment;
        } else if (activityPart.kind === "expected-actual") {
          item.note = attachment;
        } else if (activityPart.kind === "screenshot") {
          item.screenshot = attachment;
        } else {
          item.other.push(attachment);
        }
        group.activities.set(activityPart.id, item);
        continue;
      }

      const stepNumber = stepNumberFrom(attachment.suggestedName);
      if (stepNumber != null) {
        const step = group.steps.get(stepNumber) || {
          number: stepNumber,
          note: null,
          screenshot: null,
          other: [],
        };
        if (attachment.kind === "image" && attachment.suggestedName.includes("screenshot")) {
          step.screenshot = attachment;
        } else if (attachment.kind === "text" && attachment.suggestedName.includes("expected-actual")) {
          step.note = attachment;
        } else {
          step.other.push(attachment);
        }
        group.steps.set(stepNumber, step);
      } else {
        group.other.push(attachment);
      }
    }

    group.steps = [...group.steps.values()].sort((a, b) => a.number - b.number);
    group.activities = [...group.activities.values()].sort((a, b) => a.timestamp - b.timestamp);
    group.other.sort((a, b) => a.timestamp - b.timestamp);
    group.all.sort((a, b) => a.timestamp - b.timestamp);
    if (group.all.length === 0) continue;

    for (const key of [testEntry.testIdentifierURL, testEntry.testIdentifier].filter(Boolean)) {
      groups.set(key, group);
    }
  }
  return groups;
}

function stepNumberFrom(name) {
  const match = name.match(/-step-(\d+)-(?:expected-actual|screenshot)\b/);
  return match ? Number(match[1]) : null;
}

function activityPartFrom(name) {
  const match = name.match(/^activity-(.+)-(spec|expected-actual|screenshot)$/);
  if (!match) return null;
  return { id: normalizeActivityID(match[1]), kind: match[2] };
}

function normalizeActivityID(id) {
  return id.replace(/_\d+_[0-9A-Fa-f]{8}(?:-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\./g, ".");
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(child);
    return [child];
  });
}

function mediaTypeFor(ext) {
  switch (ext) {
    case ".png": return "image/png";
    case ".jpg":
    case ".jpeg": return "image/jpeg";
    case ".heic": return "image/heic";
    case ".json": return "application/json";
    default: return "text/plain";
  }
}

function buildScreenCoverage(screenManifest, attachmentGroups) {
  if (!screenManifest) return null;

  const manifestIDs = new Set(screenManifest.screens.map((screen) => screen.id));
  const coveredIDs = new Set();
  const unknownIDs = new Set();
  const specAttachmentPaths = new Set();
  let specCount = 0;
  let stepCount = 0;
  let activityCount = 0;

  for (const group of [...new Set(attachmentGroups.values())]) {
    collectSpecCoverage(group.spec);
    for (const activity of group.activities || []) {
      activityCount += 1;
      collectSpecCoverage(activity.spec);
    }
  }

  const coveredScreens = screenManifest.screens.filter((screen) => coveredIDs.has(screen.id));
  const missingScreens = screenManifest.screens.filter((screen) => !coveredIDs.has(screen.id));

  return {
    manifestPath: screenManifest.path,
    total: screenManifest.screens.length,
    covered: coveredScreens.length,
    missing: missingScreens.length,
    specCount,
    stepCount,
    activityCount,
    coveredScreens,
    missingScreens,
    unknownIDs: [...unknownIDs].sort(),
  };

  function collectSpecCoverage(attachment) {
    if (!attachment || specAttachmentPaths.has(attachment.path)) return;
    specAttachmentPaths.add(attachment.path);
    specCount += 1;

    const spec = parseSpecMarkdown(readTextAttachment(attachment));
    stepCount += spec.steps.filter(Boolean).length;
    for (const id of screenIDsFromSpec(spec)) {
      if (manifestIDs.has(id)) {
        coveredIDs.add(id);
      } else {
        unknownIDs.add(id);
      }
    }
  }
}

function screenIDsFromSpec(spec) {
  if (!spec.screens) return [];
  return spec.screens
    .split(",")
    .map((screen) => screen.trim())
    .filter(Boolean);
}

function buildExecutionScope(attachmentGroups) {
  const specAttachmentPaths = new Set();
  const modes = new Map();
  const seeds = new Map();
  let specCount = 0;

  for (const group of [...new Set(attachmentGroups.values())]) {
    collectSpecScope(group.spec);
    for (const activity of group.activities || []) {
      collectSpecScope(activity.spec);
    }
  }

  if (specCount === 0) return null;

  return {
    specCount,
    modes: [...modes.entries()].map(([name, count]) => ({ name, count })).sort(byName),
    seeds: [...seeds.entries()].map(([name, count]) => ({ name, count })).sort(byName),
  };

  function collectSpecScope(attachment) {
    if (!attachment || specAttachmentPaths.has(attachment.path)) return;
    specAttachmentPaths.add(attachment.path);
    specCount += 1;

    const spec = parseSpecMarkdown(readTextAttachment(attachment));
    const backend = spec.backend || "unspecified";
    modes.set(backend, (modes.get(backend) || 0) + 1);
    if (spec.seed && spec.seed !== "none") {
      seeds.set(spec.seed, (seeds.get(spec.seed) || 0) + 1);
    }
  }
}

function byName(left, right) {
  return left.name.localeCompare(right.name);
}

function renderHTML(model) {
  const {
    summary,
    testCases,
    failures,
    passes,
    skipped,
    attachments,
    attachmentGroups,
    ungroupedAttachments,
    attachmentExportError,
    screenCoverage,
    executionScope,
    device,
    generatedAt,
    durationSeconds,
    xcresultPath,
  } = model;

  const ungroupedAttachmentCards = ungroupedAttachments.map(renderAttachment).join("\n");
  const screenshotCount = attachments.filter((attachment) => attachment.kind === "image").length;
  const failureCards = failures.map((test) => renderTestDetails(test, true, attachmentGroups)).join("\n")
    || "<p class=\"muted\">No failed tests.</p>";
  const passCards = passes.map((test) => renderTestDetails(test, false, attachmentGroups)).join("\n")
    || "<p class=\"muted\">No passed tests.</p>";
  const skippedCards = skipped.map((test) => renderTestDetails(test, false, attachmentGroups)).join("\n")
    || "<p class=\"muted\">No skipped tests.</p>";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHTML(summary.title || "iOS Test Report")}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --panel: #ffffff;
      --text: #14171a;
      --muted: #667085;
      --border: #d9dee7;
      --pass: #0f7b3f;
      --fail: #b42318;
      --skip: #6941c6;
      --accent: #155eef;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    header, main { max-width: 1180px; margin: 0 auto; padding: 24px; }
    header { padding-bottom: 8px; }
    h1 { margin: 0 0 8px; font-size: 28px; letter-spacing: 0; }
    h2 { margin: 28px 0 12px; font-size: 18px; letter-spacing: 0; }
    h3 { margin: 0; font-size: 15px; letter-spacing: 0; }
    a { color: var(--accent); }
    .muted { color: var(--muted); }
    .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
      gap: 10px;
      margin-top: 18px;
    }
    .metric, details, .attachment {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 1px 2px rgba(16, 24, 40, 0.04);
    }
    .metric { padding: 14px; }
    .metric strong { display: block; font-size: 22px; }
    .metric span { color: var(--muted); }
    details { margin: 10px 0; padding: 12px 14px; }
    summary { cursor: pointer; list-style-position: outside; }
    .test-title { display: flex; gap: 10px; align-items: center; justify-content: space-between; }
    .badge {
      display: inline-flex;
      align-items: center;
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      font-weight: 600;
      border: 1px solid currentColor;
      white-space: nowrap;
    }
    .pass { color: var(--pass); }
    .fail { color: var(--fail); }
    .skip { color: var(--skip); }
    .test-meta { margin: 8px 0 0; color: var(--muted); font-size: 13px; }
    .spec-summary {
      margin: 12px 0;
      padding: 12px;
      background: #f8fafc;
      border: 1px solid var(--border);
      border-radius: 8px;
    }
    .spec-summary p { margin: 4px 0; }
    .steps {
      display: grid;
      gap: 14px;
      margin: 14px 0 0;
      padding: 0;
      list-style: none;
    }
    .step {
      display: grid;
      grid-template-columns: minmax(220px, 0.8fr) minmax(280px, 1.2fr);
      gap: 14px;
      align-items: start;
      padding: 14px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #ffffff;
    }
    .step-copy p { margin: 8px 0; }
    .step-label {
      display: inline-flex;
      margin-bottom: 4px;
      color: var(--muted);
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .screen-shot {
      margin: 0;
      overflow: hidden;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: #eef1f5;
    }
    .screen-shot img {
      width: 100%;
      max-height: 720px;
      object-fit: contain;
      display: block;
    }
    .screen-shot figcaption {
      padding: 8px 10px;
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
      background: #ffffff;
      border-top: 1px solid var(--border);
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 12px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 12px;
      font-size: 13px;
    }
    th, td {
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      text-align: left;
      vertical-align: top;
    }
    th {
      color: var(--muted);
      font-weight: 700;
      background: #f8fafc;
    }
    .attachment { overflow: hidden; }
    .attachment img { width: 100%; display: block; background: #eef1f5; }
    .attachment pre {
      margin: 0;
      padding: 12px;
      overflow: auto;
      max-height: 260px;
      background: #101828;
      color: #f9fafb;
      font-size: 12px;
    }
    .attachment .caption { padding: 10px 12px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
    .note {
      padding: 12px 14px;
      background: #fff7ed;
      border: 1px solid #fed7aa;
      border-radius: 8px;
      color: #9a3412;
    }
    code { background: #eef1f5; padding: 1px 4px; border-radius: 4px; }
    @media (max-width: 760px) {
      header, main { padding: 18px; }
      .step { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>${escapeHTML(summary.title || "iOS Test Report")}</h1>
    <p class="muted">
      Generated ${escapeHTML(generatedAt)} from <code>${escapeHTML(xcresultPath)}</code><br>
      ${escapeHTML(device.deviceName || "Unknown device")} · ${escapeHTML(device.platform || "Unknown platform")}
      ${device.osVersion ? `· iOS ${escapeHTML(device.osVersion)}` : ""}
    </p>
    <section class="summary" aria-label="Summary">
      ${metric("Result", summary.result || "Unknown")}
      ${metric("Total", summary.totalTestCount ?? testCases.length)}
      ${metric("Passed", summary.passedTests ?? passes.length, "pass")}
      ${metric("Failed", summary.failedTests ?? failures.length, failures.length ? "fail" : "pass")}
      ${metric("Skipped", summary.skippedTests ?? skipped.length, "skip")}
      ${metric("Screenshots", screenshotCount)}
      ${screenCoverage ? metric("Manifest Coverage", `${screenCoverage.covered}/${screenCoverage.total}`, screenCoverage.missing ? "fail" : "pass") : ""}
      ${screenCoverage ? metric("Specs", screenCoverage.specCount) : ""}
      ${screenCoverage ? metric("Spec Steps", screenCoverage.stepCount) : ""}
      ${executionScope ? metric("Backend Modes", executionScope.modes.map((mode) => mode.name).join(", ")) : ""}
      ${metric("Duration", durationSeconds == null ? "n/a" : `${durationSeconds.toFixed(1)}s`)}
    </section>
  </header>
  <main>
    ${attachmentExportError ? `<p class="note">Attachment export failed: ${escapeHTML(attachmentExportError)}</p>` : ""}
    ${screenCoverage ? renderScreenCoverage(screenCoverage) : ""}
    ${executionScope ? renderExecutionScope(executionScope) : ""}
    <section>
      <h2>Failures</h2>
      ${failureCards}
    </section>
    <section>
      <h2>Passed</h2>
      ${passCards}
    </section>
    <section>
      <h2>Skipped</h2>
      ${skippedCards}
    </section>
    ${ungroupedAttachmentCards ? `<section>
      <h2>Unassigned Attachments</h2>
      <p class="muted">Attachments exported from the xcresult that were not associated with a TestSpec step.</p>
      <div class="grid">${ungroupedAttachmentCards}</div>
    </section>` : ""}
    <section>
      <h2>Regression</h2>
      <p class="muted">Snapshot and visual regressions are surfaced as XCTest failures in this report. Raw JSON is saved next to this file as <code>summary.json</code> and <code>tests.json</code>.</p>
    </section>
  </main>
</body>
</html>`;
}

function renderScreenCoverage(coverage) {
  const missing = coverage.missingScreens.length
    ? `<div class="note"><strong>Uncovered screens</strong><br>${coverage.missingScreens.map((screen) => escapeHTML(`${screen.id} (${screen.title})`)).join("<br>")}</div>`
    : "<p class=\"muted\">Every screen in the manifest appears in at least one exported TestSpec or screen activity.</p>";

  const unknown = coverage.unknownIDs.length
    ? `<p class="note">Unknown screen ids appeared in specs: ${escapeHTML(coverage.unknownIDs.join(", "))}</p>`
    : "";

  const rows = coverage.coveredScreens.map((screen) => `
    <tr>
      <td><code>${escapeHTML(screen.id)}</code></td>
      <td>${escapeHTML(screen.title)}</td>
      <td>${escapeHTML(screen.expectedIdentifier)}</td>
      <td>${screen.catalog ? escapeHTML(screen.catalog) : "spec"}</td>
    </tr>
  `).join("\n");

  return `<section>
    <h2>Manifest Coverage</h2>
    <p class="muted">
      Manifest: <code>${escapeHTML(coverage.manifestPath)}</code><br>
      ${coverage.covered}/${coverage.total} manifest screens covered · ${coverage.specCount} specs · ${coverage.activityCount} screen activities · ${coverage.stepCount} declared steps
    </p>
    ${missing}
    ${unknown}
    <details>
      <summary>Covered Screens</summary>
      <table>
        <thead>
          <tr><th>Screen</th><th>Title</th><th>Expected identifier</th><th>Source</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </details>
  </section>`;
}

function renderExecutionScope(scope) {
  const modeRows = scope.modes.map((mode) => `
    <tr>
      <td><code>${escapeHTML(mode.name)}</code></td>
      <td>${mode.count}</td>
    </tr>
  `).join("\n");
  const seedRows = scope.seeds.length
    ? scope.seeds.map((seed) => `
      <tr>
        <td><code>${escapeHTML(seed.name)}</code></td>
        <td>${seed.count}</td>
      </tr>
    `).join("\n")
    : `<tr><td colspan="2" class="muted">No explicit seed profiles were declared by exported specs.</td></tr>`;

  return `<section>
    <h2>Execution Scope</h2>
    <p class="muted">
      Backend mode and seed profile are read from each exported TestSpec, so mock+seed runs are visible separately from pure UI and opt-in live integration checks.
    </p>
    <div class="grid">
      <table>
        <thead><tr><th>Backend mode</th><th>Specs</th></tr></thead>
        <tbody>${modeRows}</tbody>
      </table>
      <table>
        <thead><tr><th>Seed profile</th><th>Specs</th></tr></thead>
        <tbody>${seedRows}</tbody>
      </table>
    </div>
  </section>`;
}

function metric(label, value, className = "") {
  return `<div class="metric ${className}"><strong>${escapeHTML(String(value))}</strong><span>${escapeHTML(label)}</span></div>`;
}

function renderTestDetails(test, open, attachmentGroups) {
  const cls = test.result === "Passed" ? "pass" : test.result === "Skipped" ? "skip" : "fail";
  const group = attachmentGroups.get(test.identifierURL) || attachmentGroups.get(test.identifier);
  return `<details ${open ? "open" : ""}>
    <summary>
      <span class="test-title">
        <h3>${escapeHTML(test.name)}</h3>
        <span class="badge ${cls}">${escapeHTML(test.result || "Unknown")}</span>
      </span>
    </summary>
    <p class="test-meta">${escapeHTML(test.suitePath.join(" / "))}${test.duration ? ` · ${escapeHTML(test.duration)}` : ""}</p>
    ${test.identifierURL ? `<p class="test-meta"><code>${escapeHTML(test.identifierURL)}</code></p>` : ""}
    ${group ? renderSpecSummary(group.spec) : ""}
    ${group ? renderStepTimeline(group) : "<p class=\"muted\">No TestSpec screenshots were exported for this test.</p>"}
    ${group ? renderActivityTimeline(group) : ""}
  </details>`;
}

function renderSpecSummary(specAttachment) {
  if (!specAttachment) return "";
  const spec = parseSpecMarkdown(readTextAttachment(specAttachment));
  const title = spec.title || attachmentCaption(specAttachment);
  return `<div class="spec-summary">
    <p><strong>${escapeHTML(title)}</strong></p>
    ${spec.purpose ? `<p>${escapeHTML(spec.purpose)}</p>` : ""}
    ${spec.screens ? `<p class="muted">Screens: ${escapeHTML(spec.screens)}</p>` : ""}
    ${spec.backend ? `<p class="muted">Backend: ${escapeHTML(spec.backend)}${spec.seed ? ` · Seed: ${escapeHTML(spec.seed)}` : ""}</p>` : ""}
  </div>`;
}

function renderStepTimeline(group) {
  const spec = group.spec ? parseSpecMarkdown(readTextAttachment(group.spec)) : { steps: [] };
  const steps = group.steps.length > 0
    ? group.steps
    : spec.steps.map((step, index) => ({ number: index + 1, specStep: step, note: null, screenshot: null, other: [] }));
  if (steps.length === 0) return "<p class=\"muted\">No step screenshots were exported for this test.</p>";

  const stepCards = steps.map((step) => {
    const note = step.note ? parseExpectedActual(readTextAttachment(step.note)) : {};
    const specStep = spec.steps[step.number - 1] || step.specStep || {};
    const action = note.action || specStep.action || "No action recorded";
    const expected = note.expected || specStep.expected || "No expected result recorded";
    const actual = note.actual || "No actual result recorded";
    const extra = step.other?.length ? `<div class="grid">${step.other.map(renderAttachment).join("\n")}</div>` : "";

    return `<li class="step">
      <div class="step-copy">
        <span class="step-label">Step ${step.number}</span>
        <p><strong>Action</strong><br>${escapeHTML(action)}</p>
        <p><strong>Expected</strong><br>${escapeHTML(expected)}</p>
        <p><strong>Actual</strong><br>${escapeHTML(actual)}</p>
      </div>
      <div>
        ${step.screenshot ? renderInlineImage(step.screenshot) : "<p class=\"muted\">No screenshot exported for this step.</p>"}
        ${extra}
      </div>
    </li>`;
  }).join("\n");

  const other = group.other.length ? `<div class="grid">${group.other.map(renderAttachment).join("\n")}</div>` : "";
  return `<ol class="steps">${stepCards}</ol>${other}`;
}

function renderActivityTimeline(group) {
  if (!group.activities?.length) return "";
  const cards = group.activities.map((activity, index) => {
    const spec = activity.spec ? parseSpecMarkdown(readTextAttachment(activity.spec)) : { title: activity.id, steps: [] };
    const note = activity.note ? parseExpectedActual(readTextAttachment(activity.note)) : {};
    const firstStep = spec.steps[0] || {};
    const action = note.action || firstStep.action || spec.title || activity.id;
    const expected = note.expected || firstStep.expected || spec.purpose || "No expected result recorded";
    const actual = note.actual || "No actual result recorded";
    const extra = activity.other?.length ? `<div class="grid">${activity.other.map(renderAttachment).join("\n")}</div>` : "";

    return `<li class="step">
      <div class="step-copy">
        <span class="step-label">Screen ${index + 1}</span>
        <p><strong>${escapeHTML(spec.title || activity.id)}</strong></p>
        ${spec.purpose ? `<p>${escapeHTML(spec.purpose)}</p>` : ""}
        ${spec.screens ? `<p class="muted">Screens: ${escapeHTML(spec.screens)}</p>` : ""}
        ${spec.backend ? `<p class="muted">Backend: ${escapeHTML(spec.backend)}${spec.seed ? ` · Seed: ${escapeHTML(spec.seed)}` : ""}</p>` : ""}
        <p><strong>Action</strong><br>${escapeHTML(action)}</p>
        <p><strong>Expected</strong><br>${escapeHTML(expected)}</p>
        <p><strong>Actual</strong><br>${escapeHTML(actual)}</p>
      </div>
      <div>
        ${activity.screenshot ? renderInlineImage(activity.screenshot) : "<p class=\"muted\">No screenshot exported for this activity.</p>"}
        ${extra}
      </div>
    </li>`;
  }).join("\n");

  return `<h4>Screen Activities</h4><ol class="steps">${cards}</ol>`;
}

function parseSpecMarkdown(text) {
  const spec = { title: "", purpose: "", screens: "", steps: [] };
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("# ")) {
      spec.title = line.slice(2).trim();
    } else if (line.startsWith("- purpose:")) {
      spec.purpose = line.slice("- purpose:".length).trim();
    } else if (line.startsWith("- screens:")) {
      spec.screens = line.slice("- screens:".length).trim();
    } else if (line.startsWith("- backend:")) {
      spec.backend = line.slice("- backend:".length).trim();
    } else if (line.startsWith("- seed:")) {
      spec.seed = line.slice("- seed:".length).trim();
    } else {
      const match = line.match(/^(\d+)\.\s+(.*?)\s+->\s+(.*)$/);
      if (match) {
        spec.steps[Number(match[1]) - 1] = {
          action: match[2].trim(),
          expected: match[3].trim(),
        };
      }
    }
  }
  return spec;
}

function parseExpectedActual(text) {
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^(action|expected|actual):\s*(.*)$/);
    if (match) result[match[1]] = match[2].trim();
  }
  return result;
}

function readTextAttachment(attachment) {
  return readFileSync(attachment.path, "utf8");
}

function renderInlineImage(attachment) {
  const data = readFileSync(attachment.path).toString("base64");
  return `<figure class="screen-shot">
    <img alt="${escapeHTML(attachmentCaption(attachment))}" src="data:${attachment.mediaType};base64,${data}">
    <figcaption>${escapeHTML(attachmentCaption(attachment))}</figcaption>
  </figure>`;
}

function renderAttachment(attachment) {
  if (attachment.kind === "image") {
    return `<article class="attachment">
      ${renderInlineImage(attachment)}
    </article>`;
  }

  const text = readTextAttachment(attachment);
  return `<article class="attachment">
    <pre>${escapeHTML(text)}</pre>
    <div class="caption">${escapeHTML(attachmentCaption(attachment))}</div>
  </article>`;
}

function attachmentCaption(attachment) {
  return attachment.suggestedName || attachment.relativePath;
}

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}
