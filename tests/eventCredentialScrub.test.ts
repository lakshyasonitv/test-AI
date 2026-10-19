import { describe, it, expect, vi, afterEach } from "vitest";
import { rmSync, readFileSync } from "node:fs";
import path from "node:path";

// TD-154. A real SauceDemo run (2026-10-18T17-22-54-631Z-7e5d7867) wrote the user's real password
// into events.ndjson: the `testcases`/`completed` event carries EVERY candidate case the model
// wrote, and two of them typed the literal value it had read off the login page ("Password for
// all users: ..."). The kept cases in 03-cases.json were clean; the event log was not, and it is
// served by /runs/ and /api/runs/:id/state. These tests drive the real orchestrator with only the
// LLM-backed stages stubbed, and check every place an event leaves the process.

const { toTestCasesMock, planMock, discoverSiteHybridMock, discoverPagesHybridMock, toIRMock } = vi.hoisted(() => ({
  toTestCasesMock: vi.fn(), planMock: vi.fn(),
  discoverSiteHybridMock: vi.fn(), discoverPagesHybridMock: vi.fn(), toIRMock: vi.fn(),
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
vi.mock("../src/stages/ir.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/stages/ir.js")>();
  return { ...actual, toIR: toIRMock };
});

const { runPipeline } = await import("../src/orchestrator.js");
const { askCredentials, settle } = await import("../src/server/pendingCredentials.js");
const { getEvents, subscribe, record } = await import("../src/server/runRegistry.js");

const URL = "https://login-page-shows-password.example";
// A canary, not a real credential: long enough for redactCredentials and not a DOM keyword.
const USER = "canary_user_7f3a";
const PASS = "canary_pass_9c1e";
const PLAN = { goal: "g", steps: ["log in", "check out"], testTypeScope: ["functional"], coverage: "standard" };
// The page itself prints the password, which is how the model came to know it on SauceDemo.
const APPMODEL = {
  baseUrl: URL,
  pages: [{
    url: URL, title: "Login", concepts: ["login"], elements: [],
    markdown: `Accepted usernames are: ${USER}\nPassword for all users: ${PASS}`,
  }],
};
const caseTyping = (title: string, value: string) => ({
  title, priority: "medium", feature: "Login", category: "empty-boundary",
  steps: [`Go to the '${URL}' page.`, "Leave the 'Username' field empty.",
    `Type the text '${value}' into the 'Password' field.`, "Click the 'Login' button."],
  expected: "An error message is shown.", fromPrompt: false, targetUrl: URL,
});
// Candidates: the first is the kept primary; the second is a generated-but-not-kept style case
// that typed the literal password, exactly as the real run's candidate pool did.
const CASES = [
  caseTyping("Complete purchase as the standard user", "the standard user's password"),
  caseTyping("Submit login with empty username", PASS),
];

function fakeSseResponse() {
  const written: string[] = [];
  const res: any = { writeHead: () => res, write: (s: string) => { written.push(s); return true; }, on: () => res };
  return { res, written };
}

async function runUntilIr(runId: string, prompt: string, answer: boolean) {
  planMock.mockResolvedValueOnce(PLAN);
  discoverSiteHybridMock.mockImplementationOnce(async (_url: string, _creds: unknown, ask?: () => Promise<unknown>) => {
    if (answer && ask) await ask();
    return APPMODEL;
  });
  toTestCasesMock.mockResolvedValueOnce(CASES);
  // Stop the run right after the cases: the leak happens before the IR stage.
  toIRMock.mockRejectedValueOnce(new Error("stop after testcases"));

  const sse = fakeSseResponse();
  subscribe(runId, sse.res);
  const onEvent = (e: any) => {
    record(e);
    // Answer the in-run credential prompt the way POST /api/runs/:runId/credentials does.
    if (answer && e.stage === "credentials" && e.status === "started") {
      setTimeout(() => settle(runId, { username: USER, password: PASS, secret: true }), 0);
    }
  };
  await expect(runPipeline({ prompt, url: URL, coverage: "standard" }, onEvent, runId, askCredentials))
    .rejects.toThrow("stop after testcases");
  return sse.written.join("");
}

describe("TD-154: no event carries the run's credentials", () => {
  const ids: string[] = [];
  afterEach(() => {
    for (const id of ids.splice(0)) rmSync(path.join("runs", id), { recursive: true, force: true });
    toTestCasesMock.mockReset(); planMock.mockReset(); toIRMock.mockReset();
    discoverSiteHybridMock.mockReset(); discoverPagesHybridMock.mockReset();
  });

  it("credentials typed into the run's prompt form are scrubbed from events.ndjson, /state and live SSE", async () => {
    const runId = "test-run-eventScrub-asked";
    ids.push(runId);
    const live = await runUntilIr(runId, "log in and check out", true);

    const onDisk = readFileSync(path.join("runs", runId, "events.ndjson"), "utf8");
    const state = JSON.stringify(getEvents(runId)); // exactly what GET /api/runs/:runId/state returns
    for (const [where, text] of [["events.ndjson", onDisk], ["/state", state], ["live SSE", live]] as const) {
      expect(text.includes(PASS), `${where} carries the password`).toBe(false);
      expect(text.includes(USER), `${where} carries the username`).toBe(false);
    }

    // TD-156: the saved cases file is model text too, and is scrubbed the same way.
    expect(readFileSync(path.join("runs", runId, "03-cases.json"), "utf8").includes(PASS)).toBe(false);

    // Only the value changes: the candidate case and its step are still there, with the placeholder.
    const casesEvent = getEvents(runId).find((e) => e.stage === "testcases" && e.status === "completed");
    const leaked = (casesEvent?.data as any[]).find((c) => c.title === "Submit login with empty username");
    expect(leaked.steps[2]).toBe("Type the text '[redacted]' into the 'Password' field.");
  });

  it("credentials written into the request itself are scrubbed from the events too", async () => {
    const runId = "test-run-eventScrub-prompt";
    ids.push(runId);
    await runUntilIr(runId, `log in with user: ${USER} password: ${PASS} and check out`, false);

    const onDisk = readFileSync(path.join("runs", runId, "events.ndjson"), "utf8");
    expect(onDisk.includes(PASS)).toBe(false);
    expect(JSON.stringify(getEvents(runId)).includes(PASS)).toBe(false);
  });

  it("a run with no credentials is written exactly as before", async () => {
    const runId = "test-run-eventScrub-none";
    ids.push(runId);
    await runUntilIr(runId, "log in and check out", false);

    // Nothing to scrub: the page-printed value is not a credential this run was given.
    const casesEvent = getEvents(runId).find((e) => e.stage === "testcases" && e.status === "completed");
    expect(JSON.stringify(casesEvent?.data)).toBe(JSON.stringify(CASES));
  });
});
