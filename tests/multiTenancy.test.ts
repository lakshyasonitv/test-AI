import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * Two organisations on one instance, and nothing crosses between them.
 *
 * `tenancy.test.ts` already proves org B cannot touch org A's RUN. This file asks the larger
 * question the product now depends on: with two complete tenants — each with an owner, a tester and
 * a viewer, each with projects, suites, cases, versions, runs and artifacts on disk — can any read
 * anywhere reach across the boundary?
 *
 * WHY A SEPARATE FILE FROM tenancy.test.ts. That file's fake is deliberately read-only: writes are
 * accepted and discarded so each test asserts a decision rather than depending on the order tests
 * ran in. That is right for it and wrong here, because provisioning — creating an organisation,
 * bootstrapping a signup into one — is precisely what has to be observed. This file therefore
 * carries a mutable fake, reset per test.
 *
 * THE COVERAGE GUARD AT THE BOTTOM IS THE POINT. tenancy.test.ts's guard only ever inspected
 * `/api/runs/:runId*`, so the ~30 library, case, suite and project routes could be added without
 * anything noticing. The guard here is inverted: it enumerates EVERY mounted `/api/*` route and
 * fails unless each one appears in one of three tables. A new route is covered by default, and
 * escaping requires writing down a reason.
 */

// --------------------------------------------------------------------------
// Two tenants, each complete
// --------------------------------------------------------------------------

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";

const OWNER_A = "a0000001-0000-4000-8000-000000000001";
const TESTER_A = "a0000002-0000-4000-8000-000000000002";
const VIEWER_A = "a0000003-0000-4000-8000-000000000003";
const OWNER_B = "b0000001-0000-4000-8000-000000000001";
const TESTER_B = "b0000002-0000-4000-8000-000000000002";
const VIEWER_B = "b0000003-0000-4000-8000-000000000003";
/** Signed in, belongs to nothing. Proves "no membership" is not "all memberships". */
const NOBODY = "c0000001-0000-4000-8000-000000000001";

/** Each org has two projects; its tester and viewer are assigned to the FIRST only. */
const PROJ_A1 = "a0001111-0000-4000-8000-00000000a001";
const PROJ_A2 = "a0002222-0000-4000-8000-00000000a002";
const PROJ_B1 = "b0001111-0000-4000-8000-00000000b001";
const PROJ_B2 = "b0002222-0000-4000-8000-00000000b002";

const SUITE_A = "a0003333-0000-4000-8000-00000000a003";
const SUITE_B = "b0003333-0000-4000-8000-00000000b003";
const CASE_A = "a0004444-0000-4000-8000-00000000a004";
const CASE_B = "b0004444-0000-4000-8000-00000000b004";

const RUN_A = "2026-02-01T00-00-00-000Z-aaaaaaaa";
const RUN_B = "2026-02-02T00-00-00-000Z-bbbbbbbb";

const IR = {
  meta: { title: "Sign in", baseUrl: "https://a.example.com" },
  steps: [] as unknown[],
};

interface Db { [table: string]: any[] }
let db: Db;

