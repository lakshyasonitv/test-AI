import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { readFileSync } from "node:fs";

/**
 * `safeClick`, EXECUTED — not inspected as a string.
 *
 * WHY THIS FILE EXISTS. `safeClick` is emitted into the generated spec as source text, so every
 * existing test of it asserts on the emitted STRING. DECISIONS.md D-19 records what that is worth:
 * `.filter({ visible: true })` shipped as a fix, passed `tsc`, passed a unit test, and was a silent
 * no-op — because `Locator.filter()` has no `visible` option in this project's pinned Playwright.
 * Both checks only read the emitted string; neither ran it. D-19's rule is that a change touching
 * the generated spec's real Playwright surface must be executed once, and that synthetic HTML in a
 * headless browser is enough — no live target site.
 *
 * WHAT IS BEING PINNED.
 *   - TD-08: an `<a href="javascript:void(0)" onclick=…>` must be CLICKED, not navigated to. The
 *     regex guard is present in `SAFE_CLICK_HELPER` today; this proves it actually works at
 *     runtime rather than merely appearing in the source. (TECH_DEBT.md still lists TD-08 as open
 *     and describes a check that no longer matches the code — the register is stale, and this test
 *     is the evidence for correcting it.)
 *   - TD-09: an ambiguous locator must FAIL LOUDLY. The `href` read used to swallow every error
 *     including Playwright's strict-mode violation, so a duplicated link silently misfired.
 *
 * The helper is extracted from generator.ts and evaluated, so this tests the exact text that ships
 * inside a spec — not a reimplementation that could drift from it.
 */

const SRC = readFileSync(new URL("../src/stages/generator.ts", import.meta.url), "utf8");

/** Pull a backtick-delimited `const NAME = \`…\`;` block out of generator.ts. */
function extractTemplate(name: string): string {
  const start = SRC.indexOf(`const ${name} = \``);
  if (start < 0) throw new Error(`${name} not found in generator.ts`);
  const open = SRC.indexOf("`", start);
  const end = SRC.indexOf("`;", open + 1);
  if (end < 0) throw new Error(`could not find the end of ${name}`);
  return SRC.slice(open + 1, end);
}

/** The minimum surface safeClick calls that the real spec supplies elsewhere. */
const SUPPORT = `
async function locate(scope, role, name, nth) {
  let l = scope.getByRole(role, { name, exact: true });
  if (typeof nth === "number") l = l.nth(nth);
  return l;
}
async function scopeOf(page) { return page; }
`;

function buildSafeClick(): (page: Page, role: string, name: string, nth?: number) => Promise<void> {
  const helper = extractTemplate("SAFE_CLICK_HELPER");
  // eslint-disable-next-line no-new-func
  return new Function(`${SUPPORT}\n${helper}\nreturn safeClick;`)();
}

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

const pageWith = async (body: string): Promise<Page> => {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
  return page;
};

describe("safeClick — executed in a real browser (D-19)", () => {
  it("CLICKS a javascript: link instead of navigating to it (TD-08)", async () => {
    const safeClick = buildSafeClick();
    const page = await pageWith(`
      <div id="out">untouched</div>
      <a href="javascript:void(0)" onclick="document.getElementById('out').textContent='clicked'">Open modal</a>
    `);

    await safeClick(page, "link", "Open modal");

    // The whole point: the onclick must have fired. If safeClick had page.goto'd the href, this
    // would still read "untouched" and NO error would have been raised — the silent failure the
    // register describes.
    expect(await page.locator("#out").textContent()).toBe("clicked");
    await page.close();
  }, 60_000);

  it("also clicks mailto: and tel: rather than navigating (TD-08)", async () => {
    for (const href of ["mailto:someone@example.com", "tel:+15550100", "#"]) {
      const safeClick = buildSafeClick();
      const page = await pageWith(`
        <div id="out">untouched</div>
        <a href="${href}" onclick="document.getElementById('out').textContent='clicked'">Contact</a>
      `);
      await safeClick(page, "link", "Contact");
      expect(await page.locator("#out").textContent(), `href="${href}" must be clicked`).toBe("clicked");
      await page.close();
    }
  }, 90_000);

  it("still navigates a REAL href", async () => {
    const safeClick = buildSafeClick();
    const page = await pageWith(`<a href="https://example.com/landed">Go</a>`);
    // about:blank content can't resolve a relative URL, so an absolute one keeps this hermetic:
    // the assertion is that navigation was ATTEMPTED, not that the network answered.
    await safeClick(page, "link", "Go").catch(() => {});
    expect(page.url()).not.toBe("about:blank");
    await page.close();
  }, 60_000);

  // CHARACTERISATION, not a regression test — and the distinction is the point. TD-09 claims the
  // swallowed strict-mode error makes an ambiguous click "silently misfire". Run both ways, it does
  // not: with the bare .catch(() => null) the href read returns null, control falls through to the
  // fallback ladder, and waitFor/click raise the SAME violation. Playwright raises strict-mode the
  // instant a locator resolves to >1 element, not after a timeout, so it is neither silent nor
  // slow. Two attempts to write a failing control for it — one asserting the throw, one asserting
  // it happens within 3s — both passed with the fix reverted, which is what established that the
  // fix was inert. This test therefore pins the behaviour that IS true and relied upon.
  it("surfaces an ambiguous link loudly, clicking nothing (TD-09's premise, measured)", async () => {
    const safeClick = buildSafeClick();
    const page = await pageWith(`
      <div id="out">untouched</div>
      <a href="javascript:void(0)" onclick="document.getElementById('out').textContent='first'">Training &amp; Placement</a>
      <a href="javascript:void(0)" onclick="document.getElementById('out').textContent='second'">Training &amp; Placement</a>
    `);

    // Two same-named links. What must hold, and does: the run fails with a classifiable error, and
    // NEITHER onclick fires on the way out — no half-executed step, no page mutated by a click
    // nobody asked for. `classify.ts` matches this message, so it is diagnosed deterministically
    // instead of falling through to the vision fallback.
    await expect(safeClick(page, "link", "Training & Placement")).rejects.toThrow(/strict mode violation/i);
    expect(await page.locator("#out").textContent()).toBe("untouched");
    await page.close();
  }, 60_000);
});
