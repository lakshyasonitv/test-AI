import { describe, it, expect, afterEach, vi } from "vitest";
import { orgRefusal, assertTestOrg, classifyOrg } from "../src/stages/salesforceOrgLogin.js";

/**
 * D-68 — SALESFORCE_ALLOW_ALL_ORGS. Off: the D-64 guard exactly (scratch + sandbox only). On: every
 * Salesforce host is accepted and a non-scratch/non-sandbox org is named in the server log; a host
 * Salesforce does not serve is still refused. Pure: no browser, no network.
 */

const SCRATCH = "https://ruby-data-2200-dev-ed.scratch.my.salesforce.com/";
const SANDBOX = "https://acme--uat.sandbox.my.salesforce.com/";
const OTHER_SALESFORCE = [
  "https://acme.my.salesforce.com/",                  // production My Domain
  "https://acme-dev-ed.develop.my.salesforce.com/",   // Developer Edition
  "https://login.salesforce.com/",
  "https://test.salesforce.com/",                     // TD-176
  "https://cs42.salesforce.com/",
  "https://acme.lightning.force.com/one/one.app",
];
const NOT_SALESFORCE = ["https://example.com/", "https://evil.sandbox.example.com/", "not a url"];

afterEach(() => {
  delete process.env.SALESFORCE_ALLOW_ALL_ORGS;
  vi.restoreAllMocks();
});

describe("flag off — the D-64 guard, unchanged", () => {
  it("scratch and sandbox pass; every other Salesforce org and every non-Salesforce host is refused", () => {
    expect(orgRefusal(SCRATCH)).toBeNull();
    expect(orgRefusal(SANDBOX)).toBeNull();
    for (const u of [...OTHER_SALESFORCE, ...NOT_SALESFORCE]) expect(orgRefusal(u)).not.toBeNull();
    expect(() => assertTestOrg("https://acme.my.salesforce.com/")).toThrow(/only runs against Salesforce scratch orgs and sandboxes/);
  });

  it('"false" and unset behave the same', () => {
    process.env.SALESFORCE_ALLOW_ALL_ORGS = "false";
    for (const u of OTHER_SALESFORCE) expect(orgRefusal(u)).not.toBeNull();
  });
});

describe("flag on", () => {
  it("every Salesforce org passes, production included", () => {
    process.env.SALESFORCE_ALLOW_ALL_ORGS = "true";
    for (const u of [SCRATCH, SANDBOX, ...OTHER_SALESFORCE]) expect(orgRefusal(u)).toBeNull();
  });

  it("a host Salesforce does not serve is still refused", () => {
    process.env.SALESFORCE_ALLOW_ALL_ORGS = "true";
    for (const u of NOT_SALESFORCE) expect(orgRefusal(u)).not.toBeNull();
  });

  it("a production org is let through with a warning that names it", () => {
    process.env.SALESFORCE_ALLOW_ALL_ORGS = "true";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => assertTestOrg("https://acme.my.salesforce.com/")).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0][0])).toMatch(/acme\.my\.salesforce\.com is a PRODUCTION Salesforce org/);
  });

  it("a scratch org or sandbox gets no warning", () => {
    process.env.SALESFORCE_ALLOW_ALL_ORGS = "true";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    assertTestOrg(SCRATCH);
    assertTestOrg(SANDBOX);
    expect(warn).not.toHaveBeenCalled();
  });

  it("classifyOrg itself is unchanged by the flag", () => {
    process.env.SALESFORCE_ALLOW_ALL_ORGS = "true";
    expect(classifyOrg("https://acme.my.salesforce.com/")).toBe("production");
    expect(classifyOrg("https://test.salesforce.com/")).toBe("unknown");
  });
});

describe("orgWarning — the sentence the screen and the report show (D-68)", () => {
  it("production and other non-test Salesforce orgs get a warning; scratch, sandbox and non-Salesforce do not", async () => {
    const { orgWarning } = await import("../src/stages/salesforceOrgLogin.js");
    expect(orgWarning("https://acme.my.salesforce.com/")).toEqual({
      kind: "production", host: "acme.my.salesforce.com",
      message: "acme.my.salesforce.com is a PRODUCTION Salesforce org. Generated tests may create or change real records there.",
    });
    expect(orgWarning("https://test.salesforce.com/")?.kind).toBe("other");
    expect(orgWarning(SCRATCH)).toBeNull();
    expect(orgWarning(SANDBOX)).toBeNull();
    for (const u of NOT_SALESFORCE) expect(orgWarning(u)).toBeNull();
  });
});

describe("the HTML report", () => {
  const base = { runId: "r1", baseUrl: "https://acme.my.salesforce.com", cases: [] as any[] };

  it("shows the warning box under the header when given one", async () => {
    const { buildRunReportHtml } = await import("../src/stages/htmlReport.js");
    const html = buildRunReportHtml({ ...base, orgWarning: "acme.my.salesforce.com is a PRODUCTION Salesforce org." });
    expect(html).toContain('<div class="failbox"><h3>Not a test org</h3>acme.my.salesforce.com is a PRODUCTION Salesforce org.</div>');
    expect(html.indexOf("Not a test org")).toBeGreaterThan(html.indexOf("</header>"));
  });

  it("without one, the report is exactly what it was", async () => {
    const { buildRunReportHtml } = await import("../src/stages/htmlReport.js");
    const html = buildRunReportHtml(base);
    expect(html).not.toContain("Not a test org");
    expect(html).toContain("</header>\n  <section");
  });
});

describe("the run screen (public/app.js summarize)", () => {
  it("prefixes the discovery line with the warning, and is unchanged without it", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("public/app.js", "utf8");
    const start = src.indexOf("function summarize(stage, data) {");
    let depth = 0, end = start;
    for (let i = src.indexOf("{", start); i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) { end = i + 1; break; }
    }
    // eslint-disable-next-line no-new-func
    const summarize = new Function(`${src.slice(start, end)}\nreturn summarize;`)();
    const pages = [{ url: "u", concepts: ["Home"] }];
    expect(summarize("discovery", { pages })).toBe("Discovered 1 page — Home");
    expect(summarize("discovery", { pages, orgWarning: { message: "acme is a PRODUCTION Salesforce org." } }))
      .toBe("⚠ acme is a PRODUCTION Salesforce org. Discovered 1 page — Home");
  });
});
