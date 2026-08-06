import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runPipeline } from "./orchestrator.js";
import type { Plan } from "./stages/planner.js";
import type { AppModel } from "./schema/appModel.js";
import type { TestCase } from "./stages/testCases.js";

// Mock every heavy stage so the pipeline can complete end-to-end without any LLM call,
// network request, or Playwright launch. The whole point of this test is the testcases
// stage: does the flag-off path call toTestCases directly, and does the flag-on path
// route through the gate?
const h = vi.hoisted(() => ({
  plan: vi.fn(),
  discover: vi.fn(),
  toTestCases: vi.fn(),
  selectCases: vi.fn(),
  budgetFor: vi.fn(),
  generateCasesForNewPages: vi.fn(),
  toIR: vi.fn(),
  generateSpec: vi.fn(),
  runSpec: vi.fn(),
  findScreenshot: vi.fn(),
  detectBlocked: vi.fn(),
  runSuite: vi.fn(),
  analyzeFailure: vi.fn(),
  refreshPageModel: vi.fn(),
  credentialsFor: vi.fn(),
  credentialFieldsNeeded: vi.fn(),
  promptCarriesCredentials: vi.fn(),
  credentialEnvVars: vi.fn(),
  credentialPolicyFor: vi.fn(),
  runCaseSelectionGate: vi.fn(),
  storeAppend: vi.fn(),
  storeRead: vi.fn(),
}));

vi.mock("./stages/planner.js", () => ({ plan: h.plan }));
vi.mock("./stages/hybridDiscovery.js", () => ({ discover: h.discover, discoverPages: h.discover }));
vi.mock("./stages/testCases.js", () => ({
  toTestCases: h.toTestCases,
  selectCases: h.selectCases,
  budgetFor: h.budgetFor,
  generateCasesForNewPages: h.generateCasesForNewPages,
}));
vi.mock("./stages/ir.js", () => ({ toIR: h.toIR }));
vi.mock("./stages/generator.js", () => ({ generateSpec: h.generateSpec }));
vi.mock("./stages/executor.js", () => ({
  runSpec: h.runSpec,
  findScreenshot: h.findScreenshot,
  detectBlocked: h.detectBlocked,
}));
vi.mock("./stages/suiteRunner.js", () => ({ runSuite: h.runSuite }));
vi.mock("./stages/failureAnalysis.js", () => ({ analyzeFailure: h.analyzeFailure }));
vi.mock("./stages/liveExtend.js", () => ({ refreshPageModel: h.refreshPageModel }));
vi.mock("./stages/credentials.js", () => ({
  credentialsFor: h.credentialsFor,
  credentialFieldsNeeded: h.credentialFieldsNeeded,
  promptCarriesCredentials: h.promptCarriesCredentials,
  credentialEnvVars: h.credentialEnvVars,
  credentialPolicyFor: h.credentialPolicyFor,
}));
vi.mock("./stages/caseSelectionGate.js", () => ({ runCaseSelectionGate: h.runCaseSelectionGate }));
vi.mock("./runStore.js", () => ({
  store: { append: h.storeAppend, read: h.storeRead },
}));

const runIds: string[] = [];

function newRunId(): string {
  const id = "__test-" + randomUUID();
  runIds.push(id);
  return id;
}

afterEach(() => {
  for (const runId of runIds) {
    fs.rmSync(path.join("runs", runId), { recursive: true, force: true });
  }
  runIds.length = 0;
  vi.clearAllMocks();
});

const thePlan: Plan = {
  goal: "Verify a user can log in and reach the dashboard",
  steps: ["Open the login page", "Log in with valid credentials", "Verify the dashboard is displayed"],
  testTypeScope: ["functional", "security"],
  coverage: "standard",
};

const appModel: AppModel = {
  baseUrl: "https://x.example",
  pages: [{
    url: "https://x.example/",
    concepts: ["Login"],
    elements: [
      { role: "textbox", name: "Email" },
      { role: "textbox", name: "Password" },
      { role: "button", name: "Sign In" },
    ],
  }],
};

const directCase: TestCase = {
  title: "Log in with the given credentials",
  priority: "high",
  feature: "Login",
  steps: ["Navigate to /login", "Click 'Sign In'"],
  expected: "Login succeeds",
  fromPrompt: true,
  category: "valid",
  generatedFrom: "upfront",
};

const ir: any = {
  meta: { truncated: false, hasTerminalAssertion: true },
  steps: [],
};

const passedRun = {
  passed: true,
  exitCode: 0,
  artifactsDir: "artifacts",
  resultsJsonPath: "results.json",
  raw: "{}",
};

beforeEach(() => {
  h.plan.mockResolvedValue(thePlan);
  h.discover.mockResolvedValue(appModel);
  h.toTestCases.mockResolvedValue([directCase]);
  h.selectCases.mockImplementation((all: TestCase[]) => all);
  h.budgetFor.mockReturnValue(10);
  h.generateCasesForNewPages.mockResolvedValue([]);
  h.toIR.mockResolvedValue({ ir, updatedAppModel: appModel });
  h.generateSpec.mockReturnValue("spec");
  h.runSpec.mockResolvedValue(passedRun);
  h.findScreenshot.mockReturnValue(null);
  h.detectBlocked.mockReturnValue(null);
  h.runSuite.mockResolvedValue(undefined);
  h.analyzeFailure.mockResolvedValue({ category: "selector_changed", failingStepId: "s1" });
  h.refreshPageModel.mockResolvedValue(appModel);
  h.credentialsFor.mockReturnValue(undefined);
  h.credentialFieldsNeeded.mockReturnValue([]);
  h.promptCarriesCredentials.mockReturnValue(false);
  h.credentialEnvVars.mockReturnValue({});
  h.credentialPolicyFor.mockReturnValue({ inject: true, positive: true });
  h.runCaseSelectionGate.mockResolvedValue({ finalCases: [directCase] });
});

describe("runPipeline testcases stage", () => {
  it("flag off: calls toTestCases directly and runs its cases", async () => {
    delete process.env.ENABLE_CASE_SELECTION_GATE;
    const runId = newRunId();

    const result = await runPipeline(
      { prompt: "test login", url: "https://x.example/" },
      () => {},
      runId
    );

    expect(h.toTestCases).toHaveBeenCalledTimes(1);
    expect(h.toTestCases).toHaveBeenCalledWith(thePlan, appModel);
    expect(h.runCaseSelectionGate).not.toHaveBeenCalled();
    expect(h.runSuite).toHaveBeenCalledTimes(1);
    expect(h.runSuite.mock.calls[0][0]).toEqual([directCase]);
    expect(result.runId).toBe(runId);
  });

  it("flag on: routes through the gate with the source prompt", async () => {
    process.env.ENABLE_CASE_SELECTION_GATE = "true";
    const runId = newRunId();

    await runPipeline(
      { prompt: "test login", url: "https://x.example/" },
      () => {},
      runId
    );

    expect(h.toTestCases).not.toHaveBeenCalled();
    expect(h.runCaseSelectionGate).toHaveBeenCalledTimes(1);
    expect(h.runCaseSelectionGate).toHaveBeenCalledWith({
      runId,
      plan: thePlan,
      appModel,
      sourcePrompt: "test login",
    });
    expect(h.runSuite.mock.calls[0][0]).toEqual([directCase]);
  });
});
