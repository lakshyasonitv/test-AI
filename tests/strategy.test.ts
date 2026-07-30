import { describe, it, expect } from "vitest";
import { strategyFor, classifyScope, filterByScope, ALL_SCOPES } from "../src/kb/testStrategy.js";
import { Semaphore } from "../src/server/concurrency.js";
import { extractPromptSelectors, verifyAgainstModel, promptSelectorHint } from "../src/stages/promptSelectors.js";
import { classify, findFailingStepId } from "../src/stages/classify.js";
import type { AppModel } from "../src/schema/appModel.js";
import type { IR } from "../src/schema/ir.js";

// --- converted from the inline `if (process.argv[1]...)` self-check in testStrategy.ts ---
describe("testStrategy", () => {
  it("aliases 'Sign In' to the login suite including the injection case", () => {
    const login = strategyFor(["Sign In"]);
    expect(login.some(c => /sql injection/i.test(c.title))).toBe(true);
    expect(login.length).toBeGreaterThanOrEqual(6);
  });

  it("falls back to exactly the generic floor for an unknown concept", () => {
    expect(strategyFor(["Totally Unknown Concept"]).length).toBe(1);
  });

  it("does not duplicate categories for aliased duplicate concepts", () => {
    expect(strategyFor(["Login", "Sign In"]).length).toBe(strategyFor(["Sign In"]).length);
  });

  it("classifies scope from prompt wording", () => {
    expect(classifyScope("run functional tests only")).toEqual(["functional"]);
    expect(classifyScope("test for SQL injection vulnerabilities")).toEqual(["security"]);
    expect(classifyScope("functional and security testing")).toEqual(["functional", "security"]);
    expect(classifyScope("test the login page")).toEqual(ALL_SCOPES);
  });

  it("keeps fromPrompt and uncategorised cases regardless of scope", () => {
    const cases = [
      { category: "Valid credentials", fromPrompt: false },
      { category: "SQL injection in login", fromPrompt: false },
      { category: "Valid credentials", fromPrompt: true },
      { category: undefined, fromPrompt: false },
    ];
    const func = filterByScope(cases, ["functional"]);
    expect(func.length).toBe(3);
    expect(func.some(c => c.category === "SQL injection in login")).toBe(false);
    expect(filterByScope(cases, ALL_SCOPES).length).toBe(4);
  });
});

// --- converted from the inline self-check in concurrency.ts -----------------------------
describe("Semaphore", () => {
  it("holds the cap when a new caller arrives in the wake gap", async () => {
    const sem = new Semaphore(2);
    let running = 0, peak = 0;
    const gates: Array<() => void> = [];
    const task = () => sem.run(async () => {
      running++; peak = Math.max(peak, running);
      await new Promise<void>(r => gates.push(r));
      running--;
    });
    const flush = () => new Promise(r => setImmediate(r));

    task(); task(); task();      // A,B run; C parks
    await flush();
    gates.shift()!();            // A finishes -> should wake C
    task();                      // D arrives in the wake gap: must NOT start a third
    await flush();
    gates.forEach(g => g());
    await flush();

    expect(peak).toBe(2);
  });

  it("rejects a cap below 1", () => {
    expect(() => new Semaphore(0)).toThrow();
  });
});

describe("promptSelectors", () => {
  // Regression: the user wrote `id="shopping_cart_container"` and the pipeline had no way
  // to use it, truncating on an ungroundable "Cart" link.
  it("extracts id, data-* and #id forms from prose", () => {
    const found = extractPromptSelectors(
      'click the cart id="shopping_cart_container" then [data-test="checkout"] then #main_nav'
    );
    expect(found.map(f => f.css)).toEqual(
      expect.arrayContaining(["#shopping_cart_container", '[data-test="checkout"]', "#main_nav"])
    );
  });

  it("keeps only selectors discovery actually saw", () => {
    const model = { baseUrl: "https://x", pages: [{ url: "https://x", concepts: [], elements: [
      { role: "link", name: "cart", css: '[data-test="shopping-cart-link"]', id: "shopping_cart_container" },
      { role: "button", name: "Checkout", testId: "checkout" },
    ]}]} as unknown as AppModel;

    const { usable, unknown } = verifyAgainstModel(
      extractPromptSelectors('id="shopping_cart_container" and [data-test="checkout"] and #nope_not_here'),
      model,
    );
    expect(usable.map(u => u.css).sort()).toEqual(['#shopping_cart_container', '[data-test="checkout"]']);
    expect(unknown.map(u => u.css)).toEqual(["#nope_not_here"]);
  });

  it("produces no hint block when nothing verified", () => {
    expect(promptSelectorHint([])).toBe("");
  });
});

describe("classify", () => {
  it("recognises a strict mode violation", () => {
    expect(classify("Error: strict mode violation: getByRole('button') resolved to 6 elements")?.category)
      .toBe("multiple_matches");
  });

  it("separates a hidden element from a missing one", () => {
    expect(classify("toBeVisible() failed\nReceived: hidden")?.category).toBe("element_hidden");
    expect(classify('Timeout 10000ms exceeded.\nwaiting for getByRole("button")')?.category)
      .toBe("element_missing");
  });

  it("recognises a network failure", () => {
    expect(classify("net::ERR_NAME_NOT_RESOLVED")?.category).toBe("network");
  });

  it("returns null when no pattern applies, so the LLM fallback runs", () => {
    expect(classify("something entirely unfamiliar")).toBeNull();
  });
});

describe("findFailingStepId", () => {
  const ir = {
    meta: {}, steps: [
      { id: "s1", action: "click", target: { role: "button", name: "Login" } },
      { id: "s2", action: "assert", target: { text: "Welcome" }, assertion: "visible" },
    ],
  } as unknown as IR;

  it("maps a getByRole locator line back to its step", () => {
    expect(findFailingStepId(ir, "Locator: getByRole('button', { name: 'Login' })")).toBe("s1");
  });

  it("maps a getByText locator line back to its step", () => {
    expect(findFailingStepId(ir, "Locator: getByText('Welcome')")).toBe("s2");
  });

  it("returns null rather than guessing", () => {
    expect(findFailingStepId(ir, "no locator line here")).toBeNull();
  });
});
