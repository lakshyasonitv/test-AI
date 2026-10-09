import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { extractDomModelFromPage, elementStrategy, domCacheKey } from "../src/stages/domDiscovery.js";
import type { AppModel } from "../src/schema/appModel.js";

/**
 * Phase 5 of the live-DOM discovery stream: the DISCOVERY_LIVE_DOM strategy switch.
 *
 * Two promises, both checked against a real browser:
 *   - FLAG OFF IS BYTE-IDENTICAL. `fixtures/discoveryFlagOff/pre-phase5.json` is the output of
 *     `extractDomModelFromPage` captured from the code BEFORE the switch existed, on the pages below.
 *     Today's flag-off output must deep-equal it — a permanent guard, not a one-off check.
 *   - FLAG ON loses no control. Not "no fewer entries per role": the static parse lists one
 *     <input> twice (once by its label, once by its HTML `name` attribute) and lists type=hidden
 *     inputs; the live walker lists each control once and excludes hidden inputs on purpose.
 */
process.env.DISCOVERY_HYDRATION_POLL_MS = "0";

/** The exact pages the fixture was captured from. Do not edit one without recapturing it. */
const PAGES: Record<string, string> = {
  login: `<header style="position:fixed;top:0"><nav><a href="/home">Home</a><a href="/about">About</a></nav></header>
    <main><h1>Sign in</h1><form action="/login" method="post">
    <label for="u">Username</label><input id="u" name="username"><label for="p">Password</label><input id="p" type="password" name="pw">
    <input type="text" name="passwordShown" placeholder="Password" style="display:none"><input type="hidden" name="csrf" value="T0K3N">
    <input type="checkbox" aria-label="Remember me"><select name="lang"><option>EN</option><option>DE</option></select>
    <button type="submit" data-test="login-button">Log in</button></form></main><footer><a href="/terms">Terms</a></footer>`,
  shop: `<main><h2>Products</h2><ul>${[1,2,3].map(i=>`<li><span>Item ${i}</span><button id="add-${i}">Add to cart</button></li>`).join("")}</ul>
    <div style="cursor:pointer;width:90px;height:30px" id="go.now">Checkout</div><div role="tab">Details</div>
    <a href="/cart" aria-label="Cart"><img alt="cart"></a><div>Full Name</div><input class="x"></main>`,
  shadowAndFrame: `<button>Light</button><div id="h"></div><iframe srcdoc="<button>InFrame</button>"></iframe>
    <script>document.getElementById("h").attachShadow({mode:"open"}).innerHTML = "<button>InShadow</button>";</script>`,
  empty: `<p>Nothing to click here.</p>`,
};

let browser: Browser;
let page: Page;
const saved = process.env.DISCOVERY_LIVE_DOM;
beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
afterAll(async () => { await browser.close(); });
afterEach(() => {
  if (saved === undefined) delete process.env.DISCOVERY_LIVE_DOM;
  else process.env.DISCOVERY_LIVE_DOM = saved;
});

async function extract(name: string): Promise<AppModel> {
  await page.setContent(PAGES[name]);
  await page.waitForTimeout(150);
  const m = (await extractDomModelFromPage(page, "https://example.test/" + name))!;
  for (const p of m.pages) delete (p as any).crawlTimeMs; // wall-clock
  return m;
}

describe("elementStrategy reads DISCOVERY_LIVE_DOM, default off", () => {
  it.each([[undefined, "cheerio"], ["false", "cheerio"], ["true", "live"]] as const)(
    "%s -> %s", (value, want) => {
      if (value === undefined) delete process.env.DISCOVERY_LIVE_DOM;
      else process.env.DISCOVERY_LIVE_DOM = value;
      expect(elementStrategy()).toBe(want);
    });

  it("is read in exactly ONE place in src/", () => {
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name);
        if (e.isDirectory()) walk(full);
        else if (e.name.endsWith(".ts") && /process\.env\.DISCOVERY_LIVE_DOM\b/.test(readFileSync(full, "utf8"))) hits.push(full);
      }
    };
    walk(fileURLToPath(new URL("../src", import.meta.url)));
    expect(hits.map((h) => h.split("/src/")[1])).toEqual(["stages/domDiscovery.ts"]);
  });
});

describe("the discovery cache key carries the strategy", () => {
  it("flag off keeps the original key, so existing cache entries stay valid", () => {
    delete process.env.DISCOVERY_LIVE_DOM;
    expect(domCacheKey("https://x.test/")).toBe("dom:https://x.test/");
  });
  it("flag on uses a different key, so a cached static model is never served as a live one", () => {
    process.env.DISCOVERY_LIVE_DOM = "true";
    expect(domCacheKey("https://x.test/")).toBe("dom-live:https://x.test/");
  });
});

