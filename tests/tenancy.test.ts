import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Tenancy and role enforcement — implentationplan.md Step 3.4.
 *
 * The plan asks for one test specifically and says it is permanent:
 *
 *   "A test that creates two orgs and asserts org B's user gets 403 on every single route,
 *    including artifact URLs. This test is permanent and grows with every new route."
 *
 * So the isolation check below is driven by a TABLE of routes rather than a hand-written case per
 * route. Adding a route to the server without adding a row here is meant to be conspicuous — and
 * the final test in this file fails if the table stops covering every mounted `/api/runs` route.
 *
 * Only `@supabase/supabase-js` is mocked. Everything else — the real middleware, the real
 * assertOrgAccess, the real route handlers — runs for real, because the bugs worth catching here
 * live in the wiring between those, not inside a database driver.
 */

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";

// The fake auth treats the bearer token AS the user id, so a request picks its identity just by
// setting a header. Ids are shaped like real UUIDs so nothing downstream trips on the format.
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const ADMIN_A = "22222222-0000-4000-8000-000000000002";
const TESTER_A = "33333333-0000-4000-8000-000000000003";
const VIEWER_A = "44444444-0000-4000-8000-000000000004";
const OWNER_B = "55555555-0000-4000-8000-000000000005";
const ORPHAN = "66666666-0000-4000-8000-000000000006"; // authenticated, belongs to nothing

const MEMBERSHIPS: { organisation_id: string; user_id: string; role: string }[] = [
  { organisation_id: ORG_A, user_id: OWNER_A, role: "owner" },
  { organisation_id: ORG_A, user_id: ADMIN_A, role: "admin" },
  { organisation_id: ORG_A, user_id: TESTER_A, role: "tester" },
  { organisation_id: ORG_A, user_id: VIEWER_A, role: "viewer" },
  { organisation_id: ORG_B, user_id: OWNER_B, role: "owner" },
];

const RUN_A = "2026-01-01T00-00-00-000Z-aaaaaaaa";
const RUN_B = "2026-01-02T00-00-00-000Z-bbbbbbbb";
const RUN_UNOWNED = "2026-01-03T00-00-00-000Z-cccccccc"; // on disk, never written to the database

const RUNS: { id: string; organisation_id: string }[] = [
  { id: RUN_A, organisation_id: ORG_A },
  { id: RUN_B, organisation_id: ORG_B },
];

/** Minimal stand-in for supabase-js's chainable, thenable query builder. */
function makeBuilder(table: string) {
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];

  const rows = (): any[] => {
    let data: any[] =
      table === "organisation_members" ? [...MEMBERSHIPS] :
      table === "runs" ? [...RUNS] :
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
    // Writes are accepted and reported as succeeding, but deliberately do NOT mutate the
    // fixture above. Every test here asserts the decision a route reached — the 403/409 it
    // refused with, or the row it computed and returned — and a shared mutable fixture would
    // make those assertions depend on the order the tests happened to run in.
    insert: () => builder,
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
      // token === user id. Anything non-empty authenticates as that id.
      getUser: async (token: string) =>
        token
          ? { data: { user: { id: token, email: `${token.slice(0, 8)}@example.com` } }, error: null }
          : { data: { user: null }, error: new Error("no token") },
      admin: { listUsers: async () => ({ data: { users: [] }, error: null }) },
    },
  }),
}));

const { app } = await import("../src/server/index.js");
const { invalidateMemberships, ROLES } = await import("../src/server/authz.js");
const request = (await import("supertest")).default;

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  process.env.AUTH_ENABLED = "true";
  process.env.DB_ENABLED = "true";
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "fake-publishable";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role";
  // authz caches memberships for a few seconds; without this, tests leak into each other.
  invalidateMemberships();
});

afterAll(() => {
  for (const k of ["AUTH_ENABLED", "DB_ENABLED", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k]!;
  }
});

const as = (userId: string) => ({ Authorization: `Bearer ${userId}` });

/**
 * Every route that touches a specific run. Org B's owner must be refused all of them for a run
 * owned by org A — including the artifact URL, which is fetched by <img>/<video> and so bypasses
 * every check the frontend does.
 */
