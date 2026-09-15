import type { Request, Response, NextFunction } from "express";
import { getServiceClient, isDbEnabled, DEFAULT_ORG_ID, fetchRunOrgIds, fetchRunScopes } from "../db.js";
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

/**
 * `tester` is the person who drives a run — talks to the AI, answers the credential prompt, and
 * picks cases at the selection gate. It was called `editor` until the role names were made to
 * describe the job rather than the permission; the rank, the meaning and every gate are unchanged.
 */
export const ROLES = ["viewer", "tester", "admin", "owner"] as const;
export type Role = (typeof ROLES)[number];

/** Lowest to highest. A check is "your rank >= the required rank", never string equality — the
 *  point of a ladder is that an owner automatically satisfies every lesser requirement. */
const ROLE_RANK: Record<Role, number> = { viewer: 1, tester: 2, admin: 3, owner: 4 };

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

  // ORDERED, because primaryOrgFor takes [0] and every non-run-scoped route acts in whatever it
  // returns. Unordered, Postgres is free to hand back rows in any order it likes — so a user in two
  // organisations could create a project in one and then not find it, having been silently switched
  // to the other between requests. With one organisation this could not be observed, which is why
  // it survived. created_at first (the oldest membership is the one they were bootstrapped into);
  // organisation_id as a tiebreak, because two memberships written in the same transaction share a
  // timestamp and `created_at` alone would leave those two free to swap.
  const { data, error } = await client
    .from("organisation_members")
    .select("organisation_id, role, created_at")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .order("organisation_id", { ascending: true });

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
 *
 * That claim is now true. It was written before `getMemberships` ordered anything, so "oldest" and
 * "deterministic" were both aspirations; see the ordering comment there. It remains a placeholder
 * for a real organisation switcher — a user who belongs to two organisations still acts in one of
 * them with no way to say which, they just now do so predictably.
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
      const scope = (await fetchRunScopes([req.params.runId]))?.get(req.params.runId);
      if (!scope) {
        // Fail closed. A run with no ownership record is a run nobody can prove they own, and
        // guessing "probably yours" is how a second tenant reads the first tenant's screenshots.
        throw new AccessError(403, "you do not have access to this run");
      }
      req.organisationId = scope.organisationId;
      const role = await assertOrgAccess(userId, scope.organisationId, minRole);

      // Project visibility too (Step 5.1), not just the org. Otherwise the run list and the
      // artifact route would hide a run that this endpoint still served in full to anyone who
      // knew — or guessed — its id, which would make the project boundary decorative.
      const allowed = await visibleProjectIds(userId, scope.organisationId, role);
      if (allowed && (scope.projectId === null || !allowed.has(scope.projectId))) {
        throw new AccessError(403, "you have not been added to this run's project");
      }

      req.organisationRole = role;
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
 * Which projects this user may SEE within an organisation, or `null` meaning "no restriction".
 *
 * The second axis of the model (Step 5.1). The org role above answers "what may you do"; this
 * answers "what may you look at". They are deliberately separate — `project_members` has no role
 * column, because duplicating the ladder per project would make two places answer the same
 * question and guarantee they drift.
 *
 * `null` for admin/owner rather than a materialised list of every id: their answer is a property
 * of their role, not a set that could go stale between the check and the query.
 *
 * Lives here rather than in projects.ts because it is an authorization question and because
 * `filterRunsForUser` below needs it — putting it there would make the two modules import each
 * other.
 */
export async function visibleProjectIds(
  userId: string,
  orgId: string,
  role: Role,
): Promise<Set<string> | null> {
  if (roleAtLeast(role, "admin")) return null;

  const client = getServiceClient();
  if (!client) return new Set();

  const { data, error } = await client
    .from("project_members")
    .select("project_id, projects!inner(organisation_id)")
    .eq("user_id", userId)
    .eq("projects.organisation_id", orgId);

  if (error) {
    // Fail closed: "we cannot tell which projects you may see" must mean none, never all.
    console.error(`[authz] project visibility lookup failed for ${userId}:`, error.message);
    return new Set();
  }
  return new Set((data ?? []).map((r) => (r as { project_id: string }).project_id));
}

/**
 * Filter a disk-derived run list down to what this user may see.
 *
 * Two gates now, in order: the run's organisation must be one of theirs (Step 3.4), AND — unless
 * they are an admin or owner — its project must be one they have been assigned to (Step 5.1). A
 * viewer with no project assignments therefore sees an empty history, which is the whole point of
 * the model the user asked for.
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
  const allowedOrgs = new Set(memberships.map((m) => m.organisationId));

  const scopes = await fetchRunScopes(runs.map((r) => r.runId));
  if (scopes === null) {
    // Database unreachable while tenancy is meant to be enforced. Fail closed: showing the full
    // list "just this once" is showing every tenant's history to whoever is signed in.
    console.error("[authz] could not resolve run ownership; returning an empty history");
    return [];
  }

  // One project-visibility lookup per organisation involved, not per run.
  const projectScopes = new Map<string, Set<string> | null>();
  for (const m of memberships) {
    projectScopes.set(m.organisationId, await visibleProjectIds(userId, m.organisationId, m.role));
  }

  return runs.filter((r) => {
    const scope = scopes.get(r.runId);
    if (!scope || !allowedOrgs.has(scope.organisationId)) return false;

    const allowedProjects = projectScopes.get(scope.organisationId);
    if (allowedProjects === null || allowedProjects === undefined) return true; // admin/owner
    // A run with no project can only be seen by admin+ — nobody can be assigned to "no project",
    // so treating it as visible would be a hole that widens as unfiled runs accumulate.
    return scope.projectId !== null && allowedProjects.has(scope.projectId);
  });
}

/**
 * May this user see this one run? The artifact guard's question.
 *
 * Same two gates as filterRunsForUser, for a single run — screenshots and videos are fetched by
 * `<img>`/`<video>` tags that bypass every check the frontend does, so this must not be a weaker
 * test than the list is.
 */
export async function canViewRun(userId: string, runId: string): Promise<boolean> {
  if (!canEnforceTenancy()) return true;

  const scopes = await fetchRunScopes([runId]);
  const scope = scopes?.get(runId);
  // Fail closed: a run with no ownership record is one nobody can prove they own.
  if (!scope) return false;

  try {
    const role = await assertOrgAccess(userId, scope.organisationId, "viewer");
    const allowed = await visibleProjectIds(userId, scope.organisationId, role);
    if (allowed === null) return true;
    return scope.projectId !== null && allowed.has(scope.projectId);
  } catch {
    return false;
  }
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
