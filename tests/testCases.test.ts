import { describe, it, expect, vi } from "vitest";
import type { AppModel } from "../src/schema/appModel.js";
import type { TestCase } from "../src/stages/testCases.js";

const { geminiMock } = vi.hoisted(() => ({ geminiMock: vi.fn() }));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));
const { toTestCases, dropCompoundLoginCases } = await import("../src/stages/testCases.js");

const tc = (o: Partial<TestCase>): TestCase =>
  ({ priority: "high", feature: "Login", steps: ["step"], generatedFrom: "upfront", fromPrompt: false,
     title: "t", expected: "e", category: "functional-other", ...o }) as TestCase;

// The real production repro (run 2026-08-02T18-34-28-317Z-9ef3c101, learnvibes.vercel.app).
const COMPOUND_CASE = tc({
  title: "Full login page verification flow", fromPrompt: true, category: "functional-other",
  steps: [
    "Navigate to https://learnvibes.vercel.app/login",
    "Verify 'you@thinkvibes.com', '*********', and 'Sign In' are visible and interactive",
    "Fill 'you@thinkvibes.com' with 'valid.user@example.com'",
    "Fill '*********' with 'Password123!'",
    "Click 'Sign In'",
    "Verify successful redirection to the dashboard",
    "Return to the login page",
    "Fill 'you@thinkvibes.com' with 'invalid@example.com'",
    "Fill '*********' with 'WrongPass'",
    "Click 'Sign In'",
    "Verify that an error message is displayed",
    "Verify the user session persists after returning to the authenticated area",
  ],
  expected: "UI elements are present, valid credentials grant access, invalid credentials show errors, and session state is maintained.",
});

const VALID_LOGIN_CASE = tc({
  title: "Log in with valid credentials", category: "valid",
  steps: ["Navigate to /login", "Fill 'Email' with 'user@example.com'", "Fill 'Password' with 'hunter2'", "Click 'Sign In'"],
  expected: "Login succeeds",
});

const INVALID_PASSWORD_CASE = tc({
  title: "Login with invalid password", category: "invalid-input",
  steps: ["Navigate to /login", "Fill 'Email' with 'user@example.com'", "Fill 'Password' with 'wrong'", "Click 'Sign In'"],
  expected: "An error is shown",
});

describe("dropCompoundLoginCases", () => {
  it("drops the compound case and promotes a surviving 'valid' case to fromPrompt", () => {
    const result = dropCompoundLoginCases([COMPOUND_CASE, VALID_LOGIN_CASE, INVALID_PASSWORD_CASE]);
    expect(result.some((c) => c.title === COMPOUND_CASE.title)).toBe(false);
    expect(result.find((c) => c.category === "valid")?.fromPrompt).toBe(true);
    expect(result.length).toBe(2);
  });

  it("leaves a non-compound batch untouched", () => {
    const batch = [VALID_LOGIN_CASE, INVALID_PASSWORD_CASE];
    expect(dropCompoundLoginCases(batch)).toBe(batch); // same reference — no dropped cases
  });

  it("drops the only fromPrompt case with nothing to promote and logs a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = dropCompoundLoginCases([COMPOUND_CASE]);
    expect(result).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("no 'valid' case survives to promote"));
    warn.mockRestore();
  });
});

const appModel: AppModel = {
  baseUrl: "https://compound-case-e2e.example",
  pages: [{
    url: "https://compound-case-e2e.example/login", title: "Login", concepts: ["Login"],
    elements: [
      { role: "textbox", name: "Email" }, { role: "textbox", name: "Password" },
      { role: "button", name: "Sign In" },
    ],
  }],
};
const plan: any = { steps: ["log in"], testTypeScope: ["functional"], coverage: "standard" };

describe("toTestCases — compound-login backstop end-to-end", () => {
  it("never returns a compound case even if the model still produces one", async () => {
    geminiMock.mockResolvedValueOnce(JSON.stringify([COMPOUND_CASE, INVALID_PASSWORD_CASE]));
    // toTestCases returns from the disk cache before gemini() is even called — a static
    // sourcePrompt would silently hit a prior test's cache entry and make this assertion
    // vacuous (same discipline irSystemPrompt.test.ts documents for toIR).
    const cases = await toTestCases(plan, appModel, undefined, {
      sourcePrompt: `compound-case-e2e ${Date.now()}-${Math.random()}`,
    });
    expect(cases.some((c) => c.title === COMPOUND_CASE.title)).toBe(false);
  });
});
