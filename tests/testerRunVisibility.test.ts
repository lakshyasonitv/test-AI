import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";

/**
 * A tester can see the run they just started — the end-to-end path, not the role gate.
 *
 * Every other tenancy test here proves a REFUSAL. This one proves the thing the product is for,
 * and it is the case that was broken: starting a run against a URL nobody in the organisation had
 * tested yet auto-created a project via `resolveProjectForUrl`, and nothing added the person who
 * caused that creation to it. The Step 5.1 visibility gate then applied identically on every read
 * path — `filterRunsForUser` dropped the run from history, `requireRunRole` refused `/state` and
 * `/events`, `canViewRun` 403'd every screenshot — so a tester could spend a run and then not be
 * allowed to watch it, with only an admin able to unblock them afterwards.
 *
 * It went unseen because admins and owners are exempt from project scoping by role
 * (`visibleProjectIds` returns null for admin and above), and every run on record was started by
 * one. So this test is deliberately driven by a TESTER, and asserts positive visibility.
 *
 * WHY A SEPARATE FILE. `tenancy.test.ts`'s fake accepts writes and deliberately does not apply
 * them, so that each test asserts a decision rather than depending on the order tests happened to
 * run in. That is the right call there and the wrong one here: the whole question is whether a
 * WRITE happened. This file therefore carries its own small mutable fake, reset per test.
 */

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const TESTER = "33333333-0000-4000-8000-000000000003";
const ADMIN = "22222222-0000-4000-8000-000000000002";

/** A project that already exists and the tester is NOT in — the negative control. */
const PROJ_FOREIGN = "ffff1111-0000-4000-8000-00000000f001";

/** Nobody has tested this host, so filing a run against it must create a project. */
const FRESH_URL = "https://fresh-site.example.com";
const FRESH_KEY = "fresh-site.example.com"; // normaliseUrlKey(FRESH_URL)

interface Db {
  organisation_members: any[];
  organisations: any[];
  projects: any[];
  project_members: any[];
  runs: any[];
  run_cases: any[];
}

let db: Db;

/**
 * Set to make the NEXT insert into `projects` fail with this error, then clear itself.
 *
 * Exists to reach one branch that is otherwise unreachable from a test: the unique-violation retry
 * in `resolveProjectForUrl`. That path only fires when two runs race to create the same project,
 * which a single-threaded test cannot produce by timing — and the constraint that raises 23505
 * (`projects_organisation_id_normalised_name_key`) lives in a migration, not in this fake.
 */
let failNextProjectInsert:
  | { code: string; message: string; winnerAppears?: Record<string, unknown> }
  | null = null;

function reset(): void {
  failNextProjectInsert = null;
  db = {
    organisations: [{ id: ORG, name: "Org A" }],
    organisation_members: [
      { organisation_id: ORG, user_id: TESTER, role: "tester" },
      { organisation_id: ORG, user_id: ADMIN, role: "admin" },
    ],
    projects: [
      { id: PROJ_FOREIGN, organisation_id: ORG, name: "foreign.example.com", base_url: "https://foreign.example.com" },
    ],
    project_members: [],
    runs: [],
    run_cases: [],
  };
}
reset();

/**
 * A mutable stand-in for supabase-js's chainable builder. Writes land in `db` so the test can ask
 * what the server actually persisted.
 *
 * `project_members` rows are stored with the denormalised `"projects.organisation_id"` key that
 * `visibleProjectIds` filters on, matching what `tenancy.test.ts` does and for the same reason:
 * the real query uses supabase-js's embedded-resource syntax, and storing the value under that
 * exact key lets it run unmodified against a fake that cannot perform joins.
 */
