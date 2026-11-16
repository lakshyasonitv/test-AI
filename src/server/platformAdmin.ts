/**
 * Platform admins and company organisations (D-84), behind PLATFORM_ADMIN_ENABLED (default OFF).
 *
 * THE MODEL, in the user's words: "only admin can create an organisation, which is basically a
 * company; admins are the people who run Testbench and have access to all organisations; an owner
 * creates users who belong to the owner's organisation; viewer < tester < owner < Admin."
 *
 *   - A platform admin is a row in `platform_admins` (migration 20261116120000). They are not a
 *     member of any organisation; inside whichever organisation they open they act as its owner.
 *   - Company roles are owner, tester and viewer. A legacy `admin` membership row is read as
 *     `owner` (the user's decision: old data stays as it is, and those people run their company).
 *   - Every account belongs to exactly one organisation. Nobody gets an organisation of their own on
 *     first sign-in any more (that is what left added members stuck in an empty workspace, TD-191).
 *
 * With the flag off none of this is read, every function here is unused, and access is exactly the
 * old model.
 */
import { getServiceClient } from "../db.js";
import { AccessError, invalidateMemberships, type Role } from "./authz.js";

export function platformAdminEnabled(): boolean {
  return process.env.PLATFORM_ADMIN_ENABLED === "true";
}

/** The company roles an owner or admin may hand out. `admin` is the platform level, never a company role. */
export const COMPANY_ROLES = ["owner", "tester", "viewer"] as const;
export type CompanyRole = (typeof COMPANY_ROLES)[number];
export function isCompanyRole(v: unknown): v is CompanyRole {
  return typeof v === "string" && (COMPANY_ROLES as readonly string[]).includes(v);
}

/** A legacy in-company `admin` reads as `owner` while the new model is on. */
export function effectiveCompanyRole(role: Role): Role {
  return platformAdminEnabled() && role === "admin" ? "owner" : role;
}

function requireClient() {
  const client = getServiceClient();
  if (!client) throw new AccessError(503, "the database is not configured");
  return client;
}

const CACHE_TTL_MS = 5_000;
let adminCache: { at: number; ids: Set<string> } | null = null;

export function invalidatePlatformAdmins(): void { adminCache = null; }

/** Is this account a platform admin? Fails CLOSED: an unreadable table means "no". */
export async function isPlatformAdmin(userId: string): Promise<boolean> {
  if (!platformAdminEnabled() || !userId) return false;
  if (adminCache && Date.now() - adminCache.at < CACHE_TTL_MS) return adminCache.ids.has(userId);
  const client = getServiceClient();
  if (!client) return false;
  const { data, error } = await client.from("platform_admins").select("user_id");
  if (error) {
    console.error("[platform-admin] could not read platform_admins:", error.message);
    return false;
  }
  adminCache = { at: Date.now(), ids: new Set((data ?? []).map((r: { user_id: string }) => r.user_id)) };
  return adminCache.ids.has(userId);
}

/** Does this organisation exist? Used before a platform admin acts in it. */
export async function organisationExists(orgId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) return false;
  const client = requireClient();
  const { data, error } = await client.from("organisations").select("id").eq("id", orgId).maybeSingle();
  if (error) throw new AccessError(500, `could not read organisation: ${error.message}`);
  return !!data;
}

/** The organisation a platform admin is looking at when they named none: the oldest one. */
export async function firstOrganisation(): Promise<string | null> {
  const client = requireClient();
  const { data, error } = await client.from("organisations").select("id, created_at")
    .order("created_at", { ascending: true }).limit(1);
  if (error) throw new AccessError(500, `could not read organisations: ${error.message}`);
  return (data as { id: string }[] | null)?.[0]?.id ?? null;
}

export interface OrganisationSummary {
  id: string;
  name: string;
  createdAt: string | null;
  members: number;
  projects: number;
}

/** Every organisation, for the Admin page. Counts in two grouped reads, not one per organisation. */
export async function listAllOrganisations(): Promise<OrganisationSummary[]> {
  const client = requireClient();
  const { data: orgs, error } = await client.from("organisations").select("id, name, created_at")
    .order("created_at", { ascending: true });
  if (error) throw new AccessError(500, `could not list organisations: ${error.message}`);
  const [{ data: members }, { data: projects }] = await Promise.all([
    client.from("organisation_members").select("organisation_id"),
    client.from("projects").select("organisation_id"),
  ]);
  const count = (rows: unknown) => {
    const m = new Map<string, number>();
    for (const r of (rows ?? []) as { organisation_id: string }[]) m.set(r.organisation_id, (m.get(r.organisation_id) ?? 0) + 1);
    return m;
  };
  const mc = count(members), pc = count(projects);
  return ((orgs ?? []) as { id: string; name: string; created_at: string | null }[]).map((o) => ({
    id: o.id, name: o.name, createdAt: o.created_at ?? null,
    members: mc.get(o.id) ?? 0, projects: pc.get(o.id) ?? 0,
  }));
}

/** The organisation's display name, or null. */
export async function organisationName(orgId: string): Promise<string | null> {
  const client = getServiceClient();
  if (!client) return null;
  const { data } = await client.from("organisations").select("name").eq("id", orgId).maybeSingle();
  return (data as { name?: string } | null)?.name ?? null;
}

