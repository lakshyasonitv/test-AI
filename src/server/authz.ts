import type { Request, Response, NextFunction } from "express";
import { getServiceClient, isDbEnabled, DEFAULT_ORG_ID, fetchRunOrgIds } from "../db.js";
import { LOCAL_USER_ID, isAuthEnabled } from "./auth.js";

/**
 * Tenancy and roles — implentationplan.md Step 3.4, plus the role-enforcement half of Step 5.4.
 *
 * Authentication (Step 2.1, auth.ts) answers "who are you". This file answers "what may you do",
 * and the plan states the rule it exists to enforce in one sentence:
 *
 *   "Every read joins through membership. Never filter by an org id taken from the request body —
 *    take the user from the session, and let the join prove the org is theirs."
 *
 * So nothing here ever trusts a caller-supplied organisation id as evidence of access. An org id
 * from a URL is only ever the *subject* of a check, never its authority: the membership row —
 * looked up by the session's user id — is what grants anything.
 */

export const ROLES = ["viewer", "editor", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

/** Lowest to highest. A check is "your rank >= the required rank", never string equality — the
 *  point of a ladder is that an owner automatically satisfies every lesser requirement. */
const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export function isRole(value: unknown): value is Role {
  return typeof value === "string" && (ROLES as readonly string[]).includes(value);
}

export function roleRank(role: Role): number {
  return ROLE_RANK[role];
}

export function roleAtLeast(actual: Role, required: Role): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export interface Membership {
  organisationId: string;
  role: Role;
}

/** Thrown by assertOrgAccess. Carries the status the route should return. */
export class AccessError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "AccessError";
  }
}

/**
 * The synthetic single-user identity is owner of the bootstrap organisation.
 *
 * This is Rule 4 made concrete: with AUTH_ENABLED off we do not *skip* authorization, we satisfy
 * it — the local user genuinely is an owner, so every check below runs its normal code path and
 * passes. There is no `if (authDisabled) return true` sprinkled through the route handlers, which
 * is exactly the kind of branch that later leaks when a second account appears.
 *
 * It also means the flag-off path needs no database at all: this is answered from memory.
 */
const LOCAL_MEMBERSHIPS: Membership[] = [{ organisationId: DEFAULT_ORG_ID, role: "owner" }];

/**
 * Membership lookups are cached for a few seconds.
 *
 * `GET /api/runs` is polled by the UI every couple of seconds, and an uncached lookup would mean a
 * database round-trip per poll purely to re-derive an answer that almost never changes. The cost
 * is bounded staleness: a role change takes effect within CACHE_TTL_MS. That window is closed for
 * the case that actually matters — the member-management routes call `invalidateMemberships()`
 * directly, so an admin demoting someone takes effect immediately rather than eventually.
 */
const CACHE_TTL_MS = 5_000;
const membershipCache = new Map<string, { at: number; memberships: Membership[] }>();

export function invalidateMemberships(userId?: string): void {
  if (userId) membershipCache.delete(userId);
  else membershipCache.clear();
}

let warnedNoDb = false;

/**
 * True when organisation-scoped authorization can actually be decided.
 *
 * Tenancy needs the database: membership lives there and nowhere else. With auth on but the
 * database off there is no way to tell one user's runs from another's, so rather than inventing an
 * answer we fall back to Phase 2's behaviour (authenticated = permitted) and say so loudly. That
 * combination is a misconfiguration, not a supported mode.
 */
export function canEnforceTenancy(): boolean {
  if (!isAuthEnabled()) return false;      // synthetic owner; nothing to enforce against
  if (!isDbEnabled()) {
    if (!warnedNoDb) {
      warnedNoDb = true;
      console.error(
        "[authz] AUTH_ENABLED=true but DB_ENABLED is not set. Membership lives in the database, " +
        "so roles and organisation isolation CANNOT be enforced — every signed-in user can see " +
        "and do everything. Set DB_ENABLED=true (and SUPABASE_SERVICE_ROLE_KEY) before a second " +
        "account exists.",
      );
    }
    return false;
  }
  return true;
}

