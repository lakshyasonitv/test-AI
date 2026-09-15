import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { generateSpec } from "../src/stages/generator.js";
import {
  resolveField, chooseLive, domOrderFieldFn, FIELD_SELECTOR, DOM_ORDER_FIELD_JS,
} from "../src/stages/targetResolver.js";
import type { IR } from "../src/schema/ir.js";
import { specHelpers } from "./fixtures/specHelpers.js";

/**
 * The Manager dropdown — TECH_DEBT.md TD-78 and TD-79, from run
 * `2026-09-06T14-19-13-154Z-fed833e5` step 12:
 *
 *     TimeoutError: locator.selectOption: Timeout 10000ms exceeded.
 *       - waiting for locator('body').locator('select:near(:text("Manager"), 120), ...').first()
 *         - locator resolved to <select>…</select>
 *       - attempting select option action
 *         2 × waiting for element to be visible and enabled
 *           - did not find some options
 *
 * A live probe of the modal settled which of the three candidate causes it was. The option
 * "prashant mishra" EXISTS, spelled exactly as the step asks, present from the first paint — so
 * it was neither a late-loading list nor a genuinely absent option. It was the third: the step's
 * locator matched TWO sibling `<select>`s and `.first()` took the Role one, whose options are
 * Select…/Learner/Trainer/Manager/Admin. (The Role select even contains an `<option>Manager</option>`,
 * so the anchor text is not unique either.)
 *
 * The reason it got as far as geometry at all is TD-78: `resolveField`'s DOM-order rung was
 * passing a function SOURCE STRING to `Locator.evaluate()`, which evaluates a string as an
 * expression and never calls it — so the rung returned `undefined`, read as "no match", every
 * time it ran. It never worked once, in either implementation.
 *
 * These tests drive a real browser (`DECISIONS.md` D-19) and, where they can, assert the RUNG
 * rather than only the outcome — a dead rung is invisible end-to-end, because geometry quietly
 * returns the right answer on any page simple enough for a unit test.
 */

const irWith = (steps: IR["steps"]): IR => ({
  meta: {
    feature: "admin", title: "Admin creates a new user via management interface",
    priority: "medium", sourcePrompt: "add a user", baseUrl: "https://example.com",
  },
  steps,
} as IR);

/** The two select steps exactly as run fed833e5 saved them. */
const SAVED_STEPS = [
  { id: "s12", action: "select", target: { role: "combobox", name: "Manager" }, value: "prashant mishra" },
  { id: "s13", action: "select", target: { role: "combobox", name: "Role" }, value: "Learner" },
] as unknown as IR["steps"];

const SPEC = generateSpec(irWith(SAVED_STEPS), "artifacts");

/**
 * The real modal's shape: Role and Manager as sibling `<select>`s inside one grid row, close
 * enough that each is inside the other's `:near()` radius, labels carrying NO `for=`, and the
 * Role select containing an `<option>Manager</option>` so the anchor text is ambiguous too.
 * No role="dialog" and no modal class — the live one has neither, which is why scoping alone
 * cannot separate these two.
 */
const REAL_SHAPE = `
<html><body style="font-family:sans-serif;margin:0">
  <div style="padding:20px">
    <label>Email</label><input id="bg-email" style="width:240px">
    <button>Save</button>
  </div>
  <div style="position:fixed;top:80px;left:80px;width:520px;background:#fff;border:1px solid #ccc;padding:16px">
    <h3>New User</h3>
    <div><label>Full Name</label><br><input id="d-name" style="width:480px"></div>
    <div><label>Email</label><br><input id="d-email" style="width:480px"></div>
    <div style="display:flex;gap:16px">
      <div>
        <label>Role</label><br>
        <select id="d-role" style="width:240px">
          <option value="">Select...</option>
          <option value="learner">Learner</option>
          <option value="manager">Manager</option>
        </select>
      </div>
      <div>
        <label>Manager</label><br>
        <select id="d-manager" style="width:240px">
          <option value="">No manager</option>
          <option value="6aec50a5">prashant mishra</option>
          <option value="dca00925">Vaibhav Parmar</option>
        </select>
      </div>
    </div>
    <button>Cancel</button><button>Save</button>
  </div>
</body></html>`;