/** A new, empty organisation. The admin who creates it does NOT become a member: they reach every one by being an admin. */
export async function createCompany(name: string): Promise<{ id: string; name: string }> {
  const trimmed = name.trim();
  if (!trimmed) throw new AccessError(400, "an organisation needs a name");
  if (trimmed.length > 120) throw new AccessError(400, "that name is too long");
  const client = requireClient();
  const { data, error } = await client.from("organisations").insert({ name: trimmed }).select("id, name").single();
  if (error || !data) throw new AccessError(500, `could not create the organisation: ${error?.message ?? "no row"}`);
  return { id: (data as { id: string }).id, name: (data as { name: string }).name };
}

async function accountByEmail(email: string): Promise<{ id: string; email: string } | null> {
  const client = requireClient();
  const wanted = email.trim().toLowerCase();
  const { data, error } = await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw new AccessError(500, `could not look up accounts: ${error.message}`);
  const found = (data?.users ?? []).find((u: { email?: string | null }) => (u.email ?? "").toLowerCase() === wanted);
  return found ? { id: found.id, email: found.email ?? wanted } : null;
}

export const MIN_PASSWORD_LENGTH = 8;

/**
 * Create an account AND put it in this organisation with this role (an owner's "New user", or an
 * admin's in any organisation). One organisation per person: an email that already has an account
 * anywhere is refused, so nobody is silently moved between companies — that is the admin's "Move"
 * below. The password is passed straight to Supabase and never logged, stored or echoed.
 *
 * Two writes, so it unwinds: if the membership cannot be written the new account is deleted again,
 * rather than leaving a login that belongs to no company.
 */
export async function createCompanyUser(
  orgId: string,
  input: { email: unknown; password: unknown; role: unknown; projectId?: unknown },
): Promise<{ userId: string; email: string; role: CompanyRole; projectId: string | null }> {
  const email = typeof input.email === "string" ? input.email.trim() : "";
  const password = typeof input.password === "string" ? input.password : "";
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AccessError(400, "enter a valid email address");
  if (password.length < MIN_PASSWORD_LENGTH) throw new AccessError(400, `the password needs at least ${MIN_PASSWORD_LENGTH} characters`);
  if (!isCompanyRole(input.role)) throw new AccessError(400, "role must be one of: owner, tester, viewer");
  const role = input.role;
  const projectId = typeof input.projectId === "string" && input.projectId ? input.projectId : null;

  const client = requireClient();
  if (projectId) {
    const { data: p } = await client.from("projects").select("id").eq("id", projectId).eq("organisation_id", orgId).maybeSingle();
    if (!p) throw new AccessError(404, "that project is not in this organisation");
  }
  if (await accountByEmail(email)) {
    throw new AccessError(409, "this email already has an account — an admin can move it into this organisation");
  }

  const { data: created, error: createErr } = await client.auth.admin.createUser({ email, password, email_confirm: true });
  const userId = (created as { user?: { id?: string } } | null)?.user?.id;
  if (createErr || !userId) throw new AccessError(500, `could not create the account: ${createErr?.message ?? "no user returned"}`);

  const { error: memErr } = await client.from("organisation_members").insert({ organisation_id: orgId, user_id: userId, role });
  if (memErr) {
    await client.auth.admin.deleteUser(userId).catch(() => undefined);
    throw new AccessError(500, `could not add the account to the organisation: ${memErr.message}`);
  }
  invalidateMemberships(userId);
  if (projectId && role !== "owner") {
    await client.from("project_members").upsert({ project_id: projectId, user_id: userId }, { onConflict: "project_id,user_id", ignoreDuplicates: true });
  }
  return { userId, email, role, projectId: role !== "owner" ? projectId : null };
}

/**
 * Admin only: put an EXISTING account into this organisation with this role, taking it out of any
 * other (one organisation per person). This is how someone stuck in an old empty workspace is fixed.
 * Their project assignments elsewhere go with them; their old workspace itself is left as it is.
 */
export async function moveUserToOrganisation(
  orgId: string, email: unknown, role: unknown,
): Promise<{ userId: string; email: string; role: CompanyRole }> {
  if (typeof email !== "string" || !email.trim()) throw new AccessError(400, "enter the account's email");
  if (!isCompanyRole(role)) throw new AccessError(400, "role must be one of: owner, tester, viewer");
  const account = await accountByEmail(email);
  if (!account) throw new AccessError(404, "no account with that email");
  const client = requireClient();
  const { data: others } = await client.from("organisation_members").select("organisation_id").eq("user_id", account.id);
  const elsewhere = ((others ?? []) as { organisation_id: string }[]).filter((o) => o.organisation_id !== orgId);
  for (const o of elsewhere) {
    await client.from("organisation_members").delete().eq("organisation_id", o.organisation_id).eq("user_id", account.id);
  }
  // Their projects in the organisations they leave go with them; projects in this one are kept.
  if (elsewhere.length) {
    const { data: theirProjects } = await client.from("project_members").select("project_id, projects!inner(organisation_id)").eq("user_id", account.id);
    for (const r of (theirProjects ?? []) as { project_id: string; projects?: { organisation_id?: string } }[]) {
      if (r.projects?.organisation_id !== orgId) {
        await client.from("project_members").delete().eq("project_id", r.project_id).eq("user_id", account.id);
      }
    }
  }
  const { data: here } = await client.from("organisation_members").select("role").eq("organisation_id", orgId).eq("user_id", account.id).maybeSingle();
  const write = here
    ? await client.from("organisation_members").update({ role }).eq("organisation_id", orgId).eq("user_id", account.id)
    : await client.from("organisation_members").insert({ organisation_id: orgId, user_id: account.id, role });
  if (write.error) throw new AccessError(500, `could not move the account: ${write.error.message}`);
  invalidateMemberships(account.id);
  return { userId: account.id, email: account.email, role };
}
