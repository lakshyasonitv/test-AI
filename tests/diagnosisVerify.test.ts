import { describe, it, expect } from "vitest";
import { verifyDiagnosisText } from "../src/stages/failureAnalysis.js";
import type { Diagnosis } from "../src/stages/failureAnalysis.js";
import type { ExecResult } from "../src/stages/executor.js";

// Real shape from case-3, runs/2026-08-15T17-57-40-434Z-0b385264/cases/case-3: the diagnosis
// (from the Gemini fallback path, not the deterministic classifier) states the REAL validation
// text as a quoted substring inside a narrative sentence — the sentence itself never appears
// verbatim in a captured snapshot, only the quoted part does.
const realDiagnosis: Diagnosis = {
  failingStepId: "s6",
  category: "assertion_failed",
  explanation: "The test expects the text 'Invalid email address' to appear after submitting the form with an invalid email, but the actual error message displayed on the page is 'Please enter a valid email address.'",
  suggestedFix: "Update the assertion to match the actual text displayed on the page: 'Please enter a valid email address'.",
};

const resultWithSnapshot = (snapshot: string | undefined): ExecResult =>
  ({ passed: false, exitCode: 1, resultsJsonPath: "r", artifactsDir: "a", raw: null, accessibilitySnapshot: snapshot });

describe("verifyDiagnosisText", () => {
  it("confirms a quoted candidate that actually appears in the accessibility snapshot", () => {
    const snapshot = `- generic [ref=e1]:\n  - text: "Please enter a valid email address."\n  - button "Submit"`;
    expect(verifyDiagnosisText(realDiagnosis, resultWithSnapshot(snapshot))).toBe("Please enter a valid email address");
  });

  it("returns undefined when the quoted candidate is not in the snapshot (a genuinely wrong guess)", () => {
    const snapshot = `- generic [ref=e1]:\n  - text: "Something completely different"\n  - button "Submit"`;
    expect(verifyDiagnosisText(realDiagnosis, resultWithSnapshot(snapshot))).toBeUndefined();
  });

  it("returns undefined when there's no snapshot to check against", () => {
    expect(verifyDiagnosisText(realDiagnosis, resultWithSnapshot(undefined))).toBeUndefined();
  });

  it("is case- and whitespace-insensitive (real snapshots wrap and re-case text)", () => {
    const snapshot = `- text: "please   enter a VALID\n  email address."`;
    expect(verifyDiagnosisText(realDiagnosis, resultWithSnapshot(snapshot))).toBe("Please enter a valid email address");
  });

  it("doesn't confirm a diagnosis with no quoted text at all", () => {
    const noQuotes: Diagnosis = {
      failingStepId: "s2", category: "timeout",
      explanation: "The page took too long to respond.",
      suggestedFix: "Increase the timeout or check the page for a slow network request.",
    };
    const snapshot = `- text: "Please enter a valid email address."`;
    expect(verifyDiagnosisText(noQuotes, resultWithSnapshot(snapshot))).toBeUndefined();
  });
});
