import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

/**
 * D-62 — Salesforce host names read as (My Domain name, partition, purpose), from Salesforce's own
 * "Partitioned Domains for Scratch Orgs" / "My Domain URL Format Changes" tables, and the user's real
 * login chain (2026-10-22 capture): my.salesforce.com -> file.force.com -> lightning.force.com.
 */

const { parseSalesforceHost, sameSalesforceApp, orgRefusal, assertTestOrg, OrgRefusedError } =
  await import("../src/stages/salesforceOrgLogin.js");
const { detectBlocked } = await import("../src/stages/executor.js");
const { withTargetApp } = await import("../src/runTarget.js");

const ORG = "ruby-data-2200-dev-ed";
const LOGIN = `https://${ORG}.scratch.my.salesforce.com/`;

afterEach(() => { delete process.env.SALESFORCE_FIXED_LOGIN; });

describe("parseSalesforceHost — the official formats", () => {
  it.each([
    [`${ORG}.scratch.my.salesforce.com`, ORG, "scratch", "login"],
    [`${ORG}.scratch.lightning.force.com`, ORG, "scratch", "lightning"],
    [`${ORG}.scratch.my.salesforce-setup.com`, ORG, "scratch", "setup"],
    [`${ORG}.scratch.file.force.com`, ORG, "scratch", "files"],
    [`${ORG}--c.scratch.vf.force.com`, ORG, "scratch", "visualforce"],
    [`${ORG}.scratch.my.site.com`, ORG, "scratch", "portal"],
    ["acme--uat.sandbox.my.salesforce.com", "acme--uat", "sandbox", "login"],
    ["acme--uat.sandbox.lightning.force.com", "acme--uat", "sandbox", "lightning"],
    ["acme--uat--mypkg.sandbox.vf.force.com", "acme--uat", "sandbox", "visualforce"],
    ["acme.my.salesforce.com", "acme", "", "login"],
    ["acme.lightning.force.com", "acme", "", "lightning"],
    ["acme.my.salesforce-sites.com", "acme", "", "sites"],
    ["acme-dev-ed.develop.my.salesforce.com", "acme-dev-ed", "develop", "login"],
  ])("%s", (host, myDomain, partition, purpose) => {
    expect(parseSalesforceHost(host)).toEqual({ myDomain, partition, purpose });
  });

  it("shared Salesforce hosts and other sites are not org hosts", () => {
    for (const h of ["b.static.lightning.force.com", "a.sfdcstatic.com", "c.salesforce.com",
      "test.salesforce.com", "login.salesforce.com", "example.com", "evil.scratch.my.site.com.example.com"]) {
      expect(parseSalesforceHost(h)).toBeNull();
    }
  });

  it("accepts a full URL too", () => {
    expect(parseSalesforceHost(`https://${ORG}.scratch.lightning.force.com/lightning/page/home`)?.purpose).toBe("lightning");
  });
});

describe("sameSalesforceApp", () => {
  it("every host of the real login chain is the same app", () => {
    for (const u of [`https://${ORG}.scratch.file.force.com/secur/contentDoor`,
      `https://${ORG}.scratch.lightning.force.com/one/one.app`,
      `https://${ORG}.scratch.lightning.force.com/lightning/page/home`,
      `https://${ORG}.scratch.my.salesforce-setup.com/lightning/setup/OrgDomain/home`]) {
      expect(sameSalesforceApp(u, LOGIN)).toBe(true);
    }
  });

  it("another org, another partition, a portal, a shared host or any other site is not", () => {
    expect(sameSalesforceApp("https://other-org.scratch.lightning.force.com/", LOGIN)).toBe(false);
    expect(sameSalesforceApp(`https://${ORG}.sandbox.lightning.force.com/`, LOGIN)).toBe(false);
    expect(sameSalesforceApp(`https://${ORG}.scratch.my.site.com/`, LOGIN)).toBe(false);
    expect(sameSalesforceApp("https://b.static.lightning.force.com/x", LOGIN)).toBe(false);
    expect(sameSalesforceApp("https://login.okta.com/", LOGIN)).toBe(false);
  });
});

