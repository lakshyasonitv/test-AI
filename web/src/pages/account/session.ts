/**
 * The signed-in session, written exactly the way the classic UI (public/app.js) writes it, so a
 * sign-in in either UI signs in both:
 *
 *  - localStorage "testbench.session" = { token, email } — or, only while the server reports
 *    `tokenRefresh` (AUTH_TOKEN_REFRESH), { token, email, refreshToken, expiresAt }.
 *  - the `sb-access-token` cookie (path=/, SameSite=Strict), which <img>/<video> requests carry.
 *
 * Supabase is reached with plain fetch to its REST endpoints, the same dependency-free approach as
 * app.js (no supabase-js). A password is only ever put in the body of the sign-in request; nothing
 * here logs or stores it.
 */

const AUTH_STORAGE_KEY = "testbench.session";
const ADMIN_ORG_KEY = "tb-admin-org";
/** Renew this many seconds before the access token expires (app.js TOKEN_REFRESH_MARGIN_S). */
const TOKEN_REFRESH_MARGIN_S = 60;

export interface AuthConfig {
  authEnabled: boolean;
  url?: string | null;
  publishableKey?: string | null;
  tokenRefresh?: boolean;
}

interface Stored { token?: string; email?: string | null; refreshToken?: string; expiresAt?: number }

const state = {
  config: null as AuthConfig | null,
  token: null as string | null,
  email: null as string | null,
  refreshToken: null as string | null,
  expiresAt: null as number | null,
};

function readStored(): Stored | null {
  try { return JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null"); } catch { return null; }
}

// Restore synchronously, as app.js does at load.
(() => {
  const saved = readStored();
  if (saved && saved.token) {
    state.token = saved.token;
    state.email = saved.email || null;
    state.refreshToken = saved.refreshToken || null;
    state.expiresAt = saved.expiresAt || null;
    writeSessionCookie(saved.token);
  }
})();

export const currentToken = (): string | null => state.token;
export const currentEmail = (): string | null => state.email;
export const authConfig = (): AuthConfig | null => state.config;

/** The organisation a platform admin picked (D-84), remembered for this tab like app.js. */
export function adminOrgId(): string | null {
  try { return sessionStorage.getItem(ADMIN_ORG_KEY); } catch { return null; }
}
export function setAdminOrgId(orgId: string | null): void {
  try { if (orgId) sessionStorage.setItem(ADMIN_ORG_KEY, orgId); else sessionStorage.removeItem(ADMIN_ORG_KEY); } catch { /* storage blocked */ }
}

export function writeSessionCookie(token: string | null): void {
  document.cookie = token
    ? `sb-access-token=${encodeURIComponent(token)}; path=/; SameSite=Strict`
    : "sb-access-token=; path=/; Max-Age=0; SameSite=Strict";
}

/** The `exp` claim of a JWT, in epoch seconds, or null (sign-up's response carries no expiry). */
function jwtExpiry(token: string): number | null {
  try {
    const part = String(token).split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const exp = JSON.parse(atob(part + "===".slice((part.length + 3) % 4))).exp;
    return typeof exp === "number" ? exp : null;
  } catch {
    return null;
  }
}

/** app.js setSession: same stored shape, same cookie, same refresh scheduling. */
export function setSession(token: string | null, email: string | null,
  refresh?: { refreshToken?: string | null; expiresAt?: number | null }): void {
  state.token = token || null;
  state.email = email || null;
  const renewable = !!(token && state.config?.tokenRefresh && refresh && refresh.refreshToken);
  state.refreshToken = renewable ? refresh!.refreshToken! : null;
  state.expiresAt = renewable ? (refresh!.expiresAt || jwtExpiry(token!)) : null;
  if (token) {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(renewable
      ? { token, email: state.email, refreshToken: state.refreshToken, expiresAt: state.expiresAt }
      : { token, email: state.email }));
  } else {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  }
  writeSessionCookie(token);
  scheduleTokenRefresh();
}

// ------------------------------------------------------------------ token refresh (TD-108)

let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let refreshInFlight: Promise<boolean> | null = null;

function tokenNeedsRefresh(): boolean {
  return !!(state.config?.tokenRefresh && state.token && state.refreshToken && state.expiresAt
    && state.expiresAt - Date.now() / 1000 <= TOKEN_REFRESH_MARGIN_S);
}

function scheduleTokenRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  if (!state.config?.tokenRefresh || !state.token || !state.refreshToken || !state.expiresAt) return;
  const delayMs = Math.max(0, (state.expiresAt - TOKEN_REFRESH_MARGIN_S) * 1000 - Date.now());
  refreshTimer = setTimeout(() => { void refreshSession(); }, delayMs);
}

/** Take over a session another tab (either UI) wrote, if it is the same account's newer one. */
function adoptStoredSession(): boolean {
  const saved = readStored();
  if (!saved || !saved.token || !saved.refreshToken || saved.token === state.token) return false;
  if ((saved.email || null) !== (state.email || null)) return false;
  if (!saved.expiresAt || saved.expiresAt <= (state.expiresAt || 0)) return false;
  state.token = saved.token;
  state.refreshToken = saved.refreshToken;
  state.expiresAt = saved.expiresAt;
  writeSessionCookie(saved.token);
  scheduleTokenRefresh();
  return true;
}

