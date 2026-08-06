import { describe, it, expect, vi, beforeEach } from "vitest";
import { runCaseSelectionGate, MAX_CASE_REGEN_ATTEMPTS } from "./caseSelectionGate.js";
import type { Plan } from "./planner.js";
import type { AppModel } from "../schema/appModel.js";
import type { TestCase } from "./testCases.js";

const h = vi.hoisted(() => ({
  toTestCases: vi.fn(),
  awaitCaseSelection: vi.fn(),
  appendAcceptedCases: vi.fn(),
  getAllAcceptedCases: vi.fn(),
  hasAcceptedPrimary: vi.fn(),
  remainingCapacity: vi.fn(),
  appendRoundToHistory: vi.fn(),
  buildHistoryPromptBlock: vi.fn(),
  events: [] as { stage: string; status: string; data?: any }[],
}));

vi.mock("./testCases.js", () => ({
  toTestCases: h.toTestCases,
}));

vi.mock("../server/pendingCaseSelection.js", () => ({
  awaitCaseSelection: h.awaitCaseSelection,
}));

vi.mock("../server/caseAccumulator.js", () => ({
  appendAcceptedCases: h.appendAcceptedCases,
  getAllAcceptedCases: h.getAllAcceptedCases,
  hasAcceptedPrimary: h.hasAcceptedPrimary,
  remainingCapacity: h.remainingCapacity,
  MAX_ACCUMULATED_CASES: 5,
}));

vi.mock("../server/caseHistoryLedger.js", () => ({
  appendRoundToHistory: h.appendRoundToHistory,
  buildHistoryPromptBlock: h.buildHistoryPromptBlock,
}));

vi.mock("../runStore.js", () => ({
  store: {
    append: vi.fn((e: { stage: string; status: string; data?: any }) => h.events.push(e)),
    read: vi.fn(() => h.events),
  },
}));

