import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";

/**
 * Server-side sign-up — POST /api/auth/signup.
 *
 * This is the only unauthenticated route in the server that writes, and it writes using the
 * service-role key, so the tests below are mostly about what it REFUSES: the flag, the rate
 * limit, the validation, and not leaking whether an address is already registered in a form an
 * anonymous caller can farm.
 *
 * Only `@supabase/supabase-js` is mocked. The real route, the real ordering of its guards and the
 * real rate limiter all run — those are where a mistake here would actually live.
 */

const CREATED_ID = "77777777-0000-4000-8000-000000000007";

/** Addresses the fake Supabase already knows about, to exercise the duplicate path. */
const EXISTING = "taken@example.com";

const createCalls: { email: string; email_confirm?: boolean }[] = [];

vi.mock("@supabase/supabase-js", () => ({
  createClient: () => ({
    from: () => {
      const builder: any = {
        select: () => builder,
        insert: () => builder,
        update: () => builder,
        delete: () => builder,
        eq: () => builder,
        in: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        // bootstrapUser inserts an organisation and reads back its id.
        single: () => Promise.resolve({ data: { id: "org-new", name: "new org" }, error: null }),
        then: (resolve: (v: unknown) => unknown) => resolve({ data: [], error: null }),
      };
      return builder;
    },
    auth: {
      getUser: async (token: string) =>
        token
          ? { data: { user: { id: token, email: "someone@example.com" } }, error: null }
          : { data: { user: null }, error: new Error("no token") },
      signInWithPassword: async ({ email }: { email: string }) => ({
        data: { session: { access_token: `token-for-${email}`, refresh_token: "refresh" } },
        error: null,
      }),
      admin: {
        listUsers: async () => ({ data: { users: [] }, error: null }),
        createUser: async (opts: { email: string; email_confirm?: boolean }) => {
          createCalls.push(opts);
          if (opts.email === EXISTING) {
            return {
              data: { user: null },
              error: { message: "A user with this email address has already been registered" },
            };
          }
          return { data: { user: { id: CREATED_ID, email: opts.email } }, error: null };
        },
      },
    },
  }),
}));

const { app } = await import("../src/server/index.js");
const { resetSignupRateLimit } = await import("../src/server/signup.js");
const request = (await import("supertest")).default;

const ORIGINAL_ENV = { ...process.env };
const TOUCHED = [
  "AUTH_ENABLED", "DB_ENABLED", "SIGNUP_ENABLED",
  "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY",
];

beforeEach(() => {
  process.env.AUTH_ENABLED = "true";
  process.env.DB_ENABLED = "true";
  delete process.env.SIGNUP_ENABLED; // default: open
  process.env.SUPABASE_URL = "https://fake.supabase.co";
  process.env.SUPABASE_PUBLISHABLE_KEY = "fake-publishable";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role";
  resetSignupRateLimit();
  createCalls.length = 0;
});

afterAll(() => {
  for (const k of TOUCHED) {
    if (ORIGINAL_ENV[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL_ENV[k]!;
  }
});

/** Unique address per call so the rate limiter, not a duplicate, is what varies between tests. */
let n = 0;
const freshEmail = () => `new-user-${n++}@example.com`;

describe("POST /api/auth/signup — the happy path", () => {
  it("creates an account and returns a usable session", async () => {
    const email = freshEmail();
    const res = await request(app).post("/api/auth/signup").send({ email, password: "longenough1" });

    expect(res.status).toBe(201);
    expect(res.body.accessToken).toBeTruthy();
    expect(res.body.user.email).toBe(email);
  });

  it("marks the address confirmed at creation — the whole reason this route exists", async () => {
    // Supabase's public /auth/v1/signup 504s on this project because it tries to send a
    // confirmation mail. email_confirm:true is what avoids that path entirely; if this ever
    // regresses to false, sign-up silently starts hanging again in production and nowhere else.
    await request(app).post("/api/auth/signup").send({ email: freshEmail(), password: "longenough1" });
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].email_confirm).toBe(true);
  });

  it("lowercases and trims the address", async () => {
    await request(app).post("/api/auth/signup").send({ email: "  MiXeD@Example.COM ", password: "longenough1" });
    expect(createCalls[0].email).toBe("mixed@example.com");
  });
});