/** Every organisation this user belongs to, with their role in each. */
export async function getMemberships(userId: string): Promise<Membership[]> {
  if (!canEnforceTenancy()) return LOCAL_MEMBERSHIPS;

  const cached = membershipCache.get(userId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.memberships;

  const client = getServiceClient();
  if (!client) return [];

  const { data, error } = await client
    .from("organisation_members")
    .select("organisation_id, role")
    .eq("user_id", userId);

  if (error) {
    // Fail closed. An unreadable membership table means "we do not know what you may do", and the
    // safe answer to that is nothing — not everything.
    console.error(`[authz] membership lookup failed for ${userId}:`, error.message);
    return [];
  }

  const memberships: Membership[] = (data ?? [])
    .filter((r: { role: string }) => isRole(r.role))
    .map((r: { organisation_id: string; role: string }) => ({
      organisationId: r.organisation_id,
      role: r.role as Role,
    }));

  membershipCache.set(userId, { at: Date.now(), memberships });
  return memberships;
}

/**
 * The organisation a new run belongs to. A user with several gets their oldest — deterministic,
 * and the one they were bootstrapped into.
 */
export async function primaryOrgFor(userId: string): Promise<string | null> {
  const memberships = await getMemberships(userId);
  return memberships[0]?.organisationId ?? null;
}

/**
 * THE authorization helper. Every route and the artifact guard goes through this one function.
 *
 * Note the shape: the caller passes the org id it wants to act on, and this proves the caller is
 * entitled to it by joining through membership on the *session's* user id. Passing a different org
 * id can only ever narrow what you get — never widen it — because the join is what grants, not the
 * argument.
 */
export async function assertOrgAccess(
  userId: string,
  organisationId: string,
  minRole: Role = "viewer",
): Promise<Role> {
  if (!canEnforceTenancy()) return "owner";

  const memberships = await getMemberships(userId);
  const found = memberships.find((m) => m.organisationId === organisationId);

  if (!found) {
    // 404-shaped information leaks are not a concern here: 403 for both "not a member" and
    // "insufficient role" keeps the two indistinguishable to a prober.
    throw new AccessError(403, "you do not have access to this organisation");
  }
  if (!roleAtLeast(found.role, minRole)) {
    throw new AccessError(403, `this action requires the ${minRole} role or higher`);
  }
  return found.role;
}

/** The organisation that owns a run, or null when the database has never heard of it. */
export async function orgForRun(runId: string): Promise<string | null> {
  const map = await fetchRunOrgIds([runId]);
  return map?.get(runId) ?? null;
}

// ---------------------------------------------------------------------------
// Express middleware
//
// Three of them rather than one clever one, because the *subject* of the check differs by route
// and making that explicit at each mount point is what stops a new route silently defaulting to
// the weakest interpretation.
// ---------------------------------------------------------------------------

function userIdOf(req: Request): string {
  return req.user?.id ?? LOCAL_USER_ID;
}

function deny(res: Response, err: unknown): void {
  if (err instanceof AccessError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error("[authz] authorization check failed:", (err as Error)?.message ?? err);
  res.status(500).json({ error: "authorization check failed" });
}

/**
 * For routes not scoped to a specific organisation — the caller acts within their own.
 * `req.organisationId` is set for the handler, so a handler never has to re-derive it (and so it
 * can never derive a *different* one from the request body).
 */
export function requireRole(minRole: Role) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = userIdOf(req);
      const orgId = await primaryOrgFor(userId);
      if (!orgId) {
        throw new AccessError(
          403,
          "your account is not a member of any organisation yet — POST /api/auth/bootstrap first",
        );
      }
      req.organisationId = orgId;
      req.organisationRole = await assertOrgAccess(userId, orgId, minRole);
      next();
    } catch (err) {
      deny(res, err);
    }
  };
}

/**
 * For `/api/runs/:runId/*` and artifact access — the subject is whichever organisation owns
 * that run.
 */
export function requireRunRole(minRole: Role) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = userIdOf(req);
      if (!canEnforceTenancy()) {
        req.organisationRole = "owner";
        next();
        return;
      }
      const orgId = await orgForRun(req.params.runId);
      if (!orgId) {
        // Fail closed. A run with no ownership record is a run nobody can prove they own, and
        // guessing "probably yours" is how a second tenant reads the first tenant's screenshots.
        throw new AccessError(403, "you do not have access to this run");
      }
      req.organisationId = orgId;
      req.organisationRole = await assertOrgAccess(userId, orgId, minRole);
      next();
    } catch (err) {
      deny(res, err);
    }
  };
}

/** For `/api/organisations/:orgId/*` — the subject is the org named in the path. */
export function requireOrgRole(minRole: Role) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const userId = userIdOf(req);
      req.organisationId = req.params.orgId;
      req.organisationRole = await assertOrgAccess(userId, req.params.orgId, minRole);
      next();
    } catch (err) {
      deny(res, err);
    }
  };
}

/**
 * Filter a disk-derived run list down to what this user may see.
 *
 * Disk stays authoritative for the *content* of the list (flipping that is Step 3.3) — this only
 * removes rows. The response shape is untouched, which is what keeps `public/app.js` and the
 * Phase 0 contract tests working unchanged.
 */
export async function filterRunsForUser<T extends { runId: string }>(
  userId: string,
  runs: T[],
): Promise<T[]> {
  if (!canEnforceTenancy()) return runs;

  const memberships = await getMemberships(userId);
  if (memberships.length === 0) return [];
  const allowed = new Set(memberships.map((m) => m.organisationId));

  const owners = await fetchRunOrgIds(runs.map((r) => r.runId));
  if (owners === null) {
    // Database unreachable while tenancy is meant to be enforced. Fail closed: showing the full
    // list "just this once" is showing every tenant's history to whoever is signed in.
    console.error("[authz] could not resolve run ownership; returning an empty history");
    return [];
  }

  return runs.filter((r) => {
    const org = owners.get(r.runId);
    return org !== undefined && allowed.has(org);
  });
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by the requireRole family — the organisation this request acts within. */
      organisationId?: string;
      /** Set by the requireRole family — the caller's role in that organisation. */
      organisationRole?: Role;
    }
  }
}
