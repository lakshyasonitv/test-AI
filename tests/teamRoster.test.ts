import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The Team screen's data, scoped by shared projects (DECISIONS.md D-36).
 *
 *   - owner / admin: every member of the organisation, every assignment — unchanged.
 *   - anyone else:   themselves, plus members who share at least one project with them IN THIS
 *                    ORGANISATION; and only chips for projects they are in themselves.
 *   - adding to / removing from a project: owner and admin only (403 for everyone else).
 *
 * Enforced in the route, not the UI: every assertion here calls the API directly, the way a tester
 * with devtools open would.
 *
 * Own fixture rather than tenancy.test.ts's: that one is shared by dozens of assertions that pin
 * its exact rows, and this needs a multi-organisation member, a project-less member and a stale
 * assignment that it does not have. Same mocking technique — only `@supabase/supabase-js` is
 * faked; the real middleware, `visibleProjectIds` and route handlers all run.
 *
 * RLS is NOT covered here — a fake client never asks Postgres anything. The matching policy is
 * covered by tests/rlsPolicies.integration.test.ts (`npm run test:rls`, against a real database).
 */

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";

const OWNER_A = "11111111-0000-4000-8000-000000000001";
const ADMIN_A = "22222222-0000-4000-8000-000000000002";
const TESTER_A = "33333333-0000-4000-8000-000000000003"; // in org A AND org B
const PEER_1 = "44444444-0000-4000-8000-000000000004";   // in org A AND org B; shares P1 with TESTER_A
const VIEWER_2 = "55555555-0000-4000-8000-000000000005"; // shares P2 with TESTER_A
const OUTSIDE_3 = "66666666-0000-4000-8000-000000000006"; // only in P3, which TESTER_A is not in
const LONELY = "77777777-0000-4000-8000-000000000007";   // a tester assigned to no project
const LEFT = "88888888-0000-4000-8000-000000000008";     // removed from org A; stale P1 row remains
const OWNER_B = "99999999-0000-4000-8000-000000000009";

const P1 = "aaaa1111-0000-4000-8000-00000000a001";
const P2 = "aaaa2222-0000-4000-8000-00000000a002";
const P3 = "aaaa3333-0000-4000-8000-00000000a003";
const PB1 = "bbbb1111-0000-4000-8000-00000000b001";

const MEMBERSHIPS = [
  { organisation_id: ORG_A, user_id: OWNER_A, role: "owner" },
  { organisation_id: ORG_A, user_id: ADMIN_A, role: "admin" },
  { organisation_id: ORG_A, user_id: TESTER_A, role: "tester" },
  { organisation_id: ORG_A, user_id: PEER_1, role: "tester" },
  { organisation_id: ORG_A, user_id: VIEWER_2, role: "viewer" },
  { organisation_id: ORG_A, user_id: OUTSIDE_3, role: "tester" },
  { organisation_id: ORG_A, user_id: LONELY, role: "tester" },
  { organisation_id: ORG_B, user_id: OWNER_B, role: "owner" },
  { organisation_id: ORG_B, user_id: TESTER_A, role: "tester" },
  { organisation_id: ORG_B, user_id: PEER_1, role: "viewer" },
];
const ORG_A_IDS = MEMBERSHIPS.filter((m) => m.organisation_id === ORG_A).map((m) => m.user_id);

const PROJECTS = [
  { id: P1, organisation_id: ORG_A, name: "THINKVIBES", base_url: "https://tv.example.com" },
  { id: P2, organisation_id: ORG_A, name: "LMS", base_url: "https://lms.example.com" },
  { id: P3, organisation_id: ORG_A, name: "SECRET", base_url: "https://secret.example.com" },
  { id: PB1, organisation_id: ORG_B, name: "ORG-B", base_url: "https://b.example.com" },
];

/** `projects.organisation_id` is literal — see tests/tenancy.test.ts for why the fake needs it. */
const pm = (project_id: string, user_id: string, org: string) =>
  ({ project_id, user_id, "projects.organisation_id": org });
const PROJECT_MEMBERS = [
  pm(P1, TESTER_A, ORG_A), pm(P1, PEER_1, ORG_A), pm(P1, LEFT, ORG_A),
  pm(P2, TESTER_A, ORG_A), pm(P2, VIEWER_2, ORG_A),
  pm(P3, PEER_1, ORG_A), pm(P3, OUTSIDE_3, ORG_A),
  pm(PB1, TESTER_A, ORG_B),
];

const DIRECTORY = [OWNER_A, ADMIN_A, TESTER_A, PEER_1, VIEWER_2, OUTSIDE_3, LONELY, LEFT, OWNER_B]
  .map((id) => ({ id, email: `${id.slice(0, 8)}@example.com` }));

