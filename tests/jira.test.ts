import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import { app } from "../src/server/index.js";
import { invalidateMemberships } from "../src/server/authz.js";
import { adfToText } from "../src/jira/adf.js";
import { authorizeUrl, parseIssueKey, fetchStory, JIRA_SCOPES } from "../src/jira/client.js";
import { beginSignIn, finishSignIn, getConnection, saveConnection, _resetJiraSessions, STATE_TTL_MS } from "../src/jira/session.js";

/**
 * D-63 — Jira Phase 1: "Connect Jira" (OAuth 2.0 3LO) and read one story into the prompt box.
 * Atlassian is faked by stubbing global fetch: no network, no cost. URLs and shapes asserted here
 * are the ones from Atlassian's OAuth 3LO page and the REST v3 OpenAPI spec.
 */

const TOKEN = "atlassian-access-token-SECRET-123";
const SECRET = "client-secret-XYZ";
const CLOUD = "11111111-2222-3333-4444-555555555555";

const ADF = {
  version: 1, type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "User logs in with a valid username and password." }] },
    { type: "paragraph", content: [{ type: "text", text: "Acceptance criteria:", marks: [{ type: "strong" }] }] },
    { type: "bulletList", content: [
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Correct details open the home page" }] }] },
      { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "Wrong password shows an error" }] }] },
    ] },
    { type: "mediaSingle", content: [{ type: "media", attrs: { id: "x", type: "file" } }] },
  ],
};

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let issueReply: () => Response;

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });
}

beforeEach(() => {
  delete process.env.AUTH_ENABLED;
  delete process.env.DB_ENABLED;
  invalidateMemberships();
  _resetJiraSessions();
  process.env.JIRA_ENABLED = "true";
  process.env.JIRA_CLIENT_ID = "client-id-abc";
  process.env.JIRA_CLIENT_SECRET = SECRET;
  delete process.env.JIRA_REDIRECT_URL;
  delete process.env.JIRA_MAX_PROMPT_CHARS;
  calls = [];
  issueReply = () => json({ key: "TBS-1", fields: { summary: "User can log in", description: ADF } });
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    if (url === "https://auth.atlassian.com/oauth/token") return json({ access_token: TOKEN, expires_in: 3600, scope: "read:jira-work" });
    if (url === "https://api.atlassian.com/oauth/token/accessible-resources") {
      return json([
        { id: CLOUD, name: "thinkvibes", url: "https://thinkvibes.atlassian.net", scopes: ["read:jira-work"], avatarUrl: "" },
        { id: "conf-1", name: "wiki", url: "https://thinkvibes.atlassian.net/wiki", scopes: ["read:confluence-content.all"] },
      ]);
    }
    if (String(url).startsWith(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/`)) return issueReply();
    throw new Error(`unexpected fetch ${url}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["JIRA_ENABLED", "JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET", "JIRA_REDIRECT_URL", "JIRA_MAX_PROMPT_CHARS"]) delete process.env[k];
});

/** Connect through the real routes; returns every response so tests can scan them for the token. */
async function connectThroughRoutes() {
  const start = await request(app).post("/api/jira/connect");
  const state = new URL(start.body.authorizeUrl).searchParams.get("state")!;
  const cb = await request(app).get(`/api/jira/callback?code=the-code&state=${encodeURIComponent(state)}`);
  return { start, cb, state };
}

describe("adfToText", () => {
  it("keeps paragraphs, lists and the acceptance criteria; skips pictures", () => {
    expect(adfToText(ADF)).toBe(
      "User logs in with a valid username and password.\n\nAcceptance criteria:\n\n" +
      "- Correct details open the home page\n- Wrong password shows an error");
  });

  it("ordered lists, hard breaks, mentions, tables, and unknown nodes still yield their text", () => {
    const doc = { type: "doc", version: 1, content: [
      { type: "orderedList", attrs: { order: 3 }, content: [
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "a" }, { type: "hardBreak" }, { type: "text", text: "b" }] }] },
        { type: "listItem", content: [{ type: "paragraph", content: [{ type: "mention", attrs: { id: "1", text: "@Asha" } }] }] },
      ] },
      { type: "table", content: [{ type: "tableRow", content: [
        { type: "tableHeader", content: [{ type: "paragraph", content: [{ type: "text", text: "Field" }] }] },
        { type: "tableCell", content: [{ type: "paragraph", content: [{ type: "text", text: "Email" }] }] },
      ] }] },
      { type: "someFutureNode", content: [{ type: "paragraph", content: [{ type: "text", text: "still here" }] }] },
    ] };
    expect(adfToText(doc)).toBe("3. a\nb\n4. @Asha\n\nField | Email\n\nstill here");
  });

  it("null and a plain string are handled", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText("  plain  ")).toBe("plain");
  });
});

