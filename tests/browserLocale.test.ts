import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser } from "playwright";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { browserContextOptions } from "../src/browserLaunch.js";

/**
 * Locale pinning, EXECUTED — not asserted against the object we pass in.
 *
 * WHY THIS FILE EXISTS. `DECISIONS.md` D-19: a Playwright option that looks right is not verified
 * until it has been run once. `.filter({ visible: true })` shipped as a fix, passed `tsc`, passed a
 * unit test, and was a silent no-op because `Locator.filter()` has no `visible` option in this
 * project's pinned Playwright. `tests/browserContextOptions.test.ts` is exactly that kind of check
 * — it proves the OBJECT is shaped correctly and nothing more. This file proves a real Chromium
 * actually honours it.
 *
 * The installed 1.49.0 types do declare `locale`, `timezoneId` and `extraHTTPHeaders` on
 * `Browser.newPage(options?)` (`node_modules/playwright-core/types/types.d.ts:9677-10122`). That is
 * a type check, not a behaviour check, and it is the type check D-19 says is not enough.
 *
 * WHAT IS BEING PINNED.
 *   - `newPage(options)` — the route the four in-process sites use. If this ever stops working the
 *     alternative is `newContext()` + `context.newPage()`, which loses sessionStorage across pages
 *     (TD-41 / D-23) on exactly the authenticated flows live-extend replays.
 *   - `newContext(options)` — the route `hybridDiscovery`'s authenticated crawl uses.
 *   - That `locale` really does move `navigator.language`, the timezone, AND the `Accept-Language`
 *     header, so deriving the header from the locale is sound rather than merely tidy.
 *
 * SETCONTENT CANNOT SEE A HEADER. `page.setContent()` issues no HTTP request at all, so the
 * header assertion needs a real one. A throwaway `http.createServer` on port 0 provides it and
 * keeps the test hermetic — no live target site, no network beyond loopback.
 */

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

