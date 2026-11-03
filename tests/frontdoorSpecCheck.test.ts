import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright";
import { generateSpec } from "../src/stages/generator.js";
import { FRONTDOOR_ENV, FRONTDOOR_REF } from "../src/stages/salesforceFrontdoor.js";

/**
 * The generated spec's frontdoor sign-in must stop on Salesforce's login page.
 *
 * Run 2026-11-02T17-24-43-232Z-d9a20fcf (R2): a revoked session sent frontdoor.jsp to the org's
 * login page (/?ec=302&startURL=...), a username-first form with no password box. The spec's
 * waitForURL accepted it, and every later step failed against the login page for an unrelated
 * reason. The step now says why, without the URL (it carried the sid).
 */
const MESSAGE = "The Salesforce org connection did not sign in: Salesforce showed its login page. The connection has expired or was revoked (another Testbench server refreshing the same connection does this). Click Connect org and run again.";

describe("emitted frontdoor sign-in step: login-page check", () => {
  let server: http.Server;
  let base = "";
  let browser: Browser;
  const GOOD = "zqcanarygoodsession0123456789";
  const BAD = "zqcanaryrevokedsession0123456789";

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/secur/frontdoor.jsp") {
        const to = u.searchParams.get("sid") === GOOD ? "/lightning/page/home" : `/?ec=302&startURL=${encodeURIComponent("/lightning/page/home")}`;
        res.writeHead(302, { Location: to });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html" });
      if (u.pathname === "/lightning/page/home") return res.end(`<main><h1>Seller Home</h1></main>`);
      // The My Domain login page, username first: no password box until the username is entered.
      return res.end(`<form><input id="username" name="username"><input type="submit" id="Login" value="Log In to Sandbox"></form>`);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** The emitted sign-in step's code, from its env check to the step's screenshot. */
  const signIn = () => {
    const spec = generateSpec({
      meta: { feature: "Home", title: "Open the app", priority: "high", sourcePrompt: "x", baseUrl: base },
      steps: [{ id: "auth-0", action: "navigate", target: { url: FRONTDOOR_REF } }],
    } as any);
    const start = spec.indexOf(`if (!process.env.${FRONTDOOR_ENV})`);
    const end = spec.indexOf("await shot(", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const AsyncFunction = Object.getPrototypeOf(async function () { /* */ }).constructor;
    return new AsyncFunction("page", "process", spec.slice(start, end));
  };
  const mint = (sid: string) => `${base}/secur/frontdoor.jsp?sid=${sid}&retURL=${encodeURIComponent("/lightning/page/home")}`;

  it("throws the connection message, without the URL or sid, when it lands on the login page", async () => {
    const page = await browser.newPage();
    try {
      const err = await signIn()(page, { env: { [FRONTDOOR_ENV]: mint(BAD) } }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toBe(MESSAGE);
      expect(err.message).not.toContain(BAD);
      expect(err.message).not.toContain(base);
    } finally {
      await page.close();
    }
  }, 60_000);

  it("passes on a good landing", async () => {
    const page = await browser.newPage();
    try {
      await signIn()(page, { env: { [FRONTDOOR_ENV]: mint(GOOD) } });
      expect(new URL(page.url()).pathname).toBe("/lightning/page/home");
    } finally {
      await page.close();
    }
  }, 60_000);
});
