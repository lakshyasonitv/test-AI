import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * Per-organisation LLM configuration.
 *
 * The three properties this file exists to prove, in the order they would hurt:
 *
 *  1. **A decrypted key never leaves the server.** Not in a response body, not in a log line, not
 *     in an event, not in an artifact. There is exactly one decryption site (`llmConfigForOrg`)
 *     and it feeds an in-memory KeyPool. Everything else must be unable to express a key.
 *  2. **Tenancy.** An admin of org A cannot read *or* set org B's configuration. Reading matters
 *     as much as writing: "does org B have a key set" is already information an outsider should
 *     not have.
 *  3. **Cache keys do not collide across models or tenants.** The disk cache never expires, so a
 *     key missing a dimension serves a wrong answer forever — TD-22 / D-10. This is the failure
 *     that would be silent, permanent, and cross-tenant.
 */

const ORG_A = "aaaaaaaa-0000-4000-8000-0000000000a1";
const ORG_B = "bbbbbbbb-0000-4000-8000-0000000000b1";
const ADMIN_A = "11111111-0000-4000-8000-0000000000a2";
const ADMIN_B = "22222222-0000-4000-8000-0000000000b2";
const VIEWER_A = "33333333-0000-4000-8000-0000000000a3";

/** Distinctive enough that a substring search for it is a meaningful leak test. */
const SECRET_KEY = "AIzaSyTOTALLY-SECRET-KEY-DO-NOT-LEAK-9f3a";

const keyDir = mkdtempSync(path.join(tmpdir(), "llmkey-"));
const keyFile = path.join(keyDir, "llm.key");
writeFileSync(keyFile, crypto.randomBytes(32));

interface Tables {
  organisation_members: any[];
  org_llm_config: any[];
  organisations: any[];
}
let db: Tables;

function reset() {
  db = {
    organisations: [{ id: ORG_A, name: "A" }, { id: ORG_B, name: "B" }],
    organisation_members: [
      { organisation_id: ORG_A, user_id: ADMIN_A, role: "admin" },
      { organisation_id: ORG_A, user_id: VIEWER_A, role: "viewer" },
      { organisation_id: ORG_B, user_id: ADMIN_B, role: "admin" },
    ],
    org_llm_config: [],
  };
}

function makeBuilder(table: keyof Tables) {
  const eqs: [string, unknown][] = [];
  let pending: { kind: string; payload?: any } | null = null;
  let single = false;
  const match = (r: any) => eqs.every(([c, v]) => r[c] === v);

  const run = () => {
    const rows = db[table] as any[];
    if (pending?.kind === "upsert" || pending?.kind === "insert") {
      const payloads = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      for (const p of payloads) {
        const existing = rows.find((r) => r.organisation_id === p.organisation_id);
        if (existing) Object.assign(existing, p);
        else rows.push({ ...p });
      }
      return { data: single ? payloads[0] : payloads, error: null };
    }
    if (pending?.kind === "update") {
      const hit = rows.filter(match);
      for (const r of hit) Object.assign(r, pending.payload);
      return { data: single ? hit[0] ?? null : hit, error: null };
    }
    const found = rows.filter(match);
    return { data: single ? found[0] ?? null : found, error: null };
  };

  const b: any = {
    select: () => b,
    eq: (c: string, v: unknown) => { eqs.push([c, v]); return b; },
    in: () => b, order: () => b, limit: () => b,
    insert: (p: any) => { pending = { kind: "insert", payload: p }; return b; },
    update: (p: any) => { pending = { kind: "update", payload: p }; return b; },
    upsert: (p: any) => { pending = { kind: "upsert", payload: p }; return b; },
    delete: () => { pending = { kind: "delete" }; return b; },
    single: () => { single = true; return Promise.resolve(run()); },
    maybeSingle: () => { single = true; return Promise.resolve(run()); },
    then: (res: any, rej: any) => Promise.resolve(run()).then(res, rej),
  };
  return b;
}

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: (t: string) => makeBuilder(t as keyof Tables),
    auth: { admin: { listUsers: async () => ({ data: { users: [] } }) } },
  }),
}));

