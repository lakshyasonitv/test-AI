import { getServiceClient } from "../db.js";
import { AccessError, visibleProjectIds, type Role } from "./authz.js";
import { countCasesByProject } from "./library.js";

/**
 * Projects, and project-level visibility — implentationplan.md Step 5.1 plus the access model the
 * user asked for: "create by default a user as viewer, and then admin or the owner can add them to
 * a particular project".
 *
 * TWO INDEPENDENT AXES. This is the whole design, and keeping them separate is what stops the
 * permission model turning into a matrix nobody can reason about:
 *
 *   - **Organisation role = what you may DO.**  viewer < tester < admin < owner. Lives in
 *     `organisation_members.role` and is enforced by authz.ts. Unchanged by this file.
 *   - **Project membership = what you may SEE.** Lives in `project_members`, which deliberately
 *     has NO role column. Adding one would mean two places answer "may this person delete a run",
 *     and they would drift.
 *
 * Visibility rule, in one sentence: admins and owners see every project in their organisation
 * (they manage it — scoping them is friction with no security value); testers and viewers see only
 * the projects they have been assigned to, and a brand-new account is assigned to none, which is
 * exactly the "you're not in any project yet" state the user asked for.
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

export interface ProjectRow {
  id: string;
  name: string;
  baseUrl: string;
  /** Runs filed under this project. Kept, and still returned — it is a real fact about the
   *  project and removing it would drop a field callers may already read. It is simply not the
   *  number the tree renders, because the tree's other rows count cases. */
  runCount?: number;
  /** Saved cases in this project — ALL of them, not the sum of its suites. The number the sidebar
   *  tree shows on a project row, so it speaks the same unit its suite children already do.
   *  Additive and optional; see `countCasesByProject` in library.ts for why it is counted there. */
  caseCount?: number;
}

export interface ProjectMemberRow {
  userId: string;
  email: string | null;
}

/**
 * The project key for a URL.
 *
 * MUST stay identical to `normalizeUrlKey()` in public/app.js — the backfill migration keyed the
 * existing 52 runs with exactly this rule, so a divergence here would file new runs under a
 * second, near-duplicate project instead of the one the user already sees in the sidebar.
 * Protocol stripped, trailing slashes stripped, lowercased, path retained.
 */
