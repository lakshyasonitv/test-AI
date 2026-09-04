import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * `public/app.js` must not call a function it does not have.
 *
 * This exists because of a real, shipped bug. Adding the gate's case editor replaced a ~200-line
 * region of app.js wholesale, and the replacement silently dropped `postCaseSelectionDecision` —
 * the single function through which every case-selection decision leaves the browser. Its two
 * call sites survived, pointing at nothing.
 *
 * Nothing caught it. `node --check` validates syntax, not references. `tsc` never looks at app.js.
 * The suite does not execute app.js's click handlers. And the manual browser check called the
 * panel's helpers directly instead of pressing the button, so the panel rendered perfectly while
 * the one unexercised path failed: click "Run selected tests" -> ReferenceError -> the decision is
 * never sent -> the gate waits out its full CASE_SELECTION_WAIT_MS -> the run finishes having
 * executed no tests. The symptom looked like "test cases aren't generating"; generation was fine.
 *
 * WHY THIS SHAPE. app.js is a classic script with no module surface, so it cannot be imported and
 * checked at runtime, and this repo has no JS parser available to build a real scope analysis on.
 * Two cruder approaches were tried and rejected rather than shipped:
 *   - regex-stripping literals, which broke on NESTED template literals and reported the word
 *     "call" (from the string "AI call(s)") as a missing function;
 *   - a hand-rolled state-machine tokenizer, which lost 108KB of a 228KB file to regex literals
 *     and apostrophes inside comments, hiding real definitions.
 * Both are the failure this project already documents: a check that looks like it verifies
 * something while actually measuring its own bug. So this checks `await NAME(` instead — an
 * unambiguous shape that cannot appear in prose, verified to flag nothing across all 70 such call
 * sites in the current file, and precisely where the real bug bit.
 */

const APP = readFileSync("public/app.js", "utf8");
// index.html loads icons.js and preview.js as classic scripts alongside app.js, so whatever they
// define is a legitimate global for app.js to call — `icon()` is the live example.
const SIBLINGS = ["public/icons.js", "public/preview.js"]
  .map((p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } })
  .join("\n");

const AWAIT_CALL = /(?<![.\w$])await\s+([A-Za-z_$][\w$]*)\s*\(/g;

/**
 * Names bound anywhere across the three scripts. Collected from the RAW source on purpose: over-
 * collecting can only make this check quieter, never noisier, and a false alarm in a guard test is
 * far more corrosive than a missed edge case.
 */
function definedNames(src: string): Set<string> {
  const out = new Set<string>();
  const patterns = [
    /(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    /([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?(?:function|\()/g,
    /class\s+([A-Za-z_$][\w$]*)/g,
  ];
  for (const re of patterns) for (const m of src.matchAll(re)) out.add(m[1]);
  return out;
}

/** Awaitable globals, which are legitimately called without being declared anywhere. */
const GLOBALS = new Set(["fetch", "Promise", "Response", "Request", "JSON", "import", "structuredClone"]);

describe("public/app.js — every function it awaits actually exists", () => {
  it("has a definition for every awaited call", () => {
    const defined = definedNames(APP + "\n" + SIBLINGS);
    const sites = [...APP.matchAll(AWAIT_CALL)].map((m) => m[1]);
    expect(sites.length).toBeGreaterThan(50);   // guards against the regex silently matching nothing

    const missing = [...new Set(sites)].filter((n) => !defined.has(n) && !GLOBALS.has(n)).sort();
    expect(
      missing,
      `app.js awaits these but never defines them — a deleted definition with live call sites:\n  ${missing.join("\n  ")}`
    ).toEqual([]);
  });

  /**
   * The specific regression, named, so a future reader meets it by name instead of inferring it
   * from a diff. The general check above would catch it too; this says what it was.
   */
  it("still defines postCaseSelectionDecision, the only way a gate decision leaves the browser", () => {
    expect(APP).toMatch(/async function postCaseSelectionDecision\s*\(/);
    // Defined once, and still wired to both buttons that can end a round.
    expect((APP.match(/postCaseSelectionDecision\s*\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
  });

  /**
   * The gate panel's own helpers. The editor is built from many small functions that only ever run
   * on a click, so a repeat of the same wholesale-replacement mistake would go unnoticed until a
   * person was sitting in front of a parked round.
   */
  it("defines every helper the gate panel depends on", () => {
    const required = [
      "renderCaseSelectionPanel", "repaintCaseList", "hideCaseSelectionPanel",
      "gateCases", "gateCardHtml", "gateStepRowsHtml", "gateProposalHtml",
      "gateEditFor", "gateStepsFor", "setGateSteps", "gateIsChecked", "setGateChecked",
      "gateEditPayload", "gateValidationError", "markGateEdited",
      "loadGateDrafts", "saveGateDrafts", "clearGateDrafts", "gateDraftKey", "emptyGateDrafts",
      "getCheckedCaseIndexes", "updateDoneButtonState", "postCaseSelectionDecision",
    ];
    const defined = definedNames(APP);
    const missing = required.filter((n) => !defined.has(n));
    expect(missing, `gate helpers referenced but not defined: ${missing.join(", ")}`).toEqual([]);
  });
});
