import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import request from "supertest";
import { readFileSync, readdirSync, statSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/**
 * Pro document intake, stage 3: the routes, the flag, and options.spec on POST /api/runs
 * (Pro tests 4, 5 and 15).
 *
 * `gemini()` is mocked — nothing here spends money. `runPipeline` is mocked so a run request can
 * be observed reaching the pipeline (and with exactly which options) without starting a browser.
 * SPEC_INTAKE_ENABLED is set per test and restored; AUTH/DB are pinned off for the reason
 * runLocaleRoute.test.ts records (several files set them at module scope and vitest shares workers).
 */

const { geminiMock, runPipelineMock } = vi.hoisted(() => ({
  geminiMock: vi.fn(),
  runPipelineMock: vi.fn(async () => ({ runId: "x", runDir: "x", result: null, diagnosis: null })),
}));
vi.mock("../src/llm/gemini.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/llm/gemini.js")>()),
  gemini: geminiMock,
}));
vi.mock("../src/orchestrator.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/orchestrator.js")>()),
  runPipeline: runPipelineMock,
}));

const { app } = await import("../src/server/index.js");
const { invalidateMemberships } = await import("../src/server/authz.js");
const { setRunSpecWarnings, SPEC_WARNINGS, DISTILL_FAILED_WARNING } = await import("../src/stages/specIntake.js");

const RUN_ID = "2026-10-13T00-00-00-000Z-5bec0001";
const GOOD_SPEC = {
  actors: ["Sales Manager"], entities: ["Lead"], actions: ["Convert a Lead"],
  rules: ["A Lead cannot convert without a phone number."], criteria: [], outOfScope: ["Refunds"],
  unresolved: ["Which currency are the thresholds in?"], answers: [],
};
const modelAnswer = (o: object) => ({
  content: JSON.stringify(o), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
});

// Successful uploads write a real distilled spec into runs/_cache/spec — the production path, left
// unmocked so test 15 checks the real disk. Whatever a test adds there is removed after it, so a
// developer's own cache never accumulates test entries.
const SPEC_CACHE_DIR = path.join("runs", "_cache", "spec");
const cacheFiles = () => (existsSync(SPEC_CACHE_DIR) ? readdirSync(SPEC_CACHE_DIR) : []);
let cacheBefore = new Set<string>();

let savedFlag: string | undefined;
beforeEach(() => {
  cacheBefore = new Set(cacheFiles());
  savedFlag = process.env.SPEC_INTAKE_ENABLED;
  delete process.env.SPEC_INTAKE_ENABLED;
  delete process.env.AUTH_ENABLED;
  delete process.env.DB_ENABLED;
  invalidateMemberships();
  geminiMock.mockReset();
  runPipelineMock.mockClear();
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  for (const f of cacheFiles()) if (!cacheBefore.has(f)) rmSync(path.join(SPEC_CACHE_DIR, f), { force: true });
  if (savedFlag === undefined) delete process.env.SPEC_INTAKE_ENABLED;
  else process.env.SPEC_INTAKE_ENABLED = savedFlag;
  vi.restoreAllMocks();
});
const flagOn = () => { process.env.SPEC_INTAKE_ENABLED = "true"; };

const upload = (bytes: Buffer, name: string) =>
  request(app).post(`/api/spec/upload?name=${encodeURIComponent(name)}`)
    .set("Content-Type", "application/octet-stream").send(bytes);

/** Let the route's fire-and-forget run start reach runPipeline. */
async function startRun(options: unknown) {
  const res = await request(app).post("/api/runs")
    .send({ prompt: "convert a lead", url: "https://example.com", options });
  expect(res.status).toBeLessThan(300);
  await vi.waitFor(() => expect(runPipelineMock).toHaveBeenCalledTimes(1));
  return (runPipelineMock.mock.calls[0] as any[])[0].options;
}

// ---------------------------------------------------------------------------------------------

