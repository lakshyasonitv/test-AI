import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

/**
 * Salesforce org login hardening — the WIRING (tests 3, 6 and 10 of the brief).
 *
 * The browser is mocked at `chromium.launch`, so these prove what discovery does BEFORE and
 * AROUND a browser without needing one: a ticked run against a production org stops before any
 * browser exists, and an unticked run goes on to launch exactly as it always has.
 */

const { launchMock, planMock } = vi.hoisted(() => ({ launchMock: vi.fn(), planMock: vi.fn() }));
vi.mock("playwright", async (importOriginal) => {
  const actual = await importOriginal<typeof import("playwright")>();
  return { ...actual, chromium: { launch: launchMock } };
});
vi.mock("../src/stages/planner.js", () => ({ plan: planMock }));

const { discoverSiteHybrid, siteCacheKey } = await import("../src/stages/hybridDiscovery.js");
const { withTargetApp } = await import("../src/runTarget.js");
const { runPipeline } = await import("../src/orchestrator.js");

const PROD = "https://acme.my.salesforce.com";
const SANDBOX = "https://acme--uat.sandbox.my.salesforce.com";
const LAUNCHED = new Error("sentinel: a browser was launched");

afterEach(() => { launchMock.mockReset(); planMock.mockReset(); });

describe("the production guard actually stops a run (test 6)", () => {
  it("ticked + production org: discovery fails with the refusal, and no browser is ever launched", async () => {
    launchMock.mockRejectedValue(LAUNCHED);
    const err = await withTargetApp("salesforce", () => discoverSiteHybrid(PROD, undefined, async () => null)).catch((e) => e);
    expect(String(err?.message)).toMatch(/^Testbench only runs against Salesforce scratch orgs and sandboxes\. acme\.my\.salesforce\.com/);
    expect(launchMock).not.toHaveBeenCalled();
  });

  it("through the real orchestrator: the run ends at discovery, failed, with the refusal as its reason", async () => {
    const runId = `test-run-sfguard-${Math.random().toString(16).slice(2, 8)}`;
    planMock.mockResolvedValue({ goal: "g", steps: ["convert a lead"], testTypeScope: ["functional"], coverage: "standard" });
    launchMock.mockRejectedValue(LAUNCHED);
    const events: any[] = [];
    vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await expect(runPipeline(
        { prompt: "convert a lead", url: PROD, options: { targetApp: "salesforce" } }, (e) => events.push(e), runId,
      )).rejects.toThrow(/doesn't look like either/);
      const failed = events.find((e) => e.stage === "discovery" && e.status === "failed");
      expect(failed?.error).toMatch(/acme\.my\.salesforce\.com doesn't look like either/);
      expect(launchMock).not.toHaveBeenCalled();
      expect(events.some((e) => e.stage === "testcases")).toBe(false);
    } finally {
      rmSync(path.join("runs", runId), { recursive: true, force: true });
      vi.restoreAllMocks();
    }
  });

  it("ticked + sandbox: the guard lets it through to the browser", async () => {
    launchMock.mockRejectedValue(LAUNCHED);
    const err = await withTargetApp("salesforce", () => discoverSiteHybrid(SANDBOX, undefined, async () => null)).catch((e) => e);
    expect(String(err?.message ?? err)).not.toMatch(/doesn't look like either/);
    expect(launchMock).toHaveBeenCalled();
  });
});

describe("unticked runs take today's path (test 3)", () => {
  it("unticked + the same production URL: no refusal — discovery goes on to launch a browser as before", async () => {
    launchMock.mockRejectedValue(LAUNCHED);
    const err = await withTargetApp(null, () => discoverSiteHybrid(PROD, undefined, async () => null)).catch((e) => e);
    expect(String(err?.message ?? err)).not.toMatch(/doesn't look like either/);
    expect(launchMock).toHaveBeenCalled();
  });

  it("every call into salesforceOrgLogin.ts from discovery sits behind salesforceRun()", () => {
    // Source-structure check, the repo's precedent for wiring (gateClosesGeneration.test.ts): the
    // behaviour of each function is pinned in real Chromium in salesforceOrgLogin.test.ts; what is
    // asserted HERE is that an unticked run cannot reach any of them.
    const src = readFileSync("src/stages/hybridDiscovery.ts", "utf8").split("\n");
    const calls = ["assertTestOrg(", "blockLoginAds(", "reachUsernameForm(", "waitForOneScreenPassword(", "describeLoginFailure("];
    let found = 0;
    src.forEach((line, i) => {
      if (/^\s*(\/\/|\*|import|salesforceRun,)/.test(line)) return;
      if (!calls.some((c) => line.includes(c))) return;
      found++;
      const window = src.slice(Math.max(0, i - 8), i + 1).join("\n");
      expect(window, `unguarded call at hybridDiscovery.ts:${i + 1}: ${line.trim()}`).toContain("salesforceRun()");
    });
    expect(found).toBeGreaterThanOrEqual(6);
  });
});

describe("cache keys keep ticked and unticked runs apart (test 10)", () => {
  it("the same URL keys differently with the Salesforce box ticked", () => {
    const unticked = withTargetApp(null, () => siteCacheKey(SANDBOX));
    const ticked = withTargetApp("salesforce", () => siteCacheKey(SANDBOX));
    expect(ticked).not.toBe(unticked);
  });
});
