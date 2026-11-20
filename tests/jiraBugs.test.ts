import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import request from "supertest";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, mkdtempSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { app } from "../src/server/index.js";
import { invalidateMemberships } from "../src/server/authz.js";
import { textToAdf, adfToText } from "../src/jira/adf.js";
import { authorizeUrl, jiraScopes } from "../src/jira/client.js";
import { normalizeFields, buildIssueFields, type BugField } from "../src/jira/bugs.js";
import { buildBugDraft, bugScreenshotFile, filedBugs, recordFiledBug } from "../src/server/jiraBugDraft.js";
import { _resetJiraSessions } from "../src/jira/session.js";

/**
 * D-86 — "Create Jira bug". Atlassian is faked by stubbing global fetch: no network, no cost. The
 * URLs, bodies and reply shapes asserted here are the ones in the REST v3 OpenAPI spec.
 */

const TOKEN = "atlassian-access-token-SECRET-456";
const CLOUD = "11111111-2222-3333-4444-555555555555";
const API = `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3`;
const RUN_ID = "2026-11-17T00-00-00-000Z-d85d85d8";
const RUN_DIR = path.resolve("runs", RUN_ID);

/** Jira's create metadata for project 10000, issue type 10004 ("Bug"), as the spec describes it. */
const META = [
  { fieldId: "summary", key: "summary", name: "Summary", required: true, hasDefaultValue: false, operations: ["set"], schema: { type: "string", system: "summary" } },
  { fieldId: "issuetype", key: "issuetype", name: "Issue Type", required: true, hasDefaultValue: false, operations: [], schema: { type: "issuetype", system: "issuetype" }, allowedValues: [{ id: "10004", name: "Bug" }] },
  { fieldId: "project", key: "project", name: "Project", required: true, hasDefaultValue: false, operations: ["set"], schema: { type: "project", system: "project" }, allowedValues: [{ id: "10000", name: "Shop" }] },
  { fieldId: "reporter", key: "reporter", name: "Reporter", required: true, hasDefaultValue: true, operations: ["set"], schema: { type: "user", system: "reporter" } },
  { fieldId: "priority", key: "priority", name: "Priority", required: false, hasDefaultValue: true, operations: ["set"], schema: { type: "priority", system: "priority" }, allowedValues: [{ id: "1", name: "Highest" }, { id: "3", name: "Medium" }] },
  { fieldId: "components", key: "components", name: "Components", required: true, hasDefaultValue: false, operations: ["add", "set", "remove"], schema: { type: "array", items: "component", system: "components" }, allowedValues: [{ id: "100", name: "Checkout" }, { id: "101", name: "Login" }] },
  { fieldId: "labels", key: "labels", name: "Labels", required: false, hasDefaultValue: false, operations: ["add", "set", "remove"], schema: { type: "array", items: "string", system: "labels" } },
  { fieldId: "description", key: "description", name: "Description", required: false, hasDefaultValue: false, operations: ["set"], schema: { type: "string", system: "description" } },
  { fieldId: "duedate", key: "duedate", name: "Due date", required: false, hasDefaultValue: false, operations: ["set"], schema: { type: "date", system: "duedate" } },
  { fieldId: "customfield_10050", key: "customfield_10050", name: "Steps", required: false, hasDefaultValue: false, operations: ["set"], schema: { type: "string", custom: "com.atlassian.jira.plugin.system.customfieldtypes:textarea", customId: 10050 } },
  { fieldId: "customfield_10051", key: "customfield_10051", name: "Build", required: false, hasDefaultValue: false, operations: ["set"], schema: { type: "number", custom: "com.atlassian.jira.plugin.system.customfieldtypes:float", customId: 10051 } },
  { fieldId: "customfield_10052", key: "customfield_10052", name: "QA owner", required: false, hasDefaultValue: false, operations: ["set"], schema: { type: "user", custom: "com.atlassian.jira.plugin.system.customfieldtypes:userpicker", customId: 10052 } },
  { fieldId: "attachment", key: "attachment", name: "Attachment", required: false, hasDefaultValue: false, operations: ["set"], schema: { type: "array", items: "attachment", system: "attachment" } },
];

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
let tokenScope = "read:jira-work write:jira-work";
let siteScopes = ["read:jira-work", "write:jira-work"];
let createReply: () => Response;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  delete process.env.AUTH_ENABLED;
  delete process.env.DB_ENABLED;
  invalidateMemberships();
  _resetJiraSessions();
  process.env.JIRA_ENABLED = "true";
  process.env.JIRA_BUGS_ENABLED = "true";
  process.env.JIRA_CLIENT_ID = "client-id-abc";
  process.env.JIRA_CLIENT_SECRET = "client-secret-XYZ";
  calls = [];
  tokenScope = "read:jira-work write:jira-work";
  siteScopes = ["read:jira-work", "write:jira-work"];
  createReply = () => json({ id: "20001", key: "SHOP-45", self: `${API}/issue/20001` }, 201);
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    if (u === "https://auth.atlassian.com/oauth/token") return json({ access_token: TOKEN, expires_in: 3600, scope: tokenScope });
    if (u === "https://api.atlassian.com/oauth/token/accessible-resources") {
      return json([{ id: CLOUD, name: "thinkvibes", url: "https://thinkvibes.atlassian.net", scopes: siteScopes }]);
    }
    if (u.startsWith(`${API}/project/search?`)) {
      return json({ startAt: 0, maxResults: 50, total: 2, isLast: true, values: [
        { id: "10000", key: "SHOP", name: "Shop" },
        { id: "10001", key: "OLD", name: "Old", archived: true },
      ] });
    }
    if (u.startsWith(`${API}/issue/createmeta/10000/issuetypes/10004?`)) return json({ startAt: 0, maxResults: 200, total: META.length, fields: META });
    if (u.startsWith(`${API}/issue/createmeta/10000/issuetypes?`)) {
      return json({ startAt: 0, maxResults: 200, total: 3, issueTypes: [
        { id: "10001", name: "Story", subtask: false }, { id: "10004", name: "Bug", subtask: false }, { id: "10005", name: "Sub-task", subtask: true },
      ] });
    }
    if (u === `${API}/issue` && init?.method === "POST") return createReply();
    if (u === `${API}/issue/SHOP-45/attachments`) return json([{ id: "1" }]);
    if (u === `${API}/issueLinkType`) return json({ issueLinkTypes: [{ id: "10000", name: "Blocks" }, { id: "10003", name: "Relates", inward: "relates to", outward: "relates to" }] });
    if (u === `${API}/issueLink`) return new Response(null, { status: 201 });
    throw new Error(`unexpected fetch ${u}`);
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const k of ["JIRA_ENABLED", "JIRA_BUGS_ENABLED", "JIRA_CLIENT_ID", "JIRA_CLIENT_SECRET"]) delete process.env[k];
  rmSync(RUN_DIR, { recursive: true, force: true });
});

