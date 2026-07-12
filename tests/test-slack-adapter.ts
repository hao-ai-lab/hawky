import { describe, test, expect } from "bun:test";

// ---------------------------------------------------------------------------
// SlackAdapter unit tests.
//
// We keep these intentionally thin:
// - The ChannelAdapter contract (outbound + inbound) is exercised by the
//   channel-relay and channel-wiring integration tests with mock adapters.
// - Live-connection behavior is covered by manual tests (MANUAL_TESTS.md
//   section "Slack Integration") with a real workspace.
//
// Fail-soft regression coverage (#20): bolt's App used to be constructed in
// the SlackAdapter constructor, which fired auth.test as a floating promise —
// a dead bot token (account_inactive/token_revoked) became an unhandled
// rejection that killed the whole gateway at startup. The constructor must
// stay free of network side effects, and start() must surface token failures
// as a normal rejection the bootstrap guard in src/index.ts can catch.
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
// Fail-soft startup (#20): dead token must reject start(), never crash
// ---------------------------------------------------------------------------

describe("SlackAdapter fail-soft startup (#20)", () => {
  const makeAdapter = async () => {
    const { SlackAdapter } = await import("../src/gateway/adapters/slack.js");
    return new SlackAdapter({
      botToken: "xoxb-fake-dead-token",
      appToken: "xapp-fake-token",
      allowedUserId: "U0000000",
    });
  };

  test("constructor has no network side effects (no bolt App, no auth.test)", async () => {
    // Regression: constructing with a dead token used to fire bolt's
    // constructor-time auth.test floating promise. Now construction must be
    // pure — the bolt app must not exist until start().
    const adapter = await makeAdapter();
    expect((adapter as any).app).toBeNull();
    expect(adapter.isReady()).toBe(false);
  });

  test("start() rejects with the slack error when the bot token is dead", async () => {
    const adapter = await makeAdapter();
    // Stub the awaited token-verification call to fail the way @slack/web-api
    // does for a revoked/inactive token (slack_webapi_platform_error).
    const platformError = Object.assign(new Error("An API error occurred: account_inactive"), {
      code: "slack_webapi_platform_error",
      data: { ok: false, error: "account_inactive" },
    });
    (adapter as any).botClient = {
      auth: { test: async () => { throw platformError; } },
    };

    // The failure must surface as a normal rejection (catchable by the
    // bootstrap guard) — not as a floating-promise unhandled rejection.
    await expect(adapter.start()).rejects.toThrow("account_inactive");

    // And the adapter must be left cleanly disabled.
    expect(adapter.isReady()).toBe(false);
    expect((adapter as any).app).toBeNull();
    expect(adapter.getStatus().lastError).toContain("account_inactive");
  });

  test("stop() is a no-op when start() never succeeded", async () => {
    const adapter = await makeAdapter();
    // Must not throw on the never-started app.
    await adapter.stop();
    expect(adapter.isReady()).toBe(false);
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
