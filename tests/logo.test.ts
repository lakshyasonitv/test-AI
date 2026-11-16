import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * One logo everywhere (2026-11-16, at the user's request): the app uses the landing page's mark —
 * four dots in a square, the first blue (landing/landing.css .lp-logo) — in the nav row, the old
 * sidebar, the sign-in / sign-up tile and the browser tab. Checked in the browser beside the landing.
 */

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const THEME = read("public/theme.css");
const HTML = read("public/index.html");
const APP = read("public/app.js");
const LANDING = read("landing/landing.css");
const LOGO = THEME.slice(THEME.indexOf("/* ── one logo everywhere"));

describe("one logo everywhere: the landing page's", () => {
  it("the landing page's own mark is what is copied: 7px dots, 3px gap, the first blue", () => {
    expect(LANDING).toContain(".lp-logo { display: inline-grid; grid-template-columns: 7px 7px; gap: 3px; }");
    expect(LANDING).toContain(".lp-logo i:first-child { background: var(--lp-blue); }");
    expect(LANDING).toContain("--lp-blue: #1f7bff;");
  });

  it("theme.css draws the same four dots (7px, 10px apart, first in the accent blue)", () => {
    expect(LOGO.length).toBeGreaterThan(200);
    const tb = LOGO.slice(LOGO.indexOf("--tb-logo:"), LOGO.indexOf(";", LOGO.indexOf("--tb-logo:")));
    expect(tb).toContain("var(--accent) 96%, transparent 100%) 0 0 / 7px 7px");
    for (const pos of ["10px 0", "0 10px", "10px 10px"]) expect(tb).toContain(`var(--text) 96%, transparent 100%) ${pos} / 7px 7px`);
  });

  it("is used by the nav row, the sidebar and the sign-in tile; the lightning bolt is gone", () => {
    expect(LOGO).toMatch(/body\[data-shell="top"\] \.crumb-root::before \{[^}]*background: var\(--tb-logo\)/);
    expect(LOGO).toMatch(/\.brand-mark \{[^}]*background: var\(--tb-logo\)/);
    expect(LOGO).toContain("#view-login .page-head::before, #view-signup .page-head::before");
    expect(APP).not.toContain('getElementById("brandMark").innerHTML = icon("zap"');
  });

  it("the browser tab shows it too", () => {
    expect(HTML).toMatch(/<link rel="icon" type="image\/svg\+xml" href="data:image\/svg\+xml,[^"]*%231f7bff[^"]*" \/>/);
  });
});
