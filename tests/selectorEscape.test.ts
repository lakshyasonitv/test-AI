import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { cssIdent, stableSelector } from "../src/stages/discovery.js";
import { extractDomModelFromPage } from "../src/stages/domDiscovery.js";

/**
 * LS-4: `#id` selectors were built with a string-value escape (`"` and `\` only), which is wrong
 * for an IDENTIFIER. Measured in Chromium before the fix: id `a.b` gave `#a.b` — "id a AND class b"
 * — and matched a DIFFERENT element without any error; id `1x` gave `#1x`, which throws.
 *
 * `cssIdent` is a port of the CSSOM `CSS.escape()`, so it is checked against the browser's own
 * `CSS.escape` rather than against expectations written by hand, and every resulting selector is
 * EXECUTED (D-19).
 */
process.env.DISCOVERY_HYDRATION_POLL_MS = "0";

const NASTY_IDS = [
  "plain", "a.b", "1x", "-1x", "-", "--", "_x", "a:b", "a[b]", "a b", 'q"uote', "back\\slash",
  "with#hash", "emoji😀", "ünïcode", "a\tb", "a\u007fb", "a/b", "a+b", "a>b", "a,b", "50%",
];

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
afterAll(async () => { await browser.close(); });

describe("cssIdent — the CSS.escape port (LS-4)", () => {
  it("agrees with the browser's own CSS.escape on every awkward id", async () => {
    const browserSays = await page.evaluate((ids) => ids.map((id) => CSS.escape(id)), NASTY_IDS);
    expect(NASTY_IDS.map(cssIdent)).toEqual(browserSays);
  });

  it("maps NUL to U+FFFD, as the spec says", async () => {
    expect(cssIdent("a\u0000b")).toBe(await page.evaluate(() => CSS.escape("a\u0000b")));
  });

  it("keeps a plain id as #id — byte-identical to before — and quotes any id that needs escaping", () => {
    expect(stableSelector({ id: "plain" })).toBe("#plain");
    expect(stableSelector({ id: "_x-1" })).toBe("#_x-1");
    expect(stableSelector({ id: "a.b" })).toBe('[id="a.b"]');
    expect(stableSelector({ id: "1x" })).toBe('[id="1x"]');
    expect(stableSelector({ id: "-" })).toBe('[id="-"]');
    expect(stableSelector({ id: 'q"uote' })).toBe('[id="q\\"uote"]');
  });

  it("stableSelector's #id matches exactly the element with that id — never a decoy, never a throw", async () => {
    // ids set from script: HTML does not interpret JS escapes, so writing a quote, backslash or
    // tab into the markup would give the element a DIFFERENT id than the one under test.
    await page.setContent('<div id="root"></div><button id="a" class="b" data-k="decoy">decoy for a.b</button>');
    await page.evaluate((ids) => {
      ids.forEach((id, i) => {
        const b = document.createElement("button");
        b.id = id; b.setAttribute("data-k", String(i)); b.textContent = "b" + i;
        document.getElementById("root")!.appendChild(b);
      });
    }, NASTY_IDS);
    for (const [i, id] of NASTY_IDS.entries()) {
      const sel = stableSelector({ id });
      const loc = page.locator(sel);
      expect(await loc.count(), `${id} -> ${sel}`).toBe(1);
      expect(await loc.getAttribute("data-k"), `${id} -> ${sel}`).toBe(String(i));
    }
  });
});

describe("generic clickables get an escaped #id too (LS-4)", () => {
  it("a cursor:pointer div with a dotted id resolves to itself, not to a decoy", async () => {
    await page.setContent(`
      <div id="go.now" style="cursor:pointer; width:80px; height:30px" data-k="real">Go now</div>
      <span id="go" class="now" data-k="decoy">decoy</span>`);
    const model = await extractDomModelFromPage(page, "https://example.test/");
    const el = model!.pages[0].elements.find((e) => e.name === "Go now")!;
    expect(el.css).toBe('[id="go.now"]');
    expect(await page.locator(el.css!).getAttribute("data-k")).toBe("real");
  });
});
