import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractFailureDetail } from "../src/stages/executor.js";
import { buildSuiteSummary, type CaseRunResult } from "../src/stages/suiteRunner.js";

/**
 * A failed case must say WHY, with no model call — TECH_DEBT.md TD-80.
 *
 * THE DEFECT. A replay makes zero LLM calls by design, so `analyzeFailure` never runs and no
 * `06-diagnosis.json` is written. The UI rendered a reason only when a diagnosis existed, so a
 * failed replay showed a red X and no text whatsoever. The Playwright error was sitting in
 * `05-result.json` the whole time, unread.
 *
 * Run `2026-09-06T14-19-13-154Z-fed833e5` is the evidence, and the fixtures below are its actual
 * report shape: twelve steps, the twelfth carrying the error.
 */

/** The report shape Playwright's JSON reporter produces, trimmed to what is read. */
const rawWith = (steps: any[], errors: any[]) => ({
  suites: [{
    specs: [{
      title: "Admin creates a new user via management interface",
      ok: false,
      tests: [{ results: [{ status: "failed", steps, errors }] }],
    }],
  }],
  errors: [],
});

const STEPS = [
  { title: "Navigate to https://learnvibes.vercel.app/login" },
  { title: "Fill 'Full Name' with 'test lakshay'" },
  { title: "Select 'prashant mishra' in 'Manager'", error: { message: "boom" } },
];

// Exactly as it appears on disk, ANSI escapes included.
const REAL_ERROR = "[31mTimeoutError[0m: locator.selectOption: Timeout 10000ms exceeded.\n" +
  "Call log:\n  - waiting for locator('body').locator('select:near(:text(\"Manager\"), 120)')\n" +
  "    - locator resolved to <select>…</select>\n      - did not find some options\n";

describe("extractFailureDetail", () => {
  it("names the failing step by NUMBER and by title", () => {
    const d = extractFailureDetail(rawWith(STEPS, [{ message: REAL_ERROR }]));
    expect(d.failedStep).toBe(3);
    expect(d.failedStepTitle).toBe("Select 'prashant mishra' in 'Manager'");
  });

  it("gives the first line of the error, with ANSI stripped", () => {
    const d = extractFailureDetail(rawWith(STEPS, [{ message: REAL_ERROR }]));
    expect(d.error).toBe("TimeoutError: locator.selectOption: Timeout 10000ms exceeded.");
    expect(d.error).not.toContain("");
  });

  it("keeps the full message for the expandable detail", () => {
    const d = extractFailureDetail(rawWith(STEPS, [{ message: REAL_ERROR }]));
    expect(d.errorDetail).toContain("did not find some options");
    expect(d.errorDetail).not.toContain("");
  });

  it("prefers the real cause over the timeout it caused", () => {
    // Playwright appends "Test timeout of 50000ms exceeded." as a second error. It is the
    // consequence of the first, and showing it on the card would bury the actual reason.
    const d = extractFailureDetail(rawWith(STEPS, [
      { message: REAL_ERROR },
      { message: "Test timeout of 50000ms exceeded." },
    ]));
    expect(d.error).toContain("locator.selectOption");
  });

  it("takes the FIRST failing step when several report errors", () => {
    const d = extractFailureDetail(rawWith([
      { title: "one" }, { title: "two", error: { message: "x" } }, { title: "three", error: { message: "y" } },
    ], [{ message: "x" }]));
    expect(d.failedStep).toBe(2);
    expect(d.failedStepTitle).toBe("two");
  });

  it("ignores a spec that passed", () => {
    const raw = rawWith(STEPS, [{ message: REAL_ERROR }]);
    raw.suites[0].specs[0].ok = true;
    expect(extractFailureDetail(raw)).toEqual({});
  });

  it("falls back to a top-level error when no step carries one", () => {
    const raw: any = rawWith([{ title: "one" }], []);
    raw.errors = [{ message: "Error: spec failed to compile\n  at foo" }];
    const d = extractFailureDetail(raw);
    expect(d.error).toBe("Error: spec failed to compile");
    expect(d.failedStep).toBeUndefined();
  });

  it("never throws on junk — a missing or malformed report just has nothing to say", () => {
    for (const junk of [null, undefined, "", 42, {}, { suites: null }, { suites: [{}] }]) {
      expect(() => extractFailureDetail(junk as any)).not.toThrow();
    }
  });
});

