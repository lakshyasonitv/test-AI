import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * The only test in this repository that exercises a row-level security policy.
 *
 * EVERY OTHER TEST MOCKS `@supabase/supabase-js`. That is the right call for them — they assert
 * what the middleware and the route handlers decide, and a real database would make them slow,
 * networked and dependent on a secret. But it has a consequence nobody had written down: RLS is
 * enforced by Postgres, and a fake `createClient` never asks Postgres anything. So before this
 * file, not one policy in this system was covered by anything at all, and the audit found the
 * result — every read policy stopped at the organisation and none consulted `project_members`,
 * for months, with a green suite the whole time.
 *
 * So this file does the opposite of the others on purpose: NO `vi.mock`. It signs a real viewer in,
 * takes their real JWT, and talks to PostgREST over HTTP the way a browser would — because that is
 * the exact path RLS is the only defence on. The server holds the service-role key and bypasses
 * RLS entirely, so nothing the API does can prove any of this.
 *
 * WHY IT IS SKIPPED BY DEFAULT. It needs a live Postgres with the migrations applied and it creates
 * real accounts, so it cannot run in CI or on a laptop with no project. It skips unless pointed at
 * one, and says so. That makes it opt-in, not decorative: `npm run test:rls` is a real gate before
 * a policy change ships.
 *
 *   RLS_TEST_SUPABASE_URL=https://<ref>.supabase.co \
 *   RLS_TEST_SERVICE_ROLE_KEY=<service_role key> \
 *   RLS_TEST_PUBLISHABLE_KEY=<publishable/anon key> \
 *   npx vitest run tests/rlsPolicies.integration.test.ts
 *
 * POINT IT AT A BRANCH OR A SCRATCH PROJECT, NOT PRODUCTION. It creates two organisations, two
 * projects, three accounts and their data, and deletes them afterwards — but a failed run can leave
 * fixtures behind, and it signs real users in. Everything it creates is prefixed `rlstest-` so
 * leftovers are identifiable.
 */

const URL_ = process.env.RLS_TEST_SUPABASE_URL;
const SERVICE_KEY = process.env.RLS_TEST_SERVICE_ROLE_KEY;
const PUBLISHABLE_KEY = process.env.RLS_TEST_PUBLISHABLE_KEY;
const CONFIGURED = !!(URL_ && SERVICE_KEY && PUBLISHABLE_KEY);

if (!CONFIGURED) {
  console.warn(
    "[rls] SKIPPED — no database configured. RLS policies are enforced by Postgres and cannot be " +
    "tested against a mock. Set RLS_TEST_SUPABASE_URL, RLS_TEST_SERVICE_ROLE_KEY and " +
    "RLS_TEST_PUBLISHABLE_KEY (pointing at a branch, NOT production) to run this.",
  );
}

/** Unique per run, so a leftover fixture from a failed run never collides with a fresh one. */
const TAG = `rlstest-${Date.now().toString(36)}`;
const PASSWORD = "rls-test-password-9f3a2b";

interface Fixture {
  orgA: string;
  orgB: string;
  projAssigned: string;
  projUnassigned: string;
  projOrgB: string;
  caseAssigned: string;
  caseUnassigned: string;
  caseOrgB: string;
  runAssigned: string;
  runUnassigned: string;
  runUnfiled: string;
  suiteUnassigned: string;
  viewerId: string;
  adminId: string;
  outsiderId: string;
}

let admin: SupabaseClient;
let fx: Fixture;
/** PostgREST as the viewer: publishable key + the viewer's own JWT. Exactly what a browser has. */
let asViewer: SupabaseClient;
/** Same, for an account in a different organisation entirely. */
let asOutsider: SupabaseClient;

async function makeUser(email: string): Promise<string> {
  const { data, error } = await admin.auth.admin.createUser({
    email, password: PASSWORD, email_confirm: true,
  });
  if (error) throw new Error(`could not create ${email}: ${error.message}`);
  return data.user!.id;
}