const plan: Plan = {
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

function makeCase(title: string, fromPrompt = false): TestCase {
  return {
    title,
    priority: "high",
    feature: "Login",
    steps: ["Navigate to /login", "Click 'Sign In'"],
    expected: "Login succeeds",
    fromPrompt,
    category: "valid",
    generatedFrom: "upfront",
  };
}

const primary = makeCase("Log in with the given credentials", true);
const secondary = makeCase("Login with wrong password");
const tertiary = makeCase("Login with empty fields");

beforeEach(() => {
  vi.clearAllMocks();
  h.events.length = 0;
  h.buildHistoryPromptBlock.mockReturnValue("history-block");
  h.getAllAcceptedCases.mockReturnValue([]);
  h.hasAcceptedPrimary.mockReturnValue(false);
  h.remainingCapacity.mockReturnValue(5);
});

describe("runCaseSelectionGate", () => {
  it("exits after a done decision, accepting the selected indexes", async () => {
    h.toTestCases.mockResolvedValue([primary, secondary]);
    h.awaitCaseSelection.mockResolvedValue({ action: "done", selectedIndexes: [0] });
    h.appendAcceptedCases.mockReturnValue({ accepted: [primary], overflow: [], overflowIndexes: [] });
    h.getAllAcceptedCases.mockReturnValue([primary]);
    h.hasAcceptedPrimary.mockReturnValue(true);

    const { finalCases } = await runCaseSelectionGate({ runId: "r1", plan, appModel, sourcePrompt: "test login" });

    expect(finalCases).toEqual([primary]);
    expect(h.toTestCases).toHaveBeenCalledTimes(1);
    expect(h.toTestCases).toHaveBeenCalledWith(plan, appModel);
    expect(h.appendRoundToHistory).toHaveBeenCalledWith("r1", 1, "test login", [primary, secondary], [0], []);
  });

  it("regenerates on not_satisfied with seen titles and mintPrimary false, then exits on done", async () => {
    h.toTestCases
      .mockResolvedValueOnce([primary, secondary])
      .mockResolvedValueOnce([tertiary]);
    h.awaitCaseSelection
      .mockResolvedValueOnce({ action: "not_satisfied", selectedIndexes: [0], newPrompt: "also test empty fields" })
      .mockResolvedValueOnce({ action: "done", selectedIndexes: [0] });
    h.appendAcceptedCases.mockReturnValue({ accepted: [primary], overflow: [], overflowIndexes: [] });
    h.getAllAcceptedCases.mockReturnValue([primary]);
    h.hasAcceptedPrimary.mockReturnValue(true);

    const { finalCases } = await runCaseSelectionGate({ runId: "r2", plan, appModel, sourcePrompt: "test login" });

    expect(finalCases).toEqual([primary]);
    expect(h.toTestCases).toHaveBeenCalledTimes(2);
    expect(h.toTestCases).toHaveBeenNthCalledWith(2, plan, appModel, {
      existingTitles: [primary.title],
      mintPrimary: false,
    });
  });

  it("stops regenerating once the regen budget is spent", async () => {
    h.toTestCases.mockResolvedValue([primary, secondary]);
    h.awaitCaseSelection.mockResolvedValue({ action: "not_satisfied", selectedIndexes: [0], newPrompt: "keep going" });
    h.appendAcceptedCases.mockReturnValue({ accepted: [primary], overflow: [], overflowIndexes: [] });
    h.getAllAcceptedCases.mockReturnValue([primary]);
    h.hasAcceptedPrimary.mockReturnValue(true);

    const { finalCases } = await runCaseSelectionGate({ runId: "r3", plan, appModel, sourcePrompt: "test login" });

    expect(finalCases).toEqual([primary]);
    expect(h.toTestCases).toHaveBeenCalledTimes(MAX_CASE_REGEN_ATTEMPTS);
    const actions = h.events.map((e) => e.data.action);
    expect(actions).toContain("case_regen_limit_reached");
  });

  it("stops early when the pool has no remaining capacity", async () => {
    h.toTestCases.mockResolvedValue([primary, secondary]);
    h.awaitCaseSelection.mockResolvedValue({ action: "not_satisfied", selectedIndexes: [0], newPrompt: "more" });
    h.appendAcceptedCases.mockReturnValue({ accepted: [primary], overflow: [secondary], overflowIndexes: [1] });
    h.getAllAcceptedCases.mockReturnValue([primary]);
    h.hasAcceptedPrimary.mockReturnValue(true);
    h.remainingCapacity.mockReturnValue(0);

    const { finalCases } = await runCaseSelectionGate({ runId: "r4", plan, appModel, sourcePrompt: "test login" });

    expect(finalCases).toEqual([primary]);
    expect(h.toTestCases).toHaveBeenCalledTimes(1);
    const actions = h.events.map((e) => e.data.action);
    expect(actions).toContain("case_pool_cap_warning");
  });

  it("throws when the user ends with no cases accepted", async () => {
    h.toTestCases.mockResolvedValue([primary, secondary]);
    h.awaitCaseSelection.mockResolvedValue({ action: "done", selectedIndexes: [] });
    h.appendAcceptedCases.mockReturnValue({ accepted: [], overflow: [], overflowIndexes: [] });
    h.getAllAcceptedCases.mockReturnValue([]);

    await expect(runCaseSelectionGate({ runId: "r5", plan, appModel, sourcePrompt: "test login" }))
      .rejects.toThrow(/No test cases were selected/);
  });

  it("throws when cases are accepted but no primary is among them", async () => {
    h.toTestCases.mockResolvedValue([secondary, tertiary]);
    h.awaitCaseSelection.mockResolvedValue({ action: "done", selectedIndexes: [0] });
    h.appendAcceptedCases.mockReturnValue({ accepted: [secondary], overflow: [], overflowIndexes: [] });
    h.getAllAcceptedCases.mockReturnValue([secondary]);
    h.hasAcceptedPrimary.mockReturnValue(false);

    await expect(runCaseSelectionGate({ runId: "r6", plan, appModel, sourcePrompt: "test login" }))
      .rejects.toThrow(/No primary case accepted/);
  });

  it("emits all five event actions across a full regen + cap run", async () => {
    h.toTestCases.mockResolvedValue([primary, secondary]);
    h.awaitCaseSelection.mockResolvedValue({ action: "not_satisfied", selectedIndexes: [0], newPrompt: "more" });
    h.appendAcceptedCases.mockReturnValue({ accepted: [primary], overflow: [], overflowIndexes: [] });
    h.getAllAcceptedCases.mockReturnValue([primary]);
    h.hasAcceptedPrimary.mockReturnValue(true);
    h.remainingCapacity
      .mockReturnValueOnce(5)
      .mockReturnValueOnce(5)
      .mockReturnValueOnce(0);

    await runCaseSelectionGate({ runId: "r7", plan, appModel, sourcePrompt: "test login" });

    const actions = h.events.map((e) => e.data.action);
    expect(actions).toContain("case_round_requested");
    expect(actions).toContain("case_round_resolved");
    expect(actions).toContain("case_pool_cap_warning");
    expect(actions).toContain("case_regen_limit_reached");
    expect(actions).toContain("case_selection_finalized");
  });
});
