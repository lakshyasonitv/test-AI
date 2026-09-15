import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { generateSpec } from "../src/stages/generator.js";
import type { IR } from "../src/schema/ir.js";
import { specHelpers } from "./fixtures/specHelpers.js";

/**
 * Field resolution inside a modal — TECH_DEBT.md TD-72 / TD-76.
 *
 * THE FAILURE. Run `2026-09-06T13-05-36-248Z-db2c0b4c`, replaying "Admin creates a new user" on
 * the real LMS. Its final screenshot shows the New User modal with **Full Name containing
 * `test@thinkvibes.com` and Email empty**: step 10 typed the name into Full Name correctly, then
 * step 11 ("Fill Email") resolved to the SAME input and overwrote it.
 *
 * The modal only exists after clicking "Add New", so discovery never saw it and its steps carry no
 * `css`/`testId`. Resolution fell to `input:near(:text("Email"), 120)` + `.first()`; the Email
 * label sits ~46px below the Full Name input, so both inputs are inside the radius and `.first()`
 * breaks the tie by DOCUMENT ORDER. It picked the wrong one.
 *
 * The fix is not a better tie-break. "Which control is nearest in pixels" is the wrong question —
 * the control a label describes is the next one AFTER it, which the DOM states exactly.
 *
 * WHY A REAL BROWSER (D-19). `:near()`, `:visible`, `compareDocumentPosition` and
 * `selectOption`'s matching are all browser behaviour. A string assertion on the emitted spec
 * cannot tell a right answer from a wrong one here — which is exactly how the original bug
 * shipped. The helpers below are extracted from the GENERATED spec text and executed.
 */

function extractFn(src: string, name: string): string {
  const at = src.indexOf(`function ${name}(`);
  if (at === -1) throw new Error(`generated spec does not define ${name}()`);
  const start = src.lastIndexOf("async ", at) === at - 6 ? at - 6 : at;
  let depth = 0;
  for (let k = src.indexOf("{", at); k < src.length; k++) {
    if (src[k] === "{") depth++;
    else if (src[k] === "}" && --depth === 0) return src.slice(start, k + 1);
  }
  throw new Error(`unbalanced braces extracting ${name}()`);
}

/** The real steps from that run's saved IR, from "Add New" onward. */
const SAVED_MODAL_STEPS = [
  { id: "s10", action: "fill", target: { role: "textbox", name: "Full Name" }, value: "test lakshay" },
  { id: "s11", action: "fill", target: { role: "textbox", name: "Email" }, value: "test@thinkvibes.com" },
  { id: "s12", action: "select", target: { role: "combobox", name: "Manager" }, value: "prashant mishra" },
  { id: "s13", action: "select", target: { role: "combobox", name: "Role" }, value: "Learner" },
  { id: "s14", action: "click", target: { role: "button", name: "Save" } },
] as unknown as IR["steps"];

const SPEC = generateSpec({
  meta: {
    feature: "Admin", title: "Admin creates a new user via management interface",
    priority: "high", sourcePrompt: "add a user", baseUrl: "https://example.com",
  },
  steps: SAVED_MODAL_STEPS,
} as IR, "artifacts");

/**
 * The shape that broke, reproduced generically.
 *
 * BACKGROUND page carries its own "Email" input and its own "Save" button — the collision a modal
 * creates and the reason scoping matters. Inside the dialog: two label+input pairs 20px apart
 * (labels are plain `<div>`s with no `for`, the shape that defeats getByLabel), a native
 * `<select>` whose option text is cased DIFFERENTLY from the step value, and an input-based
 * combobox with a popup.
 */
const PAGE_HTML = `
<html><body style="margin:0;font-family:sans-serif">
  <!-- The page BEHIND the modal. Same names, different elements. -->
  <div id="behind" style="padding:8px">
    <div>Email</div>
    <input id="bg-email" style="width:240px">
    <button id="bg-save">Save</button>
    <select id="bg-role"><option>Learner</option></select>
  </div>

  <div id="dlg" role="dialog" aria-modal="true"
       style="position:fixed;top:40px;left:40px;width:420px;background:#fff;border:1px solid #333;padding:12px">
    <h2>New User</h2>

    <div style="margin-bottom:4px">Full Name</div>
    <input id="d-name" style="width:380px;height:24px">

    <!-- 20px below the input above: inside the :near() radius, which is what broke it. -->
    <div style="margin-top:20px;margin-bottom:4px">Email</div>
    <input id="d-email" style="width:380px;height:24px">

    <div style="margin-top:20px;margin-bottom:4px">Role</div>
    <select id="d-role" style="width:380px">
      <option value="">Pick one</option>
      <option value="learner">Learner</option>
      <option value="admin">Admin</option>
    </select>

    <div style="margin-top:20px;margin-bottom:4px">Manager</div>
    <select id="d-manager" style="width:380px">
      <option value="">No manager</option>
      <!-- Cased differently from the step value "prashant mishra" — the real dropdown's shape. -->
      <option value="u1">Prashant Mishra</option>
      <option value="u2">Anita Rao</option>
    </select>

    <div style="margin-top:16px">
      <button id="d-cancel">Cancel</button>
      <button id="d-save">Save</button>
    </div>
  </div>

  <script>
    document.getElementById('d-save').addEventListener('click', function () {
      document.getElementById('d-save').setAttribute('data-clicked', '1');
    });
    document.getElementById('bg-save').addEventListener('click', function () {
      document.getElementById('bg-save').setAttribute('data-clicked', '1');
    });
  </script>
</body></html>`;