describe("flag OFF — the server behaves exactly as before Pro existed (test 4)", () => {
  it("/api/health carries no specIntake field at all", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty("specIntake");
  });

  it("the served home page is byte-identical with the flag on and off — the Pro control is never in the HTML", async () => {
    const off = (await request(app).get("/")).text;
    flagOn();
    const on = (await request(app).get("/")).text;
    expect(off).toBe(on);
    expect(off).toBe(readFileSync(path.join("public", "index.html"), "utf8"));
  });

  it("POST /api/spec/upload, POST /api/spec/confirm and GET spec-warnings all 403", async () => {
    expect((await upload(Buffer.from("# x\nrule"), "a.md")).status).toBe(403);
    expect((await request(app).post("/api/spec/confirm").send({ spec: GOOD_SPEC })).status).toBe(403);
    expect((await request(app).get(`/api/runs/${RUN_ID}/spec-warnings`)).status).toBe(403);
    expect(geminiMock).not.toHaveBeenCalled();
  });

  it("a run carrying options.spec reaches the pipeline as if the field were not there", async () => {
    const opts = await startRun({ gateReview: false, spec: GOOD_SPEC });
    expect(opts).not.toHaveProperty("spec");
    expect(opts).toMatchObject({ gateReview: false });
  });
});

describe("routes are mounted in BOTH flag states (test 5)", () => {
  const mounted = async (flag: string | undefined) => {
    vi.resetModules();
    if (flag === undefined) delete process.env.SPEC_INTAKE_ENABLED; else process.env.SPEC_INTAKE_ENABLED = flag;
    const fresh = (await import("../src/server/index.js")).app as any;
    const out: string[] = [];
    for (const layer of fresh._router.stack) {
      const p = layer.route?.path;
      if (typeof p !== "string") continue;
      for (const m of Object.keys(layer.route.methods)) out.push(`${m.toUpperCase()} ${p}`);
    }
    return out;
  };

  it("the mounted route list is identical whether the flag is on or off", async () => {
    const off = await mounted(undefined);
    const on = await mounted("true");
    expect(off.length).toBeGreaterThan(20); // the table was actually read
    expect(on).toEqual(off);
    for (const r of ["POST /api/spec/upload", "POST /api/spec/confirm", "GET /api/runs/:runId/spec-warnings"]) {
      expect(off).toContain(r);
    }
  });
});

// ---------------------------------------------------------------------------------------------

describe("flag ON — POST /api/spec/upload", () => {
  it("advertises itself on /api/health", async () => {
    flagOn();
    expect((await request(app).get("/api/health")).body.specIntake).toBe(true);
  });

  it("distils an accepted document and returns the spec to the caller", async () => {
    flagOn();
    geminiMock.mockResolvedValueOnce(modelAnswer(GOOD_SPEC));
    const md = Buffer.from(`# Leads ${randomUUID()}\nA Lead cannot convert without a phone number.\n`);
    const res = await upload(md, "spec.md");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, warnings: [], cached: false });
    expect(res.body.spec.rules).toEqual(GOOD_SPEC.rules);
    expect(res.body.spec.answers).toEqual([]);
  });

  it("a rejected document is HTTP 200 with one plain warning — and never reaches the model", async () => {
    flagOn();
    const res = await upload(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), "old.doc");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, warnings: [SPEC_WARNINGS.oldDoc] });
    expect(geminiMock).not.toHaveBeenCalled();
  });

  it("a provider failure is a plain warning, not a 500 and not the error text", async () => {
    flagOn();
    vi.spyOn(console, "error").mockImplementation(() => {});
    geminiMock.mockRejectedValue(new Error("Gemini 429: quota exhausted for key AIza..."));
    const res = await upload(Buffer.from(`# ${randomUUID()}\nrule\n`), "spec.md");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: false, warnings: [DISTILL_FAILED_WARNING] });
    expect(JSON.stringify(res.body)).not.toContain("429");
  });

  it("a malformed REQUEST (no name, wrong content type) is a 400, distinct from a rejected document", async () => {
    flagOn();
    const noName = await request(app).post("/api/spec/upload")
      .set("Content-Type", "application/octet-stream").send(Buffer.from("x"));
    expect(noName.status).toBe(400);
    const json = await request(app).post("/api/spec/upload?name=a.md").send({ base64: "eA==" });
    expect(json.status).toBe(400);
  });

  it("is tester-or-above, like starting a run", async () => {
    // With AUTH off the synthetic local OWNER passes; the role check itself runs either way
    // (rule 7) — the multi-tenancy suite covers the authenticated denials.
    flagOn();
    geminiMock.mockResolvedValueOnce(modelAnswer(GOOD_SPEC));
    expect((await upload(Buffer.from(`# ${randomUUID()}\nr\n`), "a.md")).status).toBe(200);
  });
});

