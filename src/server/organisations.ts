import { getServiceClient } from "../db.js";
import { AccessError, invalidateMemberships, isRole, roleAtLeast, type Role } from "./authz.js";
import { LOCAL_USER_ID } from "./auth.js";

/**
 * Organisation membership management — the CRUD behind `/api/organisations/:orgId/members`,
 * plus the bootstrap that gives a brand-new account somewhere to belong.
 *
 * Two invariants are enforced here rather than in the routes, because they are properties of the
 * data and must hold no matter which caller reaches them:
 *
 *   1. **Nobody grants above themselves.** An admin cannot mint an owner. Otherwise every role
 *      below owner is decorative — anyone able to manage members could promote themselves.
 *   2. **An organisation always has at least one owner.** The last owner can be neither demoted
 *      nor removed, or the org becomes permanently unadministrable with no way back.
 */

function requireClient() {
  const client = getServiceClient();
  if (!client) {
    throw new AccessError(
      503,
      "the database is not configured — set DB_ENABLED=true and SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return client;
}

export interface MemberRow {
  userId: string;
  email: string | null;
  role: Role;
  createdAt: string | null;
}

/**
 * How many owners the organisation currently has — the last-owner guard's input.
 *
 * EXCLUDES THE SYNTHETIC LOCAL USER (audit finding M-2). `LOCAL_USER_ID` holds a real `owner` row
 * in the bootstrap organisation and has no `auth.users` record — it is the identity the server
 * attributes work to when AUTH_ENABLED is off, not an account anyone can sign in as. Counting it
 * meant the last-owner guard could be satisfied by an owner who can never log in: with one real
 * owner plus the synthetic one the count read 2, so demoting or removing the real owner was
 * permitted and left an organisation nobody could administer.
 *
 * The guard's question is "would this leave a person able to manage this organisation", so the
 * count has to be of people.
 */
async function ownerCount(orgId: string): Promise<number> {
  const client = requireClient();
  const { data, error } = await client
    .from("organisation_members")
    .select("user_id")
    .eq("organisation_id", orgId)
    .eq("role", "owner");
  if (error) throw new AccessError(500, `could not count owners: ${error.message}`);
  return (data ?? []).filter((r) => (r as { user_id: string }).user_id !== LOCAL_USER_ID).length;
}

/**
 * The synthetic identity is not a member anyone may administer.
 *
 * It is a placeholder for "no authentication is configured", so promoting, demoting or removing it
 * is meaningless — and removing it would silently change what the AUTH_ENABLED=off path attributes
 * historical runs to. Refused explicitly rather than left to the rank checks, which would happily
 * let an owner act on it.
 */
function refuseSyntheticTarget(targetUserId: string): void {
  if (targetUserId === LOCAL_USER_ID) {
    throw new AccessError(
      403,
      "that is the built-in local identity used when authentication is disabled — it cannot be " +
      "given a role, changed or removed",
    );
  }
}

/** Exported as `roleOfMember` below — project membership has to check org membership first. */
async function roleOf(orgId: string, userId: string): Promise<Role | null> {
  const client = requireClient();
  const { data, error } = await client
    .from("organisation_members")
    .select("role")
    .eq("organisation_id", orgId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw new AccessError(500, `could not read membership: ${error.message}`);
  const role = (data as { role?: string } | null)?.role;
  return isRole(role) ? role : null;
}

/**
 * This account's role in this organisation, or null if they aren't a member.
 *
 * Project membership grants visibility, never entry: adding someone to a project only makes sense
 * once they are in the organisation and therefore have a role. The project routes call this to
 * refuse the other case rather than creating a member with visibility but no permissions.
 */
export async function roleOfMember(orgId: string, userId: string): Promise<Role | null> {
  return roleOf(orgId, userId);
}

/** Best-effort address lookup so the members list is readable. Never fails the request. */
async function emailsFor(userIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (userIds.length === 0) return out;
  const client = requireClient();
  try {
    const { data } = await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of data?.users ?? []) out.set(u.id, u.email ?? null);
  } catch (err) {
    console.error("[org] could not resolve member emails:", (err as Error)?.message ?? err);
  }
  return out;
}

export async function listMembers(orgId: string): Promise<MemberRow[]> {
  const client = requireClient();
  const { data, error } = await client
    .from("organisation_members")
    .select("user_id, role, created_at")
    .eq("organisation_id", orgId)
    .order("created_at", { ascending: true });
  if (error) throw new AccessError(500, `could not list members: ${error.message}`);

  const rows = (data ?? []) as { user_id: string; role: string; created_at: string | null }[];
  const emails = await emailsFor(rows.map((r) => r.user_id));

  return rows.filter((r) => isRole(r.role)).map((r) => ({
    userId: r.user_id,
    email: emails.get(r.user_id) ?? null,
    role: r.role as Role,
    createdAt: r.created_at,
  }));
}

/** Resolve an email to a Supabase user id. Returns null when no such account exists. */
export async function findUserByEmail(email: string): Promise<{ id: string; email: string } | null> {
  const client = requireClient();
  const wanted = email.trim().toLowerCase();
  try {
    const { data, error } = await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (error) throw new Error(error.message);
    const found = (data?.users ?? []).find((u) => (u.email ?? "").toLowerCase() === wanted);
    return found ? { id: found.id, email: found.email ?? wanted } : null;
  } catch (err) {
    throw new AccessError(500, `could not look up that account: ${(err as Error)?.message ?? err}`);
  }
}

/** Invariant 1, in one place so every mutation below is covered by it. */
function assertCanGrant(actorRole: Role, targetRole: Role): void {
  if (!roleAtLeast(actorRole, targetRole)) {
    throw new AccessError(403, `you cannot grant the ${targetRole} role — it is above your own`);
  }
}

export async function addMember(
  orgId: string,
  actorRole: Role,
  email: string,
  role: Role,
): Promise<MemberRow> {
  assertCanGrant(actorRole, role);

  const user = await findUserByEmail(email);
  if (!user) {
    throw new AccessError(
      404,
      "no account with that email — they must sign up first, then be added here",
    );
  }
  if (await roleOf(orgId, user.id)) {
    throw new AccessError(409, "that account is already a member of this organisation");
  }

  const client = requireClient();
  const { error } = await client
    .from("organisation_members")
    .insert({ organisation_id: orgId, user_id: user.id, role });
  if (error) throw new AccessError(500, `could not add member: ${error.message}`);

  invalidateMemberships(user.id);
  return { userId: user.id, email: user.email, role, createdAt: null };
}

export async function changeMemberRole(
  orgId: string,
  actorRole: Role,
  actorUserId: string,
  targetUserId: string,
  role: Role,
): Promise<MemberRow> {
  assertCanGrant(actorRole, role);
  refuseSyntheticTarget(targetUserId);

  const current = await roleOf(orgId, targetUserId);
  if (!current) throw new AccessError(404, "that account is not a member of this organisation");

  // You also cannot act *on* someone above you — otherwise an admin could demote an owner to
  // viewer, which is removing an owner by another name.
  if (!roleAtLeast(actorRole, current)) {
    throw new AccessError(403, `you cannot change a member whose role (${current}) is above your own`);
  }
  if (current === "owner" && role !== "owner" && (await ownerCount(orgId)) <= 1) {
    throw new AccessError(409, "this is the last owner — promote someone else to owner first");
  }
  if (targetUserId === actorUserId && current === "owner" && role !== "owner") {
    // Covered by the count check above in the single-owner case; this catches the multi-owner
    // case where self-demotion is legal but worth being deliberate about.
    if ((await ownerCount(orgId)) <= 1) {
      throw new AccessError(409, "you are the last owner and cannot demote yourself");
    }
  }

  const client = requireClient();
  const { error } = await client
    .from("organisation_members")
    .update({ role })
    .eq("organisation_id", orgId)
    .eq("user_id", targetUserId);
  if (error) throw new AccessError(500, `could not change role: ${error.message}`);

  invalidateMemberships(targetUserId);
  const emails = await emailsFor([targetUserId]);
  return { userId: targetUserId, email: emails.get(targetUserId) ?? null, role, createdAt: null };
}

export async function removeMember(
  orgId: string,
  actorRole: Role,
  targetUserId: string,
): Promise<void> {
  refuseSyntheticTarget(targetUserId);
  const current = await roleOf(orgId, targetUserId);
  if (!current) throw new AccessError(404, "that account is not a member of this organisation");
  if (!roleAtLeast(actorRole, current)) {
    throw new AccessError(403, `you cannot remove a member whose role (${current}) is above your own`);
  }
  if (current === "owner" && (await ownerCount(orgId)) <= 1) {
    throw new AccessError(409, "this is the last owner — promote someone else to owner first");
  }

  const client = requireClient();
  const { error } = await client
    .from("organisation_members")
    .delete()
    .eq("organisation_id", orgId)
    .eq("user_id", targetUserId);
  if (error) throw new AccessError(500, `could not remove member: ${error.message}`);

  invalidateMemberships(targetUserId);
}

export interface BootstrapResult {
  organisationId: string;
  organisationName: string;
  role: Role;
  created: boolean;
}

/**
 * Create an organisation with the caller as its owner.
 *
 * ONE STATEMENT, NOT TWO. `create_organisation_with_owner` is a plpgsql function and therefore a
 * single transaction. Doing this as two inserts from here leaves an ownerless organisation behind
 * if the process dies between them — and an ownerless organisation is unreachable forever, because
 * every management route requires an owner or admin membership to act, so nobody could ever add
 * one. The function has existed since `20260825080543_orgs_create_with_owner.sql` and nothing has
 * ever called it; this is its caller.
 */
export async function createOrganisation(userId: string, name: string): Promise<BootstrapResult> {
  const trimmed = name.trim();
  if (!trimmed) throw new AccessError(400, "an organisation needs a name");

  const client = requireClient();
  const { data, error } = await client.rpc("create_organisation_with_owner", {
    p_name: trimmed,
    p_user_id: userId,
  });
  if (error) throw new AccessError(500, `could not create the organisation: ${error.message}`);

  // The function `returns table (id uuid, name text)`, which supabase-js surfaces as an array.
  const row = (Array.isArray(data) ? data[0] : data) as { id?: string; name?: string } | null;
  if (!row?.id) throw new AccessError(500, "the organisation was not created");

  invalidateMemberships(userId);
  return {
    organisationId: row.id,
    organisationName: row.name ?? trimmed,
    role: "owner",
    created: true,
  };
}

/**
 * A readable name for the organisation a new sign-up gets.
 *
 * The local part of their address, not the whole thing: "priya@acme.com" becomes "priya" rather
 * than a workspace whose name is an email. Falls back to a generic label when there is no address
 * at all, which happens for an account created straight in the Supabase dashboard.
 */
function defaultOrgName(email: string | null): string {
  const local = (email ?? "").split("@")[0]?.trim();
  return local ? `${local}'s workspace` : "New workspace";
}

/**
 * Make sure a signed-in account belongs somewhere.
 *
 * **A new account now gets its OWN organisation, as its owner.** That is the whole multi-tenancy
 * change: an organisation is the tenant boundary, so one organisation per owner is what makes two
 * owners' projects invisible to each other. Nothing else in the access model had to move — the org
 * boundary was already enforced by `assertOrgAccess`, by `filterRunsForUser`, and (after the
 * project-scoped policy migration) by RLS. What was missing was any way for a second organisation
 * to come into existence at all.
 *
 * WHAT THIS REPLACES, AND WHY THE OLD BEHAVIOUR WAS ALSO RIGHT ONCE. Until now every sign-up was
 * inserted into one hardcoded organisation (`DEFAULT_ORG_ID`) as `viewer`. That was deliberate and
 * correct for the thing it was built for — one company, where a colleague signing up should land in
 * the company's workspace and not a private empty one. It is exactly wrong for unrelated tenants,
 * where landing in someone else's workspace IS the breach. The trade-off has simply moved:
 *
 *   - one company on one instance  -> colleagues must now be added by an owner after signing up
 *   - many tenants on one instance -> nobody can ever see another tenant's anything
 *
 * The second is what this instance is now for. `addMember` is how the first case is served.
 *
 * OPEN SIGN-UP IS NOW TENANT CREATION. With `SIGNUP_ENABLED` unset (the default is on, and only
 * applies when AUTH_ENABLED is true), anyone who can reach this port can create an account AND an
 * organisation. That was already true of accounts; it is now true of tenants. Set
 * `SIGNUP_ENABLED=false` before exposing this beyond localhost — signup.ts says the same thing and
 * meant it slightly less.
 *
 * Idempotent by design: the frontend calls it after every sign-in, not just after sign-up, so an
 * account created directly in the Supabase dashboard (which never touches this server) still ends
 * up with a home rather than a working login that can do nothing. An account that already belongs
 * somewhere gets its existing membership back and no second organisation is minted.
 */
export async function bootstrapUser(userId: string, email: string | null): Promise<BootstrapResult> {
  const client = requireClient();

  const { data: existing, error: readErr } = await client
    .from("organisation_members")
    .select("organisation_id, role, organisations(name)")
    .eq("user_id", userId)
    .order("created_at", { ascending: true })
    .limit(1);
  if (readErr) throw new AccessError(500, `could not read membership: ${readErr.message}`);

  const first = (existing ?? [])[0] as
    | { organisation_id: string; role: string; organisations?: { name?: string } | { name?: string }[] }
    | undefined;

  if (first && isRole(first.role)) {
    const orgs = first.organisations;
    const name = (Array.isArray(orgs) ? orgs[0]?.name : orgs?.name) ?? "Organisation";
    return { organisationId: first.organisation_id, organisationName: name, role: first.role, created: false };
  }

  return createOrganisation(userId, defaultOrgName(email));
}