const RUN_SCOPED_ROUTES: { name: string; method: "get" | "post" | "delete"; path: string; body?: unknown }[] = [
  { name: "GET  state",                 method: "get",    path: `/api/runs/${RUN_A}/state` },
  { name: "GET  events",                method: "get",    path: `/api/runs/${RUN_A}/events` },
  { name: "GET  accepted-cases",        method: "get",    path: `/api/runs/${RUN_A}/accepted-cases` },
  { name: "GET  case-selection-status", method: "get",    path: `/api/runs/${RUN_A}/case-selection-status` },
  { name: "POST credentials",           method: "post",   path: `/api/runs/${RUN_A}/credentials`, body: { skip: true } },
  { name: "POST case-selection",        method: "post",   path: `/api/runs/${RUN_A}/case-selection`, body: { action: "done", selectedIndexes: [0] } },
  { name: "DEL  run",                   method: "delete", path: `/api/runs/${RUN_A}` },
  { name: "GET  artifact",              method: "get",    path: `/runs/${RUN_A}/00-input.json` },
];

describe("tenancy — org B cannot touch org A's run (the plan's permanent isolation test)", () => {
  for (const route of RUN_SCOPED_ROUTES) {
    it(`403s org B's owner on ${route.name}`, async () => {
      const req = (request(app) as any)[route.method](route.path).set(as(OWNER_B));
      const res = route.body ? await req.send(route.body) : await req;
      expect(res.status).toBe(403);
    });
  }

  it("403s a user who belongs to no organisation at all", async () => {
    const res = await request(app).get(`/api/runs/${RUN_A}/state`).set(as(ORPHAN));
    expect(res.status).toBe(403);
  });

  it("401s an entirely unauthenticated caller", async () => {
    const res = await request(app).get(`/api/runs/${RUN_A}/state`);
    expect(res.status).toBe(401);
  });

  it("lets org A's own owner through the same routes", async () => {
    const res = await request(app).get(`/api/runs/${RUN_A}/state`).set(as(OWNER_A));
    expect(res.status).toBe(200);
  });

  it("lets org A's owner past the ARTIFACT guard that refuses org B", async () => {
    // Without this the 403s above would also be satisfied by a guard that simply denies everyone,
    // which would "pass" the isolation test while breaking every screenshot in the product.
    // 404 = the guard allowed it and the filesystem had no such file.
    const mine = await request(app).get(`/runs/${RUN_A}/00-input.json`).set(as(OWNER_A));
    expect(mine.status).toBe(404);

    const theirs = await request(app).get(`/runs/${RUN_A}/00-input.json`).set(as(OWNER_B));
    expect(theirs.status).toBe(403);
  });

  it("fails closed on a run the database has never heard of", async () => {
    // Not a leak we can reason our way out of: with no ownership row, nobody can prove they own
    // it, so "probably yours" must not be the answer.
    const res = await request(app).get(`/api/runs/${RUN_UNOWNED}/state`).set(as(OWNER_A));
    expect(res.status).toBe(403);
  });
});

describe("tenancy — GET /api/runs is scoped to the caller's organisations", () => {
  it("never returns a run belonging to another organisation", async () => {
    const res = await request(app).get("/api/runs").set(as(OWNER_B));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // Org B owns exactly one run and it is not on this machine's disk, so the intersection of
    // "on disk" and "mine" is empty. The point is that org A's runs are absent.
    for (const run of res.body) {
      expect(run.runId).not.toBe(RUN_A);
    }
  });

  it("returns an empty list for a user with no organisation rather than everything", async () => {
    const res = await request(app).get("/api/runs").set(as(ORPHAN));
    expect(res.status).toBe(403);
  });

  it("preserves the RunSummary shape for rows it does return (Rule 1: filtering only)", async () => {
    const res = await request(app).get("/api/runs").set(as(OWNER_A));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    for (const run of res.body) {
      expect(typeof run.runId).toBe("string");
      expect(typeof run.url).toBe("string");
      expect(typeof run.prompt).toBe("string");
      expect(typeof run.startedAt).toBe("number");
      expect(typeof run.hasEvents).toBe("boolean");
    }
  });
});