describe("FLAG OFF: byte-identical to the code before the switch existed", () => {
  const fixture = JSON.parse(readFileSync(new URL("./fixtures/discoveryFlagOff/pre-phase5.json", import.meta.url), "utf8"));

  it("the fixture covers every page here", () => {
    expect(Object.keys(fixture).sort()).toEqual(Object.keys(PAGES).sort());
  });

  it.each(Object.keys(PAGES))("%s, flag unset", async (name) => {
    delete process.env.DISCOVERY_LIVE_DOM;
    expect(JSON.parse(JSON.stringify(await extract(name)))).toEqual(fixture[name]);
  });

  it.each(Object.keys(PAGES))("%s, flag explicitly false", async (name) => {
    process.env.DISCOVERY_LIVE_DOM = "false";
    expect(JSON.parse(JSON.stringify(await extract(name)))).toEqual(fixture[name]);
  });
});

describe("FLAG ON: the live walker supplies the elements", () => {
  it("every element is measured and carries a css; the hidden password mirror is not visible", async () => {
    process.env.DISCOVERY_LIVE_DOM = "true";
    const els = (await extract("login")).pages[0].elements;
    for (const e of els) {
      expect(e.visibleSource, `${e.role} ${e.name}`).toBe("computed");
      expect(e.css, `${e.role} ${e.name}`).toBeTruthy();
    }
    const mirror = els.find((e) => e.css === 'input[name="passwordShown"]')!;
    expect(mirror.visible).toBe(false);
    expect(els.find((e) => e.css === "#p")).toMatchObject({ name: "Password", visible: true });
  });

  it("loses no control the static parse found — every static entry maps to a live element", async () => {
    // Map static entries to DOM controls the only stable way: the static path's own css where it
    // has one, otherwise by the control it names. The two static-only kinds are asserted for what
    // they are: a second name for the same control, and the deliberately excluded hidden input.
    delete process.env.DISCOVERY_LIVE_DOM;
    const off = (await extract("login")).pages[0].elements;
    process.env.DISCOVERY_LIVE_DOM = "true";
    const on = (await extract("login")).pages[0].elements;
    const onCss = new Set(on.map((e) => e.css));
    const SAME_CONTROL: Record<string, string> = {
      "textbox:username": "#u", "textbox:pw": "#p", "combobox:lang": 'select[name="lang"]',
    };
    for (const e of off) {
      const key = `${e.role}:${e.name}`;
      if (key === "textbox:csrf") continue; // type=hidden — excluded on purpose (TD-64)
      if (SAME_CONTROL[key]) { expect(onCss.has(SAME_CONTROL[key]), key).toBe(true); continue; }
      expect(on.some((o) => o.role === e.role && o.name === e.name), key).toBe(true);
    }
  });

  it("finds shadow-DOM and same-origin iframe content the static parse cannot see", async () => {
    process.env.DISCOVERY_LIVE_DOM = "true";
    const els = (await extract("shadowAndFrame")).pages[0].elements;
    expect(els.map((e) => e.name)).toEqual(["Light", "InShadow", "InFrame"]);
    expect(els[1].inShadow).toBe(true);
    expect(els[2].frame).toBeTruthy();
  });

  it("re-tags landmarks on the live elements, by the same rule", async () => {
    process.env.DISCOVERY_LIVE_DOM = "true";
    const p = (await extract("login")).pages[0];
    const lm = (n: string) => p.elements.find((e) => e.name === n)?.landmark;
    expect(lm("Home")).toBe("nav");
    expect(lm("Username")).toBe("form");
    expect(lm("Terms")).toBe("footer");
    expect(p.landmarkSections?.find((s) => s.landmark === "form")?.elementCount).toBe(6);
  });

  it("keeps generic clickables, which the walker does not enumerate", async () => {
    process.env.DISCOVERY_LIVE_DOM = "true";
    const els = (await extract("shop")).pages[0].elements;
    expect(els.find((e) => e.name === "Checkout")).toMatchObject({ role: "button", css: '[id="go.now"]' });
  });

  it("does not let recheckVisibility overwrite a measured value via a same-css element in another document", async () => {
    // The frame's #e is visible; the TOP page's #e is hidden. document.querySelector("#e") on the top
    // page finds the hidden one — re-checking the frame element against it would flip it to false.
    process.env.DISCOVERY_LIVE_DOM = "true";
    await page.setContent(`<input id="e" aria-label="Top" style="display:none"><iframe srcdoc="<input id='e' aria-label='Framed'>"></iframe>`);
    await page.waitForTimeout(150);
    const els = (await extractDomModelFromPage(page, "https://example.test/"))!.pages[0].elements;
    expect(els.find((e) => e.name === "Top")?.visible).toBe(false);
    expect(els.find((e) => e.name === "Framed")?.visible).toBe(true);
  });
});
