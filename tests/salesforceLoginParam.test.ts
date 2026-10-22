import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";

/**
 * D-59 — SALESFORCE_LOGIN_PARAM: the generated test opens the login URL with `?login` and runs one
 * straight-line two-screen login. The emitted text is checked, then EXECUTED in real Chromium
 * (D-19) against synthetic Salesforce pages served by `page.route` — no network, no org.
 */

const ORG = "https://ruby-data-2200-dev-ed.scratch.my.salesforce.com";
const LIGHTNING = "https://ruby-data-2200-dev-ed.scratch.lightning.force.com/one/one.app";

const IR: any = {
  meta: { feature: "Login", title: "t", priority: "high", sourcePrompt: "p", baseUrl: ORG, fixedLogin: "salesforce" },
  steps: [
    { id: "auth-0", action: "navigate", target: { url: `${ORG}/` } },
    { id: "auth-1", action: "fill", target: { css: "#username" }, value: "${env:TEST_USERNAME}" },
    { id: "auth-2", action: "click", target: { css: "#Login" } },
    { id: "auth-3", action: "assert", target: { css: "#password" }, assertion: "visible" },
    { id: "auth-4", action: "fill", target: { css: "#password" }, value: "${env:TEST_PASSWORD}" },
    { id: "auth-5", action: "click", target: { css: "#Login" } },
    { id: "auth-6", action: "assert", target: { css: "#password" }, assertion: "hidden" },
    { id: "s1", action: "assert", target: { role: "heading", name: "Home" }, assertion: "visible" },
  ],
};

