import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import request from "supertest";
import { chromium, type Browser } from "playwright";

/**
 * Salesforce org connections over OAuth + frontdoor sign-in (D-63, SALESFORCE_OAUTH_ENABLED).
 *
 * Three groups, as agreed for Stage 1:
 *  1. start / callback / guard / tenancy — the OAuth module and its two routes;
 *  2. token secrecy — the frontdoor URL, refresh, and every scrubber it must pass through;
 *  3. pipeline shape — the login prefix, the page trail redirect, the generated spec, and the
 *     grounding replay, the last two EXECUTED in real Chromium against a local stand-in for
 *     frontdoor.jsp (CLAUDE.md: a generated Playwright expression is not verified until it runs).
 *
 * Every value here is a made-up canary (fixtures rule): no real client id, secret, token or org.
 * `runPipeline` is mocked so a run request can be observed reaching the pipeline without a browser.
 */

const { runPipelineMock } = vi.hoisted(() => ({
  runPipelineMock: vi.fn(async () => ({ runId: "x", runDir: "x", result: null, diagnosis: null })),
}));
vi.mock("../src/orchestrator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/orchestrator.js")>()),
  runPipeline: runPipelineMock,
}));

const oauth = await import("../src/server/salesforceOAuth.js");
const { app } = await import("../src/server/index.js");
const fd = await import("../src/stages/salesforceFrontdoor.js");
const {
  buildLoginPrefix, needsLoginPrefix, irAlreadyLogsIn, redirectPostLoginNavigate, groundingError,
  missingActions, withoutCredentialEntry,
} = await import("../src/stages/ir.js");
const { generateSpec } = await import("../src/stages/generator.js");
const { runStepLive, walkCacheKey } = await import("../src/stages/liveExtend.js");
const { scrubServedSecrets, detectBlocked } = await import("../src/stages/executor.js");
const { scrubRunSecrets } = await import("../src/runSecrets.js");
const { withRunId } = await import("../src/runContext.js");

const CFG = {
  clientId: "zqcanary-client-id",
  clientSecret: "zqcanary-client-secret",
  callbackUrl: "http://localhost:3001/api/salesforce/callback",
};
const ORG_URL = "https://zqcanary-dev-ed.scratch.my.salesforce.com";
const INSTANCE = "https://zqcanary-dev-ed.scratch.my.salesforce.com";
const TOKEN = "zqcanaryaccesstoken0123456789abcdef";
const REFRESH = "zqcanaryrefreshtoken0123456789abcdef";

const okFetch = (json: object) => vi.fn(async (_url: string, _init?: any) => ({ ok: true, status: 200, json: async () => json }));

/** A completed connection for `orgId`, through the real start + callback functions. */
async function connect(orgId: string | null, instanceUrl = INSTANCE) {
  const started = oauth.startAuthorization({ orgUrl: ORG_URL, orgId, userId: "zq-user" }, CFG);
  if ("error" in started) throw new Error(started.error);
  const state = new URL(started.authorizeUrl).searchParams.get("state")!;
  const fetchImpl = okFetch({ access_token: TOKEN, refresh_token: REFRESH, instance_url: instanceUrl });
  const done = await oauth.completeAuthorization("zqcanary-code", state, CFG, fetchImpl);
  return { done, fetchImpl, state };
}

const ENV_KEYS = [
  "SALESFORCE_ENABLED", "SALESFORCE_OAUTH_ENABLED", "SALESFORCE_OAUTH_CLIENT_ID",
  "SALESFORCE_OAUTH_CLIENT_SECRET", "SALESFORCE_OAUTH_CALLBACK_URL", "AUTH_ENABLED", "DB_ENABLED",
  "SALESFORCE_PRODUCTION_ORGS_ENABLED",
] as const;
let savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  oauth.resetSalesforceOAuthForTests();
  runPipelineMock.mockClear();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const flagsOn = () => {
  process.env.SALESFORCE_ENABLED = "true";
  process.env.SALESFORCE_OAUTH_ENABLED = "true";
  process.env.SALESFORCE_OAUTH_CLIENT_ID = CFG.clientId;
  process.env.SALESFORCE_OAUTH_CLIENT_SECRET = CFG.clientSecret;
  process.env.SALESFORCE_OAUTH_CALLBACK_URL = CFG.callbackUrl;
};

// ------------------------------------------------------------------------------------------------
describe("0. replay through an org connection (Session 102, TD-166)", () => {
  const FD = "${env:SF_FRONTDOOR_URL}";
  const sfCase = (baseUrl = INSTANCE) => ({ ir: { meta: { baseUrl }, steps: [
    { id: "auth-0", action: "navigate", target: { url: FD } },
    { id: "s1", action: "navigate", target: { url: "/lightning/o/Lead/new" } },
  ] } });
  const plainCase = { ir: { meta: { baseUrl: "https://zq.example" }, steps: [{ id: "s1", action: "navigate", target: { url: "/" } }] } };

  it("a saved case that signs in through a connection needs one, and the caller's own", async () => {
    expect(oauth.replaySessionFor([plainCase] as any, undefined, "org-a")).toEqual({ session: null });
    const none = oauth.replaySessionFor([sfCase()] as any, undefined, "org-a");
    expect("error" in none && none.code).toBe("sf-connection-required");
    const own = await connect("org-a");
    const foreign = oauth.replaySessionFor([sfCase()] as any, own.done.connectionId, "org-b");
    expect("error" in foreign && foreign.code).toBe("sf-connection-expired");
    const ok = oauth.replaySessionFor([sfCase()] as any, own.done.connectionId, "org-a");
    expect("session" in ok && ok.session?.instanceHost).toBe(new URL(INSTANCE).hostname);
  });

  it("refuses a case saved from another org, so one org's session never opens another's pages", async () => {
    const own = await connect("org-a");
    const other = oauth.replaySessionFor([sfCase("https://zq-other-dev-ed.develop.lightning.force.com")] as any, own.done.connectionId, "org-a");
    expect("error" in other && other.error).toMatch(/not an address of the connected org/);
  });
});

