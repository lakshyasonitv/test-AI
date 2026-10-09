import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from "vitest";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import request from "supertest";

/**
 * `options.targetApp` on POST /api/runs, and the run-scoped rail it feeds (DECISIONS.md D-50).
 *
 * THE RUNS HERE ARE REAL UP TO THE PLANNER. Only `plan()` is replaced: it records what
 * `currentRunTargetApp()` answers from inside the pipeline, then throws — so the route, the
 * orchestrator and the rail all run for real, and nothing reaches Gemini or a browser. That is
 * what proves the value actually arrives where the stages will read it, rather than only that the
 * route accepted it.
 */

const seen: { prompt: string; targetApp: string | null }[] = [];

vi.mock("../src/stages/planner.js", async () => {
  const { currentRunTargetApp } = await import("../src/runTarget.js");
  return {
    plan: async (prompt: string) => {
      seen.push({ prompt, targetApp: currentRunTargetApp() });
      throw new Error("stopped by the test before any LLM call");
    },
  };
});

const { app } = await import("../src/server/index.js");
const { invalidateMemberships } = await import("../src/server/authz.js");
const { getEvents } = await import("../src/server/runRegistry.js");
const { currentRunTargetApp, enterWithTargetApp, isTargetApp, withTargetApp, TARGET_APPS } =
  await import("../src/runTarget.js");

const createdRuns: string[] = [];
let n = 0;
const VALID = () => ({ prompt: `check the home page ${++n}-${Date.now()}`, url: "https://example.com" });

beforeEach(() => {
  delete process.env.AUTH_ENABLED;
  delete process.env.DB_ENABLED;
  delete process.env.SALESFORCE_ENABLED;
  invalidateMemberships();
});

afterEach(async () => {
  for (const id of createdRuns.splice(0)) {
    await waitFor(() => getEvents(id).some((e) => e.stage === "error" || e.status === "failed"));
    rmSync(path.join("runs", id), { recursive: true, force: true });
  }
});

afterAll(() => { delete process.env.SALESFORCE_ENABLED; });

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 20));
  }
}

/** Start a run and return what the pipeline saw for it. */
async function startRun(options?: unknown) {
  const body = { ...VALID(), ...(options === undefined ? {} : { options }) };
  const res = await request(app).post("/api/runs").send(body);
  expect(res.status).toBe(202);
  createdRuns.push(res.body.runId);
  await waitFor(() => seen.some((s) => s.prompt === body.prompt));
  return { runId: res.body.runId as string, saw: seen.find((s) => s.prompt === body.prompt)!.targetApp };
}

const targetFile = (runId: string) => path.join("runs", runId, "00-run-target.json");

describe("runTarget — the rail itself", () => {
  it("is null outside any run", () => {
    expect(currentRunTargetApp()).toBeNull();
  });

  it("withTargetApp scopes the value and leaves nothing behind", async () => {
    const inside = await withTargetApp("salesforce", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return currentRunTargetApp();
    });
    expect(inside).toBe("salesforce");
    expect(currentRunTargetApp()).toBeNull();
  });

  it("two concurrent chains each keep their own value", async () => {
    const [a, b] = await Promise.all([
      withTargetApp("salesforce", async () => { await new Promise((r) => setTimeout(r, 10)); return currentRunTargetApp(); }),
      withTargetApp(null, async () => { await new Promise((r) => setTimeout(r, 5)); return currentRunTargetApp(); }),
    ]);
    expect(a).toBe("salesforce");
    expect(b).toBeNull();
  });

  it("enterWithTargetApp(null) clears an inherited value", async () => {
    await withTargetApp("salesforce", async () => {
      enterWithTargetApp(null);
      expect(currentRunTargetApp()).toBeNull();
    });
  });

  it("the allow-list is exact — no near-misses, no non-strings", () => {
    expect(TARGET_APPS).toEqual(["salesforce"]);
    expect(isTargetApp("salesforce")).toBe(true);
    for (const bad of ["Salesforce", "SALESFORCE", " salesforce", "sfdc", "", true, 1, null, {}, ["salesforce"]]) {
      expect(isTargetApp(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("GET /api/health — advertises target apps only when the flag is on", () => {
  it("flag off: no targetApps key at all", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("targetApps");
  });

  it("flag on: lists exactly the allow-list", async () => {
    process.env.SALESFORCE_ENABLED = "true";
    const res = await request(app).get("/api/health");
    expect(res.body.targetApps).toEqual(["salesforce"]);
  });
});

describe("POST /api/runs — flag OFF: targetApp is ignored, never rejected", () => {
  it("a malformed targetApp still starts the run, as it would have before the field existed", async () => {
    const { runId, saw } = await startRun({ targetApp: "not-an-app" });
    expect(saw).toBeNull();
    expect(existsSync(targetFile(runId))).toBe(false);
  });

  it("even targetApp: \"salesforce\" is ignored — the run is an ordinary web run", async () => {
    const { runId, saw } = await startRun({ targetApp: "salesforce" });
    expect(saw).toBeNull();
    expect(existsSync(targetFile(runId))).toBe(false);
  });

  it("a run with no options at all sees null — the same code path, with no value", async () => {
    const { runId, saw } = await startRun();
    expect(saw).toBeNull();
    expect(existsSync(targetFile(runId))).toBe(false);
  });
});

describe("POST /api/runs — flag ON: validated like coverage and locale", () => {
  beforeEach(() => { process.env.SALESFORCE_ENABLED = "true"; });

  it("rejects anything off the allow-list, naming the field and what IS accepted", async () => {
    for (const bad of ["Salesforce", "sfdc", "", true, 1, {}, ["salesforce"]]) {
      const res = await request(app).post("/api/runs").send({ ...VALID(), options: { targetApp: bad } });
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body.error).toMatch(/targetApp/);
      expect(res.body.error).toContain("salesforce");
      expect(res.body).not.toHaveProperty("runId");
    }
  });

  it("checks coverage first, so the new check cannot mask an older error", async () => {
    const res = await request(app).post("/api/runs")
      .send({ ...VALID(), coverage: "nonsense", options: { targetApp: "sfdc" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/coverage/i);
  });

  it("\"salesforce\" reaches the pipeline through the rail, and is recorded on disk", async () => {
    const { runId, saw } = await startRun({ targetApp: "salesforce" });
    expect(saw).toBe("salesforce");
    expect(JSON.parse(readFileSync(targetFile(runId), "utf8"))).toEqual({ targetApp: "salesforce" });
  });

  it("unticked (no targetApp) is an ordinary run: null in the pipeline, no file", async () => {
    const { runId, saw } = await startRun({ gateReview: false });
    expect(saw).toBeNull();
    expect(existsSync(targetFile(runId))).toBe(false);
  });

  it("null is treated as absent, not rejected", async () => {
    const { runId, saw } = await startRun({ targetApp: null });
    expect(saw).toBeNull();
    expect(existsSync(targetFile(runId))).toBe(false);
  });

  it("two runs at once each see their own target app", async () => {
    const [sf, web] = await Promise.all([startRun({ targetApp: "salesforce" }), startRun({})]);
    expect(sf.saw).toBe("salesforce");
    expect(web.saw).toBeNull();
  });
});
