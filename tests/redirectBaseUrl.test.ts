import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { siteHost } from "../src/text.js";
import { isSameSite } from "../src/stages/executor.js";
import { groundingError } from "../src/stages/ir.js";
import { AppModel } from "../src/schema/appModel.js";
import { landedOrigin, withLandedBase } from "../src/stages/hybridDiscovery.js";
import { IR } from "../src/schema/ir.js";

/**
 * The entry URL's scheme must not decide whether a real page exists — TECH_DEBT.md TD-82.
 *
 * THE FAILURE. Run `2026-09-06T15-42-48-000Z-61e01731`. The user entered
 * `http://veterans.my.site.com/s/`; the site redirects to `https://`, so every discovered
 * `page.url` is `https://…` while `appModel.baseUrl` kept the typed `http://…`. `navUrlAllowed`
 * resolved a navigate to `/s/` against the http base and looked it up in a set keyed by
 * `origin + path`, so `http://…/s` missed `https://…/s` and a CORRECT step was refused:
 *
 *     Step s4 navigates to "/s/", which is not a page or link destination present in the
 *     application model … Known paths: /s/, /vetforce/s/login/.
 *
 * The hint lists the very path it rejects — a message the model cannot act on, so it re-sent the
 * same answer until the attempt budget was gone. Same root cause as TD-69's `detectBlocked`
 * bug, one layer deeper.
 *
 * The fixture is that run's real `02-appmodel.json`, trimmed to what the guard reads and
 * committed so this is reproducible without `runs/` (which is gitignored).
 */

const model = AppModel.parse(JSON.parse(
  readFileSync("tests/fixtures/redirectBaseUrl/02-appmodel.json", "utf8")));

const irWith = (steps: unknown[]) => IR.parse({
  meta: {
    feature: "Navigation", title: "Comprehensive end-to-end portal verification",
    priority: "high", sourcePrompt: "test this website end to end",
    baseUrl: "http://veterans.my.site.com",
  },
  steps,
});

describe("siteHost — one definition for every same-site comparison", () => {
  it("ignores scheme, port and www", () => {
    expect(siteHost("http://example.com/a")).toBe("example.com");
    expect(siteHost("https://example.com/a")).toBe("example.com");
    expect(siteHost("https://www.example.com")).toBe("example.com");
    expect(siteHost("https://WWW.Example.COM:8443/x")).toBe("example.com");
  });

  it("returns null for something unparseable, so callers can fall to their permissive side", () => {
    expect(siteHost("not a url")).toBeNull();
    expect(siteHost("")).toBeNull();
  });

  it("does not strip a host that merely STARTS with www", () => {
    // `wwwfoo.com` is not `foo.com`. A naive replace(/www/,"") would say it is.
    expect(siteHost("https://wwwfoo.com")).toBe("wwwfoo.com");
  });

  it("is what isSameSite is built on, so the two cannot drift", () => {
    expect(isSameSite("http://veterans.my.site.com/s/", "https://veterans.my.site.com")).toBe(true);
    expect(isSameSite("https://evil.example", "https://veterans.my.site.com")).toBe(false);
  });
});

describe("the navigate guard, against the AppModel that actually failed", () => {
  it("still refuses a genuinely invented route — the guard is not simply switched off", () => {
    const err = groundingError(irWith([
      { id: "s1", action: "navigate", target: { url: "/s/" } },
      { id: "s2", action: "navigate", target: { url: "/not-a-real-route/" } },
    ]), model);
    expect(err?.kind).toBe("navigate-url");
    expect(err?.index).toBe(1);
  });

  it("accepts the path the run rejected — the whole defect", () => {
    // `/s/` IS a discovered page; only its scheme differed from the entered one.
    expect(groundingError(irWith([
      { id: "s1", action: "navigate", target: { url: "/s/" } },
      { id: "s2", action: "click", target: { role: "menuitem", name: "How it Works" } },
      { id: "s4", action: "navigate", target: { url: "/s/" } },
    ]), model)).toBeNull();
  });

  it("accepts the other discovered path too, at an index the guard actually checks", () => {
    // Index 0 is exempt (it is the entry URL the pipeline supplied), so this has to be later
    // or the test proves nothing — which is exactly why grounding the SAVED truncated IR looked
    // like a pass even before the fix.
    expect(groundingError(irWith([
      { id: "s1", action: "navigate", target: { url: "/s/" } },
      { id: "s2", action: "navigate", target: { url: "/vetforce/s/login/" } },
    ]), model)).toBeNull();
  });

  it("ignores a trailing-slash difference", () => {
    expect(groundingError(irWith([
      { id: "s1", action: "navigate", target: { url: "/s/" } },
      { id: "s2", action: "navigate", target: { url: "/vetforce/s/login" } },
    ]), model)).toBeNull();
  });

  it("still treats a different host as off-site and leaves it alone", () => {
    // Off-site is a separate concern; this guard is about invented routes on the app itself.
    expect(groundingError(irWith([
      { id: "s1", action: "navigate", target: { url: "/s/" } },
      { id: "s2", action: "navigate", target: { url: "https://example.org/anything" } },
    ]), model)).toBeNull();
  });
});

