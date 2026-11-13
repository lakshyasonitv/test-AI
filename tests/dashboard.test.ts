import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import request from "supertest";
import { app } from "../src/server/index.js";
import { invalidateMemberships } from "../src/server/authz.js";
import { dashboardEnabled } from "../src/server/dashboardFlag.js";

/**
 * D-79 — the dashboard screen at #/dashboard. ON by default at the user's explicit request (an
 * exception to platform rule 2, recorded in D-79); DASHBOARD_ENABLED=false|0|off|no turns it off,
 * and off means /api/health and the app are exactly what they were before the dashboard existed.
 * The screen only reads existing routes, never changes a route's shape (rule 1), reuses existing
 * classes (rule 3) and never shows or hides anything with .hidden (rule 4).
 */

const original = process.env.DASHBOARD_ENABLED;
beforeEach(() => {
  delete process.env.AUTH_ENABLED;
  delete process.env.DB_ENABLED;
  delete process.env.DASHBOARD_ENABLED;
  invalidateMemberships();
});
afterEach(() => {
  if (original === undefined) delete process.env.DASHBOARD_ENABLED;
  else process.env.DASHBOARD_ENABLED = original;
});

// Normalised to LF: a Windows checkout (core.autocrlf) has CRLF line endings, CI does not (TD-170).
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const APP = read("public/app.js");
const HTML = read("public/index.html");
const CSS = read("public/style.css");

/** The source of one top-level function, from its declaration to the closing brace at column 0. */
function fnSource(decl: string): string {
  const s = APP.indexOf(decl);
  if (s < 0) return "";
  const e = APP.indexOf("\n}\n", s);
  return e < 0 ? "" : APP.slice(s, e + 2);
}

describe("dashboardEnabled()", () => {
  it("is ON by default: unset, blank, or any value that is not an explicit off", () => {
    expect(dashboardEnabled()).toBe(true);
    for (const v of ["", "  ", "true", "TRUE", "1", "yes", "on"]) {
      process.env.DASHBOARD_ENABLED = v;
      expect(dashboardEnabled(), `DASHBOARD_ENABLED=${JSON.stringify(v)}`).toBe(true);
    }
  });

  it("is off for false, 0, off or no, ignoring case and surrounding space", () => {
    for (const v of ["false", "FALSE", " false ", "0", "off", "OFF", "no"]) {
      process.env.DASHBOARD_ENABLED = v;
      expect(dashboardEnabled(), `DASHBOARD_ENABLED=${JSON.stringify(v)}`).toBe(false);
    }
  });
});

describe("GET /api/health and DASHBOARD_ENABLED", () => {
  it("reports dashboard:true by default, with no setting at all", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.dashboard).toBe(true);
  });

  it("serves a plain /dashboard address that redirects into the app", async () => {
    const on = await request(app).get("/dashboard");
    expect(on.status).toBe(302);
    expect(on.headers.location).toBe("/#/dashboard");
    process.env.DASHBOARD_ENABLED = "false";
    const off = await request(app).get("/dashboard");
    expect(off.status).toBe(302);
    expect(off.headers.location).toBe("/");
  });

  it("has no dashboard field when turned off, and on only ADDS that field", async () => {
    process.env.DASHBOARD_ENABLED = "false";
    const off = (await request(app).get("/api/health")).body;
    expect("dashboard" in off).toBe(false);
    delete process.env.DASHBOARD_ENABLED;
    const on = (await request(app).get("/api/health")).body;
    expect(on.dashboard).toBe(true);
    // Additive only: every key of the flag-off body is still there, in the same order.
    const offKeys = Object.keys(off);
    expect(Object.keys(on).slice(0, offKeys.length)).toEqual(offKeys);
    expect(on.status).toBe("ok");
    expect(typeof on.defaults.gateReview).toBe("boolean");
  });
});