describe("buildSuiteSummary exposes the failure to the UI", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), "suite-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const writeResult = (caseId: string, raw: any) => {
    const caseDir = path.join(dir, "cases", caseId);
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(path.join(caseDir, "05-result.json"),
      JSON.stringify({ passed: false, exitCode: 1, raw }), "utf8");
  };

  const result = (caseId: string, status: CaseRunResult["status"]): CaseRunResult => ({
    caseId, title: "Admin creates a new user", status,
    irPath: `${caseId}/04-ir.json`, resultPath: `cases/${caseId}`,
  });

  it("a failed case carries the step and the error string", () => {
    writeResult("case-0", rawWith(STEPS, [{ message: REAL_ERROR }]));
    const s = buildSuiteSummary([result("case-0", "failed")], dir);
    expect(s.cases[0].failedStep).toBe(3);
    expect(s.cases[0].failedStepTitle).toBe("Select 'prashant mishra' in 'Manager'");
    expect(s.cases[0].error).toContain("locator.selectOption");
  });

  it("a PASSING case carries none of it — the fields stay absent, not empty", () => {
    // Additive-optional is the whole contract (rule 1): a passing case's shape is unchanged.
    writeResult("case-0", rawWith(STEPS, [{ message: REAL_ERROR }]));
    const s = buildSuiteSummary([result("case-0", "passed")], dir);
    expect(s.cases[0]).not.toHaveProperty("failedStep");
    expect(s.cases[0]).not.toHaveProperty("error");
  });

  it("a case with no report on disk still builds, with nothing to show", () => {
    const s = buildSuiteSummary([result("case-0", "failed")], dir);
    expect(s.cases[0].status).toBe("failed");
    expect(s.cases[0].error).toBeUndefined();
  });

  it("an unparseable report does not take the whole summary down", () => {
    const caseDir = path.join(dir, "cases", "case-0");
    mkdirSync(caseDir, { recursive: true });
    writeFileSync(path.join(caseDir, "05-result.json"), "{ not json", "utf8");
    expect(() => buildSuiteSummary([result("case-0", "failed")], dir)).not.toThrow();
  });

  it("every field a passing case already had is still there", () => {
    // The regression this file's neighbours exist for: fields silently not surviving the map.
    const r = { ...result("case-0", "passed"), whyItMatters: "w", intent: "i", expected: "e" };
    const s = buildSuiteSummary([r], dir);
    expect(s.cases[0]).toMatchObject({
      caseId: "case-0", status: "passed", whyItMatters: "w", intent: "i", expected: "e",
      resultPath: "cases/case-0",
    });
  });
});

/**
 * The card itself. `public/app.js` is a classic script with no module surface, so the renderer is
 * extracted from the file and evaluated — the same approach `tests/stepText.test.ts` uses for
 * app.js's copy of `formatIrStep`. Testing a reimplementation here would miss the point: the
 * defect was that the card rendered NOTHING, which only the real function can demonstrate.
 */
describe("the case card renders the error", () => {
  const APP = readFileSync("public/app.js", "utf8");

  const render = (() => {
    const at = APP.indexOf("function renderCaseErrorBlock(");
    if (at === -1) throw new Error("app.js no longer defines renderCaseErrorBlock()");
    let depth = 0;
    let end = -1;
    for (let k = APP.indexOf("{", at); k < APP.length; k++) {
      if (APP[k] === "{") depth++;
      else if (APP[k] === "}" && --depth === 0) { end = k + 1; break; }
    }
    // app.js's own escapeHtml, so the escaping under test is the one that ships. Bounded by its
    // real terminator rather than by the next blank line — a slice that overshoots drags in
    // top-level DOM lookups and the whole thing dies on `document is not defined`.
    const escapeAt = APP.indexOf("const escapeHtml = (s) =>");
    const escapeEnd = APP.indexOf("[c]));", escapeAt);
    if (escapeAt === -1 || escapeEnd === -1) throw new Error("app.js no longer defines escapeHtml as expected");
    const escapeSrc = APP.slice(escapeAt, escapeEnd + "[c]));".length);
    return new Function(`${escapeSrc}\n${APP.slice(at, end)}\nreturn renderCaseErrorBlock;`)() as
      (c: any, url?: string) => string;
  })();

  const failed = {
    status: "failed",
    failedStep: 12,
    failedStepTitle: "Select 'prashant mishra' in 'Manager'",
    error: "TimeoutError: locator.selectOption: Timeout 10000ms exceeded.",
    errorDetail: "TimeoutError: locator.selectOption: Timeout 10000ms exceeded.\nCall log:\n  - did not find some options",
  };

  it("shows the step number, the title and the first error line", () => {
    const html = render(failed, "/runs/x/step-11.png");
    expect(html).toContain("Step 12");
    expect(html).toContain("Select &#39;prashant mishra&#39; in &#39;Manager&#39;");
    expect(html).toContain("TimeoutError: locator.selectOption");
  });

  it("links to the screenshot", () => {
    expect(render(failed, "/runs/x/step-11.png")).toContain('href="/runs/x/step-11.png"');
  });

  it("puts the full error behind a disclosure rather than in the headline", () => {
    const html = render(failed, undefined);
    expect(html).toContain("<details");
    expect(html).toContain("did not find some options");
  });

  it("renders nothing for a passing case", () => {
    expect(render({ status: "passed", error: "x" }, "/s.png")).toBe("");
  });

  it("renders nothing when there is genuinely nothing to say", () => {
    expect(render({ status: "failed" }, "/s.png")).toBe("");
  });

  it("still renders the step when the error string is missing", () => {
    const html = render({ status: "failed", failedStep: 4, failedStepTitle: "Click 'Save'" }, undefined);
    expect(html).toContain("Step 4");
    expect(html).toContain("Click &#39;Save&#39;");
  });

  it("escapes what it renders — the error text is not trusted markup", () => {
    const html = render({ status: "failed", failedStep: 1, error: "<img src=x onerror=alert(1)>" }, undefined);
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("mints no new CSS class names (rule 3)", () => {
    const css = readFileSync("public/style.css", "utf8");
    const classes = Array.from(render(failed, "/s.png").matchAll(/class="([^"]+)"/g))
      .flatMap((m) => m[1].split(/\s+/)).filter(Boolean);
    expect(classes.length).toBeGreaterThan(0);
    for (const c of classes) expect(css, `.${c} is not defined in style.css`).toContain(`.${c}`);
  });
});
