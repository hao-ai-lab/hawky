// Tests for Slack recipient matching/ranking (#533) — pure, no Slack client.
import { describe, test, expect } from "bun:test";
import { rankRecipients, scoreEntry, type SlackDirectoryEntry } from "../src/gateway/adapters/slack-resolve.js";

const DIR: SlackDirectoryEntry[] = [
  { id: "U_JAY", kind: "user", handle: "jay", label: "Jay (Xinkai) Zou", aliases: ["Jay (Xinkai) Zou", "jayzou"] },
  { id: "U_XL", kind: "user", handle: "xinkai_li", label: "Xinkai Li", aliases: ["Xinkai Li"] },
  { id: "U_BOB", kind: "user", handle: "bob", label: "Bob Smith", aliases: ["Bob Smith"] },
  { id: "C_AMB", kind: "channel", handle: "research-ambient-agent", label: "research-ambient-agent" },
  { id: "C_GEN", kind: "channel", handle: "general", label: "general" },
];

function ids(q: string): string[] {
  return rankRecipients(q, DIR).map((r) => r.id);
}

describe("slack recipient matching", () => {
  test("substring matches a user inside parentheses", () => {
    expect(ids("xinkai")).toContain("U_JAY");
    expect(ids("xinkai")).toContain("U_XL");
  });

  test("Chinese query resolves via pinyin (邹欣凯 → Jay (Xinkai) Zou)", () => {
    const r = ids("邹欣凯");
    expect(r).toContain("U_JAY");
  });

  test("Chinese given name resolves via pinyin (欣凯)", () => {
    expect(ids("欣凯")).toContain("U_JAY");
  });

  test("loose channel name matches a channel (no # needed)", () => {
    const r = rankRecipients("ambient", DIR);
    expect(r[0].id).toBe("C_AMB");
    expect(r[0].kind).toBe("channel");
  });

  test("full channel name resolves to the channel", () => {
    expect(ids("research-ambient-agent")).toContain("C_AMB");
  });

  test("exact handle ranks first", () => {
    const r = rankRecipients("bob", DIR);
    expect(r[0].id).toBe("U_BOB");
  });

  test("no match returns empty", () => {
    expect(ids("zzzznotreal")).toEqual([]);
  });

  test("kind + handle are returned on candidates", () => {
    const r = rankRecipients("general", DIR);
    const gen = r.find((x) => x.id === "C_GEN")!;
    expect(gen.kind).toBe("channel");
    expect(gen.handle).toBe("general");
  });

  test("a person outranks a same-named channel on a tie", () => {
    const dir: SlackDirectoryEntry[] = [
      { id: "C_X", kind: "channel", handle: "design", label: "design" },
      { id: "U_X", kind: "user", handle: "design", label: "design" },
    ];
    const r = rankRecipients("design", dir);
    expect(r[0].id).toBe("U_X"); // channel gets -1 tie-break penalty
  });

  test("scoreEntry: exact full-name beats a mid-name substring", () => {
    const entry: SlackDirectoryEntry = { id: "U", kind: "user", handle: "alice_w", label: "Alice Wonderland", aliases: ["Alice Wonderland"] };
    const exact = scoreEntry("Alice Wonderland", entry); // exact name
    const sub = scoreEntry("onder", entry);              // mid-substring only
    expect(exact).toBeGreaterThan(sub);
  });

  test("empty query scores 0 / returns nothing", () => {
    expect(scoreEntry("", DIR[0])).toBe(0);
    expect(ids("")).toEqual([]);
  });
});
