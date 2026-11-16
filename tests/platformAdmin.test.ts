import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * D-84 — platform admins and company organisations (PLATFORM_ADMIN_ENABLED).
 *
 * The user's model: viewer < tester < owner < Admin. Only an Admin creates organisations; an Admin
 * reaches every organisation and creates users of any role in any of them; an owner creates users who
 * belong to the owner's organisation; one organisation per person; testers and viewers work only in
 * the projects their owner gave them (TD-193); nobody gets an empty organisation of their own on first
 * sign-in (TD-191).
 *
 * Only `@supabase/supabase-js` is faked (an in-memory, MUTABLE store, so a created user is really
 * there for the next read) and the pipeline is stubbed, so an allowed run gets past every gate
 * without a browser or a model call. The real middleware and route handlers run.
 */

const ORG_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const ORG_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const ADMIN = "99999999-0000-4000-8000-000000000009";     // platform admin, member of no organisation
const OWNER_A = "11111111-0000-4000-8000-000000000001";
const LEGACY_ADMIN_A = "22222222-0000-4000-8000-000000000002"; // an old in-company "admin" row
const TESTER_A = "33333333-0000-4000-8000-000000000003";
const VIEWER_A = "44444444-0000-4000-8000-000000000004";
const OWNER_B = "55555555-0000-4000-8000-000000000005";
const ORPHAN = "66666666-0000-4000-8000-000000000006";   // signed in, in no organisation
const PROJ_A1 = "aaaa1111-0000-4000-8000-00000000a001";
const PROJ_A2 = "aaaa2222-0000-4000-8000-00000000a002";

type Row = Record<string, any>;
let db: Record<string, Row[]>;
let users: { id: string; email: string }[];
let created: { email: string; password: string; email_confirm?: boolean }[];

function reset() {
  db = {
    organisations: [
      { id: ORG_A, name: "Acme", created_at: "2026-01-01" },
      { id: ORG_B, name: "Globex", created_at: "2026-01-02" },
    ],
    organisation_members: [
      { organisation_id: ORG_A, user_id: OWNER_A, role: "owner", created_at: "1" },
      { organisation_id: ORG_A, user_id: LEGACY_ADMIN_A, role: "admin", created_at: "2" },
      { organisation_id: ORG_A, user_id: TESTER_A, role: "tester", created_at: "3" },
      { organisation_id: ORG_A, user_id: VIEWER_A, role: "viewer", created_at: "4" },
      { organisation_id: ORG_B, user_id: OWNER_B, role: "owner", created_at: "5" },
    ],
    platform_admins: [{ user_id: ADMIN, email: "admin@gmail.com" }],
    projects: [
      { id: PROJ_A1, organisation_id: ORG_A, name: "alpha.example.com", base_url: "https://alpha.example.com", created_at: "1" },
      { id: PROJ_A2, organisation_id: ORG_A, name: "beta.example.com", base_url: "https://beta.example.com", created_at: "2" },
    ],
    project_members: [
      { project_id: PROJ_A1, user_id: TESTER_A, "projects.organisation_id": ORG_A, projects: { organisation_id: ORG_A } },
      { project_id: PROJ_A1, user_id: VIEWER_A, "projects.organisation_id": ORG_A, projects: { organisation_id: ORG_A } },
    ],
    runs: [],
  };
  users = [
    { id: ADMIN, email: "admin@gmail.com" }, { id: OWNER_A, email: "owner-a@example.com" },
    { id: LEGACY_ADMIN_A, email: "old-admin@example.com" }, { id: TESTER_A, email: "tester-a@example.com" },
    { id: VIEWER_A, email: "viewer-a@example.com" }, { id: OWNER_B, email: "owner-b@example.com" },
    { id: ORPHAN, email: "orphan@example.com" },
  ];
  created = [];
}
reset();

