import { acctFetch, ensureAuth, signOutSession, currentToken, SIGNED_OUT_EVENT } from "./session";

/**
 * Who is signed in, the way app.js's refreshIdentity learns it: POST /api/auth/bootstrap (so an
 * account made in the Supabase dashboard gets an organisation), then GET /api/auth/me. Used only to
 * decide what is drawn; every action is enforced on the server regardless.
 */
export interface Identity {
  authRequired: boolean;
  role: string | null;
  organisationId: string | null;
  organisationName: string | null;
  userId: string | null;
  email: string | null;
  platformAdmin: boolean;
}

export interface Health {
  platformAdmins: boolean;
  defaults: { gateReview: boolean; selfHeal: boolean };
}

/** Role ladder mirrored from src/server/authz.ts (app.js ROLE_RANK). */
const ROLE_RANK: Record<string, number> = { viewer: 1, tester: 2, admin: 3, owner: 4 };
export const roleAtLeast = (actual: string | null | undefined, required: string): boolean =>
  (ROLE_RANK[actual ?? ""] || 0) >= (ROLE_RANK[required] || 0);
/** Lowest to highest — the same order as ROLES in src/server/authz.ts. */
export const ROLES_ASC = ["viewer", "tester", "admin", "owner"] as const;

let healthPromise: Promise<Health> | null = null;
/** GET /api/health once: `platformAdmins` (D-84) and the run-option `defaults` (TD-83). */
export function loadHealth(): Promise<Health> {
  if (!healthPromise) {
    healthPromise = fetch("/api/health")
      .then((r) => r.json())
      .then((h) => ({
        platformAdmins: h?.platformAdmins === true,
        defaults: { gateReview: h?.defaults?.gateReview === true, selfHeal: h?.defaults?.selfHeal === true },
      }))
      .catch(() => ({ platformAdmins: false, defaults: { gateReview: false, selfHeal: false } }));
  }
  return healthPromise;
}

const NONE: Omit<Identity, "authRequired"> = {
  role: null, organisationId: null, organisationName: null, userId: null, email: null, platformAdmin: false,
};

export class SessionRejected extends Error {}

let identityPromise: Promise<Identity> | null = null;

/**
 * The current identity, cached for the page load; `force` asks again (after a sign-in, or after a
 * Team change that may have changed our own role). A session the server refuses (401), or an
 * account in no organisation under the platform model, is signed out with app.js's own message
 * and rejects with SessionRejected.
 */
export function loadIdentity(force = false): Promise<Identity> {
  if (identityPromise && !force) return identityPromise;
  identityPromise = (async () => {
    const cfg = await ensureAuth();
    if (!cfg.authEnabled || !currentToken()) return { authRequired: !!cfg.authEnabled, ...NONE };
    try {
      await acctFetch("/api/auth/bootstrap", { method: "POST" });
      const meRes = await acctFetch("/api/auth/me");
      if (meRes.status === 401) {
        await signOutSession("Your session has ended. Please sign in again.");
        throw new SessionRejected("Your session has ended. Please sign in again.");
      }
      const me = meRes.ok ? await meRes.json() : null;
      if (!me) return { authRequired: true, ...NONE };
      const platformModel = (await loadHealth()).platformAdmins;
      const id: Identity = {
        authRequired: true,
        role: me.role || null,
        organisationId: me.organisationId || null,
        organisationName: me.organisationName || null,
        userId: me.userId || null,
        email: me.email || null,
        platformAdmin: me.platformAdmin === true,
      };
      if (platformModel && me.tenancyEnforced && !id.organisationId && !id.platformAdmin) {
        const msg = "Your account isn't part of an organisation yet. Ask your owner or admin to add you.";
        await signOutSession(msg);
        throw new SessionRejected(msg);
      }
      return id;
    } catch (err) {
      if (err instanceof SessionRejected) { identityPromise = null; throw err; }
      // Non-fatal, as in app.js: an unknown role restricts nothing; the server still enforces.
      return { authRequired: true, ...NONE };
    }
  })();
  return identityPromise;
}

/** Forget the cached identity (sign-out). */
export function clearIdentity(): void { identityPromise = null; }
window.addEventListener(SIGNED_OUT_EVENT, clearIdentity);

/** Sign out: clear the session and cookie, revoke at Supabase (best effort). The caller redraws. */
export async function signOut(): Promise<void> {
  clearIdentity();
  await signOutSession();
}

/** app.js shortProjectName: a project name without scheme/www/trailing slash; Salesforce hosts shortened. */
export function shortProjectName(name: unknown): string {
  const n = String(name ?? "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  const sf = /^([a-z0-9-]+?)(?:-dev-ed)?\.(?:(scratch|sandbox|develop|trailblaze)\.)?(my\.salesforce(?:-setup)?\.com|lightning\.force\.com|my\.site\.com)$/i.exec(n);
  if (!sf) return n || String(name ?? "");
  if (/^my\.site\.com$/i.test(sf[3])) return `${sf[1]} (site)`;
  const kind = ({ scratch: "scratch org", sandbox: "sandbox", develop: "dev org", trailblaze: "playground" } as Record<string, string>)[(sf[2] ?? "").toLowerCase()];
  return kind ? `${sf[1]} (${kind})` : sf[1];
}

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
