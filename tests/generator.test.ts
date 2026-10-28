import { describe, it, expect } from "vitest";
import { generateSpec } from "../src/stages/generator.js";
import type { IR } from "../src/schema/ir.js";

const spec = (steps: any[], meta: Partial<IR["meta"]> = {}) =>
  generateSpec({
    meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "s",
            baseUrl: "https://www.saucedemo.com", ...meta },
    steps,
  } as unknown as IR);

describe("generateSpec", () => {
  // Regression: the click branch was the only action that bypassed resolveCode(), so a
  // legitimate text-only target became safeClick(page, "", "") and Playwright threw
  // "Role must not be empty".
  it("does not emit an empty-role safeClick for a text-only click target", () => {
    const out = spec([{ id: "s1", action: "click", target: { text: "Sauce Labs Fleece Jacket" } }]);
    expect(out).not.toContain('safeClick(page, "", "")');
    expect(out).toContain('page.getByText("Sauce Labs Fleece Jacket").first().click(');
  });

  it("still uses safeClick for a role+name click", () => {
    const out = spec([{ id: "s1", action: "click", target: { role: "button", name: "Login" } }]);
    expect(out).toContain('safeClick(page, "button", "Login")');
  });

  // Regression: getByText("Amazon") matched a hidden <option> inside a dropdown menu ahead of
  // the real, visible "Amazon" text elsewhere on the page — toBeVisible() then polled a hidden
  // element for the full timeout. `.and(page.locator(':visible'))` is the real fix — verified
  // directly against Playwright's own type declarations AND with a real headless-browser run
  // that `.filter({ visible: true })` does NOT work (it's not a real filter() option in this
  // Playwright version — silently ignored, not an error) while `.and(locator(':visible'))`
  // correctly drops the hidden match. Must come BEFORE any trailing .first()/.nth() that
  // resolveCode() already appends: applying it AFTER narrowing locks onto whichever candidate
  // happened to be first in DOM order, and if THAT one is hidden, intersecting it with :visible
  // afterward just empties the locator instead of finding the visible sibling — also verified
  // directly with a real browser (0 matches with the wrong order, 1 correct match with the
  // right one). Three target shapes, three different trailing modifiers (or none) — all three
  // must put .and() first.
  it("narrows visible assertions to visible-only candidates, before any trailing .first()/.nth()", () => {
    const visibleOf = (t: any) =>
      spec([{ id: "s1", action: "assert", assertion: "visible", target: t }])
        .split("\n").find(l => l.includes("toBeVisible"))!;

    const text = visibleOf({ text: "Amazon" });
    expect(text).toContain("page.getByText(\"Amazon\").and(page.locator(':visible')).first()");
    expect(text).not.toMatch(/\.first\(\)\.and/);
    expect(text).not.toContain("filter({ visible: true })"); // not a real Playwright option

    const css = visibleOf({ css: "#logo" });
    expect(css).toContain("page.locator(\"#logo\").and(page.locator(':visible')).first()");
    expect(css).not.toMatch(/\.first\(\)\.and/);

    const role = visibleOf({ role: "button", name: "All" });
    expect(role).toContain("(await locate(page, \"button\", \"All\")).and(page.locator(':visible'))");

    // hidden/enabled/disabled must NOT gain the narrowing — they need the SAME element the step
    // resolved, not a visibility-narrowed candidate set.
    const hidden = spec([{ id: "s1", action: "assert", assertion: "hidden", target: { text: "Amazon" } }]);
    expect(hidden).not.toContain(":visible");
  });

  // Regression: "verify the page title is X" had no correct compilation target — the IR
  // assertion enum had no title option, so the step degraded to text_equals/text_contains
  // against a { text } target, i.e. a body-text search for a string that (on most sites)
  // exists only inside <title>. Reproduced repeatedly against amazon.in, whose title appears
  // zero times in the rendered body — a guaranteed timeout, by construction.
  it("compiles title assertions against page title metadata, not body text", () => {
    const contains = spec([{ id: "s1", action: "assert", assertion: "title_contains", value: "Amazon.in" }]);
    expect(contains).toContain('await expect(page).toHaveTitle(new RegExp("Amazon\\\\.in")');
    expect(contains).not.toContain("getByText");

    const equals = spec([{ id: "s1", action: "assert", assertion: "title_equals", value: "Amazon.in" }]);
    expect(equals).toContain('await expect(page).toHaveTitle("Amazon.in"');
    expect(equals).not.toContain("getByText");
  });

  it("refuses a title assertion with no comparison value, like every other comparison", () => {
    expect(() => spec([{ id: "s1", action: "assert", assertion: "title_contains" }]))
      .toThrow(/no comparison value/);
  });

  // Regression: safeClick's ladder had two calls with NO explicit timeout
  // (scrollIntoViewIfNeeded, hover), each inheriting Playwright's 30s action default. On a
  // genuinely hidden element none of them ever become actionable, so worst case was
  // 30+5+30+3+30+10+5 ≈ 113s for ONE click step — over the executor's own kill timer, so the
  // process was SIGKILLed before any report could be written and the failure was undiagnosable.
  // Every call in the ladder must carry its own bound.
  it("bounds every call in safeClick's ladder with an explicit timeout", () => {
    const out = spec([{ id: "s1", action: "click", target: { role: "button", name: "Login" } }]);
    const ladder = out.slice(out.indexOf("async function safeClick"));
    // Comments only, stripped — the explanation inside this helper naturally mentions the very
    // bare calls being asserted against, so matching raw source would test the prose, not the code.
    const body = ladder.slice(0, ladder.indexOf("\n}"))
      .split("\n").filter(l => !l.trim().startsWith("//")).join("\n");

    // No bare scrollIntoViewIfNeeded()/hover() — those inherit the 30s default.
    expect(body).not.toMatch(/scrollIntoViewIfNeeded\(\)/);
    expect(body).not.toMatch(/\.hover\(\)/);
    // Every waitFor/click/hover/scroll call carries a timeout.
    const calls = body.match(/\.(scrollIntoViewIfNeeded|waitFor|hover|click)\([^)]*\)/g) ?? [];
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(c).toMatch(/timeout:\s*\d+/);
  });

  // Regression: getByRole's `name` defaults to a case-insensitive SUBSTRING match, so asserting
  // the real discovered button "All" also matched a video player's hidden "restore all settings
  // to the default" button (picked confidently — count was 1) and, on the click path, a
  // 4-element strict-mode violation including an "Open All Categories Menu" hamburger. The name
  // is never a guess by this point (groundingError rewrites it to a verified element's exact
  // accessible name), so the injected helper must demand an exact match.
  it("injects a locate() helper that matches names exactly, not by substring", () => {
    const out = spec([{ id: "s1", action: "assert", target: { role: "button", name: "All" }, assertion: "visible" }]);
    expect(out).toContain("getByRole(role, { name, exact: true })");
    // :has-text() is a substring match over the whole subtree — the other half of the same bug.
    expect(out).not.toContain(':has-text("');
    expect(out).toContain(":text-is(");
    expect(out).toContain("getByText(name, { exact: true })");
  });

  // Regression: a derived name cannot be matched by getByRole, so a verified selector has
  // to win even when role+name are both present.
  it("prefers a verified css selector over role+name", () => {
    const out = spec([{ id: "s1", action: "click",
      target: { role: "link", name: "shopping cart link", css: '[data-test="shopping-cart-link"]' } }]);
    expect(out).not.toContain("safeClick");
    expect(out).toContain('page.locator("[data-test=\\"shopping-cart-link\\"]")');
  });

  // Regression: resolveCode already returns a full locator expression, so the hover branch
  // was emitting page.locator(<Locator>) — invalid, could never have run.
  it("does not nest a Locator inside page.locator for a hover preAction", () => {
    const out = spec([{ id: "s1", action: "click",
      target: { role: "link", name: "Menu" },
      preAction: { action: "hover", target: { role: "link", name: "Menu" } } }]);
    expect(out).not.toMatch(/page\.locator\(\s*\(await locate/);
    expect(out).toContain("(await locate(page, \"link\", \"Menu\")).hover()");
  });

  // Regression: 30 vacuous toHaveURL(new RegExp("")) across the run history — matches any
  // page, so the step reported a confident pass while verifying nothing.
  it("refuses to emit a comparison assertion with no value", () => {
    expect(() => spec([{ id: "s1", action: "assert",
      target: { role: "heading", name: "x" }, assertion: "text_contains" }]))
      .toThrow(/no comparison value/);
  });

  it("reads a url_contains path from target.url when value is absent", () => {
    const out = spec([{ id: "s1", action: "assert", target: { url: "/inventory.html" }, assertion: "url_contains" }]);
    expect(out).toContain('toHaveURL(new RegExp("/inventory\\\\.html")');
  });

  it("emits one test.step per IR step", () => {
    const out = spec([
      { id: "s1", action: "navigate", target: { url: "/" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Username" }, value: "u" },
      { id: "s3", action: "assert", target: { role: "button", name: "Login" }, assertion: "hidden" },
    ]);
    expect(out.match(/await test\.step\(/g)?.length).toBe(3);
  });

  it("marks a truncated IR in the generated file", () => {
    const out = spec([{ id: "s1", action: "navigate", target: { url: "/" } }],
      { truncated: true, truncationNote: "could not ground step s2" });
    expect(out).toContain("// PARTIAL:");
    expect(out).toContain("could not ground step s2");
  });

  // Regression: a `//` line comment ends at the first newline. sourcePrompt is free-form
  // user text — nothing stops it from containing a literal newline — and an unsanitized
  // `// Source: ${sourcePrompt}` interpolation let the rest of the prompt fall onto a bare,
  // uncommented line, producing "SyntaxError: Missing semicolon" in the generated spec.
  it("never emits a raw newline into the Feature/Source comment lines", () => {
    const out = spec([{ id: "s1", action: "navigate", target: { url: "/" } }], {
      feature: "Auth\nInjected",
      sourcePrompt: "select the product named '\nSauce Labs Fleece Jacket\n' and click it",
    });
    const sourceLine = out.split("\n").find((l) => l.startsWith("// Source:"));
    const featureLine = out.split("\n").find((l) => l.startsWith("// Feature:"));
    expect(sourceLine).toBe("// Source: select the product named ' Sauce Labs Fleece Jacket ' and click it");
    expect(featureLine).toBe("// Feature: Auth Injected");
  });

  it("rewrites networkidle, which hangs on real sites", () => {
    const out = spec([{ id: "s1", action: "navigate", target: { url: "/" } }]);
    expect(out).not.toContain("networkidle");
  });

  // Regression: the screenshot path was hard-coded "artifacts/step-N.png", relative to the
  // Playwright process CWD — so every run and every case overwrote the same nine files at
  // the repo root. With concurrent users that is a cross-user leak.
  it("writes per-step screenshots into the directory it is given", () => {
    const out = generateSpec({
      meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "s", baseUrl: "https://x" },
      steps: [{ id: "s1", action: "navigate", target: { url: "/" } }],
    } as unknown as IR, "runs/abc/cases/case-0/artifacts");
    expect(out).toContain('await shot(page, "runs/abc/cases/case-0/artifacts/step-1.png")');
    expect(out).not.toContain('"artifacts/step-1.png"');
  });

  it("normalises Windows separators in the screenshot directory", () => {
    const out = generateSpec({
      meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "s", baseUrl: "https://x" },
      steps: [{ id: "s1", action: "navigate", target: { url: "/" } }],
    } as unknown as IR, "runs\\abc\\artifacts\\");
    expect(out).toContain('await shot(page, "runs/abc/artifacts/step-1.png")');
  });
});

// ---------------------------------------------------------------------------
// Screenshot capture. Regression: step screenshots came out solid white (4,254-byte
// PNGs) because `page.screenshot()` fired immediately after the action, catching the
// app's JS-driven fade-in at ~0% opacity.
// ---------------------------------------------------------------------------

describe("generateSpec — screenshots", () => {
  const ir = (steps: any[]) => ({
    meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://x.example" },
    steps,
  }) as any;

  const threeSteps = ir([
    { id: "s1", action: "navigate", target: { url: "/" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Email" }, value: "a@b.c" },
    { id: "s3", action: "assert", target: { role: "button", name: "Sign In" }, assertion: "hidden" },
  ]);

  it("routes every step capture through the settling helper, never a bare screenshot", () => {
    const spec = generateSpec(threeSteps, "runs/demo/artifacts");
    expect(spec).not.toMatch(/await page\.screenshot\(\{ path/);
    expect(spec.match(/await shot\(page, /g) ?? []).toHaveLength(3);
  });

  // Unconditional injection — a `needsShot` gate could compute false and emit a spec that
  // calls a function that isn't there.
  it("always injects the helper, exactly once", () => {
    for (const spec of [generateSpec(threeSteps, "a"), generateSpec(ir([{ id: "s1", action: "navigate", target: { url: "/" } }]), "a")]) {
      expect(spec.match(/async function shot\(/g) ?? []).toHaveLength(1);
      expect(spec).toContain('import { writeFileSync } from "node:fs"');
    }
  });

  // generateSpec rewrites "networkidle" -> "domcontentloaded" on the way out; the helper must
  // not depend on a wait that rewrite would silently change.
  it("does not rely on networkidle", () => {
    expect(generateSpec(threeSteps, "a")).not.toContain("networkidle");
  });
});

describe("{{uid}}: a create flow's names are unique on every run", () => {
  // Run 2026-10-24T14-53-11-800Z-86059d19: the valid Lead case was blocked by the org's duplicate rule
  // ("Similar Records Exist") because earlier runs had created the same name. Made-up values.
  const spec = generateSpec({
    meta: { feature: "Zq", title: "Create a Zq", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
    steps: [
      { id: "s1", action: "navigate", target: { url: "/new" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name", css: "#n" }, value: "Zq Smith {{uid}}" },
    ],
  } as unknown as IR);

  it("declares one run context and resolves the token with it, so no literal {{uid}} is typed", () => {
    const decl = spec.match(/const RUN_CTX = [^;]+;\nconst resolveRunTokens = [\s\S]+?\}\);/)?.[0];
    expect(decl).toBeTruthy();
    const fillArg = spec.match(/\.fill\((.+?), \{ timeout/)?.[1];
    expect(fillArg).toBeTruthy();
    const typed = new Function(`${decl} return ${fillArg};`)() as string;
    expect(typed).toMatch(/^Zq Smith [a-z0-9]{4,}$/);
    expect(typed).not.toContain("{{uid}}");
    // The report reads the values back from results.json (app.js runTokensOf).
    expect(spec).toContain('annotations.push({ type: "run-tokens", description: JSON.stringify(RUN_CTX) })');
  });

  it("resolves phone and date tokens at run time too, in the token's locale", () => {
    const s = generateSpec({
      meta: { feature: "Zq", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
      steps: [
        { id: "s1", action: "fill", target: { role: "textbox", name: "Zq Phone", css: "#p" }, value: "{{phone}}" },
        { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Due", css: "#d" }, value: "{{date:+30:en-GB}}" },
      ],
    } as unknown as IR);
    const decl = s.match(/const RUN_CTX = [^;]+;\nconst resolveRunTokens = [\s\S]+?\}\);/)?.[0];
    const args = [...s.matchAll(/\.fill\((.+?), \{ timeout/g)].map((m) => m[1]);
    const [phone, due] = args.map((a) => new Function(`${decl} return ${a};`)() as string);
    expect(phone).toMatch(/^[0-9]{10}$/);
    expect(due).toMatch(/^[0-9]{2}\/[0-9]{2}\/[0-9]{4}$/);   // en-GB: day first
  });

  it("a spec without the token is unchanged", () => {
    const plain = generateSpec({
      meta: { feature: "Zq", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
      steps: [{ id: "s1", action: "fill", target: { role: "textbox", name: "Zq Name", css: "#n" }, value: "Zq Smith" }],
    } as unknown as IR);
    expect(plain).not.toContain("RUN_CTX");
  });

  // Run 2026-10-25T06-38-05-178Z-ebdc2303 case-3 asserted getByText('VisibleLast {{uid}}'): the literal
  // token never appears on a page. An assertion names the SAME record the fills created, so it is
  // resolved with the same run context.
  it("resolves run tokens in an assertion's text and value with the fills' context", () => {
    const s = generateSpec({
      meta: { feature: "Zq", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
      steps: [
        { id: "s1", action: "fill", target: { role: "textbox", name: "Zq Name", css: "#n" }, value: "Zq Kim {{uid}}" },
        { id: "s2", action: "assert", target: { text: "Zq Kim {{uid}}" }, assertion: "visible" },
        { id: "s3", action: "assert", target: { role: "heading", name: "Zq Title", css: "h1" }, assertion: "text_contains", value: "Zq Kim {{uid}}" },
      ],
    } as unknown as IR);
    expect(s).toContain('getByText(resolveRunTokens("Zq Kim {{uid}}", RUN_CTX))');
    expect(s).toContain('toContainText(resolveRunTokens("Zq Kim {{uid}}", RUN_CTX)');
    expect(s.match(/const RUN_CTX = /g)).toHaveLength(1);
  });

  it("a lookup select emits lookupPick with its helper, never choose", () => {
    const s = generateSpec({
      meta: { feature: "Zq", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" },
      steps: [{ id: "s1", action: "select", target: { role: "combobox", name: "Zq Firm Name", css: "#f", lookup: true }, value: "" }],
    } as unknown as IR);
    expect(s).toContain("await lookupPick(page,");
    expect(s).toContain("async function lookupPick(");
    expect(s).not.toContain("await choose(");
  });
});

describe("a text check after a record's Details tab scrolls its lazy sections in first", () => {
  const meta = { feature: "Zq", title: "t", priority: "high", sourcePrompt: "p", baseUrl: "https://zq.example" };
  const spec = generateSpec({ meta, steps: [
    { id: "s1", action: "click", target: { role: "button", name: "Save", css: "#save" } },
    { id: "s2", action: "assert", target: { text: "was created" }, assertion: "visible" },
    { id: "s3", action: "click", target: { role: "tab", name: "Details" } },
    { id: "s4", action: "assert", target: { text: "Zq Expiry" }, assertion: "visible" },
  ] } as unknown as IR);

  it("reveals only after the Details click, never before the toast check", () => {
    expect(spec).toContain('await sfReveal(page, "Zq Expiry");');
    expect(spec).not.toContain('sfReveal(page, "was created")');
    expect(spec).toContain("async function sfReveal(page, text)");
  });

  it("adds nothing to a spec with no Details tab", () => {
    const plain = generateSpec({ meta, steps: [{ id: "s1", action: "assert", target: { text: "Zq" }, assertion: "visible" }] } as unknown as IR);
    expect(plain).not.toContain("sfReveal");
  });
});
