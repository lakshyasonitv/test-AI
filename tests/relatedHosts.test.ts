import { describe, it, expect } from "vitest";
import { isSameSite } from "../src/stages/executor.js";
import { collectCrawlTargets, loginHops } from "../src/stages/hybridDiscovery.js";

/**
 * Related hosts as DATA (D-47): a login observed to pass from one host to another makes them one
 * application. No host pattern anywhere — the same code holds for production, sandbox, scratch,
 * developer, custom-domain and Experience Cloud orgs, because the set is whatever the login did.
 *
 * Half of every block below is the regression half: with no set supplied, both functions must
 * answer exactly as they did before the parameter existed.
 */

const SF = ["acme--uat.sandbox.my.salesforce.com", "acme--uat.sandbox.lightning.force.com"];

describe("isSameSite — unchanged without a related set", () => {
  it("same host, scheme change, www prefix: same site (TD-69)", () => {
    expect(isSameSite("https://a.example.com/x", "http://a.example.com/")).toBe(true);
    expect(isSameSite("https://www.example.com/", "https://example.com/")).toBe(true);
  });

  it("different hosts: not the same site", () => {
    expect(isSameSite("https://acme.lightning.force.com/one", "https://acme.my.salesforce.com/")).toBe(false);
  });

  it("unparseable input stays permissive (TD-69), with or without a set", () => {
    expect(isSameSite("not a url", "https://a.example.com/")).toBe(true);
    expect(isSameSite("not a url", "https://a.example.com/", SF)).toBe(true);
  });

  it("an empty set is the same as no set", () => {
    expect(isSameSite("https://b.example.com/", "https://a.example.com/", [])).toBe(false);
  });
});

describe("isSameSite — with the hosts a login passed through", () => {
  it("a sandbox login that lands on Lightning has not left the application", () => {
    expect(isSameSite(`https://${SF[1]}/lightning/page/home`, `https://${SF[0]}/`, SF)).toBe(true);
  });

  it("holds for any org shape, because nothing is pattern-matched", () => {
    const scratch = ["ruby-data-2200-dev-ed.scratch.my.salesforce.com", "ruby-data-2200-dev-ed.scratch.lightning.force.com"];
    const custom = ["login.acme-corp.com", "acme-corp.my.site.com"];
    expect(isSameSite(`https://${scratch[1]}/x`, `https://${scratch[0]}/`, scratch)).toBe(true);
    expect(isSameSite(`https://${custom[1]}/s/`, `https://${custom[0]}/`, custom)).toBe(true);
  });

  it("a host outside the set is still leaving — an external provider is still caught", () => {
    expect(isSameSite("https://accounts.google.com/o/oauth2", `https://${SF[0]}/`, SF)).toBe(false);
    // Another org's Lightning host is NOT this org's, however alike the names look.
    expect(isSameSite("https://other-org.lightning.force.com/", `https://${SF[0]}/`, SF)).toBe(false);
  });

  it("matches the set the way siteHost normalises (case, www)", () => {
    expect(isSameSite("https://WWW.App.Example.com/", "https://login.example.com/", ["app.example.com", "LOGIN.example.com"])).toBe(true);
  });
});

describe("collectCrawlTargets — unchanged without a related set", () => {
  it("follows only the entry host", () => {
    const out = collectCrawlTargets(
      ["/a", "https://login.example.com/b", "https://other.example.com/c"],
      "https://login.example.com/", new Set(),
    );
    expect(out).toEqual(["https://login.example.com/a", "https://login.example.com/b"]);
  });
});

describe("collectCrawlTargets — with the hosts a login passed through", () => {
  it("follows the app onto its landing host, and still nowhere else", () => {
    const out = collectCrawlTargets(
      [`https://${SF[1]}/lightning/o/Account/home`, "https://accounts.google.com/x", `https://${SF[0]}/setup`],
      `https://${SF[0]}/`, new Set(), SF,
    );
    expect(out).toEqual([`https://${SF[1]}/lightning/o/Account/home`, `https://${SF[0]}/setup`]);
  });

  it("still de-duplicates across hosts and still skips assets", () => {
    const visited = new Set<string>();
    const first = collectCrawlTargets([`https://${SF[1]}/a`, `https://${SF[1]}/logo.png`], `https://${SF[0]}/`, visited, SF);
    const again = collectCrawlTargets([`https://${SF[1]}/a`], `https://${SF[0]}/`, visited, SF);
    expect(first).toEqual([`https://${SF[1]}/a`]);
    expect(again).toEqual([]);
  });
});

describe("loginHops", () => {
  it("records the distinct hosts of a cross-host login, in order", () => {
    expect(loginHops(`https://${SF[0]}/`, `https://${SF[0]}/`, `https://${SF[0]}/?login`, `https://${SF[1]}/one/one.app`))
      .toEqual(SF);
  });

  it("is undefined for a same-host login, so nothing new is recorded", () => {
    expect(loginHops("https://www.shop.example.com/", "https://shop.example.com/login", "https://shop.example.com/home")).toBeUndefined();
  });

  it("ignores missing and unparseable inputs", () => {
    expect(loginHops(null, undefined, "nonsense", "https://a.example.com/", "https://b.example.com/")).toEqual(["a.example.com", "b.example.com"]);
  });
});
