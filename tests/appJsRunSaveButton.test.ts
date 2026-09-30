import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * A finished single (composer) run can be filed into the library from its own result screen.
 *
 * WHY. The only "Save case" affordance used to live on suite-result cards, so a run started from
 * the composer could never become a saved case — and a brand-new project with zero saved cases had
 * no way to seed its library at all (the Add-cases picker lists saved cases only).
 *
 * SCOPE, and its limit. SOURCE-level assertions over `public/app.js` and `public/index.html`,
 * same technique as `tests/appJsSaveNeedsSuite.test.ts` — app.js is a classic script with no
 * module surface. It catches the slot vanishing, the button leaking onto suite replays, and the
 * panel losing its suite-required gate. It does not prove the wiring works in a browser; that is
 * the manual check in the plan.
 */

const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const HTML = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

/** The `refreshRunSaveSlot` body, so these assertions cannot be satisfied by some other function. */
function runSaveSlotSource(): string {
  const start = APP.indexOf("function refreshRunSaveSlot()");
  if (start < 0) throw new Error("refreshRunSaveSlot not found in public/app.js");
  const body = APP.slice(start);
  let depth = 0;
  for (let i = body.indexOf("{"); i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") { depth--; if (depth === 0) return body.slice(0, i + 1); }
  }
  throw new Error("could not find the end of refreshRunSaveSlot");
}

const SLOT = runSaveSlotSource();

describe("single-run save-to-library", () => {
  it("the results screen has a slot for the affordance", () => {
    // The slot lives inside #finalResult (index.html), so it hides with the run results as a whole.
    expect(HTML).toMatch(/<div id="runSaveSlot" class="hidden"><\/div>/);
    expect(HTML.indexOf('id="runSaveSlot"')).toBeGreaterThan(HTML.indexOf('id="finalResult"'));
  });

  it("shows only for a genuinely finished, non-replay, non-suite run", () => {
    // currentRunFinished gates it (see the flag's comment), replays of already-saved cases get no
    // button, and a suite run is excluded because its cards already each carry "Save case".
    expect(SLOT).toContain("currentRunFinished && !currentRunIsReplay && !suiteShowing");
    expect(SLOT).toContain('const suiteShowing = !suiteResultsEl.classList.contains("hidden")');
  });

  it("never offers save on the run-error or could-not-start paths", () => {
    // currentRunFinished is set only for event.stage === "done", not "error" — a run can error
    // before any case artifact exists, and a save that would 500 is worse than no button.
    expect(APP).toContain('currentRunFinished = event.stage === "done";');
    expect(SLOT).toContain("currentRunFinished");
  });

  it("saves the run's single case directory (case-0) through the panel", () => {
    // The panel is the SAME one the suite cards use, handed this run's id and "case-0". If the
    // caseId constant drifts away from the run's one case directory, this catches it.
    expect(SLOT).toContain('caseId: "case-0"');
    expect(SLOT).toContain("openSaveCasePanel(runSaveSlotEl, {");
  });

  it("the panel still posts to the existing save route with a suite chosen", () => {
    // Guarding the refactor: openSaveCasePanel now takes {runId, caseId, title} from a source
    // argument instead of reading them off the card — but the POST and the suite-required gate
    // (Gap 2, left untouched) must be byte-identical.
    const start = APP.indexOf("async function openSaveCasePanel(");
    const panel = APP.slice(start, APP.indexOf("function refreshRunSaveSlot()"));
    expect(panel).toContain("const { runId, caseId, title } = source;");
    expect(panel).toContain(
      "`/api/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(caseId)}/save`",
    );
    expect(panel).toContain('confirmBtn.disabled = !suiteSel.value || suiteSel.value === "__new"');
  });

  it("suite-result cards hand their own ids into the new panel signature", () => {
    // The old implied source (card dataset) is now explicit — a regression here would silently
    // save the wrong run/case from the suite results screen.
    expect(APP).toContain("openSaveCasePanel(card, {");
    expect(APP).toContain("runId: suiteResultsEl.dataset.runId");
    expect(APP).toContain("caseId: card.dataset.caseId");
  });
});