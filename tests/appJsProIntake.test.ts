import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Pro document intake's browser code keeps the platform's UI rules (CLAUDE.md rules 3 and 4).
 *
 * The Pro block in public/app.js was checked end-to-end in a real browser when it was written
 * (toggle, upload, the two-column screen, narrow-viewport stacking, the run-screen panel). This
 * file keeps the two rules that check cannot keep for the next edit: every class the block uses
 * already exists in style.css (no class is minted), and the block never switches anything by
 * toggling `.hidden` or by calling showView.
 */

const APP = readFileSync("public/app.js", "utf8");
const CSS = readFileSync("public/style.css", "utf8");

const START = "// Pro document intake (SPEC_INTAKE_ENABLED)";
const END = "/**\n * Clear the cached browser walks";
const s = APP.indexOf(START);
const e = APP.indexOf(END, s);
const PRO = APP.slice(s, e);
/** CODE only: the block's header comment says "no showView()" in prose, which must not count. */
const PRO_CODE = PRO.split("\n").map((l) => { const i = l.indexOf("//"); return i < 0 ? l : l.slice(0, i); }).join("\n");

describe("Pro intake's app.js block", () => {
  it("is found (the guard below is not vacuous)", () => {
    expect(s).toBeGreaterThan(0);
    expect(e).toBeGreaterThan(s);
    expect(PRO).toContain("function proUpload");
    expect(PRO).toContain("function renderProQuestions");
  });

  it("uses only classes style.css already defines — no new class (rule 3)", () => {
    const used = new Set<string>();
    for (const m of PRO.matchAll(/class(?:Name)?\s*=\s*"([^"$]+)"/g)) {
      for (const c of m[1].split(/\s+/).filter(Boolean)) used.add(c);
    }
    expect(used.size).toBeGreaterThan(8);
    const missing = [...used].filter((c) => !new RegExp(`\\.${c.replace(/-/g, "\\-")}(?![\\w-])`).test(CSS));
    expect(missing, `classes used by the Pro block but not defined in style.css: ${missing.join(", ")}`).toEqual([]);
  });

  it("never toggles .hidden and never calls showView (rule 4) — elements are created and removed", () => {
    expect(PRO_CODE).not.toMatch(/classList\.(add|remove|toggle)\(\s*["']hidden["']/);
    expect(PRO_CODE).not.toMatch(/\bshowView\s*\(/);
    expect(PRO_CODE).toMatch(/\.remove\(\)/);
  });

  it("is only built when /api/health says specIntake is true", () => {
    expect(APP).toMatch(/if \(h && h\.specIntake === true\) renderProToggle\(\);/);
  });

  it("the run body is unchanged unless Pro supplies options — Pro off sends exactly baseOptions", () => {
    expect(APP).toContain("options: proOptions ? { ...baseOptions, ...proOptions } : baseOptions");
  });
});
