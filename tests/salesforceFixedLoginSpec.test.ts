import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";

/**
 * D-65 stage 2 — the fixed Salesforce login, EXECUTED in real Chromium.
 *
 * Extracted from a REAL generated spec (DECISIONS.md D-19: a check that only reads the emitted
 * string verified nothing the one time it mattered). Every Salesforce host below is answered by
 * `page.route` with a small synthetic page that behaves like the real screen — no network, no org.
 */

const ORG = "https://acme--uat.sandbox.my.salesforce.com";
const LIGHTNING = "https://acme--uat.sandbox.lightning.force.com/one/one.app";

let browser: Browser;
let salesforceLogin: (page: Page, url: string) => Promise<void>;
let spec: string;

/** Pull `async function NAME(...) {...}` (or a plain `function`) out of the generated spec. */
function extract(src: string, name: string): string {
  let start = src.indexOf(`async function ${name}(`);
  if (start < 0) start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`generated spec has no ${name}`);
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

const HOME = `<html><body><h1>Home</h1></body></html>`;

/** A login page. `submitJs` runs when Log In is clicked and decides what happens next. */
const loginPage = (inner: string, submitJs: string) => `<html><body>
<form onsubmit="return false">${inner}<button id="Login" type="submit">Log In to Sandbox</button></form>
<script>
window.__submits = [];
document.getElementById("Login").addEventListener("click", function () {
  var u = document.getElementById("username"); var p = document.getElementById("password");
  window.__submits.push({ u: u ? u.value : null, p: p ? p.value : null });
  ${submitJs}
});
</script></body></html>`;

const ONE_SCREEN = loginPage(
  `<input id="username" type="email" autocomplete="username"><input id="password" type="password">`,
  `location.href = "${LIGHTNING}";`);

const TWO_SCREEN = loginPage(
  `<input id="username" type="email" autocomplete="username">`,
  `if (!document.getElementById("password")) {
     var p = document.createElement("input"); p.id = "password"; p.type = "password";
     document.forms[0].insertBefore(p, document.getElementById("Login"));
   } else { location.href = "${LIGHTNING}"; }`);

const SLOW_PASSWORD = loginPage(
  `<input id="username" type="email" autocomplete="username"><span id="slot"></span>
   <script>setTimeout(function () { document.getElementById("slot").innerHTML = '<input id="password" type="password">'; }, 900);</script>`,
  `var p = document.getElementById("password");
   if (p && p.value) location.href = "${LIGHTNING}";`);

const EMAIL_FIRST = `<html><body>
<div id="first"><input id="username" type="email" placeholder="Email"><a href="#" id="switch">Log In with Username</a></div>
<script>
document.getElementById("switch").addEventListener("click", function (e) {
  e.preventDefault();
  document.getElementById("first").remove();
  var f = document.createElement("form"); f.onsubmit = function () { return false; };
  f.innerHTML = '<input id="username" type="text" autocomplete="username"><input id="password" type="password">'
    + '<button id="Login" type="submit">Log In to Sandbox</button>';
  document.body.appendChild(f);
  document.getElementById("Login").addEventListener("click", function () {
    window.__typedIntoUsername = document.getElementById("username").value;
    location.href = "${LIGHTNING}";
  });
});
</script></body></html>`;

/** The switch link never leads anywhere: the login must give up, not loop forever. */
const STUCK_SWITCH = `<html><body><a href="#" onclick="return false">Log In with Username</a></body></html>`;

const STAYS = (extra: string) => loginPage(
  `<input id="username" type="email" autocomplete="username"><input id="password" type="password">`, extra);

async function newPage(routes: Record<string, string>, opts: { adHits?: number[] } = {}): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.route(() => true, async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "c.salesforce.com") { opts.adHits?.push(1); return route.fulfill({ body: "ad" }); }
    const key = url.origin + url.pathname;
    const body = routes[key] ?? (url.origin === new URL(LIGHTNING).origin ? HOME : undefined);
    if (body === undefined) return route.fulfill({ status: 404, body: "not here" });
    return route.fulfill({ contentType: "text/html", body });
  });
  return page;
}

