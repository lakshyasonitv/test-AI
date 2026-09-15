import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

/**
 * `POST /api/replay` must ASK for credentials before it executes — TECH_DEBT.md TD-66.
 *
 * THE FAILURE THIS PINS. A saved login case stores `${env:TEST_USERNAME}` /
 * `${env:TEST_PASSWORD}` rather than literals (credentials never reach disk — `CLAUDE.md` rule 5).
 * `runReplay` accepts `creds`, but its only caller once passed none, so `credentialEnvVars(undefined)`
 * was `{}`, the generated spec's `process.env.TEST_USERNAME ?? ""` typed an EMPTY STRING into the
 * login form, the sign-in silently failed, and the case died several steps later on whatever
 * assertion first noticed it was logged out.
 *
 * Seen again on run `2026-09-04T10-44-48-583Z-a388c88e` ("Search with no results"), which failed at
 * `expect(input[placeholder="*********"]).toBeHidden()` — the password box was still on screen.
 * Its `events.ndjson` carries **no `credentials` event at all**, and `execute` started 25 ms after
 * `suite` did, so nothing was ever asked.
 *
 * The ORDERING assertion is the point. "A credentials event exists somewhere" would pass against a
 * server that asked after executing, which is the same bug wearing a different shape. What has to
 * hold is that the prompt is emitted, answered, and the answer is in hand BEFORE the spec runs.
 */

const TEST_RUN_ID_PREFIX = "replay-cred-test";
const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";
const OWNER = "11111111-0000-4000-8000-000000000001";
const PROJ = "aaaa1111-0000-4000-8000-00000000a001";
const CASE_LOGIN = "c111aaaa-0000-4000-8000-0000000000c1";
const CASE_NOAUTH = "c222aaaa-0000-4000-8000-0000000000c2";

/** Mirrors a real saved login case: the credential steps carry env references, never literals. */
const loginIr = () => ({
  meta: {
    feature: "auth", title: "Search with no results", priority: "medium",
    sourcePrompt: "search for something that does not exist",
    baseUrl: "https://learnvibes.vercel.app",
  },
  steps: [
    { id: "auth-0", action: "navigate", target: { url: "/login" } },
    { id: "auth-1", action: "fill", target: { role: "textbox", name: "Email" }, value: "${env:TEST_USERNAME}" },
    { id: "auth-2", action: "fill", target: { role: "textbox", name: "Password" }, value: "${env:TEST_PASSWORD}" },
    { id: "auth-3", action: "click", target: { role: "button", name: "Sign In" } },
    { id: "s1", action: "assert", target: { role: "textbox", name: "Password" }, assertion: "hidden" },
  ],
});

/** No credential anywhere — the control case that must NOT prompt. */
const plainIr = () => ({
  meta: {
    feature: "nav", title: "Open the homepage", priority: "low",
    sourcePrompt: "open it", baseUrl: "https://learnvibes.vercel.app",
  },
  steps: [{ id: "s1", action: "navigate", target: { url: "/" } }],
});

interface Tables {
  organisation_members: any[]; projects: any[]; project_members: any[]; runs: any[];
  suites: any[]; test_cases: any[]; test_case_versions: any[]; suite_cases: any[]; run_cases: any[];
}
let db: Tables;

function reset() {
  db = {
    organisation_members: [{ organisation_id: ORG, user_id: OWNER, role: "owner" }],
    projects: [{ id: PROJ, organisation_id: ORG, name: "learnvibes", base_url: "https://learnvibes.vercel.app" }],
    project_members: [],
    runs: [],
    suites: [],
    test_cases: [
      { id: CASE_LOGIN, project_id: PROJ, title: "Search with no results", feature: "auth", ir: loginIr(), current_version: 1, source_run_id: null, last_run_status: null, last_run_at: null, updated_at: null },
      { id: CASE_NOAUTH, project_id: PROJ, title: "Open the homepage", feature: "nav", ir: plainIr(), current_version: 1, source_run_id: null, last_run_status: null, last_run_at: null, updated_at: null },
    ],
    test_case_versions: [],
    suite_cases: [],
    run_cases: [],
  };
}