describe("TD-78 — the DOM-order rung actually runs", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
  afterAll(async () => { await browser.close(); });

  it("returns an INDEX, not undefined — a string callback silently returns undefined", async () => {
    await page.setContent(REAL_SHAPE);
    const body = page.locator("body");

    const arg = { wanted: "Manager", fieldSel: FIELD_SELECTOR };

    // The bug, pinned: passing the SOURCE to evaluate() yields undefined rather than running it.
    const asString = await body.evaluate(DOM_ORDER_FIELD_JS as any, arg).catch(() => "threw");
    expect(asString).toBeUndefined();

    // The fix: the materialised function. This is the assertion that would have caught it —
    // end-to-end, geometry covers for the dead rung and the case still passes.
    const idx = await body.evaluate(domOrderFieldFn, arg);
    expect(typeof idx).toBe("number");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(await body.locator(FIELD_SELECTOR).nth(idx as number).getAttribute("id")).toBe("d-manager");
  });

  it("distinguishes two sibling selects that both sit inside the :near() radius", async () => {
    await page.setContent(REAL_SHAPE);
    const body = page.locator("body");
    const idRole = await body.evaluate(domOrderFieldFn, { wanted: "Role", fieldSel: FIELD_SELECTOR });
    const idMgr = await body.evaluate(domOrderFieldFn, { wanted: "Manager", fieldSel: FIELD_SELECTOR });
    expect(await body.locator(FIELD_SELECTOR).nth(idRole as number).getAttribute("id")).toBe("d-role");
    expect(await body.locator(FIELD_SELECTOR).nth(idMgr as number).getAttribute("id")).toBe("d-manager");
  });

  it("resolveField lands on the Manager select, not the Role one — the actual failure", async () => {
    await page.setContent(REAL_SHAPE);
    // The geometry rung returns TWO here and .first() is the Role select, which is what shipped.
    const el = await resolveField(page, "Manager", "select");
    expect(await el.getAttribute("id")).toBe("d-manager");
  });

  /**
   * The shape that still failed after the rung was revived, found by running it against the real
   * modal rather than by reading it.
   *
   * The word "Manager" appears SIX times inside the resolution scope: five role badges on the
   * user rows behind the modal, and the field's own `<label>`. The badges come first in document
   * order, and because a badge sits far above the form, EVERY control follows it — so
   * first-match-wins returned the first select on the page (Role), confidently and wrongly.
   *
   * The scope is `body` here because this modal sets no `role="dialog"`, no `aria-modal` and no
   * dialog/modal class — the live one sets none of the three, so dialog scoping cannot help.
   * Resolution has to be right without it.
   */
  const BADGES_BEHIND = `
    <html><body style="font-family:sans-serif;margin:0">
      <div id="rows" style="padding:8px">
        <div><span>ravi k</span><span>Manager</span></div>
        <div><span>anita r</span><span>Manager</span></div>
        <div><span>sunil p</span><span>Manager</span></div>
      </div>
      <div style="position:fixed;top:60px;left:60px;background:#fff;border:1px solid #333;padding:12px">
        <div><label>Role</label><br>
          <select id="d-role"><option value="">Select...</option><option value="learner">Learner</option><option value="manager">Manager</option></select>
        </div>
        <div><label>Manager</label><br>
          <select id="d-manager"><option value="">No manager</option><option value="u1">prashant mishra</option></select>
        </div>
      </div>
    </body></html>`;

  it("prefers the field's <label> over identical text in the page behind it", async () => {
    await page.setContent(BADGES_BEHIND);
    const el = await resolveField(page, "Manager", "select");
    expect(await el.getAttribute("id")).toBe("d-manager");
  });

  it("and actually selects, end to end, on that shape", async () => {
    await page.setContent(BADGES_BEHIND);
    await chooseLive(page, await resolveField(page, "Manager", "select"), "prashant mishra");
    await chooseLive(page, await resolveField(page, "Role", "select"), "Learner");
    expect(await page.locator("#d-manager").inputValue()).toBe("u1");
    expect(await page.locator("#d-role").inputValue()).toBe("learner");
  });

  /**
   * Two legitimately identical labels, no dialog to scope to — the shape the badge fix must NOT
   * break. A login form and a footer newsletter both carrying `<label>Email</label>` is a far more
   * common page than a decoy label, and the first one is the field the flow means. This is why
   * "last wins" applies only to generic leaves, where the decoys (badges, chips, cells) actually
   * live, and labels keep first-in-document-order.
   */
  it("two forms with the same <label> still resolve to the FIRST — no regression", async () => {
    await page.setContent(`
      <html><body>
        <form id="login"><label>Email</label><input id="login-email"></form>
        <footer><label>Email</label><input id="news-email"></footer>
      </body></html>`);
    const el = await resolveField(page, "Email", "fill");
    await el.fill("me@example.com");
    expect(await page.locator("#login-email").inputValue()).toBe("me@example.com");
    expect(await page.locator("#news-email").inputValue()).toBe("");
  });

  it("a select step is never handed a plain <input> — TD-70 must survive the live rung", async () => {
    // While the DOM-order rung was dead this could not happen; the moment it started running, an
    // unnarrowed selector offered the <input> after the label to a select step.
    await page.setContent(`<html><body><div>Manager</div><input id="plain"></body></html>`);
    expect(await (await resolveField(page, "Manager", "select")).count()).toBe(0);
    // ...but a fill still reaches it.
    const f = await resolveField(page, "Manager", "fill");
    await f.fill("typed");
    expect(await page.locator("#plain").inputValue()).toBe("typed");
  });

  it("the emitted spec passes a real arrow to evaluate, never a string", () => {
    expect(SPEC).toMatch(/scope\.evaluate\(\(root, arg\) =>/);
    expect(SPEC).not.toMatch(/scope\.evaluate\("/);
  });

  it("the emitted spec's regexes kept their backslashes", () => {
    // `\s` inside a template literal needs `\\s` to survive into the file. It did not, so every
    // emitted matcher ran `/s+/g` — which replaces the letter s. Both sides were mangled equally
    // so exact matching still worked by luck, and nothing failed.
    expect(SPEC).toContain("replace(/\\s+/g");
    expect(SPEC).not.toMatch(/replace\(\/s\+\/g/);
  });
});

/** A page for each shape the brief asks `choose()` to survive. */
const ASYNC_SHAPES = `
<html><body style="font-family:sans-serif">
  <div><label>Manager</label><br>
    <select id="late" style="width:240px"><option value="">Select...</option></select>
  </div>

  <div style="margin-top:300px"><label>Owner</label><br>
    <input id="cbx" role="combobox" readonly aria-expanded="false" style="width:240px">
    <ul id="cbx-list" role="listbox" hidden style="list-style:none;padding:4px;border:1px solid #ccc"></ul>
  </div>

  <div style="margin-top:300px"><label>Team</label><br>
    <div id="team-shell">
      <button id="team-btn" type="button">Choose a team</button>
      <select id="team-native" style="position:absolute;width:1px;height:1px;opacity:0">
        <option value="">Select...</option>
        <option value="t1">Platform</option>
        <option value="t2">Growth</option>
      </select>
    </div>
  </div>

  <script>
    // Options arrive from "the server" well after the modal opened.
    setTimeout(function () {
      var s = document.getElementById('late');
      var names = ['prashant mishra', 'udit goyal'];
      for (var i = 0; i < names.length; i++) {
        var o = document.createElement('option');
        o.value = 'u' + i; o.textContent = names[i];
        s.appendChild(o);
      }
    }, 800);

    var list = document.getElementById('cbx-list');
    document.getElementById('cbx').addEventListener('click', function () {
      list.hidden = false;
      setTimeout(function () {
        if (list.children.length) return;
        var names = ['kiran s', 'meera n'];
        for (var i = 0; i < names.length; i++) {
          var li = document.createElement('li');
          li.setAttribute('role', 'option');
          li.textContent = names[i];
          li.addEventListener('click', function (e) {
            document.getElementById('cbx').value = e.target.textContent;
            list.hidden = true;
          });
          list.appendChild(li);
        }
      }, 700);
    });
  </script>
</body></html>`;

describe("TD-79 — choose() against dropdowns that are not simple", () => {
  let browser: Browser;
  let page: Page;
  let helpers: { field: Function; choose: Function };

  beforeAll(async () => {
    browser = await chromium.launch();
    page = await browser.newPage();
    // Built from the SPEC TEXT, so this tests what actually ships (D-19).
    helpers = specHelpers(SPEC, ["field", "choose"]) as unknown as { field: Function; choose: Function };
  });

  afterAll(async () => { await browser.close(); });

  it("(i) waits for a native <select> whose options arrive late", async () => {
    await page.setContent(ASYNC_SHAPES);
    const el = await helpers.field(page, "Manager", "select");
    await helpers.choose(page, el, "prashant mishra");
    expect(await page.locator("#late").inputValue()).toBe("u0");
  });

  it("(ii) waits for a combobox whose listbox items arrive late", async () => {
    await page.setContent(ASYNC_SHAPES);
    const el = await helpers.field(page, "Owner", "select");
    await helpers.choose(page, el, "kiran s");
    expect(await page.locator("#cbx").inputValue()).toBe("kiran s");
  });

  it("(iii) reaches the hidden native <select> behind a custom control", async () => {
    await page.setContent(ASYNC_SHAPES);
    // The step resolves to the shell/button; the value has to land on the real select.
    await helpers.choose(page, page.locator("#team-btn"), "Platform");
    expect(await page.locator("#team-native").inputValue()).toBe("t1");
  });

  it("(iv) an absent option fails with the options that WERE available", async () => {
    await page.setContent(ASYNC_SHAPES);
    const el = await helpers.field(page, "Manager", "select");
    await expect(helpers.choose(page, el, "nobody at all")).rejects.toThrow(/no option matching/i);
    await page.setContent(ASYNC_SHAPES);
    const el2 = await helpers.field(page, "Manager", "select");
    const err = await helpers.choose(page, el2, "nobody at all").catch((e: Error) => e.message);
    // The whole point: name what was on offer, so a spelling difference is visible without
    // re-running the case and watching a video.
    expect(err).toContain("prashant mishra");
    expect(err).toContain("udit goyal");
  });

  it("fails FAST when the list is populated and the value simply is not in it", async () => {
    // A wrong-control resolution must not look like a slow network. If this ever starts taking
    // the full timeout, the early exit has regressed and every such bug gets 10s slower to see.
    await page.setContent(REAL_SHAPE);
    const el = await helpers.field(page, "Manager", "select");
    const t0 = Date.now();
    await helpers.choose(page, el, "definitely not there").catch(() => {});
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  it("still selects with different casing — TD-76 stays fixed", async () => {
    await page.setContent(REAL_SHAPE);
    const el = await helpers.field(page, "Manager", "select");
    await helpers.choose(page, el, "PRASHANT MISHRA");
    expect(await page.locator("#d-manager").inputValue()).toBe("6aec50a5");
  });

  /**
   * The shape that actually failed, driven through the GENERATED SPEC rather than the live
   * resolver — the path a replay runs. The two share `DOM_ORDER_FIELD_JS` as source, but "the
   * string is shared, so both behave the same" is precisely the claim that was true and useless
   * last session: both copies were shared AND both were dead (TD-78). Asserted separately.
   */
  const BADGES_BEHIND_SPEC = `
    <html><body style="font-family:sans-serif;margin:0">
      <div style="padding:8px">
        <div><span>ravi k</span><span>Manager</span></div>
        <div><span>anita r</span><span>Manager</span></div>
        <div><span>sunil p</span><span>Manager</span></div>
      </div>
      <div style="position:fixed;top:60px;left:60px;background:#fff;border:1px solid #333;padding:12px">
        <div><label>Role</label><br>
          <select id="d-role"><option value="">Select...</option><option value="learner">Learner</option><option value="manager">Manager</option></select>
        </div>
        <div><label>Manager</label><br>
          <select id="d-manager"><option value="">No manager</option><option value="u1">prashant mishra</option></select>
        </div>
      </div>
    </body></html>`;

  it("the GENERATED field() also beats the decoy text behind the modal", async () => {
    await page.setContent(BADGES_BEHIND_SPEC);
    const el = await helpers.field(page, "Manager", "select");
    expect(await el.getAttribute("id")).toBe("d-manager");
  });

  it("the GENERATED choose() lands the value on that shape, end to end", async () => {
    await page.setContent(BADGES_BEHIND_SPEC);
    await helpers.choose(page, await helpers.field(page, "Manager", "select"), "prashant mishra");
    await helpers.choose(page, await helpers.field(page, "Role", "select"), "Learner");
    expect(await page.locator("#d-manager").inputValue()).toBe("u1");
    expect(await page.locator("#d-role").inputValue()).toBe("learner");
  });

  it("reaches the RIGHT hidden select when the ancestor holds two of them", async () => {
    // The shell is nested deeply enough that the walk climbs past it to a container holding BOTH
    // fields' native selects. querySelector("select") there is first-in-subtree, not nearest, and
    // returns the Role one — the same mistake the DOM-order rung was making. The fix prefers a
    // select that FOLLOWS the element.
    await page.setContent(`
      <html><body>
        <div id="row">
          <label>Role</label>
          <select id="role-native" style="opacity:0;width:1px"><option value="">-</option><option value="r1">Learner</option></select>
          <label>Manager</label>
          <div><div><button id="mgr-btn" type="button">Pick a manager</button></div></div>
          <select id="mgr-native" style="opacity:0;width:1px"><option value="">-</option><option value="m1">prashant mishra</option></select>
        </div>
      </body></html>`);
    await helpers.choose(page, page.locator("#mgr-btn"), "prashant mishra");
    expect(await page.locator("#mgr-native").inputValue()).toBe("m1");
    expect(await page.locator("#role-native").inputValue()).toBe("");
  });

  it("replays the saved IR's two select steps onto their own controls", async () => {
    await page.setContent(REAL_SHAPE);
    for (const step of SAVED_STEPS as any[]) {
      const el = await helpers.field(page, step.target.name, "select");
      await helpers.choose(page, el, step.value);
    }
    expect(await page.locator("#d-manager").inputValue()).toBe("6aec50a5");
    expect(await page.locator("#d-role").inputValue()).toBe("learner");
  });
});

describe("chooseLive — the live path behaves like the generated one", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => { browser = await chromium.launch(); page = await browser.newPage(); });
  afterAll(async () => { await browser.close(); });

  it("selects case-insensitively on the right control", async () => {
    await page.setContent(REAL_SHAPE);
    await chooseLive(page, await resolveField(page, "Manager", "select"), "PRASHANT MISHRA");
    expect(await page.locator("#d-manager").inputValue()).toBe("6aec50a5");
  });

  it("waits for late options", async () => {
    await page.setContent(ASYNC_SHAPES);
    await chooseLive(page, await resolveField(page, "Manager", "select"), "udit goyal");
    expect(await page.locator("#late").inputValue()).toBe("u1");
  });

  it("reports the available options when there is no match", async () => {
    await page.setContent(REAL_SHAPE);
    const err = await chooseLive(page, await resolveField(page, "Manager", "select"), "nope")
      .catch((e: Error) => e.message);
    expect(err).toMatch(/no option matching/i);
    expect(err).toContain("prashant mishra");
  });
});
