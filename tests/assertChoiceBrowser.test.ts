import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, expect as pwExpect, type Browser, type Page } from "@playwright/test";
import { generateSpec } from "../src/stages/generator.js";
import type { IR } from "../src/schema/ir.js";

/**
 * `assertChoice`, EXECUTED — a dropdown assertion must compare the SELECTED option.
 *
 * THE BUG, from a real saucedemo run. The case "Sorting products by 'Name (A to Z)'" failed with
 * the diagnosis: the combobox "actually contains multiple option texts concatenated together, such
 * as 'Name (A to Z)Name (Z to A)Price (low to high)Price (high to low)'".
 *
 * That is exactly what `textContent` of a `<select>` is, confirmed here in a browser rather than
 * assumed. So `toHaveText("Name (A to Z)")` can NEVER match a dropdown, and `toContainText` is
 * worse than useless — it matches whichever option merely exists, passing while verifying nothing,
 * which `emitAssert`'s own vacuous-assertion guard calls out as the failure mode worse than a
 * red test.
 *
 * WHY EXECUTED AND NOT ASSERTED ON THE EMITTED STRING. DECISIONS.md D-19: `.filter({visible:true})`
 * shipped as a fix, passed `tsc`, passed a unit test, and was a silent no-op because the option did
 * not exist in the pinned Playwright. Both checks only read the emitted text. A change to the
 * generated spec's real Playwright surface has to be run once, and synthetic HTML is enough.
 *
 * The helper is extracted from `generator.ts` and evaluated, so this tests the exact text that
 * ships inside a spec rather than a reimplementation that could drift from it.
 */

/**
 * Pull `assertChoice` out of a REAL generated spec, not out of generator.ts's template source.
 *
 * The template interpolates `${ASSERT_TIMEOUT_MS}` and carries escaped backslashes for the regex
 * it emits; reading the raw source between backticks yields text that is not valid JavaScript on
 * its own. Generating a spec resolves all of it, so what runs below is byte-for-byte what ships
 * inside a case.
 */
function buildAssertChoice(): AssertChoice {
  const ir = {
    meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://x.example" },
    steps: [
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "assert", target: { role: "combobox", name: "Sort products" },
        assertion: "text_equals", value: "Name (A to Z)" },
    ],
  } as unknown as IR;

  const spec = generateSpec(ir);
  const start = spec.indexOf("async function assertChoice(");
  if (start < 0) throw new Error("generated spec does not contain assertChoice — is the helper wired in?");
  let depth = 0, end = -1;
  for (let i = spec.indexOf("{", start); i < spec.length; i++) {
    if (spec[i] === "{") depth++;
    else if (spec[i] === "}") { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  // eslint-disable-next-line no-new-func
  return new Function("expect", `${spec.slice(start, end)}
return assertChoice;`)(pwExpect);
}

type AssertChoice = (loc: any, expected: string, mode: "equals" | "contains") => Promise<void>;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

const pageWith = async (body: string): Promise<Page> => {
  const page = await browser.newPage();
  await page.setContent(`<!doctype html><html><body>${body}</body></html>`);
  return page;
};

/** The saucedemo sort control, in shape. */
const SELECT = `<select data-test="product-sort-container" aria-label="Sort products">` +
  `<option value="az">Name (A to Z)</option><option value="za">Name (Z to A)</option>` +
  `<option value="lohi">Price (low to high)</option><option value="hilo">Price (high to low)</option>` +
  `</select>`;

describe("assertChoice — executed in a real browser (D-19)", () => {
  it("passes on the option that is actually selected", async () => {
    const assertChoice = buildAssertChoice();
    const page = await pageWith(SELECT);
    await expect(assertChoice(page.getByRole("combobox"), "Name (A to Z)", "equals")).resolves.toBeUndefined();
    await page.close();
  }, 60_000);

  it("FAILS on an option that exists but is not selected — the whole point", async () => {
    // toContainText against the element would pass here, because the concatenated text contains
    // every option. That is the "green verdict verifying nothing" case.
    const assertChoice = buildAssertChoice();
    const page = await pageWith(SELECT);
    await page.getByRole("combobox").selectOption("hilo");
    await expect(assertChoice(page.getByRole("combobox"), "Name (A to Z)", "equals")).rejects.toThrow();
    await expect(assertChoice(page.getByRole("combobox"), "Name (A to Z)", "contains")).rejects.toThrow();
    await page.close();
  }, 60_000);

  it("proves the old assertion could never have worked", async () => {
    // Not a test of the fix — a record of why it was needed, measured rather than asserted.
    const page = await pageWith(SELECT);
    const whole = await page.getByRole("combobox").textContent();
    expect(whole).toBe("Name (A to Z)Name (Z to A)Price (low to high)Price (high to low)");
    expect(whole).not.toBe("Name (A to Z)");
    await page.close();
  }, 60_000);

  it("follows the selection after it changes", async () => {
    const assertChoice = buildAssertChoice();
    const page = await pageWith(SELECT);
    await page.getByRole("combobox").selectOption("lohi");
    await expect(assertChoice(page.getByRole("combobox"), "Price (low to high)", "equals")).resolves.toBeUndefined();
    await expect(assertChoice(page.getByRole("combobox"), "low to high", "contains")).resolves.toBeUndefined();
    await page.close();
  }, 60_000);

  it("handles a React-style combobox with no <option> children (TD-70's shape)", async () => {
    // An <input role="combobox"> has no options at all, so `option:checked` matches nothing and
    // the helper must fall through to the input's value rather than throwing.
    const assertChoice = buildAssertChoice();
    const page = await pageWith(`<input role="combobox" aria-label="Sort" value="Name (A to Z)" />`);
    await expect(assertChoice(page.getByRole("combobox"), "Name (A to Z)", "equals")).resolves.toBeUndefined();
    await expect(assertChoice(page.getByRole("combobox"), "A to Z", "contains")).resolves.toBeUndefined();
    await expect(assertChoice(page.getByRole("combobox"), "Price (low to high)", "equals")).rejects.toThrow();
    await page.close();
  }, 60_000);

  it("escapes regex metacharacters in a contains comparison", async () => {
    // "Price (low to high)" carries parentheses. Unescaped, they become a regex group and the
    // match silently changes meaning.
    const assertChoice = buildAssertChoice();
    const page = await pageWith(`<input role="combobox" aria-label="Sort" value="Price (low to high)" />`);
    await expect(assertChoice(page.getByRole("combobox"), "(low to high)", "contains")).resolves.toBeUndefined();
    await page.close();
  }, 60_000);
});
