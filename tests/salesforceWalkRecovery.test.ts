import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { walkLiveDomWithFrames } from "../src/stages/liveDomDiscovery.js";
import { extractDomModelFromPage } from "../src/stages/domDiscovery.js";
import { withTargetApp } from "../src/runTarget.js";

/**
 * Run 2026-10-24T07-58-47-085Z-3eb31efb: on four Lightning list pages the live walk of the page's
 * own document failed, the failure was swallowed (`catch { continue; }`), and the model kept only
 * the generic-clickable pass: 9 header buttons, no css, no list, no New button. These pin that a
 * failed walk is reported and, on a Salesforce run, retried by the hydration poll.
 *
 * The failure is forced by making getComputedStyle (which the walk calls per element) throw: once
 * for a transient failure, always for a persistent one.
 */

const THROW_ONCE = `<script>(() => { const real = window.getComputedStyle; let n = 0;
  window.getComputedStyle = function () { if (n++ === 0) throw new Error("walk boom"); return real.apply(window, arguments); }; })();</script>`;
const THROW_ALWAYS = `<script>window.getComputedStyle = function () { throw new Error("walk boom"); };</script>`;

describe("a failed live walk of the page's own document", () => {
  let browser: Browser;
  let page: Page;
  let prevPoll: string | undefined;
  beforeAll(async () => {
    prevPoll = process.env.DISCOVERY_HYDRATION_POLL_MS;
    process.env.DISCOVERY_HYDRATION_POLL_MS = "2500";
    browser = await chromium.launch();
  });
  // A fresh page per test: setContent keeps the window, so a patched getComputedStyle would leak.
  beforeEach(async () => { page = await browser.newPage(); });
  afterEach(async () => { await page.close(); });
  afterAll(async () => {
    await browser.close();
    if (prevPoll === undefined) delete process.env.DISCOVERY_HYDRATION_POLL_MS;
    else process.env.DISCOVERY_HYDRATION_POLL_MS = prevPoll;
  });

  it("is reported, not returned as an empty page", async () => {
    await page.setContent(`${THROW_ALWAYS}<button>Go</button>`);
    await expect(withTargetApp("salesforce", () => walkLiveDomWithFrames(page))).rejects.toThrow(/walk boom/);
  });

  it("survives Lightning's ban on ShadowRoot.getElementById and still resolves aria-labelledby", async () => {
    // The real cause on the DE org's list pages (run 2026-10-24T10-48-05-743Z-dad17042): Lightning
    // patches ShadowRoot.getElementById to throw `Disallowed method "getElementById" on ShadowRoot.`
    await page.setContent(`<div id="h"></div><section role="dialog" aria-labelledby="t"><h2 id="t">New Lead</h2><button>Save</button></section>
      <script>
        const root = document.getElementById("h").attachShadow({ mode: "open" });
        root.innerHTML = '<span id="lbl">Search Leads</span><input aria-labelledby="lbl">';
        ShadowRoot.prototype.getElementById = function () { throw new Error('Disallowed method "getElementById" on ShadowRoot.'); };
      </script>`);
    const els = await withTargetApp("salesforce", () => walkLiveDomWithFrames(page));
    expect(els.find((e) => e.role === "textbox")?.name).toBe("Search Leads");
    expect(els.find((e) => e.name === "Save")?.dialogName).toBe("New Lead");
  });

  it("is retried on a Salesforce run, so a transient failure still yields the live elements", async () => {
    await page.setContent(`${THROW_ONCE}<span style="cursor:pointer">Fav</span><button>New</button>`);
    const els = (await withTargetApp("salesforce", () => extractDomModelFromPage(page, "https://x.test/list")))!.pages[0].elements;
    const nw = els.find((e) => e.name === "New");
    expect(nw?.visibleSource).toBe("computed"); // the walker's element, not the static parse's
    expect(nw?.css).toBeTruthy();
  });

  it("a Salesforce page whose walk finds nothing yet keeps polling past generic clickables", async () => {
    // The generic pass sees the cursor:pointer header at once; the real controls render later.
    await page.setContent(`<span style="cursor:pointer">Fav</span><div id="late"></div>
      <script>setTimeout(() => { document.getElementById("late").innerHTML = "<button>New</button>"; }, 1200);</script>`);
    const els = (await withTargetApp("salesforce", () => extractDomModelFromPage(page, "https://x.test/list")))!.pages[0].elements;
    expect(els.map((e) => e.name)).toContain("New");
  });

  it("an ordinary run is unchanged: generic clickables end the poll at once", async () => {
    process.env.DISCOVERY_LIVE_DOM = "true";
    try {
      await page.setContent(`<span style="cursor:pointer">Fav</span><div id="late"></div>
        <script>setTimeout(() => { document.getElementById("late").innerHTML = "<button>New</button>"; }, 1200);</script>`);
      const els = (await extractDomModelFromPage(page, "https://x.test/list"))!.pages[0].elements;
      expect(els.map((e) => e.name)).not.toContain("New");
    } finally { delete process.env.DISCOVERY_LIVE_DOM; }
  });
});