describe("the rejection hint", () => {
  const hintFor = (url: string) => groundingError(irWith([
    { id: "s1", action: "navigate", target: { url: "/s/" } },
    { id: "s2", action: "navigate", target: { url } },
  ]), model)?.message ?? "";

  it("never lists the path it is rejecting", () => {
    // The original message refused "/s/" and then offered "/s/" as a known path. A hint that
    // contradicts its own verdict is worse than none: the model cannot act on it.
    const msg = hintFor("/vetforce/s/login/x/");
    expect(msg).toContain("is not a page or link destination");
    expect(msg).toMatch(/Known paths:/);
    expect(msg).not.toMatch(/Known paths:[^.]*\/vetforce\/s\/login\/x/);
  });

  it("offers the paths that ARE known", () => {
    expect(hintFor("/nope/")).toContain("/s/");
  });

  it("says so plainly when removing the rejected path leaves nothing to suggest", () => {
    const onePage = AppModel.parse({
      baseUrl: "http://only.example.com",
      pages: [{ url: "https://only.example.com/dash", title: "d", concepts: [], elements: [] }],
    });
    const err = groundingError(IR.parse({
      meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "http://only.example.com" },
      steps: [
        { id: "s1", action: "navigate", target: { url: "/dash" } },
        { id: "s2", action: "navigate", target: { url: "/dash/../dash" } },
      ],
    }), onePage);
    // "/dash/../dash" normalises to "/dash", which IS known — so this must ground, not reject.
    expect(err).toBeNull();
  });
});

describe("baseUrl is where the browser LANDED, not what was typed", () => {
  it("takes the landed origin over the entered one", () => {
    expect(landedOrigin("https://veterans.my.site.com/s/", "http://veterans.my.site.com/s/"))
      .toBe("https://veterans.my.site.com");
  });

  it("strips the PATH — baseUrl is contractually an origin", () => {
    // discoverPagesHybrid used `urls[0]` verbatim, so a base of `http://host/s/` made
    // resolveHref(base, "/x") and every page comparison resolve against a page, not the site.
    expect(landedOrigin(undefined, "http://veterans.my.site.com/s/"))
      .toBe("http://veterans.my.site.com");
  });

  it("follows apex -> www and a port change too, not just the scheme", () => {
    expect(landedOrigin("https://www.example.com/home", "https://example.com"))
      .toBe("https://www.example.com");
    expect(landedOrigin("http://localhost:4173/app", "http://localhost:5173"))
      .toBe("http://localhost:4173");
  });

  it("falls back to the entered URL when the landed one is unusable", () => {
    // An unusable base is worse than a stale one.
    expect(landedOrigin(undefined, "https://example.com")).toBe("https://example.com");
    expect(landedOrigin("", "https://example.com")).toBe("https://example.com");
    expect(landedOrigin("garbage", "https://example.com")).toBe("https://example.com");
  });

  it("records what the user typed only when it actually differs", () => {
    const base = { baseUrl: "http://x", pages: [] };
    const redirected = withLandedBase(base, "https://veterans.my.site.com/s/", "http://veterans.my.site.com/s/");
    expect(redirected.baseUrl).toBe("https://veterans.my.site.com");
    // The full entered URL, path included — it is provenance ("you asked for X, the site sent
    // you to Y"), and the origin is derivable from it while the reverse is not.
    expect(redirected.enteredUrl).toBe("http://veterans.my.site.com/s/");

    const notRedirected = withLandedBase(base, "https://example.com/a", "https://example.com");
    expect(notRedirected.baseUrl).toBe("https://example.com");
    expect(notRedirected.enteredUrl).toBeUndefined();
  });

  it("enteredUrl is additive — every AppModel already on disk still parses", () => {
    const old = AppModel.safeParse({ baseUrl: "https://e.com", pages: [] });
    expect(old.success).toBe(true);
    expect(old.success && old.data.enteredUrl).toBeUndefined();
    expect(AppModel.parse({ baseUrl: "https://e.com", enteredUrl: "http://e.com", pages: [] }).enteredUrl)
      .toBe("http://e.com");
  });

  it("a normalised model grounds the step the un-normalised one rejected", () => {
    // The end-to-end statement of the fix: with baseUrl agreeing with the pages, the guard has
    // nothing to disagree about — and this holds independently of the pageKey change, which is
    // the second line of defence for models cached before this fix.
    const normalised = AppModel.parse({ ...model, baseUrl: "https://veterans.my.site.com" });
    expect(groundingError(irWith([
      { id: "s1", action: "navigate", target: { url: "/s/" } },
      { id: "s4", action: "navigate", target: { url: "/s/" } },
    ]), normalised)).toBeNull();
  });
});
