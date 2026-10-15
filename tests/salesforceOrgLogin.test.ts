import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import {
  classifyOrg, orgRefusal, assertTestOrg, blockLoginAds, reachUsernameForm, waitForOneScreenPassword,
  describeLoginFailure, codeEntryField, LOGIN_FAILURE, SALESFORCE_AD_HOST,
} from "../src/stages/salesforceOrgLogin.js";
import { loginOnPage } from "../src/stages/hybridDiscovery.js";

/**
 * Salesforce org login hardening (salesforceOrgLogin.ts), executed in real Chromium (D-19).
 *
 * No live org: every login screen here is synthetic HTML modelled on the shapes the brief describes
 * — one screen, two screens, email-first with a "Log In with Username" switch, a slow one-screen
 * form — served through `page.route` on real Salesforce-shaped hosts, so `page.url()` is what it
 * would be against an org. Nothing touches the network.
 */

const SANDBOX = "https://acme--uat.sandbox.my.salesforce.com";
const SCRATCH = "https://ruby-data-2200-dev-ed.scratch.my.salesforce.com";
const PROD = "https://acme.my.salesforce.com";

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });

/** A fresh page that answers every request with `html` (or `routes[url]`), so nothing leaves the box. */
async function pageServing(html: string, routes: Record<string, string> = {}): Promise<Page> {
  const page = await browser.newPage();
  await page.route("**/*", (route) => {
    const body = routes[route.request().url()] ?? html;
    return route.fulfill({ status: 200, contentType: "text/html", body: `<!doctype html><html><body>${body}</body></html>` });
  });
  return page;
}