const ENV_KEYS = [
  "AUTH_ENABLED", "DB_ENABLED", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY",
  "ORG_LLM_CONFIG_ENABLED", "LLM_KEY_FILE", "GEMINI_MODEL", "GEMINI_MODEL_LITE",
] as const;
const ORIGINAL_ENV = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

process.env.AUTH_ENABLED = "true";
process.env.DB_ENABLED = "true";
process.env.SUPABASE_URL = "https://example.supabase.co";
process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
process.env.ORG_LLM_CONFIG_ENABLED = "true";
process.env.LLM_KEY_FILE = keyFile;

afterAll(() => {
  for (const k of ENV_KEYS) {
    const o = ORIGINAL_ENV[k];
    if (o === undefined) delete process.env[k]; else process.env[k] = o;
  }
  rmSync(keyDir, { recursive: true, force: true });
});

vi.mock("../src/server/auth.js", async (orig) => {
  const actual = await orig<any>();
  return {
    ...actual,
    isAuthEnabled: () => true,
    resolveUser: async (req: any) => {
      const t = (req.headers?.authorization ?? "").replace(/^Bearer\s+/i, "");
      return t ? { id: t, email: `${t}@example.com`, synthetic: false } : null;
    },
    requireAuth: async (req: any, res: any, next: any) => {
      const t = (req.headers?.authorization ?? "").replace(/^Bearer\s+/i, "");
      if (!t) return res.status(401).json({ error: "authentication required" });
      req.user = { id: t, email: `${t}@example.com`, synthetic: false };
      next();
    },
  };
});

