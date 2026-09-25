import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { sanitizeReturnUrl } from "./app-auth.js";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_KEYS = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
const FLOW_TTL_MS = 10 * 60 * 1000;
const FLOW_COOKIE = "hawky_google_state";

type PendingFlow = {
  verifier: string;
  nonce: string;
  returnUrl: string;
  linkedUserId: string | null;
  expiresAt: number;
};

export type GoogleIdentity = { sub: string; email: string; hostedDomain?: string };

function randomUrlSafe(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function cookieValue(req: Request, name: string): string {
  const header = req.headers.get("Cookie") ?? "";
  return header.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1) ?? "";
}

export class GoogleOAuth {
  private pending = new Map<string, PendingFlow>();
  private readonly cookieDomain: string;

  static fromEnv(): GoogleOAuth | null {
    const clientId = process.env.HAWKY_GOOGLE_CLIENT_ID?.trim();
    const clientSecret = process.env.HAWKY_GOOGLE_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) return null;
    const redirectUri = process.env.HAWKY_GOOGLE_REDIRECT_URI?.trim() ?? "https://app.hawky.live/auth/google/callback";
    return new GoogleOAuth(clientId, clientSecret, redirectUri);
  }

  constructor(
    private readonly clientId: string,
    private readonly clientSecret: string,
    private readonly redirectUri: string,
  ) {
    if (!redirectUri.startsWith("https://")) throw new Error("Google OAuth redirect URI must use HTTPS.");
    this.cookieDomain = new URL(redirectUri).hostname.endsWith(".hawky.live") ? "; Domain=.hawky.live" : "";
  }

  start(returnUrl: string, linkedUserId: string | null = null): { url: string; cookie: string } {
    for (const [key, flow] of this.pending) {
      if (flow.expiresAt <= Date.now()) this.pending.delete(key);
    }
    if (this.pending.size >= 1024) this.pending.delete(this.pending.keys().next().value!);
    const state = randomUrlSafe();
    const verifier = randomUrlSafe(48);
    const nonce = randomUrlSafe();
    this.pending.set(state, {
      verifier,
      nonce,
      returnUrl: sanitizeReturnUrl(returnUrl),
      linkedUserId,
      expiresAt: Date.now() + FLOW_TTL_MS,
    });
    const url = new URL(GOOGLE_AUTH_URL);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "openid email");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    return {
      url: url.toString(),
      cookie: `${FLOW_COOKIE}=${state}; Path=/auth/google${this.cookieDomain}; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    };
  }

  async finish(req: Request, url: URL): Promise<{ identity: GoogleIdentity; returnUrl: string; linkedUserId: string | null }> {
    const state = url.searchParams.get("state") ?? "";
    const cookieState = cookieValue(req, FLOW_COOKIE);
    const flow = this.pending.get(state);
    if (state) this.pending.delete(state);
    if (!flow || !cookieState || !equal(state, cookieState) || flow.expiresAt <= Date.now()) {
      throw new Error("Google sign-in expired. Please try again.");
    }
    const code = url.searchParams.get("code");
    if (!code || url.searchParams.has("error")) throw new Error("Google sign-in was cancelled.");
    const response = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: "authorization_code",
        code_verifier: flow.verifier,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Google sign-in could not be completed.");
    const body = await response.json() as { id_token?: string };
    if (!body.id_token) throw new Error("Google did not return an identity token.");
    const { payload } = await jwtVerify(body.id_token, GOOGLE_KEYS, {
      issuer: ["https://accounts.google.com", "accounts.google.com"],
      audience: this.clientId,
      algorithms: ["RS256"],
    });
    if (!payload.sub || typeof payload.email !== "string" || payload.email_verified !== true || payload.nonce !== flow.nonce) {
      throw new Error("Google identity could not be verified.");
    }
    return {
      identity: { sub: payload.sub, email: payload.email, hostedDomain: typeof payload.hd === "string" ? payload.hd : undefined },
      returnUrl: flow.returnUrl,
      linkedUserId: flow.linkedUserId,
    };
  }

  clearCookie(): string {
    return `${FLOW_COOKIE}=; Path=/auth/google${this.cookieDomain}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
  }
}