afterAll(() => rmSync(RUN_DIR, { recursive: true, force: true }));

async function connect() {
  const start = await request(app).post("/api/jira/connect");
  const state = new URL(start.body.authorizeUrl).searchParams.get("state")!;
  await request(app).get(`/api/jira/callback?code=the-code&state=${encodeURIComponent(state)}`);
  return start;
}

/** A finished run with one failed case, written the way the pipeline writes it — already scrubbed. */
function writeRun(root: string, runId: string, opts: { status?: string; shot?: string | null } = {}) {
  const dir = path.join(root, runId);
  const caseDir = path.join(dir, "cases", "case-1");
  mkdirSync(path.join(caseDir, "artifacts"), { recursive: true });
  const shot = path.join(caseDir, "artifacts", "step-3.png");
  writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const shotUrl = opts.shot === undefined ? "/" + path.relative(".", shot).replace(/\\/g, "/") : opts.shot;
  writeFileSync(path.join(dir, "00-input.json"), JSON.stringify({ prompt: "log in with password Hunter2Secret!", url: "https://shop.example.com/login" }));
  writeFileSync(path.join(dir, "07-suite-summary.json"), JSON.stringify({ total: 2, passed: 1, failed: 1, cases: [
    { caseId: "case-0", title: "Home loads", status: "passed", resultPath: "cases/case-0" },
    { caseId: "case-1", title: "Valid login opens the dashboard", status: opts.status ?? "failed", resultPath: "cases/case-1",
      whyItMatters: "Customers who can't log in can't buy anything.", expected: "The dashboard is shown.",
      failedStep: 3, failedStepTitle: "Check that heading \"Dashboard\" appears", error: "\u001b[31mTimeout 5000ms\u001b[39m waiting for heading",
      ...(shotUrl ? { screenshotUrl: shotUrl } : {}) },
  ] }));
  writeFileSync(path.join(caseDir, "04-ir.json"), JSON.stringify({ meta: { title: "Valid login" }, steps: [
    { id: "s1", action: "goto", value: "https://shop.example.com/login" },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Password" }, value: "${env:TEST_PASSWORD}" },
    { id: "s3", action: "assertVisible", target: { role: "heading", name: "Dashboard" } },
  ] }));
  writeFileSync(path.join(caseDir, "06-diagnosis.json"), JSON.stringify({ failingStepId: "s3", category: "other", explanation: "The page stayed on the login form.", suggestedFix: "" }));
  return { dir, shot };
}

