import { describe, it, expect } from "vitest";
import request from "supertest";
import { app } from "../src/server/index.js";

// Characterization tests for src/server/index.ts's public HTTP contract.
//
// These pin down the CURRENT shape of every existing route's response, so that a later phase
// (auth, tenancy, the library CRUD routes, etc.) can't accidentally rename/remove/reorder a field
// `public/app.js` depends on without a test failing here first — see implentationplan.md's Rule 2
// and Step 0.3. Nothing here exercises a route that would trigger a real Gemini call or spend
// money (POST /api/runs's success path is intentionally NOT tested here).
//
// A valid-shaped-but-nonexistent runId, so these never depend on (or mutate) real data under
// runs/.
const FAKE_RUN_ID = "2000-01-01T00-00-00-000Z-deadbeef";

describe("API contract — POST /api/runs", () => {
  it("400s with no prompt and no url", async () => {
    const res = await request(app).post("/api/runs").send({});
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("400s with a prompt but no url/urls", async () => {
    const res = await request(app).post("/api/runs").send({ prompt: "test something" });
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("400s on an invalid coverage value", async () => {
    const res = await request(app)
      .post("/api/runs")
      .send({ prompt: "test something", url: "https://example.com", coverage: "extreme" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/coverage/i);
  });
});

describe("API contract — GET /api/runs", () => {
  it("returns an array whose items match the current RunSummary shape", async () => {
    const res = await request(app).get("/api/runs");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);

    if (res.body.length === 0) return; // shape can't be checked against an empty history

    const KNOWN_STATUSES = ["passed", "failed", "error", "incomplete", "truncated_no_assertion"];
    const item = res.body[0];
    expect(typeof item.runId).toBe("string");
    expect(typeof item.url).toBe("string");
    expect(typeof item.prompt).toBe("string");
    expect(KNOWN_STATUSES).toContain(item.status);
    expect(typeof item.startedAt).toBe("number");
    expect(typeof item.hasEvents).toBe("boolean");
    if (item.suite !== undefined) {
      expect(typeof item.suite.total).toBe("number");
      expect(typeof item.suite.passed).toBe("number");
      expect(typeof item.suite.failed).toBe("number");
      expect(Array.isArray(item.suite.cases)).toBe(true);
    }
  });
});

describe("API contract — GET /api/runs/:runId/state", () => {
  it("400s on a malformed runId", async () => {
    const res = await request(app).get("/api/runs/not-a-real-run-id/state");
    expect(res.status).toBe(400);
    expect(res.body).toHaveProperty("error");
  });

  it("200s with an empty array for a validly-shaped but nonexistent runId", async () => {
    const res = await request(app).get(`/api/runs/${FAKE_RUN_ID}/state`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});

describe("API contract — GET /api/health", () => {
  it("returns the exact current top-level shape", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");

    const envKeys = ["GEMINI_API_KEYS", "GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_MODEL_LITE", "NODE_ENV", "PORT"];
    for (const key of envKeys) {
      expect(typeof res.body.env[key].set).toBe("boolean");
      expect(typeof res.body.env[key].length).toBe("number");
    }

    expect(typeof res.body.defaults.gateReview).toBe("boolean");
    expect(typeof res.body.defaults.selfHeal).toBe("boolean");
  });
});

describe("API contract — GET /runs/:runId/* (artifact serving)", () => {
  it("403s on a path-traversal attempt", async () => {
    const res = await request(app).get(`/runs/${FAKE_RUN_ID}/../../../../../../etc/passwd`);
    // supertest/superagent normalizes ".." segments in the URL before the request is sent, same
    // as a real browser would — so this also doubles as confirming the guard survives an
    // encoded attempt, which does reach the server unnormalized.
    expect([403, 404]).toContain(res.status);
  });

  it("403s on an encoded path-traversal attempt", async () => {
    const res = await request(app).get(`/runs/${FAKE_RUN_ID}/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd`);
    expect(res.status).toBe(403);
  });

  it("404s for a nonexistent file under a validly-shaped runId", async () => {
    const res = await request(app).get(`/runs/${FAKE_RUN_ID}/nonexistent-file.json`);
    expect(res.status).toBe(404);
  });
});
