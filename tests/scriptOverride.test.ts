import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { randomUUID } from "node:crypto";

/**
 * A case version is either IR-driven or script-overridden, and which one is an explicit stored
 * flag — never inferred, never ambiguous.
 *
 * What these tests are really protecting, in order of how badly it would hurt:
 *
 *  1. **`getCaseScript` must not fall back for an overridden version.** Its two ordinary sources
 *     (stored bytes, or `generateSpec(ir)` re-derived now) are interchangeable *because the
 *     generator is deterministic* — that is the documented contract. An override is by definition
 *     not derivable from the IR, so silently regenerating would hand the reader a script that is
 *     not the one that runs. It has to fail loudly instead.
 *  2. **Self-heal must not touch an overridden case.** `attemptHeal` rebuilds the IR via `toIR`
 *     and regenerates the spec from it. On an overridden case a "successful" heal would discard
 *     the author's script, run something nobody wrote, and report a pass.
 *  3. **The permission gate.** Overriding is authoring, so `tester` and above — the same bar
 *     `assertCanAuthor` sets for every other library mutation.
 *  4. **The confirmation.** A client cannot set an override without being handed the
 *     not-grounded warning to show.
 */

const ORG = "aaaaaaaa-0000-4000-8000-00000000000b";
const OWNER = "11111111-0000-4000-8000-000000000011";
const VIEWER = "22222222-0000-4000-8000-000000000022";
const PROJ = "aaaa1111-0000-4000-8000-00000000b001";
const CASE = "bbbb1111-0000-4000-8000-00000000b002";

const OVERRIDE_SCRIPT = `import { test, expect } from "@playwright/test";
test("hand written", async ({ page }) => {
  await page.goto("https://example.com/");
  await page.getByRole("link", { name: "Hand Written Link" }).click();
});
`;

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
    { id: "s2", action: "assert", assertion: "url_contains", value: "/faq" },
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
      { organisation_id: ORG, user_id: VIEWER, role: "viewer" },
    ],
    projects: [{ id: PROJ, organisation_id: ORG, name: "example.com", base_url: "https://example.com" }],
    project_members: [],
    runs: [],
    suites: [],
    test_cases: [{
      id: CASE, project_id: PROJ, title: "Navigate to the FAQ page", feature: "navigation",
      ir: FIXTURE_IR, current_version: 1, source_run_id: null,
      last_run_status: null, last_run_at: null, updated_at: new Date().toISOString(),
      script_override: null, script_overridden: false,
    }],
    test_case_versions: [{
      test_case_id: CASE, version: 1, ir: FIXTURE_IR, spec: null,
      change_note: "Saved", saved_by: OWNER, saved_at: new Date().toISOString(),
      script_override: null, script_overridden: false,
    }],
    suite_cases: [],
    run_cases: [],
  };
}

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

/**
 * Captured and restored in afterAll. Several existing test files set these at module scope and
 * never put them back, which makes whichever file a worker runs next depend on scheduling — the
 * flake this suite already has. Not repeating it here.
 */
