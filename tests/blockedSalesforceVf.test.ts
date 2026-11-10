import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectBlocked } from "../src/stages/executor.js";
import { withTargetApp } from "../src/runTarget.js";
import { withFrontdoor } from "../src/stages/salesforceFrontdoor.js";

const session = { connectionId: "zq", instanceHost: "zqorg-dev-ed.scratch.my.salesforce.com" } as any;

// Run 2026-11-10T07-51-03-736Z-780d6aed: a screen flow ran to its end on the org's own Visualforce host
// and the passing test was reported "blocked: left the application for an external sign-in provider".
describe("detectBlocked on a Salesforce org-connection run", () => {
  // A ticked password run with the flags off stays exactly as before: tests/salesforceSameOrg.test.ts.
  const ended = (url: string) => {
    const dir = mkdtempSync(path.join(tmpdir(), "zq-blocked-"));
    writeFileSync(path.join(dir, "final-page.txt"), `${url}\nZq Contact was created.`);
    return dir;
  };
  const app = "https://zqorg-dev-ed.scratch.my.salesforce.com";

  it("the same org's Visualforce host is not leaving the application", () => {
    const dir = ended("https://zqorg-dev-ed--c.scratch.vf.force.com/flow/Zq_Screen");
    expect(withTargetApp("salesforce", () => withFrontdoor(session, () => detectBlocked(dir, app)))).toBeNull();
  });

  it("another org, or any other site, still is", () => {
    expect(withTargetApp("salesforce", () => withFrontdoor(session, () => detectBlocked(ended("https://otherorg-dev-ed--c.scratch.vf.force.com/flow/X"), app)))).not.toBeNull();
    expect(withTargetApp("salesforce", () => withFrontdoor(session, () => detectBlocked(ended("https://login.zq-idp.example/sso"), app)))).not.toBeNull();
  });

  it("an ordinary (non-Salesforce) run keeps the old host rule", () => {
    expect(withTargetApp(null, () => detectBlocked(ended("https://zqorg-dev-ed--c.scratch.vf.force.com/flow/Zq_Screen"), app))).not.toBeNull();
  });
});
