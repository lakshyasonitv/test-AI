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
        this.attachShadow({ mode: "open" }).innerHTML = '<span>' + this.dataset.value + '</span>';
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
        const it = document.createElement("zq-item"); it.setAttribute("role", "option"); it.dataset.value = v;
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

  it("says what was on offer when nothing matches", async () => {
    await page.setContent(LOOKUP);
    await expect(lookupLive(page, page.getByRole("combobox", { name: "Zq Firm Name" }), "zz-nothing")).rejects.toThrow(/zz-nothing/);
  });
});