describe("POST /api/auth/signup — validation is server-side, not the client's word", () => {
  it("rejects a malformed address", async () => {
    const res = await request(app).post("/api/auth/signup").send({ email: "not-an-email", password: "longenough1" });
    expect(res.status).toBe(400);
    expect(createCalls).toHaveLength(0);
  });

  it("rejects a short password even though the form also checks it", async () => {
    const res = await request(app).post("/api/auth/signup").send({ email: freshEmail(), password: "short" });
    expect(res.status).toBe(400);
    expect(createCalls).toHaveLength(0);
  });

  it("rejects a non-string password rather than passing it through", async () => {
    const res = await request(app).post("/api/auth/signup").send({ email: freshEmail(), password: 12345678 });
    expect(res.status).toBe(400);
    expect(createCalls).toHaveLength(0);
  });

  it("rejects a missing body", async () => {
    const res = await request(app).post("/api/auth/signup").send({});
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/signup — refusals", () => {
  it("409s a duplicate address without echoing Supabase's wording", async () => {
    const res = await request(app).post("/api/auth/signup").send({ email: EXISTING, password: "longenough1" });
    expect(res.status).toBe(409);
    expect(String(res.body.error)).toMatch(/already exists/i);
    // Supabase's own phrasing varies by version and can describe internals — ours shouldn't leak it.
    expect(String(res.body.error)).not.toMatch(/registered/i);
  });

  it("404s when AUTH_ENABLED is off — an account nobody could sign in as", async () => {
    process.env.AUTH_ENABLED = "false";
    const res = await request(app).post("/api/auth/signup").send({ email: freshEmail(), password: "longenough1" });
    expect(res.status).toBe(404);
    expect(createCalls).toHaveLength(0);
  });

  it("403s when SIGNUP_ENABLED=false", async () => {
    process.env.SIGNUP_ENABLED = "false";
    const res = await request(app).post("/api/auth/signup").send({ email: freshEmail(), password: "longenough1" });
    expect(res.status).toBe(403);
    expect(createCalls).toHaveLength(0);
  });

  it("is open by default — only the literal string 'false' closes it", async () => {
    process.env.SIGNUP_ENABLED = "yes";
    const res = await request(app).post("/api/auth/signup").send({ email: freshEmail(), password: "longenough1" });
    expect(res.status).toBe(201);
  });
});

describe("POST /api/auth/signup — rate limiting", () => {
  it("429s after the per-IP allowance is spent", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 7; i++) {
      const res = await request(app)
        .post("/api/auth/signup")
        .send({ email: freshEmail(), password: "longenough1" });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 5).every((s) => s === 201)).toBe(true);
    expect(statuses.slice(5)).toEqual([429, 429]);
  });

  it("counts failed attempts too, so a duplicate-email probe is not free", async () => {
    // Otherwise the 409 becomes an unlimited oracle for "is this address registered?".
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/auth/signup").send({ email: EXISTING, password: "longenough1" });
    }
    const res = await request(app).post("/api/auth/signup").send({ email: freshEmail(), password: "longenough1" });
    expect(res.status).toBe(429);
  });

  it("counts rejected-validation attempts too", async () => {
    for (let i = 0; i < 5; i++) {
      await request(app).post("/api/auth/signup").send({ email: "bad", password: "x" });
    }
    const res = await request(app).post("/api/auth/signup").send({ email: freshEmail(), password: "longenough1" });
    expect(res.status).toBe(429);
  });
});

describe("POST /api/auth/signup — reachable without a credential", () => {
  it("does not require a bearer token (it is how you get one)", async () => {
    const res = await request(app).post("/api/auth/signup").send({ email: freshEmail(), password: "longenough1" });
    expect(res.status).not.toBe(401);
  });
});
