import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertMemoryCandidate,
  buildMemoryCandidate,
  FileMemoryCandidateStore,
  InMemoryMemoryCandidateStore,
} from "../src/memory/candidate.js";

describe("MemoryCandidate", () => {
  test("defaults to reviewable but not memory-promotable", () => {
    const candidate = buildMemoryCandidate({
      text: "Kevin prefers short updates.",
      sourceSession: { sessionKey: "realtime/person" },
      subjects: [{ type: "confirmed_person", id: "person_kevin", label: "Kevin" }],
    });

    expect(candidate.review.state).toBe("unreviewed");
    expect(candidate.allowedUses.reviewDisplay).toBe(true);
    expect(candidate.allowedUses.memorySearch).toBe(false);
    expect(candidate.allowedUses.contextExport).toBe(false);
    expect(candidate.allowedUses.durableMemory).toBe(false);
    expect(candidate.retention).toBe("durable");
  });

  test("requires inspectable evidence or a source session", () => {
    expect(() => buildMemoryCandidate({ text: "No provenance." })).toThrow(/evidenceRefs or sourceSession/i);
  });

  test("stores quarantined identity-derived candidates without enabling durable memory", () => {
    const store = new InMemoryMemoryCandidateStore();
    const candidate = store.put(buildMemoryCandidate({
      text: "The unknown face might be Kevin.",
      sourceSession: { sessionKey: "realtime/person" },
      subjects: [{ type: "person_candidate", id: "cand_face_unknown", label: "unknown face" }],
      quarantineReason: "unconfirmed_identity_candidate",
    }));

    expect(store.get(candidate.id)?.quarantineReason).toBe("unconfirmed_identity_candidate");
    expect(store.get(candidate.id)?.allowedUses.durableMemory).toBe(false);
  });
});

describe("FileMemoryCandidateStore", () => {
  test("persists candidates as validated JSON records", () => {
    const dir = mkdtempSync(join(tmpdir(), "hawky-memory-candidate-"));
    try {
      const store = new FileMemoryCandidateStore(join(dir, "memory-candidates.json"));
      const candidate = buildMemoryCandidate({
        text: "User likes local-first tools.",
        sourceSession: { sessionKey: "realtime/local" },
        subjects: [{ type: "owner" }],
      });
      store.put(candidate);

      const loaded = new FileMemoryCandidateStore(join(dir, "memory-candidates.json")).get(candidate.id);
      expect(loaded?.text).toBe(candidate.text);
      expect(() => assertMemoryCandidate(loaded)).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
