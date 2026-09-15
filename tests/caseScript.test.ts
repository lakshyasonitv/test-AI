import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * `GET /api/cases/:caseId/script` — a saved case must always be able to show its script.
 *
 * THE DEFECT (TECH_DEBT.md TD-68). The `.spec.ts` used to exist in exactly one place: the artifact
 * folder of the run it came from. The Script tab fetched it from there. But run folders are
 * deleted — `DELETE /api/runs/:runId` does an `rmSync`, retention does the same on a timer, and
 * `runs/` is gitignored so a fresh clone has none at all. The result was a case that reported
 * "Passed v1" in one tab and "No script yet" in the next. Real example: case "Navigate to the FAQ
 * page" pointed at run `2026-09-01T09-43-27-050Z-e900b8d9`, whose folder no longer exists.
 *
 * So the test that matters is not "does the route return something" — it is **delete the run and
 * then ask**, which is what `describe("after the run directory is deleted")` below does.
 *
 * `generateSpec` is deliberately NOT mocked here (library.test.ts does mock it). The whole promise
 * of the fallback is that a regenerated spec is the *same* spec, and that is only meaningful when
 * the real generator runs. The Supabase client is mocked the way library.test.ts mocks it.
 */

/**
 * A fixed id, so this file deletes exactly what it created. library.test.ts records the same
 * hazard: a run directory left behind is not inert debris — history reads the newest directories
 * off disk, so accumulated test runs push the user's real runs out of the visible window.
 */
const TEST_RUN_ID = "2026-01-03T00-00-00-000Z-cafe0001";
const runDir = path.join("runs", TEST_RUN_ID);

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const OWNER = "11111111-0000-4000-8000-000000000001";
const OUTSIDER = "99999999-0000-4000-8000-000000000009";
const PROJ = "aaaa1111-0000-4000-8000-00000000a001";

/** Distinctive targets, so "the spec really is this case's" is a checkable claim, not a vibe. */
const FIXTURE_IR = {
  meta: {
    feature: "navigation",
    title: "Navigate to the FAQ page",
    priority: "medium",
    sourcePrompt: "check the FAQ link",
    baseUrl: "https://example.com",
  },
  steps: [
    { id: "s1", action: "navigate", target: { url: "https://example.com/" } },
    { id: "s2", action: "click", target: { role: "link", name: "Frequently Asked Questions" } },
    { id: "s3", action: "assert", assertion: "url_contains", value: "/faq" },
  ],
};

interface Tables {
  organisation_members: any[];
  projects: any[];
  project_members: any[];
  runs: any[];
  suites: any[];
  test_cases: any[];
  test_case_versions: any[];
  suite_cases: any[];
  run_cases: any[];
}

let db: Tables;

function reset() {
  db = {
    organisation_members: [
      { organisation_id: ORG, user_id: OWNER, role: "owner" },
      { organisation_id: ORG, user_id: OUTSIDER, role: "viewer" },
    ],
    projects: [{ id: PROJ, organisation_id: ORG, name: "example.com", base_url: "https://example.com" }],
    project_members: [],
    // `POST /api/runs/:runId/cases/:caseId/save` is guarded by requireRunRole, which resolves the
    // org from the RUN row. Without this the save 403s before it ever reads the fixture on disk.
    runs: [{ id: TEST_RUN_ID, organisation_id: ORG, project_id: PROJ, started_by: OWNER }],
    suites: [],
    test_cases: [],
    test_case_versions: [],
    suite_cases: [],
    run_cases: [],
  };
}