// 2026-10-25: the migration was run, yet the API answered PGRST205 (no such table), so every restart
// still needed Connect org. The same sealed row then goes to a local file, and a restart restores it.
describe("0c-file. no table the API can see: the connection survives a restart through the local file", () => {
  const custody = { dataKey: () => Buffer.alloc(32, 7), describe: () => "zq-test-custody" };
  const missingTable: any = { from: () => ({
    upsert: async () => ({ error: { message: "Could not find the table 'public.salesforce_connections' in the schema cache" } }),
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "PGRST205" } }) }) }),
    delete: () => ({ eq: async () => ({ error: null }) }),
  }) };

  for (const [name, client] of [["no database", null], ["a database without the table", missingTable]] as const) {
    it(`${name}: stores the sealed row in the file and restores from it`, async () => {
      const dir = mkdtempSync(path.join(tmpdir(), "zq-conn-"));
      const file = path.join(dir, "nested", "connections.json");
      try {
        const started = oauth.startAuthorization({ orgUrl: ORG_URL, orgId: "org-a", userId: "zq-user" }, CFG);
        const state = new URL((started as { authorizeUrl: string }).authorizeUrl).searchParams.get("state")!;
        const done = await oauth.completeAuthorization("zqcanary-code", state, CFG,
          okFetch({ access_token: TOKEN, refresh_token: REFRESH, instance_url: INSTANCE }), { client, custody, file });
        const stored = readFileSync(file, "utf8");
        expect(stored).toContain(done.connectionId);
        expect(stored).not.toContain(REFRESH);
        expect(stored).not.toContain(TOKEN);

        oauth.resetSalesforceOAuthForTests();
        const refreshed = okFetch({ access_token: "zqcanary-newtoken-0123456789", instance_url: INSTANCE });
        expect(await oauth.restoreConnection(done.connectionId, "org-b", { client, custody, cfg: CFG, fetchImpl: refreshed, file })).toBeNull();
        expect((await oauth.restoreConnection(done.connectionId, "org-a", { client, custody, cfg: CFG, fetchImpl: refreshed, file }))?.instanceUrl).toBe(INSTANCE);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
  }

  it("off by default: no file, memory only, as before", async () => {
    const prev = process.env.SALESFORCE_CONNECTIONS_FILE;
    delete process.env.SALESFORCE_CONNECTIONS_FILE;
    try {
      const started = oauth.startAuthorization({ orgUrl: ORG_URL, orgId: "org-a", userId: "zq-user" }, CFG);
      const state = new URL((started as { authorizeUrl: string }).authorizeUrl).searchParams.get("state")!;
      const done = await oauth.completeAuthorization("zqcanary-code", state, CFG,
        okFetch({ access_token: TOKEN, refresh_token: REFRESH, instance_url: INSTANCE }), { client: null, custody });
      oauth.resetSalesforceOAuthForTests();
      expect(await oauth.restoreConnection(done.connectionId, "org-a", { client: null, custody, cfg: CFG })).toBeNull();
    } finally { if (prev !== undefined) process.env.SALESFORCE_CONNECTIONS_FILE = prev; }
  });
});

describe("0c. a connection survives a restart: stored encrypted, restored with a fresh token (Session 102, TD-166)", () => {
  // A fake table and a fake key custody: what is stored, and that nothing readable is stored.
  const rows = new Map<string, any>();
  const client: any = { from: (_t: string) => ({
    upsert: async (row: any) => { rows.set(row.id, row); return { error: null }; },
    select: () => ({ eq: (_k: string, id: string) => ({ maybeSingle: async () => ({ data: rows.get(id) ?? null, error: null }) }) }),
    delete: () => ({ eq: async (_k: string, id: string) => { rows.delete(id); return { error: null }; } }),
  }) };
  const custody = { dataKey: () => Buffer.alloc(32, 7), describe: () => "zq-test-custody" };

  it("stores only a sealed refresh token, and restores the connection for its own organisation", async () => {
    rows.clear();
    const started = oauth.startAuthorization({ orgUrl: ORG_URL, orgId: "org-a", userId: "zq-user" }, CFG);
    const state = new URL((started as { authorizeUrl: string }).authorizeUrl).searchParams.get("state")!;
    const done = await oauth.completeAuthorization("zqcanary-code", state, CFG,
      okFetch({ access_token: TOKEN, refresh_token: REFRESH, instance_url: INSTANCE }), { client, custody });
    const row = rows.get(done.connectionId);
    expect(row.organisation_id).toBe("org-a");
    expect(JSON.stringify(row)).not.toContain(REFRESH);
    expect(JSON.stringify(row)).not.toContain(TOKEN);

    oauth.resetSalesforceOAuthForTests();   // the "restart": memory is gone
    expect(oauth.connectionFor(done.connectionId, "org-a")).toBeNull();
    const refreshed = okFetch({ access_token: "zqcanary-newtoken-0123456789", instance_url: INSTANCE });
    expect(await oauth.restoreConnection(done.connectionId, "org-b", { client, custody, cfg: CFG, fetchImpl: refreshed })).toBeNull();
    const back = await oauth.restoreConnection(done.connectionId, "org-a", { client, custody, cfg: CFG, fetchImpl: refreshed });
    expect(back?.instanceUrl).toBe(INSTANCE);
    // Minted a fresh access token through the refresh grant; the stored one was never the token.
    const body = String(refreshed.mock.calls[0][1]?.body ?? "");
    expect(body).toContain("grant_type=refresh_token");
    expect(oauth.connectionFor(done.connectionId, "org-a")).not.toBeNull();
  });

  it("drops a stored connection whose refresh token no longer works", async () => {
    rows.clear();
    const started = oauth.startAuthorization({ orgUrl: ORG_URL, orgId: "org-a", userId: "zq-user" }, CFG);
    const state = new URL((started as { authorizeUrl: string }).authorizeUrl).searchParams.get("state")!;
    const done = await oauth.completeAuthorization("zqcanary-code", state, CFG,
      okFetch({ access_token: TOKEN, refresh_token: REFRESH, instance_url: INSTANCE }), { client, custody });
    oauth.resetSalesforceOAuthForTests();
    const refused = vi.fn(async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) }));
    expect(await oauth.restoreConnection(done.connectionId, "org-a", { client, custody, cfg: CFG, fetchImpl: refused as any })).toBeNull();
    expect(rows.has(done.connectionId)).toBe(false);
  });
});

