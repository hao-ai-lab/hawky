import { describe, expect, test } from "bun:test";
import { stableHash, stableJson } from "../src/identity/person/stable-hash.js";

describe("person stable hash", () => {
  test("sorts object keys recursively", () => {
    expect(stableJson({ b: 2, a: { d: 4, c: 3 } })).toBe('{"a":{"c":3,"d":4},"b":2}');
  });

  test("keeps array order while sorting nested object keys", () => {
    expect(stableJson(["x", { b: 2, a: 1 }])).toBe('["x",{"a":1,"b":2}]');
  });

  test("produces deterministic 16 character hashes", () => {
    const left = stableHash({ b: 2, a: 1 });
    const right = stableHash({ a: 1, b: 2 });

    expect(left).toBe(right);
    expect(left).toHaveLength(16);
  });

  test("changes when payload values change", () => {
    expect(stableHash(["legacy_deepface", "p1"])).not.toBe(stableHash(["legacy_deepface", "p2"]));
  });
});