function makeBuilder(table: keyof Db) {
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  let pending: { kind: "insert" | "upsert" | "update" | "delete"; payload?: any } | null = null;
  let single = false;

  const match = (r: any) =>
    eqs.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c]));

  const decorate = (row: any) => {
    if (table !== "project_members") return row;
    const project = db.projects.find((p) => p.id === row.project_id);
    return { ...row, "projects.organisation_id": project?.organisation_id ?? null };
  };

  const run = () => {
    if (pending?.kind === "insert" && table === "projects" && failNextProjectInsert) {
      const { winnerAppears, ...error } = failNextProjectInsert;
      failNextProjectInsert = null;
      // The winner's row lands HERE, at the moment of the collision — after the caller's lookup
      // already came back empty and before its retry re-reads. Pushing it any earlier would make
      // the lookup find it and return without ever attempting the insert, which is the ordinary
      // path, not the race.
      if (winnerAppears) db.projects.push(winnerAppears as any);
      return { data: null, error };
    }
    if (pending?.kind === "insert" || pending?.kind === "upsert") {
      const payloads = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const made = payloads.map((p: any) => ({ id: p.id ?? crypto.randomUUID(), ...p }));
      for (const m of made) {
        // Honour the upsert dedup the real calls rely on, so a repeated add is not two rows.
        const dup = pending.kind === "upsert" && (db[table] as any[]).some((r) =>
          Object.keys(m).filter((k) => k !== "id").every((k) => r[k] === m[k]));
        if (!dup) (db[table] as any[]).push(m);
      }
      return { data: single ? made[0] : made, error: null };
    }
    if (pending?.kind === "update") {
      const hit = (db[table] as any[]).filter(match);
      for (const r of hit) Object.assign(r, pending.payload);
      return { data: single ? hit[0] ?? null : hit, error: null };
    }
    if (pending?.kind === "delete") {
      db[table] = (db[table] as any[]).filter((r) => !match(r)) as any;
      return { data: null, error: null };
    }
    const found = (db[table] as any[]).map(decorate).filter(match);
    return { data: single ? found[0] ?? null : found, error: null };
  };

  const builder: any = {
    select: () => builder,
    eq: (c: string, v: unknown) => { eqs.push([c, v]); return builder; },
    in: (c: string, v: unknown[]) => { ins.push([c, v]); return builder; },
    order: () => builder,
    limit: () => builder,
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
    from: (table: keyof Db) => makeBuilder(table),
    auth: {
      getUser: async (token: string) =>
        token
          ? { data: { user: { id: token, email: `${token.slice(0, 8)}@example.com` } }, error: null }
          : { data: { user: null }, error: new Error("no token") },
      admin: { listUsers: async () => ({ data: { users: [] }, error: null }) },
    },
  }),
}));

/**
 * No real pipeline. `POST /api/runs` launches Chromium and spends Gemini tokens, and this test is
 * about what the SERVER files, not about what the pipeline produces — so `runPipeline` is a no-op
 * and `makeRunId` stays real, since the id shape is what `app.param("runId")` validates.
 */
vi.mock("../src/orchestrator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/orchestrator.js")>();
  return { ...actual, runPipeline: async () => undefined };
});

const { app } = await import("../src/server/index.js");
const { invalidateMemberships } = await import("../src/server/authz.js");
const request = (await import("supertest")).default;

const ORIGINAL_ENV = { ...process.env };
const created: string[] = [];

const as = (userId: string) => ({ Authorization: `Bearer ${userId}` });

