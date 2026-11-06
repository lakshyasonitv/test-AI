import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { generateSpec } from "../src/stages/generator.js";
import { checkBoxLive, chooseLive, chooseMultiLive } from "../src/stages/targetResolver.js";
import type { IR } from "../src/schema/ir.js";
import { specHelpers } from "./fixtures/specHelpers.js";

/**
 * D-74 (MULTI_VALUE_CONTROLS_ENABLED): screen-flow fields that take SEVERAL values, executed in a
 * real browser (D-19) — the helpers are lifted from the generated spec's TEXT and run, never a
 * reimplementation.
 *
 * The markup is SLDS-shaped, not captured from an org: no saved run holds a dual listbox or a
 * checkbox group (the one multi-select picklist an org model lists, Contact.BuyerAttributes in run
 * 2026-10-29T04-50-18-125Z-a0fe4a84, was not on its form). What it copies is what the defects hang
 * on: Lightning's dual listbox (a role=group named by the field, two aria-multiselectable lists,
 * option click = highlight, an arrow button between the lists = move), and SLDS's visually hidden
 * checkbox/radio input with the painted box in its label.
 */

const meta = { feature: "flow", title: "screen flow", priority: "medium", sourcePrompt: "p", baseUrl: "https://x.test" } as const;
const STEPS = [
  { id: "s1", action: "select", target: { role: "group", name: "Interests" }, value: "Red" },
  { id: "s2", action: "check", target: { role: "checkbox", name: "Email" } },
  { id: "s3", action: "click", target: { role: "radio", name: "Phone" } },
] as unknown as IR["steps"];
const spec = () => generateSpec({ meta, steps: STEPS } as IR, "artifacts");

const SLDS = `<style>
.slds-checkbox input, .slds-radio input { width:1px;height:1px;border:0;clip:rect(0 0 0 0);margin:-1px;overflow:hidden;padding:0;position:absolute; }
.faux { display:inline-block; width:16px; height:16px; border:1px solid #888; }
li { list-style:none } [role=option][aria-selected=true] { background:#cce }
</style>`;

/** One dual listbox, as the markup Lightning draws: options highlight on click (ctrl adds), the
 *  first arrow moves highlighted options into the second list, the second arrow moves them back. */
const DUAL = (id: string, label: string, options: string[], chosen: string[] = []) => `
<div role="group" aria-labelledby="${id}-l" id="${id}"><span id="${id}-l">${label}</span>
  <div class="col"><span id="${id}-al">Available</span>
    <ul role="listbox" aria-labelledby="${id}-al" aria-multiselectable="true" id="${id}-src">
      ${options.map((o) => `<li role="presentation"><div role="option" aria-selected="false"><span>${o}</span></div></li>`).join("")}
    </ul></div>
  <div class="col"><button type="button" id="${id}-right" title="Move to Selected">&rarr;</button>
    <button type="button" id="${id}-left" title="Move to Available">&larr;</button></div>
  <div class="col"><span id="${id}-sl">Selected</span>
    <ul role="listbox" aria-labelledby="${id}-sl" aria-multiselectable="true" id="${id}-dst">
      ${chosen.map((o) => `<li role="presentation"><div role="option" aria-selected="false"><span>${o}</span></div></li>`).join("")}
    </ul></div>
  <div class="col"><button type="button">Up</button><button type="button">Down</button></div>
</div>`;

const DUAL_SCRIPT = `<script>
document.addEventListener('click', (e) => {
  const path = e.composedPath();
  const o = path.find((n) => n.getAttribute && n.getAttribute('role') === 'option');
  if (o) {
    const list = path.find((n) => n.getAttribute && n.getAttribute('role') === 'listbox');
    if (!(e.ctrlKey || e.metaKey)) list.querySelectorAll('[role=option]').forEach((x) => x.setAttribute('aria-selected', 'false'));
    o.setAttribute('aria-selected', o.getAttribute('aria-selected') === 'true' ? 'false' : 'true');
    return;
  }
  const b = path.find((n) => n.tagName === 'BUTTON');
  if (!b || !/-(right|left)$/.test(b.id || '')) return;
  const group = path.find((n) => n.getAttribute && n.getAttribute('role') === 'group');
  const [src, dst] = group.querySelectorAll('[role=listbox]');
  const from = b.id.endsWith('-right') ? src : dst, to = from === src ? dst : src;
  from.querySelectorAll('[role=option][aria-selected=true]').forEach((x) => { x.setAttribute('aria-selected', 'false'); to.appendChild(x.parentElement); });
});
</script>`;

