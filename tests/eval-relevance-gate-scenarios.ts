// =============================================================================
// eval-relevance-gate-scenarios.ts — LLM relevance-gate scenario eval.
//
// Runs the REAL LLM gate (claude-sonnet-4-6) against similar-but-different
// scenarios and checks the per-need surface decision against expectations.
// Run: ANTHROPIC_API_KEY=… bun run tests/eval-relevance-gate-scenarios.ts
// (falls back to ~/.hawky/config.json api_keys.anthropic)
// =============================================================================

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { makeRelevanceGate, type RelevanceInput } from "../src/ambient/relevance-gate.js";
import type { Intention } from "../src/ambient/intention.js";
import type { TranscriptTurn } from "../src/ambient/transcript-window.js";

function apiKey(): string {
  if (process.env.ANTHROPIC_API_KEY) return process.env.ANTHROPIC_API_KEY;
  try {
    const cfg = JSON.parse(readFileSync(join(homedir(), ".hawky", "config.json"), "utf8"));
    return cfg.api_keys?.anthropic ?? "";
  } catch {
    return "";
  }
}

const MODEL = process.env.GATE_MODEL ?? "claude-sonnet-4-6";
const client = new Anthropic({ apiKey: apiKey() });
const invoke = async (prompt: string): Promise<string> => {
  const r = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: "user", content: prompt }],
  });
  return r.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
};

let nextId = 0;
function need(content: string, topic: string): Intention {
  const id = `n${++nextId}`;
  return {
    id,
    content,
    trigger: { all: [{ kind: "topic", topic, provenance: "inferred", confidence: 0.9 }] },
    strength: "soft",
    origin: "latent",
    state: "armed",
    evidence: { ts: "2026-06-09T00:00:00Z" },
    sensitivity: "private",
    createdAt: "2026-06-09T00:00:00Z",
    updatedAt: "2026-06-09T00:00:00Z",
  };
}
const turn = (text: string): TranscriptTurn => ({ role: "user", text, ts: "2026-06-09T00:00:00Z" });
const input = (armed: Intention[], window: TranscriptTurn[]): RelevanceInput => ({
  armed,
  window,
  now: Date.parse("2026-06-09T12:00:00Z"),
  tz: "America/Los_Angeles",
});

// Each scenario: a window + needs, with the EXPECTED surface decision per need content.
interface Scenario {
  name: string;
  window: string[];
  needs: Array<{ content: string; topic: string; expect: boolean }>;
}
const SCENARIOS: Scenario[] = [
  // --- EXPLICIT LIST REQUESTS (the fix: surface ALL pending needs) ---
  { name: "explicit: create a shopping list", window: ["Can you create a shopping list for me?"],
    needs: [{ content: "buy tissue", topic: "tissue", expect: true }, { content: "buy coffee", topic: "coffee", expect: true }] },
  { name: "explicit: what's on my to-do list", window: ["What's on my to-do list today?"],
    needs: [{ content: "call the dentist", topic: "dentist", expect: true }, { content: "buy batteries", topic: "batteries", expect: true }] },
  { name: "explicit: what did I need to get", window: ["Remind me, what did I need to get again?"],
    needs: [{ content: "buy tissue", topic: "tissue", expect: true }] },
  { name: "explicit: what errands do I have", window: ["What errands do I have?"],
    needs: [{ content: "pick up dry cleaning", topic: "dry cleaning", expect: true }, { content: "buy milk", topic: "milk", expect: true }] },
  // --- ON-TOPIC (surface the matching one only) ---
  { name: "on-topic: running low on coffee", window: ["Ugh, we're running really low on coffee again."],
    needs: [{ content: "buy coffee", topic: "coffee", expect: true }, { content: "buy tissue", topic: "tissue", expect: false }] },
  // --- RIGHT CONTEXT: place / activity ---
  { name: "context: heading to grocery store", window: ["I'm heading to the grocery store now."],
    needs: [{ content: "buy tissue", topic: "tissue", expect: true }, { content: "call the dentist", topic: "dentist", expect: false }] },
  { name: "context: running errands", window: ["Okay, I'm about to head out and run some errands."],
    needs: [{ content: "buy tissue", topic: "tissue", expect: true }, { content: "pick up dry cleaning", topic: "dry cleaning", expect: true }] },
  // --- SUPPRESS: incidental / unrelated / other-question / handled ---
  { name: "incidental: coffee prices chatter", window: ["Ugh, coffee is so expensive these days."],
    needs: [{ content: "buy coffee", topic: "coffee", expect: false }] },
  { name: "unrelated: weather question", window: ["What's the weather going to be like tomorrow?"],
    needs: [{ content: "buy tissue", topic: "tissue", expect: false }] },
  { name: "handled: already bought it", window: ["I just picked up tissue at the store on the way home."],
    needs: [{ content: "buy tissue", topic: "tissue", expect: false }] },
];

async function run() {
  if (!apiKey()) { console.log("NO ANTHROPIC KEY — skipping eval"); return; }
  const gate = makeRelevanceGate(invoke);
  let pass = 0, fail = 0;
  for (const s of SCENARIOS) {
    const needs = s.needs.map((n) => need(n.content, n.topic));
    const verdicts = await gate.evaluate(input(needs, s.window.map(turn)));
    const byId = new Map(verdicts.map((v) => [v.id, v.surface]));
    const rows = s.needs.map((n, i) => {
      const got = byId.get(needs[i].id) ?? false;
      const ok = got === n.expect;
      if (ok) pass++; else fail++;
      return `      ${ok ? "✓" : "✗"} "${n.content}" expect=${n.expect} got=${got}`;
    });
    console.log(`\n[${rows.every((r) => r.includes("✓")) ? "PASS" : "FAIL"}] ${s.name}`);
    console.log(rows.join("\n"));
  }
  console.log(`\n=== ${pass}/${pass + fail} need-decisions correct (${fail} wrong) ===`);
}
run().catch((e) => { console.error("eval error:", e); process.exit(1); });
