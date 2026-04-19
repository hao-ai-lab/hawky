import { describe, test, expect } from "bun:test";

// ---------------------------------------------------------------------------
// SlackAdapter unit tests.
//
// We keep these intentionally thin:
// - The ChannelAdapter contract (outbound + inbound) is exercised by the
//   channel-relay and channel-wiring integration tests with mock adapters.
// - The @slack/bolt App instantiated by our real adapter connects on
//   construction (Socket Mode machinery), so we can't construct a real
//   SlackAdapter in unit tests without network side effects that leak
//   unhandled rejections into sibling tests.
// - Live-connection behavior is covered by manual tests (MANUAL_TESTS.md
//   section "Slack Integration") with a real workspace.
//
// These tests verify only the module-level shape: that the class is
// exported and its exported options/method signatures compile against
// the ChannelAdapter interface.
// ---------------------------------------------------------------------------

describe("SlackAdapter module", () => {
  test("exports SlackAdapter class", async () => {
    const mod = await import("../src/gateway/adapters/slack.js");
    expect(mod.SlackAdapter).toBeDefined();
    expect(typeof mod.SlackAdapter).toBe("function");
  });

  test("SlackAdapter is a constructable class", async () => {
    const mod = await import("../src/gateway/adapters/slack.js");
    // Constructor arity: expects an options object
    expect(mod.SlackAdapter.length).toBe(1);
  });

  test("SlackMessage type exported", async () => {
    // Type-only export; importing the module should not throw.
    const mod = await import("../src/gateway/adapters/slack.js");
    expect(mod).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Fail-closed policy documentation
// ---------------------------------------------------------------------------
//
// The adapter accepts `allowedUserId` as optional at the type level, but
// src/index.ts enforces a fail-closed policy: Slack inbound will not
// initialize unless `channels.slack.default_dm_user` is set and matches the
// U<id> format. Without this gate, any workspace member who can DM the bot
// could drive the agent.
//
// The enforcement code in src/index.ts (grep for "default_dm_user") refuses
// to construct the SlackAdapter if the gate is missing and logs a warning
// pointing at deploy/SLACK_SETUP.md Step 4.
//
// This is verified by integration tests and manual tests (#817, #836).
// ---------------------------------------------------------------------------
