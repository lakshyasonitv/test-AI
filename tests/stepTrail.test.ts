import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * D-81: a result card lists every step of the case in plain English, green up to where the run
 * got and red from the step it failed on (that step, then every step after it as "Not reached").
 * The colours come from Playwright's own report, matched to the IR by position: generateSpec
 * emits exactly one test.step() per IR step, in order. Checked live on run
 * 2026-11-13T10-40-05-865Z-3cb6d6f7 (Salesforce, 5 cases): 2 failed at steps 12 and 11, 1 cut
 * short after 8 steps, 2 passed.
 */

// Normalised to LF: a Windows checkout has CRLF line endings, CI does not (TD-170).
const APP = readFileSync("public/app.js", "utf8").replace(/\r\n/g, "\n");

function fnSource(decl: string): string {
  const s = APP.indexOf(decl);
  if (s < 0) return "";
  const e = APP.indexOf("\n}\n", s);
  return e < 0 ? "" : APP.slice(s, e + 2);
}

const REPORT = fnSource("function reportStepsOf(");
const OUTCOMES = fnSource("function stepOutcomes(");
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const { reportStepsOf, stepOutcomes } = new Function(`${REPORT}\n${OUTCOMES}\nreturn { reportStepsOf, stepOutcomes };`)();

const ir = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `s${i + 1}`, action: "click" }));
const report = (title: string, steps: Array<{ title: string; error?: unknown }>) =>
  ({ suites: [{ suites: [], specs: [{ title, tests: [{ results: [{ steps }] }] }] }] });

describe("step trail", () => {
  it("is found and only drawn with the new layout", () => {
    expect(REPORT).toContain("results.length - 1");
    expect(OUTCOMES).toContain('"skipped"');
    const load = fnSource("async function loadCaseDetails(");
    expect(load).toMatch(/if \(dashboardOn\) \{[\s\S]*renderStepTrail\(/);
  });

  it("failed case: green before the failing step, red on it and after it", () => {
    const raw = report("Lead", [{ title: "a" }, { title: "b" }, { title: "c", error: { message: "boom" } }]);
    expect(stepOutcomes(ir(5), reportStepsOf(raw, "Lead"), {}, "failed"))
      .toEqual(["ok", "ok", "failed", "skipped", "skipped"]);
  });

  it("passed case: every step green", () => {
    const raw = report("Acc", [{ title: "a" }, { title: "b" }, { title: "c" }]);
    expect(stepOutcomes(ir(3), reportStepsOf(raw, "Acc"), {}, "passed")).toEqual(["ok", "ok", "ok"]);
  });

  it("a timeout between steps (no step error) stops at the next step", () => {
    const raw = report("T", [{ title: "a" }, { title: "b" }]);
    expect(stepOutcomes(ir(4), reportStepsOf(raw, "T"), {}, "failed")).toEqual(["ok", "ok", "failed", "skipped"]);
  });

  it("no report: falls back to the summary's failedStep (1-based)", () => {
    expect(stepOutcomes(ir(4), null, { failedStep: 2 }, "failed")).toEqual(["ok", "failed", "skipped", "skipped"]);
    expect(stepOutcomes(ir(2), null, {}, "passed")).toEqual(["ok", "ok"]);
    expect(stepOutcomes(ir(2), null, {}, "failed")).toBeNull();
  });

  it("a report that is not the case's own is used only for the matching title", () => {
    const raw = report("Other case", [{ title: "a" }]);
    expect(reportStepsOf(raw, "This case", true)).toBeNull();
    expect(reportStepsOf(raw, "This case", false)).toHaveLength(1);
  });

  it("a retried test reports its last attempt", () => {
    const raw = { suites: [{ specs: [{ title: "R", tests: [{ results: [
      { steps: [{ title: "a", error: { message: "x" } }] },
      { steps: [{ title: "a" }, { title: "b" }] },
    ] }] }] }] };
    expect(stepOutcomes(ir(2), reportStepsOf(raw, "R"), {}, "passed")).toEqual(["ok", "ok"]);
  });
});
