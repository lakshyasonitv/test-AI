import { describe, it, expect, beforeEach, vi } from "vitest";

/**
 * A run files under the project that already points at the same SITE.
 *
 * THE BUG. `resolveProjectForUrl` looked up by `name` only — and `name` holds two different kinds
 * of value. It writes a normalised URL key itself; `createProject` writes whatever a human typed.
 * So creating "LMS" for https://learnvibes.vercel.app and then running against that site produced
 * a SECOND, URL-named project, because "LMS" never equals "learnvibes.vercel.app".
 *
 * Measured on the live database before this fix: **"LMS" held 85 runs, 4 suites and 15 cases while
 * "learnvibes.vercel.app" held 21 runs, 1 suite and 1 case — same `base_url`, same site.**
 * "Salesforce Website" was split from two `veterans.my.site.com/*` projects the same way. That
 * split is why a case could not be attached to the suite the user wanted: the save panel only
 * offers suites belonging to the selected project.
 *
 * NOT FIXED HERE, by decision: the existing split stays as it is. This prevents new ones.
 *
 * The fake is the one from `tests/testerRunVisibility.test.ts`, reduced to the tables this needs.
 */

const ORG = "aaaaaaaa-0000-4000-8000-00000000000a";

interface Db { projects: any[]; project_members: any[] }
let db: Db;

function reset(): void {
  db = {
    projects: [
      // Human-named, created through the UI — the shape `name` matching can never find.
      { id: "p-lms", organisation_id: ORG, name: "LMS",
        base_url: "https://learnvibes.vercel.app", created_at: "2026-08-01T00:00:00Z" },
      // A different site entirely: the negative control.
      { id: "p-other", organisation_id: ORG, name: "other.example.com",
        base_url: "https://other.example.com", created_at: "2026-08-02T00:00:00Z" },
    ],
    project_members: [],
  };
}
reset();

function makeBuilder(table: keyof Db) {
  const eqs: [string, unknown][] = [];
  let pending: { kind: "insert" | "upsert"; payload?: any } | null = null;
  let single = false;
  const match = (r: any) => eqs.every(([c, v]) => r[c] === v);

  const run = () => {
    if (pending) {
      const payloads = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const made = payloads.map((p: any) => ({ id: p.id ?? crypto.randomUUID(), ...p }));
      for (const m of made) db[table].push(m);
      return { data: single ? made[0] : made, error: null };
    }
    const found = db[table].filter(match);
    return { data: single ? found[0] ?? null : found, error: null };
  };

  const builder: any = {
    select: () => builder,
    eq: (c: string, v: unknown) => { eqs.push([c, v]); return builder; },
    in: () => builder,
    order: () => builder,
    limit: () => builder,
    insert: (p: any) => { pending = { kind: "insert", payload: p }; return builder; },
    upsert: (p: any) => { pending = { kind: "upsert", payload: p }; return builder; },
    maybeSingle: () => { single = true; return Promise.resolve(run()); },
    single: () => { single = true; return Promise.resolve(run()); },
    then: (resolve: (v: unknown) => unknown) => resolve(run()),
  };
  return builder;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({ from: (t: keyof Db) => makeBuilder(t) }),
}));

process.env.DB_ENABLED = "true";
process.env.SUPABASE_URL ||= "https://stub.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY ||= "stub-service-key";

const { resolveProjectForUrl } = await import("../src/server/projects.js");

describe("resolveProjectForUrl — matches an existing project by site", () => {
  beforeEach(reset);

  it("files under the human-named project instead of minting a URL-named twin", async () => {
    const id = await resolveProjectForUrl(ORG, "https://learnvibes.vercel.app/dashboard");
    expect(id).toBe("p-lms");
    // The point: no second project was created.
    expect(db.projects).toHaveLength(2);
  });

  it("ignores www. and the path, since those are what fragmented projects in the first place", async () => {
    for (const url of [
      "https://www.learnvibes.vercel.app",
      "http://learnvibes.vercel.app/login",
      "https://learnvibes.vercel.app/s/how-it-works",
    ]) {
      reset();
      expect(await resolveProjectForUrl(ORG, url), url).toBe("p-lms");
      expect(db.projects, url).toHaveLength(2);
    }
  });

  it("still creates a project for a genuinely new site", async () => {
    const id = await resolveProjectForUrl(ORG, "https://brand-new.example.com");
    expect(id).toBeTruthy();
    expect(id).not.toBe("p-lms");
    expect(db.projects).toHaveLength(3);
    expect(db.projects.at(-1).name).toBe("brand-new.example.com");
  });

  it("prefers an exact name match over the site match, so existing behaviour is unchanged", async () => {
    // A URL-named project for the same site, created later. A run against its exact key must still
    // land on it — the name lookup runs first and is untouched by this change.
    db.projects.push({ id: "p-url", organisation_id: ORG, name: "learnvibes.vercel.app",
      base_url: "https://learnvibes.vercel.app", created_at: "2026-09-01T00:00:00Z" });
    expect(await resolveProjectForUrl(ORG, "https://learnvibes.vercel.app")).toBe("p-url");
  });

  it("picks deterministically when several projects share the site", async () => {
    // Possible today precisely because the split already happened. Oldest by created_at wins, and
    // an exact base_url match beats a host-only one — never "most recent", which would make the
    // same URL resolve differently over time, and a run's project decides who can see it.
    db.projects.push({ id: "p-newer", organisation_id: ORG, name: "learnvibes.vercel.app",
      base_url: "https://learnvibes.vercel.app", created_at: "2026-09-01T00:00:00Z" });
    const id = await resolveProjectForUrl(ORG, "https://learnvibes.vercel.app/deep/page");
    expect(["p-lms", "p-newer"]).toContain(id);
    // Same answer every time, whatever it is.
    expect(await resolveProjectForUrl(ORG, "https://learnvibes.vercel.app/deep/page")).toBe(id);
  });

  it("does not match a different site", async () => {
    const id = await resolveProjectForUrl(ORG, "https://learnvibes.vercel.app.evil.com");
    expect(id).not.toBe("p-lms");
    expect(id).not.toBe("p-other");
  });

  it("returns null for a URL it cannot key", async () => {
    expect(await resolveProjectForUrl(ORG, null)).toBeNull();
    expect(await resolveProjectForUrl(ORG, "")).toBeNull();
  });
});
