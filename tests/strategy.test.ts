import { describe, it, expect, vi } from "vitest";
import { strategyFor, classifyScope, filterByScope, ALL_SCOPES, normalizeCategory } from "../src/kb/testStrategy.js";
import { Semaphore } from "../src/server/concurrency.js";
import { extractPromptSelectors, verifyAgainstModel, promptSelectorHint } from "../src/stages/promptSelectors.js";
import { classify, findFailingStepId } from "../src/stages/classify.js";
import type { AppModel } from "../src/schema/appModel.js";
import type { IR } from "../src/schema/ir.js";

const { geminiMock } = vi.hoisted(() => ({ geminiMock: vi.fn().mockResolvedValue({
  content: JSON.stringify([{
    title: "Log in with valid credentials", priority: "high", feature: "Login",
    steps: ["Navigate to /login", "Fill 'Username' with 'user@example.com'", "Fill 'Password' with 'hunter2'", "Click 'Log in'"],
    expected: "Login succeeds", fromPrompt: false, category: "valid",
    intent: "Valid credentials let a user reach the authenticated area.",
    whyItMatters: "If this breaks, legitimate users cannot sign in.",
  }]),
  usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
}) }));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));
const { toTestCases } = await import("../src/stages/testCases.js");
// Hoisted to module scope, not re-imported per `it()`: hybridDiscovery.ts pulls in Playwright,
// and re-triggering that dynamic import 5x under parallel test load is what produced a real,
// reproduced-at-HEAD flake (TECH_DEBT.md TD-21) — a 5s timeout on the import itself roughly 1
// run in 6. One import, done once, at the same top-level-await point testCases.js already uses.
const { isAllowedEntryUrl } = await import("../src/stages/hybridDiscovery.js");

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
    const model = {
      baseUrl: "https://x", pages: [{
        url: "https://x", concepts: [], elements: [
          { role: "link", name: "cart", css: '[data-test="shopping-cart-link"]', id: "shopping_cart_container" },
          { role: "button", name: "Checkout", testId: "checkout" },
        ]
      }]
    } as unknown as AppModel;

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

  // Regression: Playwright words an assertion timeout two ways — "expect(locator).toBeVisible()
  // failed" and "Timed out Nms waiting for expect(locator).toBeVisible()". Only the first was
  // matched, so this (verbatim from run 2026-08-14T20-25-38-925Z-70279845's results.json, minus
  // ANSI codes) fell through the whole deterministic classifier to the Gemini fallback, which
  // invented a "multiple_matches" diagnosis for an error that plainly says one element resolved
  // and was hidden.
  it("classifies the 'Timed out ... waiting for expect(...).toBeVisible()' wording too", () => {
    const real = [
      "Error: Timed out 10000ms waiting for expect(locator).toBeVisible()",
      "",
      "Locator: locator('button:has-text(\"All\")')",
      "Expected: visible",
      "Received: hidden",
      "Call log:",
      "  - expect.toBeVisible with timeout 10000ms",
      "  - waiting for locator('button:has-text(\"All\")')",
      '    13 x locator resolved to <button type="button" class="vjs-default-button">',
    ].join("\n");
    expect(classify(real)?.category).toBe("element_hidden");
  });

  it("classifies the same alternate wording for toBeHidden", () => {
    expect(classify("Timed out 5000ms waiting for expect(locator).toBeHidden()\nReceived: visible")?.category)
      .toBe("assertion_failed");
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

// ---------------------------------------------------------------------------
// Regression: toTestCases's checklist wasn't filtered by scope, so a functional-only
// run's prompt said "do NOT write security cases" while its own checklist still listed
// "[critical] SQL injection in login" — a contradiction the model doesn't reliably resolve.
// ---------------------------------------------------------------------------

describe("toTestCases — checklist obeys scope", () => {
  const appModel: AppModel = {
    baseUrl: "https://example.com",
    pages: [{
      url: "https://example.com/login", title: "Login", concepts: ["Login"],
      elements: [{ role: "textbox", name: "Username" }, { role: "textbox", name: "Password" },
      { role: "button", name: "Log in" }],
    }],
  } as unknown as AppModel;

  // toTestCases disk-caches by a hash of its inputs (runs/_cache/llm) — a static plan/model
  // fixture would hit that cache on the second time this suite runs and never call gemini()
  // again, silently making the assertion vacuous. A unique goal per invocation keeps every
  // run a guaranteed cache miss.
  const uniquePlan = (scope: string[]) =>
    ({ goal: `test login ${Date.now()}-${Math.random()}`, steps: ["test login"], testTypeScope: scope, coverage: "standard" } as any);

  it("omits the security checklist item from a functional-only run's prompt", async () => {
    geminiMock.mockClear();
    await toTestCases(uniquePlan(["functional"]), appModel);
    const userPrompt = geminiMock.mock.calls[0][0] as string;
    expect(userPrompt).not.toContain("SQL injection");
  });

  it("still includes it when scope is the default ALL_SCOPES (no behavior change for the tested default)", async () => {
    geminiMock.mockClear();
    await toTestCases(uniquePlan(ALL_SCOPES), appModel);
    const userPrompt = geminiMock.mock.calls[0][0] as string;
    expect(userPrompt).toContain("SQL injection");
  });
});

describe("isAllowedEntryUrl & SSRF validation", () => {
  it("rejects non-http/https schemes like file://", () => {
    expect(isAllowedEntryUrl("file:///C:/Windows/win.ini").ok).toBe(false);
    expect(isAllowedEntryUrl("ftp://example.com/file").ok).toBe(false);
  });

  it("rejects loopback and private network IP hosts (SSRF prevention)", () => {
    expect(isAllowedEntryUrl("http://localhost:3000/").ok).toBe(false);
    expect(isAllowedEntryUrl("http://127.0.0.1:8080/").ok).toBe(false);
    expect(isAllowedEntryUrl("http://169.254.169.254/latest/meta-data/").ok).toBe(false);
    expect(isAllowedEntryUrl("http://192.168.1.1/").ok).toBe(false);
    expect(isAllowedEntryUrl("http://10.0.0.1/").ok).toBe(false);
  });

  it("allows valid public http/https URLs", () => {
    expect(isAllowedEntryUrl("https://learnvibes.vercel.app").ok).toBe(true);
    expect(isAllowedEntryUrl("http://example.com/page").ok).toBe(true);
  });

  // Regression: only the exact "127.0.0.1" was blocked, but the whole 127.0.0.0/8 block is
  // loopback — a classic SSRF-filter bypass is using any OTHER address in that range.
  it("rejects every address in the 127.0.0.0/8 loopback range, not just 127.0.0.1", () => {
    expect(isAllowedEntryUrl("http://127.0.0.2/").ok).toBe(false);
    expect(isAllowedEntryUrl("http://127.5.5.5/").ok).toBe(false);
  });

  // Regression: Node's URL keeps the brackets on an IPv6 host (hostname is "[::1]", not
  // "::1"), so the bare "::1" comparison never matched and IPv6 loopback sailed through.
  it("rejects IPv6 loopback", () => {
    expect(isAllowedEntryUrl("http://[::1]/").ok).toBe(false);
  });
});
