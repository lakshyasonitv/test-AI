import type { Request, Response, NextFunction } from "express";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Identity, behind AUTH_ENABLED (default off) — implentationplan.md Step 2.1.
 *
 * The design rule this file exists to enforce is Rule 4: **bootstrap a synthetic owner, don't
 * special-case "no user"**. When AUTH_ENABLED is off we do NOT skip the middleware or leave
 * `req.user` undefined — we inject a fixed synthetic user. That way every downstream code path
 * (and every future tenancy join) can assume `req.user` exists from day one, instead of growing
 * `if (!user)` branches, which is where tenancy leaks come from once a second account exists.
 *
 * So single-user mode is just multi-user mode with exactly one member, not a separate mode.
 */

/**
 * The synthetic single-user identity used whenever AUTH_ENABLED is off.
 *
 * This UUID is deliberately fixed and shared: Phase 3's bootstrap migration inserts it as the
 * owner of the "Default" organisation, so pre-existing runs backfilled into the database are
 * owned by the same id this server attributes new runs to. If it changes, that link breaks and
 * every historical run becomes orphaned — hence one constant, imported by both, never re-typed.
 */
export const LOCAL_USER_ID = "00000000-0000-4000-8000-000000000001";

export interface AuthUser {
  id: string;
  email: string | null;
  /** True for the AUTH_ENABLED=off placeholder, false for a real Supabase session. */
  synthetic: boolean;
}

export const LOCAL_USER: AuthUser = {
  id: LOCAL_USER_ID,
  email: null,
  synthetic: true,
};

/** Single source of truth for the flag, so no route re-reads process.env with its own spelling. */
export function isAuthEnabled(): boolean {
  return process.env.AUTH_ENABLED === "true";
}

// The client is built lazily and cached: reading env at module load would bake in whatever was
// set at import time, which breaks tests that toggle AUTH_ENABLED per-case.
let cachedClient: SupabaseClient | null = null;
let cachedClientKey = "";

function getAuthClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  // The publishable/anon key is enough to VERIFY a token (auth.getUser calls Supabase's
  // /auth/v1/user with the caller's JWT). No service-role secret is needed to authenticate
  // someone — only to bypass RLS, which this file never does.
  const key = process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !key) return null;

  const cacheKey = `${url}::${key}`;
  if (cachedClient && cachedClientKey === cacheKey) return cachedClient;

  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  cachedClientKey = cacheKey;
  return cachedClient;
}

/**
 * Pull the access token off a request.
 *
 * Two sources, because the browser can only supply one of them per request type:
 *   - `Authorization: Bearer <jwt>` — what `fetch()` in app.js sends for /api/* calls.
 *   - the `sb-access-token` cookie — what an `<img src>` / `<video src>` sends, since a plain
 *     asset request carries no headers we control. The artifact route (/runs/:runId/*) is served
 *     into exactly those tags, so without the cookie path every screenshot and video would 401
 *     the moment AUTH_ENABLED was switched on.
 */
function extractToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith("Bearer ")) {
    const token = header.slice("Bearer ".length).trim();
    if (token) return token;
  }

  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== "sb-access-token") continue;
    const value = decodeURIComponent(part.slice(eq + 1).trim());
    if (value) return value;
  }
  return null;
}

/**
 * Resolve the caller's identity, or null if they aren't authenticated.
 *
 * With the flag off this always succeeds with LOCAL_USER — never null — which is what lets
 * callers treat "no identity" as a genuine auth failure rather than "auth is disabled".
 */
export async function resolveUser(req: Request): Promise<AuthUser | null> {
  if (!isAuthEnabled()) return LOCAL_USER;

  const token = extractToken(req);
  if (!token) return null;

  const client = getAuthClient();
  if (!client) {
    // Misconfiguration, not a rejected credential: the operator turned auth on without pointing
    // it at a project. Say so loudly rather than silently 401ing every request forever.
    console.error(
      "[auth] AUTH_ENABLED=true but SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY are not set — " +
      "every request will be rejected until they are.",
    );
    return null;
  }

  try {
    const { data, error } = await client.auth.getUser(token);
    if (error || !data?.user) return null;
    return { id: data.user.id, email: data.user.email ?? null, synthetic: false };
  } catch (err) {
    console.error("[auth] token verification failed:", (err as Error)?.message ?? err);
    return null;
  }
}

/**
 * Express middleware. Guarantees `req.user` is set for everything downstream, or 401s.
 *
 * With AUTH_ENABLED off this is a pass-through that costs one object assignment — no network
 * call, no Supabase client construction, no behavior change of any kind. That is what makes
 * Phase 0's contract tests pass unchanged, which is the step's own stated proof.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const user = await resolveUser(req);
  if (!user) {
    res.status(401).json({ error: "authentication required" });
    return;
  }
  req.user = user;
  next();
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}
