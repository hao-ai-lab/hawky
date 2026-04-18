import { describe, test, expect, beforeEach } from "bun:test";
import { SessionBindingService } from "../src/gateway/session-binding.js";

describe("SessionBindingService", () => {
  let service: SessionBindingService;

  beforeEach(() => {
    service = new SessionBindingService();
  });

  // -------------------------------------------------------------------------
  // bind + resolve
  // -------------------------------------------------------------------------

  test("bind creates a binding and resolve returns the session key", () => {
    service.bind("slack", "D123", "web:general");
    expect(service.resolve("slack", "D123")).toBe("web:general");
  });

  test("resolve returns undefined for unbound conversation", () => {
    expect(service.resolve("slack", "D999")).toBeUndefined();
  });

  test("resolve returns undefined for unbound channel", () => {
    service.bind("slack", "D123", "web:general");
    expect(service.resolve("imessage", "D123")).toBeUndefined();
  });

  test("wildcard binding matches any conversation on that channel", () => {
    service.bind("slack", "*", "web:general");
    expect(service.resolve("slack", "D123")).toBe("web:general");
    expect(service.resolve("slack", "D456")).toBe("web:general");
  });

  test("exact match takes precedence over wildcard", () => {
    service.bind("slack", "*", "web:general");
    service.bind("slack", "D123", "web:study");
    expect(service.resolve("slack", "D123")).toBe("web:study");
    expect(service.resolve("slack", "D456")).toBe("web:general");
  });

  test("wildcard on one channel does not match another channel", () => {
    service.bind("slack", "*", "web:general");
    expect(service.resolve("imessage", "chat-1")).toBeUndefined();
  });

  test("bind overwrites existing binding for same conversation", () => {
    service.bind("slack", "D123", "web:general");
    service.bind("slack", "D123", "web:work");
    expect(service.resolve("slack", "D123")).toBe("web:work");
  });

  test("bind returns the created binding object", () => {
    const binding = service.bind("slack", "D123", "web:general");
    expect(binding.channelId).toBe("slack");
    expect(binding.conversationId).toBe("D123");
    expect(binding.sessionKey).toBe("web:general");
    expect(binding.boundAt).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // listBySession
  // -------------------------------------------------------------------------

  test("listBySession returns all non-wildcard bindings for a session", () => {
    service.bind("slack", "D123", "web:general");
    service.bind("slack", "D456", "web:general");
    service.bind("imessage", "chat-1", "web:general");
    service.bind("slack", "D789", "web:work");

    const bindings = service.listBySession("web:general");
    expect(bindings.length).toBe(3);
    expect(bindings.map(b => b.conversationId).sort()).toEqual(["D123", "D456", "chat-1"]);
  });

  test("listBySession returns empty array for unbound session", () => {
    expect(service.listBySession("web:unknown")).toEqual([]);
  });

  test("listBySession excludes wildcard bindings (can't send to '*')", () => {
    service.bind("slack", "*", "web:general");
    service.bind("slack", "D123", "web:general");

    const bindings = service.listBySession("web:general");
    expect(bindings.length).toBe(1);
    expect(bindings[0].conversationId).toBe("D123");
  });

  test("listBySession returns empty when only wildcard is bound", () => {
    service.bind("slack", "*", "web:general");
    expect(service.listBySession("web:general")).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // resolveAndBind — promote wildcard to exact binding
  // -------------------------------------------------------------------------

  test("resolveAndBind returns session key for exact match without creating new binding", () => {
    service.bind("slack", "D123", "web:general");
    const before = service.listAll().length;

    const result = service.resolveAndBind("slack", "D123");

    expect(result).toBe("web:general");
    expect(service.listAll().length).toBe(before);
  });

  test("resolveAndBind promotes wildcard match to exact binding", () => {
    service.bind("slack", "*", "web:general");
    expect(service.listAll().length).toBe(1);

    const result = service.resolveAndBind("slack", "D123");

    expect(result).toBe("web:general");
    // Now an exact binding exists
    expect(service.listAll().length).toBe(2);
    // And listBySession now returns the exact binding (but not the wildcard)
    const bindings = service.listBySession("web:general");
    expect(bindings.length).toBe(1);
    expect(bindings[0].conversationId).toBe("D123");
  });

  test("resolveAndBind returns undefined when no binding matches", () => {
    expect(service.resolveAndBind("slack", "D999")).toBeUndefined();
    expect(service.listAll().length).toBe(0);
  });

  test("resolveAndBind is idempotent across multiple calls for same conversation", () => {
    service.bind("slack", "*", "web:general");

    service.resolveAndBind("slack", "D123");
    service.resolveAndBind("slack", "D123");
    service.resolveAndBind("slack", "D123");

    // Should have wildcard + one exact binding (not three)
    expect(service.listAll().length).toBe(2);
  });

  test("resolveAndBind on different conversations creates separate exact bindings", () => {
    service.bind("slack", "*", "web:general");

    service.resolveAndBind("slack", "D123");
    service.resolveAndBind("slack", "D456");

    const bindings = service.listBySession("web:general");
    expect(bindings.length).toBe(2);
    expect(bindings.map(b => b.conversationId).sort()).toEqual(["D123", "D456"]);
  });

  // -------------------------------------------------------------------------
  // unbind
  // -------------------------------------------------------------------------

  test("unbind removes a binding", () => {
    service.bind("slack", "D123", "web:general");
    expect(service.unbind("slack", "D123")).toBe(true);
    expect(service.resolve("slack", "D123")).toBeUndefined();
  });

  test("unbind returns false for non-existent binding", () => {
    expect(service.unbind("slack", "D999")).toBe(false);
  });

  // -------------------------------------------------------------------------
  // listAll + clear
  // -------------------------------------------------------------------------

  test("listAll returns all bindings", () => {
    service.bind("slack", "D123", "web:general");
    service.bind("imessage", "chat-1", "web:work");
    expect(service.listAll().length).toBe(2);
  });

  test("clear removes all bindings", () => {
    service.bind("slack", "D123", "web:general");
    service.bind("slack", "*", "web:general");
    service.clear();
    expect(service.listAll().length).toBe(0);
    expect(service.resolve("slack", "D123")).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // rebindAll — used by session rename
  // -------------------------------------------------------------------------

  test("rebindAll redirects bindings matching oldKey", () => {
    service.bind("slack", "D123", "web:email-triage");
    service.bind("slack", "D456", "web:email-triage");
    service.bind("slack", "D789", "web:other");

    const n = service.rebindAll("web:email-triage", "web:message-triage");

    expect(n).toBe(2);
    expect(service.resolve("slack", "D123")).toBe("web:message-triage");
    expect(service.resolve("slack", "D456")).toBe("web:message-triage");
    expect(service.resolve("slack", "D789")).toBe("web:other");
  });

  test("rebindAll is a no-op when no bindings match", () => {
    service.bind("slack", "D123", "web:general");
    expect(service.rebindAll("web:missing", "web:new")).toBe(0);
    expect(service.resolve("slack", "D123")).toBe("web:general");
  });

  test("rebindAll with same old/new key is a no-op", () => {
    service.bind("slack", "D123", "web:general");
    expect(service.rebindAll("web:general", "web:general")).toBe(0);
  });
});
