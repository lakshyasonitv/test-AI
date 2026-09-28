import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { app } from "../src/server/index.js";
import { invalidateMemberships } from "../src/server/authz.js";
import { SUPPORTED_RUN_LOCALES } from "../src/browserLaunch.js";

/**
 * `POST /api/runs` gaining an optional `options.locale` — additively.
 *
 * NOTHING HERE STARTS A RUN. Every request below is one the route rejects before `makeRunId()`,
 * exactly as `tests/apiContract.test.ts` does for coverage: a run costs real Gemini calls and
 * drives a browser, so the success path is deliberately untested here too.
 *
 * Flags are pinned per test for the reason apiContract.test.ts records — several files set
 * AUTH_ENABLED/DB_ENABLED at module scope and never restore them, vitest can share a worker, and
 * the symptom is a different test failing each run.
 */

beforeEach(() => {
  delete process.env.AUTH_ENABLED;
  delete process.env.DB_ENABLED;
  invalidateMemberships();
});

const VALID = { prompt: "test the login page", url: "https://example.com" };

describe("POST /api/runs — options.locale is optional and additive", () => {
  it("a body with NO options at all is unaffected by the new check", async () => {
    // Pinned against the old failure: no options, bad coverage -> still the COVERAGE error, not a
    // locale one. This is what "the request shape did not change" means in practice.
    const res = await request(app).post("/api/runs").send({ ...VALID, coverage: "nonsense" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/coverage/i);
    expect(res.body.error).not.toMatch(/locale/i);
  });

  it("an options object without `locale` is unaffected", async () => {
    const res = await request(app)
      .post("/api/runs")
      .send({ ...VALID, coverage: "nonsense", options: { gateReview: true, selfHeal: false } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/coverage/i);
  });

  it("the pre-existing validations still fire first and unchanged", async () => {
    const noPrompt = await request(app).post("/api/runs").send({});
    expect(noPrompt.status).toBe(400);
    expect(noPrompt.body).toHaveProperty("error");

    const noUrl = await request(app).post("/api/runs").send({ prompt: "x" });
    expect(noUrl.status).toBe(400);
    expect(noUrl.body).toHaveProperty("error");
  });
});

describe("POST /api/runs — an invalid locale is rejected, never forwarded", () => {
  it("400s and names the field", async () => {
    const res = await request(app)
      .post("/api/runs")
      .send({ ...VALID, options: { locale: "klingon" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/locale/i);
  });

  it("the error lists what IS accepted, so the caller can fix it", async () => {
    const res = await request(app)
      .post("/api/runs")
      .send({ ...VALID, options: { locale: "klingon" } });
    expect(res.body.error).toContain("en-US");
  });

  it("rejects near-misses rather than coercing them", async () => {
    // "en_US" and "en" are the two most likely typos, and silently accepting either would mean a
    // caller believing they pinned something they did not.
    for (const bad of ["en_US", "en", "EN-US", "en-us", " en-US", "xx-XX"]) {
      const res = await request(app).post("/api/runs").send({ ...VALID, options: { locale: bad } });
      expect(res.status, `locale "${bad}" must be rejected`).toBe(400);
      expect(res.body.error).toMatch(/locale/i);
    }
  });

  it("rejects non-string locales instead of stringifying them", async () => {
    for (const bad of [5, true, null, {}, ["en-US"]]) {
      const res = await request(app).post("/api/runs").send({ ...VALID, options: { locale: bad } });
      expect(res.status, `locale ${JSON.stringify(bad)} must be rejected`).toBe(400);
    }
  });

  it("rejects the locale BEFORE any run is created", async () => {
    // A 400 is the proof: makeRunId() and the pipeline come after this check, so a rejected
    // locale cannot leave a half-created run or spend an LLM call.
    const res = await request(app)
      .post("/api/runs")
      .send({ ...VALID, options: { locale: "klingon" } });
    expect(res.status).toBe(400);
    expect(res.body).not.toHaveProperty("runId");
  });

  it("checks coverage first, so the new check cannot mask an older error", async () => {
    const res = await request(app)
      .post("/api/runs")
      .send({ ...VALID, coverage: "nonsense", options: { locale: "klingon" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/coverage/i);
  });
});

describe("POST /api/runs — a valid locale passes validation", () => {
  it("every advertised tag gets past the locale check", async () => {
    // Proven without starting a run: pair each valid locale with a deliberately invalid coverage
    // and assert the rejection is about COVERAGE. If the locale check were wrong, the error would
    // be about the locale instead.
    for (const tag of SUPPORTED_RUN_LOCALES) {
      const res = await request(app)
        .post("/api/runs")
        .send({ ...VALID, coverage: "nonsense", options: { locale: tag } });
      expect(res.status, `locale "${tag}" must be accepted`).toBe(400);
      expect(res.body.error, `locale "${tag}" must reach the coverage check`).toMatch(/coverage/i);
    }
  });
});
