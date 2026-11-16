import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * D-82: the project page (#/projects/<id>, new layout) has a search box that narrows the page to
 * the suites, cases and recent runs matching every word typed, and looks inside each suite: a suite
 * shows when one of its cases matches, with those cases listed under it. Checked live on
 * 2026-11-16 (project 78d6a70d…: "regression" -> 1 suite; "creates user" -> 4 suites through their
 * cases; nonsense -> "Nothing matches" in every card). These pin the shape.
 */

// Normalised to LF: a Windows checkout has CRLF line endings, CI does not (TD-170).
const APP = readFileSync("public/app.js", "utf8").replace(/\r\n/g, "\n");
const CSS = readFileSync("public/theme.css", "utf8").replace(/\r\n/g, "\n");

function fnSource(decl: string): string {
  const s = APP.indexOf(decl);
  if (s < 0) return "";
  const e = APP.indexOf("\n}\n", s);
  return e < 0 ? "" : APP.slice(s, e + 2);
}
const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const MATCHER = fnSource("function pvMatcher(");
const APPLY = fnSource("function applyProjectSearch(");
const BIND = fnSource("function bindProjectSearch(");
const DRAW = fnSource("function drawOneProject(");
// eslint-disable-next-line @typescript-eslint/no-implied-eval
const pvMatcher = new Function(`${MATCHER}\nreturn pvMatcher;`)() as (q: string) => (t: string) => boolean;

describe("search inside a project (D-82)", () => {
  it("is found (the guards below are not vacuous)", () => {
    expect(MATCHER).toContain("every");
    expect(APPLY).toContain("/api/suites/");
    expect(BIND).toContain("applyProjectSearch");
    expect(DRAW).toContain("data-pv-search");
    expect(DRAW).toContain("bindProjectSearch(body, p, suites)");
  });

  it("matches every word, in any order, ignoring case", () => {
    const m = pvMatcher("Creates  USER");
    expect(m("Admin creates a new user via management interface")).toBe(true);
    expect(m("user creates")).toBe(true);
    expect(m("Admin creates a role")).toBe(false);
    expect(pvMatcher("")("anything")).toBe(true);
  });

  it("each searchable row carries its text; a suite has a place for its matching cases", () => {
    expect(DRAW).toMatch(/data-pv-row="suite" data-id="\$\{escapeHtml\(s\.id\)\}" data-pv-text=/);
    expect(DRAW).toMatch(/data-pv-row="case" data-pv-text=/);
    expect(DRAW).toMatch(/data-pv-row="run" data-pv-text=/);
    expect(DRAW).toContain('<div data-pv-hits="${escapeHtml(s.id)}" hidden></div>');
  });

  it("reads a suite's cases through the existing GET route only, once per suite", () => {
    const body = stripComments(APPLY);
    expect(body).toMatch(/fetch\(`\/api\/suites\/\$\{encodeURIComponent\(s\.id\)\}\/cases`\)/);
    expect(body).not.toMatch(/method:\s*"(POST|PATCH|PUT|DELETE)"/);
    expect(body).toContain("pvSuiteCases.has(s.id)");
  });

  it("narrows rows with the hidden attribute, never the .hidden class or showView (rules 3 and 4)", () => {
    for (const src of [APPLY, BIND]) {
      const code = stripComments(src);
      expect(code).not.toMatch(/classList\.(add|remove|toggle)\(\s*["']hidden["']/);
      expect(code).not.toContain("showView(");
    }
    expect(APPLY).toContain("row.hidden = !show");
    // .hrow sets display itself, so [hidden] must be restated or the rows never hide.
    expect(CSS).toMatch(/#view-projects \[data-pv-row\]\[hidden\][^{]*\{\s*display:\s*none !important;/);
  });

  it("the Projects list has its own search: name, address, or a suite in the project", () => {
    const LIST = fnSource("function drawProjectList(");
    const LBIND = fnSource("function bindProjectListSearch(");
    expect(LIST).toContain('data-pv-row="project" data-pv-text="${escapeHtml(searchText)}"');
    expect(LIST).toMatch(/searchText = \[p\.name, p\.baseUrl, \.\.\.suitesCache\.filter/);
    expect(LIST).toContain("bindProjectListSearch(body)");
    expect(LBIND).toContain("card.hidden = !show");
    // Its query is kept apart from a project page's (projectId "" vs the project's id).
    expect(LBIND).toContain('pvSearch = { projectId: "", q: input.value }');
    expect(stripComments(LBIND)).not.toMatch(/classList\.(add|remove|toggle)\(\s*["']hidden["']/);
  });

  it("escapes every server value it draws", () => {
    const hits = APPLY.slice(APPLY.indexOf("hits.innerHTML"));
    expect(hits).toContain('escapeHtml(c.title || "(untitled case)")');
    expect(hits).toMatch(/escapeHtml\(c\.feature/);
  });
});