function reset(): void {
  db = {
    organisations: [
      { id: ORG_A, name: "Org A", created_at: "2026-01-01T00:00:00Z" },
      { id: ORG_B, name: "Org B", created_at: "2026-01-02T00:00:00Z" },
    ],
    organisation_members: [
      { organisation_id: ORG_A, user_id: OWNER_A, role: "owner", created_at: "2026-01-01T00:00:00Z" },
      { organisation_id: ORG_A, user_id: TESTER_A, role: "tester", created_at: "2026-01-01T00:01:00Z" },
      { organisation_id: ORG_A, user_id: VIEWER_A, role: "viewer", created_at: "2026-01-01T00:02:00Z" },
      { organisation_id: ORG_B, user_id: OWNER_B, role: "owner", created_at: "2026-01-02T00:00:00Z" },
      { organisation_id: ORG_B, user_id: TESTER_B, role: "tester", created_at: "2026-01-02T00:01:00Z" },
      { organisation_id: ORG_B, user_id: VIEWER_B, role: "viewer", created_at: "2026-01-02T00:02:00Z" },
    ],
    projects: [
      { id: PROJ_A1, organisation_id: ORG_A, name: "a-one.example.com", base_url: "https://a-one.example.com" },
      { id: PROJ_A2, organisation_id: ORG_A, name: "a-two.example.com", base_url: "https://a-two.example.com" },
      { id: PROJ_B1, organisation_id: ORG_B, name: "b-one.example.com", base_url: "https://b-one.example.com" },
      { id: PROJ_B2, organisation_id: ORG_B, name: "b-two.example.com", base_url: "https://b-two.example.com" },
    ],
    project_members: [
      { project_id: PROJ_A1, user_id: TESTER_A, "projects.organisation_id": ORG_A },
      { project_id: PROJ_A1, user_id: VIEWER_A, "projects.organisation_id": ORG_A },
      { project_id: PROJ_B1, user_id: TESTER_B, "projects.organisation_id": ORG_B },
      { project_id: PROJ_B1, user_id: VIEWER_B, "projects.organisation_id": ORG_B },
    ],
    suites: [
      { id: SUITE_A, project_id: PROJ_A1, name: "A smoke", created_by: OWNER_A },
      { id: SUITE_B, project_id: PROJ_B1, name: "B smoke", created_by: OWNER_B },
    ],
    test_cases: [
      { id: CASE_A, project_id: PROJ_A1, title: "A login", feature: null, ir: IR, current_version: 1,
        source_run_id: RUN_A, last_run_status: "passed", last_run_at: null, updated_at: null },
      { id: CASE_B, project_id: PROJ_B1, title: "B login", feature: null, ir: IR, current_version: 1,
        source_run_id: RUN_B, last_run_status: "passed", last_run_at: null, updated_at: null },
    ],
    test_case_versions: [
      { id: randomUUID(), test_case_id: CASE_A, version: 1, ir: IR, change_note: null, saved_by: OWNER_A, saved_at: null, spec: "// A" },
      { id: randomUUID(), test_case_id: CASE_B, version: 1, ir: IR, change_note: null, saved_by: OWNER_B, saved_at: null, spec: "// B" },
    ],
    suite_cases: [
      { suite_id: SUITE_A, test_case_id: CASE_A, position: 0 },
      { suite_id: SUITE_B, test_case_id: CASE_B, position: 0 },
    ],
    runs: [
      { id: RUN_A, organisation_id: ORG_A, project_id: PROJ_A1, started_by: OWNER_A, status: "passed", started_at: "2026-02-01T00:00:00Z" },
      { id: RUN_B, organisation_id: ORG_B, project_id: PROJ_B1, started_by: OWNER_B, status: "passed", started_at: "2026-02-02T00:00:00Z" },
    ],
    run_cases: [
      { run_id: RUN_A, test_case_id: CASE_A, case_index: 0, status: "passed", created_at: "2026-02-01T00:00:00Z" },
      { run_id: RUN_B, test_case_id: CASE_B, case_index: 0, status: "passed", created_at: "2026-02-02T00:00:00Z" },
    ],
  };
}
reset();

const DIRECTORY = [
  { id: OWNER_A, email: "owner-a@example.com" }, { id: TESTER_A, email: "tester-a@example.com" },
  { id: VIEWER_A, email: "viewer-a@example.com" }, { id: OWNER_B, email: "owner-b@example.com" },
  { id: TESTER_B, email: "tester-b@example.com" }, { id: VIEWER_B, email: "viewer-b@example.com" },
  { id: NOBODY, email: "nobody@example.com" },
];

/**
 * Mutable stand-in for supabase-js's chainable builder.
 *
 * Wider than tenancy.test.ts's because the library routes are in scope here — `.order()` and
 * `.limit()` actually have to do something, and writes have to land so provisioning can be
 * observed. `project_members` rows carry a denormalised `"projects.organisation_id"` key because
 * `visibleProjectIds` filters with supabase-js's embedded-resource syntax; storing the value under
 * that literal key lets the real query run unmodified against a fake that cannot join.
 */