/** Minimal stand-in for supabase-js's chainable, thenable query builder (as tenancy.test.ts). */
function makeBuilder(table: string) {
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  const rows = (): any[] => {
    let data: any[] =
      table === "organisation_members" ? [...MEMBERSHIPS] :
      table === "projects" ? [...PROJECTS] :
      table === "project_members" ? [...PROJECT_MEMBERS] :
      [];
    for (const [col, val] of eqs) data = data.filter((r) => r[col] === val);
    for (const [col, vals] of ins) data = data.filter((r) => vals.includes(r[col]));
    return data;
  };
  const builder: any = {
    select: () => builder,
    eq: (col: string, val: unknown) => { eqs.push([col, val]); return builder; },
    in: (col: string, vals: unknown[]) => { ins.push([col, vals]); return builder; },
    order: () => builder,
    limit: () => builder,
    // Writes succeed without mutating the fixture, so no test depends on another's order.
    insert: () => builder,
    upsert: () => builder,
    update: () => builder,
    delete: () => builder,
    maybeSingle: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    single: () => Promise.resolve({ data: rows()[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null }),
  };
  return builder;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => makeBuilder(table),
    auth: {
      getUser: async (token: string) =>
        token
          ? { data: { user: { id: token, email: `${token.slice(0, 8)}@example.com` } }, error: null }
          : { data: { user: null }, error: new Error("no token") },
      admin: { listUsers: async () => ({ data: { users: DIRECTORY }, error: null }) },
    },
  }),
}));

const { app } = await import("../src/server/index.js");
const { invalidateMemberships } = await import("../src/server/authz.js");
const request = (await import("supertest")).default;

const ENV_KEYS = ["AUTH_ENABLED", "DB_ENABLED", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"];
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

beforeEach(() => {
  process.env.AUTH_ENABLED = "true";
  process.env.DB_ENABLED = "true";
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "fake-publishable";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role";
  invalidateMemberships();
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k]!;
  }
});

const as = (userId: string) => ({ Authorization: `Bearer ${userId}` });

async function roster(viewer: string, org: string): Promise<string[]> {
  const res = await request(app).get(`/api/organisations/${org}/members`).set(as(viewer));
  expect(res.status).toBe(200);
  return res.body.members.map((m: { userId: string }) => m.userId).sort();
}

async function assignments(viewer: string, org: string): Promise<Record<string, string[]>> {
  const res = await request(app).get(`/api/organisations/${org}/assignments`).set(as(viewer));
  expect(res.status).toBe(200);
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(res.body.assignments as Record<string, string[]>)) out[k] = [...v].sort();
  return out;
}

const sorted = (ids: string[]) => [...ids].sort();

// ---------------------------------------------------------------------------------------------

describe("GET /api/organisations/:orgId/members — who sees whom", () => {
  it("owner sees every member of the organisation", async () => {
    expect(await roster(OWNER_A, ORG_A)).toEqual(sorted(ORG_A_IDS));
  });

  it("admin sees every member of the organisation", async () => {
    expect(await roster(ADMIN_A, ORG_A)).toEqual(sorted(ORG_A_IDS));
  });

  it("tester sees only themselves plus members who share a project with them", async () => {
    // P1 -> PEER_1, P2 -> VIEWER_2. Not OUTSIDE_3 (P3 only), not LONELY, not the admin/owner
    // (not assigned to a shared project), and not LEFT (not a member any more).
    expect(await roster(TESTER_A, ORG_A)).toEqual(sorted([TESTER_A, PEER_1, VIEWER_2]));
  });

  it("tester with no projects sees only themselves", async () => {
    expect(await roster(LONELY, ORG_A)).toEqual([LONELY]);
  });

  it("viewer gets the same scoping as a tester", async () => {
    expect(await roster(VIEWER_2, ORG_A)).toEqual(sorted([VIEWER_2, TESTER_A]));
  });

  it("is scoped PER ORGANISATION — sharing a project in org A reveals nothing in org B", async () => {
    // TESTER_A and PEER_1 share P1 in org A and are BOTH members of org B, but share no project
    // there. Each must see only themselves in org B.
    expect(await roster(PEER_1, ORG_B)).toEqual([PEER_1]);
    expect(await roster(TESTER_A, ORG_B)).toEqual([TESTER_A]);
  });

  it("returns full member rows (email, role) for the people it does return", async () => {
    const res = await request(app).get(`/api/organisations/${ORG_A}/members`).set(as(TESTER_A));
    const peer = res.body.members.find((m: { userId: string }) => m.userId === PEER_1);
    expect(peer).toMatchObject({ userId: PEER_1, role: "tester", email: expect.stringContaining("@") });
  });

  it("still refuses a different organisation's roster outright", async () => {
    const res = await request(app).get(`/api/organisations/${ORG_A}/members`).set(as(OWNER_B));
    expect(res.status).toBe(403);
  });
});

