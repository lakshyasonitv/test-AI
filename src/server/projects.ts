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

/** What deleting a project would actually destroy or unfile. Counts only — no side effects. */
export interface ProjectDeletionImpact {
  /** Runs that become UNFILED (`project_id` → null). Artifacts on disk are untouched. */
  runs: number;
  /** Suites destroyed by the `projects → suites` cascade. */
  suites: number;
  /** Saved cases destroyed by the `projects → test_cases` cascade, with all their versions. */
  cases: number;
}

/**
 * Count what a delete would do, so the caller can be shown it BEFORE confirming.
 *
 * Exists because the cascade is invisible from the UI: `projects → suites` and
 * `projects → test_cases` are both ON DELETE CASCADE, so deleting a project takes its entire
 * library with it. Until now the runs refusal below happened to shield people from that; removing
 * the refusal without surfacing the cascade would trade a blocked delete for a silent one.
 */
export async function projectDeletionImpact(
  orgId: string, projectId: string,
): Promise<ProjectDeletionImpact> {
  await assertProjectInOrg(orgId, projectId);
  const client = requireClient();

  const counted = async (table: string) => {
    const { count, error } = await client
      .from(table).select("id", { count: "exact", head: true }).eq("project_id", projectId);
    if (error) throw new AccessError(500, `could not count ${table}: ${error.message}`);
    return count ?? 0;
  };

  return {
    runs: await counted("runs"),
    suites: await counted("suites"),
    cases: await counted("test_cases"),
  };
}

/**
 * Delete a project.
 *
 * WHAT THIS DOES TO RUNS, AND WHY IT NO LONGER REFUSES. `runs.project_id` is **ON DELETE SET
 * NULL** — the schema was built so a project can go while its run history survives. This function
 * used to be stricter than its own database, throwing 409 whenever any run referenced the project
 * and telling the caller to "move or delete them first". **There is no route to move a run to
 * another project**, and History only lists the newest 20 runs (TECH_DEBT.md TD-51), so a project
 * whose runs had aged out of that window could never be deleted at all — the refusal pointed at an
 * action the product does not offer.
 *
 * The original concern was real and is preserved differently: nothing is destroyed here. The runs,
 * their screenshots, traces and specs all survive; they become UNFILED. The one genuine cost is
 * that an unfiled run is visible to admin+ only (`filterRunsForUser` in authz.ts — nobody can be
 * assigned to "no project"), so a tester loses sight of them. That is a disclosure the caller makes
 * knowingly, which is what `projectDeletionImpact` is for.
 *
 * THE CASCADE IS THE DANGEROUS PART, not the runs. Suites and test_cases both CASCADE from
 * projects, so this destroys the project's whole library including every saved version. Callers
 * must show `projectDeletionImpact` first; the UI additionally requires the project name to be
 * typed back.
 */
export async function deleteProject(orgId: string, projectId: string): Promise<void> {
  await assertProjectInOrg(orgId, projectId);
  const client = requireClient();

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
 * Put the person who caused a project to exist into it.
 *
 * Non-fatal, like everything else on this path: the project exists and the run can still be filed
 * under it. Logged loudly rather than swallowed, because the consequence is a run its own author
 * cannot see, and that is invisible from the server's side.
 */
async function addCreatorToProject(
  client: NonNullable<ReturnType<typeof getServiceClient>>,
  projectId: string,
  userId: string | undefined,
): Promise<void> {
  if (!userId) return;
  const { error } = await client
    .from("project_members")
    .upsert({ project_id: projectId, user_id: userId },
      { onConflict: "project_id,user_id", ignoreDuplicates: true });
  if (error) {
    console.error(
      `[projects] created project ${projectId} but could not add its creator ${userId} — ` +
      `they will not be able to see runs filed under it until an admin adds them: ${error.message}`,
    );
  }
}

/**
 * The project a new run belongs to, inferred from its URL.
 *
 * Keeps the sidebar coherent without asking the user to pick a project on every run: a run against
 * a URL that already has a project files under it, and an unrecognised URL creates one. Same key
 * as the backfill, so a run started today lands in the project its history is already in.
 *
 * WHEN IT CREATES ONE, IT ADDS THE CREATOR TO IT. Without that a tester who starts a run against a
 * URL nobody has tested yet lands their own run in a project with no members — and every read path
 * applies the Step 5.1 visibility gate identically, so `filterRunsForUser` drops the run from their
 * history, `requireRunRole` refuses `/state`, `/events` and `/page-elements`, and `canViewRun` 403s
 * every screenshot. They could start a run and then not watch it, with only an admin able to
 * unblock them after the fact. Admins and owners never noticed because their role exempts them
 * from project scoping entirely, which is why every run on record was started by one.
 *
 * Only on CREATE, never on lookup: adding someone to a project that already exists would silently
 * widen access, and "who may see this project" is an admin's decision everywhere else.
 */
export async function resolveProjectForUrl(
  orgId: string, url: string | null, userId?: string,
): Promise<string | null> {
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
      // 23505 is unique_violation — another run created this same project between the lookup a few
      // lines above and this insert. Before the (organisation_id, normalised_name) index existed
      // both inserts succeeded and the result was two near-duplicate projects splitting one site's
      // history. With the index the loser's insert fails instead, and simply returning null here
      // would be WORSE than the duplicate it prevents: the run is then filed under no project, and
      // an unfiled run is admin-visible only — so the person who started it cannot see it. That is
      // precisely the failure `addCreatorToProject` exists to prevent, reintroduced by the fix for
      // a different bug.
      //
      // So the loser re-reads the winner's row and files under it. Both runs land in one project,
      // which is what should have happened, and neither caller is punished for the race.
      if (createErr.code === "23505") {
        const { data: winner, error: reReadErr } = await client
          .from("projects")
          .select("id")
          .eq("organisation_id", orgId)
          .eq("name", key)
          .maybeSingle();
        if (reReadErr || !winner) {
          console.error(
            `[projects] lost the race to create project "${key}" and could not read it back:`,
            reReadErr?.message ?? "no row",
          );
          return null;
        }
        const projectId = (winner as { id: string }).id;
        // Still add the creator. This path is reachable ONLY when the project did not exist at
        // lookup time, so this caller genuinely was creating it and lost by microseconds — the
        // "grant on create, never on lookup" rule is about projects that already existed, not
        // about losing a tie. A caller cannot steer themselves here: if the project exists, the
        // lookup above returns early and grants nothing.
        await addCreatorToProject(client, projectId, userId);
        return projectId;
      }

      console.error("[projects] could not create project for a new run:", createErr.message);
      return null;
    }

    const projectId = (created as { id: string }).id;
    await addCreatorToProject(client, projectId, userId);
    return projectId;
  } catch (err) {
    // Never fatal: a run must start even if its filing cabinet is unreachable.
    console.error("[projects] resolving a project threw:", (err as Error)?.message ?? err);
    return null;
  }
}