function makeBuilder(table: string) {
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  const orders: { col: string; asc: boolean }[] = [];
  let limitN: number | null = null;
  let pending: { kind: "insert" | "upsert" | "update" | "delete"; payload?: any } | null = null;
  let single = false;

  const match = (r: any) =>
    eqs.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c]));

  const run = () => {
    const rows: any[] = (db[table] ??= []);
    if (pending?.kind === "insert" || pending?.kind === "upsert") {
      const payloads = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const made = payloads.map((p: any) => ({ id: p.id ?? randomUUID(), ...p }));
      for (const m of made) {
        const dup = pending.kind === "upsert" && rows.some((r) =>
          Object.keys(m).filter((k) => k !== "id").every((k) => r[k] === m[k]));
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
      db[table] = rows.filter((r) => !match(r));
      return { data: null, error: null };
    }
    let found = rows.filter(match);
    for (const o of [...orders].reverse()) {
      found = [...found].sort((a, b) => {
        const x = a[o.col], y = b[o.col];
        if (x === y) return 0;
        return (x > y ? 1 : -1) * (o.asc ? 1 : -1);
      });
    }
    if (limitN !== null) found = found.slice(0, limitN);
    return { data: single ? found[0] ?? null : found, error: null };
  };

  const builder: any = {
    select: () => builder,
    eq: (c: string, v: unknown) => { eqs.push([c, v]); return builder; },
    in: (c: string, v: unknown[]) => { ins.push([c, v]); return builder; },
    order: (c: string, o?: { ascending?: boolean }) => {
      orders.push({ col: c, asc: o?.ascending !== false }); return builder;
    },
    limit: (n: number) => { limitN = n; return builder; },
    insert: (p: any) => { pending = { kind: "insert", payload: p }; return builder; },
    upsert: (p: any) => { pending = { kind: "upsert", payload: p }; return builder; },
    update: (p: any) => { pending = { kind: "update", payload: p }; return builder; },
    delete: () => { pending = { kind: "delete" }; return builder; },
    maybeSingle: () => { single = true; return Promise.resolve(run()); },
    single: () => { single = true; return Promise.resolve(run()); },
    then: (resolve: (v: unknown) => unknown) => resolve(run()),
  };
  return builder;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (table: string) => makeBuilder(table),
    /** The one RPC in this system: create_organisation_with_owner, used by createOrganisation. */
    rpc: async (fn: string, args: Record<string, any>) => {
      if (fn !== "create_organisation_with_owner") return { data: null, error: { message: `no such function ${fn}` } };
      const id = randomUUID();
      const name = String(args.p_name).trim();
      db.organisations.push({ id, name, created_at: new Date().toISOString() });
      db.organisation_members.push({
        organisation_id: id, user_id: args.p_user_id, role: "owner", created_at: new Date().toISOString(),
      });
      return { data: [{ id, name }], error: null };
    },
    auth: {
      getUser: async (token: string) =>
        token
          ? { data: { user: { id: token, email: DIRECTORY.find((u) => u.id === token)?.email ?? `${token}@example.com` } }, error: null }
          : { data: { user: null }, error: new Error("no token") },
      admin: { listUsers: async () => ({ data: { users: DIRECTORY }, error: null }) },
    },
  }),
}));

const { app } = await import("../src/server/index.js");
const { invalidateMemberships } = await import("../src/server/authz.js");
const request = (await import("supertest")).default;

const ORIGINAL_ENV = { ...process.env };
const as = (userId: string) => ({ Authorization: `Bearer ${userId}` });

