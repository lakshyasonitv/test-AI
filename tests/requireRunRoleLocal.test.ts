import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { requireRunRole } from "../src/server/authz.js";
import { DEFAULT_ORG_ID } from "../src/db.js";

/**
 * Session 102 (2026-10-24): with AUTH_ENABLED off, `requireRunRole` set only the role, so
 * POST /api/runs/:runId/cases/:caseId/save handed `undefined` to the library as the organisation
 * and Supabase answered `invalid input syntax for type uuid: "undefined"`. The local owner acts
 * within the same organisation `requireRole` resolves, so the run routes must say so too.
 */
describe("requireRunRole without tenancy enforcement", () => {
  const saved = { AUTH_ENABLED: process.env.AUTH_ENABLED, DB_ENABLED: process.env.DB_ENABLED };
  beforeEach(() => { delete process.env.AUTH_ENABLED; delete process.env.DB_ENABLED; });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  });

  it("sets the local organisation on the request, not only the role", async () => {
    const req: any = { params: { runId: "zq-run" } };
    let passed = false;
    await requireRunRole("tester")(req, {} as any, () => { passed = true; });
    expect(passed).toBe(true);
    expect(req.organisationRole).toBe("owner");
    expect(req.organisationId).toBe(DEFAULT_ORG_ID);
  });
});