beforeAll(async () => {
  process.env.SALESFORCE_FIXED_LOGIN = "true";
  const { generateSpec } = await import("../src/stages/generator.js");
  spec = generateSpec({
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
  } as any);
  const code = ["salesforceWhere", "salesforceLoginFailure", "salesforceLogin"].map((n) => extract(spec, n)).join("\n");
  // eslint-disable-next-line no-new-func
  salesforceLogin = new Function(`${code}\nreturn salesforceLogin;`)();
  process.env.TEST_USERNAME = "qa@acme.com.uat";
  process.env.TEST_PASSWORD = "s3cret-pass";
  browser = await chromium.launch();
}, 60_000);

afterAll(async () => {
  await browser?.close();
  delete process.env.TEST_USERNAME;
  delete process.env.TEST_PASSWORD;
  delete process.env.SALESFORCE_FIXED_LOGIN;
});

describe("the generated spec's fixed Salesforce login, in Chromium", () => {
  it("one-screen login: fills both, submits once, lands on Lightning", async () => {
    const page = await newPage({ [`${ORG}/`]: ONE_SCREEN });
    await salesforceLogin(page, `${ORG}/`);
    expect(page.url()).toBe(LIGHTNING);
    await page.context().close();
  }, 60_000);

  it("two-screen login: username, Log In, waits for the password box, password, Log In", async () => {
    const page = await newPage({ [`${ORG}/`]: TWO_SCREEN });
    await salesforceLogin(page, `${ORG}/`);
    expect(page.url()).toBe(LIGHTNING);
    await page.context().close();
  }, 60_000);

  it("a password box that draws late is waited for — never submitted empty", async () => {
    const page = await newPage({ [`${ORG}/`]: SLOW_PASSWORD });
    await salesforceLogin(page, `${ORG}/`);
    expect(page.url()).toBe(LIGHTNING);
    await page.context().close();
  }, 60_000);

  it("email-first screen: clicks Log In with Username before typing (its email box is also #username)", async () => {
    const page = await newPage({ [`${ORG}/`]: EMAIL_FIRST });
    await salesforceLogin(page, `${ORG}/`);
    expect(page.url()).toBe(LIGHTNING);
    await page.context().close();
  }, 60_000);

  it("a switch link that never goes away: gives up after 20s with where it stopped", async () => {
    const page = await newPage({ [`${ORG}/`]: STUCK_SWITCH });
    const started = Date.now();
    const err = await salesforceLogin(page, `${ORG}/`).catch((e) => e);
    expect(String(err?.message)).toMatch(/no username form appeared within 20s\. Still at https:\/\/acme--uat/);
    expect(Date.now() - started).toBeLessThan(35_000);
    await page.context().close();
  }, 60_000);

  it("blocks c.salesforce.com", async () => {
    const adHits: number[] = [];
    const withAd = ONE_SCREEN.replace("</form>", `</form><img src="https://c.salesforce.com/ad.png">`);
    const page = await newPage({ [`${ORG}/`]: withAd }, { adHits });
    await salesforceLogin(page, `${ORG}/`);
    expect(adHits).toHaveLength(0);
    await page.context().close();
  }, 60_000);

  it("wrong username or password: says so, with the sandbox-username hint", async () => {
    const page = await newPage({ [`${ORG}/`]: STAYS("") });
    const err = await salesforceLogin(page, `${ORG}/`).catch((e) => e);
    expect(String(err?.message)).toMatch(/^Salesforce login: still on the login form after submitting/);
    expect(String(err?.message)).toContain("user@example.com.uat");
    expect(String(err?.message)).not.toContain("s3cret-pass");
    await page.context().close();
  }, 60_000);

  it("verification code: says so", async () => {
    const page = await newPage({ [`${ORG}/`]: STAYS(
      `document.body.innerHTML = '<input id="code" inputmode="numeric" maxlength="6"><button>Verify</button>';`) });
    const err = await salesforceLogin(page, `${ORG}/`).catch((e) => e);
    expect(String(err?.message)).toMatch(/verification code/);
    await page.context().close();
  }, 60_000);

  it("forced password change: says so", async () => {
    const page = await newPage({ [`${ORG}/`]: STAYS(
      `document.body.innerHTML = '<input type="password" id="newpassword"><input type="password" id="confirmpassword">';`) });
    const err = await salesforceLogin(page, `${ORG}/`).catch((e) => e);
    expect(String(err?.message)).toMatch(/password changed/);
    await page.context().close();
  }, 60_000);

  it("single sign-on: names the host it left for", async () => {
    const page = await newPage({
      [`${ORG}/`]: STAYS(`location.href = "https://idp.example.com/login";`),
      "https://idp.example.com/login": `<html><body><input type="password" id="password"></body></html>`,
    });
    const err = await salesforceLogin(page, `${ORG}/`).catch((e) => e);
    expect(String(err?.message)).toMatch(/left Salesforce for idp\.example\.com/);
    await page.context().close();
  }, 60_000);
});

