import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import request from "supertest";
import { app } from "../src/server/index.js";
import { invalidateMemberships } from "../src/server/authz.js";

/**
 * Access-token refresh in `public/app.js` (TECH_DEBT.md TD-108, DECISIONS.md D-35).
 *
 * WHAT BROKE. Sign-in kept only Supabase's hour-long `access_token` and threw the `refresh_token`
 * away, so an idle tab silently stopped working after an hour: every /api call 401'd, and only the
 * run poll said so.
 *
 * THE CONTRACT these tests pin has two halves, and the first matters as much as the second:
 *
 *   1. FLAG OFF (`AUTH_TOKEN_REFRESH` unset, the default) changes NOTHING. No refresh token is
 *      stored, nothing is scheduled, a 401 is never retried. The "flag off" block below is the
 *      proof that shipping this is a no-op until someone turns it on.
 *   2. FLAG ON renews the token before it expires and on a 401, and when renewal fails the caller
 *      gets the ORIGINAL 401 — so every pre-existing 401 handler still runs unchanged.
 *
 * `public/app.js` is a classic script with no module surface, so the session code is extracted
 * from the file and evaluated against stubs — the same technique as `tests/appJsRunRecovery.test.ts`.
 * No browser, no server, no network.
 */

const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

/** Brace-match from `startIdx` (which must be at or before the opening `{`). */
function sliceBlock(startIdx: number, what: string): string {
  const body = APP.slice(startIdx);
  let depth = 0;
  for (let i = body.indexOf("{"); i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") {
      depth--;
      if (depth === 0) return body.slice(0, i + 1);
    }
  }
  throw new Error(`could not find the end of ${what}`);
}

function extractFunctionSource(name: string): string {
  const m = new RegExp(`(?:async )?function ${name}\\(`).exec(APP);
  if (!m) throw new Error(`${name} not found in public/app.js`);
  return sliceBlock(m.index, name);
}

function extractFetchWrapper(): string {
  const i = APP.indexOf("window.fetch = function (input, init) {");
  if (i < 0) throw new Error("fetch wrapper not found in public/app.js");
  return `${sliceBlock(i, "fetch wrapper")};`;
}

const MARGIN_LINE = /const TOKEN_REFRESH_MARGIN_S = \d+;/.exec(APP)?.[0];
if (!MARGIN_LINE) throw new Error("TOKEN_REFRESH_MARGIN_S not found in public/app.js");

const SOURCES = [
  MARGIN_LINE,
  ...[
    "writeSessionCookie", "setSession", "jwtExpiry", "tokenNeedsRefresh", "scheduleTokenRefresh",
    "adoptStoredSession", "refreshSession", "refreshIfStale", "canReplay",
  ].map(extractFunctionSource),
  extractFetchWrapper(),
].join("\n");

const SUPA = "https://proj.supabase.co";
const REFRESH_URL = `${SUPA}/auth/v1/token?grant_type=refresh_token`;
const now = () => Math.floor(Date.now() / 1000);