let nextId = 1;
function builder(table: string) {
  const eqs: [string, unknown][] = [];
  const ins: [string, unknown[]][] = [];
  let op: "select" | "insert" | "update" | "delete" = "select";
  let payload: Row | Row[] | null = null;
  let inserted: Row[] = [];
  const match = (r: Row) => eqs.every(([c, v]) => r[c] === v) && ins.every(([c, vs]) => vs.includes(r[c]));
  const run = () => {
    const rows = db[table] ?? (db[table] = []);
    if (op === "insert") {
      const list = (Array.isArray(payload) ? payload : [payload!]).map((p) => ({
        ...(table === "organisations" ? { id: `0000000${nextId++}-0000-4000-8000-000000000000`.slice(-36) } : {}),
        created_at: String(Date.now()), ...p,
      }));
      rows.push(...list);
      inserted = list;
      return { data: list, error: null };
    }
    if (op === "update") { for (const r of rows.filter(match)) Object.assign(r, payload); return { data: null, error: null }; }
    if (op === "delete") { db[table] = rows.filter((r) => !match(r)); return { data: null, error: null }; }
    return { data: (inserted.length ? inserted : rows).filter(inserted.length ? () => true : match), error: null };
  };
  const b: any = {
    select: () => b,
    eq: (c: string, v: unknown) => { eqs.push([c, v]); return b; },
    in: (c: string, v: unknown[]) => { ins.push([c, v]); return b; },
    order: () => b, limit: () => b,
    insert: (p: Row | Row[]) => { op = "insert"; payload = p; run(); return b; },
    upsert: (p: Row | Row[]) => { op = "insert"; payload = p; run(); return b; },
    update: (p: Row) => { op = "update"; payload = p; return b; },
    delete: () => { op = "delete"; return b; },
    maybeSingle: () => Promise.resolve({ data: (op === "select" ? run().data : inserted)[0] ?? null, error: null }),
    single: () => Promise.resolve({ data: (op === "select" ? run().data : inserted)[0] ?? null, error: null }),
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) => {
      try { return Promise.resolve(op === "insert" ? { data: inserted, error: null } : run()).then(resolve, reject); }
      catch (e) { return reject ? reject(e) : Promise.reject(e); }
    },
  };
  return b;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (t: string) => builder(t),
    rpc: async () => ({ data: null, error: { message: "rpc must not be called in the D-84 model" } }),
    auth: {
      getUser: async (token: string) => token
        ? { data: { user: { id: token, email: users.find((u) => u.id === token)?.email ?? "x@example.com" } }, error: null }
        : { data: { user: null }, error: new Error("no token") },
      admin: {
        listUsers: async () => ({ data: { users }, error: null }),
        createUser: async (a: { email: string; password: string; email_confirm?: boolean }) => {
          const id = `7777777${nextId++}-0000-4000-8000-000000000007`.slice(-36);
          users.push({ id, email: a.email });
          created.push(a);
          return { data: { user: { id, email: a.email } }, error: null };
        },
        deleteUser: async (id: string) => { users = users.filter((u) => u.id !== id); return { data: null, error: null }; },
      },
    },
  }),
}));

// An allowed run passes every gate and then reaches this stub: no browser, no model call.
vi.mock("../src/orchestrator.js", async (orig) => ({
  ...(await orig<typeof import("../src/orchestrator.js")>()),
  runPipeline: vi.fn(async () => ({ passed: true })),
}));

const { app } = await import("../src/server/index.js");
const { invalidateMemberships } = await import("../src/server/authz.js");
const { invalidatePlatformAdmins } = await import("../src/server/platformAdmin.js");
const request = (await import("supertest")).default;

