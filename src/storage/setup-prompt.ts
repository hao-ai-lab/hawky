// =============================================================================
// First-Run API Key Prompt
//
// Interactive CLI prompt for collecting LLM credentials when none are
// configured. Runs before the agent boots (no LLM needed). Uses node:readline
// so it works in any terminal without Ink/React.
// =============================================================================

import { createInterface } from "node:readline";
import { validateAnthropicKey, validateOpenAIKey } from "./config-validators.js";
import { updateConfig } from "./config.js";

// -----------------------------------------------------------------------------
// Masked input helper
// -----------------------------------------------------------------------------

/**
 * Prompt for secret input with asterisk masking.
 * Disables terminal echo, reads character-by-character, and prints '*' for
 * each typed character. Supports backspace.
 */
function promptSecret(label: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(label);

    const stdin = process.stdin;
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    let input = "";

    const onData = (ch: string) => {
      const code = ch.charCodeAt(0);

      if (ch === "\r" || ch === "\n") {
        // Enter — done
        stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(input.trim());
      } else if (code === 3) {
        // Ctrl+C — exit cleanly
        stdin.setRawMode(wasRaw ?? false);
        stdin.pause();
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        process.exit(130);
      } else if (code === 127 || code === 8) {
        // Backspace
        if (input.length > 0) {
          input = input.slice(0, -1);
          process.stdout.write("\b \b");
        }
      } else if (code >= 32) {
        // Printable character
        input += ch;
        process.stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}

/**
 * Prompt for plain (unmasked) input.
 */
export function askLine(label: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(label, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// -----------------------------------------------------------------------------
// Provider-specific prompt flows
// -----------------------------------------------------------------------------

/**
 * Interactive prompt that collects and validates the Anthropic API key.
 * Loops until a valid key is provided or the user cancels (Ctrl+C).
 * On success, saves the key to ~/.hawky/config.json and returns it.
 *
 * @param apiBaseURL - Custom Anthropic API base URL (for proxy setups)
 */
export async function promptForAnthropicKey(apiBaseURL?: string): Promise<string> {
  console.log();
  console.log("Welcome to Hawky!");
  console.log();
  console.log("An Anthropic API key is required to start.");
  console.log("Get one at: https://console.anthropic.com/settings/keys");
  console.log();

  while (true) {
    const apiKey = await promptSecret("Anthropic API key: ");

    if (!apiKey) {
      console.log("  Key cannot be empty. Try again.\n");
      continue;
    }

    process.stdout.write("  Validating... ");
    const result = await validateAnthropicKey(apiKey, apiBaseURL);

    if (result.valid) {
      console.log("valid!\n");
      updateConfig({ api_keys: { anthropic: apiKey } });
      console.log("  Saved to ~/.hawky/config.json\n");
      return apiKey;
    }

    console.log(`  ${result.error ?? "Invalid API key"}\n`);
  }
}

/**
 * Interactive prompt for Vertex AI configuration.
 * Writes provider: "vertex" + vertex.project_id + vertex.region to config.
 * Relies on ambient Application Default Credentials (gcloud auth).
 */
export async function promptForVertex(): Promise<void> {
  console.log();
  console.log("Vertex AI setup");
  console.log("Auth uses Application Default Credentials.");
  console.log("Run: gcloud auth application-default login");
  console.log("See deploy/VERTEX_SETUP.md for full setup.");
  console.log();

  const projectId = await askLine("GCP Project ID: ");
  if (!projectId) {
    console.log("  Project ID cannot be empty. Aborting.\n");
    process.exit(1);
  }

  const regionInput = await askLine("Region (default: global): ");
  const region = regionInput || "global";

  updateConfig({
    provider: "vertex",
    vertex: { project_id: projectId, region },
  });
  console.log(`  Saved Vertex config (project: ${projectId}, region: ${region})\n`);
}

/**
 * Interactive prompt that collects and validates the OpenAI API key.
 * Loops until a valid key is provided or the user cancels (Ctrl+C).
 * On success, saves the key to ~/.hawky/config.json and returns.
 */
export async function promptForOpenAIKey(): Promise<void> {
  console.log();
  console.log("OpenAI setup");
  console.log("Get an API key at: https://platform.openai.com/api-keys");
  console.log();

  while (true) {
    const apiKey = await promptSecret("OpenAI API key: ");

    if (!apiKey) {
      console.log("  Key cannot be empty. Try again.\n");
      continue;
    }

    process.stdout.write("  Validating... ");
    const result = await validateOpenAIKey(apiKey);

    if (result.valid) {
      console.log("valid!\n");
      updateConfig({ provider: "openai", api_keys: { openai: apiKey } });
      console.log("  Saved to ~/.hawky/config.json\n");
      return;
    }

    if (result.error?.includes("401") || result.error?.includes("Invalid API key")) {
      console.log(`  ${result.error ?? "Invalid API key"}\n`);
      continue;
    }

    // Network/timeout — soft warning, accept and continue
    console.log(`  Warning: could not validate key (${result.error}). Saving anyway.\n`);
    updateConfig({ provider: "openai", api_keys: { openai: apiKey } });
    console.log("  Saved to ~/.hawky/config.json\n");
    return;
  }
}

// -----------------------------------------------------------------------------
// Brave Search (provider-orthogonal)
// -----------------------------------------------------------------------------

/**
 * Prompt for the Brave Search API key (optional).
 * Web search is important for many agent tasks, so we ask during first-run setup.
 */
export async function promptForBraveKey(): Promise<void> {
  console.log("Web search lets the agent find current information online.");
  console.log("A Brave Search API key is recommended (free tier available).");
  console.log("Get one at: https://brave.com/search/api/");
  console.log("Press Enter to skip.\n");

  const braveKey = await promptSecret("Brave Search API key (optional): ");

  if (!braveKey) {
    console.log("  Skipped — you can add it later in ~/.hawky/config.json\n");
    return;
  }

  // Quick validation
  process.stdout.write("  Validating... ");
  try {
    const resp = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=test&count=1`,
      { headers: { "X-Subscription-Token": braveKey } },
    );
    if (resp.ok) {
      console.log("valid!\n");
      updateConfig({ api_keys: { brave_search: braveKey } });
      console.log("  Saved to ~/.hawky/config.json\n");
    } else {
      console.log(`  HTTP ${resp.status} — key may be invalid. Skipping.\n`);
    }
  } catch {
    console.log("  Network error — skipping validation.\n");
  }
}

// -----------------------------------------------------------------------------
// Top-level first-run wrapper
// -----------------------------------------------------------------------------

/**
 * First-run credential prompt. Asks which LLM backend to use, collects
 * the required credentials for that backend, then prompts for Brave Search
 * (provider-orthogonal, optional).
 */
export async function promptForLlmCredentials(): Promise<void> {
  const backend = await askLine(
    "Which LLM backend? [A]nthropic (default) / [V]ertex / [O]penAI-compatible (vLLM/OpenAI/Groq/etc.): ",
  );
  const choice = (backend.trim().toLowerCase() || "a")[0];

  if (choice === "v") {
    await promptForVertex();
  } else if (choice === "o") {
    await promptForOpenAIKey();
  } else {
    await promptForAnthropicKey();
  }

  // Brave is provider-orthogonal — runs after every branch.
  await promptForBraveKey();
}
