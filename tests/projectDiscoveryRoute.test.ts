import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";

/**
 * D-72 — what POST /api/runs hands the pipeline for a project's shared discovery. The pipeline is
 * mocked: nothing runs, nothing is spent.
 */

const { runPipelineMock } = vi.hoisted(() => ({
  runPipelineMock: vi.fn(async () => ({ runId: "x", runDir: "x", result: null, diagnosis: null })),
}));
vi.mock("../src/orchestrator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/orchestrator.js")>()),
  runPipeline: runPipelineMock,
}));

const { app } = await import("../src/server/index.js");
const { invalidateMemberships } = await import("../src/server/authz.js");

beforeEach(() => {
  delete process.env.AUTH_ENABLED;
  delete process.env.DB_ENABLED;
  delete process.env.PROJECT_DISCOVERY_SHARING;
  invalidateMemberships();
  runPipelineMock.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.PROJECT_DISCOVERY_SHARING;
  vi.restoreAllMocks();
});

async function startRun(options?: unknown) {
  const res = await request(app).post("/api/runs")
    .send({ prompt: "check the home page", url: "https://example.com", ...(options ? { options } : {}) });
  expect(res.status).toBeLessThan(300);
  await vi.waitFor(() => expect(runPipelineMock).toHaveBeenCalledTimes(1));
  return (runPipelineMock.mock.calls[0] as any[])[0].options;
}

describe("flag off — exactly as before", () => {
  it("no discoveryScope, freshDiscovery ignored, health has no projectDiscovery field", async () => {
    const opts = await startRun({ freshDiscovery: true });
    expect(opts).not.toHaveProperty("discoveryScope");
    expect(opts).not.toHaveProperty("freshDiscovery");
    expect((await request(app).get("/api/health")).body).not.toHaveProperty("projectDiscovery");
  });
});

describe("flag on", () => {
  beforeEach(() => { process.env.PROJECT_DISCOVERY_SHARING = "true"; });

  it("the run carries its organisation (from the session) as the discovery scope", async () => {
    const opts = await startRun();
    expect(opts.discoveryScope).toBeTruthy();
    expect(typeof opts.discoveryScope.organisationId).toBe("string");
    expect(opts.discoveryScope).toHaveProperty("projectId");
  });

  it("a projectId in the body that the caller cannot see is not used as the scope", async () => {
    const res = await request(app).post("/api/runs")
      .send({ prompt: "p", url: "https://example.com", projectId: "someone-elses-project" });
    expect(res.status).toBeLessThan(300);
    await vi.waitFor(() => expect(runPipelineMock).toHaveBeenCalledTimes(1));
    const opts = (runPipelineMock.mock.calls[0] as any[])[0].options;
    expect(opts.discoveryScope.projectId).not.toBe("someone-elses-project");
  });

  it("'Explore the site again' is forwarded only as a boolean", async () => {
    expect((await startRun({ freshDiscovery: true })).freshDiscovery).toBe(true);
    runPipelineMock.mockClear();
    expect(await startRun({ freshDiscovery: "yes" })).not.toHaveProperty("freshDiscovery");
  });

  it("health says projectDiscovery: true", async () => {
    expect((await request(app).get("/api/health")).body.projectDiscovery).toBe(true);
  });
});
