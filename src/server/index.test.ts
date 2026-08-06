import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { app } from "./index.js";
import { awaitCaseSelection, resolveCaseSelection } from "./pendingCaseSelection.js";
import type { TestCase } from "../stages/testCases.js";

const batch = [
  { id: "c1", priority: "medium", feature: "Login", title: "Log in with valid credentials", steps: ["s"], expected: "ok", fromPrompt: true, category: "valid", generatedFrom: "upfront" },
  { id: "c2", priority: "high", feature: "Login", title: "Login with wrong password", steps: ["s"], expected: "ok", fromPrompt: false, category: "invalid-input", generatedFrom: "upfront" },
] as unknown as TestCase[];

const parked: string[] = [];

function newRunId(): string {
  const id = "__test-" + randomUUID();
  parked.push(id);
  return id;
}

afterEach(() => {
  for (const runId of parked) resolveCaseSelection(runId, { action: "done", selectedIndexes: [] });
  parked.length = 0;
});

describe("case-selection API routes", () => {
  let server: ReturnType<typeof createServer>;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())));
  });

  const post = (runId: string, body: unknown) =>
    fetch(`${baseUrl}/api/runs/${runId}/case-selection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("POST with no pending selection returns 409", async () => {
    const res = await post(newRunId(), { action: "done", selectedIndexes: [0] });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "No case-selection round is pending for this run" });
  });

  it("POST with an invalid body returns 400", async () => {
    const runId = newRunId();
    awaitCaseSelection(runId, batch, 1);
    const res = await post(runId, { action: "done", selectedIndexes: ["0"] });
    expect(res.status).toBe(400);
  });

  it("POST done with an empty selection and empty pool returns 400", async () => {
    const runId = newRunId();
    awaitCaseSelection(runId, batch, 1);
    const res = await post(runId, { action: "done", selectedIndexes: [] });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Select at least one case before clicking Done" });
  });

  it("POST valid done resolves the pending promise", async () => {
    const runId = newRunId();
    const decisionPromise = awaitCaseSelection(runId, batch, 1);

    const res = await post(runId, { action: "done", selectedIndexes: [0] });
    expect(res.status).toBe(200);

    const resolved = await decisionPromise;
    expect(resolved).toEqual({ action: "done", selectedIndexes: [0] });
  });

  it("POST valid not_satisfied resolves the pending promise", async () => {
    const runId = newRunId();
    const decisionPromise = awaitCaseSelection(runId, batch, 1);

    const res = await post(runId, {
      action: "not_satisfied",
      selectedIndexes: [],
      newPrompt: "Add a case for an empty password field.",
    });
    expect(res.status).toBe(200);

    const resolved = await decisionPromise;
    expect(resolved).toEqual({
      action: "not_satisfied",
      selectedIndexes: [],
      newPrompt: "Add a case for an empty password field.",
    });
  });

  it("GET accepted-cases for an empty pool returns zeroes", async () => {
    const res = await fetch(`${baseUrl}/api/runs/${newRunId()}/accepted-cases`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      cases: [],
      count: 0,
      cap: Number(process.env.MAX_ACCUMULATED_CASES ?? 5),
      remainingCapacity: Number(process.env.MAX_ACCUMULATED_CASES ?? 5),
    });
  });

  it("GET case-selection-status with no pending round returns 404", async () => {
    const res = await fetch(`${baseUrl}/api/runs/${newRunId()}/case-selection-status`);
    expect(res.status).toBe(404);
  });

  it("GET case-selection-status with a pending round returns attempt and batch", async () => {
    const runId = newRunId();
    awaitCaseSelection(runId, batch, 2);

    const res = await fetch(`${baseUrl}/api/runs/${runId}/case-selection-status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attempt).toBe(2);
    expect(body.batch).toEqual(batch);
    expect(body.acceptedCount).toBe(0);
    expect(body.cap).toBe(Number(process.env.MAX_ACCUMULATED_CASES ?? 5));
  });
});
