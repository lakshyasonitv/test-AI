import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Saving a case must require a suite.
 *
 * WHY. A case with no suite is **unreachable through the UI**. The sidebar tree renders suites,
 * then "+ New suite", then *runs* — saved cases are only ever opened from inside a suite. The one
 * link to a suite-less case is the transient "Saved. Open the case" line in the save panel, which
 * disappears with the panel. Measured before this gate existed: **10 of 26 saved cases (38%) were
 * already stranded**, across three projects.
 *
 * SCOPE, and its limit. This is a SOURCE-level assertion over `public/app.js` — the same
 * extract-and-read technique as `tests/appJsProjectDelete.test.ts` and
 * `tests/appJsNewRunBtn.test.ts`, because app.js is a classic script with no module surface. It
 * catches the no-suite option being reintroduced and the confirm button losing its initial
 * `disabled`. It does **not** prove the wiring works in a browser — two source-level tests in this
 * repo have already produced a false green. The negative control was run for both assertions, and
 * the flow was exercised by hand.
 */

const APP = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

/** The `openSaveCasePanel` body, so these assertions cannot be satisfied by some other panel. */
function saveCasePanelSource(): string {
  const start = APP.indexOf("async function openSaveCasePanel(");
  if (start < 0) throw new Error("openSaveCasePanel not found in public/app.js");
  const body = APP.slice(start);
  let depth = 0;
  for (let i = body.indexOf("{"); i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") { depth--; if (depth === 0) return body.slice(0, i + 1); }
  }
  throw new Error("could not find the end of openSaveCasePanel");
}

const PANEL = saveCasePanelSource();

describe("save-case panel — a suite is required", () => {
  it("offers no way to save with no suite", () => {
    // The exact option that stranded 10 cases. Any option whose label reads as "no suite" is the
    // regression, whatever it is spelled.
    expect(PANEL).not.toContain("— none —");
    expect(PANEL.toLowerCase()).not.toMatch(/>\s*(—|-)?\s*none\s*(—|-)?\s*</);
  });

  it("starts with the confirm button disabled", () => {
    // Nothing is selected when the panel opens, so saving must not be reachable on first paint.
    expect(PANEL).toMatch(/data-role="confirm"[^>]*\bdisabled\b/);
  });

  it("re-enables only for a real suite id", () => {
    // The gate itself: empty placeholder and the "+ New suite" sentinel both keep Save disabled.
    expect(PANEL).toContain('confirmBtn.disabled = !suiteSel.value || suiteSel.value === "__new"');
  });

  it("offers inline suite creation, so the gate is not a dead end", () => {
    // Without this the gate would just move the problem: a project with no suites would have no
    // way forward from the panel at all.
    expect(PANEL).toContain('<option value="__new">+ New suite</option>');
    expect(PANEL).toContain('api("/api/suites"');
  });

  it("keeps the placeholder and '+ New suite' visible when the project filter runs", () => {
    // syncSuites() hides options whose data-project does not match. Neither of these carries one,
    // so without the guard the new-suite option would vanish the moment a project was picked.
    expect(PANEL).toContain('if (!o.value || o.value === "__new") return;');
  });
});