export function normaliseUrlKey(url: string | null | undefined): string {
  return (url ?? "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

/** Projects the caller may see, busiest first, each with its run count AND its saved-case count. */
export async function listVisibleProjects(
  userId: string,
  orgId: string,
  role: Role,
): Promise<ProjectRow[]> {
  const client = requireClient();
  const allowed = await visibleProjectIds(userId, orgId, role);
  if (allowed && allowed.size === 0) return [];

  let query = client
    .from("projects")
    .select("id, name, base_url")
    .eq("organisation_id", orgId);
  if (allowed) query = query.in("id", [...allowed]);

  const { data, error } = await query;
  if (error) throw new AccessError(500, `could not list projects: ${error.message}`);

  const rows = (data ?? []) as { id: string; name: string; base_url: string }[];
  if (rows.length === 0) return [];

  // One grouped count rather than a query per project.
  const projectIds = rows.map((r) => r.id);
  const { data: runRows } = await client
    .from("runs")
    .select("project_id")
    .in("project_id", projectIds);
  const counts = new Map<string, number>();
  for (const r of (runRows ?? []) as { project_id: string | null }[]) {
    if (r.project_id) counts.set(r.project_id, (counts.get(r.project_id) ?? 0) + 1);
  }

  // The case count is owned by library.ts, which owns the case library. One grouped query there,
  // not one per project, and never counted client-side off a full listCases().
  const caseCounts = await countCasesByProject(projectIds);

  return rows
    .map((r) => ({
      id: r.id, name: r.name, baseUrl: r.base_url,
      runCount: counts.get(r.id) ?? 0,
      // Zero is a real answer and must survive as 0 — a project with no saved cases shows "0",
      // never a blank.
      caseCount: caseCounts.get(r.id) ?? 0,
    }))
    // Ordering is deliberately UNCHANGED: busiest-by-runs first. Re-sorting on the new number
    // would silently rearrange everyone's sidebar, which is not what this fix is for.
    .sort((a, b) => (b.runCount! - a.runCount!) || a.name.localeCompare(b.name));
}

/**
 * Prove a project belongs to this organisation before anything acts on it.
 *
 * The plan's rule — "never filter by an org id taken from the request body; let the join prove the
 * org is theirs" — applies to project ids too. `orgId` here always comes from the session via
 * requireRole, so a caller naming someone else's project id gets a 404, not their data.
 */
export async function assertProjectInOrg(orgId: string, projectId: string): Promise<ProjectRow> {
  const client = requireClient();
  const { data, error } = await client
    .from("projects")
    .select("id, name, base_url")
    .eq("id", projectId)
    .eq("organisation_id", orgId)
    .maybeSingle();
  if (error) throw new AccessError(500, `could not read project: ${error.message}`);
  const row = data as { id: string; name: string; base_url: string } | null;
  if (!row) throw new AccessError(404, "no such project in this organisation");
  return { id: row.id, name: row.name, baseUrl: row.base_url };
}

/** A non-admin must additionally be assigned to the project, not merely in the organisation. */
export async function assertProjectVisible(
  userId: string,
  orgId: string,
  role: Role,
  projectId: string,
): Promise<ProjectRow> {
  const project = await assertProjectInOrg(orgId, projectId);
  const allowed = await visibleProjectIds(userId, orgId, role);
  if (allowed && !allowed.has(projectId)) {
    throw new AccessError(403, "you have not been added to this project");
  }
  return project;
}

export async function createProject(orgId: string, name: string, baseUrl: string): Promise<ProjectRow> {
  const client = requireClient();
  const { data, error } = await client
    .from("projects")
    .insert({ organisation_id: orgId, name: name.trim(), base_url: baseUrl.trim() })
    .select("id, name, base_url")
    .single();
  if (error || !data) throw new AccessError(500, `could not create project: ${error?.message}`);
  return { id: data.id, name: data.name, baseUrl: data.base_url, runCount: 0, caseCount: 0 };
}

export async function updateProject(
  orgId: string,
  projectId: string,
  patch: { name?: string; baseUrl?: string },
): Promise<ProjectRow> {
  await assertProjectInOrg(orgId, projectId);
  const update: Record<string, string> = {};
  if (typeof patch.name === "string" && patch.name.trim()) update.name = patch.name.trim();
  if (typeof patch.baseUrl === "string") update.base_url = patch.baseUrl.trim();
  if (Object.keys(update).length === 0) {
    throw new AccessError(400, "nothing to update — send a name or baseUrl");
  }

  const client = requireClient();
  const { data, error } = await client
    .from("projects")
    .update(update)
    .eq("id", projectId)
    .eq("organisation_id", orgId)
    .select("id, name, base_url")
    .single();
  if (error || !data) throw new AccessError(500, `could not update project: ${error?.message}`);
  return { id: data.id, name: data.name, baseUrl: data.base_url };
}

/**
 * Delete a project.
 *
 * REFUSES while it still holds runs, rather than orphaning or cascading them. Run history is the
 * evidence this product exists to produce — screenshots, traces, the generated spec — and a
 * mis-click on a project row must not be able to make 25 runs unreachable. The caller is told the
 * count and can move or delete the runs deliberately.
 */
export async function deleteProject(orgId: string, projectId: string): Promise<void> {
  await assertProjectInOrg(orgId, projectId);
  const client = requireClient();

  const { data: runRows, error: runErr } = await client
    .from("runs")
    .select("id")
    .eq("project_id", projectId)
    .limit(1000);
  if (runErr) throw new AccessError(500, `could not check the project's runs: ${runErr.message}`);
  const count = (runRows ?? []).length;
  if (count > 0) {
    throw new AccessError(
      409,
      `this project still holds ${count} run${count === 1 ? "" : "s"} — move or delete them first`,
    );
  }

  const { error } = await client
    .from("projects")
    .delete()
    .eq("id", projectId)
    .eq("organisation_id", orgId);
  if (error) throw new AccessError(500, `could not delete project: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Project membership
// ---------------------------------------------------------------------------

async function emailsFor(userIds: string[]): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (userIds.length === 0) return out;
  const client = requireClient();
  try {
    const { data } = await client.auth.admin.listUsers({ page: 1, perPage: 1000 });
    for (const u of data?.users ?? []) out.set(u.id, u.email ?? null);
  } catch (err) {
    console.error("[projects] could not resolve member emails:", (err as Error)?.message ?? err);
  }
  return out;
}

export async function listProjectMembers(orgId: string, projectId: string): Promise<ProjectMemberRow[]> {
  await assertProjectInOrg(orgId, projectId);
  const client = requireClient();
  const { data, error } = await client
    .from("project_members")
    .select("user_id")
    .eq("project_id", projectId);
  if (error) throw new AccessError(500, `could not list project members: ${error.message}`);

  const ids = (data ?? []).map((r) => (r as { user_id: string }).user_id);
  const emails = await emailsFor(ids);
  return ids.map((id) => ({ userId: id, email: emails.get(id) ?? null }));
}

/** Every project assignment in this organisation, as userId -> projectIds. Powers the Team screen. */
export async function assignmentsByUser(orgId: string): Promise<Map<string, string[]>> {
  const client = requireClient();
  const { data, error } = await client
    .from("project_members")
    .select("user_id, project_id, projects!inner(organisation_id)")
    .eq("projects.organisation_id", orgId);
  if (error) throw new AccessError(500, `could not read project assignments: ${error.message}`);

  const out = new Map<string, string[]>();
  for (const r of (data ?? []) as { user_id: string; project_id: string }[]) {
    const list = out.get(r.user_id) ?? [];
    list.push(r.project_id);
    out.set(r.user_id, list);
  }
  return out;
}

/**
 * Add someone to a project. `userId` must already be a member of the organisation — project
 * membership grants visibility, never entry: someone outside the org has no role and so no
 * permissions at all, and silently creating that state would be a tenancy hole.
 */
export async function addProjectMember(
  orgId: string,
  projectId: string,
  userId: string,
  isOrgMember: boolean,
): Promise<void> {
  await assertProjectInOrg(orgId, projectId);
  if (!isOrgMember) {
    throw new AccessError(
      404,
      "that account is not a member of this organisation — add them to the team first",
    );
  }
  const client = requireClient();
  const { error } = await client
    .from("project_members")
    .upsert({ project_id: projectId, user_id: userId }, { onConflict: "project_id,user_id", ignoreDuplicates: true });
  if (error) throw new AccessError(500, `could not add to project: ${error.message}`);
}

export async function removeProjectMember(
  orgId: string,
  projectId: string,
  userId: string,
): Promise<void> {
  await assertProjectInOrg(orgId, projectId);
  const client = requireClient();
  const { error } = await client
    .from("project_members")
    .delete()
    .eq("project_id", projectId)
    .eq("user_id", userId);
  if (error) throw new AccessError(500, `could not remove from project: ${error.message}`);
}

/**
 * The project a new run belongs to, inferred from its URL.
 *
 * Keeps the sidebar coherent without asking the user to pick a project on every run: a run against
 * a URL that already has a project files under it, and an unrecognised URL creates one. Same key
 * as the backfill, so a run started today lands in the project its history is already in.
 */
export async function resolveProjectForUrl(orgId: string, url: string | null): Promise<string | null> {
  const key = normaliseUrlKey(url);
  if (!key) return null;

  const client = getServiceClient();
  if (!client) return null;

  try {
    const { data, error } = await client
      .from("projects")
      .select("id")
      .eq("organisation_id", orgId)
      .eq("name", key)
      .maybeSingle();
    if (error) {
      console.error("[projects] project lookup failed:", error.message);
      return null;
    }
    if (data) return (data as { id: string }).id;

    const { data: created, error: createErr } = await client
      .from("projects")
      .insert({ organisation_id: orgId, name: key, base_url: url ?? "" })
      .select("id")
      .single();
    if (createErr) {
      console.error("[projects] could not create project for a new run:", createErr.message);
      return null;
    }
    return (created as { id: string }).id;
  } catch (err) {
    // Never fatal: a run must start even if its filing cabinet is unreachable.
    console.error("[projects] resolving a project threw:", (err as Error)?.message ?? err);
    return null;
  }
}
