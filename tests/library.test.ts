import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rmSync } from "node:fs";
import path from "node:path";

/**
 * The test-case library — implentationplan.md Steps 5.2, 5.3, 5.5.
 *
 * Unlike tenancy.test.ts, whose mock deliberately refuses to mutate (every assertion there is
 * about a *decision*, and a shared mutable fixture would make tests order-dependent), this file
 * needs writes to actually land: suite ordering, many-to-many membership and version history are
 * only meaningful if a write is readable afterwards. So the mock below is a small mutable
 * in-memory store, reset before each test.
 *
 * What is deliberately NOT mocked: library.ts, replay.ts, the real route handlers and the real
 * authz middleware. The bugs worth catching live in the wiring between those.
 */

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const OWNER = "11111111-0000-4000-8000-000000000001";
const TESTER = "33333333-0000-4000-8000-000000000003";
const VIEWER = "44444444-0000-4000-8000-000000000004";

const PROJ_1 = "aaaa1111-0000-4000-8000-00000000a001";
const PROJ_2 = "aaaa2222-0000-4000-8000-00000000a002";

const SUITE_SMOKE = "5111aaaa-0000-4000-8000-00000000501a";
const SUITE_AUTH = "5222aaaa-0000-4000-8000-00000000502a";

const CASE_LOGIN = "c111aaaa-0000-4000-8000-0000000000c1";
const CASE_CART = "c222aaaa-0000-4000-8000-0000000000c2";
const CASE_OTHER_PROJECT = "c333aaaa-0000-4000-8000-0000000000c3";

/** A minimal IR that satisfies src/schema/ir.ts — the schema library.ts validates against. */
const validIr = (title: string) => ({
  meta: { feature: "checkout", title, priority: "medium", sourcePrompt: "p", baseUrl: "https://example.com" },
  steps: [{ id: "s1", action: "navigate", target: { url: "https://example.com" } }],
});

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
      { organisation_id: ORG, user_id: TESTER, role: "tester" },
      { organisation_id: ORG, user_id: VIEWER, role: "viewer" },
    ],
    projects: [
      { id: PROJ_1, organisation_id: ORG, name: "one.example.com", base_url: "https://one.example.com" },
      { id: PROJ_2, organisation_id: ORG, name: "two.example.com", base_url: "https://two.example.com" },
    ],
    // The tester and viewer are assigned to PROJ_1 only, so PROJ_2 is the "not yours" case.
    project_members: [
      { project_id: PROJ_1, user_id: TESTER, "projects.organisation_id": ORG },
      { project_id: PROJ_1, user_id: VIEWER, "projects.organisation_id": ORG },
    ],
    runs: [],
    suites: [
      { id: SUITE_SMOKE, project_id: PROJ_1, name: "Smoke", created_by: OWNER },
      { id: SUITE_AUTH, project_id: PROJ_1, name: "Auth", created_by: OWNER },
    ],
    test_cases: [
      { id: CASE_LOGIN, project_id: PROJ_1, title: "Login works", feature: "auth", ir: validIr("Login works"), current_version: 1, source_run_id: null, last_run_status: null, last_run_at: null, updated_at: null },
      { id: CASE_CART, project_id: PROJ_1, title: "Cart survives reload", feature: "cart", ir: validIr("Cart survives reload"), current_version: 1, source_run_id: null, last_run_status: null, last_run_at: null, updated_at: null },
      { id: CASE_OTHER_PROJECT, project_id: PROJ_2, title: "Other project case", feature: null, ir: validIr("Other"), current_version: 1, source_run_id: null, last_run_status: null, last_run_at: null, updated_at: null },
    ],
    test_case_versions: [],
    suite_cases: [],
    run_cases: [],
  };
}