/**
 * Renew the access token; true if this tab now holds a fresh one. A failure changes nothing (the
 * caller keeps its 401), exactly as app.js. Serialised across tabs with the same Web Lock name
 * app.js uses, so the two UIs never spend one single-use refresh token twice.
 */
export function refreshSession(): Promise<boolean> {
  const cfg = state.config;
  if (!cfg?.tokenRefresh || !state.refreshToken || !cfg.url || !cfg.publishableKey) return Promise.resolve(false);
  if (refreshInFlight) return refreshInFlight;

  const attempt = async (): Promise<boolean> => {
    if (adoptStoredSession()) return true;
    const spent = state.refreshToken;
    const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", apikey: String(cfg.publishableKey) },
      body: JSON.stringify({ refresh_token: spent }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token || !body.refresh_token) return false;
    if (state.refreshToken !== spent) return false;
    setSession(body.access_token, state.email, { refreshToken: body.refresh_token, expiresAt: body.expires_at });
    return true;
  };

  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  const run: Promise<boolean> = locks
    ? locks.request("testbench-token-refresh", attempt).then((v) => v)
    : attempt();
  const p = run.catch(() => false).finally(() => { refreshInFlight = null; });
  refreshInFlight = p;
  return p;
}

function refreshIfStale(): void { if (tokenNeedsRefresh()) void refreshSession(); }

// ------------------------------------------------------------------ auth config (initAuth)

let configPromise: Promise<AuthConfig> | null = null;

/**
 * GET /api/auth/config once per page load (retried 1 s, 2 s, 4 s like app.js), then — only when the
 * server reports tokenRefresh — the wake-up / other-tab listeners and the refresh timer, and a
 * renewal first if the restored token is already stale. Safe to call from every page.
 */
export function ensureAuth(): Promise<AuthConfig> {
  if (configPromise) return configPromise;
  configPromise = (async () => {
    let cfg: AuthConfig | undefined;
    for (const wait of [0, 1000, 2000, 4000]) {
      if (wait) await new Promise((r) => setTimeout(r, wait));
      try {
        const r = await fetch("/api/auth/config");
        if (!r.ok) throw new Error(String(r.status));
        cfg = await r.json();
        break;
      } catch { cfg = undefined; }
    }
    if (cfg === undefined) { configPromise = null; throw new Error("The server cannot be reached."); }
    state.config = cfg ?? { authEnabled: false };
    if (!state.config.authEnabled) return state.config;
    if (state.config.tokenRefresh === true) {
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshIfStale(); });
      window.addEventListener("focus", refreshIfStale);
      window.addEventListener("storage", (e) => { if (e.key === AUTH_STORAGE_KEY) adoptStoredSession(); });
      if (tokenNeedsRefresh()) await refreshSession();
      scheduleTokenRefresh();
    }
    return state.config;
  })();
  return configPromise;
}

// ------------------------------------------------------------------ requests

/**
 * fetch for these pages, with what app.js's fetch wrapper adds: the Bearer token, the admin's
 * picked organisation as x-organisation-id, and (token refresh on) one renew-and-retry on a 401.
 * Same-origin paths only.
 */
export async function acctFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const sentToken = state.token;
  if (sentToken && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${sentToken}`);
  const org = adminOrgId();
  if (sentToken && org && !headers.has("x-organisation-id")) headers.set("x-organisation-id", org);
  const res = await fetch(path, { ...init, headers });
  const body = init.body;
  const replayable = body === undefined || body === null || typeof body === "string";
  if (res.status !== 401 || !sentToken || !state.config?.tokenRefresh || !replayable) return res;
  const renewed = state.token !== sentToken || await refreshSession();
  if (!renewed || !state.token) return res;
  headers.set("Authorization", `Bearer ${state.token}`);
  return fetch(path, { ...init, headers });
}

/** JSON helper over acctFetch: throws the server's own `error` message, like app.js's api(). */
export async function acctJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await acctFetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `That didn't work (${res.status}).`);
  return body as T;
}

export const jsonBody = (method: string, payload: unknown): RequestInit =>
  ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });

// ------------------------------------------------------------------ sign-out

let pendingLoginMessage: string | null = null;
/** A message for the next sign-in screen (app.js sessionRejected), read once. */
export function takeLoginMessage(): string | null {
  const m = pendingLoginMessage;
  pendingLoginMessage = null;
  return m;
}

export const SIGNED_OUT_EVENT = "testbench:signed-out";

/**
 * app.js signOut: forget the picked organisation, clear the stored session and cookie, then a
 * best-effort revoke at Supabase. Dispatches SIGNED_OUT_EVENT on window so the shell can show the
 * sign-in screen. `message` (app.js sessionRejected) is shown by the next LoginPage.
 */
export async function signOutSession(message?: string): Promise<void> {
  const cfg = state.config;
  const token = state.token;
  setAdminOrgId(null);
  setSession(null, null);
  if (message) pendingLoginMessage = message;
  if (cfg?.url && cfg.publishableKey && token) {
    fetch(`${cfg.url}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: String(cfg.publishableKey), Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
}