/** Real directories, so the artifact route reaches the filesystem rather than a missing path. */
function materialise(runId: string): void {
  const dir = path.join("runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "00-input.json"), JSON.stringify({ url: "https://x.example.com", prompt: "p" }), "utf8");
  writeFileSync(path.join(dir, "events.ndjson"),
    JSON.stringify({ runId, stage: "input", status: "completed", data: {}, ts: Date.now() }) + "\n", "utf8");
}

beforeEach(() => {
  process.env.AUTH_ENABLED = "true";
  process.env.DB_ENABLED = "true";
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "fake-publishable";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role";
  reset();
  invalidateMemberships();
  materialise(RUN_A);
  materialise(RUN_B);
});

afterEach(() => {
  for (const r of [RUN_A, RUN_B]) rmSync(path.join("runs", r), { recursive: true, force: true });
});

afterAll(() => {
  for (const k of ["AUTH_ENABLED", "DB_ENABLED", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k]!;
  }
  for (const r of [RUN_A, RUN_B]) {
    if (existsSync(path.join("runs", r))) rmSync(path.join("runs", r), { recursive: true, force: true });
  }
});

// --------------------------------------------------------------------------
// The three route tables. Together they must account for every mounted /api/* route.
// --------------------------------------------------------------------------

type Method = "get" | "post" | "patch" | "delete";

/**
 * RESOURCE routes: they name a thing belonging to org A. Called by org B, every one must refuse.
 *
 * 403 or 404 — deliberately either. Some refuse at the membership join (403) and some resolve the
 * id first and find nothing in the caller's organisation (404). Both are correct refusals and
 * pinning each to one code would test the message rather than the boundary.
 */
const RESOURCE_ROUTES: { name: string; method: Method; path: string; body?: unknown; mounted: string }[] = [
  { name: "read org A's roster", method: "get", path: `/api/organisations/${ORG_A}/members`, mounted: "GET /api/organisations/:orgId/members" },
  { name: "read org A's assignments", method: "get", path: `/api/organisations/${ORG_A}/assignments`, mounted: "GET /api/organisations/:orgId/assignments" },
  { name: "add a member to org A", method: "post", path: `/api/organisations/${ORG_A}/members`, body: { email: "nobody@example.com", role: "viewer" }, mounted: "POST /api/organisations/:orgId/members" },
  { name: "change a role in org A", method: "patch", path: `/api/organisations/${ORG_A}/members/${VIEWER_A}`, body: { role: "admin" }, mounted: "PATCH /api/organisations/:orgId/members/:userId" },
  { name: "remove a member from org A", method: "delete", path: `/api/organisations/${ORG_A}/members/${VIEWER_A}`, mounted: "DELETE /api/organisations/:orgId/members/:userId" },
  // The whole point of these two: an admin of org B must not be able to read whether org A has a
  // key set, nor overwrite org A's credentials with their own.
  { name: "read org A's LLM configuration", method: "get", path: `/api/organisations/${ORG_A}/llm-config`, mounted: "GET /api/organisations/:orgId/llm-config" },
  { name: "set org A's LLM configuration", method: "put", path: `/api/organisations/${ORG_A}/llm-config`, body: { model: "gemini-3.6-flash" }, mounted: "PUT /api/organisations/:orgId/llm-config" },

  { name: "rename org A's project", method: "patch", path: `/api/projects/${PROJ_A1}`, body: { name: "hijacked" }, mounted: "PATCH /api/projects/:projectId" },
  { name: "delete org A's project", method: "delete", path: `/api/projects/${PROJ_A1}`, mounted: "DELETE /api/projects/:projectId" },
  { name: "read org A's project members", method: "get", path: `/api/projects/${PROJ_A1}/members`, mounted: "GET /api/projects/:projectId/members" },
  { name: "add to org A's project", method: "post", path: `/api/projects/${PROJ_A1}/members`, body: { userId: OWNER_B }, mounted: "POST /api/projects/:projectId/members" },
  { name: "remove from org A's project", method: "delete", path: `/api/projects/${PROJ_A1}/members/${VIEWER_A}`, mounted: "DELETE /api/projects/:projectId/members/:userId" },

  { name: "rename org A's suite", method: "patch", path: `/api/suites/${SUITE_A}`, body: { name: "hijacked" }, mounted: "PATCH /api/suites/:suiteId" },
  { name: "delete org A's suite", method: "delete", path: `/api/suites/${SUITE_A}`, mounted: "DELETE /api/suites/:suiteId" },
  { name: "read org A's suite cases", method: "get", path: `/api/suites/${SUITE_A}/cases`, mounted: "GET /api/suites/:suiteId/cases" },
  { name: "add a case to org A's suite", method: "post", path: `/api/suites/${SUITE_A}/cases`, body: { caseId: CASE_B }, mounted: "POST /api/suites/:suiteId/cases" },
  { name: "remove a case from org A's suite", method: "delete", path: `/api/suites/${SUITE_A}/cases/${CASE_A}`, mounted: "DELETE /api/suites/:suiteId/cases/:caseId" },
  { name: "reorder org A's suite", method: "patch", path: `/api/suites/${SUITE_A}/order`, body: { caseIds: [CASE_A] }, mounted: "PATCH /api/suites/:suiteId/order" },

  { name: "read org A's case", method: "get", path: `/api/cases/${CASE_A}`, mounted: "GET /api/cases/:caseId" },
  { name: "read org A's case script", method: "get", path: `/api/cases/${CASE_A}/script`, mounted: "GET /api/cases/:caseId/script" },
  { name: "read org A's case version (the IR)", method: "get", path: `/api/cases/${CASE_A}/versions/1`, mounted: "GET /api/cases/:caseId/versions/:version" },
  { name: "read org A's case steps", method: "get", path: `/api/cases/${CASE_A}/steps`, mounted: "GET /api/cases/:caseId/steps" },
  { name: "read org A's case run history", method: "get", path: `/api/cases/${CASE_A}/runs`, mounted: "GET /api/cases/:caseId/runs" },
  { name: "edit org A's case", method: "patch", path: `/api/cases/${CASE_A}`, body: { title: "hijacked" }, mounted: "PATCH /api/cases/:caseId" },
  { name: "delete org A's case", method: "delete", path: `/api/cases/${CASE_A}`, mounted: "DELETE /api/cases/:caseId" },
  { name: "duplicate org A's case", method: "post", path: `/api/cases/${CASE_A}/duplicate`, body: {}, mounted: "POST /api/cases/:caseId/duplicate" },
  // A NON-EMPTY steps array on purpose. `prepareEdit` validates the body shape before it calls
  // getCase(), so `steps: []` 400s on validation and never reaches the authorization check — the
  // test would pass while proving nothing about tenancy. Harmless in itself (the 400 is identical
  // whoever asks), but a refusal for the wrong reason is not the refusal under test.
  { name: "estimate an edit to org A's case", method: "post", path: `/api/cases/${CASE_A}/steps/estimate`, body: { steps: ['Click "Sign in"'] }, mounted: "POST /api/cases/:caseId/steps/estimate" },
  { name: "save steps onto org A's case", method: "post", path: `/api/cases/${CASE_A}/steps`, body: { steps: ['Click "Sign in"'] }, mounted: "POST /api/cases/:caseId/steps" },
  { name: "rewrite org A's case", method: "post", path: `/api/cases/${CASE_A}/rewrite`, body: { instruction: "x" }, mounted: "POST /api/cases/:caseId/rewrite" },
  { name: "translate steps on org A's case", method: "post", path: `/api/cases/${CASE_A}/steps/translate`, body: { text: "x" }, mounted: "POST /api/cases/:caseId/steps/translate" },
  { name: "override the script on org A's case", method: "put", path: `/api/cases/${CASE_A}/script-override`, body: { script: "x", confirm: true }, mounted: "PUT /api/cases/:caseId/script-override" },

  { name: "read org A's run state", method: "get", path: `/api/runs/${RUN_A}/state`, mounted: "GET /api/runs/:runId/state" },
  { name: "read org A's run events", method: "get", path: `/api/runs/${RUN_A}/events`, mounted: "GET /api/runs/:runId/events" },
  { name: "read org A's accepted cases", method: "get", path: `/api/runs/${RUN_A}/accepted-cases`, mounted: "GET /api/runs/:runId/accepted-cases" },
  { name: "read org A's selection status", method: "get", path: `/api/runs/${RUN_A}/case-selection-status`, mounted: "GET /api/runs/:runId/case-selection-status" },
  { name: "read org A's page elements", method: "get", path: `/api/runs/${RUN_A}/page-elements`, mounted: "GET /api/runs/:runId/page-elements" },
  { name: "answer org A's credential prompt", method: "post", path: `/api/runs/${RUN_A}/credentials`, body: { skip: true }, mounted: "POST /api/runs/:runId/credentials" },
  { name: "answer org A's selection gate", method: "post", path: `/api/runs/${RUN_A}/case-selection`, body: { action: "done", selectedIndexes: [0] }, mounted: "POST /api/runs/:runId/case-selection" },
  { name: "rewrite org A's gate case", method: "post", path: `/api/runs/${RUN_A}/case-selection/rewrite`, body: { title: "t", steps: ["s"], instruction: "i" }, mounted: "POST /api/runs/:runId/case-selection/rewrite" },
  { name: "delete org A's run", method: "delete", path: `/api/runs/${RUN_A}`, mounted: "DELETE /api/runs/:runId" },
  { name: "save org A's run case into a library", method: "post", path: `/api/runs/${RUN_A}/cases/case-0/save`, body: { projectId: PROJ_B1 }, mounted: "POST /api/runs/:runId/cases/:caseId/save" },
  { name: "replay org A's case", method: "post", path: "/api/replay", body: { caseIds: [CASE_A] }, mounted: "POST /api/replay" },
];

/**
 * LISTING routes: no id to name, so they cannot 403 — org B is entitled to call them. The
 * assertion is different in kind: the response must be 200 and must contain NONE of org A's rows.
 *
 * These are the routes a 403-only table silently misses, and they are the ones a real tenant
 * actually hits first: the sidebar, the history list, the library.
 */
const LISTING_ROUTES: {
  name: string; path: string; mounted: string;
  /** Every org-A id that must not appear anywhere in the response body. */
  forbidden: string[];
}[] = [
  { name: "projects", path: "/api/projects", mounted: "GET /api/projects", forbidden: [PROJ_A1, PROJ_A2] },
  { name: "suites", path: "/api/suites", mounted: "GET /api/suites", forbidden: [SUITE_A, PROJ_A1] },
  { name: "cases", path: "/api/cases", mounted: "GET /api/cases", forbidden: [CASE_A, PROJ_A1] },
  { name: "run history", path: "/api/runs", mounted: "GET /api/runs", forbidden: [RUN_A] },
];

/**
 * EXEMPT: mounted, and deliberately not cross-org assertable. Every entry needs a reason, because
 * "exempt" is where a real hole would hide.
 */
const EXEMPT: Record<string, string> = {
  "GET /api/health": "public by necessity — reports only whether env vars are set, never a value",
  "GET /api/auth/config": "public by necessity — the UI must learn where to authenticate before it holds a token",
  "POST /api/auth/signup": "public by necessity — an account that does not exist cannot present a token",
  "GET /api/auth/me": "scoped to req.user by construction; returns the caller's own identity only",
  "POST /api/auth/bootstrap": "scoped to req.user; gives the caller an organisation, never reads another's",
  "POST /api/organisations": "creates a NEW organisation for the caller — it is the one route that acts outside every organisation",
  "POST /api/runs": "creates a run in the caller's own org; there is no org-A resource to name",
  "POST /api/projects": "creates a project in the caller's own org",
  "POST /api/suites": "creates a suite; the projectId in the body IS cross-org tested, in the body-id table below",
  "POST /api/cache/walks/clear": "org-admin gated but clears a GLOBAL cache — a real cross-tenant side effect, audit finding F-2, out of scope here and deliberately recorded rather than hidden",
  "GET /api/script-override/warning": "a fixed statement of policy — names no case, reads no row, identical for every caller; deliberately not mounted under /api/cases/:caseId so it cannot look tenant-scoped while behaving otherwise",
  "GET /api/cases/:caseId/steps/jobs/:jobId/events": "editing sessions are scoped by userId, not org — getJob 404s for anyone else",
  "GET /api/cases/:caseId/steps/jobs/:jobId/state": "as above",
  "POST /api/cases/:caseId/steps/jobs/:jobId/cancel": "as above",
  "POST /api/cases/:caseId/steps/jobs/:jobId/credentials": "as above",
};

// --------------------------------------------------------------------------

describe("two organisations — org B cannot reach any of org A's resources", () => {
  for (const route of RESOURCE_ROUTES) {
    it(`refuses org B's OWNER: ${route.name}`, async () => {
      const req = (request(app) as any)[route.method](route.path).set(as(OWNER_B));
      const res = await (route.body ? req.send(route.body) : req);
      expect([403, 404], `${route.method.toUpperCase()} ${route.path} -> ${res.status}`).toContain(res.status);
    });
  }

  // The owner is the strongest identity in org B. If it cannot cross, neither can the weaker two —
  // but a role gate could mask a tenancy hole (a viewer refused for being a viewer, not for being
  // in the wrong org), so the read-only routes are re-checked as org B's viewer too.
  for (const route of RESOURCE_ROUTES.filter((r) => r.method === "get")) {
    it(`refuses org B's VIEWER: ${route.name}`, async () => {
      const res = await request(app).get(route.path).set(as(VIEWER_B));
      expect([403, 404]).toContain(res.status);
    });
  }

  it("refuses an account that belongs to no organisation at all", async () => {
    for (const route of RESOURCE_ROUTES.filter((r) => r.method === "get")) {
      const res = await request(app).get(route.path).set(as(NOBODY));
      expect([403, 404], `${route.path} -> ${res.status}`).toContain(res.status);
    }
  });

  it("401s an unauthenticated caller on every one of them", async () => {
    for (const route of RESOURCE_ROUTES.filter((r) => r.method === "get")) {
      const res = await request(app).get(route.path);
      expect(res.status, route.path).toBe(401);
    }
  });
});

describe("two organisations — listings return the caller's own rows and nothing else", () => {
  for (const route of LISTING_ROUTES) {
    it(`org B's owner sees no org-A rows in ${route.name}`, async () => {
      const res = await request(app).get(route.path).set(as(OWNER_B));
      expect(res.status).toBe(200);
      const body = JSON.stringify(res.body);
      for (const id of route.forbidden) {
        expect(body.includes(id), `${route.path} leaked ${id}`).toBe(false);
      }
    });

    it(`org A's owner DOES see their own rows in ${route.name}`, async () => {
      // Without this the previous test passes trivially if the route is simply broken.
      const res = await request(app).get(route.path).set(as(OWNER_A));
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body).length).toBeGreaterThan(2);
    });
  }
});