/** Chainable stand-in for supabase-js's builder, backed by a mutable in-memory store. */
function makeBuilder(table: keyof Tables) {
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  let pending: { kind: "insert" | "update" | "upsert" | "delete"; payload?: any } | null = null;
  let single = false;

  const match = (r: any) =>
    eqs.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c]));

  const run = () => {
    const rows = db[table] as any[];
    if (pending?.kind === "insert" || pending?.kind === "upsert") {
      const payloads = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      // A uuid, because that is what the column is: `id uuid not null default gen_random_uuid()`.
      // A fake id of any other shape would sail through this mock and be rejected by the real
      // `app.param("caseId")` validator, so the fixture has to mint the shape production mints.
      const made = payloads.map((p: any) => ({ id: p.id ?? randomUUID(), ...p }));
      rows.push(...made);
      return { data: single ? made[0] : made, error: null };
    }
    if (pending?.kind === "update") {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, pending.payload);
      return { data: single ? hit[0] ?? null : hit, error: null };
    }
    if (pending?.kind === "delete") {
      db[table] = rows.filter((r) => !match(r)) as any;
      return { data: null, error: null };
    }
    const found = rows.filter(match);
    return { data: single ? found[0] ?? null : found, error: null };
  };

  const builder: any = {
    select: () => builder,
    eq: (c: string, v: unknown) => { eqs.push([c, v]); return builder; },
    in: (c: string, v: unknown[]) => { ins.push([c, v]); return builder; },
    order: () => builder,
    limit: () => builder,
    insert: (p: any) => { pending = { kind: "insert", payload: p }; return builder; },
    update: (p: any) => { pending = { kind: "update", payload: p }; return builder; },
    upsert: (p: any) => { pending = { kind: "upsert", payload: p }; return builder; },
    delete: () => { pending = { kind: "delete" }; return builder; },
    single: () => { single = true; return Promise.resolve(run()); },
    maybeSingle: () => { single = true; return Promise.resolve(run()); },
    then: (resolve: any, reject: any) => Promise.resolve(run()).then(resolve, reject),
  };
  return builder;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => makeBuilder(table as keyof Tables),
    auth: { admin: { listUsers: async () => ({ data: { users: [] } }) } },
  }),
}));

process.env.AUTH_ENABLED = "true";
process.env.DB_ENABLED = "true";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

vi.mock("../src/server/auth.js", async (orig) => {
  const actual = await orig<any>();
  return {
    ...actual,
    isAuthEnabled: () => true,
    resolveUser: async (req: any) => {
      const t = (req.headers?.authorization ?? "").replace(/^Bearer\s+/i, "");
      return t ? { id: t, email: `${t}@example.com`, synthetic: false } : null;
    },
    requireAuth: async (req: any, res: any, next: any) => {
      const t = (req.headers?.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!t) return res.status(401).json({ error: "authentication required" });
      req.user = { id: t, email: `${t}@example.com`, synthetic: false };
      next();
    },
  };
});

const { app } = await import("../src/server/index.js");
const request = (await import("supertest")).default;
const { invalidateMemberships } = await import("../src/server/authz.js");
// The REAL generator — the byte-identity assertions below are worthless against a mock.
const { generateSpec } = await import("../src/stages/generator.js");

const as = (userId: string) => ({ Authorization: `Bearer ${userId}` });

function makeRunFixture() {
  const caseDir = path.join(runDir, "cases", "case-0");
  mkdirSync(caseDir, { recursive: true });
  // Per-case file is a BARE ir; the run-level one wraps it as {ir, updatedAppModel}.
  writeFileSync(path.join(caseDir, "04-ir.json"), JSON.stringify(FIXTURE_IR, null, 2));
  writeFileSync(
    path.join(caseDir, "generated.spec.ts"),
    "// the run's own artifact — deliberately different from what the generator produces\n",
  );
}

const cleanup = () => { try { rmSync(runDir, { recursive: true, force: true }); } catch { /* already gone */ } };

async function saveCaseFromFixtureRun(): Promise<string> {
  const res = await request(app)
    .post(`/api/runs/${TEST_RUN_ID}/cases/case-0/save`)
    .set(as(OWNER))
    .send({ projectId: PROJ });
  expect(res.status).toBe(201); // the save route answers 201 Created
  return res.body.id as string;
}

beforeEach(() => {
  reset();
  invalidateMemberships();
  cleanup();
  makeRunFixture();
});

afterAll(cleanup);