describe("GET /api/organisations/:orgId/assignments — chips only for shared projects", () => {
  it("owner and admin get every assignment, exactly as before", async () => {
    const full = await assignments(OWNER_A, ORG_A);
    expect(full[PEER_1]).toEqual(sorted([P1, P3]));
    expect(full[OUTSIDE_3]).toEqual([P3]);
    expect(await assignments(ADMIN_A, ORG_A)).toEqual(full);
  });

  it("tester gets only projects they are in, for only the people they can see", async () => {
    expect(await assignments(TESTER_A, ORG_A)).toEqual({
      [TESTER_A]: sorted([P1, P2]),
      [PEER_1]: [P1],          // NOT P3 — the tester is not in it, so must not learn it exists
      [VIEWER_2]: [P2],
    });
  });

  it("viewer sees their co-member's chips cut to the projects THEY share", async () => {
    // TESTER_A is in P1 and P2; VIEWER_2 is only in P2, so P1 must not appear.
    expect(await assignments(VIEWER_2, ORG_A)).toEqual({ [VIEWER_2]: [P2], [TESTER_A]: [P2] });
  });

  it("tester with no projects gets an empty map", async () => {
    expect(await assignments(LONELY, ORG_A)).toEqual({});
  });

  it("a removed member's leftover project row is never exposed to a non-admin", async () => {
    expect(Object.keys(await assignments(TESTER_A, ORG_A))).not.toContain(LEFT);
  });

  it("is scoped per organisation too", async () => {
    expect(await assignments(PEER_1, ORG_B)).toEqual({});
    expect(await assignments(TESTER_A, ORG_B)).toEqual({ [TESTER_A]: [PB1] });
  });

  it("the roster and the chips agree: everyone with chips is someone you can see", async () => {
    for (const viewer of [TESTER_A, VIEWER_2, LONELY, PEER_1]) {
      const people = new Set(await roster(viewer, ORG_A));
      for (const id of Object.keys(await assignments(viewer, ORG_A))) expect(people.has(id)).toBe(true);
    }
  });
});

describe("project membership — only owner and admin may add or remove", () => {
  const add = (who: string, project: string, target: string) =>
    request(app).post(`/api/projects/${project}/members`).set(as(who)).send({ userId: target });
  const remove = (who: string, project: string, target: string) =>
    request(app).delete(`/api/projects/${project}/members/${target}`).set(as(who));

  it("tester gets 403 calling add-to-project directly", async () => {
    expect((await add(TESTER_A, P1, LONELY)).status).toBe(403);
  });

  it("tester gets 403 calling remove-from-project directly", async () => {
    expect((await remove(TESTER_A, P1, PEER_1)).status).toBe(403);
  });

  it("being IN the project gives a tester no extra right to manage it", async () => {
    // TESTER_A is a member of P1 — still 403, because membership is visibility, not authority.
    expect((await add(TESTER_A, P1, OUTSIDE_3)).status).toBe(403);
    expect((await remove(TESTER_A, P1, TESTER_A)).status).toBe(403);
  });

  it("viewer gets 403 on both", async () => {
    expect((await add(VIEWER_2, P2, LONELY)).status).toBe(403);
    expect((await remove(VIEWER_2, P2, TESTER_A)).status).toBe(403);
  });

  it("owner and admin are allowed (so the 403s above are not a guard that refuses everyone)", async () => {
    expect((await add(ADMIN_A, P1, LONELY)).status).toBe(201);
    expect((await remove(ADMIN_A, P1, PEER_1)).status).toBe(204);
    expect((await add(OWNER_A, P2, LONELY)).status).toBe(201);
    expect((await remove(OWNER_A, P2, VIEWER_2)).status).toBe(204);
  });

  it("role change and member removal stay admin-only (unchanged, pinned here for the Team screen)", async () => {
    const patch = await request(app).patch(`/api/organisations/${ORG_A}/members/${PEER_1}`)
      .set(as(TESTER_A)).send({ role: "viewer" });
    expect(patch.status).toBe(403);
    const del = await request(app).delete(`/api/organisations/${ORG_A}/members/${PEER_1}`).set(as(TESTER_A));
    expect(del.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------------------------

describe("Team screen wiring in public/app.js (source checks — the server is the real control)", () => {
  const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const team = APP.slice(APP.indexOf("async function renderTeamView("), APP.indexOf("function teamFeedback("));

  it("the Team button is shown to any signed-in member with a role, not only admins", () => {
    expect(APP).toContain("const showTeam = auth.required && !!auth.token && !!auth.role;");
  });

  it("the chip × and the add-to-project picker are drawn only for admins", () => {
    expect(team).toMatch(/\$\{isAdmin \? `\s*<button type="button" class="team-chip-x"/);
    expect(team).toContain("${isAdmin && allProjects.length > mine.length ? `");
  });

  it("assignments are fetched for every role, no longer only inside an admin branch", () => {
    expect(team).not.toMatch(/if \(isAdmin\) \{\s*const \[aRes, pRes\]/);
    expect(team).toContain("/assignments`)");
  });
});
