import { describe, it, expect, vi, afterEach } from "vitest";
import { rmSync, readFileSync } from "node:fs";
import path from "node:path";

const { toTestCasesMock, planMock, discoverSiteHybridMock, discoverPagesHybridMock } = vi.hoisted(() => ({
  toTestCasesMock: vi.fn(), planMock: vi.fn(),
  discoverSiteHybridMock: vi.fn(), discoverPagesHybridMock: vi.fn(),
}));

vi.mock("../src/stages/testCases.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/stages/testCases.js")>();
  return { ...actual, toTestCases: toTestCasesMock };
});
vi.mock("../src/stages/planner.js", () => ({ plan: planMock }));
vi.mock("../src/stages/hybridDiscovery.js", () => ({
  discoverSiteHybrid: discoverSiteHybridMock,
  discoverPagesHybrid: discoverPagesHybridMock,
}));

const { runPipeline } = await import("../src/orchestrator.js");
const { NoTestCasesError } = await import("../src/stages/testCases.js");

const RUN_ID = "test-run-noTestCases";
const URL = "https://no-cases.example";
const PLAN = { goal: "g", steps: ["log in"], testTypeScope: ["functional"], coverage: "standard" };
const APPMODEL = { baseUrl: URL, pages: [{ url: URL, title: "Home", concepts: [], elements: [] }] };

describe("orchestrator NoTestCasesError path", () => {
  afterEach(() => {
    rmSync(path.join("runs", RUN_ID), { recursive: true, force: true });
    toTestCasesMock.mockReset(); planMock.mockReset(); discoverSiteHybridMock.mockReset(); discoverPagesHybridMock.mockReset();
  });

  it("writes 03-cases-raw.txt and emits a testcases failed event, then rethrows", async () => {
    planMock.mockResolvedValueOnce(PLAN);
    discoverSiteHybridMock.mockResolvedValueOnce(APPMODEL);
    const cause = new NoTestCasesError("gemini", "gemini-3.6-flash", "[\n  {\"title\":\"half a case\"\n");
    toTestCasesMock.mockRejectedValueOnce(cause);

    const events: any[] = [];
    await expect(
      runPipeline({ prompt: "test the login", url: URL, coverage: "standard" }, (e) => events.push(e), RUN_ID)
    ).rejects.toBe(cause);

    // The full raw response is on disk next to the stage artifact.
    expect(readFileSync(path.join("runs", RUN_ID, "03-cases-raw.txt"), "utf8")).toBe(
      "[\n  {\"title\":\"half a case\"\n",
    );

    // step() already emitted the failed event with the plain-English message — no second
    // translation inside the catch.
    const failed = events.filter((e) => e.stage === "testcases" && e.status === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].error).toBe("The model returned no usable test cases. Raw response saved.");

    // The failure must NOT descend into the legit no_cases_selected outcome (which is only for
    // a gate round timing out) — so no 'done' event with that status ever fires.
    expect(events.some((e) => e.stage === "done")).toBe(false);
  });
});