const ORIGINAL_ENV = { ...process.env };
beforeEach(() => {
  reset();
  process.env.AUTH_ENABLED = "true";
  process.env.DB_ENABLED = "true";
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "fake-publishable";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role";
  process.env.PLATFORM_ADMIN_ENABLED = "true";
  invalidateMemberships();
  invalidatePlatformAdmins();
});
afterAll(() => {
  for (const k of ["AUTH_ENABLED", "DB_ENABLED", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY", "PLATFORM_ADMIN_ENABLED"]) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k]; else process.env[k] = ORIGINAL_ENV[k]!;
  }
});
const as = (id: string) => ({ Authorization: `Bearer ${id}` });

describe("D-84 off: nothing changes", () => {
  it("the new routes do not exist, /api/health has no new field, the old self-serve route still works", async () => {
    process.env.PLATFORM_ADMIN_ENABLED = "false";
    expect((await request(app).get("/api/admin/organisations").set(as(ADMIN))).status).toBe(404);
    expect((await request(app).post(`/api/organisations/${ORG_A}/users`).set(as(OWNER_A)).send({})).status).toBe(404);
    expect("platformAdmins" in (await request(app).get("/api/health")).body).toBe(false);
    const me = (await request(app).get("/api/auth/me").set(as(LEGACY_ADMIN_A))).body;
    expect(me.role).toBe("admin");                   // no remapping with the model off
    expect("platformAdmin" in me).toBe(false);
  });
});

describe("D-84: the Admin level", () => {
  it("/api/health says the model is on", async () => {
    expect((await request(app).get("/api/health")).body.platformAdmins).toBe(true);
  });

  it("an admin lists every organisation with counts; anyone else is refused", async () => {
    const res = await request(app).get("/api/admin/organisations").set(as(ADMIN));
    expect(res.status).toBe(200);
    const acme = res.body.organisations.find((o: any) => o.id === ORG_A);
    expect(acme).toMatchObject({ name: "Acme", members: 4, projects: 2 });
    for (const who of [OWNER_A, TESTER_A, VIEWER_A, OWNER_B, ORPHAN]) {
      expect((await request(app).get("/api/admin/organisations").set(as(who))).status).toBe(403);
    }
  });

  it("only an admin creates an organisation, and is not added to it", async () => {
    const made = await request(app).post("/api/admin/organisations").set(as(ADMIN)).send({ name: "Initech" });
    expect(made.status).toBe(201);
    expect(made.body.name).toBe("Initech");
    expect(db.organisation_members.some((m) => m.organisation_id === made.body.id)).toBe(false);
    expect((await request(app).post("/api/admin/organisations").set(as(OWNER_A)).send({ name: "X" })).status).toBe(403);
    // the old self-serve route is closed while the model is on
    expect((await request(app).post("/api/organisations").set(as(OWNER_A)).send({ name: "Mine" })).status).toBe(403);
  });

  it("an admin acts as owner in the organisation they pick; the header is ignored for anyone else", async () => {
    const me = (await request(app).get("/api/auth/me").set(as(ADMIN)).set("x-organisation-id", ORG_B)).body;
    expect(me).toMatchObject({ organisationId: ORG_B, role: "owner", platformAdmin: true, organisationName: "Globex" });
    const notAdmin = (await request(app).get("/api/auth/me").set(as(OWNER_A)).set("x-organisation-id", ORG_B)).body;
    expect(notAdmin.organisationId).toBe(ORG_A);
    expect("platformAdmin" in notAdmin).toBe(false);
    // a made-up organisation id falls back instead of being trusted
    const fake = (await request(app).get("/api/auth/me").set(as(ADMIN)).set("x-organisation-id", "dddddddd-0000-4000-8000-00000000000d")).body;
    expect([ORG_A, ORG_B]).toContain(fake.organisationId);
  });

  it("an admin creates a user of any company role in any organisation", async () => {
    const res = await request(app).post(`/api/organisations/${ORG_B}/users`).set(as(ADMIN))
      .send({ email: "new-owner@globex.com", password: "a-good-password", role: "owner" });
    expect(res.status).toBe(201);
    expect(db.organisation_members.find((m) => m.user_id === res.body.userId)).toMatchObject({ organisation_id: ORG_B, role: "owner" });
  });

  it("an admin moves an existing account into an organisation (one organisation per person)", async () => {
    db.organisation_members.push({ organisation_id: "eeeeeeee-0000-4000-8000-00000000000e", user_id: ORPHAN, role: "owner" });
    const res = await request(app).post(`/api/admin/organisations/${ORG_A}/move-user`).set(as(ADMIN))
      .send({ email: "orphan@example.com", role: "tester" });
    expect(res.status).toBe(200);
    const mine = db.organisation_members.filter((m) => m.user_id === ORPHAN);
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ organisation_id: ORG_A, role: "tester" });
    expect((await request(app).post(`/api/admin/organisations/${ORG_A}/move-user`).set(as(OWNER_A))
      .send({ email: "orphan@example.com", role: "tester" })).status).toBe(403);
  });
});