describe("the generated spec's shape", () => {
  it("keeps exactly one test.step per IR step (executor and failure analysis count on it)", () => {
    expect((spec.match(/test\.step\(/g) ?? []).length).toBe(8);
  });

  it("runs the login once, in step 1, and takes no screenshot of the login screens", () => {
    expect(spec.match(/await salesforceLogin\(page, /g)).toHaveLength(1);
    expect(spec).toContain("step-1.png");
    for (let n = 2; n <= 7; n++) expect(spec).not.toContain(`step-${n}.png`);
    expect(spec).toContain("step-8.png");
  });

  it("a marked IR (e.g. a saved library case) with the flag switched OFF: the login is emitted step by step, as before", async () => {
    const { generateSpec } = await import("../src/stages/generator.js");
    const ir: any = {
      meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: ORG, fixedLogin: "salesforce" },
      steps: [
        { id: "auth-0", action: "navigate", target: { url: `${ORG}/` } },
        { id: "auth-1", action: "fill", target: { css: "#username" }, value: "${env:TEST_USERNAME}" },
        { id: "s1", action: "assert", target: { role: "heading", name: "Home" }, assertion: "visible" },
      ],
    };
    process.env.SALESFORCE_FIXED_LOGIN = "false";
    try {
      const off = generateSpec(structuredClone(ir));
      const { fixedLogin, ...unmarkedMeta } = ir.meta;
      expect(off).toBe(generateSpec({ ...structuredClone(ir), meta: unmarkedMeta }));
      expect(off).not.toContain("salesforceLogin");
    } finally {
      process.env.SALESFORCE_FIXED_LOGIN = "true";
    }
  });

  it("never contains a credential value — only the env reads", () => {
    expect(spec).toContain('process.env.TEST_USERNAME ?? ""');
    expect(spec).toContain('process.env.TEST_PASSWORD ?? ""');
    expect(spec).not.toContain("${env:");
  });
});

describe("flag off: every spec is byte-identical to the code before D-65", () => {
  it("six saved IRs (two real runs, both login shapes) generate exactly the pre-D-65 spec", async () => {
    // Captured by running the generator from the commit BEFORE this change on the same IRs
    // (tests/fixtures/salesforceFixedLogin/flag-off-specs.json). Re-captured 2026-10-28 from
    // origin/main's generator (1fb9dcb), which has no D-65 code, when main was merged in: main's own
    // generator changes moved the bytes, and "flag off = main's spec exactly" is the invariant.
    // An IR without meta.fixedLogin —
    // every IR when SALESFORCE_FIXED_LOGIN is off — must not change by a single byte.
    const { readFileSync } = await import("node:fs");
    const { generateSpec } = await import("../src/stages/generator.js");
    const cases = JSON.parse(readFileSync("tests/fixtures/salesforceFixedLogin/flag-off-specs.json", "utf8"));
    expect(cases.length).toBe(6);
    for (const c of cases) expect(generateSpec(structuredClone(c.ir), "runs/x/artifacts")).toBe(c.spec);
  });
});