describe("parseIssueKey", () => {
  it.each([["TBS-1", "TBS-1"], ["tbs-12", "TBS-12"], [" TBS_A-7 ", "TBS_A-7"],
    ["https://x.atlassian.net/browse/TBS-3", "TBS-3"], ["https://x.atlassian.net/browse/TBS-3?focused=1", "TBS-3"]])("%s", (i, o) => {
    expect(parseIssueKey(i)).toBe(o);
  });
  it.each(["", "TBS", "1-TBS", "TBS-1; DROP", "../TBS-1", "TBS-1/comment"])("rejects %s", (i) => {
    expect(parseIssueKey(i)).toBeNull();
  });
});

describe("authorizeUrl", () => {
  it("is exactly Atlassian's documented authorize call, read-only scope, no offline_access", () => {
    const u = new URL(authorizeUrl({ clientId: "cid", clientSecret: "SECRETVALUE", redirectUrl: "http://localhost:3000/api/jira/callback" }, "st"));
    expect(`${u.origin}${u.pathname}`).toBe("https://auth.atlassian.com/authorize");
    expect(Object.fromEntries(u.searchParams)).toEqual({
      audience: "api.atlassian.com", client_id: "cid", scope: "read:jira-work",
      redirect_uri: "http://localhost:3000/api/jira/callback", state: "st", response_type: "code", prompt: "consent",
    });
    expect(JIRA_SCOPES).not.toContain("offline_access");
    expect(u.toString()).not.toContain("SECRETVALUE"); // the secret is never in the URL
  });
});

describe("the one-time state", () => {
  it("is random, bound to the user, and works once", () => {
    const a = beginSignIn("user-1");
    const b = beginSignIn("user-1");
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43); // 32 bytes, base64url
    expect(finishSignIn(a)).toBe("user-1");
    expect(finishSignIn(a)).toBeNull();
  });

  it("expires after 10 minutes; unknown or missing is refused", () => {
    const t = Date.now();
    const s = beginSignIn("user-1", t);
    expect(finishSignIn(s, t + STATE_TTL_MS + 1)).toBeNull();
    expect(finishSignIn("made-up")).toBeNull();
    expect(finishSignIn(undefined)).toBeNull();
  });

  it("an expired connection is gone", () => {
    saveConnection("u", { accessToken: TOKEN, expiresAt: Date.now() - 1, sites: [] });
    expect(getConnection("u")).toBeNull();
  });
});

