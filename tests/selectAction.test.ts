import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { generateSpec } from "../src/stages/generator.js";
import { nearFieldSelector } from "../src/stages/targetResolver.js";
import type { IR } from "../src/schema/ir.js";
import { specHelpers } from "./fixtures/specHelpers.js";

/**
 * A `select` step against something that is not a `<select>` element — TECH_DEBT.md TD-70.
 *
 * THE DEFECT. Grounding matches on ROLE. A React combobox has `role="combobox"` and is an
 * `<input>` with a popup list — no `<option>` children, no `selectOption()` support. The
 * generator emitted `selectOption()` unconditionally for the action, so run
 * `2026-09-04T10-38-19-619Z-bf20906d` (case "Admin creates a new user via management interface")
 * died on a perfectly valid case with:
 *
 *     locator.selectOption: Error: Element is not a <select> element
 *     waiting for locator('input:near(:text("Manager"), 120), textarea:near(...), select:near(...)')
 *     - locator resolved to <input require…
 *
 * Two separate mistakes in that one line, and both are covered below: the ACTION was wrong for
 * the element, and the `:near()` fallback offered an `<input>` for an action that can never act
 * on one.
 *
 * WHY THIS FILE DRIVES A REAL BROWSER. `CLAUDE.md` / `DECISIONS.md` D-19: "a generated Playwright
 * expression that looks right isn't verified until it's run once". `.filter({ visible: true })`
 * shipped after passing `tsc` and a unit test on the emitted string, and was a silent no-op. A
 * string assertion here would have exactly the same blind spot — `selectOption` vs `click` on a
 * custom dropdown is precisely the kind of difference only a real DOM can settle. So the helpers
 * below are **extracted from the actually-generated spec text and executed**, not reimplemented.
 */

/** Pull one function's source out of the emitted spec by brace-matching, `async` prefix included. */
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

const irWith = (steps: IR["steps"]): IR => ({
  meta: {
    feature: "admin", title: "Admin creates a new user via management interface",
    priority: "medium", sourcePrompt: "add a user", baseUrl: "https://example.com",
  },
  steps,
} as IR);

/** The two steps that actually failed in run bf20906d, copied from its saved IR. */
const SAVED_SELECT_STEPS = [
  { id: "s12", action: "select", target: { role: "combobox", name: "Manager" }, value: "prashant mishra" },
  { id: "s13", action: "select", target: { role: "combobox", name: "Role" }, value: "Learner" },
] as unknown as IR["steps"];

const SPEC = generateSpec(irWith(SAVED_SELECT_STEPS), "artifacts");

/**
 * A page carrying all three shapes a `select` step meets in the wild:
 *   Role    — a native <select>, the only one selectOption() can handle
 *   Manager — a custom combobox with role="option" items (the LMS shape)
 *   Owner   — a custom dropdown whose items carry NO option role, only text
 */
const PAGE_HTML = `
<html><body style="font-family:sans-serif">
  <div style="margin:0 0 400px 0">
    <label for="role-native">Role</label>
    <select id="role-native">
      <option value="">Pick one</option>
      <option value="Learner">Learner</option>
      <option value="Admin">Admin</option>
    </select>
  </div>

  <div style="margin:0 0 400px 0">
    <div>Manager</div>
    <input id="mgr" role="combobox" readonly aria-expanded="false" value="" style="width:220px">
    <ul id="mgr-list" role="listbox" hidden style="border:1px solid #ccc;list-style:none;padding:4px">
      <li role="option">prashant mishra</li>
      <li role="option">anita rao</li>
    </ul>
  </div>

  <div style="margin:0 0 400px 0">
    <div>Owner</div>
    <input id="own" role="combobox" readonly value="" style="width:220px">
    <div id="own-list" role="listbox" hidden style="border:1px solid #ccc;padding:4px">
      <div>kiran s</div>
      <div>meera n</div>
    </div>
  </div>

  <script>
    // Deliberately plain: an inert page, not a framework. The point is the SHAPE — an input that
    // opens a popup — not any particular library's implementation of it.
    function wire(inputId, listId) {
      var input = document.getElementById(inputId);
      var list = document.getElementById(listId);
      input.addEventListener('click', function () {
        list.hidden = !list.hidden;
        input.setAttribute('aria-expanded', String(!list.hidden));
      });
      list.addEventListener('click', function (e) {
        if (e.target === list) return;
        input.value = e.target.textContent;
        list.hidden = true;
        input.setAttribute('aria-expanded', 'false');
      });
    }
    wire('mgr', 'mgr-list');
    wire('own', 'own-list');
  </script>
</body></html>`;

