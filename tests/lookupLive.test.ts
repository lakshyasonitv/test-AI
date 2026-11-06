import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { lookupLive } from "../src/stages/targetResolver.js";

/**
 * A Lightning LOOKUP: an input role=combobox whose listbox fills with records on focus (recent
 * items) and filters as the person types; the first row is "New <Object>", which is never a record.
 * Run 2026-10-24T21-26-12-355Z-15cbc64f typed into one and never picked, so the save failed.
 * Canary names; option text lives in each item's shadow root, as Lightning's does.
 */
const LOOKUP = `<html><body>
  <div role="dialog" aria-label="New Zq Person">
    <label for="lk">Zq Firm Name</label>
    <input id="lk" role="combobox" aria-controls="lk-list" aria-expanded="false" autocomplete="off" />
    <div id="lk-list" role="listbox" style="display:none"></div>
    <div id="picked"></div>
  </div>
  <script>
    // setContent re-runs this script in the same page: a second define() throws and would skip the
    // listeners below (which is why only the first test could ever pass).
    if (!customElements.get("zq-item")) customElements.define("zq-item", class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        this.attachShadow({ mode: "open" }).innerHTML = '<span>' + this.dataset.text + '</span>';
      }
    });
    // Block-scoped: setContent re-runs this script in the same window, and a top-level const
    // redeclared throws, leaving the new input without listeners.
    {
    const input = document.getElementById("lk"), list = document.getElementById("lk-list");
    const all = ["New Zq Firm", "Zq Alpha Labs", "Zq Beta Studio", "Zq Gamma Energy"];
    function render() {
      const q = input.value.toLowerCase();
      list.innerHTML = "";
      for (const v of all) {
        if (q && v !== all[0] && !v.toLowerCase().includes(q)) continue;
        // Lightning marks its action rows data-value="actionCreateNew"; a record's is its id.
        const it = document.createElement("zq-item"); it.setAttribute("role", "option"); it.dataset.text = v;
        it.dataset.value = v === all[0] ? "actionCreateNew" : "001" + v.length;
        it.addEventListener("click", () => { document.getElementById("picked").textContent = v; list.style.display = "none"; });
        list.appendChild(it);
      }
      list.style.display = "block"; input.setAttribute("aria-expanded", "true");
    }
    input.addEventListener("click", () => setTimeout(render, 150));
    input.addEventListener("input", () => setTimeout(render, 100));
    }
  </script>
</body></html>`;

/** LOOKUP below a required field whose 20 px error line is removed when that field loses focus. */
const SHIFT = `<html><body style="font: 14px sans-serif"><div role="dialog" aria-label="New Zq Person" style="padding: 20px">
  <label for="nm">Zq Surname</label><br><input id="nm" style="height: 28px; width: 300px" />
  <div id="err" style="height: 20px; color: #c00">Complete this field.</div>
  <label for="lk">Zq Firm Name</label><br>
  <input id="lk" role="combobox" aria-controls="lk-list" aria-expanded="false" autocomplete="off" style="height: 32px; width: 300px" />
  <div id="lk-list" role="listbox" style="display: none"></div><div id="picked"></div></div>
  <script>{
    const nm = document.getElementById("nm"), err = document.getElementById("err");
    nm.addEventListener("blur", () => Promise.resolve().then(() => { err.style.display = "none"; }));
    const lk = document.getElementById("lk"), list = document.getElementById("lk-list");
    lk.addEventListener("click", () => setTimeout(() => {
      list.innerHTML = "";
      for (const v of ["New Zq Firm", "Zq Alpha Labs"]) {
        const o = document.createElement("div"); o.setAttribute("role", "option"); o.textContent = v;
        if (v.startsWith("New ")) o.dataset.value = "actionCreateNew";
        o.addEventListener("click", () => { document.getElementById("picked").textContent = v; list.style.display = "none"; });
        list.appendChild(o);
      }
      list.style.display = "block"; lk.setAttribute("aria-expanded", "true");
    }, 150));
  }</script></body></html>`;

