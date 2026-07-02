import { describe, expect, test } from "bun:test";
import { isLoopbackHost, isLoopbackUrl } from "../src/gateway/loopback.js";

describe("gateway loopback helpers", () => {
  test("recognizes loopback hostnames", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
  });

  test("rejects non-loopback hostnames", () => {
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("gateway.example.test")).toBe(false);
    expect(isLoopbackHost("192.168.1.20")).toBe(false);
  });

  test("recognizes loopback URLs across supported schemes", () => {
    expect(isLoopbackUrl("ws://localhost:4242")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1:4242/auth/device")).toBe(true);
    expect(isLoopbackUrl("wss://[::1]:4242/ws")).toBe(true);
  });

  test("rejects remote and invalid URLs", () => {
    expect(isLoopbackUrl("wss://hawky.example.test/ws")).toBe(false);
    expect(isLoopbackUrl("/ws")).toBe(false);
    expect(isLoopbackUrl("not a url")).toBe(false);
  });
});