describe("GET /api/cases/:caseId/script", () => {
  it("returns the spec stored with the version at save time", async () => {
    const caseId = await saveCaseFromFixtureRun();

    const res = await request(app).get(`/api/cases/${caseId}/script`).set(as(OWNER));
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("stored");
    expect(res.body.version).toBe(1);
    expect(res.body.spec).toBe(generateSpec(FIXTURE_IR as any, "artifacts"));
  });

  it("persists that spec onto the version row, not just the case", async () => {
    await saveCaseFromFixtureRun();
    const v1 = db.test_case_versions.find((v) => v.version === 1);
    expect(typeof v1.spec).toBe("string");
    expect(v1.spec.length).toBeGreaterThan(0);
  });

  describe("after the run directory is deleted — the actual bug", () => {
    it("still returns a complete, non-empty script", async () => {
      const caseId = await saveCaseFromFixtureRun();
      rmSync(runDir, { recursive: true, force: true });
      expect(existsSync(runDir)).toBe(false);

      const res = await request(app).get(`/api/cases/${caseId}/script`).set(as(OWNER));
      expect(res.status).toBe(200);
      expect(res.body.spec.trim().length).toBeGreaterThan(0);
    });

    it("returns a script carrying this case's own step targets", async () => {
      const caseId = await saveCaseFromFixtureRun();
      rmSync(runDir, { recursive: true, force: true });

      const { spec } = (await request(app).get(`/api/cases/${caseId}/script`).set(as(OWNER))).body;
      // The distinguishing content: this case's URL, its link name, and its assertion value.
      expect(spec).toContain("https://example.com/");
      expect(spec).toContain("Frequently Asked Questions");
      expect(spec).toContain("/faq");
      expect(spec).toContain("@playwright/test");
    });

    it("regenerates byte-identically when the version row carries no stored spec", async () => {
      const caseId = await saveCaseFromFixtureRun();
      rmSync(runDir, { recursive: true, force: true });

      // Exactly the pre-migration state: a row written before the `spec` column existed. Those
      // rows are deliberately NOT backfilled, so this path stays live for every historical case.
      for (const v of db.test_case_versions) v.spec = null;

      const res = await request(app).get(`/api/cases/${caseId}/script`).set(as(OWNER));
      expect(res.status).toBe(200);
      expect(res.body.source).toBe("generated");
      expect(res.body.spec).toBe(generateSpec(FIXTURE_IR as any, "artifacts"));
    });

    it("regenerates identically whether the column is null or missing entirely", async () => {
      const caseId = await saveCaseFromFixtureRun();
      rmSync(runDir, { recursive: true, force: true });
      for (const v of db.test_case_versions) delete v.spec;

      const res = await request(app).get(`/api/cases/${caseId}/script`).set(as(OWNER));
      expect(res.status).toBe(200);
      expect(res.body.spec).toBe(generateSpec(FIXTURE_IR as any, "artifacts"));
    });
  });

  describe("?version=N", () => {
    it("returns the requested older version, not the current one", async () => {
      const caseId = await saveCaseFromFixtureRun();

      const edited = {
        ...FIXTURE_IR,
        steps: [
          { id: "s1", action: "navigate", target: { url: "https://example.com/" } },
          { id: "s2", action: "click", target: { role: "link", name: "Contact Support" } },
        ],
      };
      const patch = await request(app).patch(`/api/cases/${caseId}`).set(as(OWNER)).send({ ir: edited });
      expect(patch.status).toBe(200);

      const v2 = (await request(app).get(`/api/cases/${caseId}/script`).set(as(OWNER))).body;
      expect(v2.version).toBe(2);
      expect(v2.spec).toContain("Contact Support");

      const v1 = (await request(app).get(`/api/cases/${caseId}/script?version=1`).set(as(OWNER))).body;
      expect(v1.version).toBe(1);
      expect(v1.spec).toContain("Frequently Asked Questions");
      expect(v1.spec).not.toContain("Contact Support");
    });

    it("400s a version that is not a positive integer", async () => {
      const caseId = await saveCaseFromFixtureRun();
      for (const bad of ["0", "-1", "abc", "1.5"]) {
        const res = await request(app).get(`/api/cases/${caseId}/script?version=${bad}`).set(as(OWNER));
        expect(res.status).toBe(400);
      }
    });

    it("404s a version that does not exist", async () => {
      const caseId = await saveCaseFromFixtureRun();
      const res = await request(app).get(`/api/cases/${caseId}/script?version=99`).set(as(OWNER));
      expect(res.status).toBe(404);
    });
  });

  describe("access", () => {
    it("404s a case the caller cannot see", async () => {
      const caseId = await saveCaseFromFixtureRun();
      // A viewer with no project membership cannot see PROJ, so the case must not resolve.
      const res = await request(app).get(`/api/cases/${caseId}/script`).set(as(OUTSIDER));
      expect([403, 404]).toContain(res.status);
    });

    it("401s an unauthenticated caller", async () => {
      const caseId = await saveCaseFromFixtureRun();
      expect((await request(app).get(`/api/cases/${caseId}/script`)).status).toBe(401);
    });

    it("404s an unknown case id", async () => {
      const res = await request(app)
        .get("/api/cases/c0000000-0000-4000-8000-00000000dead/script").set(as(OWNER));
      expect(res.status).toBe(404);
    });
  });
});
