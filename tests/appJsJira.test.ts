import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * D-63 — the Jira row in public/app.js keeps the platform's UI rules (CLAUDE.md rules 3 and 4),
 * the same guard appJsProIntake.test.ts keeps for the Pro block. The row itself was checked in a
 * real browser when it was written; this keeps the rules for the next edit.
 */

const APP = readFileSync("public/app.js", "utf8");
const CSS = readFileSync("public/style.css", "utf8");

const START = "// Jira, Phase 1 (D-63)";
const END = 'fetch("/api/health")';
const s = APP.indexOf(START);
const e = APP.indexOf(END, s);
const BLOCK = APP.slice(s, e);
const CODE = BLOCK.split("\n").map((l) => { const i = l.indexOf("//"); return i < 0 ? l : l.slice(0, i); }).join("\n");

describe("the Jira row in app.js", () => {
  it("is found (the guards below are not vacuous)", () => {
    expect(s).toBeGreaterThan(0);
    expect(e).toBeGreaterThan(s);
    expect(BLOCK).toContain("function connectJira");
    expect(BLOCK).toContain("function fetchJiraStory");
  });

  it("uses only classes style.css already defines (rule 3)", () => {
    const used = new Set<string>();
    for (const m of BLOCK.matchAll(/class(?:Name)?\s*=\s*"([^"$]+)"/g)) for (const c of m[1].split(/\s+/).filter(Boolean)) used.add(c);
    for (const m of BLOCK.matchAll(/btn\("\w+", "[^"]+", "([\w-]+)"\)/g)) used.add(m[1]);
    used.add("composer-save-btn"); // btn()'s default
    expect(used.size).toBeGreaterThan(4);
    const missing = [...used].filter((c) => !new RegExp(`\\.${c.replace(/-/g, "\\-")}(?![\\w-])`).test(CSS));
    expect(missing).toEqual([]);
  });

  it("never toggles .hidden and never calls showView (rule 4)", () => {
    expect(CODE).not.toMatch(/classList\.(add|remove|toggle)\(\s*["']hidden["']/);
    expect(CODE).not.toMatch(/\bshowView\s*\(/);
  });

  it("is only built when /api/health says jira is true, and sits outside the run form", () => {
    expect(APP).toMatch(/if \(h && h\.jira === true\) renderJiraRow\(\);/);
    expect(BLOCK).toContain('form.insertAdjacentElement("beforebegin", jira.root)');
  });

  it("never sends anything new on POST /api/runs — it only fills the prompt box", () => {
    expect(CODE).not.toContain("/api/runs");
    expect(CODE).toContain('document.getElementById("prompt")');
  });
});
