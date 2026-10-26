import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { generateSpec } from "../src/stages/generator.js";
import { nearFieldSelector, chooseLive } from "../src/stages/targetResolver.js";
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

/**
 * A Lightning picklist, in the shape read off the DE org's New Lead form (2026-10-24): a
 * `button role="combobox"` with aria-controls, its listbox in the same shadow root, and each option
 * a `role="option"` custom element whose TEXT lives in its OWN shadow root (textContent "") with a
 * data-value attribute. Run 2026-10-24T13-19-15-522Z-c180fec9 opened this dropdown (the screenshot
 * shows Mr., Ms., …) and choose() still said "the control had no options at all". Made-up values.
 */
const LIGHTNING_PICKLIST = `<html><body>
  <div role="dialog" aria-label="New Zq" style="padding:20px">
    <zq-combobox id="host"></zq-combobox>
    <zq-combobox id="other"></zq-combobox>
    <div class="slds-modal__footer"><button>Cancel</button><button>Save</button></div>
  </div>
  <script>
    customElements.define("zq-item", class extends HTMLElement {
      connectedCallback() {
        if (this.shadowRoot) return;
        this.attachShadow({ mode: "open" }).innerHTML =
          '<span class="fig"></span><span class="body"><span title="' + this.dataset.value + '">' + (this.dataset.value || "--None--") + '</span></span>';
      }
    });
    customElements.define("zq-combobox", class extends HTMLElement {
      connectedCallback() {
        const id = "dd-" + this.id;
        const r = this.attachShadow({ mode: "open" });
        r.innerHTML = '<label>Zq Title</label><button role="combobox" name="zq_' + this.id + '" aria-expanded="false" aria-controls="' + id + '">--None--</button>'
          + '<div id="' + id + '" role="listbox" style="display:none"></div>';
        const btn = r.querySelector("button"), list = r.getElementById(id);
        btn.addEventListener("click", () => {
          // "swallow-first": like a Lightning picklist clicked while the field before it is still
          // committing (run 2026-10-24T13-46-36-401Z-db184799), the first click does nothing.
          if (this.hasAttribute("swallow-first") && !this.armed) { this.armed = true; return; }
          if (!list.children.length) for (const v of ["", "Zq One", "Zq Two"]) {
            const it = document.createElement("zq-item"); it.setAttribute("role", "option"); it.dataset.value = v; list.appendChild(it);
          }
          list.style.display = "block"; btn.setAttribute("aria-expanded", "true");
        });
        list.addEventListener("click", (e) => {
          const it = e.composedPath().find((n) => n.tagName === "ZQ-ITEM");
          if (!it) return;
          btn.textContent = it.dataset.value || "--None--"; list.style.display = "none"; btn.setAttribute("aria-expanded", "false");
        });
      }
    });
  </script>
</body></html>`;

describe("select on a Lightning picklist: options whose text is in their own shadow root", () => {
  let browser: Browser;
  let page: Page;
  let helpers: { choose: Function };
  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    helpers = specHelpers(SPEC, ["choose"]) as unknown as { choose: Function };
  });
  afterAll(async () => { await browser.close(); });

  it("opens the control's own listbox and picks the option by its rendered text", async () => {
    await page.setContent(LIGHTNING_PICKLIST);
    await helpers.choose(page, page.locator('button[name="zq_host"]'), "Zq Two");
    expect(await page.locator('button[name="zq_host"]').textContent()).toBe("Zq Two");
    // The other picklist on the form was never touched.
    expect(await page.locator('button[name="zq_other"]').textContent()).toBe("--None--");
  });

  it("matches a value that differs only in case and spacing, as a <select> would", async () => {
    await page.setContent(LIGHTNING_PICKLIST);
    await helpers.choose(page, page.locator('button[name="zq_host"]'), "  zq one ");
    expect(await page.locator('button[name="zq_host"]').textContent()).toBe("Zq One");
  });

  it("says what was on offer when the value is not one of them", async () => {
    await page.setContent(LIGHTNING_PICKLIST);
    const err = await helpers.choose(page, page.locator('button[name="zq_host"]'), "Zq Nine").catch((e: Error) => e);
    expect(String(err)).toMatch(/Zq One/);
    expect(String(err)).toMatch(/Zq Two/);
  });
});

describe("a picklist whose first click is swallowed is clicked again, in the spec and in the live replay", () => {
  // Run 2026-10-24T13-46-36-401Z-db184799: the same Lead Status step passed in one case and failed in
  // two; the failure screenshots show the dropdown CLOSED. The control's own popup (aria-controls)
  // and aria-expanded say whether the click opened it.
  let browser: Browser;
  let page: Page;
  let helpers: { choose: Function };
  beforeAll(async () => {
    browser = await chromium.launch(); page = await browser.newPage();
    helpers = specHelpers(SPEC, ["choose"]) as unknown as { choose: Function };
  });
  afterAll(async () => { await browser.close(); });
  const sticky = () => LIGHTNING_PICKLIST.replace('<zq-combobox id="host"></zq-combobox>', '<zq-combobox id="host" swallow-first></zq-combobox>');

  it("spec choose()", async () => {
    await page.setContent(sticky());
    await helpers.choose(page, page.locator('button[name="zq_host"]'), "Zq One");
    expect(await page.locator('button[name="zq_host"]').textContent()).toBe("Zq One");
  });

  it("live chooseLive()", async () => {
    await page.setContent(sticky());
    await chooseLive(page, page.locator('button[name="zq_host"]'), "Zq One");
    expect(await page.locator('button[name="zq_host"]').textContent()).toBe("Zq One");
  });

  it("an already-open dropdown is not clicked shut", async () => {
    await page.setContent(LIGHTNING_PICKLIST);
    await helpers.choose(page, page.locator('button[name="zq_host"]'), "Zq Two");
    expect(await page.locator('button[name="zq_host"]').textContent()).toBe("Zq Two");
  });
});

describe("the live replay picks a Lightning picklist option the same way (IR grounding path)", () => {
  // chooseLive is what the grounding replay runs; it had the same two blind spots as the spec's
  // choose(): the modal footer as scope, and option text read from textContent ("" here).
  let browser: Browser;
  let page: Page;
  beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
  afterAll(async () => { await browser.close(); });

  it("opens the control's own listbox and picks by rendered text, case-insensitively", async () => {
    await page.setContent(LIGHTNING_PICKLIST);
    await chooseLive(page, page.locator('button[name="zq_host"]'), "zq two");
    expect(await page.locator('button[name="zq_host"]').textContent()).toBe("Zq Two");
    expect(await page.locator('button[name="zq_other"]').textContent()).toBe("--None--");
  });

  it("names the options on offer when the value is absent", async () => {
    await page.setContent(LIGHTNING_PICKLIST);
    const err = await chooseLive(page, page.locator('button[name="zq_host"]'), "Zq Nine").catch((e: Error) => e);
    expect(String(err)).toMatch(/Zq One/);
  });
});
