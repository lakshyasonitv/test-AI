import { describe, it, expect } from "vitest";
import { recordedFailingStepId, diagnosisBlamesWrongStep } from "../src/stages/failureAnalysis.js";
import type { IR } from "../src/schema/ir.js";
import type { ExecResult } from "../src/stages/executor.js";

/**
 * A diagnosis must be about the step that actually failed.
 *
 * WHAT WAS WRONG. `analyzeFailure` sent `ir.steps.slice(-5)` — the last five steps regardless of
 * where the failure was — and nothing told the model which of them Playwright had recorded as
 * failing. On a long case the failing step could fall outside that window entirely; inside it, the
 * model was picking among five. Naming the wrong step makes the explanation and the suggested fix
 * wrong with it, and `verifyDiagnosisText` never checked this — it only annotates a quoted string
 * that happens to appear in the accessibility snapshot.
 *
 * The report already knows the answer: `extractFailureDetail` reads the position of the first step
 * carrying an error, and `generateSpec` emits exactly one `test.step()` per IR step in order.
 * Structural ground truth, not inference — unlike `findFailingStepId`, which regexes error prose.
 */

const ir = (): IR => ({
  meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://x.example" },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Email" }, value: "a@b.c" },
    { id: "s3", action: "click", target: { role: "button", name: "Sign In" } },
    { id: "s4", action: "assert", target: { role: "heading", name: "Dashboard" }, assertion: "visible" },
  ],
} as unknown as IR);

/** A Playwright report whose Nth step (1-based) carries the error. */
const resultFailingAt = (n: number): ExecResult => ({
  raw: {
    suites: [{
      specs: [{
        ok: false,
        tests: [{ results: [{ status: "failed", errors: [{ message: "boom" }],
          steps: Array.from({ length: 4 }, (_, i) => ({
            title: `step ${i + 1}`, ...(i === n - 1 ? { error: { message: "boom" } } : {}),
          })) }] }],
      }],
    }],
  },
} as unknown as ExecResult);

const diag = (over: Record<string, unknown> = {}) => ({
  failingStepId: "s3", category: "element_not_found" as const,
  explanation: "The button was not found.", suggestedFix: "Check the selector.",
  ...over,
}) as any;

describe("recordedFailingStepId", () => {
  it("maps the report's step position onto the IR step id", () => {
    expect(recordedFailingStepId(ir(), resultFailingAt(3))).toBe("s3");
    expect(recordedFailingStepId(ir(), resultFailingAt(1))).toBe("s1");
    expect(recordedFailingStepId(ir(), resultFailingAt(4))).toBe("s4");
  });

  it("returns undefined when the report records no step-level error", () => {
    // An older report, or a crash before any step ran. There is then no ground truth, and the
    // caller must not reject anything on the strength of it.
    expect(recordedFailingStepId(ir(), { raw: null } as unknown as ExecResult)).toBeUndefined();
    expect(recordedFailingStepId(ir(), { raw: { suites: [] } } as unknown as ExecResult)).toBeUndefined();
  });
});

describe("diagnosisBlamesWrongStep", () => {
  it("accepts a diagnosis that names the recorded step", () => {
    expect(diagnosisBlamesWrongStep(diag(), ir(), "s3")).toBeUndefined();
  });

  it("rejects one that names a different step", () => {
    expect(diagnosisBlamesWrongStep(diag({ failingStepId: "s2" }), ir(), "s3"))
      .toMatch(/names step s2, but s3 is the step that failed/);
  });

  it("rejects one that blames another step's ELEMENT while citing the right step", () => {
    // The subtle case: correct step id, but the sentence is about the Email box from s2.
    const d = diag({ explanation: 'The "Email" field was empty, so submission failed.' });
    expect(diagnosisBlamesWrongStep(d, ir(), "s3")).toMatch(/belongs to step s2, not to s3/);
  });

  it("leaves ordinary prose alone, including quotes of the failing step's own element", () => {
    expect(diagnosisBlamesWrongStep(
      diag({ suggestedFix: 'Wait for "Sign In" to become enabled.' }), ir(), "s3",
    )).toBeUndefined();
    // A quote that matches no step's target at all is page text, not a misattribution.
    expect(diagnosisBlamesWrongStep(
      diag({ explanation: 'The page showed "Service temporarily unavailable".' }), ir(), "s3",
    )).toBeUndefined();
  });

  it("rejects NOTHING when there is no recorded step", () => {
    // The guard must be inert without ground truth — otherwise it would start failing diagnoses
    // on exactly the runs where the report is already degraded.
    expect(diagnosisBlamesWrongStep(diag({ failingStepId: "s1" }), ir(), undefined)).toBeUndefined();
    const d = diag({ explanation: 'The "Email" field was empty.' });
    expect(diagnosisBlamesWrongStep(d, ir(), undefined)).toBeUndefined();
  });

  it("tolerates a null failingStepId rather than treating it as a wrong answer", () => {
    // The schema allows null. Absent is not the same as wrong; the element check still applies.
    expect(diagnosisBlamesWrongStep(diag({ failingStepId: null }), ir(), "s3")).toBeUndefined();
  });
});

describe("analyzeFailure names the recorded step on the deterministic path", () => {
  // Run 2026-10-24T14-09-38-782Z-a7582b51 case-2: a CSS locator timed out, so the error text had no
  // getByRole/getByText for findFailingStepId to read, the diagnosis said failingStepId null, and
  // self-heal could never run. Playwright's report knew the step all along.
  it("uses Playwright's recorded failing step when the error text names no role or text", async () => {
    const { analyzeFailure } = await import("../src/stages/failureAnalysis.js");
    const message = "TimeoutError: locator.fill: Timeout 10000ms exceeded.\nCall log:\n  - waiting for locator('role=dialog').locator('input[name=\"Zq_Field\"]').first()";
    const result = resultFailingAt(2);
    (result.raw as any).suites[0].specs[0].tests[0].results[0].errors = [{ message }];
    const d = await analyzeFailure(ir(), { ...result, artifactsDir: "nowhere" } as ExecResult);
    expect(d.category).toBe("timeout");
    expect(d.failingStepId).toBe("s2");
  });
});