function extract(src: string, name: string): string {
  let start = src.indexOf(`async function ${name}(`);
  if (start < 0) start = src.indexOf(`function ${name}(`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} not found`);
}

const loginPage = (inner: string, script: string) => `<html><body><form onsubmit="return false">${inner}
<input id="Login" type="submit" value="Log In to Sandbox"></form><script>${script}</script></body></html>`;

/** What the user saw on `…/?login`: username, "Log In to Sandbox", then the password screen. */
const TWO_SCREEN = loginPage(`<input id="username" type="email">`, `
document.getElementById("Login").addEventListener("click", function () {
  if (!document.getElementById("password")) {
    var p = document.createElement("input"); p.id = "password"; p.type = "password";
    document.forms[0].insertBefore(p, document.getElementById("Login"));
    return;
  }
  if (document.getElementById("password").value === "s3cret-pass") location.href = "${LIGHTNING}";
});`);

/** The password is refused: the second screen stays up. */
const WRONG_PASSWORD = TWO_SCREEN.replace('"s3cret-pass"', '"never-this"');

/** Not a login page at all (the ?login address showed something else). */
const NO_FORM = `<html><body><h1>Something else</h1></body></html>`;

const HOME = `<html><body><h1>Home</h1></body></html>`;

let browser: Browser;
let salesforceLogin: (page: Page, url: string) => Promise<void>;
let specOn: string;

async function newPage(body: string, seen: string[]): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.route(() => true, async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === ORG) { seen.push(url.href); return route.fulfill({ contentType: "text/html", body }); }
    if (url.origin === new URL(LIGHTNING).origin) return route.fulfill({ contentType: "text/html", body: HOME });
    return route.fulfill({ status: 404, body: "" });
  });
  return page;
}

beforeAll(async () => {
  process.env.SALESFORCE_FIXED_LOGIN = "true";
  process.env.SALESFORCE_LOGIN_PARAM = "true";
  const { generateSpec } = await import("../src/stages/generator.js");
  specOn = generateSpec(IR);
  const code = ["salesforceWhere", "salesforceLoginFailure", "salesforceLogin"].map((n) => extract(specOn, n)).join("\n");
  // eslint-disable-next-line no-new-func
  salesforceLogin = new Function(`${code}\nreturn salesforceLogin;`)();
  process.env.TEST_USERNAME = "udit@example.com";
  process.env.TEST_PASSWORD = "s3cret-pass";
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  for (const v of ["TEST_USERNAME", "TEST_PASSWORD", "SALESFORCE_FIXED_LOGIN", "SALESFORCE_LOGIN_PARAM"]) delete process.env[v];
});

describe("withLoginParam", () => {
  it("adds ?login, or &login after an existing query, and never twice", async () => {
    const { withLoginParam } = await import("../src/stages/generator.js");
    expect(withLoginParam(`${ORG}/`)).toBe(`${ORG}/?login`);
    expect(withLoginParam(ORG)).toBe(`${ORG}/?login`);
    expect(withLoginParam(`${ORG}/?startURL=%2Fhome`)).toBe(`${ORG}/?startURL=%2Fhome&login`);
    expect(withLoginParam(`${ORG}/?login`)).toBe(`${ORG}/?login`);
    expect(withLoginParam("not a url")).toBe("not a url");
  });
});

describe("the emitted spec", () => {
  it("opens the pinned ?login link and uses the straight-line script", () => {
    expect(specOn).toContain(`await salesforceLogin(page, "${ORG}/?login");`);
    expect(specOn).toContain("Log in to Salesforce (fixed login, ?login page)");
    expect(specOn).not.toContain("log in with username"); // no email-first loop in this mode
    expect(specOn).toContain("function salesforceLoginFailure(page, fallback)");
  });

  it("SALESFORCE_LOGIN_PARAM off: exactly the D-57 spec", async () => {
    const { generateSpec } = await import("../src/stages/generator.js");
    process.env.SALESFORCE_LOGIN_PARAM = "false";
    const off = generateSpec(IR);
    delete process.env.SALESFORCE_LOGIN_PARAM;
    const unset = generateSpec(IR);
    process.env.SALESFORCE_LOGIN_PARAM = "true";
    expect(off).toBe(unset);
    expect(off).toContain(`await salesforceLogin(page, "${ORG}/");`);
    expect(off).toContain("log in with username");
  });

  it("SALESFORCE_FIXED_LOGIN off: the param alone changes nothing", async () => {
    const { generateSpec } = await import("../src/stages/generator.js");
    process.env.SALESFORCE_FIXED_LOGIN = "false";
    const withParam = generateSpec(IR);
    delete process.env.SALESFORCE_LOGIN_PARAM;
    const without = generateSpec(IR);
    process.env.SALESFORCE_FIXED_LOGIN = "true";
    process.env.SALESFORCE_LOGIN_PARAM = "true";
    expect(withParam).toBe(without);
    expect(withParam).not.toContain("salesforceLogin(");
  });
});

describe("the straight-line login, in Chromium", () => {
  it("two screens: opens ?login, username, Log In, password, Log In, lands on Lightning", async () => {
    const seen: string[] = [];
    const page = await newPage(TWO_SCREEN, seen);
    await salesforceLogin(page, `${ORG}/?login`);
    expect(page.url()).toBe(LIGHTNING);
    expect(seen[0]).toBe(`${ORG}/?login`);
    await page.context().close();
  }, 60_000);

  it("wrong password: says the login was not accepted, never prints the password", async () => {
    const page = await newPage(WRONG_PASSWORD, []);
    const err = await salesforceLogin(page, `${ORG}/?login`).catch((e) => e);
    expect(String(err?.message)).toMatch(/^Salesforce login: still on the login form after submitting/);
    expect(String(err?.message)).not.toContain("s3cret-pass");
    await page.context().close();
  }, 60_000);

  it("no username box on the ?login page: stops and names where it was", async () => {
    const page = await newPage(NO_FORM, []);
    const err = await salesforceLogin(page, `${ORG}/?login`).catch((e) => e);
    expect(String(err?.message)).toMatch(/\?login page did not show a username box within 20s\. Still at https:\/\/ruby-data/);
    await page.context().close();
  }, 60_000);
});