describe("detectBlocked on a Salesforce run", () => {
  const ended = (url: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "blocked-"));
    writeFileSync(path.join(dir, "final-page.txt"), `${url}\nSeller Home`);
    return dir;
  };
  const lightning = `https://${ORG}.scratch.lightning.force.com/lightning/page/home`;

  it("ticked + SALESFORCE_FIXED_LOGIN: landing on the same org's Lightning host is NOT blocked", () => {
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    const dir = ended(lightning);
    expect(withTargetApp("salesforce", () => detectBlocked(dir, new URL(LOGIN).origin))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaving for a company sign-in page is still blocked", () => {
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    const dir = ended("https://login.okta.com/app/x");
    expect(withTargetApp("salesforce", () => detectBlocked(dir, new URL(LOGIN).origin))?.reason).toMatch(/login\.okta\.com/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("flag off, or an unticked run: exactly as before (blocked)", () => {
    const dir = ended(lightning);
    expect(withTargetApp("salesforce", () => detectBlocked(dir, new URL(LOGIN).origin))).not.toBeNull();
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    expect(withTargetApp(null, () => detectBlocked(dir, new URL(LOGIN).origin))).not.toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("portal addresses and the refusal (D-62)", () => {
  it("a portal address is refused with a sentence saying what it is and what to use", () => {
    const why = orgRefusal(`https://${ORG}.scratch.my.site.com/`);
    expect(why).toContain("Experience Cloud portal");
    expect(why).toContain(`https://${ORG}.scratch.my.salesforce.com/`);
    expect(why).not.toContain("doesn't look like");
  });

  it("a refusal is thrown as OrgRefusedError, marked orgRefused", () => {
    let err: any;
    try { assertTestOrg(`https://${ORG}.scratch.my.site.com/`); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(OrgRefusedError);
    expect(err.orgRefused).toBe(true);
  });

  it("the screen drops 'a problem on our side' only for a refusal", () => {
    const src = readFileSync("public/app.js", "utf8");
    const start = src.indexOf("function verdictFor(data, stage, error) {");
    let depth = 0, end = start;
    for (let i = src.indexOf("{", start); i < src.length; i++) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}" && --depth === 0) { end = i + 1; break; }
    }
    // eslint-disable-next-line no-new-func
    const verdictFor = new Function(`${src.slice(start, end)}\nreturn verdictFor;`)();
    expect(verdictFor({ orgRefused: true }, "error", "Refused because X.").detail).toBe("Refused because X.");
    expect(verdictFor({}, "error", "Boom.").detail).toBe("Boom. This is a problem on our side, not a result about your site.");
  });
});

describe("onlyChecksLogin — the user's real IRs from run 2026-10-22T09-44-02-812Z", () => {
  const LOGIN_STEPS = [
    { id: "auth-0", action: "navigate", target: { url: LOGIN } },
    { id: "auth-1", action: "fill", target: { css: "#username" }, value: "${env:TEST_USERNAME}" },
    { id: "auth-2", action: "click", target: { css: "#Login" } },
    { id: "auth-3", action: "assert", target: { css: "#password" }, assertion: "visible" },
    { id: "auth-4", action: "fill", target: { css: "#password" }, value: "${env:TEST_PASSWORD}" },
    { id: "auth-5", action: "click", target: { css: "#Login" } },
    { id: "auth-6", action: "assert", target: { css: "#password" }, assertion: "hidden" },
  ];
  const meta = { feature: "Login", title: "t", priority: "high", sourcePrompt: "p", baseUrl: LOGIN, fixedLogin: "salesforce" };
  const homepage: any = { meta, steps: [...LOGIN_STEPS,
    { id: "s4", action: "wait", value: "500" },
    { id: "s5", action: "assert", target: { role: "button", name: "Log In to Sandbox", css: "#Login" }, assertion: "hidden" }] };
  const search: any = { meta: { ...meta, truncated: true }, steps: [...LOGIN_STEPS,
    { id: "s1", action: "navigate", target: { url: "/" } }, { id: "s2", action: "wait", value: "500" }] };
  const real: any = { meta, steps: [...LOGIN_STEPS,
    { id: "s1", action: "assert", target: { role: "heading", name: "Seller Home", css: "h1.title" }, assertion: "visible" }] };

  it("the homepage case (only 'Log In hidden') and the cut-short search case are login-only", async () => {
    const { onlyChecksLogin } = await import("../src/stages/salesforceOrgLogin.js");
    expect(onlyChecksLogin(homepage)).toBe(true);
    expect(onlyChecksLogin(search)).toBe(true);
  });

  it("a case with a real check after login is not; a non-fixed-login IR is never", async () => {
    const { onlyChecksLogin } = await import("../src/stages/salesforceOrgLogin.js");
    expect(onlyChecksLogin(real)).toBe(false);
    expect(onlyChecksLogin({ ...homepage, meta: { ...meta, fixedLogin: undefined } })).toBe(false);
    expect(onlyChecksLogin(null)).toBe(false);
  });

  it("the report shows the note for the login-only case and not for the real one", async () => {
    const { buildRunReportHtml } = await import("../src/stages/htmlReport.js");
    const note = "Only checked that login works";
    const html = (ir: any) => buildRunReportHtml({ runId: "r", cases: [{ caseId: "c", title: "t", status: "passed", saved: {}, ir }] });
    expect(html(homepage)).toContain(note);
    expect(html(real)).not.toContain(note);
    expect(html({ ...homepage, meta: { ...meta, fixedLogin: undefined } })).not.toContain(note);
  });
});
