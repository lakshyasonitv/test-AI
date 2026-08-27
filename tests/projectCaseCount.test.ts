import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * The number on a project row in the sidebar tree.
 *
 * The project row and its suite rows render the same `.tree-count` element in the same visual
 * position, and they used to be in DIFFERENT UNITS: the project showed its RUN count while its
 * children showed CASE counts. A project with 38 runs and 3 saved cases read as holding 38 cases.
 *
 * The rule these tests pin is the one that is easy to quietly get wrong later: the project count is
 * ALL saved cases in the project, **not the sum of its suites**. A case saved but filed in no suite
 * still counts — otherwise it is present in the library and invisible in the only place that lists
 * it. So a project's number can legitimately exceed what its children add up to.
 *
 * The mock is the mutable in-memory store `library.test.ts` uses, for the same reason: these
 * assertions are about numbers derived from rows, so writes have to be readable afterwards.
 */

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const OWNER = "11111111-0000-4000-8000-000000000001";

const PROJ_FULL = "aaaa1111-0000-4000-8000-00000000a001";   // 3 cases, 2 of them in a suite
const PROJ_EMPTY = "aaaa2222-0000-4000-8000-00000000a002";  // 0 cases, but 5 runs
const SUITE_SMOKE = "5111aaaa-0000-4000-8000-00000000501a";

const validIr = (title: string) => ({
  meta: { feature: "f", title, priority: "medium", sourcePrompt: "p", baseUrl: "https://example.com" },
  steps: [{ id: "s1", action: "navigate", target: { url: "https://example.com" } }],
});

interface Tables {
  organisation_members: any[]; projects: any[]; project_members: any[];
  runs: any[]; suites: any[]; test_cases: any[]; suite_cases: any[];
}
let db: Tables;

/** Counts every `.from(table)` so "one grouped query, not one per project" is checkable. */
let fromCalls: string[] = [];

function reset() {
  fromCalls = [];
  db = {
    organisation_members: [{ organisation_id: ORG, user_id: OWNER, role: "owner" }],
    projects: [
      { id: PROJ_FULL, organisation_id: ORG, name: "Acme Store", base_url: "https://acme.test" },
      { id: PROJ_EMPTY, organisation_id: ORG, name: "Empty", base_url: "https://empty.test" },
    ],
    project_members: [],
    // PROJ_EMPTY deliberately has MORE runs than PROJ_FULL has cases. If the tree ever regresses to
    // the run count, "Empty" shows 5 while holding nothing — the exact confusion being fixed.
    runs: [
      { id: "r1", project_id: PROJ_EMPTY }, { id: "r2", project_id: PROJ_EMPTY },
      { id: "r3", project_id: PROJ_EMPTY }, { id: "r4", project_id: PROJ_EMPTY },
      { id: "r5", project_id: PROJ_EMPTY }, { id: "r6", project_id: PROJ_FULL },
    ],
    suites: [{ id: SUITE_SMOKE, project_id: PROJ_FULL, name: "Smoke", created_by: OWNER }],
    // Three saved cases. Two are filed in Smoke; the third is in NO suite.
    test_cases: [
      { id: "c1", project_id: PROJ_FULL, title: "A", ir: validIr("A"), current_version: 1 },
      { id: "c2", project_id: PROJ_FULL, title: "B", ir: validIr("B"), current_version: 1 },
      { id: "c3", project_id: PROJ_FULL, title: "C unfiled", ir: validIr("C"), current_version: 1 },
    ],
    suite_cases: [
      { suite_id: SUITE_SMOKE, test_case_id: "c1", position: 0 },
      { suite_id: SUITE_SMOKE, test_case_id: "c2", position: 1 },
    ],
  };
}