// ---------------------------------------------------------------------------

describe("the sign-in asks for write only while the flag is on", () => {
  const cfg = { clientId: "cid", clientSecret: "s", redirectUrl: "http://localhost:3000/api/jira/callback" };
  it("flag off: exactly the read-only scope, as before", () => {
    delete process.env.JIRA_BUGS_ENABLED;
    expect(jiraScopes()).toEqual(["read:jira-work"]);
    expect(new URL(authorizeUrl(cfg, "st")).searchParams.get("scope")).toBe("read:jira-work");
  });
  it("flag on: read plus write:jira-work, still no offline_access", () => {
    expect(jiraScopes()).toEqual(["read:jira-work", "write:jira-work"]);
    expect(new URL(authorizeUrl(cfg, "st")).searchParams.get("scope")).toBe("read:jira-work write:jira-work");
  });
  it("JIRA_BUGS_ENABLED alone does nothing without JIRA_ENABLED", () => {
    delete process.env.JIRA_ENABLED;
    expect(jiraScopes()).toEqual(["read:jira-work"]);
  });
});

describe("textToAdf", () => {
  it("paragraphs on blank lines, hardBreak on single line breaks, and round-trips through adfToText", () => {
    const adf = textToAdf("First line\nsecond line\n\n\nNext paragraph\r\n");
    expect(adf).toEqual({ version: 1, type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "First line" }, { type: "hardBreak" }, { type: "text", text: "second line" }] },
      { type: "paragraph", content: [{ type: "text", text: "Next paragraph" }] },
    ] });
    expect(adfToText(adf)).toContain("Next paragraph");
    expect(textToAdf("   \n\n ").content).toEqual([]);
  });
});

describe("normalizeFields: Jira's metadata -> the form", () => {
  const fields = normalizeFields(META);
  const byId = Object.fromEntries(fields.map((f) => [f.id, f]));
  it("leaves out what Testbench sets itself, and orders summary then description first", () => {
    expect(fields.map((f) => f.id).slice(0, 2)).toEqual(["summary", "description"]);
    for (const id of ["project", "issuetype", "attachment"]) expect(byId[id]).toBeUndefined();
  });
  it("gives each field the right kind, with Jira's own choices", () => {
    expect(byId.summary).toMatchObject({ kind: "text", required: true });
    expect(byId.description.kind).toBe("richtext");
    expect(byId.customfield_10050.kind).toBe("richtext"); // textarea custom field takes ADF
    expect(byId.customfield_10051.kind).toBe("number");
    expect(byId.duedate.kind).toBe("date");
    expect(byId.labels.kind).toBe("labels");
    expect(byId.priority).toMatchObject({ kind: "select", options: [{ id: "1", label: "Highest" }, { id: "3", label: "Medium" }] });
    expect(byId.components).toMatchObject({ kind: "multiselect", required: true });
    expect(byId.customfield_10052.kind).toBe("unsupported");
  });
  it("a required field Jira fills by default (reporter) does not block the form", () => {
    expect(byId.reporter).toMatchObject({ kind: "unsupported", required: false });
    expect(byId.priority.required).toBe(false);
  });
});