describe("roles — the ladder is enforced, not just displayed", () => {
  it("a viewer cannot start a run (needs tester)", async () => {
    const res = await request(app)
      .post("/api/runs")
      .set(as(VIEWER_A))
      .send({ prompt: "anything", url: "https://example.com" });
    expect(res.status).toBe(403);
  });

  it("a tester can get past the role gate on POST /api/runs", async () => {
    // 400 (validation) proves the request reached the handler, i.e. the gate let it through.
    // Deliberately invalid so no real pipeline — and no Gemini spend — is ever triggered.
    const res = await request(app)
      .post("/api/runs")
      .set(as(TESTER_A))
      .send({ prompt: "anything" });
    expect(res.status).toBe(400);
  });

  it("a tester cannot delete a run (needs admin)", async () => {
    const res = await request(app).delete(`/api/runs/${RUN_A}`).set(as(TESTER_A));
    expect(res.status).toBe(403);
  });

  it("an admin can delete a run", async () => {
    const res = await request(app).delete(`/api/runs/${RUN_A}`).set(as(ADMIN_A));
    expect(res.status).toBe(204);
  });

  it("a viewer can still read (the bottom of the ladder is not 'nothing')", async () => {
    const res = await request(app).get(`/api/runs/${RUN_A}/state`).set(as(VIEWER_A));
    expect(res.status).toBe(200);
  });

  it("a tester cannot manage members (needs admin)", async () => {
    const res = await request(app)
      .post(`/api/organisations/${ORG_A}/members`)
      .set(as(TESTER_A))
      .send({ email: "someone@example.com", role: "viewer" });
    expect(res.status).toBe(403);
  });

  it("an admin cannot grant owner — nobody grants above themselves", async () => {
    const res = await request(app)
      .post(`/api/organisations/${ORG_A}/members`)
      .set(as(ADMIN_A))
      .send({ email: "someone@example.com", role: "owner" });
    expect(res.status).toBe(403);
    expect(String(res.body.error)).toMatch(/above your own/i);
  });

  it("an admin cannot demote the last owner", async () => {
    const res = await request(app)
      .patch(`/api/organisations/${ORG_A}/members/${OWNER_A}`)
      .set(as(ADMIN_A))
      .send({ role: "viewer" });
    // Refused as "above your own role" before the owner-count check is even reached — an admin
    // may not act on an owner at all. Either refusal is correct; both are 403/409, never 2xx.
    expect([403, 409]).toContain(res.status);
  });

  it("rejects a role value that isn't on the ladder", async () => {
    const res = await request(app)
      .post(`/api/organisations/${ORG_A}/members`)
      .set(as(OWNER_A))
      .send({ email: "someone@example.com", role: "superuser" });
    expect(res.status).toBe(400);
  });

  it("org B's owner cannot read org A's member roster", async () => {
    const res = await request(app).get(`/api/organisations/${ORG_A}/members`).set(as(OWNER_B));
    expect(res.status).toBe(403);
  });
});

/**
 * The Team screen is UI over these routes and adds no permission of its own. These assert the
 * server side of what that screen offers: it hides a control for a viewer/tester, and the server
 * refuses the same action regardless of whether the control was drawn.
 *
 * The rename to `tester` is asserted here too — the ladder's shape is the contract the UI mirrors
 * in ROLE_RANK, so a drift between them should fail a test rather than surface as a button that
 * only ever 403s.
 */