describe("classifyOrg — the production guard's input (test 5)", () => {
  it("scratch, sandbox, production and nonsense", () => {
    expect(classifyOrg(SCRATCH)).toBe("scratch");
    expect(classifyOrg(SANDBOX)).toBe("sandbox");
    expect(classifyOrg("https://acme--uat.sandbox.lightning.force.com/lightning/page/home")).toBe("sandbox");
    expect(classifyOrg(PROD)).toBe("production");
    expect(classifyOrg("not a url")).toBe("unknown");
    expect(classifyOrg("https://example.com")).toBe("unknown");
  });

  it("fails closed on hosts the brief accepts losing for now", () => {
    for (const u of ["https://login.salesforce.com", "https://test.salesforce.com", "https://cs42.salesforce.com",
      "https://acme-dev-ed.develop.my.salesforce.com"]) {
      expect(["production", "unknown"]).toContain(classifyOrg(u));
      expect(orgRefusal(u)).not.toBeNull();
    }
  });

  it("a .sandbox. label outside Salesforce's own domains is NOT a sandbox", () => {
    expect(classifyOrg("https://evil.sandbox.example.com")).toBe("unknown");
  });

  it("the refusal names the host and why; scratch and sandbox pass", () => {
    expect(orgRefusal(SANDBOX)).toBeNull();
    expect(orgRefusal(SCRATCH)).toBeNull();
    expect(orgRefusal(PROD)).toMatch(/^Testbench only runs against Salesforce scratch orgs and sandboxes\. acme\.my\.salesforce\.com doesn't look like either\. It is a production My Domain/);
    expect(orgRefusal("https://test.salesforce.com")).toContain("test.salesforce.com");
    expect(() => assertTestOrg(PROD)).toThrow(/acme\.my\.salesforce\.com/);
    expect(() => assertTestOrg(SANDBOX)).not.toThrow();
  });
});

describe("blockLoginAds — one host, nothing else (test 11)", () => {
  it("aborts c.salesforce.com and leaves every other host — edgesuite.net included — alone", async () => {
    // A fresh page per address: an aborted navigation leaves the page on Chromium's error page,
    // which would interrupt the next navigation and fail the test for the wrong reason.
    const blocked = await pageServing("ok");
    await blockLoginAds(blocked); // registered after the catch-all, so it wins for its own host
    await expect(blocked.goto(`https://${SALESFORCE_AD_HOST}/ad.js`)).rejects.toThrow();
    await blocked.close();
    for (const u of ["https://a248.e.akamai.net.edgesuite.net/x", "https://cdn.example.com/", `${SANDBOX}/`]) {
      const page = await pageServing("ok");
      await blockLoginAds(page);
      const res = await page.goto(u);
      expect(res?.status(), u).toBe(200);
      await page.close();
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Synthetic login screens
// ---------------------------------------------------------------------------------------------

const USERNAME_FORM = `
  <form onsubmit="event.preventDefault(); window.__submits=(window.__submits||0)+1">
    <input id="username" name="username" type="email" autocomplete="username">
    <input id="password" name="pw" type="password">
    <input id="Login" name="Login" type="submit" value="Log In to Sandbox">
  </form>`;

/** Email-first: an email box (optionally ALSO id="username" — the trap) and the switch link. */
const emailFirst = (emailHasUsernameId: boolean) => `
  <div id="screen">
    <input ${emailHasUsernameId ? 'id="username"' : 'id="email"'} type="email" name="email">
    <button type="button">Continue</button>
    <a href="#" id="switch" onclick="event.preventDefault();
      document.getElementById('screen').outerHTML = ${JSON.stringify(USERNAME_FORM).replace(/"/g, "&quot;")};">Log In with Username</a>
  </div>`;

describe("reachUsernameForm (test 7)", () => {
  it("(a) the username form is already there → returns at once", async () => {
    const page = await pageServing(USERNAME_FORM);
    await page.goto(`${SANDBOX}/`);
    const t0 = Date.now();
    await reachUsernameForm(page, 5_000);
    expect(Date.now() - t0).toBeLessThan(1_500);
    await page.close();
  });

  it("(b) email-first with a switch link → clicks it, then finds the form", async () => {
    const page = await pageServing(emailFirst(false));
    await page.goto(`${SANDBOX}/`);
    await reachUsernameForm(page, 5_000);
    expect(await page.locator("#password").isVisible()).toBe(true);
    expect(await page.locator("#email").count()).toBe(0);
    await page.close();
  });

  it("(c) THE TRAP: the email box also has id=\"username\" → the switch link is still clicked first", async () => {
    const page = await pageServing(emailFirst(true));
    await page.goto(`${SANDBOX}/`);
    await reachUsernameForm(page, 5_000);
    // On the real form now: the switch link is gone, the password box exists, the email screen too.
    expect(await page.getByText(/log in with username/i).count()).toBe(0);
    expect(await page.locator("#password").isVisible()).toBe(true);
    expect(await page.locator('input[name="email"]').count()).toBe(0);
    await page.close();
  });

  it("(d) neither ever appears → throws, naming where it stopped (origin + path only)", async () => {
    const page = await pageServing("<h1>Maintenance</h1>");
    await page.goto(`${SANDBOX}/secur/frontdoor.jsp?sid=SECRET`);
    const err = await reachUsernameForm(page, 1_000).catch((e) => e);
    expect(String(err?.message)).toContain(`${SANDBOX}/secur/frontdoor.jsp`);
    expect(String(err?.message)).not.toContain("SECRET");
    await page.close();
  });
});

// ---------------------------------------------------------------------------------------------
// The login itself — loginOnPage, unchanged, with and without the Salesforce preparation
// ---------------------------------------------------------------------------------------------

const CREDS = { username: "tester@acme.com.uat", password: "pw-123" };

/** Two screens: only the username box until it is submitted, then a password screen. */
const TWO_SCREEN = `
  <form id="f" onsubmit="event.preventDefault(); window.__submits=(window.__submits||0)+1;
    if (!document.getElementById('password')) {
      document.getElementById('f').insertAdjacentHTML('afterbegin', '<input id=&quot;password&quot; name=&quot;pw&quot; type=&quot;password&quot;>');
    }">
    <input id="username" name="username" type="email" autocomplete="username">
    <input id="Login" type="submit" value="Next">
  </form>`;

/** One screen whose password box draws 1.5s after the username box — the race. */
const SLOW_ONE_SCREEN = `
  <form id="f" onsubmit="event.preventDefault(); window.__submits=(window.__submits||0)+1;
    window.__pwAtSubmit=(window.__pwAtSubmit||[]).concat([(document.getElementById('password')||{}).value||'']);">
    <input id="username" name="username" type="email" autocomplete="username">
    <input id="Login" type="submit" value="Log In">
  </form>
  <script>setTimeout(function () {
    document.getElementById('username').insertAdjacentHTML('afterend', '<input id="password" name="pw" type="password">');
  }, 1500);</script>`;

const submits = (page: Page) => page.evaluate(() => (window as any).__submits ?? 0);

describe("signing in on the screen it is shown (test 8)", () => {
  it("(a) one screen → one submit", async () => {
    const page = await pageServing(USERNAME_FORM);
    await page.goto(`${SANDBOX}/`);
    await reachUsernameForm(page, 5_000);
    expect(await waitForOneScreenPassword(page)).toBe(true);
    await loginOnPage(page, CREDS);
    expect(await submits(page)).toBe(1);
    expect(await page.locator("#password").inputValue()).toBe(CREDS.password);
    await page.close();
  });

  it("(b) two screens → two submits, the password typed on the second", async () => {
    const page = await pageServing(TWO_SCREEN);
    await page.goto(`${SANDBOX}/`);
    await reachUsernameForm(page, 5_000);
    expect(await waitForOneScreenPassword(page, 600)).toBe(false);
    await loginOnPage(page, CREDS);
    expect(await submits(page)).toBe(2);
    expect(await page.locator("#password").inputValue()).toBe(CREDS.password);
    await page.close();
  }, 30_000);

  it("(c) THE RACE: a one-screen form whose password box draws late is still signed in as ONE screen, never with an empty password", async () => {
    const page = await pageServing(SLOW_ONE_SCREEN);
    await page.goto(`${SANDBOX}/`);
    await reachUsernameForm(page, 5_000);
    expect(await waitForOneScreenPassword(page)).toBe(true); // the Salesforce preparation waited it out
    await loginOnPage(page, CREDS);
    expect(await submits(page)).toBe(1);
    const pwAtSubmit = await page.evaluate(() => (window as any).__pwAtSubmit);
    expect(pwAtSubmit).toEqual([CREDS.password]);
    await page.close();
  }, 30_000);

  it("(c, control) WITHOUT the preparation the same page is submitted with an EMPTY password first — the bug the wait prevents", async () => {
    const page = await pageServing(SLOW_ONE_SCREEN);
    await page.goto(`${SANDBOX}/`);
    await page.waitForSelector("#username");
    await loginOnPage(page, CREDS).catch(() => null);
    const pwAtSubmit: string[] = await page.evaluate(() => (window as any).__pwAtSubmit ?? []);
    expect(pwAtSubmit[0]).toBe("");
    await page.close();
  }, 30_000);
});

// ---------------------------------------------------------------------------------------------
// Explaining a failed login (test 9)
// ---------------------------------------------------------------------------------------------

describe("describeLoginFailure — the reason, from the page's structure", () => {
  it("still on the form → credentials not accepted, with the sandbox hint on a sandbox", async () => {
    const page = await pageServing(USERNAME_FORM + "<div id='error'>Please check your username and password.</div>");
    await page.goto(`${SANDBOX}/`);
    expect(await describeLoginFailure(page, SANDBOX)).toBe(LOGIN_FAILURE.badCredentials + LOGIN_FAILURE.sandboxHint);
    expect(await describeLoginFailure(page, SCRATCH)).toBe(LOGIN_FAILURE.badCredentials);
    await page.close();
  });

  it("a lone code box → verification code", async () => {
    const page = await pageServing(`<form><input id="emc" type="tel" maxlength="6"><button type="submit">Verify</button></form>`);
    await page.goto(`${SANDBOX}/_ui/identity/verification/method/EmailVerificationFinishUi`);
    expect(await codeEntryField(page)).not.toBeNull();
    expect(await describeLoginFailure(page, SANDBOX)).toBe(LOGIN_FAILURE.verification);
    await page.close();
  });

  it("two password boxes → forced password change", async () => {
    const page = await pageServing(`<form><input type="password" id="newpassword"><input type="password" id="confirmpassword"><button type="submit">Change Password</button></form>`);
    await page.goto(`${SANDBOX}/_ui/system/security/ChangePassword`);
    expect(await describeLoginFailure(page, SANDBOX)).toBe(LOGIN_FAILURE.passwordChange);
    await page.close();
  });

  it("the address left Salesforce → single sign-on, naming where it went", async () => {
    const page = await pageServing(`<form><input type="email"><button type="submit">Next</button></form>`);
    await page.goto("https://acme.okta.example/login");
    expect(await describeLoginFailure(page, SANDBOX)).toBe(LOGIN_FAILURE.sso("acme.okta.example"));
    await page.close();
  });

  it("none of these → null, so the caller keeps its own sentence", async () => {
    const page = await pageServing("<h1>Something unexpected</h1>");
    await page.goto(`${SANDBOX}/lightning/page/home`);
    expect(await describeLoginFailure(page, SANDBOX)).toBeNull();
    await page.close();
  });
});