describe("buildIssueFields: the check on what the form sent", () => {
  const meta = normalizeFields(META);
  it("builds Jira's body: ids for choices, ADF for rich text, words for labels", () => {
    const r = buildIssueFields(meta, {
      summary: "  Login fails\n", description: "What happened\n\nSteps", components: ["101"], priority: "1",
      labels: "testbench, regression  ui", duedate: "2026-12-01", customfield_10051: "42", customfield_10050: "",
    }, "10000", "10004");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.fields).toEqual({
      project: { id: "10000" }, issuetype: { id: "10004" }, summary: "Login fails",
      description: textToAdf("What happened\n\nSteps"), components: [{ id: "101" }], priority: { id: "1" },
      labels: ["testbench", "regression", "ui"], duedate: "2026-12-01", customfield_10051: 42,
    }); // the blank optional field is dropped, not sent empty
  });
  it("refuses a missing required field, a choice Jira didn't offer, a field not on this screen, and a bad date", () => {
    const r = buildIssueFields(meta, { priority: "999", customfield_99999: "x", duedate: "next week" }, "10000", "10004");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(Object.keys(r.fieldErrors).sort()).toEqual(["components", "customfield_99999", "duedate", "priority", "summary"]);
    expect(r.fieldErrors.summary).toBe("Summary is required");
  });
  it("a required field Testbench can't fill blocks the create with a plain reason", () => {
    const strict = meta.map((f) => (f.id === "customfield_10052" ? { ...f, required: true } : f)) as BugField[];
    const r = buildIssueFields(strict, { summary: "x", components: ["100"] }, "10000", "10004");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.customfield_10052).toMatch(/can't be filled from Testbench yet/);
  });
  it("datetime is sent in Jira's +0000 form; a too-long summary is refused", () => {
    const m: BugField[] = [{ id: "summary", name: "Summary", required: true, kind: "text" }, { id: "when", name: "When", required: false, kind: "datetime" }];
    const ok = buildIssueFields(m, { summary: "a", when: "2026-11-17T10:30:00.000Z" }, "1", "2");
    expect(ok.ok && ok.fields.when).toBe("2026-11-17T10:30:00.000+0000");
    expect(buildIssueFields(m, { summary: "x".repeat(256) }, "1", "2").ok).toBe(false);
  });
});

describe("the prefilled draft", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "d85-"));
  const runId = "2026-11-17T01-00-00-000Z-0000aaaa";
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("is built from the run's own files: steps, expected, what happened, the diagnosis — never the prompt", () => {
    const { shot } = writeRun(root, runId);
    const d = buildBugDraft(runId, "case-1", root);
    expect(d).not.toBe(null);
    if (!d || d === "passed") return;
    expect(d.summary).toBe("Test failed: Valid login opens the dashboard");
    expect(d.description).toContain("on https://shop.example.com/login and it failed.");
    expect(d.description).toContain("Expected:\nThe dashboard is shown.");
    expect(d.description).toContain("Stopped at step 3: Check that heading \"Dashboard\" appears.");
    expect(d.description).toContain("Timeout 5000ms waiting for heading"); // terminal colour codes stripped
    expect(d.description).not.toContain("\u001b");
    expect(d.description).toMatch(/Steps the test took:\n1\. .+\n2\. .+\n3\. /);
    expect(d.description).toContain("written by AI");
    expect(d.description).not.toContain("Hunter2Secret!"); // the prompt is never copied
    expect(d.hasScreenshot).toBe(true);
    expect(bugScreenshotFile(runId, "case-1", root)).toBe(path.resolve(shot));
  });
  it("a passed case has nothing to report; an unknown case is null", () => {
    expect(buildBugDraft(runId, "case-0", root)).toBe("passed");
    expect(buildBugDraft(runId, "case-9", root)).toBe(null);
  });
  it("a screenshot path that leaves the run's directory is never used", () => {
    const other = "2026-11-17T02-00-00-000Z-0000bbbb";
    writeRun(root, other, { shot: "/etc/passwd.png" });
    expect(bugScreenshotFile(other, "case-1", root)).toBe(null);
    const third = "2026-11-17T03-00-00-000Z-0000cccc";
    writeRun(root, third, { shot: "/" + path.relative(".", path.join(root, runId, "cases", "case-1", "artifacts", "step-3.png")) });
    expect(bugScreenshotFile(third, "case-1", root)).toBe(null); // another run's file
  });
  it("remembers the issues created from a case", () => {
    expect(filedBugs(runId, "case-1", root)).toEqual([]);
    recordFiledBug(runId, "case-1", { key: "SHOP-1", link: "https://x/browse/SHOP-1", siteName: "x", createdAt: "t" }, root);
    recordFiledBug(runId, "case-1", { key: "SHOP-2", link: "", siteName: "x", createdAt: "t" }, root);
    expect(filedBugs(runId, "case-1", root).map((b) => b.key)).toEqual(["SHOP-1", "SHOP-2"]);
  });
});

