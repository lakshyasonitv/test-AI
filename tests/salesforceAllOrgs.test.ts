import { describe, it, expect, afterEach, vi } from "vitest";
import { orgRefusal, assertTestOrg, classifyOrg } from "../src/stages/salesforceOrgLogin.js";

/**
 * D-60 — SALESFORCE_ALLOW_ALL_ORGS. Off: the D-56 guard exactly (scratch + sandbox only). On: every
 * Salesforce host is accepted and a non-scratch/non-sandbox org is named in the server log; a host
 * Salesforce does not serve is still refused. Pure: no browser, no network.
 */

const SCRATCH = "https://ruby-data-2200-dev-ed.scratch.my.salesforce.com/";
const SANDBOX = "https://acme--uat.sandbox.my.salesforce.com/";
const OTHER_SALESFORCE = [
  "https://acme.my.salesforce.com/",                  // production My Domain
  "https://acme-dev-ed.develop.my.salesforce.com/",   // Developer Edition
  "https://login.salesforce.com/",
  "https://test.salesforce.com/",                     // TD-159
  "https://cs42.salesforce.com/",
  "https://acme.lightning.force.com/one/one.app",
];
const NOT_SALESFORCE = ["https://example.com/", "https://evil.sandbox.example.com/", "not a url"];

afterEach(() => {
  delete process.env.SALESFORCE_ALLOW_ALL_ORGS;
  vi.restoreAllMocks();
});

describe("flag off — the D-56 guard, unchanged", () => {
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
    expect(String(warn.mock.calls[0][0])).toMatch(/acme\.my\.salesforce\.com is a PRODUCTION org/);
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