describe("two organisations — artifacts", () => {
  it("org B cannot fetch org A's artifact by guessing the path", async () => {
    const res = await request(app).get(`/runs/${RUN_A}/00-input.json`).set(as(OWNER_B));
    expect(res.status).toBe(403);
  });

  it("org A can fetch their own — the guard is not simply refusing everyone", async () => {
    const res = await request(app).get(`/runs/${RUN_A}/00-input.json`).set(as(OWNER_A));
    expect(res.status).toBe(200);
  });

  it("org B's viewer cannot either", async () => {
    const res = await request(app).get(`/runs/${RUN_A}/00-input.json`).set(as(VIEWER_B));
    expect(res.status).toBe(403);
  });
});

describe("two organisations — an id in a request BODY is never authority", () => {
  it("org B cannot file a new suite into org A's project", async () => {
    const res = await request(app).post("/api/suites").set(as(OWNER_B))
      .send({ projectId: PROJ_A1, name: "hijacked" });
    expect([403, 404]).toContain(res.status);
    expect(db.suites.some((s) => s.name === "hijacked")).toBe(false);
  });

  it("org B cannot start a run filed into org A's project", async () => {
    const res = await request(app).post("/api/runs").set(as(OWNER_B))
      .send({ prompt: "p", url: "https://b-one.example.com", projectId: PROJ_A1 });
    // The run itself is allowed — org B may start runs. The FILING must be refused, so the run
    // must not end up attached to org A's project.
    expect(res.status).toBe(202);
    await new Promise((r) => setTimeout(r, 60));
    expect(db.runs.find((r) => r.id === res.body.runId)?.project_id).not.toBe(PROJ_A1);
  });

  it("org B cannot replay org A's case by naming its id", async () => {
    const res = await request(app).post("/api/replay").set(as(OWNER_B)).send({ caseIds: [CASE_A] });
    expect([403, 404]).toContain(res.status);
  });

  it("org B cannot add org A's case to their own suite", async () => {
    const res = await request(app).post(`/api/suites/${SUITE_B}/cases`).set(as(OWNER_B))
      .send({ caseId: CASE_A });
    expect([400, 403, 404]).toContain(res.status);
    expect(db.suite_cases.some((sc) => sc.suite_id === SUITE_B && sc.test_case_id === CASE_A)).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Provisioning — how a second organisation comes to exist at all
// --------------------------------------------------------------------------

describe("provisioning — every signup gets its own organisation", () => {
  it("bootstraps an account with no membership into a NEW org, as owner", async () => {
    const res = await request(app).post("/api/auth/bootstrap").set(as(NOBODY));
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(true);
    expect(res.body.role).toBe("owner");
    expect([ORG_A, ORG_B]).not.toContain(res.body.organisationId);
  });

  it("names it from the local part of their address, not the whole address", async () => {
    const res = await request(app).post("/api/auth/bootstrap").set(as(NOBODY));
    expect(res.body.organisationName).toBe("nobody's workspace");
  });

  it("is idempotent — a second call returns the same org, not another one", async () => {
    const first = await request(app).post("/api/auth/bootstrap").set(as(NOBODY));
    invalidateMemberships();
    const second = await request(app).post("/api/auth/bootstrap").set(as(NOBODY));
    expect(second.body.organisationId).toBe(first.body.organisationId);
    expect(second.body.created).toBe(false);
    expect(db.organisations.filter((o) => o.name === "nobody's workspace")).toHaveLength(1);
  });

  it("does NOT move an existing member — org A's viewer stays a viewer in org A", async () => {
    const res = await request(app).post("/api/auth/bootstrap").set(as(VIEWER_A));
    expect(res.body.organisationId).toBe(ORG_A);
    expect(res.body.role).toBe("viewer");
    expect(res.body.created).toBe(false);
  });

  it("two different signups do not land in the same organisation", async () => {
    const a = await request(app).post("/api/auth/bootstrap").set(as("d0000001-0000-4000-8000-000000000001"));
    invalidateMemberships();
    const b = await request(app).post("/api/auth/bootstrap").set(as("d0000002-0000-4000-8000-000000000002"));
    expect(a.body.organisationId).not.toBe(b.body.organisationId);
  });
});

describe("provisioning — POST /api/organisations", () => {
  it("creates an org with the caller as owner", async () => {
    const res = await request(app).post("/api/organisations").set(as(NOBODY)).send({ name: "Acme" });
    expect(res.status).toBe(201);
    expect(res.body.role).toBe("owner");
    expect(db.organisation_members.some(
      (m) => m.organisation_id === res.body.organisationId && m.user_id === NOBODY && m.role === "owner",
    )).toBe(true);
  });

  it("requires a name", async () => {
    const res = await request(app).post("/api/organisations").set(as(NOBODY)).send({ name: "   " });
    expect(res.status).toBe(400);
  });

  it("401s an unauthenticated caller — a tenant is not anonymous", async () => {
    const res = await request(app).post("/api/organisations").send({ name: "Acme" });
    expect(res.status).toBe(401);
  });

  it("grants the creator nothing in anyone else's organisation", async () => {
    const res = await request(app).post("/api/organisations").set(as(NOBODY)).send({ name: "Acme" });
    invalidateMemberships();
    expect(res.status).toBe(201);
    const peek = await request(app).get(`/api/organisations/${ORG_A}/members`).set(as(NOBODY));
    expect(peek.status).toBe(403);
  });
});

describe("provisioning — primaryOrgFor is deterministic for a user in two organisations", () => {
  it("acts in the same organisation on every call, not an arbitrary one", async () => {
    // Put NOBODY in both, oldest first. Unordered, Postgres could return either.
    db.organisation_members.push(
      { organisation_id: ORG_B, user_id: NOBODY, role: "owner", created_at: "2026-05-01T00:00:00Z" },
      { organisation_id: ORG_A, user_id: NOBODY, role: "owner", created_at: "2026-03-01T00:00:00Z" },
    );
    invalidateMemberships();

    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      invalidateMemberships();
      const res = await request(app).get("/api/auth/me").set(as(NOBODY));
      seen.add(res.body.organisationId);
    }
    expect(seen.size, `switched organisations between calls: ${[...seen]}`).toBe(1);
    // The oldest membership, which is what primaryOrgFor's comment promises.
    expect([...seen][0]).toBe(ORG_A);
  });
});

// --------------------------------------------------------------------------
// M-2 — the synthetic identity is not a real owner
// --------------------------------------------------------------------------

describe("M-2 — the last-owner guard counts people, not the synthetic local identity", () => {
  const SYNTHETIC = "00000000-0000-4000-8000-000000000001";

  it("refuses to demote the only real owner when a synthetic owner row exists", async () => {
    db.organisation_members.push(
      { organisation_id: ORG_A, user_id: SYNTHETIC, role: "owner", created_at: "2025-01-01T00:00:00Z" },
    );
    invalidateMemberships();

    const res = await request(app)
      .patch(`/api/organisations/${ORG_A}/members/${OWNER_A}`)
      .set(as(OWNER_A)).send({ role: "viewer" });
    expect(res.status).toBe(409);
  });

  it("refuses to remove the only real owner for the same reason", async () => {
    db.organisation_members.push(
      { organisation_id: ORG_A, user_id: SYNTHETIC, role: "owner", created_at: "2025-01-01T00:00:00Z" },
    );
    invalidateMemberships();

    const res = await request(app)
      .delete(`/api/organisations/${ORG_A}/members/${OWNER_A}`).set(as(OWNER_A));
    expect(res.status).toBe(409);
  });

  it("still allows demotion once a SECOND real owner exists", async () => {
    db.organisation_members.push(
      { organisation_id: ORG_A, user_id: SYNTHETIC, role: "owner", created_at: "2025-01-01T00:00:00Z" },
    );
    const second = db.organisation_members.find((m) => m.user_id === TESTER_A);
    second.role = "owner";
    invalidateMemberships();

    const res = await request(app)
      .patch(`/api/organisations/${ORG_A}/members/${OWNER_A}`)
      .set(as(OWNER_A)).send({ role: "viewer" });
    expect(res.status).toBe(200);
  });

  it("refuses to act on the synthetic identity itself", async () => {
    db.organisation_members.push(
      { organisation_id: ORG_A, user_id: SYNTHETIC, role: "owner", created_at: "2025-01-01T00:00:00Z" },
    );
    invalidateMemberships();

    const promote = await request(app)
      .patch(`/api/organisations/${ORG_A}/members/${SYNTHETIC}`)
      .set(as(OWNER_A)).send({ role: "viewer" });
    expect(promote.status).toBe(403);

    const remove = await request(app)
      .delete(`/api/organisations/${ORG_A}/members/${SYNTHETIC}`).set(as(OWNER_A));
    expect(remove.status).toBe(403);
  });
});

// --------------------------------------------------------------------------
// The coverage guard
// --------------------------------------------------------------------------

/**
 * Every mounted `/api/*` route must be accounted for.
 *
 * The old guard in tenancy.test.ts filtered to routes beginning `/api/runs/` — so the entire
 * library, case, suite and project surface could grow without it noticing, and it did: at the time
 * this was written those were roughly thirty routes with no cross-org test between them.
 *
 * Inverting it is the fix. Enumerate what Express actually has mounted, subtract the three tables,
 * and fail on whatever is left. Adding a route now fails this test until someone decides which of
 * the three it belongs to — including deciding, in writing, that it is exempt.
 */
describe("the isolation tables account for every mounted /api route", () => {
  const mountedRoutes = (): string[] => {
    const out: string[] = [];
    for (const layer of (app as any)._router.stack) {
      const p = layer.route?.path;
      if (typeof p !== "string" || !p.startsWith("/api/")) continue;
      for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${p}`);
    }
    return out;
  };

  it("reads a plausible route table — otherwise this guard is guarding nothing", () => {
    // Without this the whole check passes vacuously the day Express changes how it exposes routes.
    expect(mountedRoutes().length).toBeGreaterThan(40);
  });

  it("has every mounted route in exactly one table", () => {
    const covered = new Set<string>([
      ...RESOURCE_ROUTES.map((r) => r.mounted),
      ...LISTING_ROUTES.map((r) => r.mounted),
      ...Object.keys(EXEMPT),
    ]);

    const missing = mountedRoutes().filter((m) => !covered.has(m));
    expect(
      missing,
      "these routes are mounted but in no isolation table. Add each to RESOURCE_ROUTES " +
      "(it names someone else's resource), LISTING_ROUTES (it returns a list), or EXEMPT " +
      "(with a reason):\n  " + missing.join("\n  "),
    ).toEqual([]);
  });

  it("has no stale rows — every table entry names a route that still exists", () => {
    const mounted = new Set(mountedRoutes());
    const stale = [
      ...RESOURCE_ROUTES.map((r) => r.mounted),
      ...LISTING_ROUTES.map((r) => r.mounted),
      ...Object.keys(EXEMPT),
    ].filter((m) => !mounted.has(m));
    expect(stale, `these table entries name routes that no longer exist: ${stale.join(", ")}`).toEqual([]);
  });
});
