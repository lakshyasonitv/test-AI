import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { stepRunningAtKill } from "../src/stages/executor.js";
import { analyzeFailure, recordedFailingStepId } from "../src/stages/failureAnalysis.js";

/**
 * A run the safety timer killed has no report. Run 2026-11-03T05-07-28-369Z-388aa153 was then
 * diagnosed as failing at Save (a guess) while its screenshots showed it had stopped at Billing Zip.
 * The step it was on is read from the step-N.png files that attempt wrote.
 */
let dir = "";
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "killed-")).replace(/\\/g, "/"); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const spec = (d: string) => [
  `await test.step("Fill 'Zq Name'", async () => { await shot(page, "${d}/step-1.png"); });`,
  `await test.step("Fill 'Zq City'", async () => { await shot(page, "${d}/step-2.png"); });`,
  `await test.step("Fill 'Zq Zip'", async () => { await shot(page, "${d}/step-3.png"); });`,
  `await test.step("Click 'Save'", async () => { await shot(page, "${d}/step-4.png"); });`,
].join("\n");

describe("the step a killed run was on", () => {
  it("is one past the last step screenshot this attempt wrote", () => {
    const since = Date.now() - 1000;
    writeFileSync(path.join(dir, "step-1.png"), "x");
    writeFileSync(path.join(dir, "step-2.png"), "x");
    expect(stepRunningAtKill(spec(dir), since)).toEqual({ step: 3, title: "Fill 'Zq Zip'" });
  });

  it("ignores screenshots left by an earlier attempt", () => {
    const since = Date.now();
    writeFileSync(path.join(dir, "step-4.png"), "x");
    const old = (since - 60_000) / 1000;
    utimesSync(path.join(dir, "step-4.png"), old, old);
    writeFileSync(path.join(dir, "step-1.png"), "x");
    expect(stepRunningAtKill(spec(dir), since - 10)?.step).toBe(2);
  });

  it("feeds the failure analysis: the recorded step, a timeout, no guess", async () => {
    const ir = { meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
      steps: [{ id: "s1" }, { id: "s2" }, { id: "s3" }, { id: "s4" }] } as any;
    const result = { passed: false, exitCode: 1, raw: null, artifactsDir: dir, resultsJsonPath: "", killed: true, killedAtStep: 3, killedAtTitle: "Fill 'Zq Zip'" } as any;
    expect(recordedFailingStepId(ir, result)).toBe("s3");
    const d = await analyzeFailure(ir, result);
    expect(d.failingStepId).toBe("s3");
    expect(d.category).toBe("timeout");
    expect(d.explanation).toContain("Fill 'Zq Zip'");
  });
});