describe("lookupLive", () => {
  let browser: Browser; let page: Page;
  beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
  afterAll(async () => { await browser?.close(); });

  it("types the value and picks the first matching record", async () => {
    await page.setContent(LOOKUP);
    await lookupLive(page, page.getByRole("combobox", { name: "Zq Firm Name" }), "beta");
    expect(await page.locator("#picked").textContent()).toBe("Zq Beta Studio");
  });

  it("with no value, picks the first RECORD, never the 'New …' row", async () => {
    await page.setContent(LOOKUP);
    await lookupLive(page, page.getByRole("combobox", { name: "Zq Firm Name" }), "");
    expect(await page.locator("#picked").textContent()).toBe("Zq Alpha Labs");
  });

  // The SPEC's copy (generator.ts LOOKUP_HELPER) is source inside a template literal: run the text the
  // generator actually emits, so a lost backslash ("\\w", "\\b", "\\s") fails here, not in an org.
  it("the generated spec's lookupPick runs the same way", async () => {
    const { generateSpec } = await import("../src/stages/generator.js");
    const { extractFn, extractConst } = await import("./fixtures/specHelpers.js");
    const spec = generateSpec({ meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
      steps: [{ id: "s1", action: "select", target: { role: "combobox", name: "Zq Firm Name", css: "#lk", lookup: true }, value: "" }] } as any);
    const pick = new Function(`${extractConst(spec, "lookupOptionError")}\n${extractFn(spec, "lookupPick")}\nreturn lookupPick;`)();
    await page.setContent(LOOKUP);
    await pick(page, page.getByRole("combobox", { name: "Zq Firm Name" }), "");
    expect(await page.locator("#picked").textContent()).toBe("Zq Alpha Labs");
    await page.setContent(LOOKUP);
    await pick(page, page.getByRole("combobox", { name: "Zq Firm Name" }), "gamma");
    expect(await page.locator("#picked").textContent()).toBe("Zq Gamma Energy");
  });

  // Run 2026-11-02T17-17-02-125Z-59cae03e (R1, Parent Account): the field above dropped its
  // "Complete this field." line on blur, the lookup moved up 20 px between mousedown and mouseup,
  // the input got focus but no click, and Lightning never opened its recent-records list.
  it("clicks once more when the first click did not open the list (layout shift on blur)", async () => {
    const { generateSpec } = await import("../src/stages/generator.js");
    const { extractFn, extractConst } = await import("./fixtures/specHelpers.js");
    const spec = generateSpec({ meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
      steps: [{ id: "s1", action: "select", target: { role: "combobox", name: "Zq Firm Name", css: "#lk", lookup: true }, value: "" }] } as any);
    const pick = new Function(`${extractConst(spec, "lookupOptionError")}\n${extractFn(spec, "lookupPick")}\nreturn lookupPick;`)();
    for (const fn of [lookupLive, pick]) {
      await page.setContent(SHIFT);
      await page.locator("#nm").fill("Rao");
      await fn(page, page.getByRole("combobox", { name: "Zq Firm Name" }), "");
      expect(await page.locator("#picked").textContent()).toBe("Zq Alpha Labs");
    }
  }, 60_000);

  // Run 2026-11-03T05-42-52-539Z-8f96a6d6: the org's campaigns are named "New Campaign <code>"; the
  // list also held a "Recent Items" heading and the bare "New Campaign" action.
  it("picks a record named 'New Campaign x', never the heading or the bare 'New Campaign' action", async () => {
    const LIST = `<html><body><label for="lk">Zq Source</label>
      <input id="lk" role="combobox" aria-controls="ls" aria-expanded="false" />
      <div id="ls" role="listbox" style="display:none">
        <div role="option">Recent Items</div>
        <div role="option" data-value="701A">New Campaign s9kj61</div>
        <div role="option" data-value="actionCreateNew">New Campaign</div>
      </div><div id="picked"></div>
      <script>{ const lk = document.getElementById("lk"), ls = document.getElementById("ls");
        lk.addEventListener("click", () => { ls.style.display = "block"; lk.setAttribute("aria-expanded", "true"); });
        for (const o of ls.children) o.addEventListener("click", () => { document.getElementById("picked").textContent = o.textContent; }); }</script>
      </body></html>`;
    const { generateSpec } = await import("../src/stages/generator.js");
    const { extractFn, extractConst } = await import("./fixtures/specHelpers.js");
    const spec = generateSpec({ meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
      steps: [{ id: "s1", action: "select", target: { role: "combobox", name: "Zq Source", css: "#lk", lookup: true }, value: "" }] } as any);
    const pick = new Function(`${extractConst(spec, "lookupOptionError")}\n${extractFn(spec, "lookupPick")}\nreturn lookupPick;`)();
    for (const fn of [lookupLive, pick]) {
      await page.setContent(LIST);
      await fn(page, page.getByRole("combobox", { name: "Zq Source" }), "");
      expect(await page.locator("#picked").textContent()).toBe("New Campaign s9kj61");
    }
  }, 60_000);

  // Run 2026-11-03T08-05-18-274Z-12e7be67: the Account this test had just created was not in search
  // yet, so typing its name listed nothing; the empty input's Recent Items had it.
  it("finds a record the search does not know yet in the Recent Items list", async () => {
    const RECENT = `<html><body><label for="lk">Zq Account</label>
      <input id="lk" role="combobox" aria-controls="ls" aria-expanded="false" />
      <div id="ls" role="listbox" style="display:none"></div><div id="picked"></div>
      <script>{ const lk = document.getElementById("lk"), ls = document.getElementById("ls");
        const show = () => { ls.innerHTML = ""; const rows = lk.value ? [] : ["Zq Fresh 0abc12", "Zq Older"];
          for (const v of rows) { const o = document.createElement("div"); o.setAttribute("role", "option"); o.dataset.value = "001" + v.length; o.textContent = v;
            o.addEventListener("click", () => { document.getElementById("picked").textContent = v; }); ls.appendChild(o); }
          ls.style.display = "block"; lk.setAttribute("aria-expanded", "true"); };
        lk.addEventListener("click", show); lk.addEventListener("input", () => setTimeout(show, 50)); }</script>
      </body></html>`;
    const { generateSpec } = await import("../src/stages/generator.js");
    const { extractFn, extractConst } = await import("./fixtures/specHelpers.js");
    const spec = generateSpec({ meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
      steps: [{ id: "s1", action: "select", target: { role: "combobox", name: "Zq Account", css: "#lk", lookup: true }, value: "x" }] } as any);
    const pick = new Function(`${extractConst(spec, "lookupOptionError")}\n${extractFn(spec, "lookupPick")}\nreturn lookupPick;`)();
    for (const fn of [lookupLive, pick]) {
      await page.setContent(RECENT);
      await fn(page, page.getByRole("combobox", { name: "Zq Account" }), "Zq Fresh 0abc12");
      expect(await page.locator("#picked").textContent()).toBe("Zq Fresh 0abc12");
    }
  }, 60_000);

  it("says what was on offer when nothing matches", async () => {
    await page.setContent(LOOKUP);
    await expect(lookupLive(page, page.getByRole("combobox", { name: "Zq Firm Name" }), "zz-nothing")).rejects.toThrow(/zz-nothing/);
  });
});