/** Give a run the on-disk presence a real one would have — `allRunIds()` reads the directory. */
function materialise(runId: string, url: string, prompt: string): void {
  const dir = path.join("runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "00-input.json"), JSON.stringify({ url, prompt }), "utf8");
  writeFileSync(
    path.join(dir, "events.ndjson"),
    JSON.stringify({ runId, stage: "input", status: "completed", data: { url, prompt }, ts: Date.now() }) + "\n",
    "utf8",
  );
  created.push(dir);
}

/**
 * Wait for the filing to land.
 *
 * `POST /api/runs` answers 202 immediately and does BOTH database writes fire-and-forget, on
 * purpose: a run is long and expensive and must never be failed or delayed by a database hiccup.
 * So the row and its `project_id` appear a tick or two after the response, and polling for the
 * state under test is the honest way to observe that — not a fixed sleep.
 */
async function settled(runId: string, tries = 50): Promise<any> {
  for (let i = 0; i < tries; i++) {
    const row = db.runs.find((r) => r.id === runId);
    if (row?.project_id) return row;
    await new Promise((r) => setTimeout(r, 10));
  }
  return db.runs.find((r) => r.id === runId);
}

async function startRun(userId: string, body: Record<string, unknown>) {
  const res = await request(app).post("/api/runs").set(as(userId)).send(body);
  if (res.status === 202) materialise(res.body.runId, String(body.url ?? ""), String(body.prompt ?? ""));
  return res;
}

beforeEach(() => {
  process.env.AUTH_ENABLED = "true";
  process.env.DB_ENABLED = "true";
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "fake-publishable";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role";
  reset();
  invalidateMemberships();
});

afterEach(() => {
  for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

afterAll(() => {
  for (const k of ["AUTH_ENABLED", "DB_ENABLED", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k]!;
  }
  for (const dir of created.splice(0)) if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
});

describe("a tester can see the run they just started, against a URL nobody has tested", () => {
  it("files the run under a newly created project", async () => {
    const res = await startRun(TESTER, { prompt: "smoke test the homepage", url: FRESH_URL });
    expect(res.status).toBe(202);

    const row = await settled(res.body.runId);
    expect(row).toBeTruthy();
    expect(row.organisation_id).toBe(ORG);

    const project = db.projects.find((p) => p.id === row.project_id);
    expect(project?.name).toBe(FRESH_KEY);
  });

  it("adds the tester to the project it created for them", async () => {
    const res = await startRun(TESTER, { prompt: "smoke test", url: FRESH_URL });
    const row = await settled(res.body.runId);

    const membership = db.project_members.find(
      (m) => m.project_id === row.project_id && m.user_id === TESTER,
    );
    expect(membership, "the creator must be a member of the project auto-created for their run").toBeTruthy();
  });

  it("shows the run in their own history", async () => {
    const res = await startRun(TESTER, { prompt: "smoke test", url: FRESH_URL });
    await settled(res.body.runId);
    invalidateMemberships();

    const history = await request(app).get("/api/runs").set(as(TESTER));
    expect(history.status).toBe(200);
    expect(history.body.map((r: { runId: string }) => r.runId)).toContain(res.body.runId);
  });

  it("serves /state for it rather than 403ing the person who started it", async () => {
    const res = await startRun(TESTER, { prompt: "smoke test", url: FRESH_URL });
    await settled(res.body.runId);
    invalidateMemberships();

    const state = await request(app).get(`/api/runs/${res.body.runId}/state`).set(as(TESTER));
    expect(state.status).toBe(200);
  });

  it("serves its artifacts to them too — the guard <img> and <video> hit", async () => {
    const res = await startRun(TESTER, { prompt: "smoke test", url: FRESH_URL });
    await settled(res.body.runId);
    invalidateMemberships();

    // 200, not 403: reaching the filesystem at all is what proves the guard let them through.
    const artifact = await request(app).get(`/runs/${res.body.runId}/00-input.json`).set(as(TESTER));
    expect(artifact.status).toBe(200);
  });

  it("does not create a second project for the next run against the same URL", async () => {
    const first = await startRun(TESTER, { prompt: "one", url: FRESH_URL });
    await settled(first.body.runId);
    const second = await startRun(TESTER, { prompt: "two", url: FRESH_URL });
    await settled(second.body.runId);

    expect(db.projects.filter((p) => p.name === FRESH_KEY)).toHaveLength(1);
    expect(db.project_members.filter((m) => m.user_id === TESTER)).toHaveLength(1);
  });
});

/**
 * Losing the race to create a project.
 *
 * The unique index on (organisation_id, normalised_name) closes the duplicate-project race, and in
 * doing so it turns the loser's insert into an error. If that error just returned null, the loser's
 * run would be filed under no project — and an unfiled run is admin-visible only, so its author
 * could not see it. That is the same failure the creator-membership fix exists to prevent, arriving
 * by a different route, which is why the retry has its own tests rather than being assumed.
 */
describe("two runs racing to create the same project", () => {
  const winnerRow = (id: string) =>
    ({ id, organisation_id: ORG, name: FRESH_KEY, base_url: FRESH_URL });

  it("files the loser's run under the winner's project instead of nothing", async () => {
    const winner = winnerRow("eeee1111-0000-4000-8000-00000000e001");
    failNextProjectInsert = {
      code: "23505",
      message: 'duplicate key value violates unique constraint "projects_organisation_id_normalised_name_key"',
      winnerAppears: winner,
    };

    const res = await startRun(TESTER, { prompt: "loser", url: FRESH_URL });
    expect(res.status).toBe(202);

    const row = await settled(res.body.runId);
    expect(row?.project_id, "the run must be filed, not left unfiled").toBe(winner.id);
    expect(db.projects.filter((p) => p.name === FRESH_KEY)).toHaveLength(1);
  });

  it("still adds the loser to the project, so they can see their own run", async () => {
    const winner = winnerRow("eeee2222-0000-4000-8000-00000000e002");
    failNextProjectInsert = {
      code: "23505", message: "duplicate key value violates unique constraint", winnerAppears: winner,
    };

    const res = await startRun(TESTER, { prompt: "loser", url: FRESH_URL });
    await settled(res.body.runId);
    expect(db.project_members.some((m) => m.project_id === winner.id && m.user_id === TESTER)).toBe(true);

    invalidateMemberships();
    const state = await request(app).get(`/api/runs/${res.body.runId}/state`).set(as(TESTER));
    expect(state.status).toBe(200);
  });

  it("does not retry a failure that is not a unique violation", async () => {
    // A connection error, not a race. There is no winner to fall back to, and re-reading would
    // either find nothing or find something unrelated — so the run stays unfiled, deliberately.
    failNextProjectInsert = { code: "08006", message: "connection failure" };

    const res = await startRun(TESTER, { prompt: "broken", url: FRESH_URL });
    await settled(res.body.runId, 10);

    expect(db.runs.find((r) => r.id === res.body.runId)?.project_id).toBeUndefined();
    expect(db.project_members).toHaveLength(0);
  });
});

/**
 * The other half of the fix: it must widen access to the project the run CAUSED to exist, and to
 * nothing else. A membership granted by starting a run would be a way to award yourself access to
 * whatever you liked by naming it.
 */
describe("filing a run never grants access to a project that already existed", () => {
  it("refuses an explicit projectId the tester has not been added to", async () => {
    const res = await startRun(TESTER, {
      prompt: "smoke test", url: "https://foreign.example.com", projectId: PROJ_FOREIGN,
    });
    expect(res.status).toBe(202); // the run itself is allowed; the FILING is what gets refused
    await settled(res.body.runId, 10);

    expect(db.project_members.some((m) => m.user_id === TESTER && m.project_id === PROJ_FOREIGN)).toBe(false);
    expect(db.runs.find((r) => r.id === res.body.runId)?.project_id).toBeUndefined();
  });

  it("leaves an existing project's membership alone when the URL already has one", async () => {
    // An admin's run creates the project; the admin is exempt from project scoping by role, so no
    // membership row is needed for them to see it — but one is written, and only for them.
    const adminRun = await startRun(ADMIN, { prompt: "first", url: FRESH_URL });
    await settled(adminRun.body.runId);
    invalidateMemberships();

    const testerRun = await startRun(TESTER, { prompt: "second", url: FRESH_URL });
    await settled(testerRun.body.runId, 10);

    // The project already existed, so the tester is NOT auto-added — visibility stays an admin's
    // decision for anything they did not cause to be created.
    expect(db.project_members.some((m) => m.user_id === TESTER)).toBe(false);
  });
});