describe("select action — the emitted spec, executed in a real browser", () => {
  let browser: Browser;
  let page: Page;
  let helpers: { field: Function; choose: Function };

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();

    // Build the helpers from the SPEC TEXT ITSELF. If the generator stops emitting them, or
    // emits something that does not parse, this throws here rather than silently testing a
    // reimplementation that agrees with nothing shipped.
    // The helper set is listed in ONE place (tests/fixtures/specHelpers.ts). It has grown twice
    // now — scopeOf, then the option-matching consts — and each time every hand-maintained copy
    // of the list broke separately with an unhelpful "X is not defined".
    helpers = specHelpers(SPEC, ["field", "choose"]) as unknown as { field: Function; choose: Function };
  });

  afterAll(async () => {
    await browser.close();
  });

  it("emits choose(), not a bare selectOption(), for a select step", () => {
    expect(SPEC).toContain("await choose(page,");
    // The helper must actually be spliced in when used, or the spec calls an undefined function.
    expect(SPEC).toContain("async function choose(");
    // selectOption() may still appear INSIDE choose() — that is the native branch. What must be
    // gone is the step calling it directly on a resolved locator, which is what TD-70 was.
    const stepLines = SPEC.split(/\r?\n/)
      .filter((l) => l.trim().startsWith("await (") || l.trim().startsWith("await choose("));
    expect(stepLines.some((l) => l.includes(".selectOption("))).toBe(false);
  });

  it("sets the value on a NATIVE <select> — the path that already worked must keep working", async () => {
    await page.setContent(PAGE_HTML);
    const target = await helpers.field(page, "Role", "select");
    await helpers.choose(page, target, "Learner");
    expect(await page.locator("#role-native").inputValue()).toBe("Learner");
  });

  it("picks the option on a CUSTOM combobox with role=option — the step that failed in bf20906d", async () => {
    await page.setContent(PAGE_HTML);
    const target = await helpers.field(page, "Manager", "select");
    await helpers.choose(page, target, "prashant mishra");
    expect(await page.locator("#mgr").inputValue()).toBe("prashant mishra");
    // The popup must be closed again — a dropdown left open covers whatever the next step clicks.
    expect(await page.locator("#mgr-list").isHidden()).toBe(true);
  });

  it("falls back to scoped text when the popup has no option role", async () => {
    await page.setContent(PAGE_HTML);
    const target = await helpers.field(page, "Owner", "select");
    await helpers.choose(page, target, "kiran s");
    expect(await page.locator("#own").inputValue()).toBe("kiran s");
  });

  it("does NOT resolve a select step onto a plain input — the :near() half of the defect", async () => {
    await page.setContent(`
      <html><body>
        <div>
          <div>Manager</div>
          <input id="plain" style="width:220px">
        </div>
      </body></html>`);
    // Nothing on this page can satisfy a select, so the positional fallback must find zero
    // rather than handing back the neighbouring <input> as it used to.
    const target = await helpers.field(page, "Manager", "select");
    expect(await target.count()).toBe(0);
  });

  it("still reaches a plain input for fill — the narrowing is scoped to select only", async () => {
    await page.setContent(`
      <html><body>
        <div>
          <div>Manager</div>
          <input id="plain" style="width:220px">
        </div>
      </body></html>`);
    const target = await helpers.field(page, "Manager", "fill");
    await target.fill("typed");
    expect(await page.locator("#plain").inputValue()).toBe("typed");
  });

  /**
   * TD-07: `targetResolver.ts` and the generator's injected helper are the same algorithm written
   * twice, and they have already drifted once. This pins the two for the action being changed —
   * the drift that matters here is the tag list, because that is what decides whether a select
   * can land on an `<input>`.
   */
  it("pins the generated nearField() to targetResolver's nearFieldSelector (TD-07)", () => {
    const nearField = new Function(
      `${extractFn(SPEC, "nearField")}\nreturn nearField;`,
    )() as (hint: string, action?: string) => string;

    for (const action of ["select", "fill", "check", undefined]) {
      expect(nearField("Manager", action)).toBe(nearFieldSelector("Manager", action));
    }
    // And the select form specifically excludes the tags that cannot satisfy the action.
    expect(nearField("Manager", "select")).not.toContain("input:near");
    expect(nearField("Manager", "select")).not.toContain("textarea:near");
    expect(nearField("Manager", "select")).toContain('[role="combobox"]:near');
  });
});

/**
 * Regression against the real saved IR: replay the two steps that failed, end to end, through
 * the generated helpers. This is the check that would have caught bf20906d before it shipped.
 */
describe("regression — the saved IR from run 2026-09-04T10-38-19-619Z-bf20906d", () => {
  let browser: Browser;
  let page: Page;
  let helpers: { field: Function; choose: Function };

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    helpers = specHelpers(SPEC, ["field", "choose"]) as unknown as { field: Function; choose: Function };
  });

  afterAll(async () => { await browser.close(); });

  it("both select steps land their values", async () => {
    await page.setContent(PAGE_HTML);

    for (const step of SAVED_SELECT_STEPS as any[]) {
      const target = await helpers.field(page, step.target.name, "select");
      await helpers.choose(page, target, step.value);
    }

    expect(await page.locator("#mgr").inputValue()).toBe("prashant mishra");
    expect(await page.locator("#role-native").inputValue()).toBe("Learner");
  });
});