const ENV_KEYS = [
  "AUTH_ENABLED", "DB_ENABLED", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SCRIPT_OVERRIDE_ENABLED",
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

process.env.AUTH_ENABLED = "true";
process.env.DB_ENABLED = "true";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
// The feature is OFF by default (CLAUDE.md rule 2); these tests opt in, and the block at the
// bottom of this file turns it back off to prove what "off" means.
process.env.SCRIPT_OVERRIDE_ENABLED = "true";

afterAll(() => {
  for (const k of ENV_KEYS) {
    const original = ORIGINAL_ENV[k];
    if (original === undefined) delete process.env[k];
    else process.env[k] = original;
  }
});

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
const { getCaseScript, loadCasesForReplay } = await import("../src/server/library.js");
const { attemptHeal } = await import("../src/stages/heal.js");

const as = (userId: string) => ({ Authorization: `Bearer ${userId}` });

beforeEach(() => {
  reset();
  invalidateMemberships();
});

describe("the permission gate", () => {
  it("refuses a viewer", async () => {
    const res = await request(app)
      .put(`/api/cases/${CASE}/script-override`)
      .set(as(VIEWER))
      .send({ script: OVERRIDE_SCRIPT, confirm: true });
    expect(res.status).toBe(403);
    // And nothing was written.
    expect(db.test_cases[0].script_overridden).toBe(false);
  });

  it("refuses an unauthenticated caller", async () => {
    const res = await request(app)
      .put(`/api/cases/${CASE}/script-override`)
      .send({ script: OVERRIDE_SCRIPT, confirm: true });
    expect(res.status).toBe(401);
  });

  it("allows tester and above", async () => {
    const res = await request(app)
      .put(`/api/cases/${CASE}/script-override`)
      .set(as(OWNER))
      .send({ script: OVERRIDE_SCRIPT, confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.overridden).toBe(true);
  });
});

describe("the confirmation", () => {
  it("refuses to set an override without confirm: true, and hands back the warning", async () => {
    const res = await request(app)
      .put(`/api/cases/${CASE}/script-override`)
      .set(as(OWNER))
      .send({ script: OVERRIDE_SCRIPT });
    expect(res.status).toBe(400);
    expect(res.body.warning).toContain("not grounded");
    expect(db.test_cases[0].script_overridden).toBe(false);
  });

  it("states the two things a person has to know: not grounded, and fails silently", async () => {
    const res = await request(app).get("/api/script-override/warning").set(as(OWNER));
    expect(res.status).toBe(200);
    expect(res.body.warning).toMatch(/not grounded/i);
    expect(res.body.warning).toMatch(/verified against a real discovered element/i);
    expect(res.body.warning).toMatch(/silently rather than loudly/i);
  });

  it("does NOT require confirmation to remove an override", async () => {
    await request(app).put(`/api/cases/${CASE}/script-override`)
      .set(as(OWNER)).send({ script: OVERRIDE_SCRIPT, confirm: true });
    const res = await request(app).put(`/api/cases/${CASE}/script-override`)
      .set(as(OWNER)).send({ script: null });
    expect(res.status).toBe(200);
    expect(res.body.overridden).toBe(false);
    expect(db.test_cases[0].script_overridden).toBe(false);
  });

  it("rejects an empty override", async () => {
    const res = await request(app).put(`/api/cases/${CASE}/script-override`)
      .set(as(OWNER)).send({ script: "   ", confirm: true });
    expect(res.status).toBe(400);
  });
});

describe("versioning", () => {
  it("mints a version with author and timestamp, and is revertible", async () => {
    await request(app).put(`/api/cases/${CASE}/script-override`)
      .set(as(OWNER)).send({ script: OVERRIDE_SCRIPT, confirm: true });

    const v2 = db.test_case_versions.find((v) => v.version === 2);
    expect(v2.script_overridden).toBe(true);
    expect(v2.script_override).toContain("Hand Written Link");
    expect(v2.saved_by).toBe(OWNER);
    expect(v2.change_note).toBe("Script overridden");

    // Reverting is a new version with the flag off — history is kept, not rewritten.
    await request(app).put(`/api/cases/${CASE}/script-override`)
      .set(as(OWNER)).send({ script: null });
    const v3 = db.test_case_versions.find((v) => v.version === 3);
    expect(v3.script_overridden).toBe(false);
    expect(v3.script_override).toBeNull();
    expect(db.test_case_versions.find((v) => v.version === 2).script_overridden).toBe(true);
  });

  it("carries the IR forward untouched, so a revert restores a real case", async () => {
    await request(app).put(`/api/cases/${CASE}/script-override`)
      .set(as(OWNER)).send({ script: OVERRIDE_SCRIPT, confirm: true });
    const v2 = db.test_case_versions.find((v) => v.version === 2);
    expect(v2.ir.steps).toHaveLength(FIXTURE_IR.steps.length);
    expect(v2.ir.meta.title).toBe(FIXTURE_IR.meta.title);
  });
});

describe("getCaseScript", () => {
  it("returns the override, flagged, rather than anything derived from the IR", async () => {
    await request(app).put(`/api/cases/${CASE}/script-override`)
      .set(as(OWNER)).send({ script: OVERRIDE_SCRIPT, confirm: true });

    const script = await getCaseScript(OWNER, ORG, "owner" as any, CASE);
    expect(script.overridden).toBe(true);
    expect(script.source).toBe("override");
    expect(script.spec).toContain("Hand Written Link");
    // The generated spec would have mentioned the IR's own step; the override must not.
    expect(script.spec).not.toContain("url_contains");
  });

  it("THROWS rather than silently regenerating when a version is flagged but stores no script", async () => {
    db.test_cases[0].script_overridden = true;
    db.test_case_versions[0].script_overridden = true;
    db.test_case_versions[0].script_override = null;

    // The ordinary fallback would happily return generateSpec(ir) here — a script that is NOT what
    // this version runs. That is the one case where falling back is a lie rather than a re-derivation.
    await expect(getCaseScript(OWNER, ORG, "owner" as any, CASE)).rejects.toThrow(/refusing to fall back/i);
  });

  it("is unchanged for an ordinary case", async () => {
    const script = await getCaseScript(OWNER, ORG, "owner" as any, CASE);
    expect(script.overridden).toBe(false);
    expect(["stored", "generated"]).toContain(script.source);
  });
});

describe("loadCasesForReplay", () => {
  it("carries the override through to the runner when the flag is set", async () => {
    await request(app).put(`/api/cases/${CASE}/script-override`)
      .set(as(OWNER)).send({ script: OVERRIDE_SCRIPT, confirm: true });
    const [c] = await loadCasesForReplay(OWNER, ORG, "owner" as any, { caseIds: [CASE] });
    expect(c.scriptOverride).toContain("Hand Written Link");
  });

  it("omits it for an ordinary case", async () => {
    const [c] = await loadCasesForReplay(OWNER, ORG, "owner" as any, { caseIds: [CASE] });
    expect(c.scriptOverride).toBeUndefined();
  });

  it("never resurrects a leftover script when the flag is off", async () => {
    // A removed override leaves the column populated on older version rows; the flag is what
    // decides, so a stale script must not come back to life.
    db.test_cases[0].script_override = OVERRIDE_SCRIPT;
    db.test_cases[0].script_overridden = false;
    const [c] = await loadCasesForReplay(OWNER, ORG, "owner" as any, { caseIds: [CASE] });
    expect(c.scriptOverride).toBeUndefined();
  });
});

describe("self-heal", () => {
  it("does not attempt to heal an overridden case", async () => {
    // The guard is the first thing attemptHeal does, so it returns before touching any of the
    // arguments a real heal would need. If the guard regressed, this call would try to reach the
    // LLM and the browser and fail loudly — which is exactly the signal we want.
    const result = await attemptHeal({
      scriptOverridden: true,
      testCase: {} as any,
      ir: { meta: {}, steps: [] } as any,
      appModel: {} as any,
      diagnosis: { failingStepId: "s2" } as any,
      sourcePrompt: "",
      entryUrl: "https://example.com",
      outDir: "runs/__never_created__",
    });
    expect(result).toBeNull();
  });
});

describe("the AI step-improvement flow", () => {
  it("refuses a rewrite on an overridden case instead of proposing an inert edit", async () => {
    await request(app).put(`/api/cases/${CASE}/script-override`)
      .set(as(OWNER)).send({ script: OVERRIDE_SCRIPT, confirm: true });

    const res = await request(app).post(`/api/cases/${CASE}/rewrite`)
      .set(as(OWNER)).send({ instruction: "also check the footer" });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/would not change what runs/i);
  });
});

describe("editing steps on an overridden case", () => {
  it("keeps the override rather than silently clearing it", async () => {
    await request(app).put(`/api/cases/${CASE}/script-override`)
      .set(as(OWNER)).send({ script: OVERRIDE_SCRIPT, confirm: true });

    const edited = {
      ...FIXTURE_IR,
      steps: [...FIXTURE_IR.steps, { id: "s3", action: "assert", assertion: "url_contains", value: "/extra" }],
    };
    const res = await request(app).patch(`/api/cases/${CASE}`)
      .set(as(OWNER)).send({ ir: edited });
    expect(res.status).toBe(200);

    // The edit is recorded in full...
    const v3 = db.test_case_versions.find((v) => v.version === 3);
    expect(v3.ir.steps).toHaveLength(3);
    // ...and the override still wins. The two tables must agree about that, or a replay and the
    // Script tab would disagree about what this case runs.
    expect(v3.script_overridden).toBe(true);
    expect(db.test_cases[0].script_overridden).toBe(true);
  });
});

describe("the env flag, default OFF", () => {
  /**
   * Rule 2: "with every flag off, the tool behaves exactly as it did before any of this existed."
   * For this feature that has to mean more than hiding a button — a stored override must not RUN.
   * Otherwise switching the flag off would leave hand-written scripts executing invisibly, which
   * is the opposite of what turning a feature off should mean.
   */
  const off = () => { process.env.SCRIPT_OVERRIDE_ENABLED = "false"; };
  const on = () => { process.env.SCRIPT_OVERRIDE_ENABLED = "true"; };

  it("404s the override route", async () => {
    off();
    const res = await request(app).put(`/api/cases/${CASE}/script-override`)
      .set(as(OWNER)).send({ script: OVERRIDE_SCRIPT, confirm: true });
    on();
    expect(res.status).toBe(404);
  });

  it("404s the warning route", async () => {
    off();
    const res = await request(app).get("/api/script-override/warning").set(as(OWNER));
    on();
    expect(res.status).toBe(404);
  });

  it("does NOT run a stored override — the case falls back to its IR", async () => {
    // Flagged in the database, exactly as if the feature had been enabled and later switched off.
    db.test_cases[0].script_override = OVERRIDE_SCRIPT;
    db.test_cases[0].script_overridden = true;

    off();
    const [c] = await loadCasesForReplay(OWNER, ORG, "owner" as any, { caseIds: [CASE] });
    const script = await getCaseScript(OWNER, ORG, "owner" as any, CASE);
    on();

    expect(c.scriptOverride).toBeUndefined();
    expect(script.overridden).toBe(false);
    expect(script.spec).not.toContain("Hand Written Link");
  });

  it("is a validated boolean flag, so a typo in it is refused at boot", async () => {
    const { BOOLEAN_ENV_FLAGS, findInvalidBooleanFlags } = await import("../src/server/index.js");
    expect(BOOLEAN_ENV_FLAGS).toContain("SCRIPT_OVERRIDE_ENABLED");
    expect(findInvalidBooleanFlags({ SCRIPT_OVERRIDE_ENABLED: "yes" }))
      .toEqual([{ name: "SCRIPT_OVERRIDE_ENABLED", found: "yes" }]);
  });
});
