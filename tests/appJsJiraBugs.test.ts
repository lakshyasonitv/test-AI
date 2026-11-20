import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * D-86 — the "Create Jira bug" panel in public/app.js keeps the platform's UI rules (CLAUDE.md rules
 * 3 and 4), the same guard appJsJira.test.ts keeps for the Jira row.
 */

const APP = readFileSync("public/app.js", "utf8");
const CSS = readFileSync("public/style.css", "utf8");

const START = '// "Create Jira bug" (D-86)';
const END = "function paintJiraBugPanel";
const s = APP.indexOf(START);
const e = APP.indexOf("\n}\n", APP.indexOf(END)); // to the end of the painter
const BLOCK = APP.slice(s, e);
const CODE = BLOCK.split("\n").map((l) => { const i = l.indexOf("//"); return i < 0 ? l : l.slice(0, i); }).join("\n");

describe("the Create Jira bug panel in app.js", () => {
  it("is found (the guards below are not vacuous)", () => {
    expect(s).toBeGreaterThan(0);
    expect(e).toBeGreaterThan(s);
    for (const fn of ["function addJiraBugButtons", "function openJiraBugPanel", "function paintJiraBugPanel"]) expect(BLOCK).toContain(fn);
  });

  it("uses only classes style.css already defines (rule 3)", () => {
    const used = new Set<string>();
    for (const m of BLOCK.matchAll(/class(?:Name)?\s*=\s*"([^"$]+)"/g)) for (const c of m[1].split(/\s+/).filter(Boolean)) used.add(c);
    expect(used.size).toBeGreaterThan(6);
    const missing = [...used].filter((c) => !new RegExp(`\\.${c.replace(/-/g, "\\-")}(?![\\w-])`).test(CSS));
    expect(missing).toEqual([]);
  });

  it("never toggles .hidden and never calls showView (rule 4) — the panel uses the hidden attribute", () => {
    expect(CODE).not.toMatch(/classList\.(add|remove|toggle)\(\s*["']hidden["']/);
    expect(CODE).not.toMatch(/\bshowView\s*\(/);
    expect(CODE).toContain("panel.hidden = ");
  });

  it("is only switched on when /api/health says jiraBugs is true, and never on a passed case", () => {
    expect(APP).toMatch(/if \(h && h\.jiraBugs === true\) enableJiraBugs\(\);/);
    expect(CODE).toMatch(/if \(!jiraBugsOn \|\| !suiteCaseListEl\) return;/);
    expect(CODE).toContain('card.dataset.status === "passed"');
  });

  it("files nothing on its own: the only POST is inside create(), which only the Create button calls", () => {
    expect(CODE.match(/method: "POST"/g)).toHaveLength(1);
    expect(CODE).toMatch(/else if \(what === "create"\) create\(\);/);
    expect(CODE.match(/(?<!function )\bcreate\(\)/g)).toHaveLength(1); // the click handler's call, nothing else
  });
});