/** Loopback server that echoes back the Accept-Language it was sent. Port 0 = OS picks a free one. */
let server: Server;
let origin: string;
/** Every Accept-Language this server has been sent, in order. */
const headersSeen: string[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    headersSeen.push(String(req.headers["accept-language"] ?? ""));
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<!doctype html><html><body><p id=ok>served</p></body></html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("locale pinning — executed in a real browser (D-19)", () => {
  it("newPage(options) moves navigator.language and the timezone", async () => {
    const page = await browser.newPage(browserContextOptions("de-DE"));
    await page.setContent("<!doctype html><html><body></body></html>");

    // Everything inlined, no inner named or const-assigned functions: `tsx`/esbuild wraps a named
    // function in a `__name()` call that does not exist inside the browser, which throws only on a
    // real run and never in a unit test (TD-40). There is nothing to extract here anyway.
    const seen = await page.evaluate(() => ({
      language: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }));

    expect(seen.language).toBe("de-DE");
    expect(seen.timeZone).toBe("UTC");
    await page.close();
  }, 60_000);

  it("newPage(options) honours a non-UTC timezone", async () => {
    const saved = process.env.RUN_TIMEZONE;
    // Europe/Berlin, not Asia/Kolkata: Chromium's ICU resolves some zones to their LEGACY alias,
    // so RUN_TIMEZONE=Asia/Kolkata comes back as "Asia/Calcutta". Measured, and not a bug in this
    // code — but asserting the modern name would have made this test fail for the wrong reason.
    process.env.RUN_TIMEZONE = "Europe/Berlin";
    try {
      const page = await browser.newPage(browserContextOptions("en-US"));
      await page.setContent("<!doctype html><html><body></body></html>");
      const tz = await page.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
      expect(tz).toBe("Europe/Berlin");
      await page.close();
    } finally {
      if (saved === undefined) delete process.env.RUN_TIMEZONE;
      else process.env.RUN_TIMEZONE = saved;
    }
  }, 60_000);

  it("newContext(options) works too — the route the authenticated crawl uses", async () => {
    // hybridDiscovery's crawl already owns a context deliberately (sessionStorage is tab-scoped,
    // TD-41), so its options go on the context. Same helper, different method: prove both.
    const context = await browser.newContext(browserContextOptions("ja-JP"));
    const page = await context.newPage();
    await page.setContent("<!doctype html><html><body></body></html>");
    expect(await page.evaluate(() => navigator.language)).toBe("ja-JP");
    await context.close();
  }, 60_000);

  it("pinning the locale pins Accept-Language on a REAL request", async () => {
    // setContent issues no request, so this is the only assertion that can see a header.
    const before = headersSeen.length;
    const page = await browser.newPage(browserContextOptions("fr-FR"));
    await page.goto(origin);
    await page.close();

    const sent = headersSeen.slice(before);
    expect(sent.length).toBeGreaterThan(0);
    // The BARE tag, not a `fr-FR,fr;q=0.9` q-list. That is what Playwright derives from `locale`,
    // and it is what this codebase can actually guarantee — see the override test below.
    expect(sent[0]).toBe("fr-FR");
  }, 60_000);

  it("a DIFFERENT locale changes the header the server sees", async () => {
    const before = headersSeen.length;
    const page = await browser.newPage(browserContextOptions("es-ES"));
    await page.goto(origin);
    await page.close();
    expect(headersSeen.slice(before)[0]).toBe("es-ES");
  }, 60_000);

  /**
   * THE REGRESSION PIN. This is the measurement that changed the implementation.
   *
   * `browserContextOptions` was first written to also send
   * `extraHTTPHeaders: { "Accept-Language": "<locale>,<lang>;q=0.9" }`, so that what the site
   * receives would be visible in our own code rather than emergent from a dependency. Against a
   * real Chromium that is a silent no-op: `locale` wins and the explicit header is discarded. The
   * unit test could not see it, because the object was exactly right.
   *
   * Pinned in both directions so the next person to "improve" the header discovers it here rather
   * than in a run: with `locale`, an explicit header loses; without `locale`, the very same header
   * lands. If Playwright ever changes this, this test fails and the docblock in browserLaunch.ts
   * needs revisiting — not the other way round.
   */
  it("an explicit Accept-Language LOSES to locale, but works without it", async () => {
    const before = headersSeen.length;

    const withLocale = await browser.newPage({
      locale: "fr-FR",
      extraHTTPHeaders: { "Accept-Language": "zz-ZZ,zz;q=0.1" },
    });
    await withLocale.goto(origin);
    await withLocale.close();

    const headerOnly = await browser.newPage({
      extraHTTPHeaders: { "Accept-Language": "zz-ZZ,zz;q=0.1" },
    });
    await headerOnly.goto(origin);
    await headerOnly.close();

    const [both, headerAlone] = headersSeen.slice(before);
    expect(both).toBe("fr-FR");                  // locale wins; ours was dropped
    expect(headerAlone).toBe("zz-ZZ,zz;q=0.1");  // same header, no locale: it lands
  }, 90_000);

  it("with pinning OFF, nothing is pinned — the rollback switch really rolls back", async () => {
    const saved = process.env.RUN_LOCALE;
    process.env.RUN_LOCALE = "";
    try {
      const opts = browserContextOptions();
      expect(opts).toEqual({});             // nothing to pass
      const before = headersSeen.length;
      const page = await browser.newPage(opts);
      await page.goto(origin);
      // The host's own Accept-Language, whatever it is — deliberately NOT asserted to equal any
      // particular value, because the whole point of this state is that it is host-dependent.
      // What IS asserted: it is not the header a locale-pinned run would have sent.
      expect(headersSeen.slice(before)[0]).not.toBe("fr-FR");
      await page.close();
    } finally {
      if (saved === undefined) delete process.env.RUN_LOCALE;
      else process.env.RUN_LOCALE = saved;
    }
  }, 60_000);
});
