import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { hasLoginGate, loginOnPage, verifySession, loginHops } from "../src/stages/hybridDiscovery.js";
import { buildLoginPrefix } from "../src/stages/ir.js";

/**
 * Two-screen logins, EXECUTED in a real Chromium (D-45, D-46; CLAUDE.md D-19 — a login is a
 * live-DOM interaction, so a fake page would only test my model of it).
 *
 * The two-screen page reproduces what Salesforce's login page actually serves (fetched for D-45):
 * a username box `type="email" autocomplete="username"`, a submit control `type="submit"` whose
 * label is "Log In to Sandbox" (which the anchored AUTH_VERB_TEXT does not match), the hidden
 * `passwordShown` input, and NO password box until the username has been submitted.
 *
 * Two hostnames are served by request routing, so a login on `login.test` that lands on
 * `app.test` is a genuine cross-host hop — the Salesforce `my.salesforce.com` →
 * `lightning.force.com` shape.
 *
 * The single-screen cases are the regression half: they must record exactly what they always did.
 * TD-40 (a `__name` helper inside page.evaluate) is invisible here by construction — vitest does
 * not inject it — so tests/twoScreenLoginUnderTsx.test.ts runs the same login under tsx.
 */

const USER = "qa@example.com";
const PASS = "right-pw";

const TWO_SCREEN = `<!doctype html><html><body>
<form id="f">
  <input type="hidden" name="passwordShown" value="false">
  <label for="username">Username</label>
  <input id="username" name="username" type="email" autocomplete="username">
  <input type="submit" id="Login" value="Log In to Sandbox">
</form>
<script>
  document.getElementById("f").addEventListener("submit", function (e) {
    e.preventDefault();
    var pw = document.getElementById("password");
    if (!pw) {
      if (document.getElementById("username").value !== ${JSON.stringify(USER)}) return; // username refused
      setTimeout(function () {
        var p = document.createElement("input");
        p.type = "password"; p.id = "password"; p.name = "pw";
        document.getElementById("f").insertBefore(p, document.getElementById("Login"));
      }, 300);
      return;
    }
    if (pw.value === ${JSON.stringify(PASS)}) location.href = "http://app.test/home";
  });
</script></body></html>`;

const ONE_SCREEN = `<!doctype html><html><body>
<form id="f">
  <input id="email" type="email" autocomplete="username" placeholder="Email">
  <input id="pw" type="password" placeholder="Password">
  <button id="go" type="submit">Sign In</button>
</form>
<script>
  document.getElementById("f").addEventListener("submit", function (e) {
    e.preventDefault();
    if (document.getElementById("pw").value === ${JSON.stringify(PASS)}) location.href = "http://login.test/dashboard";
  });
</script></body></html>`;

const APP = `<!doctype html><html><body><h1>Home</h1><a href="/accounts">Accounts</a><input type="search" aria-label="Search"></body></html>`;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });
// Short budgets: the failure paths below would otherwise sit out the 10s production default.
beforeEach(() => { process.env.AUTH_VERIFY_TIMEOUT_MS = "2500"; });
afterAll(() => { delete process.env.AUTH_VERIFY_TIMEOUT_MS; });

async function open(html: string, url = "http://login.test/"): Promise<Page> {
  const page = await browser.newPage();
  await page.route("**/*", (route) => {
    const u = new URL(route.request().url());
    const body = u.host === "app.test" ? APP
      : u.pathname === "/dashboard" ? APP
      : u.pathname === "/" ? html : "";
    return body ? route.fulfill({ contentType: "text/html", body }) : route.fulfill({ status: 404, body: "" });
  });
  await page.goto(url);
  return page;
}

const page1 = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

describe("hasLoginGate — identifier-first screens (D-45)", () => {
  it("recognises Salesforce's first screen: no password box, a lone autocomplete=username field", async () => {
    const page = await open(TWO_SCREEN);
    expect(await page.locator('input[type="password"]').count(), "sanity: no password box yet").toBe(0);
    expect(await hasLoginGate(page)).toBe(true);
    await page.close();
  }, 30_000);

  it("still recognises a single-screen login exactly as before", async () => {
    const page = await open(ONE_SCREEN);
    expect(await hasLoginGate(page)).toBe(true);
    await page.close();
  }, 30_000);

  it("does NOT treat a newsletter box (lone email + Submit, autocomplete=email) as a login", async () => {
    const page = await open(page1(`<form><input type="email" name="email" autocomplete="email" placeholder="Your email">
      <button type="submit">Submit</button></form>`));
    expect(await hasLoginGate(page)).toBe(false);
    await page.close();
  }, 30_000);

  it("does NOT treat a profile form as a login just because it has an autocomplete=username field", async () => {
    const page = await open(page1(`<form><input id="u" autocomplete="username"><input id="d" name="display">
      <input id="e" type="email"><button type="submit">Save</button></form>`));
    expect(await hasLoginGate(page)).toBe(false);
    await page.close();
  }, 30_000);

  it("does NOT treat a lone username field with no submit control as a login", async () => {
    const page = await open(page1(`<input autocomplete="username">`));
    expect(await hasLoginGate(page)).toBe(false);
    await page.close();
  }, 30_000);
});