function makeBuilder(table: keyof Tables) {
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  let pending: { kind: "insert" | "update" | "upsert" | "delete"; payload?: any } | null = null;
  let single = false;
  const match = (r: any) => eqs.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c]));
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
    if (pending?.kind === "delete") { db[table] = rows.filter((r) => !match(r)) as any; return { data: null, error: null }; }
    const found = rows.filter(match);
    return { data: single ? found[0] ?? null : found, error: null };
  };
  const builder: any = {
    select: () => builder,
    eq: (c: string, v: unknown) => { eqs.push([c, v]); return builder; },
    in: (c: string, v: unknown[]) => { ins.push([c, v]); return builder; },
    order: () => builder, limit: () => builder,
    insert: (p: any) => { pending = { kind: "insert", payload: p }; return builder; },
    update: (p: any) => { pending = { kind: "update", payload: p }; return builder; },
    upsert: (p: any) => { pending = { kind: "upsert", payload: p }; return builder; },
    delete: () => { pending = { kind: "delete" }; return builder; },
    single: () => { single = true; return Promise.resolve(run()); },
    maybeSingle: () => { single = true; return Promise.resolve(run()); },
    then: (r: any, j: any) => Promise.resolve(run()).then(r, j),
  };
  return builder;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (t: string) => makeBuilder(t as keyof Tables),
    auth: { admin: { listUsers: async () => ({ data: { users: [] } }) } },
  }),
}));

/**
 * The whole point of the test is what reaches the Playwright child's environment, so `runSpec` is
 * captured rather than run. Everything upstream of it — the route, the waiter, `runReplay`,
 * `credentialEnvVars` — is the real implementation.
 */
const runSpecCalls: Array<{ secretEnv: Record<string, string> }> = [];
const generateSpec = vi.fn(() => "// spec");
const runSpec = vi.fn(async (_spec: string, _dir: string, secretEnv: Record<string, string> = {}) => {
  runSpecCalls.push({ secretEnv });
  return { passed: true, exitCode: 0, resultsJsonPath: "", artifactsDir: "", raw: null };
});
vi.mock("../src/stages/generator.js", () => ({ generateSpec: (...a: any[]) => (generateSpec as any)(...a) }));
vi.mock("../src/stages/executor.js", async (orig) => ({
  ...(await orig<any>()),
  runSpec: (...a: any[]) => (runSpec as any)(...a),
  findScreenshot: () => null,
  findVideo: () => null,
  detectBlocked: () => null,
}));

process.env.AUTH_ENABLED = "true";
process.env.DB_ENABLED = "true";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
// Deliberately UNSET. Under "prompt-first" the environment is only a fallback, so leaving these
// set would let a run that never prompted still end up with credentials — the test would pass
// against the exact bug it exists to catch.
delete process.env.TEST_USERNAME;
delete process.env.TEST_PASSWORD;

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
const { credentialKindsNeeded } = await import("../src/stages/credentials.js");

const as = (userId: string) => ({ Authorization: `Bearer ${userId}` });

/** Run ids the route minted, so this file deletes exactly the directories it caused. */
const created: string[] = [];
const cleanup = () => {
  for (const id of created) { try { rmSync(path.join("runs", id), { recursive: true, force: true }); } catch { /* gone */ } }
  created.length = 0;
};

// `/state` answers with the event ARRAY itself, not `{ events: [...] }`. Reading the wrong shape
// here is silent: every poll returns [], `waitFor` simply times out, and a test that does not
// assert on ordering still goes green for the wrong reason. It did, before this was fixed.
const events = async (runId: string): Promise<any[]> => {
  const body = (await request(app).get(`/api/runs/${runId}/state`).set(as(OWNER))).body;
  return Array.isArray(body) ? body : [];
};

/** Poll until `pred` sees what it is waiting for, or give up. Replay work is backgrounded. */
async function waitFor(runId: string, pred: (e: any[]) => boolean, ms = 8000): Promise<any[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const evs = await events(runId);
    if (pred(evs)) return evs;
    if (Date.now() > deadline) return evs;
    await new Promise((r) => setTimeout(r, 25));
  }
}

const idxOf = (evs: any[], stage: string, status: string) =>
  evs.findIndex((e) => e.stage === stage && e.status === status);