describe("D-84: owners create users in their own organisation", () => {
  it("creates the account and its membership together, with the password passed straight to Supabase", async () => {
    const res = await request(app).post(`/api/organisations/${ORG_A}/users`).set(as(OWNER_A))
      .send({ email: "sam@acme.com", password: "s3cret-pass", role: "tester", projectId: PROJ_A2 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: "sam@acme.com", role: "tester", projectId: PROJ_A2 });
    expect(JSON.stringify(res.body)).not.toContain("s3cret-pass");
    expect(created[0]).toMatchObject({ email: "sam@acme.com", password: "s3cret-pass", email_confirm: true });
    expect(db.organisation_members.find((m) => m.user_id === res.body.userId)?.organisation_id).toBe(ORG_A);
    expect(db.project_members.some((m) => m.user_id === res.body.userId && m.project_id === PROJ_A2)).toBe(true);
  });

  it("an owner may create another owner; a legacy in-company admin counts as an owner", async () => {
    expect((await request(app).post(`/api/organisations/${ORG_A}/users`).set(as(OWNER_A))
      .send({ email: "co-owner@acme.com", password: "long-enough", role: "owner" })).status).toBe(201);
    expect((await request(app).get("/api/auth/me").set(as(LEGACY_ADMIN_A))).body.role).toBe("owner");
    expect((await request(app).post(`/api/organisations/${ORG_A}/users`).set(as(LEGACY_ADMIN_A))
      .send({ email: "by-legacy@acme.com", password: "long-enough", role: "viewer" })).status).toBe(201);
  });

  it("refuses another organisation, lower roles, the Admin role, short passwords and existing emails", async () => {
    const ok = { email: "z@acme.com", password: "long-enough", role: "viewer" };
    expect((await request(app).post(`/api/organisations/${ORG_B}/users`).set(as(OWNER_A)).send(ok)).status).toBe(403);
    expect((await request(app).post(`/api/organisations/${ORG_A}/users`).set(as(TESTER_A)).send(ok)).status).toBe(403);
    expect((await request(app).post(`/api/organisations/${ORG_A}/users`).set(as(VIEWER_A)).send(ok)).status).toBe(403);
    expect((await request(app).post(`/api/organisations/${ORG_A}/users`).set(as(OWNER_A)).send({ ...ok, role: "admin" })).status).toBe(400);
    expect((await request(app).post(`/api/organisations/${ORG_A}/users`).set(as(OWNER_A)).send({ ...ok, password: "short" })).status).toBe(400);
    expect((await request(app).post(`/api/organisations/${ORG_A}/users`).set(as(OWNER_A)).send({ ...ok, email: "owner-b@example.com" })).status).toBe(409);
    expect(created).toHaveLength(0);
  });

  it("the old member routes no longer hand out the in-company admin role", async () => {
    expect((await request(app).patch(`/api/organisations/${ORG_A}/members/${TESTER_A}`).set(as(OWNER_A)).send({ role: "admin" })).status).toBe(400);
  });
});

describe("D-84: sign-in never creates an organisation (TD-191)", () => {
  it("an account in no organisation is told so, and nothing is created", async () => {
    const before = db.organisations.length;
    const res = await request(app).post("/api/auth/bootstrap").set(as(ORPHAN));
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("no-organisation");
    expect(db.organisations.length).toBe(before);
  });

  it("a member gets their own organisation back", async () => {
    const res = await request(app).post("/api/auth/bootstrap").set(as(TESTER_A));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ organisationId: ORG_A, role: "tester", created: false });
  });
});

describe("D-84: testers start tests only in their own projects (TD-193)", () => {
  const start = (who: string, body: Record<string, unknown>) =>
    request(app).post("/api/runs").set(as(who)).send({ prompt: "check the page", ...body });

  it("a site in a project they were not given is refused", async () => {
    const res = await start(TESTER_A, { url: "https://beta.example.com" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("project-not-assigned");
  });

  it("a brand-new site is refused, and no project is created", async () => {
    const before = db.projects.length;
    const res = await start(TESTER_A, { url: "https://new-site.example.com" });
    expect(res.status).toBe(403);
    expect(db.projects.length).toBe(before);
  });

  it("naming a project they were not given is refused", async () => {
    expect((await start(TESTER_A, { url: "https://alpha.example.com", projectId: PROJ_A2 })).status).toBe(403);
  });

  it("a site in their own project starts", async () => {
    const res = await start(TESTER_A, { url: "https://alpha.example.com" });
    expect(res.status).toBe(202);
    expect(typeof res.body.runId).toBe("string");
  });

  it("an owner may still test a new site", async () => {
    const res = await start(OWNER_A, { url: "https://another-new.example.com" });
    expect(res.status).toBe(202);
  });
});