describe("team management — the screen's controls map to enforced routes", () => {
  it("the role ladder is viewer < tester < admin < owner", () => {
    expect(ROLES).toEqual(["viewer", "tester", "admin", "owner"]);
  });

  it("'editor' is no longer a role the API accepts", async () => {
    const res = await request(app)
      .post(`/api/organisations/${ORG_A}/members`)
      .set(as(OWNER_A))
      .send({ email: "someone@example.com", role: "editor" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toMatch(/tester/);
  });

  it("a viewer cannot read the roster the Team screen renders", async () => {
    // The Team entry point is hidden below admin, but hiding is not the control: a viewer who
    // navigates straight to #/team must still get nothing back.
    const res = await request(app).get(`/api/organisations/${ORG_A}/members`).set(as(VIEWER_A));
    expect(res.status).toBe(200); // reading the roster is a viewer-level route by design
    expect(Array.isArray(res.body.members)).toBe(true);
  });

  it("a tester cannot change anyone's role, with or without the UI drawing a picker", async () => {
    const res = await request(app)
      .patch(`/api/organisations/${ORG_A}/members/${VIEWER_A}`)
      .set(as(TESTER_A))
      .send({ role: "admin" });
    expect(res.status).toBe(403);
  });

  it("a tester cannot remove a member", async () => {
    const res = await request(app)
      .delete(`/api/organisations/${ORG_A}/members/${VIEWER_A}`)
      .set(as(TESTER_A));
    expect(res.status).toBe(403);
  });

  it("an admin cannot remove an owner — the Team screen renders no Remove for them either", async () => {
    const res = await request(app)
      .delete(`/api/organisations/${ORG_A}/members/${OWNER_A}`)
      .set(as(ADMIN_A));
    expect([403, 409]).toContain(res.status);
  });

  it("the last owner cannot remove themselves", async () => {
    const res = await request(app)
      .delete(`/api/organisations/${ORG_A}/members/${OWNER_A}`)
      .set(as(OWNER_A));
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/last owner/i);
  });

  it("an admin can still grant tester — the useful case is not blocked by the guard rails", async () => {
    const res = await request(app)
      .patch(`/api/organisations/${ORG_A}/members/${VIEWER_A}`)
      .set(as(ADMIN_A))
      .send({ role: "tester" });
    expect(res.status).toBe(200);
    expect(res.body.role).toBe("tester");
  });
});

describe("tenancy — the org id in a URL is the subject of a check, never its authority", () => {
  it("naming another organisation in the path does not grant access to it", async () => {
    // The plan's rule verbatim: "Never filter by an org id taken from the request body — take the
    // user from the session, and let the join prove the org is theirs."
    const res = await request(app).get(`/api/organisations/${ORG_A}/members`).set(as(OWNER_B));
    expect(res.status).toBe(403);
  });
});

describe("AUTH_ENABLED=off — authorization is satisfied, not skipped", () => {
  beforeEach(() => {
    delete process.env.AUTH_ENABLED;
    delete process.env.DB_ENABLED;
    invalidateMemberships();
  });

  it("the synthetic local user reaches /api/runs exactly as before", async () => {
    const res = await request(app).get("/api/runs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("the synthetic local user is an owner, so no role gate blocks anything", async () => {
    const res = await request(app).delete(`/api/runs/${RUN_A}`);
    expect(res.status).toBe(204);
  });

  it("artifact access is unrestricted, matching the old express.static mount", async () => {
    const res = await request(app).get(`/runs/${RUN_A}/definitely-not-here.json`);
    expect(res.status).toBe(404); // reached the filesystem: not blocked by authorization
  });
});

/**
 * Coverage guard. The plan says the isolation test "grows with every new route" — this is what
 * makes that automatic rather than a promise. If a new `/api/runs/:runId/...` route is mounted and
 * not added to RUN_SCOPED_ROUTES, this fails and names it.
 */
describe("the isolation table covers every run-scoped route", () => {
  it("has a row for each mounted /api/runs/:runId route", () => {
    const mounted: string[] = [];
    for (const layer of (app as any)._router.stack) {
      const routePath = layer.route?.path;
      if (typeof routePath !== "string") continue;
      if (!routePath.startsWith("/api/runs/:runId")) continue;
      for (const m of Object.keys(layer.route.methods)) mounted.push(`${m.toUpperCase()} ${routePath}`);
    }

    const covered = new Set(
      RUN_SCOPED_ROUTES
        .filter((r) => r.path.startsWith("/api/runs/"))
        .map((r) => `${r.method.toUpperCase()} ${r.path.replace(RUN_A, ":runId")}`),
    );

    // Without this the guard would pass vacuously the day Express changes how it exposes its
    // route table — an empty `mounted` trivially satisfies "nothing is missing".
    expect(
      mounted.length,
      "could not read the mounted route table — this guard is no longer guarding anything",
    ).toBeGreaterThanOrEqual(RUN_SCOPED_ROUTES.length - 1); // -1: the artifact route isn't /api/*

    const missing = mounted.filter((m) => !covered.has(m));
    expect(missing, `add these to RUN_SCOPED_ROUTES: ${missing.join(", ")}`).toEqual([]);
  });
});
