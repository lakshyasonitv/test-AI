import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * D-73 step 2's Suite-screen button, held to the UI's standing rules (CLAUDE.md 3 and 4): no new CSS
 * class, never switch views by toggling `.hidden` or calling `showView`, and nothing at all unless
 * /api/health says `regressionChangeCheck: true`. Line endings normalised first, so a Windows
 * checkout reads the same text as CI (TD-170).
 */
const APP = readFileSync("public/app.js", "utf8").replace(/\r\n/g, "\n");
const CSS = readFileSync("public/style.css", "utf8");
const START = "let regressionChangeCheckOn = false;";
const END = "async function renderSuiteView(suiteId) {";
const s = APP.indexOf(START);
const e = APP.indexOf(END, s);
const BLOCK = APP.slice(s, e);
const CODE = BLOCK.split("\n").map((l) => { const i = l.indexOf("//"); return i < 0 ? l : l.slice(0, i); }).join("\n");

describe("the Suite screen's Check for changes (D-73 step 2)", () => {
  it("the block is found (the checks below are not vacuous)", () => {
    expect(s).toBeGreaterThan(0);
    expect(e).toBeGreaterThan(s);
    expect(BLOCK).toContain("function renderChangeReport");
  });

  it("never toggles .hidden and never calls showView (rule 4)", () => {
    expect(CODE).not.toMatch(/classList\.(add|remove|toggle)\(\s*["']hidden/);
    expect(CODE).not.toMatch(/showView\(/);
  });

  it("uses only classes style.css already defines (rule 3)", () => {
    const used = new Set([...BLOCK.matchAll(/class(?:Name)?="([^"$]+)"/g)].flatMap((m) => m[1].split(/\s+/)));
    for (const cls of ["badge-failed", "badge-truncated", "badge-blocked", "case-badge-healed", "badge-passed", "badge-pending"]) used.add(cls);
    const missing = [...used].filter((c) => c && !new RegExp(`\\.${c.replace(/[-]/g, "\\-")}\\b`).test(CSS));
    expect(missing).toEqual([]);
  });

  it("the button exists only when health turned the check on, and only for a suite with cases", () => {
    expect(APP).toMatch(/\$\{regressionChangeCheckOn && cases\.length \? `<button type="button" class="dl-btn-inline" data-act="change-check"/);
    expect(APP).toMatch(/if \(h && h\.regressionChangeCheck === true\) \{\n\s+regressionChangeCheckOn = true;/);
  });

  it("sends the tab's org connection, never anything else about it", () => {
    expect(CODE).toMatch(/JSON\.stringify\(connectionId \? \{ sfConnectionId: connectionId \} : \{\}\)/);
  });
});
