import { describe, it, expect, afterEach, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/server/index.js";
import { invalidateMemberships } from "../src/server/authz.js";

/**
 * These characterise the DEFAULT configuration — auth off, database off — so they pin the flag-off
 * contract explicitly rather than inheriting whatever the process happens to have.
 *
 * That inheritance was a real, reproducible flake. Several test files set `AUTH_ENABLED=true` and
 * `DB_ENABLED=true` at module top level and never restore them; vitest can run more than one file
 * in the same worker process, and `process.env` is per-process. When one of those files ran first,
 * `canEnforceTenancy()` was true here, `/api/runs` tried to resolve run ownership against a
 * Supabase client that this file does not mock, and the assertion below saw 500 instead of 200 —
 * on a different test each run, which is the signature of a scheduling-order bug rather than a
 * code one. Pinning the flags per test makes this file independent of what ran before it.
 */
beforeEach(() => {
  delete process.env.AUTH_ENABLED;
  delete process.env.DB_ENABLED;
  invalidateMemberships();
});

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

  // Step 2.2 appended `authEnabled`. Asserted ADDITIVELY — the block above still pins every
  // pre-existing field exactly as it was, and this only adds a new expectation rather than
  // rewriting the shape as a closed set. A future additive field must not fail these tests.
  it("also reports authEnabled (additive, Step 2.2)", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(typeof res.body.authEnabled).toBe("boolean");
  });
});

// Step 2.1. These flip AUTH_ENABLED at runtime rather than at import, which is why auth.ts reads
// process.env per-request instead of caching the flag at module load.
describe("auth — AUTH_ENABLED gate (Step 2.1)", () => {
  const original = process.env.AUTH_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.AUTH_ENABLED;
    else process.env.AUTH_ENABLED = original;
  });

  it("with the flag off, /api/runs is reachable without any credential (today's behavior)", async () => {
    delete process.env.AUTH_ENABLED;
    const res = await request(app).get("/api/runs");
    expect(res.status).toBe(200);
  });

  it("with the flag on, an unauthenticated /api/runs is 401", async () => {
    process.env.AUTH_ENABLED = "true";
    const res = await request(app).get("/api/runs");
    expect(res.status).toBe(401);
    expect(res.body).toHaveProperty("error");
  });

  it("with the flag on, /api/health stays public and self-reports authEnabled:true", async () => {
    process.env.AUTH_ENABLED = "true";
    const res = await request(app).get("/api/health");
    // Must stay reachable: the login UI reads this to discover auth is on, before it can
    // possibly hold a token.
    expect(res.status).toBe(200);
    expect(res.body.authEnabled).toBe(true);
  });

  it("with the flag on, an unauthenticated artifact request is 403", async () => {
    process.env.AUTH_ENABLED = "true";
    const res = await request(app).get(`/runs/${FAKE_RUN_ID}/00-input.json`);
    expect(res.status).toBe(403);
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
