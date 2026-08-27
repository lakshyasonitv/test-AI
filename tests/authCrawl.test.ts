import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";
import {
  loginOnPage, hasLoginGate, verifySession, discoverUrlsByClicking,
} from "../src/stages/hybridDiscovery.js";
import { extractDomModelFromPage } from "../src/stages/domDiscovery.js";
import { credentialFieldMap, isEnvValueRef } from "../src/stages/credentials.js";
import { buildLoginPrefix } from "../src/stages/ir.js";
import { generateSpec } from "../src/stages/generator.js";

/**
 * Real-browser checks for auth-aware discovery.
 *
 * These have to drive an actual Chromium. Two of the bugs behind this file were facts about the
 * runtime that no string-inspecting test could see: `browser.newPage()` silently creating a
 * fresh anonymous context per call, and `input[type="password"]` having no `textbox` ARIA role.
 * DECISIONS.md D-19 records the precedent — a `.filter({ visible: true })` "fix" passed tsc and a
 * unit test while being a no-op, because nothing executed it.
 *
 * Every fixture below is a login shape that broke a real run. The point is that "works on the
 * last site I tried" stops being the standard.
 *
 * Runs against a local throwaway server: no network, no LLM tokens, no real credentials.
 */

const USER = "alice";
const PASS = "s3cret-pw";
const COOKIE = "sid=valid-session";

const page$ = `<h1>Dashboard</h1><a href="/reports">Reports</a><a href="/logout">Log out</a>`;

