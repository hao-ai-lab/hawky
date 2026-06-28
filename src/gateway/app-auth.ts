import { timingSafeEqual, randomBytes, scryptSync, createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { dirname, join } from "node:path";
import { getConfigDir } from "../storage/config.js";
import { createSubsystemLogger } from "../logging/index.js";

const log = createSubsystemLogger("gateway/app-auth");

const SESSION_COOKIE = "hawky_session";
const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60;
const SIGNING_KEY_BYTES = 32;
const MIN_PASSWORD_LENGTH = 15;
const MAX_PASSWORD_LENGTH = 256;
const SCRYPT_MAXMEM = 256 * 1024 * 1024;
const MAX_FAILED_ATTEMPTS = 8;
const LOCKOUT_MS = 15 * 60 * 1000;

interface StoredUser {
  id: string;
  email: string;
  role?: AppAuthRole;
  status?: AppAuthStatus;
  password: {
    salt: string;
    hash: string;
    N: number;
    r: number;
    p: number;
    keyLen: number;
  };
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
  disabledAt?: string;
  disabledBy?: string;
}

interface UserStoreFile {
  users: StoredUser[];
}

export interface AppAuthUser {
  id: string;
  email: string;
  role: AppAuthRole;
  status: AppAuthStatus;
}

export type AppAuthRole = "admin" | "user";
export type AppAuthStatus = "pending" | "approved" | "disabled";

export interface AppAuthOptions {
  stateDir?: string;
  registrationCode?: string;
  registrationAllowlist?: string[];
  adminEmails?: string[];
  publicRegistration?: boolean;
  notifyWebhookUrl?: string;
  allowFirstUserRegistration?: boolean;
}

export interface AppRegistrationResult {
  user: AppAuthUser;
  approvalRequired: boolean;
}

export interface AppAuthUserRecord extends AppAuthUser {
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
  disabledAt?: string;
  disabledBy?: string;
}

function base64url(data: Buffer | string): string {
  return Buffer.from(data).toString("base64url");
}

function fromBase64url(data: string): Buffer {
  return Buffer.from(data, "base64url");
}

function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function parseEmailList(raw: string): string[] {
  return raw
    .split(/[,\s]+/)
    .map(normalizeEmail)
    .filter(Boolean);
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(value);
  }
  return out;
}

function sessionCookieDomainAttribute(): string[] {
  const domain = (process.env.HAWKY_SESSION_COOKIE_DOMAIN || "").trim();
  if (!domain) return [];
  if (!/^\.?[a-z0-9.-]+$/i.test(domain)) return [];
  return [`Domain=${domain}`];
}