describe("field resolution inside an open dialog — executed in a real browser", () => {
  let browser: Browser;
  let page: Page;
  let h: Record<string, Function>;

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    h = specHelpers(SPEC, ["scopeOf", "field", "choose", "safeClick"]);
  });

  afterAll(async () => { await browser.close(); });

  it("emits the helpers it calls", () => {
    for (const n of ["scopeOf", "firstUnique", "field", "choose", "safeClick", "locate"]) {
      expect(SPEC).toContain(`function ${n}(`);
    }
  });

  it("scopes to the open dialog, not the page behind it", async () => {
    await page.setContent(PAGE_HTML);
    const scope = await h.scopeOf(page);
    expect(await scope.getAttribute("id")).toBe("dlg");
  });

  it("fills the DIALOG's Email, not the background page's", async () => {
    await page.setContent(PAGE_HTML);
    const el = await h.field(page, "Email", "fill");
    await el.fill("test@thinkvibes.com");
    expect(await page.locator("#d-email").inputValue()).toBe("test@thinkvibes.com");
    expect(await page.locator("#bg-email").inputValue()).toBe("");
  });

  it("does NOT overwrite Full Name when filling Email — the exact regression", async () => {
    await page.setContent(PAGE_HTML);
    await (await h.field(page, "Full Name", "fill")).fill("test lakshay");
    await (await h.field(page, "Email", "fill")).fill("test@thinkvibes.com");

    // The run under test produced name="test@thinkvibes.com", email="".
    expect(await page.locator("#d-name").inputValue()).toBe("test lakshay");
    expect(await page.locator("#d-email").inputValue()).toBe("test@thinkvibes.com");
  });

  it("matches a native <select> option whose casing differs from the step value", async () => {
    // "prashant mishra" vs <option>Prashant Mishra</option>. selectOption() is an exact match, so
    // this previously retried for the full 10s and reported only "did not find some options".
    await page.setContent(PAGE_HTML);
    const el = await h.field(page, "Manager", "select");
    await h.choose(page, el, "prashant mishra");
    expect(await page.locator("#d-manager").inputValue()).toBe("u1");
  });

  it("picks the dialog's Role select, not the identically-named one behind it", async () => {
    await page.setContent(PAGE_HTML);
    await h.choose(page, await h.field(page, "Role", "select"), "Learner");
    expect(await page.locator("#d-role").inputValue()).toBe("learner");
  });

  it("clicks the dialog's Save, not the page's", async () => {
    await page.setContent(PAGE_HTML);
    await h.safeClick(page, "button", "Save");
    expect(await page.locator("#d-save").getAttribute("data-clicked")).toBe("1");
    expect(await page.locator("#bg-save").getAttribute("data-clicked")).toBe(null);
  });

  it("still resolves normally when no dialog is open", async () => {
    await page.setContent(`
      <html><body>
        <div>Email</div><input id="only-email" style="width:200px">
        <button id="only-save">Save</button>
      </body></html>`);
    await (await h.field(page, "Email", "fill")).fill("plain@example.com");
    expect(await page.locator("#only-email").inputValue()).toBe("plain@example.com");
    await h.safeClick(page, "button", "Save");   // must not throw
  });

  it("replays the saved case's modal steps end to end", async () => {
    await page.setContent(PAGE_HTML);
    for (const step of SAVED_MODAL_STEPS as any[]) {
      if (step.action === "fill") {
        await (await h.field(page, step.target.name, "fill")).fill(step.value);
      } else if (step.action === "select") {
        await h.choose(page, await h.field(page, step.target.name, "select"), step.value);
      } else if (step.action === "click") {
        await h.safeClick(page, step.target.role, step.target.name);
      }
    }
    expect(await page.locator("#d-name").inputValue()).toBe("test lakshay");
    expect(await page.locator("#d-email").inputValue()).toBe("test@thinkvibes.com");
    expect(await page.locator("#d-manager").inputValue()).toBe("u1");
    expect(await page.locator("#d-role").inputValue()).toBe("learner");
    expect(await page.locator("#d-save").getAttribute("data-clicked")).toBe("1");
    // Nothing behind the modal was touched.
    expect(await page.locator("#bg-email").inputValue()).toBe("");
    expect(await page.locator("#bg-save").getAttribute("data-clicked")).toBe(null);
  });
});