describe("the dashboard in app.js", () => {
  const ROUTE_START = APP.indexOf('if (head === "dashboard"');
  const VIEW = fnSource("async function renderDashboardView(");
  const LINK = fnSource("function renderDashboardLink(");
  const ENABLE = fnSource("function enableDashboard(");

  it("is found (the guards below are not vacuous)", () => {
    expect(ROUTE_START).toBeGreaterThan(0);
    expect(VIEW.length).toBeGreaterThan(500);
    expect(LINK).toContain('a.className = "topbar-btn"');
    expect(ENABLE).toContain("dashboardOn = true");
  });

  it("is a view showView() knows, starts off, and is only turned on by /api/health", () => {
    expect(APP).toMatch(/const VIEWS = \[[^\]]*"dashboard"[^\]]*\];/);
    expect(APP).toContain("let dashboardOn = false;");
    expect(APP).toContain("if (h && h.dashboard === true) enableDashboard();");
    // the only assignment that turns it on is inside enableDashboard()
    expect(APP.split("dashboardOn = true").length - 1).toBe(1);
  });

  it("after sign-in, lands on the page that was asked for (dashboard on), or #/ as before (off)", () => {
    const src = fnSource("function afterSignInHash(");
    expect(src).toContain('if (!dashboardOn) return "#/";');
    const run = (on: boolean, hash: string) =>
      // eslint-disable-next-line no-new-func
      new Function("dashboardOn", "location", `${src}; return afterSignInHash();`)(on, { hash });
    expect(run(false, "#/dashboard")).toBe("#/");          // flag off: exactly the old behaviour
    expect(run(false, "")).toBe("#/");
    expect(run(true, "#/dashboard")).toBe("#/dashboard");  // landing "Start testing"
    expect(run(true, "#/")).toBe("#/");                    // landing "Run a new test"
    expect(run(true, "#/history")).toBe("#/history");
    expect(run(true, "")).toBe("#/dashboard");             // bare address
    // both the sign-in and the sign-up handler use it; a parked run still wins
    expect(APP).toContain("navigate(resume ? `#/run/${resume}` : afterSignInHash());");
    expect(APP.split("navigate(afterSignInHash());").length - 1).toBe(1);
  });

  it("does not redirect the dev-only state preview", () => {
    expect(ENABLE).toContain('new URLSearchParams(location.search).get("preview") === "states"');
  });

  it("opens the dashboard for the bare app address only, never for #/ (the new-test screen)", () => {
    expect(ENABLE).toContain(`if (!previewing && (!location.hash || location.hash === "#")) { location.replace("#/dashboard"); return; }`);
    // #/ still routes to home: the redirect is in enableDashboard(), not in applyRoute()
    expect(APP).toContain('showView("home");\n  setCrumbs([]);');
  });

  it("routes #/dashboard only while the flag is on, before the home fallback", () => {
    expect(APP).toContain('if (head === "dashboard" && dashboardOn) {');
    const routeBlock = APP.slice(ROUTE_START, APP.indexOf("return;", ROUTE_START));
    expect(routeBlock).toContain('showView("dashboard")');
    expect(routeBlock).toContain("renderDashboardView()");
    const homeFallback = APP.indexOf('showView("home");\n  setCrumbs([]);', ROUTE_START);
    expect(homeFallback).toBeGreaterThan(ROUTE_START);
  });

  it("never shows or hides anything itself, and never switches views (rule 4)", () => {
    for (const src of [VIEW, LINK, ENABLE]) {
      expect(src).not.toMatch(/classList\.(add|remove|toggle)\(\s*["']hidden["']/);
      expect(src).not.toContain("showView(");
      expect(src).not.toMatch(/\.style\.display\s*=/);
    }
  });

  it("only reads existing routes (no new API, no writes)", () => {
    const fetched = [...VIEW.matchAll(/fetch\(\s*"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(fetched).toEqual(["/api/projects", "/api/runs", "/api/suites"]);
    expect(VIEW).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
  });

  it("links only to hashes the router already handles", () => {
    // the only literal href in the markup: Recent runs' "See all" (the header has no buttons)
    const literal = [...VIEW.matchAll(/href="([^"$]+)"/g)].map((m) => m[1]);
    expect(new Set(literal)).toEqual(new Set(["#/history"]));
    // hrefs built from data (actions, run and suite ids) take the same shapes
    expect(VIEW).toContain('href="#/run/${encodeURIComponent(r.runId)}"');
    expect(VIEW).toContain('href="#/suite/${encodeURIComponent(s.id)}"');
    // an "#anchor" would be read by the router as a route and send the user home
    expect(VIEW).not.toMatch(/href="#(?!\/)/);
  });

  it("escapes every server value it puts into markup", () => {
    for (const field of ["r.prompt", "s.name", "statusText(r.status)", "projectName.get(s.projectId)", "when"]) {
      expect(VIEW, `${field} must go through escapeHtml`).toContain(`escapeHtml(${field}`);
    }
  });

  it("no longer opens the sidebar drawer: Projects is a page reached from the nav row (D-80)", () => {
    expect(VIEW).not.toMatch(/openSidebarDrawer|data-act="projects"/);
    // the drawer functions themselves are unchanged and still own .open and the scrim
    expect(fnSource("function openSidebarDrawer(")).toContain('sidebarEl.classList.add("open")');
    expect(APP).toMatch(/function showView\(name\) \{[\s\S]*?closeSidebarDrawer\(\);/);
  });

  it("theme.css: the dashboard section no longer touches the sidebar; its layout reaches only the three pages", () => {
    const THEME = read("public/theme.css");
    const s = THEME.indexOf("/* ---------- dashboard (D-79)");
    const e = THEME.indexOf("/* ---------- the top-nav layout (D-80)", s);
    const section = THEME.slice(s, e);
    expect(s).toBeGreaterThan(0);
    expect(e).toBeGreaterThan(s);
    const selectors = [...section.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)].map((m) => m[1].trim());
    expect(selectors.filter((sel) => /\.sidebar/.test(sel))).toEqual([]);
    for (const sel of selectors.filter((x) => /data-dash/.test(x))) {
      expect(sel).toMatch(/^:is\(#view-dashboard, #view-projects, #view-settings\) /);
    }
  });

  it("reuses existing classes and adds none to style.css (rule 3)", () => {
    const used = new Set(
      [...VIEW.matchAll(/class="([^"$]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean),
    );
    expect(used.size).toBeGreaterThan(3);
    for (const cls of used) {
      expect(CSS, `.${cls} must already exist in style.css`).toMatch(new RegExp(`\\.${cls.replace(/-/g, "\\-")}\\b`));
    }
    expect(CSS).not.toContain("dashboard");
  });

  it("has one button per action: no duplicate links between the top bar and the pages", () => {
    // the nav row (D-80): one link per page, built once (Landing page is the LANDING_URL link)
    for (const [id, href, text] of [
      ["dashboardLink", "#/dashboard", "Dashboard"], ["navNew", "#/", "New test"],
      ["navProjects", "#/projects", "Projects"], ["navHistory", "#/history", "History"],
      ["navSettings", "#/settings", "Settings"],
    ]) {
      expect(LINK).toContain(`link("${id}", "${href}", "${text}")`);
    }
    expect(LINK).toContain('nav.querySelector("#navNew").addEventListener("click", startNewTest)');
    expect(LINK).not.toMatch(/hidden|innerHTML|showView\(/);
    // ... and the dashboard header repeats none of them
    expect(VIEW).not.toMatch(/data-dash="actions"|href="#\/projects"|href="#\/"/);
    expect(VIEW).not.toMatch(/<a class="dl-btn" href="#\/history"|Landing page|landingHref/);
    // ... and the new-test screen no longer has its own "← Dashboard" link
    expect(APP).not.toMatch(/homeDashboardLink|renderHomeDashboardLink/);
    // renderLandingLink() is back to exactly what main has
    expect(fnSource("function renderLandingLink(")).not.toContain("landingHref");
  });

  it("the dashboard's New test reuses the sidebar's New run button and never wipes typed text", () => {
    const START = fnSource("function startNewTest(");
    expect(START).toContain('if (currentView === "home" || !nr || nr.disabled) return;');
    expect(START).toContain("nr.click();");
    expect(START).not.toMatch(/promptEl|urlEl|currentRunId\s*=/); // no reset logic of its own
    expect(LINK).toContain(`addEventListener("click", startNewTest)`);
  });

  it("marks the current page's nav link from .view-active in CSS, with no script keeping it in sync", () => {
    const THEME = read("public/theme.css");
    for (const [view, link] of [
      ["dashboard", "dashboardLink"], ["home", "navNew"], ["run", "navNew"], ["projects", "navProjects"],
      ["suite", "navProjects"], ["case", "navProjects"], ["history", "navHistory"], ["settings", "navSettings"],
    ]) {
      expect(THEME).toContain(`body:has(#view-${view}.view-active) #${link}`);
    }
    expect(APP).not.toMatch(/nav(History|Projects|Settings|New)[^\n]*classList/);
  });

  it("the 'one look' layer only paints: it never hides a view or touches .hidden", () => {
    const THEME = read("public/theme.css");
    const s = THEME.indexOf("/* ---------- one look on every page");
    const e = THEME.indexOf("/* ---------- dashboard (D-79)", s);
    const block = THEME.slice(s, e).replace(/\/\*[\s\S]*?\*\//g, "");
    expect(s).toBeGreaterThan(0);
    // no rule styles a .view itself (only showView() decides which is visible) or .hidden;
    // "#view-x.view-active" inside :has() only READS which view is active
    expect(block).not.toMatch(/\.view(?![\w-])|\.hidden\b/);
    // the only display:none rule: the two message slots while they are empty
    const hides = [...block.matchAll(/([^{}]+)\{[^{}]*display:\s*none/g)].map((m) => m[1].trim());
    expect(hides).toEqual(["#caseFeedback:not(:has(*)), #cdConflict:not(:has(*))"]);
  });

  it("keeps the 'Testbench' crumb at home while the flag is off", () => {
    expect(APP).toContain('navigate(dashboardOn ? "#/dashboard" : "#/")');
  });
});

describe("D-80: the top-nav layout, with Projects and Settings as pages", () => {
  const THEME = read("public/theme.css");
  const PV = APP.slice(APP.indexOf("let pvForm = null;"), APP.indexOf("function buildSettingsView("));
  const SET = fnSource("function buildSettingsView(");
  const SHELL = THEME.slice(THEME.indexOf("/* ---------- the top-nav layout (D-80)"), THEME.indexOf("/* ---------- motion"));

  it("is found (the guards below are not vacuous)", () => {
    expect(PV.length).toBeGreaterThan(3000);
    expect(SET).toContain("appendChild(el)");
    expect(SHELL.length).toBeGreaterThan(1000);
  });

  it("both pages are views showView() knows, routed only while the dashboard is on", () => {
    expect(APP).toMatch(/const VIEWS = \[[^\]]*"projects", "settings"\];/);
    expect(APP).toContain('if (head === "projects" && dashboardOn) {');
    expect(APP).toContain('if (head === "settings" && dashboardOn) {');
    // a case under a project (#/projects/<id>/cases/<id>) is still a case: routed before these
    expect(APP.indexOf("if (caseRoute) {")).toBeLessThan(APP.indexOf('if (head === "projects" && dashboardOn)'));
    for (const v of ["projects", "settings"]) {
      expect(HTML).toContain(`<section class="view" data-view="${v}" id="view-${v}">`);
    }
  });

  it("the layout turns on with the dashboard and is keyed off one body attribute", () => {
    const ENABLE = fnSource("function enableDashboard(");
    expect(ENABLE).toContain('document.body.dataset.shell = "top";');
    expect(ENABLE).toContain("buildSettingsView();");
    expect(APP.split("dataset.shell").length - 1).toBe(1);
    // every rule in the layout section is scoped to that attribute or to the new nav / pages
    const selectors = [...SHELL.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{/g)]
      .map((m) => m[1].trim()).filter((s) => !s.startsWith("@media"));
    for (const sel of selectors) {
      for (const part of sel.split(",")) {
        expect(part.trim()).toMatch(/^(body\[data-shell="top"\]|#appNav|#view-projects |#view-settings |body:has\(#view-[a-z]+\.view-active\) #(dashboardLink|nav[A-Z]\w+)$)/);
      }
    }
    // it never styles .hidden and never shows or hides a view; ":not(.hidden)" only READS the
    // auth/role gating app.js already applies (the Settings cards below)
    expect(SHELL.replace(/\/\*[\s\S]*?\*\//g, "").replace(/:not\(\.hidden\)/g, "")).not.toMatch(/\.hidden\b|\.view(?![\w-])/);
  });

  it("Projects uses exactly the sidebar's routes, permission checks, confirms and toasts", () => {
    for (const s of [
      'api("/api/projects", {', "api(`/api/projects/${encodeURIComponent(pvForm.id)}`, {",
      "api(`/api/projects/${encodeURIComponent(p.id)}`, { method: \"DELETE\" })",
      'api("/api/suites", {', "api(`/api/suites/${encodeURIComponent(pvForm.id)}`, {",
      "api(`/api/suites/${encodeURIComponent(s.id)}`, { method: \"DELETE\" })",
      "await confirmProjectDelete(p)",
      'confirm(`Delete the suite "${s.name}"? The cases themselves are kept.`)',
      'toast("Project updated.")', 'toast(`Project "${name}" created.`)', 'toast(`Project "${p.name}" deleted.`)',
      'toast("Suite renamed.")', 'toast("Suite deleted — its cases were kept.")',
      "canManageProjects()", "canAuthorSuites()", "canDeleteSuites()",
      "await loadProjects();",
    ]) {
      expect(PV, s).toContain(s);
    }
    // the same request bodies as the sidebar
    expect(PV).toContain("JSON.stringify({ name, baseUrl: pvForm.url.trim() })");
    expect(PV).toContain("JSON.stringify({ projectId: p.id, name })");
    // and no route of its own
    const routes = new Set([...PV.matchAll(/api\(\s*[`"](\/api\/[a-z]+)/g)].map((m) => m[1]));
    expect(routes).toEqual(new Set(["/api/projects", "/api/suites"]));
  });

  it("Projects escapes every server value and only links to hashes the router handles", () => {
    for (const field of ["p.name", "p.baseUrl", "s.name", "c.title", "r.prompt", "statusText(r.status)", "shortProjectName(p.name)"]) {
      expect(PV, `${field} must go through escapeHtml`).toMatch(new RegExp(`escapeHtml\\((displayUrl\\()?${field.replace(/[.()]/g, "\\$&")}`));
    }
    const literal = new Set([...PV.matchAll(/href="([^"$]+)"/g)].map((m) => m[1]));
    expect(literal).toEqual(new Set(["#/projects", "#/history"]));
    expect(PV).not.toMatch(/href="#(?!\/)/);
    expect(PV).not.toMatch(/classList\.(add|remove|toggle)\("hidden"|showView\(/);
  });

  it("New test here empties the composer the way New run does, then fills in the project's address", () => {
    expect(PV).toMatch(/"new-test": \(\) => \{[\s\S]*?nr\.click\(\);[\s\S]*?setUrlFieldValue\(p\.baseUrl\);[\s\S]*?navigate\("#\/"\);/);
  });

  it("Settings MOVES the existing controls (never clones them) and leaves their gating alone", () => {
    expect(SET).not.toMatch(/cloneNode|addEventListener|classList/);
    expect(SET).toContain('put("run", ["gateToggle", "healToggle", "clearWalkCacheBtn"]);');
    expect(SET).toContain('put("account-slot", ["sessionBadge", "signOutBtn"]);');
    expect(SET).toContain('put("team-slot", ["teamBtn"]);');
    // the Account and Team cards follow the controls' own .hidden gating (auth, role)
    expect(THEME).toContain('#view-settings [data-set="account"]:not(:has(#signOutBtn:not(.hidden)))');
    expect(THEME).toContain('#view-settings [data-set="team"]:not(:has(#teamBtn:not(.hidden)))');
  });

  it("reuses existing classes only (rule 3)", () => {
    const used = new Set(
      [...(PV + SET).matchAll(/class="([^"$]+)"/g)].flatMap((m) => m[1].split(/\s+/)).filter(Boolean),
    );
    expect(used.size).toBeGreaterThan(5);
    for (const cls of used) {
      expect(CSS, `.${cls} must already exist in style.css`).toMatch(new RegExp(`\\.${cls.replace(/-/g, "\\-")}\\b`));
    }
  });
});

describe("index.html", () => {
  it("has an inert dashboard view section that only showView() can make active", () => {
    expect(HTML).toContain('<section class="view" data-view="dashboard" id="view-dashboard">');
    expect(HTML).toContain('id="dashboardViewBody"');
    expect(HTML).not.toMatch(/data-view="dashboard"[^>]*view-active/);
    expect(HTML).not.toContain("dashboardLink");
  });
});

describe("the landing page leads to the dashboard", () => {
  const PAGE = read("landing/index.html");
  const HTACCESS = read("landing/.htaccess");

  it("points every Start testing button at #/dashboard, and Run a new test at the composer", () => {
    const appLinks = [...PAGE.matchAll(/<a [^>]*href="(https:\/\/[^"]*azurecontainerapps\.io\/[^"]*)"[^>]*>([^<]+)<\/a>/g)]
      .map((m) => ({ href: m[1], text: m[2].trim() }));
    const start = appLinks.filter((l) => l.text === "Start testing");
    expect(start.length).toBeGreaterThanOrEqual(3);
    for (const l of start) expect(l.href.endsWith("/#/dashboard")).toBe(true);
    const newTest = appLinks.filter((l) => l.text === "Run a new test");
    expect(newTest.length).toBe(1);
    expect(newTest[0].href.endsWith(".azurecontainerapps.io/#/")).toBe(true);
    // nothing else on the page points into the app
    expect(appLinks.length).toBe(start.length + newTest.length);
  });

  it("redirects /app there without escaping the # (NE)", () => {
    expect(HTACCESS).toMatch(/RewriteRule \^app\/\?\$ \S+\/#\/dashboard \[R=302,L,NE\]/);
  });
});
