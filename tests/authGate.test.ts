import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

/**
 * TD-190: with sign-in on, nothing of the app may be seen or used before sign-in.
 *  1. Until the browser knows whether sign-in is required (/api/auth/config), the page is covered:
 *     index.html starts as <html data-auth-check="pending">, theme.css hides every part of the body,
 *     and app.js removes the attribute once initAuth() has settled.
 *  2. An unreachable config no longer means "sign-in off": it is retried, then the page stays covered
 *     with a message.
 *  3. A saved session the server rejects (401 on /api/auth/me) is signed out, not kept.
 * Checked live (scratchpad auth-gate-check.cjs, 21/21): config held back 3 s on an auth-on and an
 * auth-off server, an aborted config, and a 3-hour-old saved session on the auth-on server.
 */

// Normalised to LF: a Windows checkout has CRLF line endings, CI does not (TD-170).
const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const APP = read("public/app.js");
const HTML = read("public/index.html");
const THEME = read("public/theme.css");

function fnSource(decl: string): string {
  const s = APP.indexOf(decl);
  if (s < 0) return "";
  const e = APP.indexOf("\n}\n", s);
  return e < 0 ? "" : APP.slice(s, e + 2);
}

const INIT = fnSource("async function initAuth(");
const IDENT = fnSource("async function refreshIdentity(");
const REJECT = fnSource("async function sessionRejected(");

describe("TD-190: nothing of the app before sign-in", () => {
  it("is found (the guards below are not vacuous)", () => {
    expect(INIT).toContain("/api/auth/config");
    expect(IDENT).toContain("/api/auth/me");
    expect(REJECT).toContain("await signOut();");
  });

  it("the page starts covered, in the HTML itself (before any script runs)", () => {
    expect(HTML).toMatch(/<html lang="en" data-auth-check="pending">/);
    expect(THEME).toMatch(/html\[data-auth-check\] body > \* \{ visibility: hidden !important; \}/);
  });

  it("the cover comes off only after initAuth() settles, and never off an 'unreachable' page", () => {
    const start = APP.indexOf("initAuth()\n  .catch(");
    expect(start).toBeGreaterThan(0);
    const tail = APP.slice(start, start + 400);
    expect(tail).toContain('if (document.documentElement.dataset.authCheck === "pending") delete document.documentElement.dataset.authCheck;');
    // and the first route has already run by then (initAuth ends in applyRoute())
    expect(APP.indexOf("enableDashboard({ startup: true });\napplyRoute();")).toBeLessThan(start);
    expect(INIT.trimEnd().endsWith("applyRoute();\n}")).toBe(true);
  });

  it("an unreachable config is retried, then the page stays covered instead of drawing the app", () => {
    expect(INIT).toContain("for (const wait of [0, 1000, 2000, 4000])");
    expect(INIT).toContain('document.documentElement.dataset.authCheck = "unreachable";');
    expect(INIT).not.toContain("leave auth off rather than locking the user out");
    expect(THEME).toContain('html[data-auth-check="unreachable"] body::after');
  });

  it("a rejected saved session is signed out, with a reason on the sign-in page", () => {
    expect(IDENT).toContain("if (meRes.status === 401) { await sessionRejected(); return; }");
    expect(REJECT).toContain("Your session has ended. Please sign in again.");
  });

  it("never switches views itself: the router's existing sign-in guard still decides the screen", () => {
    const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    for (const src of [INIT, REJECT]) expect(code(src)).not.toMatch(/showView\(/);
    expect(APP).toContain("if (auth.required && !auth.token) {");
  });
});