/** Gemini's ListModels, stubbed: no network, and a known answer to validate against. */
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any, init?: any) => {
  const href = String(url);
  if (href.includes("generativelanguage.googleapis.com")) {
    return new Response(JSON.stringify({
      models: [{ name: "models/gemini-3.6-flash" }, { name: "models/gemini-3.1-flash-lite" }],
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  return realFetch(url, init);
}) as typeof fetch;

const { app } = await import("../src/server/index.js");
const request = (await import("supertest")).default;
const { invalidateMemberships } = await import("../src/server/authz.js");
const { llmConfigForOrg } = await import("../src/server/orgLlmConfig.js");
const { encryptSecret, decryptSecret, secretHint } = await import("../src/server/secretStore.js");
const { makeCacheKey } = await import("../src/kb/llmCache.js");
const { enterWithLlmConfig, resolvedModel, llmCacheDimension } = await import("../src/llm/llmContext.js");

const as = (u: string) => ({ Authorization: `Bearer ${u}` });

beforeEach(() => { reset(); invalidateMemberships(); });

async function setKeyForA() {
  return request(app).put(`/api/organisations/${ORG_A}/llm-config`)
    .set(as(ADMIN_A))
    .send({ apiKey: SECRET_KEY, model: "gemini-3.6-flash" });
}

describe("tenancy — org A's admin cannot reach org B", () => {
  it("cannot READ org B's configuration", async () => {
    const res = await request(app).get(`/api/organisations/${ORG_B}/llm-config`).set(as(ADMIN_A));
    expect(res.status).toBe(403);
  });

  it("cannot SET org B's configuration", async () => {
    const res = await request(app).put(`/api/organisations/${ORG_B}/llm-config`)
      .set(as(ADMIN_A)).send({ apiKey: SECRET_KEY });
    expect(res.status).toBe(403);
    expect(db.org_llm_config).toHaveLength(0);
  });

  it("a viewer in the org cannot set its configuration", async () => {
    const res = await request(app).put(`/api/organisations/${ORG_A}/llm-config`)
      .set(as(VIEWER_A)).send({ apiKey: SECRET_KEY });
    expect(res.status).toBe(403);
  });

  it("each org keeps its own key — one does not overwrite the other", async () => {
    await setKeyForA();
    await request(app).put(`/api/organisations/${ORG_B}/llm-config`)
      .set(as(ADMIN_B)).send({ apiKey: "AIzaSyDIFFERENT-KEY-FOR-ORG-B-0000", model: "gemini-3.6-flash" });

    const a = db.org_llm_config.find((r) => r.organisation_id === ORG_A);
    const b = db.org_llm_config.find((r) => r.organisation_id === ORG_B);
    expect(a.key_fingerprint).not.toBe(b.key_fingerprint);
    expect(a.key_ct).not.toBe(b.key_ct);
  });
});

describe("the key never comes back out", () => {
  it("is not in the PUT response", async () => {
    const res = await setKeyForA();
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_KEY);
  });

  it("is not in the GET response — only set/not-set and a hint", async () => {
    await setKeyForA();
    const res = await request(app).get(`/api/organisations/${ORG_A}/llm-config`).set(as(ADMIN_A));
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SECRET_KEY);
    expect(res.body.keySet).toBe(true);
    // A hint that identifies WHICH key without revealing it.
    expect(res.body.keyHint).toBe(secretHint(SECRET_KEY));
    expect(res.body.keyHint).not.toContain("SECRET");
  });

  it("is stored encrypted, not in plaintext, in the database row", async () => {
    await setKeyForA();
    const row = db.org_llm_config.find((r) => r.organisation_id === ORG_A);
    expect(JSON.stringify(row)).not.toContain(SECRET_KEY);
    expect(row.key_ct).toBeTruthy();
    expect(row.key_iv).toBeTruthy();
    expect(row.key_tag).toBeTruthy();
  });

  it("never appears in a log line — including while it is being decrypted for a run", async () => {
    const seen: string[] = [];
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation((...a: any[]) => { seen.push(a.map(String).join(" ")); }));

    await setKeyForA();
    const config = await llmConfigForOrg(ORG_A);

    spies.forEach((s) => s.mockRestore());
    // The decryption really did happen — otherwise this test proves nothing.
    expect(config?.pool).toBeTruthy();
    expect(seen.join("\n")).not.toContain(SECRET_KEY);
  });

  it("is not reachable through the config object handed to a run", async () => {
    await setKeyForA();
    const config = await llmConfigForOrg(ORG_A);
    // The pool holds it, by necessity — but the serialisable surface must not.
    expect(JSON.stringify({
      model: config?.model, modelLite: config?.modelLite,
      keyFingerprint: config?.keyFingerprint, organisationId: config?.organisationId,
    })).not.toContain(SECRET_KEY);
    // And the fingerprint is not the key, nor reversible to it.
    expect(config?.keyFingerprint).not.toContain(SECRET_KEY);
    expect(config?.keyFingerprint?.length).toBeLessThan(SECRET_KEY.length);
  });
});

describe("encryption", () => {
  it("round-trips", () => {
    const sealed = encryptSecret(SECRET_KEY);
    expect(sealed.ct).not.toContain(SECRET_KEY);
    expect(decryptSecret(sealed)).toBe(SECRET_KEY);
  });

  it("uses a fresh IV each time, so the same key does not produce the same ciphertext", () => {
    const a = encryptSecret(SECRET_KEY);
    const b = encryptSecret(SECRET_KEY);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ct).not.toBe(b.ct);
  });

  it("refuses a tampered ciphertext rather than decrypting to something else", () => {
    const sealed = encryptSecret(SECRET_KEY);
    const bytes = Buffer.from(sealed.ct, "base64");
    bytes[0] ^= 0xff;
    expect(() => decryptSecret({ ...sealed, ct: bytes.toString("base64") })).toThrow();
  });
});

