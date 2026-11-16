import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * The case-review gate's "Generate another round" used to ask window.confirm() before sending.
 * Embedded browsers (the Claude desktop app's browser pane, some webviews) never show that dialog
 * and answer "Cancel" at once, so refine sent nothing and said nothing. It now confirms IN the
 * panel: the first press states the warning and arms "Yes, generate another round"; only that
 * second press posts `not_satisfied`. Checked live in the pane on 2026-11-13 (preview scene
 * caseSelection): no confirm() call, warning shown, Cancel / typing / ticking disarm, the second
 * press posts. These pin the shape so the dialog cannot creep back.
 */

// Normalised to LF: a Windows checkout has CRLF line endings, CI does not (TD-170).
const APP = readFileSync("public/app.js", "utf8").replace(/\r\n/g, "\n");

function fnSource(decl: string): string {
  const s = APP.indexOf(decl);
  if (s < 0) return "";
  const e = APP.indexOf("\n}\n", s);
  return e < 0 ? "" : APP.slice(s, e + 2);
}
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const SUBMIT = fnSource("async function submitRefine(");
const ARM = fnSource("function armRefine(");
const DISARM = fnSource("function disarmRefine(");

describe("refine confirms in the panel, not with window.confirm()", () => {
  it("is found (the guards below are not vacuous)", () => {
    expect(SUBMIT).toContain("postCaseSelectionDecision");
    expect(ARM).toContain("refineArmed = true");
    expect(DISARM).toContain("refineArmed = false");
    expect(APP).toContain("let refineArmed = false;");
  });

  it("never calls a browser dialog", () => {
    for (const src of [SUBMIT, ARM, DISARM]) {
      expect(stripComments(src)).not.toMatch(/\b(window\.)?(confirm|alert|prompt)\(/);
    }
  });

  it("the first press only arms; the post happens on the second", () => {
    const body = stripComments(SUBMIT);
    const arm = body.indexOf("if (!refineArmed) return armRefine(warning);");
    const post = body.indexOf("postCaseSelectionDecision(");
    expect(arm).toBeGreaterThan(0);
    expect(post).toBeGreaterThan(arm);
    // the empty-note and invalid-case checks still come first, before anything is armed
    expect(body.indexOf('showError("Describe what should change before refining.")')).toBeLessThan(arm);
    expect(body.indexOf("gateValidationError(selectedIndexes)")).toBeLessThan(arm);
    // the request itself is unchanged
    expect(body).toContain('action: "not_satisfied", selectedIndexes, newPrompt, ...gateEditPayload(),');
  });

  it("states the same warning, in the panel's own notice line", () => {
    expect(SUBMIT).toContain("will be recorded as rejected, and cannot be offered again in this run.");
    expect(ARM).toContain("showNotice(warning);");
    expect(ARM).toContain('"Yes, generate another round"');
  });

  it("anything that changes what the warning describes takes the Yes back", () => {
    expect(APP).toContain('caseNewPromptInputEl.addEventListener("input", disarmRefine);');
    expect(fnSource("function setRefineOpen(")).toContain("disarmRefine();");
    // ticking / unticking a case, Select all, Select none
    expect(APP).toMatch(/caseSelectionListEl\.addEventListener\("change", \(e\) => \{\n[^\n]*\n  disarmRefine\(\);/);
    expect(APP).toMatch(/caseSelectAllBtnEl\.addEventListener\("click", \(\) => \{\n  disarmRefine\(\);/);
    expect(APP).toMatch(/caseSelectNoneBtnEl\.addEventListener\("click", \(\) => \{\n  disarmRefine\(\);/);
  });

  it("adds no class and never toggles .hidden on its buttons (rules 3 and 4)", () => {
    for (const src of [ARM, DISARM]) {
      expect(src).not.toMatch(/classList\.(add|remove|toggle)\("hidden"\)[^;]*cancel|cancel[^;]*classList/);
    }
    expect(ARM).toContain('cancel.className = "case-refine-confirm";');
    expect(DISARM).toContain('getElementById("case-refine-cancel-btn")?.remove()');
    expect(readFileSync("public/style.css", "utf8")).toContain(".case-refine-confirm {");
  });
});