beforeEach(() => { reset(); invalidateMemberships(); runSpecCalls.length = 0; });
afterAll(cleanup);

describe("POST /api/replay — credentials are collected before anything executes (TD-66)", () => {
  it("emits `credentials started` with both fields, BEFORE `execute started`", async () => {
    const res = await request(app).post("/api/replay").set(as(OWNER)).send({ caseIds: [CASE_LOGIN] });
    expect(res.status).toBe(202);
    const runId: string = res.body.runId;
    created.push(runId);

    const evs = await waitFor(runId, (e) => idxOf(e, "credentials", "started") !== -1);
    const credIdx = idxOf(evs, "credentials", "started");
    expect(credIdx).toBeGreaterThan(-1);
    expect(evs[credIdx].data.fields).toEqual(["username", "password"]);

    // Nothing may have executed yet: the prompt is still open and unanswered.
    expect(idxOf(evs, "execute", "started")).toBe(-1);
    expect(runSpecCalls.length).toBe(0);

    // Answer it, then let the run finish.
    const ans = await request(app).post(`/api/runs/${runId}/credentials`).set(as(OWNER))
      .send({ username: "real-user@example.com", password: "real-password-123" });
    expect(ans.status).toBe(204);

    const done = await waitFor(runId, (e) => idxOf(e, "done", "completed") !== -1 || idxOf(e, "error", "failed") !== -1);
    const finalCred = idxOf(done, "credentials", "started");
    const exec = idxOf(done, "execute", "started");
    expect(exec).toBeGreaterThan(-1);
    expect(finalCred).toBeLessThan(exec);   // the ordering that actually matters
  });

  it("hands the typed values — not empty strings — to the Playwright child", async () => {
    const res = await request(app).post("/api/replay").set(as(OWNER)).send({ caseIds: [CASE_LOGIN] });
    const runId: string = res.body.runId;
    created.push(runId);

    await waitFor(runId, (e) => idxOf(e, "credentials", "started") !== -1);
    await request(app).post(`/api/runs/${runId}/credentials`).set(as(OWNER))
      .send({ username: "real-user@example.com", password: "real-password-123" });
    await waitFor(runId, (e) => idxOf(e, "done", "completed") !== -1 || idxOf(e, "error", "failed") !== -1);

    expect(runSpecCalls.length).toBeGreaterThan(0);
    const env = runSpecCalls[0].secretEnv;
    // The exact regression: `{}` here is what typed "" into the login form.
    expect(env.TEST_USERNAME).toBe("real-user@example.com");
    expect(env.TEST_PASSWORD).toBe("real-password-123");
  });

  it("does not prompt for a case that carries no credential reference", async () => {
    const res = await request(app).post("/api/replay").set(as(OWNER)).send({ caseIds: [CASE_NOAUTH] });
    const runId: string = res.body.runId;
    created.push(runId);

    const evs = await waitFor(runId, (e) => idxOf(e, "done", "completed") !== -1 || idxOf(e, "error", "failed") !== -1);
    expect(idxOf(evs, "credentials", "started")).toBe(-1);
    expect(runSpecCalls[0]?.secretEnv ?? {}).toEqual({});
  });
});

/**
 * `credentialKindsNeeded` reads `step.value` and never looks at `step.action`. That is what makes
 * it correct for the LMS login, which submits with a BUTTON rather than by filling a last field —
 * an env reference parked on a `press` or a `click` still has to be seen.
 */
describe("credentialKindsNeeded — action-agnostic by design", () => {
  it("sees an env reference on fill, press and click alike", () => {
    for (const action of ["fill", "press", "click"]) {
      expect(credentialKindsNeeded([{ action, value: "${env:TEST_PASSWORD}" } as any]))
        .toEqual(["username", "password"]);
    }
  });

  it("asks for the pair even when only one kind is referenced", () => {
    expect(credentialKindsNeeded([{ value: "${env:TEST_USERNAME}" } as any])).toEqual(["username", "password"]);
  });

  it("asks for nothing when no step references a credential", () => {
    expect(credentialKindsNeeded([{ value: "plain text" } as any, { value: undefined } as any])).toEqual([]);
  });
});