describe("model validation", () => {
  it("refuses a model that is not on the allowlist — a typo fails here, not mid-run", async () => {
    const res = await request(app).put(`/api/organisations/${ORG_A}/llm-config`)
      .set(as(ADMIN_A)).send({ apiKey: SECRET_KEY, model: "gemini-3.6-flsh" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not a model this server offers/i);
    expect(db.org_llm_config).toHaveLength(0);
  });

  it("refuses a model the provider says this key cannot use", async () => {
    const res = await request(app).put(`/api/organisations/${ORG_A}/llm-config`)
      .set(as(ADMIN_A)).send({ apiKey: SECRET_KEY, model: "gemini-2.5-pro" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot use/i);
  });

  it("lists the available models alongside the config, so the UI has one source", async () => {
    const res = await request(app).get(`/api/organisations/${ORG_A}/llm-config`).set(as(ADMIN_A));
    expect(res.body.availableModels).toContain("gemini-3.6-flash");
  });
});

describe("cache keys do not collide — TD-22 / D-10", () => {
  /**
   * The bug this prevents: every makeCacheKey call site used to read `process.env.GEMINI_MODEL`,
   * so with per-org models every tenant would key on the SERVER's model and share one entry. The
   * disk half never expires, so org B would be served org A's answer, generated by a different
   * model, forever.
   */
  it("the same prompt under different models produces different keys", () => {
    enterWithLlmConfig({
      pool: null, model: "gemini-3.6-flash", modelLite: null,
      keyFingerprint: "fp-a", organisationId: ORG_A,
    });
    const keyFlash = makeCacheKey("same prompt", resolvedModel(), llmCacheDimension("main"));

    enterWithLlmConfig({
      pool: null, model: "gemini-2.5-pro", modelLite: null,
      keyFingerprint: "fp-a", organisationId: ORG_A,
    });
    const keyPro = makeCacheKey("same prompt", resolvedModel(), llmCacheDimension("main"));

    expect(keyFlash).not.toBe(keyPro);
  });

  it("the same prompt and model under different tenants produces different keys", () => {
    enterWithLlmConfig({
      pool: null, model: "gemini-3.6-flash", modelLite: null,
      keyFingerprint: "fp-a", organisationId: ORG_A,
    });
    const keyA = makeCacheKey("same prompt", resolvedModel(), llmCacheDimension("main"));

    enterWithLlmConfig({
      pool: null, model: "gemini-3.6-flash", modelLite: null,
      keyFingerprint: "fp-b", organisationId: ORG_B,
    });
    const keyB = makeCacheKey("same prompt", resolvedModel(), llmCacheDimension("main"));

    expect(keyA).not.toBe(keyB);
  });

  it("resolvedModel prefers the run's model over the server's env", () => {
    process.env.GEMINI_MODEL = "gemini-3.1-flash-lite";
    enterWithLlmConfig({
      pool: null, model: "gemini-2.5-pro", modelLite: null,
      keyFingerprint: "fp-a", organisationId: ORG_A,
    });
    // If this returned the env value, every org would share one cache entry.
    expect(resolvedModel()).toBe("gemini-2.5-pro");
  });
});

describe("the env flag, default OFF", () => {
  const off = () => { process.env.ORG_LLM_CONFIG_ENABLED = "false"; };
  const on = () => { process.env.ORG_LLM_CONFIG_ENABLED = "true"; };

  it("404s both routes", async () => {
    off();
    const get = await request(app).get(`/api/organisations/${ORG_A}/llm-config`).set(as(ADMIN_A));
    const put = await request(app).put(`/api/organisations/${ORG_A}/llm-config`)
      .set(as(ADMIN_A)).send({ apiKey: SECRET_KEY });
    on();
    expect(get.status).toBe(404);
    expect(put.status).toBe(404);
  });

  it("does not apply a stored configuration — runs use the env exactly as before", async () => {
    await setKeyForA();
    off();
    const config = await llmConfigForOrg(ORG_A);
    on();
    expect(config).toBeNull();
  });
});