const BOXES = `
<fieldset id="ch"><legend>Channels</legend>
  <span class="slds-checkbox"><input type="checkbox" id="cb1" value="Email"><label for="cb1"><span class="faux"></span><span>Email</span></label></span>
  <span class="slds-checkbox"><input type="checkbox" id="cb2" value="SMS"><label for="cb2"><span class="faux"></span><span>SMS</span></label></span>
</fieldset>
<fieldset id="cb-by" role="radiogroup" aria-label="Contact by">
  <span class="slds-radio"><input type="radio" name="r" id="r1"><label for="r1"><span class="faux"></span><span>Phone</span></label></span>
  <span class="slds-radio"><input type="radio" name="r" id="r2"><label for="r2"><span class="faux"></span><span>Mail</span></label></span>
</fieldset>
<label>Plain <input type="checkbox" id="plain"></label>
<label>Rating <select id="rating"><option>Cold</option><option>Warm</option><option>Hot</option></select></label>
<label>Tags <select id="tags" multiple><option>Alpha</option><option>Beta</option><option>Gamma</option></select></label>`;

const PAGE = `<html><head>${SLDS}</head><body>${DUAL("int", "Interests", ["Red", "Blue", "Green"])}${DUAL("col", "Colours", ["Cyan", "Magenta"], ["Black"])}${BOXES}${DUAL_SCRIPT}</body></html>`;

/** The same dual listbox inside an OPEN shadow root (a component's own tree), as Lightning nests it. */
const SHADOW_PAGE = `<html><head>${SLDS}</head><body><x-dual id="host"></x-dual>
<script>
customElements.define('x-dual', class extends HTMLElement {
  connectedCallback() {
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = ${JSON.stringify(DUAL("sh", "Regions", ["North", "South"]))};
  }
});
</script>${DUAL_SCRIPT}</body></html>`;

const chosen = (page: Page, id: string) => page.locator(`#${id}-dst [role=option]`).allTextContents();

describe("MULTI_VALUE_CONTROLS_ENABLED off: the spec is exactly as before", () => {
  afterEach(() => { delete process.env.MULTI_VALUE_CONTROLS_ENABLED; });

  it("emits choose(), .check() and safeClick() — and none of the new helpers — unset or \"false\"", () => {
    delete process.env.MULTI_VALUE_CONTROLS_ENABLED;
    const unset = spec();
    process.env.MULTI_VALUE_CONTROLS_ENABLED = "false";
    expect(spec()).toBe(unset);
    expect(unset).toContain(`await choose(page, (await field(page, "Interests", "select")), "Red");`);
    expect(unset).toContain(`.check({ timeout: 10000 });`);
    expect(unset).toContain(`await safeClick(page, "radio", "Phone");`);
    expect(unset).not.toMatch(/chooseMulti|checkBox/);
  });
});

describe("the defects, with the flag off (why the flag exists)", () => {
  let browser: Browser;
  let page: Page;
  let h: any;
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    delete process.env.MULTI_VALUE_CONTROLS_ENABLED;
    h = specHelpers(spec(), ["field", "choose"]);
  });
  afterAll(async () => { await browser.close(); });

  it("select on a dual listbox reports success while the value never reaches the chosen list", async () => {
    await page.setContent(PAGE);
    await h.choose(page, await h.field(page, "Interests", "select"), "Red");   // no error...
    expect(await chosen(page, "int")).toEqual([]);                              // ...and nothing chosen
  });

  it("check on an SLDS checkbox times out: the real input is visually hidden", async () => {
    await page.setContent(PAGE);
    const box = await h.field(page, "Email", "check");
    await expect(box.check({ timeout: 1500 })).rejects.toThrow(/Timeout/);
    expect(await page.locator("#cb1").isChecked()).toBe(false);
  });
});