function makeServer(): http.Server {
  const authed = (req: http.IncomingMessage) => (req.headers.cookie ?? "").includes(COOKIE);
  const html = (res: http.ServerResponse, body: string) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><html><body>${body}</body></html>`);
  };
  const gated = (req: http.IncomingMessage, res: http.ServerResponse, body: string) => {
    if (!authed(req)) { res.writeHead(302, { Location: "/login" }); return res.end(); }
    html(res, body);
  };

  /** The classic case: real <form>, labelled inputs, submit button. */
  const classicForm = `
    <h1>Sign in</h1>
    <form method="POST" action="/login">
      <input type="text" name="username" aria-label="Username">
      <input type="password" name="password" aria-label="Password">
      <button type="submit">Log in</button>
    </form>`;

  return http.createServer((req, res) => {
    const url = (req.url ?? "/").split("?")[0];

    if (req.method === "POST" && url === "/api/login-slow") {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = new URLSearchParams(raw);
        const ok = body.get("username") === USER && body.get("password") === PASS;
        // 1.2s is well under the assertion timeout but far longer than the gap between a click
        // and the next step — enough to lose the race every time without it.
        setTimeout(() => {
          res.writeHead(ok ? 200 : 401, {
            "Content-Type": "application/json",
            ...(ok ? { "Set-Cookie": `${COOKIE}; Path=/` } : {}),
          });
          res.end("{}");
        }, 1200);
      });
      return;
    }

    if (req.method === "POST" && (url === "/login" || url === "/api/login")) {
      let raw = "";
      req.on("data", (c) => { raw += c; });
      req.on("end", () => {
        const body = new URLSearchParams(raw);
        const ok = body.get("username") === USER && body.get("password") === PASS;
        if (url === "/api/login") {
          res.writeHead(ok ? 200 : 401, {
            "Content-Type": "application/json",
            ...(ok ? { "Set-Cookie": `${COOKIE}; Path=/` } : {}),
          });
          return res.end("{}");
        }
        res.writeHead(302, {
          ...(ok ? { "Set-Cookie": `${COOKIE}; Path=/` } : {}),
          Location: ok ? "/dashboard" : "/login",
        });
        res.end();
      });
      return;
    }

    if (url === "/login") return html(res, classicForm);

    // Entry page that is NOT the login — a marketing home with a link to it.
    if (url === "/home") return html(res, `<h1>Welcome</h1><a href="/login">Sign in</a>`);

    // An unrelated form with its own submit button ABOVE the login form.
    if (url === "/login-decoy") {
      return html(res, `
        <form method="POST" action="/newsletter">
          <input type="email" name="newsletter_email" aria-label="Newsletter email">
          <button type="submit">Subscribe</button>
        </form>` + classicForm);
    }

    // The assettrack shape: NO <form> tag at all, inputs named only by placeholder, submit is a
    // plain <button> wired to JS. credentialFieldMap returns {} here, because extractForms needs
    // a literal <form> — this is the page that silently produced "no login attempted".
    if (url === "/login-formless") {
      return html(res, `
        <h1>Welcome Back</h1>
        <div>
          <input id="email" type="email" placeholder="admin@company.com">
          <input id="password" type="password" placeholder="••••••••">
          <button id="go">Sign In</button>
        </div>
        <script>
          document.getElementById('go').onclick = async () => {
            const b = new URLSearchParams({
              username: document.getElementById('email').value,
              password: document.getElementById('password').value,
            });
            const r = await fetch('/api/login', { method:'POST', body:b });
            if (r.ok) location.href = '/dashboard';
          };
        </script>`);
    }

    // learnvibes.vercel.app's real shape: inputs with NO id, NO name, NO data-* — a placeholder
    // is the only distinguishing attribute — and a submit button with no id either. An
    // attribute-only selector ladder finds nothing here, fills the password alone, and the login
    // fails. Every other fixture in this file happens to have an id, which is why this shape only
    // showed up on a live run.
    if (url === "/login-bare") {
      // Submits via JS because the inputs have no `name` either — a form POST would carry no
      // fields at all. That is exactly why the selector ladder has to reach them by placeholder.
      //
      // The identifier is type="text" rather than type="email" purely so this fixture's shared
      // username ("alice") can be submitted at all: a type="email" input runs HTML5 constraint
      // validation and SILENTLY blocks submit for a non-email value — no request, no error, no
      // console message. Worth knowing about in its own right; it means a site whose login field
      // is type="email" will never submit a username that is not email-shaped.
      return html(res, `
        <form id="f">
          <input type="text" placeholder="you@example.com">
          <input type="password" placeholder="*********">
          <button type="submit">Sign In</button>
        </form>
        <script>
          document.getElementById('f').onsubmit = async (e) => {
            e.preventDefault();
            const i = document.querySelectorAll('input');
            const b = new URLSearchParams({ username: i[0].value, password: i[1].value });
            const r = await fetch('/api/login', { method:'POST', body:b });
            if (r.ok) location.href = '/dashboard';
          };
        </script>`);
    }

    // A hidden honeypot password input placed BEFORE the real one.
    if (url === "/login-honeypot") {
      return html(res, `
        <form method="POST" action="/login">
          <input type="password" name="trap" style="display:none">
          <input type="text" name="username" aria-label="Username">
          <input type="password" name="password" aria-label="Password">
          <button type="submit">Log in</button>
        </form>`);
    }

    // Authenticates in place: no navigation, no URL change. The old `url !== urlBefore` check
    // called this a failure. Re-fetching the same URL with the cookie proves otherwise.
    if (url === "/spa-inplace") {
      if (authed(req)) return html(res, page$);
      return html(res, `
        <div>
          <input id="u" type="text" placeholder="you@example.com">
          <input id="p" type="password" placeholder="password">
          <button id="go">Sign In</button>
        </div>
        <script>
          document.getElementById('go').onclick = async () => {
            const b = new URLSearchParams({
              username: document.getElementById('u').value,
              password: document.getElementById('p').value,
            });
            const r = await fetch('/api/login', { method:'POST', body:b });
            if (r.ok) document.body.innerHTML = ${JSON.stringify(page$)};
          };
        </script>`);
    }

    // Auth kept in sessionStorage, gated client-side — no cookie at all. This is the
    // assettrack-web.onrender.com shape, and the reason the crawl uses ONE page: sessionStorage
    // is scoped to a TAB, so a new page per hop starts logged out however shared the context is.
    if (url === "/spa-session") {
      return html(res, `
        <div id="app"></div>
        <script>
          function render() {
            if (sessionStorage.getItem('token')) {
              document.getElementById('app').innerHTML = ${JSON.stringify(page$)};
            } else {
              document.getElementById('app').innerHTML =
                '<input id="u" type="text" placeholder="you@example.com">' +
                '<input id="p" type="password" placeholder="password">' +
                '<button id="go">Sign In</button>';
              document.getElementById('go').onclick = async () => {
                const b = new URLSearchParams({
                  username: document.getElementById('u').value,
                  password: document.getElementById('p').value,
                });
                const r = await fetch('/api/login', { method:'POST', body:b });
                if (r.ok) { sessionStorage.setItem('token','t'); render(); }
              };
            }
          }
          render();
        </script>`);
    }

    // A login that takes a moment to come back — a spinner on the button while the request is
    // in flight. This is the shape that broke run 2026-08-22T16-10-40-756Z-04cfa936: the prefix
    // submitted, immediately navigated on, and raced the pending auth. Every other login fixture
    // here resolves instantly, which is exactly why nothing caught it before a live run.
    if (url === "/login-slow") {
      return html(res, `
        <form id="f">
          <input type="text" name="username" aria-label="Username">
          <input type="password" name="password" aria-label="Password">
          <button type="submit">Sign In</button>
        </form>
        <script>
          document.getElementById('f').onsubmit = async (e) => {
            e.preventDefault();
            const b = new URLSearchParams({
              username: document.querySelector('[aria-label=Username]').value,
              password: document.querySelector('[aria-label=Password]').value,
            });
            document.querySelector('button').textContent = 'Signing in…';
            const r = await fetch('/api/login-slow', { method:'POST', body:b });
            if (r.ok) location.href = '/dashboard';
          };
        </script>`);
    }

    if (url === "/dashboard") return gated(req, res, page$);
    if (url === "/reports") return gated(req, res, `<h1>Reports</h1><a href="/dashboard">Back</a>`);

    // SPA whose nav is buttons routing via JS — no <a href> anywhere.
    if (url === "/spa") {
      return html(res, `
        <header>
          <button onclick="location.href='/logout'">Sign out</button>
          <button>Toggle menu</button>
        </header>
        <nav>
          <button onclick="location.href='/spa-learning'">Learning</button>
          <button onclick="location.href='/spa-progress'">Progress</button>
          <button>Opens a modal</button>
        </nav>
        <aside><button>hamburger</button></aside>`);
    }
    if (url === "/spa-learning" || url === "/spa-progress") return html(res, `<h1>${url.slice(5)}</h1>`);

    // saucedemo's inventory shape: anchors that are NOT links in the href sense. The cart has no
    // href attribute at all; product links are href="#". React drives both by onClick, so
    // `$("a[href]")` misses the cart and the rest resolve to "#" — internalUrls comes back empty
    // on a page that visibly has navigation. No <nav> landmark anywhere, so a button-only,
    // nav-scoped probe finds nothing either.
    if (url === "/anchor-spa") {
      return html(res, `
        <div class="menu">
          <a href="#" id="logout_sidebar_link" onclick="location.href='/logout'">Logout</a>
        </div>
        <a href="#" id="reset_sidebar_link" onclick="location.href='/anchor-reset'">Reset App State</a>
        <a class="cart_link" data-test="cart-link" onclick="location.href='/anchor-cart'">Cart</a>
        <div class="inventory">
          <a href="#" id="item_0_title_link" onclick="location.href='/anchor-item'">Sauce Labs Backpack</a>
          <a href="#" id="item_0_img_link" onclick="location.href='/anchor-item'">Sauce Labs Backpack</a>
        </div>
        <button>Add to cart</button>`);
    }
    if (url === "/anchor-cart") return html(res, `<h1>Your Cart</h1><button>Checkout</button>`);
    if (url === "/anchor-item") return html(res, `<h1>Item detail</h1>`);

    res.writeHead(404);
    res.end("nope");
  });
}

describe("auth-aware discovery (real browser)", () => {
  let server: http.Server;
  let browser: Browser;
  let baseUrl: string;

  beforeAll(async () => {
    server = makeServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await new Promise<void>((r) => server?.close(() => r()));
  });

  /** Log in at `path`, then report whether a real session resulted. */
  const attempt = async (path: string, creds = { username: USER, password: PASS }) => {
    const context = await browser.newContext();
    const newPage = () => context.newPage();
    try {
      const page = await newPage();
      await page.goto(`${baseUrl}${path}`, { waitUntil: "domcontentloaded" });
      const gated = await hasLoginGate(page);
      const steps = await loginOnPage(page, creds);
      await page.waitForTimeout(600);
      const reached = page.url();
      const ok = await verifySession(page, `${baseUrl}${path}`);
      return { gated, steps, ok, reached, context, page };
    } finally {
      await context.close();
    }
  };

  it("gates /dashboard behind the session cookie", async () => {
    // Negative control: without this, every assertion below could pass against a server that
    // never redirects, proving nothing about sessions at all.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/dashboard`, { waitUntil: "domcontentloaded" });
      expect(page.url()).toBe(`${baseUrl}/login`);
    } finally {
      await context.close();
    }
  }, 30_000);

  it.each([
    ["classic labelled form", "/login"],
    ["form-less SPA login (placeholder-only names)", "/login-formless"],
    ["decoy form above the login form", "/login-decoy"],
    ["hidden honeypot password field", "/login-honeypot"],
    ["attribute-less inputs (placeholder only)", "/login-bare"],
    ["in-place auth with no URL change", "/spa-inplace"],
    ["sessionStorage auth, gated client-side", "/spa-session"],
  ])("logs in and establishes a verified session: %s", async (_label, path) => {
    const { gated, steps, ok } = await attempt(path);
    expect(gated, "hasLoginGate should see the password field").toBe(true);
    expect(ok, "verifySession should confirm a real session").toBe(true);

    // The recorded steps are the contract now: ir.ts replays exactly these to sign the
    // generated test in, so asserting their SHAPE is what proves the prefix will work.
    expect(steps, "loginOnPage should return the steps it ran").toBeTruthy();
    expect(steps!.filter((s) => s.credential === "username")).toHaveLength(1);
    expect(steps!.filter((s) => s.credential === "password")).toHaveLength(1);
    expect(steps!.at(-1)!.action, "last step submits").toMatch(/click|press/);
    for (const s of steps!) {
      expect(s.css, `every step needs a replayable selector (${s.action})`).toBeTruthy();
    }
  }, 60_000);

  it("reports failure, not false success, when the password is wrong", async () => {
    // The dangerous direction. A false success makes the crawl walk a logged-out site while
    // believing it is authenticated — strictly worse than an honest one-page model.
    const { steps, ok } = await attempt("/login", { username: USER, password: "wrong" });
    expect(steps, "the attempt still happened").toBeTruthy();
    expect(ok).toBe(false);
  }, 60_000);

  it("the form-less fixture is genuinely invisible to the old model-based detection", async () => {
    // Pins WHY /login-formless discriminates. extractForms only walks literal <form> tags, so
    // this page yields forms: [] -> credentialFieldMap {} -> the old code found no password
    // field and never attempted a login. If someone later wraps this fixture in a <form>, the
    // test above would keep passing while silently no longer covering the bug it exists for.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/login-formless`, { waitUntil: "domcontentloaded" });
      const m = (await extractDomModelFromPage(page, `${baseUrl}/login-formless`))!.pages[0];
      expect(m.forms ?? [], "fixture must expose no forms to the extractor").toHaveLength(0);
      expect(credentialFieldMap({ baseUrl, pages: [m] }).size,
        "the model-derived field map must be empty here").toBe(0);
      // ...and yet the live DOM has the password box all along.
      expect(await hasLoginGate(page)).toBe(true);
    } finally {
      await context.close();
    }
  }, 60_000);

  it("does not see a login gate on a page that has none", async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/home`, { waitUntil: "domcontentloaded" });
      expect(await hasLoginGate(page)).toBe(false);
    } finally {
      await context.close();
    }
  }, 30_000);

  it("carries a sessionStorage session across crawl hops, which a new page per hop cannot", async () => {
    // The finding that forced the single-page crawl. Verified against a real site
    // (assettrack-web.onrender.com stores `token`/`user` in sessionStorage, no cookies): a
    // second page on the SAME context came back with empty sessionStorage and the login form.
    // Both halves are asserted here so the reason survives, not just the behaviour.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/spa-session`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(300);
      await loginOnPage(page, { username: USER, password: PASS });
      await page.waitForTimeout(600);
      expect(await hasLoginGate(page), "login should have replaced the form").toBe(false);

      // One tab, navigating: the session survives. This is what every crawl hop now does.
      await page.goto(`${baseUrl}/spa-session`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(400);
      expect(await hasLoginGate(page), "same tab keeps sessionStorage").toBe(false);

      // A second tab does NOT — which is exactly why snapshot() no longer opens one per hop.
      const otherTab = await context.newPage();
      await otherTab.goto(`${baseUrl}/spa-session`, { waitUntil: "domcontentloaded" });
      await otherTab.waitForTimeout(400);
      expect(await hasLoginGate(otherTab), "a new tab has no sessionStorage — the old bug").toBe(true);
    } finally {
      await context.close();
    }
  }, 60_000);

  it("keeps the session on a page opened later on the same context", async () => {
    // The original regression: snapshot() closes its page and opens a new one per crawl hop.
    // With browser.newPage() that hop was anonymous and landed back on /login.
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${baseUrl}/login`, { waitUntil: "domcontentloaded" });
      await loginOnPage(page, { username: USER, password: PASS });
      await page.waitForTimeout(600);
      await page.close();

      const nextHop = await context.newPage();
      await nextHop.goto(`${baseUrl}/reports`, { waitUntil: "domcontentloaded" });
      expect(nextHop.url()).toBe(`${baseUrl}/reports`);
      expect(await nextHop.textContent("h1")).toBe("Reports");
    } finally {
      await context.close();
    }
  }, 60_000);

  // The executor's real condition, and the one today's IR fails: a spec runs in a browser that
  // has never seen this site. Run 2026-08-22T07-04-23-933Z-04c5704b went straight to /dashboard,
  // got bounced to /login, and every step after that failed as `element_missing`.
  describe("the login prefix authenticates from a cold browser", () => {
    it.each([
      ["cookie session", "/login", "/reports", "Reports"],
      ["sessionStorage session", "/spa-session", "/spa-session", "Dashboard"],
      ["slow login (races the next step)", "/login-slow", "/reports", "Reports"],
    ])("%s", async (_label, loginPath, gatedPath, heading) => {
      // 1. Discovery's half: log in once and keep what it took.
      const discovery = await browser.newContext();
      let loginSteps;
      try {
        const page = await discovery.newPage();
        await page.goto(`${baseUrl}${loginPath}`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(300);
        loginSteps = await loginOnPage(page, { username: USER, password: PASS });
      } finally {
        await discovery.close();
      }

      const prefix = buildLoginPrefix({
        status: "authenticated", loginUrl: `${baseUrl}${loginPath}`, loginSteps: loginSteps!,
      });
      expect(prefix.length, "there should be a prefix to replay").toBeGreaterThan(0);

      // 2. The generated spec must read credentials from the environment, never inline them —
      //    runs/ is served publicly (TD-14).
      const spec = generateSpec({
        meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl },
        steps: prefix,
      } as any);
      expect(spec).toContain("process.env.TEST_USERNAME");
      expect(spec).toContain("process.env.TEST_PASSWORD");
      expect(spec, "the literal password must not appear in the spec").not.toContain(PASS);

      // 3. Replay the prefix in a FRESH context — no cookies, no storage, exactly what the
      //    executor gives a generated spec — then confirm a gated page actually renders.
      const cold = await browser.newContext();
      try {
        const page = await cold.newPage();
        for (const s of prefix) {
          if (s.action === "navigate") {
            await page.goto(s.target!.url!, { waitUntil: "domcontentloaded" });
            await page.waitForTimeout(300);
          } else if (s.action === "fill") {
            const kind = isEnvValueRef(s.value);
            expect(kind, "every prefix fill is an env reference").toBeTruthy();
            await page.locator(s.target!.css!).first()
              .fill(kind === "TEST_PASSWORD" ? PASS : USER, { timeout: 10_000 });
          } else if (s.action === "click") {
            await page.locator(s.target!.css!).first().click({ timeout: 10_000 });
          } else if (s.action === "press") {
            await page.locator(s.target!.css!).first().press(s.value ?? "Enter");
          } else if (s.action === "assert" && s.assertion === "hidden") {
            // The settle step. `waitFor({ state: "hidden" })` is the same auto-waiting semantics
            // generator.ts emits as `expect(...).toBeHidden({ timeout: 10000 })`. Without this
            // branch the "slow login" fixture fails — which is the point of that fixture.
            await page.locator(s.target!.css!).first().waitFor({ state: "hidden", timeout: 10_000 });
          }
        }
        await page.waitForTimeout(800);

        await page.goto(`${baseUrl}${gatedPath}`, { waitUntil: "domcontentloaded" });
        await page.waitForTimeout(400);
        expect(await hasLoginGate(page), "should not have been bounced to the login form").toBe(false);
        expect(await page.textContent("h1")).toBe(heading);
      } finally {
        await cold.close();
      }
    }, 90_000);
  });

  describe("SPA routes reached by clicking nav buttons", () => {
    const model = async (page: Page, url: string) =>
      (await extractDomModelFromPage(page, url))!.pages[0];

    it("finds routes that exist only behind a JS click", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${baseUrl}/spa`, { waitUntil: "domcontentloaded" });
        const spa = await model(page, `${baseUrl}/spa`);
        expect(spa.internalUrls ?? [], "fixture must have no hrefs, else it proves nothing")
          .toHaveLength(0);

        const found = await discoverUrlsByClicking(page, spa, baseUrl);
        expect(found.sort()).toEqual([`${baseUrl}/spa-learning`, `${baseUrl}/spa-progress`]);
      } finally {
        await context.close();
      }
    }, 60_000);

    it("follows anchors that carry no usable href — the saucedemo shape", async () => {
      // Regression, run 2026-08-22T06-39-46-098Z-c97ffa6f: auth worked and the crawl still
      // produced one page, so /cart.html was never modelled and the checkout case truncated at
      // the "Checkout" button with no terminal assertion. The probe existed but only looked at
      // nav-landmark BUTTONS; saucedemo's cart and product links are anchors outside any nav.
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${baseUrl}/anchor-spa`, { waitUntil: "domcontentloaded" });
        const m = await model(page, `${baseUrl}/anchor-spa`);
        expect(m.internalUrls ?? [], "fixture must yield no href targets, else it proves nothing")
          .toHaveLength(0);

        const found = await discoverUrlsByClicking(page, m, baseUrl);
        expect(found).toContain(`${baseUrl}/anchor-cart`);
        expect(found).toContain(`${baseUrl}/anchor-item`);
        expect(found.some((u) => u.includes("logout")), "must never click Logout").toBe(false);
        // Discovery is a read-only pass over a customer's app. saucedemo's real inventory carries
        // "Reset App State" as an <a href="#"> — an anchor by markup, a state mutation in effect.
        expect(found.some((u) => u.includes("anchor-reset")), "must never click Reset App State").toBe(false);
      } finally {
        await context.close();
      }
    }, 60_000);

    it("never clicks sign-out, and ignores buttons outside the nav landmark", async () => {
      const context = await browser.newContext();
      try {
        const page = await context.newPage();
        await page.goto(`${baseUrl}/spa`, { waitUntil: "domcontentloaded" });
        const found = await discoverUrlsByClicking(page, await model(page, `${baseUrl}/spa`), baseUrl);
        expect(found.some((u) => u.includes("logout"))).toBe(false);
      } finally {
        await context.close();
      }
    }, 60_000);
  });
});