function makeBuilder(table: keyof Tables) {
  fromCalls.push(table);
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  let single = false;
  const match = (r: any) =>
    eqs.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c]));
  const run = () => {
    const found = (db[table] as any[]).filter(match);
    return { data: single ? found[0] ?? null : found, error: null };
  };
  const builder: any = {
    select: () => builder,
    eq: (c: string, v: unknown) => { eqs.push([c, v]); return builder; },
    in: (c: string, v: unknown[]) => { ins.push([c, v]); return builder; },
    order: () => builder,
    limit: () => builder,
    single: () => { single = true; return Promise.resolve(run()); },
    maybeSingle: () => { single = true; return Promise.resolve(run()); },
    then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
  };
  return builder;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: string) => makeBuilder(t as keyof Tables) }),
}));

process.env.AUTH_ENABLED = "true";
process.env.DB_ENABLED = "true";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";

const { listVisibleProjects } = await import("../src/server/projects.js");
const { listSuites, countCasesByProject } = await import("../src/server/library.js");

beforeEach(reset);

const projects = () => listVisibleProjects(OWNER, ORG, "owner");
const findProject = async (id: string) => (await projects()).find((p) => p.id === id)!;

describe("the sidebar tree's project count — the scenario from the brief", () => {
  it("shows 3 on the project and 2 on the suite", async () => {
    // 3 saved cases, 2 of them in one suite. This is the whole bug report in one assertion.
    expect((await findProject(PROJ_FULL)).caseCount).toBe(3);
    const suites = await listSuites(OWNER, ORG, "owner", PROJ_FULL);
    expect(suites.find((s) => s.id === SUITE_SMOKE)!.caseCount).toBe(2);
  });

  it("counts a case that is in NO suite — it must not vanish from the tree", async () => {
    // The definition that matters: ALL cases in the project, not the sum of its suites.
    const p = await findProject(PROJ_FULL);
    const suites = await listSuites(OWNER, ORG, "owner", PROJ_FULL);
    const sumOfSuites = suites.reduce((n, s) => n + s.caseCount, 0);
    expect(sumOfSuites).toBe(2);
    expect(p.caseCount).toBe(3);
    // The project number being LARGER than its children is correct, not a discrepancy.
    expect(p.caseCount!).toBeGreaterThan(sumOfSuites);
  });

  it("is not the run count — the two are different numbers on the same row", async () => {
    const empty = await findProject(PROJ_EMPTY);
    // 5 runs, 0 cases. Before the fix this row read "5".
    expect(empty.runCount).toBe(5);
    expect(empty.caseCount).toBe(0);
  });
});

describe("empty state", () => {
  it("reports 0 for a project with no saved cases, not undefined or absent", async () => {
    const p = await findProject(PROJ_EMPTY);
    expect(p.caseCount).toBe(0);
    expect(p.caseCount).not.toBeUndefined();
    expect("caseCount" in p).toBe(true);
  });

  it("returns an empty map for no projects rather than querying", async () => {
    reset();
    expect((await countCasesByProject([])).size).toBe(0);
    expect(fromCalls).not.toContain("test_cases");
  });
});

describe("the run count is kept, not removed", () => {
  it("still reports runCount on every project", async () => {
    const all = await projects();
    for (const p of all) expect(typeof p.runCount).toBe("number");
    expect((await findProject(PROJ_FULL)).runCount).toBe(1);
  });

  it("leaves the busiest-by-runs ordering alone", async () => {
    // PROJ_EMPTY has 5 runs to PROJ_FULL's 1, so it still leads despite holding no cases.
    // Re-sorting on the new number would silently rearrange the sidebar; this pins that it does not.
    expect((await projects()).map((p) => p.id)).toEqual([PROJ_EMPTY, PROJ_FULL]);
  });
});

describe("one source, one query", () => {
  it("counts with a single grouped query, not one per project", async () => {
    reset();
    await countCasesByProject([PROJ_FULL, PROJ_EMPTY]);
    expect(fromCalls.filter((t) => t === "test_cases")).toHaveLength(1);
  });

  it("agrees with the helper library.ts owns — the tree cannot drift from it", async () => {
    const direct = await countCasesByProject([PROJ_FULL, PROJ_EMPTY]);
    for (const p of await projects()) {
      expect(p.caseCount).toBe(direct.get(p.id) ?? 0);
    }
  });
});