describe("0d. restore keeps the row on a temporary failure, and keeps a rotated refresh token (code review)", () => {
  const rows = new Map<string, any>();
  const client: any = { from: (_t: string) => ({
    upsert: async (row: any) => { rows.set(row.id, row); return { error: null }; },
    select: () => ({ eq: (_k: string, id: string) => ({ maybeSingle: async () => ({ data: rows.get(id) ?? null, error: null }) }) }),
    delete: () => ({ eq: async (_k: string, id: string) => { rows.delete(id); return { error: null }; } }),
  }) };
  const custody = { dataKey: () => Buffer.alloc(32, 7), describe: () => "zq-test-custody" };
  const stored = async () => {
    rows.clear();
    const started = oauth.startAuthorization({ orgUrl: ORG_URL, orgId: "org-a", userId: "zq-user" }, CFG);
    const state = new URL((started as { authorizeUrl: string }).authorizeUrl).searchParams.get("state")!;
    const done = await oauth.completeAuthorization("zqcanary-code", state, CFG,
      okFetch({ access_token: TOKEN, refresh_token: REFRESH, instance_url: INSTANCE }), { client, custody });
    oauth.resetSalesforceOAuthForTests();
    return done.connectionId;
  };

  it("a network error or a 5xx returns null but keeps the stored row", async () => {
    const id = await stored();
    const down = vi.fn(async () => { throw new Error("ECONNRESET"); });
    expect(await oauth.restoreConnection(id, "org-a", { client, custody, cfg: CFG, fetchImpl: down as any })).toBeNull();
    const fivexx = vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }));
    expect(await oauth.restoreConnection(id, "org-a", { client, custody, cfg: CFG, fetchImpl: fivexx as any })).toBeNull();
    expect(rows.has(id)).toBe(true);
  });

  it("no OAuth config at restore: null, row kept, never a connection with an empty token", async () => {
    const id = await stored();
    expect(await oauth.restoreConnection(id, "org-a", { client, custody, cfg: null })).toBeNull();
    expect(rows.has(id)).toBe(true);
  });

  it("stores a rotated refresh token", async () => {
    const id = await stored();
    const rotated = okFetch({ access_token: "zqcanary-newtoken-0123456789", refresh_token: "zqcanary-rotated-refresh-0123", instance_url: INSTANCE });
    expect(await oauth.restoreConnection(id, "org-a", { client, custody, cfg: CFG, fetchImpl: rotated })).not.toBeNull();
    oauth.resetSalesforceOAuthForTests();
    const next = okFetch({ access_token: "zqcanary-third-0123456789", instance_url: INSTANCE });
    await oauth.restoreConnection(id, "org-a", { client, custody, cfg: CFG, fetchImpl: next });
    expect(String(next.mock.calls[0][1]?.body)).toContain("zqcanary-rotated-refresh-0123");
  });

  it("an off-org case is its own code, so the page does not throw away a good connection", async () => {
    const own = await connect("org-a");
    const other = oauth.replaySessionFor([{ ir: { meta: { baseUrl: "https://zq-other-dev-ed.develop.lightning.force.com" },
      steps: [{ action: "navigate", target: { url: "${env:SF_FRONTDOOR_URL}" } }] } }] as any, own.done.connectionId, "org-a");
    expect("code" in other && other.code).toBe("sf-connection-wrong-org");
  });
});

describe("0e. an org's Setup URL connects like its My Domain (Session 102)", () => {
  // The user pasted https://<org>.scratch.my.salesforce-setup.com/ — Setup's own domain.
  it("maps <org>.my.salesforce-setup.com to the org's My Domain, and a run on it belongs to that org", async () => {
    expect(oauth.loginOriginFor("https://zqcanary-dev-ed.scratch.my.salesforce-setup.com/"))
      .toEqual({ origin: ORG_URL, kind: "scratch" });
    expect(oauth.sameTestOrg("zqcanary-dev-ed.scratch.my.salesforce-setup.com", "zqcanary-dev-ed.scratch.my.salesforce.com")).toBe(true);
    const own = await connect("org-a");
    const conn = oauth.connectionFor(own.done.connectionId, "org-a")!;
    expect(oauth.connectionMatchesUrl(conn, "https://zqcanary-dev-ed.scratch.my.salesforce-setup.com/lightning/setup/SetupOneHome/home")).toBe(true);
    // Never a look-alike: the suffix must be Salesforce's own.
    expect("error" in oauth.loginOriginFor("https://zqcanary.scratch.my.salesforce-setup.com.evil.example")).toBe(true);
  });
});