function hashPassword(password: string): StoredUser["password"] {
  const salt = randomBytes(16);
  const params = { N: 131072, r: 8, p: 1, keyLen: 64 };
  const hash = scryptSync(password, salt, params.keyLen, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return { ...params, salt: salt.toString("base64"), hash: hash.toString("base64") };
}

function verifyPassword(password: string, stored: StoredUser["password"]): boolean {
  const salt = Buffer.from(stored.salt, "base64");
  const expected = Buffer.from(stored.hash, "base64");
  const actual = scryptSync(password, salt, stored.keyLen, {
    N: stored.N,
    r: stored.r,
    p: stored.p,
    maxmem: SCRYPT_MAXMEM,
  });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function readJson<T>(path: string, fallback: T): T {
  try {
    if (!existsSync(path)) return fallback;
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    log.warn("failed to read app auth store; using empty fallback", { path });
    return fallback;
  }
}

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2), { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch {}
}

export class AppAuth {
  private usersPath: string;
  private signingKeyPath: string;
  private signingKey: Buffer;
  private registrationCode: string;
  private registrationAllowlist: Set<string>;
  private adminEmails: Set<string>;
  private publicRegistration: boolean;
  private notifyWebhookUrl: string;
  private allowFirstUserRegistration: boolean;
  private failedLogins = new Map<string, { count: number; lockedUntil: number }>();

  static fromEnv(): AppAuth | null {
    if (process.env.HAWKY_APP_AUTH !== "1") return null;
    return new AppAuth({
      registrationCode: process.env.HAWKY_REGISTRATION_CODE ?? "",
      registrationAllowlist: parseEmailList(process.env.HAWKY_REGISTRATION_ALLOWLIST ?? ""),
      adminEmails: parseEmailList(process.env.HAWKY_ADMIN_EMAILS ?? ""),
      publicRegistration: process.env.HAWKY_PUBLIC_REGISTRATION === "1",
      notifyWebhookUrl: process.env.HAWKY_ADMIN_NOTIFY_WEBHOOK_URL ?? "",
      allowFirstUserRegistration: process.env.HAWKY_ALLOW_FIRST_USER_REGISTRATION === "1",
    });
  }

  constructor(options: AppAuthOptions = {}) {
    const stateDir = options.stateDir ?? join(getConfigDir(), "state");
    this.usersPath = join(stateDir, "users.json");
    this.signingKeyPath = join(stateDir, "app-auth-secret.key");
    this.registrationCode = options.registrationCode ?? "";
    this.registrationAllowlist = new Set((options.registrationAllowlist ?? []).map(normalizeEmail).filter(Boolean));
    this.adminEmails = new Set((options.adminEmails ?? []).map(normalizeEmail).filter(Boolean));
    this.publicRegistration = options.publicRegistration ?? false;
    this.notifyWebhookUrl = options.notifyWebhookUrl ?? "";
    this.allowFirstUserRegistration = options.allowFirstUserRegistration ?? false;
    this.signingKey = this.loadOrCreateSigningKey();
  }

  enabled(): true {
    return true;
  }

  getUserCount(): number {
    return this.loadStore().users.length;
  }

  canRegister(): boolean {
    return this.publicRegistration
      || this.registrationAllowlist.size > 0
      || Boolean(this.registrationCode)
      || (this.allowFirstUserRegistration && this.getUserCount() === 0);
  }

  register(emailRaw: string, password: string, registrationCode = ""): AppRegistrationResult {
    const email = normalizeEmail(emailRaw);
    if (!email || !email.includes("@")) throw new Error("Enter a valid email address.");
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new Error(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
    }
    if (password.length > MAX_PASSWORD_LENGTH) {
      throw new Error(`Password must be ${MAX_PASSWORD_LENGTH} characters or fewer.`);
    }

    const store = this.loadStore();
    const firstUserAllowed = this.allowFirstUserRegistration && store.users.length === 0;
    const approvedByEmail = this.registrationAllowlist.has(email);
    const approvedByCode = Boolean(this.registrationCode)
      && constantTimeEqual(registrationCode, this.registrationCode);
    const adminBootstrap = this.adminEmails.has(email) || (this.adminEmails.size === 0 && firstUserAllowed);
    if (!firstUserAllowed) {
      if (!approvedByEmail && !approvedByCode && !this.publicRegistration && !this.adminEmails.has(email)) {
        if (this.registrationCode) {
          throw new Error("Invalid registration code.");
        }
        throw new Error("Registration is closed.");
      }
    }
    if (store.users.some((user) => user.email === email)) {
      throw new Error("That email is already registered.");
    }

    const approved = adminBootstrap || approvedByEmail || approvedByCode;
    const now = new Date().toISOString();
    const user: StoredUser = {
      id: randomBytes(16).toString("hex"),
      email,
      role: adminBootstrap ? "admin" : "user",
      status: approved ? "approved" : "pending",
      password: hashPassword(password),
      createdAt: now,
      approvedAt: approved ? now : undefined,
      approvedBy: approved ? "registration-policy" : undefined,
    };
    store.users.push(user);
    this.saveStore(store);
    log.info("app user registered", { userId: user.id, email, role: user.role, status: user.status });
    if (!approved) {
      this.notifyAdminOfRegistration(user);
    }
    return { user: this.toPublicUser(user), approvalRequired: !approved };
  }

  login(emailRaw: string, password: string, throttleKey = ""): { user: AppAuthUser; token: string } {
    const email = normalizeEmail(emailRaw);
    const attemptKey = `${email}:${throttleKey}`;
    this.assertLoginAllowed(attemptKey);
    const user = this.loadStore().users.find((candidate) => candidate.email === email);
    if (!user || !verifyPassword(password, user.password)) {
      this.recordFailedLogin(attemptKey);
      throw new Error("Invalid email or password.");
    }
    if (user.status === "pending") {
      throw new Error("Your registration is pending admin approval.");
    }
    if (user.status === "disabled") {
      throw new Error("This account is disabled.");
    }
    this.failedLogins.delete(attemptKey);
    return {
      user: this.toPublicUser(user),
      token: this.createSessionToken(user),
    };
  }

  userFromRequest(req: Request): AppAuthUser | null {
    const token = parseCookies(req.headers.get("Cookie"))[SESSION_COOKIE];
    if (!token) return null;
    return this.verifySessionToken(token);
  }

  isAdmin(user: AppAuthUser | null): boolean {
    return user?.role === "admin" && user.status === "approved";
  }

  listUsers(admin: AppAuthUser): AppAuthUserRecord[] {
    this.assertAdmin(admin);
    return this.loadStore().users.map((user) => ({
      ...this.toPublicUser(user),
      createdAt: user.createdAt,
      approvedAt: user.approvedAt,
      approvedBy: user.approvedBy,
      disabledAt: user.disabledAt,
      disabledBy: user.disabledBy,
    }));
  }

  approveUser(admin: AppAuthUser, userId: string, role: AppAuthRole = "user"): AppAuthUser {
    this.assertAdmin(admin);
    const store = this.loadStore();
    const user = store.users.find((candidate) => candidate.id === userId);
    if (!user) throw new Error("User not found.");
    user.status = "approved";
    user.role = role;
    user.approvedAt = new Date().toISOString();
    user.approvedBy = admin.email;
    delete user.disabledAt;
    delete user.disabledBy;
    this.saveStore(store);
    log.info("app user approved", { admin: admin.email, userId, email: user.email, role: user.role });
    return this.toPublicUser(user);
  }

  disableUser(admin: AppAuthUser, userId: string): AppAuthUser {
    this.assertAdmin(admin);
    if (admin.id === userId) throw new Error("Admins cannot disable their own account.");
    const store = this.loadStore();
    const user = store.users.find((candidate) => candidate.id === userId);
    if (!user) throw new Error("User not found.");
    user.status = "disabled";
    user.disabledAt = new Date().toISOString();
    user.disabledBy = admin.email;
    this.saveStore(store);
    log.info("app user disabled", { admin: admin.email, userId, email: user.email });
    return this.toPublicUser(user);
  }

  createSessionCookie(token: string): string {
    return [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      "Path=/",
      ...sessionCookieDomainAttribute(),
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
    ].join("; ");
  }

  clearSessionCookie(): string {
    return [
      `${SESSION_COOKIE}=`,
      "Path=/",
      ...sessionCookieDomainAttribute(),
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Max-Age=0",
    ].join("; ");
  }

  loginPage(returnUrl: string, error = ""): string {
    const safeReturn = sanitizeReturnUrl(returnUrl);
    const allowRegister = this.canRegister();
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hawky sign in</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #0e1110; color: #f5f3ee; }
    main { width: min(420px, calc(100vw - 32px)); }
    h1 { margin: 0 0 10px; font-size: 28px; font-weight: 650; }
    p { margin: 0 0 22px; color: #a7aaa4; line-height: 1.45; }
    form { display: grid; gap: 12px; }
    label { display: grid; gap: 6px; color: #d7d8d2; font-size: 13px; }
    input { height: 44px; border: 1px solid #30352f; border-radius: 8px; padding: 0 12px; background: #171b18; color: #fff; font: inherit; }
    button, .button { height: 44px; border: 0; border-radius: 8px; background: #f5f3ee; color: #101310; font-weight: 650; cursor: pointer; display: grid; place-items: center; text-decoration: none; font: inherit; }
    .button.secondary { background: #252a26; color: #f5f3ee; border: 1px solid #3a403a; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 10px; }
    .muted { color: #888d86; font-size: 12px; margin-top: 14px; }
    .error { padding: 10px 12px; border: 1px solid #6f2e2e; border-radius: 8px; background: #301919; color: #ffd8d8; margin-bottom: 14px; }
  </style>
</head>
<body>
  <main>
    <h1>Hawky</h1>
    <p>Sign in to create a device token for this browser.</p>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="post" action="/auth/login">
      <input type="hidden" name="return_url" value="${escapeHtml(safeReturn)}" />
      <label>Email <input name="email" type="email" autocomplete="email" required /></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required /></label>
      ${allowRegister ? `
        <div class="row">
          <button type="submit">Sign in</button>
          <a class="button secondary" href="/auth/register?return_url=${encodeURIComponent(safeReturn)}">Request access</a>
        </div>
      ` : `<button type="submit">Sign in</button>`}
    </form>
    <p class="muted">Registration is ${allowRegister ? "open by admin approval" : "closed"} on this gateway.</p>
  </main>
</body>
</html>`;
  }

  registerPage(returnUrl: string, message = "", error = ""): string {
    const safeReturn = sanitizeReturnUrl(returnUrl);
    if (!this.canRegister()) {
      return this.loginPage(safeReturn, "Registration is closed.");
    }
    return this.shellPage("Request Access", `
      <p>Request access to Hawky. An admin reviews new accounts before sign-in is enabled.</p>
      ${message ? `<div class="notice">${escapeHtml(message)}</div>` : ""}
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      <form method="post" action="/auth/register">
        <input type="hidden" name="return_url" value="${escapeHtml(safeReturn)}" />
        <label>Email <input name="email" type="email" autocomplete="email" required /></label>
        <label>Password <input name="password" type="password" autocomplete="new-password" minlength="${MIN_PASSWORD_LENGTH}" maxlength="${MAX_PASSWORD_LENGTH}" required /></label>
        ${this.registrationCode ? `<label>Invite code <input name="registration_code" type="password" autocomplete="off" /></label>` : ""}
        <button type="submit">Request access</button>
      </form>
      <p class="muted"><a href="/auth/login?return_url=${encodeURIComponent(safeReturn)}">Back to sign in</a></p>
    `);
  }

  adminPage(admin: AppAuthUser, message = "", error = ""): string {
    const users = this.listUsers(admin);
    const pending = users.filter((user) => user.status === "pending").length;
    const approved = users.filter((user) => user.status === "approved").length;
    return this.shellPage("Admin", `
      <p>Review access requests, manage roles, and disable accounts.</p>
      ${message ? `<div class="notice">${escapeHtml(message)}</div>` : ""}
      ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
      <div class="stats">
        <div><strong>${pending}</strong><span>pending</span></div>
        <div><strong>${approved}</strong><span>approved</span></div>
        <div><strong>${users.length}</strong><span>total</span></div>
      </div>
      <table>
        <thead><tr><th>Email</th><th>Role</th><th>Status</th><th>Created</th><th>Action</th></tr></thead>
        <tbody>
          ${users.map((user) => `
            <tr>
              <td>${escapeHtml(user.email)}</td>
              <td>${escapeHtml(user.role)}</td>
              <td><span class="badge ${escapeHtml(user.status)}">${escapeHtml(user.status)}</span></td>
              <td>${escapeHtml(user.createdAt.slice(0, 10))}</td>
              <td>
                ${user.status !== "approved" ? `
                  <form method="post" action="/admin/users/${encodeURIComponent(user.id)}/approve" class="inline">
                    <select name="role"><option value="user">User</option><option value="admin">Admin</option></select>
                    <button type="submit">Approve</button>
                  </form>
                ` : ""}
                ${user.status !== "disabled" && user.id !== admin.id ? `
                  <form method="post" action="/admin/users/${encodeURIComponent(user.id)}/disable" class="inline">
                    <button type="submit" class="danger">Disable</button>
                  </form>
                ` : ""}
              </td>
            </tr>
          `).join("")}
        </tbody>
      </table>
      <p class="muted"><a href="/">Back to app</a> · <a href="/auth/logout?return_url=/auth/login">Log out</a></p>
    `, true);
  }

  private loadOrCreateSigningKey(): Buffer {
    if (existsSync(this.signingKeyPath)) {
      const key = readFileSync(this.signingKeyPath);
      if (key.length >= SIGNING_KEY_BYTES) return key;
      log.warn("app auth signing key too short, regenerating", { path: this.signingKeyPath });
    }
    const key = randomBytes(SIGNING_KEY_BYTES);
    mkdirSync(dirname(this.signingKeyPath), { recursive: true });
    writeFileSync(this.signingKeyPath, key, { mode: 0o600 });
    try { chmodSync(this.signingKeyPath, 0o600); } catch {}
    return key;
  }

  private loadStore(): UserStoreFile {
    const store = readJson<UserStoreFile>(this.usersPath, { users: [] });
    let changed = false;
    store.users = store.users.map((user, index) => {
      if (!user.status) { user.status = "approved"; changed = true; }
      const desiredRole = this.resolveInitialRole(user.email, user.role ?? (index === 0 ? "admin" : "user"));
      if (user.role !== desiredRole) { user.role = desiredRole; changed = true; }
      if (this.adminEmails.has(user.email) && user.status !== "approved") {
        user.status = "approved";
        user.approvedAt = user.approvedAt ?? new Date().toISOString();
        user.approvedBy = user.approvedBy ?? "admin-email-policy";
        changed = true;
      }
      return user;
    });
    if (changed) this.saveStore(store);
    return store;
  }

  private saveStore(store: UserStoreFile): void {
    writeJson(this.usersPath, store);
  }

  private createSessionToken(user: StoredUser): string {
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: "user",
      uid: user.id,
      email: user.email,
      role: user.role ?? "user",
      iat: now,
      exp: now + SESSION_MAX_AGE_SECONDS,
      jti: randomBytes(16).toString("hex"),
    };
    const body = base64url(JSON.stringify(payload));
    const sig = createHmac("sha256", this.signingKey).update(body).digest();
    return `${body}.${base64url(sig)}`;
  }

  private assertLoginAllowed(key: string): void {
    const entry = this.failedLogins.get(key);
    if (!entry) return;
    if (entry.lockedUntil > Date.now()) {
      const minutes = Math.ceil((entry.lockedUntil - Date.now()) / 60_000);
      throw new Error(`Too many failed attempts. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`);
    }
    if (entry.lockedUntil) this.failedLogins.delete(key);
  }

  private recordFailedLogin(key: string): void {
    const entry = this.failedLogins.get(key) ?? { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILED_ATTEMPTS) {
      entry.count = 0;
      entry.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    this.failedLogins.set(key, entry);
  }

  private verifySessionToken(token: string): AppAuthUser | null {
    const [body, sig] = token.split(".");
    if (!body || !sig) return null;
    const expected = createHmac("sha256", this.signingKey).update(body).digest();
    const actual = fromBase64url(sig);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;

    try {
      const payload = JSON.parse(fromBase64url(body).toString("utf-8")) as {
        sub?: string;
        uid?: string;
        email?: string;
        exp?: number;
      };
      if (payload.sub !== "user" || !payload.uid || !payload.email || !payload.exp) return null;
      if (payload.exp <= Math.floor(Date.now() / 1000)) return null;
      const user = this.loadStore().users.find((candidate) => candidate.id === payload.uid);
      if (!user || user.email !== payload.email) return null;
      if (user.status !== "approved") return null;
      return this.toPublicUser(user);
    } catch {
      return null;
    }
  }

  private toPublicUser(user: StoredUser): AppAuthUser {
    return {
      id: user.id,
      email: user.email,
      role: user.role ?? "user",
      status: user.status ?? "approved",
    };
  }

  private assertAdmin(user: AppAuthUser): void {
    if (!this.isAdmin(user)) throw new Error("Admin access required.");
  }

  private resolveInitialRole(email: string, requestedRole: AppAuthRole): AppAuthRole {
    if (this.adminEmails.has(normalizeEmail(email))) return "admin";
    return requestedRole;
  }

  private notifyAdminOfRegistration(user: StoredUser): void {
    log.warn("app registration pending admin approval", { userId: user.id, email: user.email });
    if (!this.notifyWebhookUrl) return;
    const body = JSON.stringify({
      text: `New Hawky registration pending approval: ${user.email}`,
      user: { id: user.id, email: user.email, status: user.status, role: user.role },
    });
    void fetch(this.notifyWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }).catch((err) => {
      log.warn("admin registration webhook failed", { error: err instanceof Error ? err.message : String(err) });
    });
  }

  private shellPage(title: string, content: string, wide = false): string {
    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Hawky ${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #0e1110; color: #f5f3ee; }
    main { width: min(${wide ? "960px" : "430px"}, calc(100vw - 32px)); padding: 32px 0; }
    h1 { margin: 0 0 10px; font-size: 28px; font-weight: 650; }
    p { margin: 0 0 22px; color: #a7aaa4; line-height: 1.45; }
    form { display: grid; gap: 12px; }
    label { display: grid; gap: 6px; color: #d7d8d2; font-size: 13px; }
    input, select { height: 44px; border: 1px solid #30352f; border-radius: 8px; padding: 0 12px; background: #171b18; color: #fff; font: inherit; }
    button { min-height: 38px; border: 0; border-radius: 8px; padding: 0 14px; background: #f5f3ee; color: #101310; font-weight: 650; cursor: pointer; }
    button.danger { background: #642323; color: #ffe8e8; }
    a { color: #f5f3ee; }
    table { width: 100%; border-collapse: collapse; margin-top: 18px; }
    th, td { border-bottom: 1px solid #30352f; padding: 12px 8px; text-align: left; vertical-align: middle; }
    th { color: #a7aaa4; font-size: 12px; font-weight: 600; text-transform: uppercase; }
    .inline { display: inline-flex; grid-auto-flow: column; align-items: center; gap: 8px; margin: 2px 6px 2px 0; }
    .inline select { height: 38px; }
    .muted { color: #888d86; font-size: 12px; margin-top: 14px; }
    .error, .notice { padding: 10px 12px; border-radius: 8px; margin-bottom: 14px; }
    .error { border: 1px solid #6f2e2e; background: #301919; color: #ffd8d8; }
    .notice { border: 1px solid #40523a; background: #1c2a1c; color: #dff6dc; }
    .stats { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; margin: 18px 0; }
    .stats div { border: 1px solid #30352f; border-radius: 8px; padding: 12px; background: #151915; }
    .stats strong { display: block; font-size: 22px; }
    .stats span { color: #a7aaa4; font-size: 12px; }
    .badge { border-radius: 999px; padding: 4px 8px; font-size: 12px; background: #2a2d28; }
    .badge.approved { background: #1e3a24; color: #c9f4cf; }
    .badge.pending { background: #403716; color: #fff1b8; }
    .badge.disabled { background: #402020; color: #ffd8d8; }
  </style>
</head>
<body>
  <main>
    <h1>Hawky ${escapeHtml(title)}</h1>
    ${content}
  </main>
</body>
</html>`;
  }
}

export function sanitizeReturnUrl(raw: string | null | undefined): string {
  if (!raw || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