describe("loginOnPage — two screens recorded and replayed (D-46)", () => {
  it("fills the username, submits, waits for the password, then fills and submits it", async () => {
    const page = await open(TWO_SCREEN);
    const steps = await loginOnPage(page, { username: USER, password: PASS });
    expect(steps).toEqual([
      { action: "fill", css: "#username", credential: "username" },
      { action: "click", css: "#Login" },
      { action: "waitFor", css: "#password" },
      { action: "fill", css: "#password", credential: "password" },
      { action: "click", css: "#Login" },
    ]);
    expect(await verifySession(page, "http://login.test/"), "the login landed on the app").toBe(true);
    expect(new URL(page.url()).host).toBe("app.test");
    await page.close();
  }, 30_000);

  it("records the cross-host hop as related hosts (D-47)", async () => {
    const page = await open(TWO_SCREEN);
    await loginOnPage(page, { username: USER, password: PASS });
    await verifySession(page, "http://login.test/");
    expect(loginHops("http://login.test/", "http://login.test/", page.url())).toEqual(["login.test", "app.test"]);
    // A same-host login records nothing — its AppModel stays byte-identical.
    expect(loginHops("http://login.test/", "http://login.test/", "http://login.test/dashboard")).toBeUndefined();
    await page.close();
  }, 30_000);

  it("a refused username yields no login (the password box never appears)", async () => {
    const page = await open(TWO_SCREEN);
    expect(await loginOnPage(page, { username: "nobody@example.com", password: PASS })).toBeNull();
    expect(await hasLoginGate(page), "still on the username screen").toBe(true);
    await page.close();
  }, 30_000);

  it("a wrong password is recorded as attempted and fails verification", async () => {
    const page = await open(TWO_SCREEN);
    const steps = await loginOnPage(page, { username: USER, password: "wrong" });
    expect(steps?.map((s) => s.action)).toEqual(["fill", "click", "waitFor", "fill", "click"]);
    expect(await verifySession(page, "http://login.test/")).toBe(false);
    await page.close();
  }, 30_000);

  it("REGRESSION: a single-screen login records exactly the steps it always did", async () => {
    const page = await open(ONE_SCREEN);
    const steps = await loginOnPage(page, { username: USER, password: PASS });
    expect(steps).toEqual([
      { action: "fill", css: "#email", credential: "username" },
      { action: "fill", css: "#pw", credential: "password" },
      { action: "click", css: "#go" },
    ]);
    expect(await verifySession(page, "http://login.test/")).toBe(true);
    await page.close();
  }, 30_000);
});

describe("buildLoginPrefix — the two-screen record becomes replayable IR (D-46)", () => {
  const auth = (loginSteps: any[]) => ({ status: "authenticated", loginUrl: "http://login.test/", url: "http://app.test/home", loginSteps } as any);

  it("turns waitFor into an auto-waiting visible assertion on the password box", () => {
    const prefix = buildLoginPrefix(auth([
      { action: "fill", css: "#username", credential: "username" },
      { action: "click", css: "#Login" },
      { action: "waitFor", css: "#password" },
      { action: "fill", css: "#password", credential: "password" },
      { action: "click", css: "#Login" },
    ]));
    expect(prefix.map((s) => [s.id, s.action, s.target?.css ?? s.target?.url, s.assertion ?? s.value ?? null])).toEqual([
      ["auth-0", "navigate", "http://login.test/", null],
      ["auth-1", "fill", "#username", "${env:TEST_USERNAME}"],
      ["auth-2", "click", "#Login", null],
      ["auth-3", "assert", "#password", "visible"],
      ["auth-4", "fill", "#password", "${env:TEST_PASSWORD}"],
      ["auth-5", "click", "#Login", null],
      ["auth-6", "assert", "#password", "hidden"],
    ]);
  });

  it("REGRESSION: a single-screen record builds the same prefix as before", () => {
    const prefix = buildLoginPrefix(auth([
      { action: "fill", css: "#email", credential: "username" },
      { action: "fill", css: "#pw", credential: "password" },
      { action: "click", css: "#go" },
    ]));
    expect(prefix.map((s) => [s.id, s.action, s.target?.css ?? s.target?.url, s.assertion ?? null])).toEqual([
      ["auth-0", "navigate", "http://login.test/", null],
      ["auth-1", "fill", "#email", null],
      ["auth-2", "fill", "#pw", null],
      ["auth-3", "click", "#go", null],
      ["auth-4", "assert", "#pw", "hidden"],
    ]);
  });
});