describe("0b. production orgs connect only when the server opts in (Session 102)", () => {
  it("refused by default, accepted as kind production with the flag", () => {
    const r = oauth.loginOriginFor("https://zqcanary.my.salesforce.com");
    expect("error" in r && r.error).toMatch(/SALESFORCE_PRODUCTION_ORGS_ENABLED/);
    process.env.SALESFORCE_PRODUCTION_ORGS_ENABLED = "true";
    expect(oauth.loginOriginFor("https://zqcanary.lightning.force.com/lightning/page/home"))
      .toEqual({ origin: "https://zqcanary.my.salesforce.com", kind: "production" });
    // Still never a login host, and two production orgs are still two orgs.
    expect("error" in oauth.loginOriginFor("https://login.salesforce.com")).toBe(true);
    expect(oauth.sameTestOrg("zqcanary.my.salesforce.com", "zqother.my.salesforce.com")).toBe(false);
    expect(oauth.sameTestOrg("zqcanary.my.salesforce.com", "zqcanary.lightning.force.com")).toBe(true);
  });
});

describe("1. start, callback, org guard and tenancy", () => {
  it("builds a PKCE web-server authorise URL on the org's own My Domain", () => {
    const started = oauth.startAuthorization({ orgUrl: ORG_URL, orgId: "org-a", userId: "u" }, CFG);
    expect("authorizeUrl" in started).toBe(true);
    const u = new URL((started as { authorizeUrl: string }).authorizeUrl);
    expect(u.origin).toBe(ORG_URL);
    expect(u.pathname).toBe("/services/oauth2/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe(CFG.clientId);
    expect(u.searchParams.get("redirect_uri")).toBe(CFG.callbackUrl);
    expect(u.searchParams.get("scope")).toBe("api web refresh_token");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("state")!.length).toBeGreaterThanOrEqual(32);
    // Never the secret in a URL the browser sees.
    expect(u.href).not.toContain(CFG.clientSecret);
  });

  it("accepts scratch orgs and sandboxes (any host of them), refuses everything else with a reason", () => {
    expect(oauth.loginOriginFor("zqcanary-dev-ed.scratch.lightning.force.com/lightning/page/home"))
      .toEqual({ origin: ORG_URL, kind: "scratch" });
    expect(oauth.loginOriginFor("https://zq--uat.sandbox.my.salesforce.com/")).toEqual({
      origin: "https://zq--uat.sandbox.my.salesforce.com", kind: "sandbox",
    });
    // Developer Edition (`.develop.`) is a free standalone test org, accepted since 2026-10-24.
    expect(oauth.loginOriginFor("https://zqcanary-dev-ed.develop.lightning.force.com/lightning/page/home")).toEqual({
      origin: "https://zqcanary-dev-ed.develop.my.salesforce.com", kind: "developer",
    });
    for (const [url, why] of [
      ["https://zqcanary.my.salesforce.com", /not a scratch org, a sandbox or a Developer Edition org/],
      ["https://login.salesforce.com", /not an org's own address/],
      ["https://test.salesforce.com", /not an org's own address/],
      ["https://zqcanary.scratch.my.salesforce.com.evil.example", /not a Salesforce address/],
    ] as const) {
      const r = oauth.loginOriginFor(url);
      expect("error" in r, url).toBe(true);
      expect((r as { error: string }).error).toMatch(why);
    }
    expect(oauth.startAuthorization({ orgUrl: ORG_URL, orgId: null, userId: null }, null))
      .toEqual({ error: expect.stringMatching(/not configured/) });
  });

  it("trades the code once, with the verifier, and keeps the connection for its own organisation only", async () => {
    const { done, fetchImpl, state } = await connect("org-a");
    expect(done).toMatchObject({ host: "zqcanary-dev-ed.scratch.my.salesforce.com", kind: "scratch", orgId: "org-a" });
    const [tokenUrl, init] = fetchImpl.mock.calls[0];
    expect(tokenUrl).toBe(`${ORG_URL}/services/oauth2/token`);
    const body = new URLSearchParams(init.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.get("redirect_uri")).toBe(CFG.callbackUrl);

    // One use per state.
    await expect(oauth.completeAuthorization("zqcanary-code", state, CFG, fetchImpl)).rejects.toThrow(/expired or was already used/);
    // Tenancy: another organisation cannot see it; unknown ids are null.
    expect(oauth.connectionFor(done.connectionId, "org-a")).not.toBeNull();
    expect(oauth.connectionFor(done.connectionId, "org-b")).toBeNull();
    expect(oauth.connectionFor("zq-unknown", "org-a")).toBeNull();
    // The run URL must be a host of the same org.
    const c = oauth.connectionFor(done.connectionId, "org-a")!;
    expect(oauth.connectionMatchesUrl(c, "https://zqcanary-dev-ed.scratch.lightning.force.com/lightning/page/home")).toBe(true);
    expect(oauth.connectionMatchesUrl(c, "https://zqother-dev-ed.scratch.my.salesforce.com/")).toBe(false);
  });

  it("refuses an instance_url that is not the org that was asked for, and keeps nothing", async () => {
    await expect(connect("org-a", "https://zqother-dev-ed.scratch.my.salesforce.com")).rejects.toThrow(/not the test org that was asked for/);
    await expect(connect("org-a", "https://zqcanary-dev-ed.my.salesforce.com")).rejects.toThrow(/not the test org that was asked for/);
    // Same My Domain name, different partition: a Developer Edition instance for a scratch-org sign-in.
    await expect(connect("org-a", "https://zqcanary-dev-ed.develop.my.salesforce.com")).rejects.toThrow(/not the test org that was asked for/);
  });
});

// ------------------------------------------------------------------------------------------------
describe("2. token secrecy: frontdoor URL, refresh, scrubbers", () => {
  it("mints a frontdoor URL from instance_url and registers it as the run's secret", async () => {
    const { done } = await connect("org-a");
    const session = oauth.frontdoorSessionFor(oauth.connectionFor(done.connectionId, "org-a")!, { cfg: CFG, fetchImpl: okFetch({}) });
    expect(session.instanceHost).toBe("zqcanary-dev-ed.scratch.my.salesforce.com");
    expect(JSON.stringify(session)).not.toContain(TOKEN); // the rail value itself holds no token

    const url = await withRunId("zq-run-1", () => session.mint());
    expect(url).toBe(`${INSTANCE}/secur/frontdoor.jsp?sid=${TOKEN}&retURL=%2Flightning%2Fpage%2Fhome`);
    const scrubbed = scrubRunSecrets("zq-run-1", { message: `page.goto failed at ${url}`, nested: [{ t: TOKEN }] });
    expect(JSON.stringify(scrubbed)).not.toContain(TOKEN);
    expect(JSON.stringify(scrubbed)).toContain("[redacted]");
    // Another run's events are not touched by this run's secrets.
    expect(scrubRunSecrets("zq-run-2", { t: "plain" })).toEqual({ t: "plain" });
  });

  it("refreshes an old access token before minting", async () => {
    const { done } = await connect("org-a");
    const c = oauth.connectionFor(done.connectionId, "org-a")!;
    (c as any).tokenAt = Date.now() - 2 * 60 * 60 * 1000;
    const refreshFetch = okFetch({ access_token: "zqcanaryrefreshedtoken0123456789", instance_url: INSTANCE });
    const url = await oauth.frontdoorSessionFor(c, { cfg: CFG, fetchImpl: refreshFetch }).mint();
    expect(new URLSearchParams(refreshFetch.mock.calls[0][1].body).get("grant_type")).toBe("refresh_token");
    expect(url).toContain("sid=zqcanaryrefreshedtoken0123456789");
    expect(url).not.toContain(TOKEN);
  });

  it("scrubs the frontdoor URL from results.json and the served text artifacts", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zq-sfoauth-"));
    try {
      const url = `${INSTANCE}/secur/frontdoor.jsp?sid=${TOKEN}&retURL=%2Flightning%2Fpage%2Fhome`;
      const resultsJson = path.join(dir, "results.json");
      const finalPage = path.join(dir, "final-page.txt");
      writeFileSync(finalPage, `navigated to ${url}`, "utf8");
      const raw = { error: { message: `page.goto: net::ERR_ABORTED at ${url}` } };
      const out = scrubServedSecrets(raw, dir, resultsJson, [], { [fd.FRONTDOOR_ENV]: url });
      expect(JSON.stringify(out)).not.toContain(TOKEN);
      expect(readFileSync(resultsJson, "utf8")).not.toContain(TOKEN);
      expect(readFileSync(finalPage, "utf8")).not.toContain(TOKEN);
      // A retained trace.zip (a failing case) cannot be scrubbed, so a frontdoor run removes it.
      const traceDir = path.join(dir, "case-x");
      mkdirSync(traceDir, { recursive: true });
      writeFileSync(path.join(traceDir, "trace.zip"), "zq-fake-zip", "utf8");
      scrubServedSecrets(raw, dir, resultsJson, [], { [fd.FRONTDOOR_ENV]: url });
      expect(existsSync(path.join(traceDir, "trace.zip"))).toBe(false);
      // Without a frontdoor URL, nothing is removed (an ordinary run keeps its trace).
      writeFileSync(path.join(traceDir, "trace.zip"), "zq-fake-zip", "utf8");
      scrubServedSecrets(raw, dir, resultsJson, [], {});
      expect(existsSync(path.join(traceDir, "trace.zip"))).toBe(true);
      // A sid= value printed in a different form (e.g. a different URL) is still taken out.
      expect(fd.withoutFrontdoorSecret(`at https://x/secur/frontdoor.jsp?sid=${TOKEN}`)).not.toContain(TOKEN);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------------------------------------
describe("routes, flag off and on", () => {
  it("flag off: both routes answer 403 and sfConnectionId is ignored on a run", async () => {
    process.env.SALESFORCE_ENABLED = "true";
    const start = await request(app).post("/api/salesforce/oauth/start").send({ url: ORG_URL });
    expect(start.status).toBe(403);
    const cb = await request(app).get("/api/salesforce/callback?code=zq&state=zq");
    expect(cb.status).toBe(403);
    const run = await request(app).post("/api/runs").send({
      prompt: "Open the app", url: ORG_URL, options: { targetApp: "salesforce", sfConnectionId: "zq-any" },
    });
    expect(run.status).toBe(202);
    expect((runPipelineMock.mock.calls[0] as any[])[0].options.sfFrontdoor).toBeUndefined();
  });

  it("flag on: start refuses a production org, accepts a scratch org; the callback never echoes a token", async () => {
    flagsOn();
    const bad = await request(app).post("/api/salesforce/oauth/start").send({ url: "https://zqcanary.my.salesforce.com" });
    expect(bad.status).toBe(400);
    const good = await request(app).post("/api/salesforce/oauth/start").send({ url: ORG_URL });
    expect(good.status).toBe(200);
    expect(new URL(good.body.authorizeUrl).origin).toBe(ORG_URL);

    const cb = await request(app).get("/api/salesforce/callback?code=zq&state=zq-not-a-real-state");
    expect(cb.status).toBe(200);
    expect(cb.text).toContain("was not connected");
    expect(cb.text).toContain(JSON.stringify("http://localhost:3001")); // postMessage target: our origin only
    expect(cb.text).not.toContain('"*"');
  });

  it("flag on: a run uses the caller's own connection, and refuses a foreign one or another org's URL", async () => {
    flagsOn();
    // Started through the route, so it belongs to the caller's (synthetic, auth-off) organisation.
    const started = await request(app).post("/api/salesforce/oauth/start").send({ url: ORG_URL });
    const state = new URL(started.body.authorizeUrl).searchParams.get("state")!;
    const own = await oauth.completeAuthorization("zq-code", state, CFG,
      okFetch({ access_token: TOKEN, refresh_token: REFRESH, instance_url: INSTANCE }));

    const ok = await request(app).post("/api/runs").send({
      prompt: "Open the app and verify the Seller Home page is visible", url: `${ORG_URL}/`,
      options: { targetApp: "salesforce", sfConnectionId: own.connectionId },
    });
    expect(ok.status).toBe(202);
    const opts = (runPipelineMock.mock.calls[0] as any[])[0].options;
    expect(opts.sfFrontdoor.instanceHost).toBe("zqcanary-dev-ed.scratch.my.salesforce.com");
    expect(JSON.stringify(opts)).not.toContain(TOKEN);

    const foreign = await connect("zq-other-organisation");
    const refused = await request(app).post("/api/runs").send({
      prompt: "Open the app", url: ORG_URL, options: { targetApp: "salesforce", sfConnectionId: foreign.done.connectionId },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.error).toMatch(/unknown or has expired/);
    // TD-166: the page reads this code to stop showing "Connected" after a server restart.
    expect(refused.body.code).toBe("sf-connection-expired");

    const otherOrgUrl = await request(app).post("/api/runs").send({
      prompt: "Open the app", url: "https://zqother-dev-ed.scratch.my.salesforce.com/",
      options: { targetApp: "salesforce", sfConnectionId: own.connectionId },
    });
    expect(otherOrgUrl.status).toBe(400);
    expect(otherOrgUrl.body.error).toMatch(/not an address of the connected org/);
    expect(runPipelineMock).toHaveBeenCalledTimes(1);
  });
});

// ------------------------------------------------------------------------------------------------
describe("3. pipeline shape", () => {
  const LANDING = "https://zqcanary-dev-ed.scratch.lightning.force.com/lightning/page/home";
  const auth = { status: "authenticated" as const, frontdoor: true, url: LANDING };

  it("the login prefix is one env-referenced navigate, and every case gets it", () => {
    expect(buildLoginPrefix(auth)).toEqual([{ id: "auth-0", action: "navigate", target: { url: fd.FRONTDOOR_REF } }]);
    expect(needsLoginPrefix({ targetUrl: ORG_URL } as any, auth)).toBe(true);
    expect(needsLoginPrefix({} as any, auth)).toBe(true);
    // A password fill the model wrote is not "already logged in" on a frontdoor run.
    const ir = { steps: [{ id: "s1", action: "fill", target: { role: "textbox", name: "Password" }, value: "x" }] };
    expect(irAlreadyLogsIn(ir as any, auth, { baseUrl: ORG_URL, pages: [] } as any)).toBe(false);
  });

  it("'open the app' written as navigate / goes to where frontdoor landed; other paths are untouched", () => {
    const steps: any[] = [...buildLoginPrefix(auth), { id: "s1", action: "navigate", target: { url: "/" } }];
    expect(redirectPostLoginNavigate(steps, 1, auth, ORG_URL)).toBe("s1");
    expect(steps[1].target.url).toBe(LANDING);
    const other: any[] = [...buildLoginPrefix(auth), { id: "s1", action: "navigate", target: { url: "/lightning/o/Lead/list" } }];
    expect(redirectPostLoginNavigate(other, 1, auth, ORG_URL)).toBeUndefined();
    expect(other[1].target.url).toBe("/lightning/o/Lead/list");
  });

  it("grounding accepts the frontdoor navigate and grounds the next step on the landing page", () => {
    const model = {
      baseUrl: ORG_URL,
      auth,
      pages: [{
        url: LANDING, title: "Home | Salesforce",
        elements: [{ role: "heading", name: "Seller Home", visible: true }],
      }],
    } as any;
    const ir = {
      meta: { feature: "Home", title: "Open the app", priority: "high", sourcePrompt: "Open the app", baseUrl: ORG_URL },
      steps: [
        ...buildLoginPrefix(auth),
        { id: "s1", action: "assert", target: { role: "heading", name: "Seller Home" }, assertion: "visible" },
      ],
    } as any;
    // The frontdoor navigate is step 0, which grounding never checks (the pipeline supplies it);
    // the heading after it grounds on the landing page through the page trail.
    expect(groundingError(ir, model)).toBeNull();
    // A made-up route after the sign-in is still refused.
    const guessed = {
      ...ir,
      steps: [ir.steps[0], { id: "s0", action: "navigate", target: { url: "/zq-invented-admin" } }, ...ir.steps.slice(1)],
    };
    expect(groundingError(guessed, model)).toMatchObject({ index: 1, kind: "navigate-url" });
  });

  it("a relative Lightning path grounds once the model's base is where frontdoor landed", () => {
    // Run 2026-10-24T11-07-55-409Z-10d29a7c: the case said "Go to /lightning/o/Lead/pipelineInspection",
    // a page discovery HAD modelled, but on the Lightning host; with the My Domain base the path
    // resolved to My Domain, grounding refused it as a guess, and the IR wandered via the App Launcher.
    const lightning = new URL(LANDING).origin;
    const page = { url: `${lightning}/lightning/o/Lead/list`, title: "Leads", elements: [{ role: "button", name: "New", visible: true }] };
    const ir = (baseUrl: string) => ({
      meta: { feature: "Lead", title: "New Lead", priority: "high", sourcePrompt: "x", baseUrl },
      steps: [...buildLoginPrefix(auth), { id: "s1", action: "navigate", target: { url: "/lightning/o/Lead/list" } },
        { id: "s2", action: "click", target: { role: "button", name: "New" } }],
    }) as any;
    expect(groundingError(ir(ORG_URL), { baseUrl: ORG_URL, auth, pages: [page] } as any)).toMatchObject({ kind: "navigate-url" });
    expect(groundingError(ir(lightning), { baseUrl: lightning, auth, pages: [page] } as any)).toBeNull();
  });

  it("on an org-connection run the guidance routes by URL, not through the App Launcher, and plans no login", async () => {
    // Run 2026-10-24T11-34-49-878Z-a7697ccd: all three cases wandered inside the App Launcher because
    // the guidance (written for password runs, where no /lightning path is in the model) said so.
    // With the create forms modelled by URL, the URL is the grounded route.
    const { salesforceGuidance, SALESFORCE_GUIDANCE } = await import("../src/stages/salesforceGuidance.js");
    const { withTargetApp } = await import("../src/runTarget.js");
    const session = { connectionId: "zq", instanceHost: "zq.scratch.my.salesforce.com", mint: async () => "" };
    for (const stage of ["plan", "cases", "ir"] as const) {
      const plain = withTargetApp("salesforce", () => salesforceGuidance(stage));
      expect(plain, stage).toBe(SALESFORCE_GUIDANCE[stage]);
      const connected = withTargetApp("salesforce", () => fd.withFrontdoor(session, () => salesforceGuidance(stage)));
      expect(connected, stage).not.toBe(plain);
      expect(connected, stage).toMatch(/\/lightning\/o\/<Object>\/new/);
      expect(connected, stage).not.toMatch(/Open the App Launcher/);
      expect(connected, stage).toMatch(/already signed in/i);
      expect(connected, `${stage} names a URL`).not.toMatch(/https?:\/\//i);
    }
    // Run 2026-10-24T14-09-38-782Z-a7582b51 (an Account create prompt) also wrote a global-search case
    // through the App Launcher, which failed and had nothing to do with the request.
    const cases = withTargetApp("salesforce", () => fd.withFrontdoor(session, () => salesforceGuidance("cases")));
    expect(cases).toMatch(/stay on the object/i);
    // Session 102j (user): fill required + rule-read fields only, others only when the request names
    // them; one create case per object named. Enforced by testData.ts / dropOffObjectCases.
    expect(cases).toMatch(/no other field unless the request names it/i);
    expect(cases).toMatch(/one create case per object/i);
    // Session 102: no "invalid phone is rejected" cases — Salesforce does not check a phone's format.
    expect(cases).toMatch(/Phone, Text or URL field accepts any text/);
    // Run 2026-10-24T14-53-11-800Z-86059d19: the org's duplicate rule blocked a repeat of an earlier
    // run's Lead name. A create flow's name fields carry the {{uid}} token.
    const irText = withTargetApp("salesforce", () => fd.withFrontdoor(session, () => salesforceGuidance("ir")));
    expect(irText).toContain("{{uid}}");
    expect(cases).toContain("{{uid}}");
    expect(salesforceGuidance("plan")).toBe(""); // an ordinary run: still nothing
  });

  it("a frontdoor case drops only its credential-entry lines, so the correct IR is not 'incomplete'", () => {
    // The primary case and shipped IR of run 2026-10-24T06-42-12-486Z-0994a20c, verbatim.
    const testCase = {
      title: "Open app and confirm Home is visible after sign-in",
      category: "valid",
      steps: [
        `Go to the '${LANDING}' page.`,
        "Enter the username and continue.",
        "Enter the password and sign in.",
        "Verify the Home page is visible.",
      ],
      expected: "The browser lands on the Home page and the Home content (for example the 'Home' heading and the seller home content) is visible.",
    } as any;
    const ir = {
      meta: { feature: "Home", title: testCase.title, priority: "high", sourcePrompt: "x", baseUrl: ORG_URL },
      steps: [
        ...buildLoginPrefix(auth),
        { id: "s1", action: "navigate", target: { url: LANDING } },
        { id: "s2", action: "assert", target: { role: "heading", name: "Home" }, assertion: "visible" },
      ],
    } as any;
    expect(missingActions(ir, testCase)).not.toBeNull(); // what the run reported
    const cleaned = withoutCredentialEntry(testCase);
    expect(cleaned.steps).toEqual([testCase.steps[0], testCase.steps[3]]);
    expect(missingActions(ir, cleaned)).toBeNull();
    // Narrow: a line that names no credential is kept, and a quoted value is data, not a credential.
    const keep = { ...testCase, steps: ["Log in as an admin and open Leads", "Type 'password' into the Search box"] };
    expect(withoutCredentialEntry(keep)).toBe(keep);
  });

  it("landing on the org's own Lightning host is not 'blocked' once the observed hosts are passed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "zq-blocked-"));
    try {
      // The final-page.txt shape the generated spec writes: URL, then visible text.
      writeFileSync(path.join(dir, "final-page.txt"), `${LANDING}\nHome\nSeller Home`, "utf8");
      // Run 0994a20c's false verdict, reproduced: without the hosts it reads as an external sign-in.
      expect(detectBlocked(dir, ORG_URL)?.reason).toMatch(/left the application/);
      const hosts = ["zqcanary-dev-ed.scratch.my.salesforce.com", "zqcanary-dev-ed.scratch.lightning.force.com"];
      expect(detectBlocked(dir, ORG_URL, hosts)).toBeNull();
      // A genuinely foreign host is still blocked with the hosts passed.
      writeFileSync(path.join(dir, "final-page.txt"), "https://zq-idp.example.com/login\nSign in", "utf8");
      expect(detectBlocked(dir, ORG_URL, hosts)?.reason).toMatch(/left the application for zq-idp\.example\.com/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a walk taken through an org connection never shares a cache key with any other walk", () => {
    const model = { baseUrl: ORG_URL, pages: [] } as any;
    const prefix = buildLoginPrefix(auth);
    const plain = walkCacheKey(model, prefix, undefined, "full");
    const viaA = fd.withFrontdoor({ connectionId: "a", instanceHost: "zqa.scratch.my.salesforce.com", mint: async () => "" },
      () => walkCacheKey(model, prefix, undefined, "full"));
    const viaB = fd.withFrontdoor({ connectionId: "b", instanceHost: "zqb.scratch.my.salesforce.com", mint: async () => "" },
      () => walkCacheKey(model, prefix, undefined, "full"));
    expect(new Set([plain, viaA, viaB]).size).toBe(3);
  });

  it("the generated spec reads the env name, never a URL, and titles the step in words", () => {
    const spec = generateSpec({
      meta: { feature: "Home", title: "Open the app", priority: "high", sourcePrompt: "Open the app", baseUrl: ORG_URL },
      steps: [
        ...buildLoginPrefix(auth),
        { id: "s1", action: "assert", target: { role: "heading", name: "Seller Home" }, assertion: "visible" },
      ],
    } as any);
    expect(spec).toContain(`process.env.${fd.FRONTDOOR_ENV}`);
    expect(spec).not.toContain("${env:");
    expect(spec).not.toContain("frontdoor.jsp?sid");
    expect(spec).toContain("Sign in through the Salesforce org connection");
  });
});

// ------------------------------------------------------------------------------------------------
describe("3b. real Chromium against a local stand-in for frontdoor.jsp", () => {
  let server: http.Server;
  let base = "";
  let browser: Browser;
  const GOOD = "zqcanarygoodsession0123456789";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/secur/frontdoor.jsp") {
        if (u.searchParams.get("sid") === GOOD) {
          res.writeHead(302, { Location: u.searchParams.get("retURL") ?? "/" });
          return res.end();
        }
        // A refused token: Salesforce shows its login form instead of the app.
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<form><input id="username"><input type="password" id="password"><button id="Login">Log In</button></form>`);
      }
      if (u.pathname === "/lightning/page/home") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end(`<main><h1>Seller Home</h1></main>`);
      }
      res.writeHead(404); res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  const session = (sid: string) => ({
    connectionId: "zq-conn", instanceHost: "127.0.0.1",
    mint: async () => `${base}/secur/frontdoor.jsp?sid=${sid}&retURL=${encodeURIComponent("/lightning/page/home")}`,
  });

  it("openFrontdoor signs in and returns origin + path; a refused token throws without the secret", async () => {
    const page = await browser.newPage();
    try {
      expect(await fd.openFrontdoor(page, session(GOOD))).toBe(`${base}/lightning/page/home`);
      const bad = "zqcanaryexpiredsession0123456789";
      const err = await fd.openFrontdoor(page, session(bad)).catch((e) => e as Error);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/did not sign in/);
      expect(err.message).not.toContain(bad);
      await expect(fd.openFrontdoor(page, null)).rejects.toThrow(/has none/);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("the grounding replay resolves the env reference through the run's connection", async () => {
    const page = await browser.newPage();
    try {
      await fd.withFrontdoor(session(GOOD), () =>
        runStepLive(page, { id: "auth-0", action: "navigate", target: { url: fd.FRONTDOOR_REF } } as any, ORG_URL));
      expect(new URL(page.url()).pathname).toBe("/lightning/page/home");
      expect(await page.getByRole("heading", { name: "Seller Home" }).isVisible()).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("the EMITTED spec code signs in when SF_FRONTDOOR_URL is set, and says why when it is not", async () => {
    const spec = generateSpec({
      meta: { feature: "Home", title: "Open the app", priority: "high", sourcePrompt: "x", baseUrl: ORG_URL },
      steps: buildLoginPrefix({ status: "authenticated", frontdoor: true, url: `${base}/lightning/page/home` }),
    } as any);
    const start = spec.indexOf(`  if (!process.env.${fd.FRONTDOOR_ENV})`);
    const endMarker = ".catch(() => {});";
    const end = spec.indexOf(endMarker, start) + endMarker.length;
    expect(start).toBeGreaterThan(-1);
    const snippet = spec.slice(start, end);
    const AsyncFunction = Object.getPrototypeOf(async function () { /* */ }).constructor;
    const run = new AsyncFunction("page", "process", snippet);

    const page = await browser.newPage();
    try {
      await run(page, { env: { [fd.FRONTDOOR_ENV]: await session(GOOD).mint() } });
      expect(new URL(page.url()).pathname).toBe("/lightning/page/home");
      await expect(run(page, { env: {} })).rejects.toThrow(/SF_FRONTDOOR_URL is not set/);
    } finally {
      await page.close();
    }
  }, 60_000);
});