describe("routes, flag on", () => {
  it("status says the site can write; projects, issue types and fields come from Jira", async () => {
    const start = await connect();
    expect(new URL(start.body.authorizeUrl).searchParams.get("scope")).toBe("read:jira-work write:jira-work");
    const status = await request(app).get("/api/jira/status");
    expect(status.body.sites).toEqual([{ id: CLOUD, name: "thinkvibes", url: "https://thinkvibes.atlassian.net", canWrite: true }]);
    expect((await request(app).get("/api/health")).body.jiraBugs).toBe(true);

    const projects = await request(app).get("/api/jira/bug/projects?query=sho");
    expect(projects.body.projects).toEqual([{ id: "10000", key: "SHOP", name: "Shop" }]); // archived left out
    const q = new URL(calls.find((c) => c.url.includes("/project/search"))!.url).searchParams;
    expect(q.get("action")).toBe("create");
    expect(q.get("query")).toBe("sho");

    const types = await request(app).get("/api/jira/bug/projects/10000/issuetypes");
    expect(types.body.issueTypes.map((t: { name: string }) => t.name)).toEqual(["Story", "Bug"]); // no sub-task
    const fields = await request(app).get("/api/jira/bug/projects/10000/issuetypes/10004/fields");
    expect(fields.body.fields[0]).toEqual({ id: "summary", name: "Summary", required: true, kind: "text" });

    expect((await request(app).get("/api/jira/bug/projects/abc/issuetypes")).status).toBe(400);
    for (const r of [start, status, projects, types, fields]) expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });

  it("draft -> create: the issue, the screenshot, the story link, and 'already reported' next time", async () => {
    writeRun("runs", RUN_ID);
    await connect();
    const draft = await request(app).get(`/api/runs/${RUN_ID}/cases/case-1/jira-bug`);
    expect(draft.status).toBe(200);
    expect(draft.body.bugs).toEqual([]);
    expect(draft.body.draft.summary).toBe("Test failed: Valid login opens the dashboard");

    const created = await request(app).post(`/api/runs/${RUN_ID}/cases/case-1/jira-bug`).send({
      projectId: "10000", issueTypeId: "10004", attachScreenshot: true, relatesTo: "shop-7",
      fields: { summary: draft.body.draft.summary, description: draft.body.draft.description, components: ["100"] },
    });
    expect(created.status).toBe(201);
    expect(created.body).toEqual({ key: "SHOP-45", link: "https://thinkvibes.atlassian.net/browse/SHOP-45", attached: true, linked: true, warnings: [] });

    // The field list was read again from Jira before the create — not taken from the browser.
    const order = calls.map((c) => c.url.replace(API, ""));
    expect(order.indexOf("/issue")).toBeGreaterThan(order.findIndex((u) => u.startsWith("/issue/createmeta/10000/issuetypes/10004")));
    const post = calls.find((c) => c.url === `${API}/issue`)!;
    expect(JSON.parse(String(post.init!.body)).fields).toMatchObject({
      project: { id: "10000" }, issuetype: { id: "10004" }, components: [{ id: "100" }], summary: "Test failed: Valid login opens the dashboard",
      description: { type: "doc", version: 1 },
    });
    const att = calls.find((c) => c.url.endsWith("/attachments"))!;
    expect((att.init!.headers as Record<string, string>)["X-Atlassian-Token"]).toBe("no-check");
    expect((att.init!.body as FormData).get("file")).toBeInstanceOf(Blob);
    const link = calls.find((c) => c.url === `${API}/issueLink`)!;
    expect(JSON.parse(String(link.init!.body))).toEqual({ type: { name: "Relates" }, inwardIssue: { key: "SHOP-7" }, outwardIssue: { key: "SHOP-45" } });

    const again = await request(app).get(`/api/runs/${RUN_ID}/cases/case-1/jira-bug`);
    expect(again.body.bugs.map((b: { key: string }) => b.key)).toEqual(["SHOP-45"]);
    expect(JSON.parse(readFileSync(path.join(RUN_DIR, "cases", "case-1", "jira-bugs.json"), "utf8"))[0].key).toBe("SHOP-45");
    for (const r of [draft, created, again]) expect(JSON.stringify(r.body)).not.toContain(TOKEN);
  });

  it("a bad value is refused before Jira is asked to create anything", async () => {
    writeRun("runs", RUN_ID);
    await connect();
    const r = await request(app).post(`/api/runs/${RUN_ID}/cases/case-1/jira-bug`).send({
      projectId: "10000", issueTypeId: "10004", fields: { summary: "x", components: ["not-a-choice"], customfield_99999: "smuggled" },
    });
    expect(r.status).toBe(400);
    expect(Object.keys(r.body.fieldErrors).sort()).toEqual(["components", "customfield_99999"]);
    expect(calls.some((c) => c.url === `${API}/issue`)).toBe(false);
  });

  it("Jira's own field errors come back by field, and nothing is remembered", async () => {
    writeRun("runs", RUN_ID);
    await connect();
    createReply = () => json({ errorMessages: [], errors: { components: "Component is not valid." } }, 400);
    const r = await request(app).post(`/api/runs/${RUN_ID}/cases/case-1/jira-bug`).send({
      projectId: "10000", issueTypeId: "10004", fields: { summary: "x", components: ["100"] },
    });
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "Jira didn't accept the issue. Components: Component is not valid.", fieldErrors: { components: "Component is not valid." } });
    expect(existsSync(path.join(RUN_DIR, "cases", "case-1", "jira-bugs.json"))).toBe(false);
  });

  it("a read-only sign-in is asked to reconnect, and nothing is created", async () => {
    writeRun("runs", RUN_ID);
    siteScopes = ["read:jira-work"];
    await connect();
    expect((await request(app).get("/api/jira/status")).body.sites[0].canWrite).toBe(false);
    const r = await request(app).post(`/api/runs/${RUN_ID}/cases/case-1/jira-bug`).send({
      projectId: "10000", issueTypeId: "10004", fields: { summary: "x", components: ["100"] },
    });
    expect(r.status).toBe(403);
    expect(r.body.reconnect).toBe(true);
    expect(calls.some((c) => c.url.startsWith(`${API}/issue`))).toBe(false);
  });

  it("a passed case can't be reported, and not connected means connect first", async () => {
    writeRun("runs", RUN_ID);
    expect((await request(app).get(`/api/runs/${RUN_ID}/cases/case-0/jira-bug`)).status).toBe(409);
    const r = await request(app).post(`/api/runs/${RUN_ID}/cases/case-1/jira-bug`).send({ projectId: "10000", issueTypeId: "10004", fields: {} });
    expect(r.status).toBe(401);
    expect(r.body.signedOut).toBe(true);
  });
});

describe("flag off: exactly as before", () => {
  it("every new route is 404, health and status carry nothing new, and nothing calls Atlassian", async () => {
    delete process.env.JIRA_BUGS_ENABLED;
    writeRun("runs", RUN_ID);
    for (const r of [
      await request(app).get("/api/jira/bug/projects"),
      await request(app).get("/api/jira/bug/projects/10000/issuetypes"),
      await request(app).get("/api/jira/bug/projects/10000/issuetypes/10004/fields"),
      await request(app).get(`/api/runs/${RUN_ID}/cases/case-1/jira-bug`),
      await request(app).post(`/api/runs/${RUN_ID}/cases/case-1/jira-bug`).send({}),
    ]) expect(r.status).toBe(404);
    expect((await request(app).get("/api/health")).body).not.toHaveProperty("jiraBugs");
    expect(calls).toEqual([]);
    await connect();
    expect((await request(app).get("/api/jira/status")).body.sites).toEqual([{ id: CLOUD, name: "thinkvibes", url: "https://thinkvibes.atlassian.net" }]);
  });
});
