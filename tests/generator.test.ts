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
