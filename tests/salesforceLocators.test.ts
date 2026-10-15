import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

// Handoff Phase 3: on a Salesforce run the live walker's selector ladder skips Lightning's generated
// ids and prefers a role + accessible-name selector (then a label-anchored one), all confirmed unique
// by Playwright. Every new locator form is EXECUTED here in a real Chromium (D-19), including after a
// re-render that changes every generated id — the thing that breaks today's `#email-145`.

const { walkLiveDom } = await import("../src/stages/liveDomDiscovery.js");
const { withTargetApp } = await import("../src/runTarget.js");
const { chromiumLaunchOptions } = await import("../src/browserLaunch.js");

const FIXTURE = new URL("./fixtures/salesforceLocators/walker-ordinary.json", import.meta.url);

/**
 * An EOI-shaped form inside an open shadow root, Lightning style: every id ends in a per-session
 * number. `render(n)` rebuilds it with suffix n. Two "Next" buttons (one per form section), and one
 * field with NO accessible name, only a visible label-like text above it.
 */
const PAGE = `<!doctype html><html><head><title>EOI</title></head><body>
<h1>Express Interest</h1><lead-form id="host"></lead-form><p id="clicked"></p>
<script>
  const root = document.getElementById("host").attachShadow({ mode: "open" });
  window.render = (n) => {
    root.innerHTML =
      '<section><label for="email-' + n + '">Email Address</label><input id="email-' + n + '">' +
      '<label for="phone-' + n + '">Phone Number</label><input id="phone-' + n + '">' +
      '<button id="next-' + n + '" data-step="1">Next</button></section>' +
      '<section><div>Budget</div><input id="budget-' + n + '">' +
      '<button id="next2-' + n + '" data-step="2">Next</button></section>';
    for (const b of root.querySelectorAll("button")) b.onclick = () => { document.getElementById("clicked").textContent = b.dataset.step; };
  };
  render(145);
</script></body></html>`;

let browser: Browser;
let page: Page;
beforeAll(async () => { browser = await chromium.launch(chromiumLaunchOptions()); });
afterAll(async () => { await browser.close(); });

async function fresh(): Promise<Page> {
  page = await browser.newPage();
  await page.setContent(PAGE);
  return page;
}
const byName = (items: any[], role: string, name: string) => items.filter((i) => i.role === role && i.name === name);

describe("Salesforce locators survive a re-render (handoff Phase 3)", () => {
  it("no generated id is emitted; the role selector still finds and fills the field after -145 becomes -146", async () => {
    const p = await fresh();
    const items = await withTargetApp("salesforce", () => walkLiveDom(p));
    for (const i of items) expect(i.css, `${i.role} "${i.name}"`).not.toMatch(/-14\d\b/);
    const [email] = byName(items, "textbox", "Email Address");
    expect(email.css).toContain('role=textbox[name="Email Address"s]');

    await p.evaluate(() => (window as any).render(146));
    expect(await p.locator(email.css).count()).toBe(1);
    await p.locator(email.css).fill("a@b.c");
    expect(await p.locator("lead-form").evaluate((h) => (h.shadowRoot!.getElementById("email-146") as HTMLInputElement).value)).toBe("a@b.c");
    await p.close();
  }, 60_000);

  it("the generated spec's own expression for that css runs (D-19: execute what is emitted, not a string)", async () => {
    const { resolveCode } = await import("../src/stages/targetResolver.js");
    const p = await fresh();
    const items = await withTargetApp("salesforce", () => walkLiveDom(p));
    const [email] = byName(items, "textbox", "Email Address");
    const code = resolveCode({ role: "textbox", name: "Email Address", css: email.css } as any, "fill");
    await p.evaluate(() => (window as any).render(146));
    const locator = new Function("page", `return ${code};`)(p);
    await locator.fill("x@y.z");
    expect(await p.locator("lead-form").evaluate((h) => (h.shadowRoot!.getElementById("email-146") as HTMLInputElement).value)).toBe("x@y.z");
    await p.close();
  }, 60_000);

  it("two buttons named \"Next\": the role selector is not unique, and the emitted css still clicks the right one", async () => {
    const p = await fresh();
    const items = await withTargetApp("salesforce", () => walkLiveDom(p));
    const nexts = byName(items, "button", "Next");
    expect(nexts).toHaveLength(2);
    for (const n of nexts) expect(n.css).not.toContain('role=button[name="Next"s]');
    for (const [k, n] of nexts.entries()) {
      expect(n.css).not.toBe("");
      await p.locator(n.css).click();
      expect(await p.locator("#clicked").textContent()).toBe(String(k + 1));
    }
    await p.close();
  }, 60_000);

  it("a field with no accessible name is anchored below its visible label, and that css runs", async () => {
    const p = await fresh();
    const items = await withTargetApp("salesforce", () => walkLiveDom(p));
    const budget = items.find((i) => i.tag === "input" && i.proximity === "Budget");
    expect(budget?.css).toMatch(/input:(below|right-of)\(:text\("Budget"\)\)/);
    await p.evaluate(() => (window as any).render(146));
    await p.locator(budget!.css).fill("40");
    expect(await p.locator("lead-form").evaluate((h) => (h.shadowRoot!.getElementById("budget-146") as HTMLInputElement).value)).toBe("40");
    await p.close();
  }, 60_000);

  it("a Salesforce run never reuses a capture cached under the old ladder; ordinary walk keys are unchanged", async () => {
    const { walkCacheKey } = await import("../src/stages/liveExtend.js");
    const { makeCacheKey, credentialFingerprint, llmCacheVersion } = await import("../src/kb/llmCache.js");
    const { llmCacheDimension } = await import("../src/llm/llmContext.js");
    const { localeCacheDimension } = await import("../src/browserLaunch.js");
    const model: any = { baseUrl: "https://org.example.my.site.com", pages: [] };
    const prefix: any[] = [{ id: "s1", action: "navigate", target: { url: "/" } }];
    const before = (settle: boolean) => makeCacheKey(...[model.baseUrl, JSON.stringify(prefix), "full", credentialFingerprint(undefined),
      llmCacheDimension("main"), localeCacheDimension(), llmCacheVersion(), ...(settle ? ["screen-settle:2"] : [])]);
    for (const settle of [false, true]) {
      expect(walkCacheKey(model, prefix, undefined, "full", { settle })).toBe(before(settle));
      expect(withTargetApp("salesforce", () => walkCacheKey(model, prefix, undefined, "full", { settle }))).not.toBe(before(settle));
    }
  });

  it("an ordinary (non-Salesforce) walk is byte-identical to the walker before this change", async () => {
    const p = await fresh();
    const items = (await walkLiveDom(p)).map((i: any) => ({ role: i.role, name: i.name, css: i.css, candidates: i.candidates }));
    if (process.env.WRITE_SF_LOCATOR_FIXTURE === "1") writeFileSync(FIXTURE, JSON.stringify(items, null, 1) + "\n");
    expect(items).toEqual(JSON.parse(readFileSync(FIXTURE, "utf8")));
    await p.close();
  }, 60_000);
});
