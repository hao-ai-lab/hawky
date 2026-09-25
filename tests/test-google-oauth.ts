import { describe, expect, test } from "bun:test";
import { GoogleOAuth } from "../src/gateway/google-oauth.js";

describe("GoogleOAuth", () => {
  test("starts a scoped code flow with state, nonce, and PKCE", async () => {
    const oauth = new GoogleOAuth("client-id", "client-secret", "https://app.hawky.live/auth/google/callback");
    const flow = oauth.start("//evil.example", "existing-user");
    const url = new URL(flow.url);
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("scope")).toBe("openid email");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("nonce")).toBeTruthy();
    expect(flow.cookie).toContain("HttpOnly");
    expect(flow.cookie).toContain("SameSite=Lax");
    expect(flow.cookie).toContain("Domain=.hawky.live");
    const callback = new URL("https://app.hawky.live/auth/google/callback");
    callback.searchParams.set("state", url.searchParams.get("state")!);
    callback.searchParams.set("code", "fake-code");
    await expect(oauth.finish(new Request(callback, { headers: { Cookie: "hawky_google_state=wrong" } }), callback))
      .rejects.toThrow("expired");
    await expect(oauth.finish(new Request(callback, { headers: { Cookie: flow.cookie.split(";")[0] } }), callback))
      .rejects.toThrow("expired");
  });
});