/** A syntactically real, unsigned JWT — only `exp` is ever read client-side. */
function jwt(exp: number, tag = "x"): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "none" })}.${b64({ exp, tag })}.sig`;
}

interface Call { url: string; auth: string | null; body: unknown }

interface Harness {
  auth: Record<string, unknown>;
  fetch: (input: unknown, init?: Record<string, unknown>) => Promise<{ status: number; json: () => Promise<unknown> }>;
  setSession: (token: string | null, email: string | null, refresh?: unknown) => void;
  refreshSession: () => Promise<boolean>;
  tokenNeedsRefresh: () => boolean;
  jwtExpiry: (t: string) => number | null;
  storage: Map<string, string>;
  calls: Call[];
  timers: { delay: number }[];
  cookie: () => string;
}

/**
 * Evaluate the real session code. `api` answers same-origin requests given the bearer they carried;
 * `supabase` answers the refresh endpoint given the refresh token spent.
 */
function harness(opts: {
  tokenRefresh: boolean;
  api?: (bearer: string | null, url: string) => number;
  supabase?: (refreshToken: string) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
  locks?: boolean;
}): Harness {
  const storage = new Map<string, string>();
  const calls: Call[] = [];
  const timers: { delay: number }[] = [];
  const doc = { cookie: "" };

  const rawFetch = async (input: unknown, init: Record<string, unknown> = {}) => {
    const url = String(input);
    const headers = new Headers((init.headers as HeadersInit) || {});
    const body = typeof init.body === "string" ? JSON.parse(init.body) : init.body ?? null;
    calls.push({ url, auth: headers.get("Authorization"), body });
    if (url === REFRESH_URL) {
      const r = await (opts.supabase ?? (() => ({ status: 400, body: {} })))((body as { refresh_token: string }).refresh_token);
      return { status: r.status, ok: r.status < 300, json: async () => r.body };
    }
    const status = (opts.api ?? (() => 200))(headers.get("Authorization"), url);
    return { status, ok: status < 300, json: async () => ({}) };
  };

  // A serialising stand-in for navigator.locks — same contract (callback result is the promise).
  let chain: Promise<unknown> = Promise.resolve();
  const locks = {
    request: (_name: string, cb: () => Promise<unknown>) => {
      const run = chain.then(cb, cb);
      chain = run.catch(() => {});
      return run;
    },
  };

  const factory = new Function(
    "deps",
    `
    const { rawFetch, localStorage, document, navigator, location, setTimeout, clearTimeout, atob } = deps;
    const window = {};
    const AUTH_STORAGE_KEY = "testbench.session";
    const auth = {
      required: true, url: ${JSON.stringify(SUPA)}, publishableKey: "pk", token: null, email: null,
      tokenRefresh: ${opts.tokenRefresh}, refreshToken: null, expiresAt: null,
    };
    let tokenRefreshTimer = null;
    let tokenRefreshInFlight = null;
    ${SOURCES}
    return { auth, fetch: window.fetch, setSession, refreshSession, tokenNeedsRefresh, jwtExpiry };
    `,
  );

  const h = factory({
    rawFetch,
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => storage.set(k, v),
      removeItem: (k: string) => storage.delete(k),
    },
    document: doc,
    navigator: opts.locks === false ? {} : { locks },
    location: { origin: "http://app.test" },
    // Recorded, never fired: the tests assert WHEN a refresh is scheduled, and call it directly.
    setTimeout: (_fn: () => void, delay: number) => { timers.push({ delay }); return timers.length; },
    clearTimeout: () => {},
    atob: (s: string) => Buffer.from(s, "base64").toString("binary"),
  });
  return { ...h, storage, calls, timers, cookie: () => doc.cookie };
}

const stored = (h: Harness) => JSON.parse(h.storage.get("testbench.session") ?? "null");
const refreshCalls = (h: Harness) => h.calls.filter((c) => c.url === REFRESH_URL);

// ---------------------------------------------------------------------------------------------

describe("flag OFF (the default) — nothing changes", () => {
  it("stores exactly { token, email } even when handed a refresh token", () => {
    const h = harness({ tokenRefresh: false });
    h.setSession(jwt(now() + 3600), "a@b.c", { refreshToken: "r1", expiresAt: now() + 3600 });
    expect(stored(h)).toEqual({ token: expect.any(String), email: "a@b.c" });
    expect(h.auth.refreshToken).toBeNull();
    expect(h.timers).toHaveLength(0);
  });

  it("a 401 is returned as-is: one request, no refresh, no retry", async () => {
    const h = harness({ tokenRefresh: false, api: () => 401 });
    h.setSession("t1", "a@b.c", { refreshToken: "r1" });
    const res = await h.fetch("/api/runs");
    expect(res.status).toBe(401);
    expect(h.calls).toHaveLength(1);
    expect(refreshCalls(h)).toHaveLength(0);
  });

  it("refreshSession is a no-op that never touches the network", async () => {
    const h = harness({ tokenRefresh: false });
    h.setSession("t1", "a@b.c");
    expect(await h.refreshSession()).toBe(false);
    expect(h.calls).toHaveLength(0);
    expect(h.tokenNeedsRefresh()).toBe(false);
  });
});

describe("flag ON — the session is renewed", () => {
  it("stores the refresh token and schedules a renewal 60s before expiry", () => {
    const h = harness({ tokenRefresh: true });
    const exp = now() + 3600;
    h.setSession(jwt(exp), "a@b.c", { refreshToken: "r1", expiresAt: exp });
    expect(stored(h)).toMatchObject({ email: "a@b.c", refreshToken: "r1", expiresAt: exp });
    const delay = h.timers.at(-1)!.delay;
    expect(delay).toBeGreaterThan((3600 - 60 - 5) * 1000);
    expect(delay).toBeLessThanOrEqual((3600 - 60) * 1000);
  });

  it("sign-up carries no expiry — it is read from the token's own `exp` claim", () => {
    const h = harness({ tokenRefresh: true });
    const exp = now() + 3600;
    expect(h.jwtExpiry(jwt(exp))).toBe(exp);
    expect(h.jwtExpiry("not-a-jwt")).toBeNull();
    h.setSession(jwt(exp), "a@b.c", { refreshToken: "r1" });
    expect(h.auth.expiresAt).toBe(exp);
  });

  it("a 401 renews once and retries with the NEW token; the caller sees the 200", async () => {
    const fresh = jwt(now() + 3600, "fresh");
    const h = harness({
      tokenRefresh: true,
      api: (bearer) => (bearer === `Bearer ${fresh}` ? 200 : 401),
      supabase: (rt) => (rt === "r1"
        ? { status: 200, body: { access_token: fresh, refresh_token: "r2", expires_at: now() + 3600 } }
        : { status: 400, body: {} }),
    });
    h.setSession(jwt(now() - 10, "old"), "a@b.c", { refreshToken: "r1", expiresAt: now() - 10 });

    const res = await h.fetch("/api/runs", { method: "POST", body: JSON.stringify({ a: 1 }) });
    expect(res.status).toBe(200);
    expect(refreshCalls(h)).toHaveLength(1);
    expect(refreshCalls(h)[0].body).toEqual({ refresh_token: "r1" });
    const retry = h.calls.at(-1)!;
    expect(retry.url).toBe("/api/runs");
    expect(retry.auth).toBe(`Bearer ${fresh}`);
    expect(retry.body).toEqual({ a: 1 });
    // The rotated pair is what's kept, and the artifact cookie follows the new token.
    expect(stored(h)).toMatchObject({ token: fresh, refreshToken: "r2" });
    expect(h.cookie()).toContain(encodeURIComponent(fresh));
  });

  it("a failed renewal hands back the ORIGINAL 401 and leaves the session alone", async () => {
    const h = harness({ tokenRefresh: true, api: () => 401, supabase: () => ({ status: 400, body: {} }) });
    h.setSession("t1", "a@b.c", { refreshToken: "r1", expiresAt: now() + 3600 });
    const res = await h.fetch("/api/runs/x/state");
    expect(res.status).toBe(401);
    // Exactly: original request + one refresh. No retry of the request, no second refresh.
    expect(h.calls.map((c) => c.url)).toEqual(["/api/runs/x/state", REFRESH_URL]);
    // Not signed out here — that stays the existing 401 handlers' decision, as before.
    expect(h.auth.token).toBe("t1");
  });

  it("a network error during renewal is a failed renewal, not a crash", async () => {
    const h = harness({ tokenRefresh: true, api: () => 401, supabase: () => { throw new Error("offline"); } });
    h.setSession("t1", "a@b.c", { refreshToken: "r1", expiresAt: now() + 3600 });
    expect((await h.fetch("/api/runs")).status).toBe(401);
  });

  it("many concurrent 401s spend the refresh token ONCE", async () => {
    const fresh = jwt(now() + 3600, "fresh");
    const h = harness({
      tokenRefresh: true,
      api: (bearer) => (bearer === `Bearer ${fresh}` ? 200 : 401),
      supabase: () => ({ status: 200, body: { access_token: fresh, refresh_token: "r2", expires_at: now() + 3600 } }),
    });
    h.setSession("old", "a@b.c", { refreshToken: "r1", expiresAt: now() + 3600 });
    const results = await Promise.all([h.fetch("/api/runs"), h.fetch("/api/projects"), h.fetch("/api/suites")]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(refreshCalls(h)).toHaveLength(1);
  });

  it("a request that can't be safely re-sent keeps its 401 (no refresh spent on it)", async () => {
    const h = harness({ tokenRefresh: true, api: () => 401, supabase: () => ({ status: 500, body: {} }) });
    h.setSession("t1", "a@b.c", { refreshToken: "r1", expiresAt: now() + 3600 });
    expect((await h.fetch("/api/upload", { method: "POST", body: new FormData() })).status).toBe(401);
    expect(refreshCalls(h)).toHaveLength(0);
  });

  it("another tab already renewed: adopt its token instead of spending ours again", async () => {
    const h = harness({ tokenRefresh: true });
    h.setSession("t1", "a@b.c", { refreshToken: "r1", expiresAt: now() + 30 });
    // What the other tab wrote after rotating r1 -> r2.
    h.storage.set("testbench.session", JSON.stringify({
      token: "t2", email: "a@b.c", refreshToken: "r2", expiresAt: now() + 3600,
    }));
    expect(await h.refreshSession()).toBe(true);
    expect(h.auth.token).toBe("t2");
    expect(h.auth.refreshToken).toBe("r2");
    expect(refreshCalls(h)).toHaveLength(0);
  });

  it("never adopts a different account's session from storage", async () => {
    const h = harness({ tokenRefresh: true });
    h.setSession("t1", "a@b.c", { refreshToken: "r1", expiresAt: now() + 30 });
    h.storage.set("testbench.session", JSON.stringify({
      token: "t9", email: "someone@else", refreshToken: "r9", expiresAt: now() + 3600,
    }));
    await h.refreshSession();
    expect(h.auth.token).not.toBe("t9");
  });

  it("signing out while a renewal is in flight does not resurrect the session", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    // A slow Supabase: it answers successfully, but only after the user has signed out.
    const h = harness({
      tokenRefresh: true,
      locks: false,
      supabase: () => gate.then(() => ({
        status: 200, body: { access_token: "t2", refresh_token: "r2", expires_at: now() + 3600 },
      })),
    });
    h.setSession("t1", "a@b.c", { refreshToken: "r1", expiresAt: now() + 30 });
    const pending = h.refreshSession();
    h.setSession(null, null);
    release();
    expect(await pending).toBe(false);
    expect(refreshCalls(h)).toHaveLength(1);
    expect(h.auth.token).toBeNull();
    expect(h.storage.has("testbench.session")).toBe(false);
  });

  it("tokenNeedsRefresh: true inside the 60s margin, false well before it", () => {
    const h = harness({ tokenRefresh: true });
    h.setSession("t1", "a@b.c", { refreshToken: "r1", expiresAt: now() - 5 });
    expect(h.tokenNeedsRefresh()).toBe(true);
    h.setSession("t1", "a@b.c", { refreshToken: "r1", expiresAt: now() + 3600 });
    expect(h.tokenNeedsRefresh()).toBe(false);
  });
});

describe("wiring in app.js (source checks)", () => {
  it("the flag comes only from the server's config, strictly `true`", () => {
    expect(extractFunctionSource("initAuth")).toContain("auth.tokenRefresh = cfg.tokenRefresh === true;");
  });

  it("sign-in and sign-up both hand their refresh token to setSession", () => {
    const init = extractFunctionSource("initAuth");
    expect(init).toMatch(/setSession\(body\.access_token,[^;]*refreshToken: body\.refresh_token/);
    expect(init).toMatch(/setSession\(body\.accessToken,[^;]*refreshToken: body\.refreshToken/);
  });
});

// ---------------------------------------------------------------------------------------------

describe("GET /api/auth/config — `tokenRefresh` is additive and flag-gated", () => {
  beforeEach(() => {
    delete process.env.AUTH_ENABLED;
    delete process.env.DB_ENABLED;
    delete process.env.AUTH_TOKEN_REFRESH;
    invalidateMemberships();
  });
  afterEach(() => {
    delete process.env.AUTH_ENABLED;
    delete process.env.AUTH_TOKEN_REFRESH;
  });

  it("flag unset: the body is exactly what it was before", async () => {
    process.env.AUTH_ENABLED = "true";
    const res = await request(app).get("/api/auth/config");
    expect(Object.keys(res.body)).toEqual(["authEnabled", "url", "publishableKey"]);
  });

  it("flag on: one extra field, appended", async () => {
    process.env.AUTH_ENABLED = "true";
    process.env.AUTH_TOKEN_REFRESH = "true";
    const res = await request(app).get("/api/auth/config");
    expect(Object.keys(res.body)).toEqual(["authEnabled", "url", "publishableKey", "tokenRefresh"]);
    expect(res.body.tokenRefresh).toBe(true);
  });

  it("auth off: unchanged regardless of the flag", async () => {
    process.env.AUTH_TOKEN_REFRESH = "true";
    const res = await request(app).get("/api/auth/config");
    expect(res.body).toEqual({ authEnabled: false });
  });
});
