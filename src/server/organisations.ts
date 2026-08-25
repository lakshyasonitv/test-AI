import { getServiceClient } from "../db.js";
import { AccessError, invalidateMemberships, isRole, roleAtLeast, type Role } from "./authz.js";

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

/** How many owners the organisation currently has — the last-owner guard's input. */
async function ownerCount(orgId: string): Promise<number> {
  const client = requireClient();
  const { data, error } = await client
    .from("organisation_members")
    .select("user_id")
    .eq("organisation_id", orgId)
    .eq("role", "owner");
  if (error) throw new AccessError(500, `could not count owners: ${error.message}`);
  return (data ?? []).length;
}

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

/**
 * Accounts that exist but are not yet in this organisation — the add-member field's suggestions.
 *
 * Read-only and admin-gated at the route. It exists because adding a member meant typing a full
 * address blind, and a typo produced "no account with that email" with no way to tell a wrong
 * address from an unregistered one.
 *
 * **This returns every registered address to any admin of any organisation.** Correct for one
 * company running this locally, a privacy leak the moment two unrelated customers share an
 * instance — see the report's DEFERRED section. It has to be scoped or dropped before that.
 */
export async function listAddableUsers(orgId: string): Promise<string[]> {
  const client = requireClient();

  const { data: memberRows, error } = await client
    .from("organisation_members")
    .select("user_id")
    .eq("organisation_id", orgId);
  if (error) throw new AccessError(500, `could not list members: ${error.message}`);

  const alreadyIn = new Set((memberRows ?? []).map((r) => (r as { user_id: string }).user_id));

  try {
    const { data, error: listErr } = await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listErr) throw new Error(listErr.message);
    return (data?.users ?? [])
      .filter((u) => u.email && !alreadyIn.has(u.id))
      .map((u) => u.email as string)
      .sort((a, b) => a.localeCompare(b));
  } catch (err) {
    // A suggestion list is a convenience. If the directory can't be read, the field still works
    // as free text — degrade to "no suggestions" rather than failing the whole Team screen.
    console.error("[org] could not list addable accounts:", (err as Error)?.message ?? err);
    return [];
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
 * Make sure a signed-in account belongs somewhere, creating an organisation it owns if not.
 *
 * Idempotent by design: the frontend calls it after every sign-in, not just after sign-up, so an
 * account created directly in the Supabase dashboard (which never touches this server) still ends
 * up with a home rather than a working login that can't do anything.
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

  const orgName = email ? `${email.split("@")[0]}'s organisation` : "New organisation";
  const { data: org, error: orgErr } = await client
    .from("organisations")
    .insert({ name: orgName })
    .select("id, name")
    .single();
  if (orgErr || !org) throw new AccessError(500, `could not create organisation: ${orgErr?.message}`);

  const { error: memberErr } = await client
    .from("organisation_members")
    .insert({ organisation_id: org.id, user_id: userId, role: "owner" });
  if (memberErr) {
    throw new AccessError(500, `could not create membership: ${memberErr.message}`);
  }

  invalidateMemberships(userId);
  return { organisationId: org.id, organisationName: org.name, role: "owner", created: true };
}