describe("the uploaded document is not stored anywhere under runs/ (test 15)", () => {
  function filesUnder(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      const p = path.join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) out.push(...filesUnder(p));
      else out.push(p);
    }
    return out;
  }

  it("after a real upload, no file under runs/ contains the document's bytes", async () => {
    flagOn();
    const before = new Set(filesUnder("runs"));
    // A marker that appears ONLY in the document — the model's answer below does not repeat it,
    // so finding it anywhere on disk can only mean the document itself was written.
    const marker = `DOC-ONLY-${randomUUID()}`;
    geminiMock.mockResolvedValueOnce(modelAnswer({ rules: ["A Lead needs a phone number."] }));
    const res = await upload(Buffer.from(`# Spec ${marker}\nA Lead needs a phone number.\n`), "spec.md");
    expect(res.body.ok).toBe(true);

    const created = filesUnder("runs").filter((f) => !before.has(f));
    try {
      // The only thing intake may write is the distilled spec, in the cache's "spec" namespace.
      for (const f of created) expect(f.split(path.sep).slice(0, 3)).toEqual(["runs", "_cache", "spec"]);
      for (const f of filesUnder("runs")) {
        expect(readFileSync(f).includes(marker), `document bytes found in ${f}`).toBe(false);
      }
    } finally {
      for (const f of created) rmSync(f, { force: true });
    }
  });
});

describe("flag ON — POST /api/spec/confirm", () => {
  it("returns the validated spec to the browser", async () => {
    flagOn();
    const spec = { ...GOOD_SPEC, answers: [{ question: GOOD_SPEC.unresolved[0], answer: "INR" }] };
    const res = await request(app).post("/api/spec/confirm").send({ spec });
    expect(res.status).toBe(200);
    expect(res.body.spec).toEqual(spec);
  });

  it("refuses an answer to a question that was never asked", async () => {
    flagOn();
    const spec = { ...GOOD_SPEC, answers: [{ question: "Something nobody asked?", answer: "yes" }] };
    expect((await request(app).post("/api/spec/confirm").send({ spec })).status).toBe(400);
  });

  it("refuses more than 10 questions and unknown fields", async () => {
    flagOn();
    const many = { ...GOOD_SPEC, unresolved: Array.from({ length: 11 }, (_, i) => `Q${i}?`) };
    expect((await request(app).post("/api/spec/confirm").send({ spec: many })).status).toBe(400);
    expect((await request(app).post("/api/spec/confirm").send({ spec: { ...GOOD_SPEC, extra: 1 } })).status).toBe(400);
    expect((await request(app).post("/api/spec/confirm").send({})).status).toBe(400);
  });
});

describe("flag ON — options.spec on POST /api/runs", () => {
  it("a valid spec is forwarded to the pipeline as the PARSED value", async () => {
    flagOn();
    const opts = await startRun({ spec: GOOD_SPEC });
    expect(opts.spec).toEqual(GOOD_SPEC);
  });

  it("a malformed spec is ignored — the run is the standard run", async () => {
    flagOn();
    const opts = await startRun({ spec: { rules: "not a list" } });
    expect(opts).not.toHaveProperty("spec");
  });

  it("no spec at all leaves the options exactly as before", async () => {
    flagOn();
    const opts = await startRun({ gateReview: true });
    expect(opts).not.toHaveProperty("spec");
  });
});

describe("flag ON — GET /api/runs/:runId/spec-warnings", () => {
  it("serves the run's in-memory warnings", async () => {
    flagOn();
    setRunSpecWarnings(RUN_ID, { warnings: ["A rule about refunds can't be tested — no refund page found."], done: true });
    const res = await request(app).get(`/api/runs/${RUN_ID}/spec-warnings`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ warnings: ["A rule about refunds can't be tested — no refund page found."], done: true });
  });

  it("a run with nothing recorded is empty and not done", async () => {
    flagOn();
    const res = await request(app).get(`/api/runs/2026-10-13T00-00-00-000Z-5bec0002/spec-warnings`);
    expect(res.body).toEqual({ warnings: [], done: false });
  });
});
