import { describe, it, expect } from "vitest";
import { strategyFor, classifyScope, filterByScope, ALL_SCOPES, normalizeCategory } from "../src/kb/testStrategy.js";
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
    // Real Playwright output: the log ALWAYS ends in "locator resolved to N elements".
    // N=0 -> missing. (The old /resolved to/ check matched this line and misread it as
    // found, sending missing elements to the generic "timeout" bucket and starving the
    // element_missing self-heal path.)
    expect(classify([
      "Timeout 10000ms exceeded.",
      'waiting for getByRole("button", { name: "Login" })',
      "locator resolved to 0 elements",
    ].join("\n"))?.category).toBe("element_missing");
  });

  it("reads a missing element when the timeout closes before a single poll resolves it", () => {
    expect(classify('Timeout 10000ms exceeded.\nwaiting for getByRole("button")')?.category)
      .toBe("element_missing");
  });

  it("reads a found-but-not-interactable element from a non-zero resolved count", () => {
    expect(classify([
      "Timeout 10000ms exceeded.",
      'waiting for getByRole("button", { name: "Login" })',
      "locator resolved to 1 element",
      "element is not visible",
    ].join("\n"))?.category).toBe("element_not_interactable");
  });

  it("reads a found element whose assertion never became true as a timeout", () => {
    expect(classify([
      "Timeout 10000ms exceeded.",
      'waiting for getByRole("heading", { name: "Welcome" })',
      "locator resolved to 1 element",
    ].join("\n"))?.category).toBe("timeout");
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

// ---------------------------------------------------------------------------
// Regressions from run 2026-07-30T15-19-00-537Z-dcd09643, which produced 8 cases
// (with a duplicated primary) and SQL-injection/XSS cases for a request that said
// "functionality".
// ---------------------------------------------------------------------------

describe("scope + category routing", () => {
  const REAL_PROMPT =
    "Please perform a comprehensive test of the login and signup functionality for the application in url,";

  // The old regex was \b(functional|functionalit)\b, which cannot match "functionality" —
  // the trailing "y" blocks the closing word boundary — so the run silently kept both scopes.
  it("classifies an inflected 'functionality' request as functional-only", () => {
    expect(classifyScope(REAL_PROMPT)).toEqual(["functional"]);
    expect(classifyScope("test the functionality of checkout")).toEqual(["functional"]);
    expect(classifyScope("functionally verify the cart")).toEqual(["functional"]);
  });

  it("still detects security requests, and stays open when neither is named", () => {
    expect(classifyScope("check for sql injection")).toEqual(["security"]);
    expect(classifyScope("look for security vulnerabilities")).toEqual(["security"]);
    expect(classifyScope("test the login page")).toEqual(["functional", "security"]);
  });

  // Free-text categories were the shared root cause of three bugs. These are the exact
  // strings the model emitted in that run.
  it("normalises the categories the model actually invented", () => {
    expect(normalizeCategory("Security - SQL Injection")).toBe("security-injection");
    expect(normalizeCategory("Security - XSS")).toBe("security-xss");
    expect(normalizeCategory("Invalid input")).toBe("invalid-input");
    expect(normalizeCategory("Valid credentials")).toBe("valid");
    expect(normalizeCategory("Empty password")).toBe("empty-boundary");
    expect(normalizeCategory(undefined)).toBe("functional-other");
  });

  // filterByScope used to KEEP any category it couldn't look up, so an invented security
  // label sailed through a functional-only run.
  it("drops security cases from a functional-only run", () => {
    const cases = [
      { title: "SQLi", category: "Security - SQL Injection" },
      { title: "XSS", category: "Security - XSS" },
      { title: "Bad password", category: "Invalid input" },
    ];
    expect(filterByScope(cases, ["functional"]).map(c => c.title)).toEqual(["Bad password"]);
  });

  it("never drops the case the user literally asked for", () => {
    const cases = [{ title: "asked for", category: "Security - XSS", fromPrompt: true }];
    expect(filterByScope(cases, ["functional"])).toHaveLength(1);
  });
});
