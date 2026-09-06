import { describe, it, expect } from "vitest";
import { isSameSite } from "../src/stages/executor.js";

/**
 * `isSameSite` decides whether a finished test "left the application" — the check behind the
 * `blocked` verdict in `detectBlocked`.
 *
 * The regression it exists for: the old test was `!finalUrl.startsWith(appOrigin)`, a string
 * prefix over origins. A user entered `http://veterans.my.site.com/s/`, the site redirected to
 * `https://…`, and all three otherwise-correct cases in run `2026-09-01T07-17-37-947Z-35c773cf`
 * came back as *"the flow left the application for veterans.my.site.com, an external sign-in
 * provider"* — naming the application's own host as the third party it had supposedly left for.
 * `TECH_DEBT.md` TD-69.
 *
 * These assertions are about the HOST being the unit of comparison. Scheme, port, path and a
 * leading `www.` are all things a site changes about its own URLs without becoming a different
 * site; a different hostname is the only thing that means the flow actually went elsewhere.
 */
describe("isSameSite", () => {
  it("ignores a scheme change — the http -> https redirect that caused the bug", () => {
    expect(isSameSite("https://veterans.my.site.com/s/", "http://veterans.my.site.com")).toBe(true);
    expect(isSameSite("http://x.com", "https://x.com/s/")).toBe(true);
  });

  it("ignores a leading www.", () => {
    expect(isSameSite("https://x.com", "https://www.x.com")).toBe(true);
    expect(isSameSite("https://www.x.com/deep/path", "https://x.com")).toBe(true);
  });

  it("ignores port and path", () => {
    expect(isSameSite("http://localhost:3000/run", "http://localhost:5173")).toBe(true);
    expect(isSameSite("https://x.com/a/b?c=d#e", "https://x.com")).toBe(true);
  });

  it("is case-insensitive about the host, as DNS is", () => {
    expect(isSameSite("https://X.COM/s/", "https://x.com")).toBe(true);
  });

  it("still reports a genuinely different host — the signal must survive the fix", () => {
    expect(isSameSite("https://login.salesforce.com/", "https://x.com")).toBe(false);
    expect(isSameSite("https://accounts.google.com/o/oauth2/auth", "https://x.com")).toBe(false);
  });

  it("does not treat a suffix match as the same site", () => {
    // "notx.com".endsWith("x.com") is true; hostname equality is what stops that being a match.
    expect(isSameSite("https://notx.com", "https://x.com")).toBe(false);
    // ...and a subdomain is a different host, which is the conservative answer here: an OAuth
    // provider on accounts.<something> is exactly the case this guard is meant to catch.
    expect(isSameSite("https://evil.x.com", "https://x.com")).toBe(false);
  });

  it("treats unreadable input as same-site, so no block is reported on evidence it cannot read", () => {
    // The caller's own comment called an unparseable URL "not a reliable signal". Being wrong in
    // the other direction is the defect this whole entry is about: marking passing tests blocked.
    expect(isSameSite("not a url", "https://x.com")).toBe(true);
    expect(isSameSite("https://x.com", "")).toBe(true);
    expect(isSameSite("", "")).toBe(true);
  });
});