/** Chainable, thenable stand-in for supabase-js's query builder, backed by the mutable store. */
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
      const made = payloads.map((p: any) => ({ id: p.id ?? `gen-${Math.random().toString(36).slice(2, 10)}`, ...p }));
      for (const m of made) {
        // upsert: a duplicate primary key is ignored rather than duplicated.
        const dup = pending.kind === "upsert" && rows.some((r) =>
          (r.suite_id !== undefined && r.suite_id === m.suite_id && r.test_case_id === m.test_case_id)
          || (r.run_id !== undefined && r.run_id === m.run_id && r.test_case_id === m.test_case_id));
        if (!dup) rows.push(m);
      }
      return { data: single ? made[0] : made, error: null };
    }
    if (pending?.kind === "update") {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, pending.payload);
      return { data: single ? hit[0] ?? null : hit, error: null };
    }
    if (pending?.kind === "delete") {
      const keep = rows.filter((r) => !match(r));
      db[table] = keep as any;
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

// Replay drives a real browser; these two are the only things standing between this test file and
// launching Chromium. Everything else in replay.ts runs for real.
const generateSpec = vi.fn(() => "// spec");
const runSpec = vi.fn(async () => ({
  passed: true, exitCode: 0, resultsJsonPath: "", artifactsDir: "", raw: null,
}));
vi.mock("../src/stages/generator.js", () => ({ generateSpec: (...a: any[]) => generateSpec(...a) }));
vi.mock("../src/stages/executor.js", async (orig) => ({
  ...(await orig<any>()),
  runSpec: (...a: any[]) => runSpec(...a),
  findScreenshot: () => null,
  findVideo: () => null,
  detectBlocked: () => null,
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
    // The bearer token IS the user id, so a request picks its identity with one header.
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
const lib = await import("../src/server/library.js");
const { invalidateMemberships } = await import("../src/server/authz.js");

const as = (userId: string) => ({ Authorization: `Bearer ${userId}` });

/**
 * runReplay writes real artifacts under runs/<runId>/ — it is the actual pipeline entry point, not
 * a mock, which is the point of exercising it here. Fixed ids (rather than makeRunId()) so this
 * file can delete exactly what it created and nothing else, and so a re-run overwrites its own
 * directories instead of accumulating a new one each time. Without this, every `npx vitest run`
 * would leave debris that the Step 3.2 shadow comparison then reports as "missing from database".
 */
const TEST_RUN_IDS = ["2026-01-01T00-00-00-000Z-abcdabcd", "2026-01-02T00-00-00-000Z-abcdabce"];

/**
 * Run ids minted by the REAL `POST /api/replay` route during these tests.
 *
 * Unlike TEST_RUN_IDS these cannot be fixed in advance — the route calls `makeRunId()` itself, so
 * the only way to clean them up is to record what it actually returned. Without this, every
 * `npx vitest run` left two fresh directories in `runs/` forever, and they were not merely debris:
 * the history list reads the newest directories off disk, so accumulated test runs pushed the
 * user's real runs out of the visible window (see tenancy.test.ts, "the cap is applied AFTER
 * access filtering"). Test output that quietly degrades the product is worse than none.
 */
const MINTED_RUN_IDS: string[] = [];
const trackMintedRun = (res: { body?: { runId?: string } }) => {
  if (res.body?.runId) MINTED_RUN_IDS.push(res.body.runId);
  return res;
};

afterAll(() => {
  for (const id of [...TEST_RUN_IDS, ...MINTED_RUN_IDS]) {
    rmSync(path.join("runs", id), { recursive: true, force: true });
  }
});

beforeEach(() => {
  reset();
  invalidateMemberships();
  generateSpec.mockClear();
  runSpec.mockClear();
});

describe("the IR schema is imported, never restated (the plan's named hazard)", () => {
  it("refuses to store something that isn't a valid test plan", () => {
    expect(() => lib.parseIr({ meta: { title: "no steps" } }, "x")).toThrow(/not a valid test plan/);
    expect(() => lib.parseIr({ steps: [] }, "x")).toThrow(/not a valid test plan/);
    expect(() => lib.parseIr(null, "x")).toThrow(/not a valid test plan/);
  });

  it("accepts an IR the real schema accepts", () => {
    expect(lib.parseIr(validIr("ok"), "x").meta.title).toBe("ok");
  });

  it("rejects an edit whose steps are malformed, rather than storing it", async () => {
    const res = await request(app)
      .patch(`/api/cases/${CASE_LOGIN}`)
      .set(as(OWNER))
      .send({ ir: { meta: { title: "broken" }, steps: [] } });
    expect(res.status).toBe(400);
    // And the stored case is untouched — a rejected edit must not half-apply.
    expect(db.test_cases.find((c) => c.id === CASE_LOGIN).current_version).toBe(1);
    expect(db.test_case_versions).toHaveLength(0);
  });

  // The Case screen's step editor draws only action / role / name / value / url / assertion. A
  // grounded target also carries css, testId and nth — css being "what makes icon-only controls
  // addressable at all" (schema/ir.ts). The editor keeps them by mutating the existing target
  // rather than rebuilding it, but that only holds if the round-trip preserves them too: if the
  // server ever normalised unknown target keys away, every edit would silently strip the
  // grounding and the case would still validate while no longer resolving its elements.
  it("preserves target fields the step editor never draws (css/testId/nth)", async () => {
    const grounded = {
      meta: validIr("grounded").meta,
      steps: [
        { id: "s1", action: "navigate", target: { url: "https://example.com" } },
        { id: "s2", action: "click", target: { role: "button", name: "Cart", css: "#cart-icon", testId: "cart", nth: 2 } },
      ],
    };
    await lib.updateCase(OWNER, ORG, "owner", CASE_LOGIN, { ir: grounded, changeNote: "grounded" });

    const stored = db.test_cases.find((c) => c.id === CASE_LOGIN).ir;
    expect(stored.steps[1].target).toMatchObject({ css: "#cart-icon", testId: "cart", nth: 2 });
    // and the fields the editor does draw are still there alongside them
    expect(stored.steps[1].target).toMatchObject({ role: "button", name: "Cart" });
  });
});

describe("suites — clubbing cases together", () => {
  it("puts one case in two suites (many-to-many, not a column on the case)", async () => {
    await lib.addCaseToSuite(OWNER, ORG, "owner", SUITE_SMOKE, CASE_LOGIN);
    await lib.addCaseToSuite(OWNER, ORG, "owner", SUITE_AUTH, CASE_LOGIN);

    const smoke = await lib.listSuiteCases(OWNER, ORG, "owner", SUITE_SMOKE);
    const auth = await lib.listSuiteCases(OWNER, ORG, "owner", SUITE_AUTH);
    expect(smoke.map((c) => c.id)).toEqual([CASE_LOGIN]);
    expect(auth.map((c) => c.id)).toEqual([CASE_LOGIN]);
  });

  it("appends rather than displacing — a new case runs last", async () => {
    await lib.addCaseToSuite(OWNER, ORG, "owner", SUITE_SMOKE, CASE_LOGIN);
    await lib.addCaseToSuite(OWNER, ORG, "owner", SUITE_SMOKE, CASE_CART);
    const positions = db.suite_cases.map((r) => r.position);
    expect(positions).toEqual([0, 1]);
  });

  it("honours the stored order, and reorder rewrites it", async () => {
    await lib.addCaseToSuite(OWNER, ORG, "owner", SUITE_SMOKE, CASE_LOGIN);
    await lib.addCaseToSuite(OWNER, ORG, "owner", SUITE_SMOKE, CASE_CART);
    expect((await lib.listSuiteCases(OWNER, ORG, "owner", SUITE_SMOKE)).map((c) => c.id))
      .toEqual([CASE_LOGIN, CASE_CART]);

    await lib.reorderSuite(OWNER, ORG, "owner", SUITE_SMOKE, [CASE_CART, CASE_LOGIN]);
    expect((await lib.listSuiteCases(OWNER, ORG, "owner", SUITE_SMOKE)).map((c) => c.id))
      .toEqual([CASE_CART, CASE_LOGIN]);
  });

  it("removing from one suite leaves the case in the other", async () => {
    await lib.addCaseToSuite(OWNER, ORG, "owner", SUITE_SMOKE, CASE_LOGIN);
    await lib.addCaseToSuite(OWNER, ORG, "owner", SUITE_AUTH, CASE_LOGIN);
    await lib.removeCaseFromSuite(OWNER, ORG, "owner", SUITE_SMOKE, CASE_LOGIN);

    expect(await lib.listSuiteCases(OWNER, ORG, "owner", SUITE_SMOKE)).toEqual([]);
    expect((await lib.listSuiteCases(OWNER, ORG, "owner", SUITE_AUTH)).map((c) => c.id))
      .toEqual([CASE_LOGIN]);
    // The case itself survives — a suite is a grouping, not ownership.
    expect(db.test_cases.some((c) => c.id === CASE_LOGIN)).toBe(true);
  });

  it("refuses to reach across projects", async () => {
    await expect(lib.addCaseToSuite(OWNER, ORG, "owner", SUITE_SMOKE, CASE_OTHER_PROJECT))
      .rejects.toThrow(/different project/);
  });

  it("reorder is not a back door for adding", async () => {
    await lib.addCaseToSuite(OWNER, ORG, "owner", SUITE_SMOKE, CASE_LOGIN);
    await lib.reorderSuite(OWNER, ORG, "owner", SUITE_SMOKE, [CASE_CART, CASE_LOGIN]);
    expect((await lib.listSuiteCases(OWNER, ORG, "owner", SUITE_SMOKE)).map((c) => c.id))
      .toEqual([CASE_LOGIN]);
  });
});

describe("saving a case from a run writes version 1 with it", () => {
  it("mints a version alongside the case, so history starts at the beginning", async () => {
    const before = db.test_case_versions.length;
    await lib.updateCase(OWNER, ORG, "owner", CASE_LOGIN, { ir: validIr("edited"), changeNote: "tightened" });
    expect(db.test_case_versions.length).toBe(before + 1);
    expect(db.test_cases.find((c) => c.id === CASE_LOGIN).current_version).toBe(2);
  });

  it("a title-only edit does not mint a version", async () => {
    await lib.updateCase(OWNER, ORG, "owner", CASE_LOGIN, { title: "Renamed" });
    expect(db.test_case_versions).toHaveLength(0);
    expect(db.test_cases.find((c) => c.id === CASE_LOGIN).current_version).toBe(1);
  });
});

describe("replay selection — whole suite, a subset, or one case", () => {
  beforeEach(async () => {
    await lib.addCaseToSuite(OWNER, ORG, "owner", SUITE_SMOKE, CASE_LOGIN);
    await lib.addCaseToSuite(OWNER, ORG, "owner", SUITE_SMOKE, CASE_CART);
  });

  it("loads a whole suite in its stored order", async () => {
    const cases = await lib.loadCasesForReplay(OWNER, ORG, "owner", { suiteId: SUITE_SMOKE });
    expect(cases.map((c) => c.id)).toEqual([CASE_LOGIN, CASE_CART]);
  });

  it("a subset of a suite still runs in the suite's order, not the order asked for", async () => {
    await lib.reorderSuite(OWNER, ORG, "owner", SUITE_SMOKE, [CASE_CART, CASE_LOGIN]);
    const cases = await lib.loadCasesForReplay(OWNER, ORG, "owner", {
      suiteId: SUITE_SMOKE, caseIds: [CASE_LOGIN, CASE_CART],
    });
    expect(cases.map((c) => c.id)).toEqual([CASE_CART, CASE_LOGIN]);
  });

  it("loads a single case with no suite at all", async () => {
    const cases = await lib.loadCasesForReplay(OWNER, ORG, "owner", { caseIds: [CASE_CART] });
    expect(cases.map((c) => c.id)).toEqual([CASE_CART]);
  });

  it("refuses an empty selection rather than running everything", async () => {
    await expect(lib.loadCasesForReplay(OWNER, ORG, "owner", { caseIds: [] }))
      .rejects.toThrow(/no cases selected/);
  });

  it("checks EVERY case's project, not just the first", async () => {
    // A viewer/tester assigned only to PROJ_1 must not reach PROJ_2 by burying its id in a list.
    await expect(lib.loadCasesForReplay(TESTER, ORG, "tester", {
      caseIds: [CASE_LOGIN, CASE_OTHER_PROJECT],
    })).rejects.toThrow(/not been added to this project/);
  });

  it("parses each stored IR through the real schema before running it", async () => {
    db.test_cases.find((c) => c.id === CASE_CART).ir = { meta: { title: "corrupt" }, steps: [] };
    await expect(lib.loadCasesForReplay(OWNER, ORG, "owner", { caseIds: [CASE_CART] }))
      .rejects.toThrow(/not a valid test plan/);
  });
});

describe("replay spends nothing — the whole economic point", () => {
  it("runs a multi-case suite through generateSpec/runSpec and makes zero LLM calls", async () => {
    const { runReplay } = await import("../src/stages/replay.js");

    // If replay ever routed through a model, importing the LLM client would be the way it did it.
    // Asserting on the two pure stages it IS allowed to call, plus the zero-usage snapshot it
    // writes, is what makes "no tokens" checkable rather than merely claimed.
    const events: any[] = [];
    const outcome = await runReplay(
      {
        runId: TEST_RUN_IDS[0],
        label: "Replayed 2 saved cases",
        cases: [
          { id: CASE_LOGIN, title: "Login works", ir: lib.parseIr(validIr("Login works"), "x") },
          { id: CASE_CART, title: "Cart survives reload", ir: lib.parseIr(validIr("Cart survives reload"), "x") },
        ],
      },
      (e) => events.push(e),
    );

    expect(generateSpec).toHaveBeenCalledTimes(2);
    expect(runSpec).toHaveBeenCalledTimes(2);
    expect(outcome.summary.total).toBe(2);
    expect(outcome.summary.passed).toBe(2);

    const done = events.find((e) => e.stage === "done");
    expect(done.data.llmUsage).toEqual({
      calls: 0, promptTokens: 0, completionTokens: 0, totalTokens: 0, exhausted: false, byStage: {},
    });
  });

  it("emits plan and discovery as completed, or the phase cards hang forever", async () => {
    const { runReplay } = await import("../src/stages/replay.js");
    const events: any[] = [];
    await runReplay(
      {
        runId: TEST_RUN_IDS[1],
        label: "one",
        cases: [{ id: CASE_LOGIN, title: "Login works", ir: lib.parseIr(validIr("Login works"), "x") }],
      },
      (e) => events.push(e),
    );

    // public/app.js's computePhaseStatus only reports a phase complete when EVERY stage it tracks
    // has completed. Cards 1 and 2 track plan and discovery; card 3 tracks all four of
    // testcases/ir/generate/execute. Miss any one and the run renders as permanently stuck.
    for (const stage of ["plan", "discovery", "testcases", "ir", "generate", "execute"]) {
      expect(
        events.some((e) => e.stage === stage && e.status === "completed"),
        `replay never completed the "${stage}" stage — phase cards would sit at PENDING`,
      ).toBe(true);
    }
    expect(events.find((e) => e.stage === "plan" && e.status === "completed").data.skipped)
      .toMatch(/skipped/i);
  });
});

describe("role gating on the library routes", () => {
  const cases: { name: string; method: "get" | "post" | "patch" | "delete"; path: string; body?: any; viewer: number; tester: number }[] = [
    { name: "list suites",   method: "get",    path: "/api/suites", viewer: 200, tester: 200 },
    { name: "create suite",  method: "post",   path: "/api/suites", body: { projectId: PROJ_1, name: "New" }, viewer: 403, tester: 201 },
    { name: "add to suite",  method: "post",   path: `/api/suites/${SUITE_SMOKE}/cases`, body: { caseId: CASE_LOGIN }, viewer: 403, tester: 201 },
    { name: "reorder suite", method: "patch",  path: `/api/suites/${SUITE_SMOKE}/order`, body: { caseIds: [] }, viewer: 403, tester: 204 },
    { name: "delete suite",  method: "delete", path: `/api/suites/${SUITE_SMOKE}`, viewer: 403, tester: 403 },
    { name: "delete case",   method: "delete", path: `/api/cases/${CASE_LOGIN}`, viewer: 403, tester: 403 },
    { name: "replay",        method: "post",   path: "/api/replay", body: { caseIds: [CASE_LOGIN] }, viewer: 403, tester: 202 },
  ];

  for (const c of cases) {
    it(`viewer gets ${c.viewer} on ${c.name}`, async () => {
      const req = (request(app) as any)[c.method](c.path).set(as(VIEWER));
      const res = c.body ? await req.send(c.body) : await req;
      expect(res.status).toBe(c.viewer);
    });

    it(`tester gets ${c.tester} on ${c.name}`, async () => {
      const req = (request(app) as any)[c.method](c.path).set(as(TESTER));
      const res = trackMintedRun(c.body ? await req.send(c.body) : await req);
      expect(res.status).toBe(c.tester);
    });
  }

  it("a viewer cannot see cases in a project they were not added to", async () => {
    const res = await request(app).get(`/api/cases/${CASE_OTHER_PROJECT}`).set(as(VIEWER));
    expect(res.status).toBe(403);
  });

  it("an owner can, because admin+ sees every project by role", async () => {
    const res = await request(app).get(`/api/cases/${CASE_OTHER_PROJECT}`).set(as(OWNER));
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Case editing: concurrency, duplicate, run history, and the two save paths
// ---------------------------------------------------------------------------

/** A grounded step, so an edit can be shown to strip its identity — and a value-only edit shown
 *  NOT to. `css` is the whole reason the fast/slow split exists. */
const groundedIr = (title: string) => ({
  meta: { feature: "auth", title, priority: "medium", sourcePrompt: "p", baseUrl: "https://one.example.com" },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/login" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Email", css: "#email" }, value: "a@b.c" },
    { id: "s3", action: "click", target: { role: "button", name: "Sign In", css: "#signin" } },
  ],
});

describe("optimistic concurrency — an editor left open must not clobber someone else's save", () => {
  beforeEach(() => {
    reset();
    db.test_cases[0].ir = groundedIr("Login works");
    db.test_cases[0].current_version = 4;
  });

  it("saves when no expectedVersion is sent — the additive default is unchanged behaviour", async () => {
    const res = await request(app).patch(`/api/cases/${CASE_LOGIN}`).set(as(TESTER))
      .send({ title: "Renamed with no version check" });
    expect(res.status).toBe(200);
  });

  it("saves when expectedVersion matches", async () => {
    const res = await request(app).patch(`/api/cases/${CASE_LOGIN}`).set(as(TESTER))
      .send({ title: "Renamed", expectedVersion: 4 });
    expect(res.status).toBe(200);
  });

  it("409s a stale edit rather than overwriting", async () => {
    const res = await request(app).patch(`/api/cases/${CASE_LOGIN}`).set(as(TESTER))
      .send({ title: "Stale write", expectedVersion: 2 });
    expect(res.status).toBe(409);
    expect(res.body.currentVersion).toBe(4);
    expect(res.body.expectedVersion).toBe(2);
  });

  it("the 409 carries the winning state, so the loser can see what they'd have destroyed", async () => {
    const res = await request(app).patch(`/api/cases/${CASE_LOGIN}`).set(as(TESTER))
      .send({ ir: groundedIr("x"), expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.current.steps.map((s: any) => s.text)).toContain(`Click on button "Sign In"`);
  });

  it("a refused save writes nothing — no version row, no version bump", async () => {
    await request(app).patch(`/api/cases/${CASE_LOGIN}`).set(as(TESTER))
      .send({ ir: groundedIr("x"), expectedVersion: 1 });
    expect(db.test_cases[0].current_version).toBe(4);
    expect(db.test_case_versions.length).toBe(0);
  });
});

describe("the two save paths — what costs a browser and what does not", () => {
  beforeEach(() => {
    reset();
    db.test_cases[0].ir = groundedIr("Login works");
  });

  const stepsOf = async () => {
    const res = await request(app).get(`/api/cases/${CASE_LOGIN}/steps`).set(as(TESTER));
    return res.body.steps.map((s: any) => s.text) as string[];
  };

  it("renders steps as the sentences the editor shows", async () => {
    expect(await stepsOf()).toEqual([
      "Go to /login",
      `Type "a@b.c" into textbox "Email"`,
      `Click on button "Sign In"`,
    ]);
  });

  it("estimates an untouched edit as instant and free", async () => {
    const res = await request(app).post(`/api/cases/${CASE_LOGIN}/steps/estimate`).set(as(TESTER))
      .send({ steps: await stepsOf() });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ instant: true, stepsToVerify: 0, snapshots: 0, maxLlmCalls: 0 });
  });

  it("estimates a VALUE-only edit as instant — the element never changed", async () => {
    const steps = await stepsOf();
    steps[1] = `Type "new@example.com" into textbox "Email"`;
    const res = await request(app).post(`/api/cases/${CASE_LOGIN}/steps/estimate`).set(as(TESTER))
      .send({ steps });
    expect(res.body).toMatchObject({ instant: true, changedSteps: 1, stepsToVerify: 0 });
  });

  it("estimates a TARGET edit as needing verification, and says how much", async () => {
    const steps = await stepsOf();
    steps[2] = `Click on button "Log In"`;
    const res = await request(app).post(`/api/cases/${CASE_LOGIN}/steps/estimate`).set(as(TESTER))
      .send({ steps });
    expect(res.body.instant).toBe(false);
    expect(res.body.stepsToVerify).toBe(1);
    expect(res.body.stepIdsToVerify).toEqual(["s3"]);
    expect(res.body.snapshots).toBe(1);
    expect(res.body.estimatedSeconds).toBeGreaterThan(0);
  });

  it("estimating opens no browser and writes nothing", async () => {
    const steps = await stepsOf();
    steps[2] = `Click on button "Log In"`;
    await request(app).post(`/api/cases/${CASE_LOGIN}/steps/estimate`).set(as(TESTER)).send({ steps });
    expect(db.test_case_versions.length).toBe(0);
    expect(db.test_cases[0].current_version).toBe(1);
  });

  it("saves a value-only edit synchronously, keeping the grounding", async () => {
    const steps = await stepsOf();
    steps[1] = `Type "new@example.com" into textbox "Email"`;
    const res = await request(app).post(`/api/cases/${CASE_LOGIN}/steps`).set(as(TESTER)).send({ steps });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("instant");
    expect(db.test_cases[0].current_version).toBe(2);
    // The css survived: this step was never in question, so it was never re-derived.
    expect(db.test_cases[0].ir.steps[1].target.css).toBe("#email");
    expect(db.test_cases[0].ir.steps[1].value).toBe("new@example.com");
  });

  it("a save with a bad sentence is refused, and names the row", async () => {
    const steps = await stepsOf();
    steps[1] = "do something vague";
    const res = await request(app).post(`/api/cases/${CASE_LOGIN}/steps`).set(as(TESTER)).send({ steps });
    expect(res.status).toBe(400);
    expect(res.body.stepIndex).toBe(1);
    expect(db.test_cases[0].current_version).toBe(1);
  });

  it("refuses a stale save before doing any work", async () => {
    const res = await request(app).post(`/api/cases/${CASE_LOGIN}/steps`).set(as(TESTER))
      .send({ steps: await stepsOf(), expectedVersion: 99 });
    expect(res.status).toBe(409);
  });

  it("a viewer cannot save or estimate, whatever the UI drew", async () => {
    const steps = await stepsOf();
    for (const p of [`/api/cases/${CASE_LOGIN}/steps`, `/api/cases/${CASE_LOGIN}/steps/estimate`]) {
      const res = await request(app).post(p).set(as(VIEWER)).send({ steps });
      expect(res.status).toBe(403);
    }
  });
});

describe("duplicate — an independent copy, not a shared one", () => {
  beforeEach(() => { reset(); db.test_cases[0].current_version = 5; });

  it("creates a new case with a fresh history at v1", async () => {
    const res = await request(app).post(`/api/cases/${CASE_LOGIN}/duplicate`).set(as(TESTER)).send({});
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(CASE_LOGIN);
    expect(res.body.currentVersion).toBe(1);
    expect(res.body.title).toBe("Login works (copy)");
  });

  it("does not clone the original's version history or its run outcome", async () => {
    db.test_case_versions.push({ test_case_id: CASE_LOGIN, version: 1, ir: validIr("v1") });
    db.test_cases[0].last_run_status = "passed";
    const res = await request(app).post(`/api/cases/${CASE_LOGIN}/duplicate`).set(as(TESTER)).send({});
    const copyVersions = db.test_case_versions.filter((v) => v.test_case_id === res.body.id);
    expect(copyVersions.length).toBe(1);
    expect(res.body.lastRunStatus).toBeNull();
    // It did not come out of a run — it came out of another case.
    expect(res.body.sourceRunId).toBeNull();
  });

  it("editing the copy leaves the original alone", async () => {
    const res = await request(app).post(`/api/cases/${CASE_LOGIN}/duplicate`).set(as(TESTER)).send({});
    await request(app).patch(`/api/cases/${res.body.id}`).set(as(TESTER)).send({ title: "Diverged" });
    expect(db.test_cases.find((c) => c.id === CASE_LOGIN).title).toBe("Login works");
  });

  it("a viewer cannot duplicate", async () => {
    const res = await request(app).post(`/api/cases/${CASE_LOGIN}/duplicate`).set(as(VIEWER)).send({});
    expect(res.status).toBe(403);
  });
});

describe("a case's own run history", () => {
  beforeEach(() => reset());

  it("is empty before it has ever run", async () => {
    const res = await request(app).get(`/api/cases/${CASE_LOGIN}/runs`).set(as(TESTER));
    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([]);
  });

  it("lists a run once one has executed it, pointing at its artifacts", async () => {
    db.run_cases.push({ run_id: "2026-01-01T00-00-00-000Z-aaaaaaaa", test_case_id: CASE_LOGIN, case_index: 2, status: "passed", created_at: "2026-01-01T00:00:00Z" });
    const res = await request(app).get(`/api/cases/${CASE_LOGIN}/runs`).set(as(TESTER));
    expect(res.body.runs).toEqual([{
      runId: "2026-01-01T00-00-00-000Z-aaaaaaaa",
      caseIndex: 2,
      status: "passed",
      ranAt: "2026-01-01T00:00:00Z",
      resultPath: "cases/case-2",
    }]);
  });

  it("records a row per case in a MULTI-case replay — the reason this is a join table", async () => {
    await request(app).post(`/api/suites/${SUITE_SMOKE}/cases`).set(as(TESTER)).send({ caseId: CASE_LOGIN });
    await request(app).post(`/api/suites/${SUITE_SMOKE}/cases`).set(as(TESTER)).send({ caseId: CASE_CART });
    const res = trackMintedRun(
      await request(app).post("/api/replay").set(as(TESTER)).send({ suiteId: SUITE_SMOKE }),
    );
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(db.run_cases.length).toBe(2), { timeout: 5000 });
    // Both cases ran under ONE run id, and both are individually addressable.
    expect(new Set(db.run_cases.map((r) => r.run_id)).size).toBe(1);
    expect(db.run_cases.map((r) => r.test_case_id).sort()).toEqual([CASE_LOGIN, CASE_CART].sort());
  });

  it("a viewer in another project cannot read a case's history", async () => {
    const res = await request(app).get(`/api/cases/${CASE_OTHER_PROJECT}/runs`).set(as(VIEWER));
    expect(res.status).toBe(403);
  });
});
