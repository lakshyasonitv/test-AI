import { describe, it, expect } from "vitest";
import {
  keepErrorStatusSnapshot, landedOnAlreadyModelled, collectCrawlTargets,
} from "../src/stages/hybridDiscovery.js";

/**
 * The two bugs that made the crawl unable to add a click-discovered page — TECH_DEBT.md TD-103.
 *
 * HISTORY, because it is the point. A filter widening (`nav` -> `nav || header`, so the cart becomes
 * a click candidate) shipped alone, changed nothing in production across four authenticated runs, and
 * was reverted. Instrumenting the crawl showed why: the probe was already finding the cart's URL.
 * Two layers below it, the page was being thrown away twice over.
 *
 *  1. **A direct GET of a client-side route 404s.** Measured on saucedemo, signed in:
 *     `GET /cart.html` -> 404 with the REAL cart in the body (14 elements, a Checkout button), and
 *     `GET /inventory.html` -> 404 as well — the page the tests run against. Only `/` is fetchable.
 *     `snapshot` treated any `status >= 400` as fatal, so the page it had just successfully rendered
 *     was discarded.
 *
 *  2. **`visited` was poisoned at queue time.** `collectCrawlTargets` adds a URL to `visited` when it
 *     QUEUES it; the loop then rejected it at DEQUEUE with `visited.has(finalKey)`. For any URL that
 *     does not redirect those are the same string, so every honest page was dropped. It only ever
 *     appeared to work on sites whose URLs redirect.
 *
 * All three changes are required and any one alone does nothing — which is exactly why the first
 * attempt looked like a no-op. Measured end to end: saucedemo **2 -> 3 pages** with the cart
 * included; `qa-practice.com` stays at **5 real pages**.
 */

describe("keepErrorStatusSnapshot", () => {
  it("keeps a 404 that rendered, when a click already proved the page exists", () => {
    // The saucedemo cart, exactly as measured: 404 from the server, 14 elements in the DOM.
    expect(keepErrorStatusSnapshot(404, 14, true)).toBe(true);
  });

  it("REJECTS a 404 that came from an href — a dead link is a dead link", () => {
    // The regression this flag exists to prevent. Accepting any 4xx that rendered something was
    // measured against qa-practice.com and admitted index.html / index_v2.html — real dead links
    // whose 404 pages carry one element — which then displaced real pages in the model.
    expect(keepErrorStatusSnapshot(404, 1, false)).toBe(false);
    expect(keepErrorStatusSnapshot(404, 14, false)).toBe(false);
  });

  it("rejects a click-discovered 4xx that rendered nothing", () => {
    // A route that genuinely no longer exists. `clientRouted` buys trust in the BODY, not a blanket
    // pass — without this an empty error page becomes a page in the model.
    expect(keepErrorStatusSnapshot(404, 0, true)).toBe(false);
  });

  it("is unchanged for every ordinary success, regardless of provenance", () => {
    for (const clientRouted of [true, false]) {
      expect(keepErrorStatusSnapshot(200, 14, clientRouted)).toBe(true);
      expect(keepErrorStatusSnapshot(200, 0, clientRouted)).toBe(true);   // emptiness is the loop's call
      expect(keepErrorStatusSnapshot(304, 5, clientRouted)).toBe(true);
    }
  });

  it("treats 5xx like 4xx — a server error is not a client-side route unless a click proved it", () => {
    expect(keepErrorStatusSnapshot(500, 14, false)).toBe(false);
    expect(keepErrorStatusSnapshot(500, 14, true)).toBe(true);
  });
});

describe("landedOnAlreadyModelled", () => {
  it("does NOT reject a page that landed exactly where it was asked to go", () => {
    // THE regression. collectCrawlTargets has already put this URL in `visited` by queueing it, so
    // the old `visited.has(finalKey)` was true here and the page was thrown away.
    const visited = new Set<string>();
    const queued = collectCrawlTargets(
      ["https://www.saucedemo.com/cart.html"], "https://www.saucedemo.com/", visited,
    );
    expect(queued).toEqual(["https://www.saucedemo.com/cart.html"]);
    expect(visited.has("https://www.saucedemo.com/cart.html"),
      "collectCrawlTargets should still mark it queued").toBe(true);

    expect(landedOnAlreadyModelled(queued[0], queued[0], visited),
      "a non-redirecting page was rejected for the visited entry its own queueing added").toBe(false);
  });

  it("still rejects an auth-wall bounce — the case the guard exists for", () => {
    // Asked for the cart, got redirected to a login page that is already modelled.
    const visited = new Set(["https://app.example/login", "https://app.example/cart"]);
    expect(landedOnAlreadyModelled("https://app.example/login", "https://app.example/cart", visited))
      .toBe(true);
  });

  it("accepts a redirect to somewhere NOT yet modelled", () => {
    const visited = new Set(["https://app.example/cart"]);
    expect(landedOnAlreadyModelled("https://app.example/cart/items", "https://app.example/cart", visited))
      .toBe(false);
  });

  it("ignores the hash, so /cart#top landing on /cart is the same page", () => {
    const visited = new Set(["https://app.example/cart"]);
    expect(landedOnAlreadyModelled("https://app.example/cart#top", "https://app.example/cart", visited))
      .toBe(false);
  });

  it("handles a trailing-slash redirect, which is why the old check ever looked correct", () => {
    // Django-style APPEND_SLASH. `/x` -> `/x/` differs from the queued URL, so the old buggy check
    // let these through — and a link-based crawl therefore looked healthy while a click-discovered
    // page could never be added. Not yet modelled, so it must be kept.
    const visited = new Set(["https://app.example/x"]);
    expect(landedOnAlreadyModelled("https://app.example/x/", "https://app.example/x", visited))
      .toBe(false);
  });
});