describe("routes, flag on", () => {
  it("connect -> callback -> status -> fetch story: the prompt text, and the token never leaves the server", async () => {
    const { start, cb } = await connectThroughRoutes();
    expect(start.status).toBe(200);
    expect(cb.status).toBe(200);
    expect(cb.text).toContain("Jira connected: thinkvibes.");
    expect(cb.headers["cache-control"]).toBe("no-store");
    expect(cb.headers["referrer-policy"]).toBe("no-referrer");

    // The token swap is Atlassian's documented body, with the default local callback.
    const swap = calls.find((c) => c.url === "https://auth.atlassian.com/oauth/token")!;
    expect(JSON.parse(String(swap.init!.body))).toEqual({
      grant_type: "authorization_code", client_id: "client-id-abc", client_secret: SECRET,
      code: "the-code", redirect_uri: "http://localhost:3000/api/jira/callback",
    });

    const status = await request(app).get("/api/jira/status");
    expect(status.body).toEqual({ configured: true, connected: true,
      sites: [{ id: CLOUD, name: "thinkvibes", url: "https://thinkvibes.atlassian.net" }] }); // Confluence filtered out

    const story = await request(app).get("/api/jira/issue/tbs-1");
    expect(story.status).toBe(200);
    expect(story.body).toEqual({
      key: "TBS-1", title: "User can log in", truncated: false, siteName: "thinkvibes",
      link: "https://thinkvibes.atlassian.net/browse/TBS-1",
      promptText: "User can log in\n\nUser logs in with a valid username and password.\n\nAcceptance criteria:\n\n" +
        "- Correct details open the home page\n- Wrong password shows an error",
    });
    const get = calls.find((c) => c.url.includes("/rest/api/3/issue/"))!;
    expect(get.url).toBe(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/TBS-1?fields=summary,description`);
    expect((get.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(get.init!.method ?? "GET").toBe("GET"); // read-only

    for (const r of [start, cb, status, story]) {
      expect(JSON.stringify(r.headers) + r.text).not.toContain(TOKEN);
      expect(JSON.stringify(r.headers) + r.text).not.toContain(SECRET);
    }
  });

  it("the token and secret never reach a log line", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await connectThroughRoutes();
    issueReply = () => json({}, 500);
    await request(app).get("/api/jira/issue/TBS-1");
    const logged = spies.flatMap((s) => s.mock.calls.flat()).map(String).join("\n");
    expect(logged).not.toContain(TOKEN);
    expect(logged).not.toContain(SECRET);
    spies.forEach((s) => s.mockRestore());
  });

  it("a reused, unknown or declined callback connects nothing and calls nobody", async () => {
    const { state } = await connectThroughRoutes();
    calls = [];
    const again = await request(app).get(`/api/jira/callback?code=c&state=${encodeURIComponent(state)}`);
    expect(again.status).toBe(400);
    expect(again.text).toContain("expired or was already used");
    const forged = await request(app).get("/api/jira/callback?code=c&state=forged");
    expect(forged.status).toBe(400);
    expect(calls).toEqual([]);

    _resetJiraSessions();
    const s2 = new URL((await request(app).post("/api/jira/connect")).body.authorizeUrl).searchParams.get("state")!;
    const declined = await request(app).get(`/api/jira/callback?error=access_denied&state=${encodeURIComponent(s2)}`);
    expect(declined.status).toBe(400);
    expect((await request(app).get("/api/jira/status")).body.connected).toBe(false);
  });

  it("not connected, bad key, not found, busy, and an expired sign-in", async () => {
    let r = await request(app).get("/api/jira/issue/TBS-1");
    expect(r.status).toBe(401);
    expect(r.body.signedOut).toBe(true);

    await connectThroughRoutes();
    expect((await request(app).get("/api/jira/issue/not-a-key")).status).toBe(400);

    issueReply = () => json({ errorMessages: ["Issue does not exist"] }, 404);
    r = await request(app).get("/api/jira/issue/TBS-9");
    expect(r.status).toBe(404);
    expect(r.body.error).toContain("TBS-9 wasn't found");

    issueReply = () => json({}, 429, { "Retry-After": "7" });
    r = await request(app).get("/api/jira/issue/TBS-1");
    expect(r.status).toBe(429);
    expect(r.body.error).toContain("7 seconds");

    issueReply = () => json({}, 401);
    r = await request(app).get("/api/jira/issue/TBS-1");
    expect(r.status).toBe(401);
    expect(r.body.signedOut).toBe(true);
    expect((await request(app).get("/api/jira/status")).body.connected).toBe(false); // forgotten
  });

  it("a long story is cut to JIRA_MAX_PROMPT_CHARS and says so", async () => {
    process.env.JIRA_MAX_PROMPT_CHARS = "40";
    await connectThroughRoutes();
    const r = await request(app).get("/api/jira/issue/TBS-1");
    expect(r.body.truncated).toBe(true);
    expect(r.body.promptText.length).toBeLessThanOrEqual(40);
  });

  it("disconnect forgets the token", async () => {
    await connectThroughRoutes();
    expect((await request(app).post("/api/jira/disconnect")).status).toBe(204);
    expect((await request(app).get("/api/jira/status")).body.connected).toBe(false);
  });

  it("missing app settings: connect names them (never values), and status says not configured", async () => {
    delete process.env.JIRA_CLIENT_SECRET;
    const r = await request(app).post("/api/jira/connect");
    expect(r.status).toBe(503);
    expect(r.body.error).toContain("JIRA_CLIENT_SECRET");
    expect((await request(app).get("/api/jira/status")).body).toMatchObject({ configured: false, missing: ["JIRA_CLIENT_SECRET"] });
  });

  it("health says jira: true", async () => {
    expect((await request(app).get("/api/health")).body.jira).toBe(true);
  });
});

describe("flag off: exactly as before", () => {
  it("every Jira route is 404, health has no jira field, and nothing calls Atlassian", async () => {
    delete process.env.JIRA_ENABLED;
    const state = beginSignIn("00000000-0000-4000-8000-000000000001");
    for (const r of [
      await request(app).get("/api/jira/status"),
      await request(app).post("/api/jira/connect"),
      await request(app).get(`/api/jira/callback?code=c&state=${state}`),
      await request(app).get("/api/jira/issue/TBS-1"),
      await request(app).post("/api/jira/disconnect"),
    ]) expect(r.status).toBe(404);
    expect((await request(app).get("/api/health")).body).not.toHaveProperty("jira");
    expect(calls).toEqual([]);
  });
});

describe("fetchStory directly", () => {
  it("uses the key Jira returns (case-insensitive / moved issue) and an empty story is refused", async () => {
    const site = { id: CLOUD, name: "s", url: "https://s.atlassian.net/" };
    const conn = { accessToken: TOKEN, expiresAt: Date.now() + 60_000, sites: [site] };
    issueReply = () => json({ key: "NEW-5", fields: { summary: "Moved", description: null } });
    const s = await fetchStory(conn, site, "OLD-5");
    expect(s.key).toBe("NEW-5");
    expect(s.link).toBe("https://s.atlassian.net/browse/NEW-5");
    expect(s.promptText).toBe("Moved");
    issueReply = () => json({ key: "E-1", fields: { summary: "", description: null } });
    await expect(fetchStory(conn, site, "E-1")).rejects.toThrow(/no title or description/);
  });
});
