// Tests for the persisted Slack directory + relationship graph (#535).
// Uses an in-memory SQLite DB and a mock source — no Slack API.
import { describe, test, expect } from "bun:test";
import { SlackDirectory, type SlackDirectorySource } from "../src/gateway/adapters/slack-directory.js";

function mockSource(): SlackDirectorySource & { memberCalls: number } {
  const src = {
    memberCalls: 0,
    async listUsers() {
      return [
        { id: "U_JAY", name: "jay", real_name: "Jay (Xinkai) Zou", display_name: "Jay", is_bot: false, is_deleted: false },
        { id: "U_BOB", name: "bob", real_name: "Bob Smith", is_bot: false, is_deleted: false },
        { id: "U_BOT", name: "robot", real_name: "Robo", is_bot: true, is_deleted: false },
        { id: "U_GONE", name: "ghost", real_name: "Ghost", is_bot: false, is_deleted: true },
      ];
    },
    async listChannels() {
      return [
        { id: "C_AMB", name: "research-ambient-agent", is_private: false },
        { id: "C_GEN", name: "general", is_private: false },
      ];
    },
    async listChannelMembers(channelId: string) {
      src.memberCalls++;
      if (channelId === "C_AMB") return ["U_JAY", "U_BOB"];
      if (channelId === "C_GEN") return ["U_BOB"];
      return [];
    },
  };
  return src;
}

function freshDir(): SlackDirectory {
  return new SlackDirectory(":memory:");
}

describe("SlackDirectory — refresh + persistence", () => {
  test("refresh populates users, channels, and membership edges", async () => {
    const dir = freshDir();
    const src = mockSource();
    const res = await dir.refresh(src);
    expect(res.users).toBe(4);
    expect(res.channels).toBe(2);
    expect(res.edges).toBe(3); // C_AMB: 2 + C_GEN: 1
    expect(dir.isEmpty()).toBe(false);
    expect(dir.lastRefreshedAt()).not.toBeNull();
    dir.close();
  });

  test("refresh can skip membership", async () => {
    const dir = freshDir();
    const src = mockSource();
    const res = await dir.refresh(src, { includeMembers: false });
    expect(res.edges).toBe(0);
    expect(src.memberCalls).toBe(0);
    dir.close();
  });

  test("isEmpty is true before any refresh, isStale respects TTL", async () => {
    const dir = freshDir();
    expect(dir.isEmpty()).toBe(true);
    expect(dir.isStale(60_000)).toBe(true); // never refreshed → stale
    await dir.refresh(mockSource());
    expect(dir.isStale(60_000)).toBe(false); // just refreshed → fresh
    dir.close();
  });

  test("partial membership refresh preserves cached edges for failed channels", async () => {
    const dir = freshDir();
    await dir.refresh(mockSource());
    const lastFullRefresh = dir.lastRefreshedAt();

    const partialSource = mockSource();
    partialSource.listChannelMembers = async (channelId: string) => {
      partialSource.memberCalls++;
      if (channelId === "C_AMB") throw new Error("rate_limited");
      if (channelId === "C_GEN") return [];
      return [];
    };

    const res = await dir.refresh(partialSource);
    expect(res.edges).toBe(0);
    expect(dir.lastRefreshedAt()).toBe(lastFullRefresh);
    expect(dir.getChannelMembers("C_AMB").map((m) => m.id).sort()).toEqual(["U_BOB", "U_JAY"]);
    expect(dir.getChannelMembers("C_GEN")).toEqual([]);
    dir.close();
  });
});

describe("SlackDirectory — resolution (reads the graph)", () => {
  test("resolves a user by substring, excludes bots/deleted", async () => {
    const dir = freshDir();
    await dir.refresh(mockSource());
    const ids = dir.resolve("xinkai").map((r) => r.id);
    expect(ids).toContain("U_JAY");
    // bot + deleted are not matchable
    expect(dir.resolve("robo").map((r) => r.id)).not.toContain("U_BOT");
    expect(dir.resolve("ghost")).toEqual([]);
    dir.close();
  });

  test("resolves a Chinese name via pinyin (邹欣凯)", async () => {
    const dir = freshDir();
    await dir.refresh(mockSource());
    expect(dir.resolve("邹欣凯").map((r) => r.id)).toContain("U_JAY");
    dir.close();
  });

  test("resolves a loose channel name to the channel", async () => {
    const dir = freshDir();
    await dir.refresh(mockSource());
    const top = dir.resolve("ambient")[0];
    expect(top.id).toBe("C_AMB");
    expect(top.kind).toBe("channel");
    dir.close();
  });
});

describe("SlackDirectory — graph lookups", () => {
  test("getChannelMembers returns members (excluding bots/deleted)", async () => {
    const dir = freshDir();
    await dir.refresh(mockSource());
    const members = dir.getChannelMembers("C_AMB").map((m) => m.id);
    expect(members.sort()).toEqual(["U_BOB", "U_JAY"]);
    dir.close();
  });

  test("getMembersOfChannelName resolves a loose name then lists members", async () => {
    const dir = freshDir();
    await dir.refresh(mockSource());
    const members = dir.getMembersOfChannelName("ambient").map((m) => m.label);
    expect(members).toContain("Jay (Xinkai) Zou");
    expect(members).toContain("Bob Smith");
    dir.close();
  });

  test("resolveChannelId returns null for an unknown channel", async () => {
    const dir = freshDir();
    await dir.refresh(mockSource());
    expect(dir.resolveChannelId("nonexistent-zzz")).toBeNull();
    dir.close();
  });
});