describe("MULTI_VALUE_CONTROLS_ENABLED on: the emitted helpers, executed", () => {
  let browser: Browser;
  let page: Page;
  let h: any;
  let SPEC = "";
  beforeAll(async () => {
    process.env.MULTI_VALUE_CONTROLS_ENABLED = "true";
    SPEC = spec();
    delete process.env.MULTI_VALUE_CONTROLS_ENABLED;
    browser = await chromium.launch();
    page = await browser.newPage();
    h = specHelpers(SPEC, ["field", "choose", "checkBox", "chooseMulti"]);
  });
  afterAll(async () => { await browser.close(); });
  const pick = async (name: string, value: string) =>
    h.chooseMulti(page, await h.field(page, name, "select"), value, undefined, h.choose, h.checkBox);

  it("emits chooseMulti / checkBox for select, check and a radio click, and splices their source", () => {
    expect(SPEC).toContain(`await chooseMulti(page, (await field(page, "Interests", "select")), "Red", undefined, choose, checkBox);`);
    expect(SPEC).toContain(`await checkBox(page, (await field(page, "Email", "check")));`);
    expect(SPEC).toContain(`await checkBox(page, (await field(page, "Phone", "check")));`);
    expect(SPEC).toContain("const chooseMulti = async (page, target, value, root, fallback, checkBox) => {");
    expect(SPEC).toContain("const checkBox = async (page, target, root) => {");
    expect(SPEC).toContain("async function choose(");   // the fallback is spliced too
  });

  it("dual listbox: two select steps MOVE both values into the chosen list", async () => {
    await page.setContent(PAGE);
    await pick("Interests", "Red");
    await pick("Interests", "Blue");
    expect(await chosen(page, "int")).toEqual(["Red", "Blue"]);
    expect(await page.locator("#int-src [role=option]").allTextContents()).toEqual(["Green"]);
    // The other dual listbox on the screen is untouched.
    expect(await chosen(page, "col")).toEqual(["Black"]);
  });

  it("dual listbox: targeting one of its lists (\"Available\") works the same", async () => {
    await page.setContent(PAGE);
    await h.chooseMulti(page, page.locator("#int-src"), "Green", undefined, h.choose, h.checkBox);
    expect(await chosen(page, "int")).toEqual(["Green"]);
  });

  it("dual listbox: a value already chosen is left as it is", async () => {
    await page.setContent(PAGE);
    await pick("Colours", "Black");
    expect(await chosen(page, "col")).toEqual(["Black"]);
  });

  it("dual listbox: a value not on offer fails naming what is", async () => {
    await page.setContent(PAGE);
    await expect(pick("Interests", "Purple")).rejects.toThrow(/no option matching "Purple" in this multi-value field\. Available: "Red", "Blue", "Green"/);
  });

  it("dual listbox inside an open shadow root", async () => {
    await page.setContent(SHADOW_PAGE);
    await h.chooseMulti(page, page.locator("#sh"), "South", undefined, h.choose, h.checkBox);
    expect(await page.locator("#sh-dst [role=option]").allTextContents()).toEqual(["South"]);
  });

  it("checkbox group: select \"Email\" in \"Channels\" checks that box, and only that one", async () => {
    await page.setContent(PAGE);
    await h.chooseMulti(page, page.locator("#ch"), "Email", undefined, h.choose, h.checkBox);
    await h.chooseMulti(page, page.locator("#ch"), "SMS", undefined, h.choose, h.checkBox);
    expect(await page.locator("#cb1").isChecked()).toBe(true);
    expect(await page.locator("#cb2").isChecked()).toBe(true);
    await expect(h.chooseMulti(page, page.locator("#ch"), "Fax", undefined, h.choose, h.checkBox))
      .rejects.toThrow(/Available: "Email", "SMS"/);
  });

  it("check on an SLDS checkbox goes through its label, fast, and is verified", async () => {
    await page.setContent(PAGE);
    const t0 = Date.now();
    await h.checkBox(page, await h.field(page, "Email", "check"));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await page.locator("#cb1").isChecked()).toBe(true);
    // Checking a box that is already checked keeps it checked (check, not toggle).
    await h.checkBox(page, await h.field(page, "Email", "check"));
    expect(await page.locator("#cb1").isChecked()).toBe(true);
  });

  it("a radio is chosen through its label, without the forced-click fallback's wait", async () => {
    await page.setContent(PAGE);
    const t0 = Date.now();
    await h.checkBox(page, await h.field(page, "Phone", "check"));
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(await page.locator("#r1").isChecked()).toBe(true);
  });

  it("an ordinary visible checkbox is checked as before", async () => {
    await page.setContent(PAGE);
    await h.checkBox(page, page.locator("#plain"));
    expect(await page.locator("#plain").isChecked()).toBe(true);
  });

  it("a single-value <select> falls through to choose() unchanged", async () => {
    await page.setContent(PAGE);
    await pick("Rating", "Warm");
    expect(await page.locator("#rating").inputValue()).toBe("Warm");
  });

  it("a <select multiple> gets each value ADDED to the selection", async () => {
    await page.setContent(PAGE);
    const tags = page.locator("#tags");
    await h.chooseMulti(page, tags, "Alpha", undefined, h.choose, h.checkBox);
    await h.chooseMulti(page, tags, "Gamma", undefined, h.choose, h.checkBox);
    expect(await page.locator("#tags").evaluate((el: HTMLSelectElement) => [...el.selectedOptions].map((o) => o.text))).toEqual(["Alpha", "Gamma"]);
  });
});

describe("the grounding replay runs the same source (TD-07)", () => {
  let browser: Browser;
  let page: Page;
  beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
  afterAll(async () => { await browser.close(); });

  it("chooseMultiLive moves the value; checkBoxLive checks a hidden SLDS box", async () => {
    await page.setContent(PAGE);
    await chooseMultiLive(page, page.getByRole("group", { name: "Interests" }), "Blue", undefined, chooseLive, checkBoxLive);
    expect(await chosen(page, "int")).toEqual(["Blue"]);
    await checkBoxLive(page, page.getByLabel("SMS", { exact: true }));
    expect(await page.locator("#cb2").isChecked()).toBe(true);
    await chooseMultiLive(page, page.getByLabel("Rating"), "Hot", undefined, chooseLive, checkBoxLive);
    expect(await page.locator("#rating").inputValue()).toBe("Hot");
  });
});