async function clientFor(email: string): Promise<SupabaseClient> {
  const c = createClient(URL_!, PUBLISHABLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (error) throw new Error(`could not sign in as ${email}: ${error.message}`);
  return c;
}

async function insert<T extends Record<string, unknown>>(table: string, row: T): Promise<string> {
  const { data, error } = await admin.from(table).insert(row).select("id").single();
  if (error) throw new Error(`seeding ${table} failed: ${error.message}`);
  return (data as { id: string }).id;
}

describe.skipIf(!CONFIGURED)("RLS — a viewer reaching PostgREST directly with their own JWT", () => {
  beforeAll(async () => {
    admin = createClient(URL_!, SERVICE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const viewerEmail = `${TAG}-viewer@example.com`;
    const adminEmail = `${TAG}-admin@example.com`;
    const outsiderEmail = `${TAG}-outsider@example.com`;

    const viewerId = await makeUser(viewerEmail);
    const adminId = await makeUser(adminEmail);
    const outsiderId = await makeUser(outsiderEmail);

    const orgA = await insert("organisations", { name: `${TAG}-org-a` });
    const orgB = await insert("organisations", { name: `${TAG}-org-b` });

    // The viewer is in org A as a viewer — the lowest rung, and the one the project axis governs.
    // The admin is in org A too, to prove admin exemption is preserved rather than lost.
    await admin.from("organisation_members").insert([
      { organisation_id: orgA, user_id: viewerId, role: "viewer" },
      { organisation_id: orgA, user_id: adminId, role: "admin" },
      { organisation_id: orgB, user_id: outsiderId, role: "owner" },
    ]);

    const projAssigned = await insert("projects", { organisation_id: orgA, name: `${TAG}-assigned`, base_url: "https://a.example.com" });
    const projUnassigned = await insert("projects", { organisation_id: orgA, name: `${TAG}-unassigned`, base_url: "https://b.example.com" });
    const projOrgB = await insert("projects", { organisation_id: orgB, name: `${TAG}-orgb`, base_url: "https://c.example.com" });

    // ONE project assignment. This is the whole point: same organisation, two projects, and the
    // viewer has been added to exactly one of them.
    await admin.from("project_members").insert({ project_id: projAssigned, user_id: viewerId });

    const ir = { meta: { title: "t", baseUrl: "https://a.example.com" }, steps: [] };
    const caseAssigned = await insert("test_cases", { project_id: projAssigned, title: `${TAG}-visible`, ir, current_version: 1 });
    const caseUnassigned = await insert("test_cases", { project_id: projUnassigned, title: `${TAG}-hidden`, ir, current_version: 1 });
    const caseOrgB = await insert("test_cases", { project_id: projOrgB, title: `${TAG}-orgb`, ir, current_version: 1 });

    await admin.from("test_case_versions").insert([
      { test_case_id: caseAssigned, version: 1, ir },
      { test_case_id: caseUnassigned, version: 1, ir },
    ]);

    const suiteUnassigned = await insert("suites", { project_id: projUnassigned, name: `${TAG}-hidden-suite` });

    // runs.id is text, not a generated uuid — it carries the makeRunId() shape.
    const runAssigned = `${TAG}-run-assigned`;
    const runUnassigned = `${TAG}-run-unassigned`;
    const runUnfiled = `${TAG}-run-unfiled`;
    const { error: runErr } = await admin.from("runs").insert([
      { id: runAssigned, organisation_id: orgA, project_id: projAssigned, status: "passed", started_at: new Date().toISOString() },
      { id: runUnassigned, organisation_id: orgA, project_id: projUnassigned, status: "passed", started_at: new Date().toISOString() },
      // No project at all — admin-visible only, per filterRunsForUser.
      { id: runUnfiled, organisation_id: orgA, project_id: null, status: "passed", started_at: new Date().toISOString() },
    ]);
    if (runErr) throw new Error(`seeding runs failed: ${runErr.message}`);

    fx = {
      orgA, orgB, projAssigned, projUnassigned, projOrgB,
      caseAssigned, caseUnassigned, caseOrgB,
      runAssigned, runUnassigned, runUnfiled, suiteUnassigned,
      viewerId, adminId, outsiderId,
    };

    asViewer = await clientFor(viewerEmail);
    asOutsider = await clientFor(outsiderEmail);
  }, 60_000);

  afterAll(async () => {
    if (!admin || !fx) return;
    // Organisations cascade to projects, members, runs, suites and cases. Users are separate.
    await admin.from("organisations").delete().in("id", [fx.orgA, fx.orgB]);
    for (const id of [fx.viewerId, fx.adminId, fx.outsiderId]) {
      await admin.auth.admin.deleteUser(id).catch(() => { /* best effort */ });
    }
  }, 60_000);

  // -------------------------------------------------------------------------
  // The organisation axis — this already worked, and must keep working.
  // -------------------------------------------------------------------------

  it("cannot read another organisation's cases", async () => {
    const { data } = await asViewer.from("test_cases").select("id").eq("id", fx.caseOrgB);
    expect(data).toEqual([]);
  });

  it("cannot read another organisation's runs", async () => {
    const { data } = await asOutsider.from("runs").select("id").eq("organisation_id", fx.orgA);
    expect(data).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The project axis — the half that did not exist in the database.
  // -------------------------------------------------------------------------

  it("reads a case in the project they were added to", async () => {
    const { data, error } = await asViewer.from("test_cases").select("id").eq("id", fx.caseAssigned);
    expect(error).toBeNull();
    expect(data?.map((r) => r.id)).toEqual([fx.caseAssigned]);
  });

  it("cannot read a case in a project they were NOT added to — same organisation", async () => {
    const { data } = await asViewer.from("test_cases").select("id").eq("id", fx.caseUnassigned);
    expect(data).toEqual([]);
  });

  it("cannot read the IR of a case in a project they were not added to", async () => {
    // test_case_versions is the row that matters most: it holds the full test plan — steps,
    // selectors, target URLs and ${env:...} credential references.
    const { data } = await asViewer
      .from("test_case_versions").select("ir").eq("test_case_id", fx.caseUnassigned);
    expect(data).toEqual([]);
  });

  it("cannot enumerate cases across the organisation by omitting a filter", async () => {
    const { data } = await asViewer.from("test_cases").select("id, project_id");
    const projects = new Set((data ?? []).map((r) => r.project_id));
    expect([...projects]).toEqual([fx.projAssigned]);
  });

  it("cannot read a run in a project they were not added to", async () => {
    const { data } = await asViewer.from("runs").select("id").eq("id", fx.runUnassigned);
    expect(data).toEqual([]);
  });

  it("cannot read a run with no project — those are admin-only", async () => {
    const { data } = await asViewer.from("runs").select("id").eq("id", fx.runUnfiled);
    expect(data).toEqual([]);
  });

  it("reads the run in their own project", async () => {
    const { data } = await asViewer.from("runs").select("id").eq("id", fx.runAssigned);
    expect(data?.map((r) => r.id)).toEqual([fx.runAssigned]);
  });

  it("cannot read a suite in a project they were not added to", async () => {
    const { data } = await asViewer.from("suites").select("id").eq("id", fx.suiteUnassigned);
    expect(data).toEqual([]);
  });

  it("cannot see the unassigned project itself", async () => {
    const { data } = await asViewer.from("projects").select("id");
    expect(data?.map((r) => r.id)).toEqual([fx.projAssigned]);
  });

  // -------------------------------------------------------------------------
  // Admin exemption — tightening the viewer must not scope the people who administer.
  // -------------------------------------------------------------------------

  it("an admin assigned to no project still sees every project in their organisation", async () => {
    const asAdmin = await clientFor(`${TAG}-admin@example.com`);
    const { data } = await asAdmin.from("projects").select("id").eq("organisation_id", fx.orgA);
    expect(new Set(data?.map((r) => r.id))).toEqual(new Set([fx.projAssigned, fx.projUnassigned]));
  }, 30_000);

  it("an admin sees the unfiled run the viewer cannot", async () => {
    const asAdmin = await clientFor(`${TAG}-admin@example.com`);
    const { data } = await asAdmin.from("runs").select("id").eq("id", fx.runUnfiled);
    expect(data?.map((r) => r.id)).toEqual([fx.runUnfiled]);
  }, 30_000);

  // -------------------------------------------------------------------------
  // Writes — denied by RESTRICTIVE policy, not by the absence of one.
  // -------------------------------------------------------------------------

  it("cannot insert a case, even into their own project", async () => {
    const { error } = await asViewer.from("test_cases").insert({
      project_id: fx.projAssigned, title: `${TAG}-should-not-exist`,
      ir: { meta: { title: "x", baseUrl: "https://a.example.com" }, steps: [] }, current_version: 1,
    });
    expect(error).not.toBeNull();
  });

  it("cannot update a case it can read", async () => {
    await asViewer.from("test_cases").update({ title: "hijacked" }).eq("id", fx.caseAssigned);
    // Assert on the truth, not the response: a write blocked by RLS can report zero affected rows
    // rather than an error, so the only honest check is whether the row actually changed.
    const { data } = await admin.from("test_cases").select("title").eq("id", fx.caseAssigned).single();
    expect((data as { title: string }).title).toBe(`${TAG}-visible`);
  });

  it("cannot delete a case it can read", async () => {
    await asViewer.from("test_cases").delete().eq("id", fx.caseAssigned);
    const { data } = await admin.from("test_cases").select("id").eq("id", fx.caseAssigned);
    expect(data).toHaveLength(1);
  });

  it("cannot grant itself a project membership", async () => {
    await asViewer.from("project_members").insert({ project_id: fx.projUnassigned, user_id: fx.viewerId });
    const { data } = await admin.from("project_members")
      .select("user_id").eq("project_id", fx.projUnassigned);
    expect(data).toEqual([]);
  });

  it("cannot promote itself to owner", async () => {
    await asViewer.from("organisation_members")
      .update({ role: "owner" }).eq("user_id", fx.viewerId).eq("organisation_id", fx.orgA);
    const { data } = await admin.from("organisation_members")
      .select("role").eq("user_id", fx.viewerId).eq("organisation_id", fx.orgA).single();
    expect((data as { role: string }).role).toBe("viewer");
  });
});
