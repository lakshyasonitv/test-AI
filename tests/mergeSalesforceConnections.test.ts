import { describe, it, expect, afterEach } from "vitest";

/**
 * The 2026-10-28 merge of main into this branch: this branch's password-login Salesforce features
 * (D-64 test-org guard, D-65 fixed login) must step aside on main's org-connection runs (D-63,
 * frontdoor.jsp), which have their own guard and no password form.
 */

const { fixedLoginRun } = await import("../src/stages/salesforceOrgLogin.js");
const { discoverSiteHybrid, discoverPagesHybrid } = await import("../src/stages/hybridDiscovery.js");
const { withFrontdoor } = await import("../src/stages/salesforceFrontdoor.js");
const { withTargetApp } = await import("../src/runTarget.js");

const session = { connectionId: "c1", instanceHost: "acme-dev-ed.develop.my.salesforce.com", mint: async () => "x" };
const DEV_ED = "https://acme-dev-ed.develop.my.salesforce.com/";

afterEach(() => { delete process.env.SALESFORCE_FIXED_LOGIN; });

describe("fixed login (D-65) on an org-connection run", () => {
  it("is on for a ticked password run and off for a ticked connection run", () => {
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    expect(withTargetApp("salesforce", () => fixedLoginRun())).toBe(true);
    expect(withTargetApp("salesforce", () => withFrontdoor(session, () => fixedLoginRun()))).toBe(false);
  });
});

describe("test-org guard (D-64) on an org-connection run", () => {
  it("a password run on a Developer Edition org is still refused before any browser opens", async () => {
    await expect(withTargetApp("salesforce", () => discoverSiteHybrid(DEV_ED))).rejects.toThrow(/scratch orgs and sandboxes/);
    await expect(withTargetApp("salesforce", () => discoverPagesHybrid([DEV_ED]))).rejects.toThrow(/scratch orgs and sandboxes/);
  });

  it("a connection run is not refused by it (main's connection guard already decided)", async () => {
    // Past the guard, discovery goes on to the org; here it fails later for want of a real org,
    // with an error that is NOT the guard's refusal.
    const err = await withTargetApp("salesforce", () => withFrontdoor(session, () =>
      discoverPagesHybrid(["http://127.0.0.1/"]))).catch((e: Error) => e);
    expect(String(err?.message ?? "")).not.toMatch(/scratch orgs and sandboxes/);
  });
});
