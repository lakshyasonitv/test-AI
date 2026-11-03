import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { generateSpec } from "../src/stages/generator.js";
import { runStepLive } from "../src/stages/liveExtend.js";

/**
 * A fill into a field that already holds a value must REPLACE it.
 *
 * Run 2026-11-02T17-24-47-449Z-ab0328f3 (R3): Stage "Prospecting" had set Probability (%) to 10,
 * shown as "10%". fill() selects the text and then focuses the input; on focus Lightning redraws
 * "10%" as the raw "10", which drops fill()'s selection, so "10" was typed after it: "1010", and
 * Save was rejected ("no more than 3 digits"). Focusing first lets the redraw happen before fill()
 * selects. Executed in a real browser (D-19): the bug only exists in the event order.
 */
const PERCENT = `<html><body>
  <label for="p">Probability (%)</label>
  <input id="p" type="text" inputmode="decimal" />
  <script>{
    const p = document.getElementById("p");
    let raw = "10";
    const show = (focused) => { p.value = raw === "" ? "" : (focused ? raw : raw + "%"); };
    p.addEventListener("focus", () => Promise.resolve().then(() => show(true)));
    p.addEventListener("input", () => { raw = p.value.replace(/%/g, ""); });
    p.addEventListener("blur", () => show(false));
    show(false);
  }</script>
</body></html>`;

const step = { id: "s1", action: "fill", target: { css: "#p" }, value: "10" } as any;

describe("fill into a prefilled, reformatting field", () => {
  let browser: Browser; let page: Page;
  beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); }, 60_000);
  afterAll(async () => { await browser?.close(); });

  it("the generated spec's fill step leaves '10', not '1010'", async () => {
    const spec = generateSpec({ meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
      steps: [step] } as any);
    const line = spec.split("\n").find((l) => l.includes('.fill("10"'));
    expect(line).toBeDefined();
    const AsyncFunction = Object.getPrototypeOf(async function () { /* */ }).constructor;
    await page.setContent(PERCENT);
    expect(await page.locator("#p").inputValue()).toBe("10%");
    await new AsyncFunction("page", line)(page);
    expect(await page.locator("#p").inputValue()).toBe("10");
  }, 60_000);

  it("the grounding replay's fill leaves '10', not '1010'", async () => {
    await page.setContent(PERCENT);
    await runStepLive(page, step, "https://zq.example");
    expect(await page.locator("#p").inputValue()).toBe("10");
  }, 60_000);
});
