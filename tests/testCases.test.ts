import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AppModel } from "../src/schema/appModel.js";
import type { TestCase } from "../src/stages/testCases.js";

const { geminiMock, azureMock } = vi.hoisted(() => ({ geminiMock: vi.fn(), azureMock: vi.fn() }));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));
vi.mock("../src/llm/azureOpenAI.js", () => ({ azureOpenAI: azureMock }));
const { toTestCases, dropCompoundLoginCases, NoTestCasesError } = await import("../src/stages/testCases.js");

const tc = (o: Partial<TestCase>): TestCase =>
  ({ priority: "high", feature: "Login", steps: ["step"], generatedFrom: "upfront", fromPrompt: false,
     title: "t", expected: "e", category: "functional-other",
     intent: "test intent", whyItMatters: "test consequence", ...o }) as TestCase;

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
    geminiMock.mockResolvedValueOnce({ content: JSON.stringify([COMPOUND_CASE, INVALID_PASSWORD_CASE]), usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });
    // toTestCases returns from the disk cache before gemini() is even called — a static
    // sourcePrompt would silently hit a prior test's cache entry and make this assertion
    // vacuous (same discipline irSystemPrompt.test.ts documents for toIR).
    const cases = await toTestCases(plan, appModel, undefined, {
      sourcePrompt: `compound-case-e2e ${Date.now()}-${Math.random()}`,
    });
    expect(cases.some((c) => c.title === COMPOUND_CASE.title)).toBe(false);
  });

  // Regression for run 2026-09-16T07-10-56-871Z-2a364a79: an earlier run's EMPTY answer was
  // cached forever and served to every later run (llmUsage.calls === 0). A zero-case result must
  // now throw the typed NoTestCasesError — never be returned, and never be written to the cache.
  it("throws NoTestCasesError instead of returning [] when the model yields no usable cases", async () => {
    geminiMock.mockResolvedValueOnce({ content: "[]", usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 } });

    const err = await toTestCases(plan, appModel, undefined, {
      sourcePrompt: `empty-cases ${Date.now()}-${Math.random()}`,
    }).then(
      () => { throw new Error("toTestCases resolved — expected NoTestCasesError"); },
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(NoTestCasesError);
    if (err instanceof NoTestCasesError) {
      expect(err.message).toBe("The model returned no usable test cases. Raw response saved.");
      expect(err.name).toBe("NoTestCasesError");
      expect(err.provider).toBe("gemini");
      expect(typeof err.modelOrDeployment).toBe("string");
      expect(err.rawResponse).toBe("[]");
      // gemini.ts never reports a finish reason — the field must be absent, not empty.
      expect(err.finishReason).toBeUndefined();
    }
  });
});

describe("toTestCases — azure provider", () => {
  beforeEach(() => {
    process.env.LLM_PROVIDER = "azure";
    process.env.AZURE_OPENAI_DEPLOYMENT = "gpt-deploy-main";
  });
  afterEach(() => {
    delete process.env.LLM_PROVIDER;
    delete process.env.AZURE_OPENAI_DEPLOYMENT;
  });

  // The evidence run this whole phase explains: completionTokens 538, reasoningTokens 512 (~26
  // visible tokens of JSON), parsed to []. Two ways that can be reported - truncation, or an
  // envelope that a strict top-level `Array.isArray` miss turned into []. These three tests pin
  // each separately. An envelope whose array holds usable cases must PRODUCE cases.
  it("unwraps a {\"testCases\":[...]} envelope from azure into real cases", async () => {
    azureMock.mockResolvedValueOnce({
      content: JSON.stringify({ testCases: [VALID_LOGIN_CASE, INVALID_PASSWORD_CASE] }),
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: "stop",
      refusal: null,
    });
    const cases = await toTestCases(plan, appModel, undefined, {
      sourcePrompt: `azure-envelope ${Date.now()}-${Math.random()}`,
    });
    expect(azureMock).toHaveBeenCalledTimes(1);
    expect(cases.length).toBe(2);
    expect(cases.map((c) => c.title)).toContain(VALID_LOGIN_CASE.title);
  });

  it("unwraps a {\"cases\":[...]} envelope and a single-key object the same way", async () => {
    azureMock.mockResolvedValueOnce({
      content: JSON.stringify({ cases: [VALID_LOGIN_CASE] }),
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: "stop",
    });
    const viaCases = await toTestCases(plan, appModel, undefined, {
      sourcePrompt: `azure-cases-key ${Date.now()}-${Math.random()}`,
    });
    azureMock.mockResolvedValueOnce({
      content: JSON.stringify({ data: [INVALID_PASSWORD_CASE] }),
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      finishReason: "stop",
    });
    const viaSingleKey = await toTestCases(plan, appModel, undefined, {
      sourcePrompt: `azure-single-key ${Date.now()}-${Math.random()}`,
    });
    expect(viaCases.map((c) => c.title)).toEqual([VALID_LOGIN_CASE.title]);
    expect(viaSingleKey.map((c) => c.title)).toEqual([INVALID_PASSWORD_CASE.title]);
  });

  it("an azure empty result throws NoTestCasesError carrying the azure finishReason", async () => {
    azureMock.mockResolvedValueOnce({
      content: JSON.stringify({ testCases: [] }),
      usage: { promptTokens: 538, completionTokens: 538, totalTokens: 1050 },
      finishReason: "length",
      refusal: null,
    });
    const err = await toTestCases(plan, appModel, undefined, {
      sourcePrompt: `azure-empty ${Date.now()}-${Math.random()}`,
    }).then(
      () => { throw new Error("toTestCases resolved — expected NoTestCasesError"); },
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(NoTestCasesError);
    if (err instanceof NoTestCasesError) {
      expect(err.provider).toBe("azure");
      expect(err.modelOrDeployment).toBe("gpt-deploy-main");
      expect(err.finishReason).toBe("length");
      expect(err.rawResponse).toBe(JSON.stringify({ testCases: [] }));
    }
  });
});
