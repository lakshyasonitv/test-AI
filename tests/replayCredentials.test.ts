import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { credentialKindsNeeded } from "../src/stages/credentials.js";

/**
 * Credentials on the replay path.
 *
 * THE BUG THIS EXISTS FOR. `runReplay` has always accepted a `creds` argument and always passed it
 * to `credentialEnvVars`, but its ONLY caller — the `/api/replay` route — never supplied one. So
 * `credentialEnvVars(undefined)` returned `{}`, no `TEST_USERNAME` / `TEST_PASSWORD` reached the
 * generated spec, and the spec's `process.env.TEST_USERNAME ?? ""` typed an EMPTY STRING into the
 * login form. The sign-in silently failed and the case died several steps later on whichever
 * assertion first noticed it was still logged out.
 *
 * Observed on run `2026-08-31T06-30-26-597Z-1c2a719e`: it failed at
 * `expect(getByRole('button', { name: 'Sign In' })).toBeHidden()` — with the edit the user was
 * actually testing sitting three steps further down, never reached. A fresh run never had this
 * problem, because the orchestrator asks. Replay was the one path that ran a login case without
 * ever obtaining a login.
 */

const { askCredentialsMock } = vi.hoisted(() => ({ askCredentialsMock: vi.fn() }));
vi.mock("../src/server/pendingCredentials.js", () => ({ askCredentials: askCredentialsMock }));

const { resolveCredentialsVia } = await import("../src/server/resolveCredentials.js");

const SAVED_USER = process.env.TEST_USERNAME;
const SAVED_PASS = process.env.TEST_PASSWORD;

beforeEach(() => {
  askCredentialsMock.mockReset();
  delete process.env.TEST_USERNAME;
  delete process.env.TEST_PASSWORD;
});
afterEach(() => {
  if (SAVED_USER === undefined) delete process.env.TEST_USERNAME; else process.env.TEST_USERNAME = SAVED_USER;
  if (SAVED_PASS === undefined) delete process.env.TEST_PASSWORD; else process.env.TEST_PASSWORD = SAVED_PASS;
});

describe("resolveCredentialsVia — the default order (env-first), used by the editor walk", () => {
  it("uses the environment and never prompts when the pair is already set", async () => {
    process.env.TEST_USERNAME = "ops@example.com";
    process.env.TEST_PASSWORD = "s3cret";
    const emit = vi.fn();

    const creds = await resolveCredentialsVia("run-1", "https://x.test", ["username", "password"] as any, emit);

    expect(creds).toMatchObject({ username: "ops@example.com", password: "s3cret" });
    expect(askCredentialsMock).not.toHaveBeenCalled();
    // No event at all: an operator who configured credentials should never see a prompt flash.
    expect(emit).not.toHaveBeenCalled();
  });

  it("prompts when the environment has nothing, and emits started then completed", async () => {
    askCredentialsMock.mockResolvedValueOnce({ username: "u", password: "p", secret: true });
    const emit = vi.fn();

    const creds = await resolveCredentialsVia("run-2", "https://x.test", ["username", "password"] as any, emit);

    expect(creds).toMatchObject({ username: "u", password: "p" });
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["started", "completed"]);
    expect(emit.mock.calls[0][1]).toEqual({ url: "https://x.test", fields: ["username", "password"] });
    expect(emit.mock.calls[1][1]).toEqual({ supplied: true });
    // Parked under the caller's own id, so the existing credentials route settles it.
    expect(askCredentialsMock).toHaveBeenCalledWith({
      runId: "run-2", url: "https://x.test", fields: ["username", "password"],
    });
  });

  it("reports supplied:false and returns undefined when the prompt is skipped or times out", async () => {
    askCredentialsMock.mockResolvedValueOnce(null);
    const emit = vi.fn();

    const creds = await resolveCredentialsVia("run-3", "https://x.test", ["username"] as any, emit);

    expect(creds).toBeUndefined();
    expect(emit.mock.calls[1][1]).toEqual({ supplied: false });
  });

  /** The events are the only thing that leaves the server, so they must never carry a value. */
  it("never puts a credential value into an event payload", async () => {
    askCredentialsMock.mockResolvedValueOnce({ username: "ops@example.com", password: "hunter2", secret: true });
    const emit = vi.fn();

    await resolveCredentialsVia("run-4", "https://x.test", ["username", "password"] as any, emit);

    const emitted = JSON.stringify(emit.mock.calls);
    expect(emitted).not.toContain("hunter2");
    expect(emitted).not.toContain("ops@example.com");
  });
});

/**
 * The back-compatibility guarantee, pinned. A replay of cases that do not sign in must behave
 * exactly as it did before this change: no prompt, no credentials event, nothing to answer. The
 * route decides that with `credentialKindsNeeded` over every case's steps, so this pins the
 * condition itself.
 */
describe("only replays that actually sign in ask for anything", () => {
  it("finds no credential need in steps without an ${env:...} value", () => {
    const steps = [
      { action: "navigate", value: undefined },
      { action: "fill", value: "hello world" },
      { action: "click" },
    ];
    expect(credentialKindsNeeded(steps as any)).toEqual([]);
  });

  it("finds the need when a step carries an ${env:...} reference", () => {
    const steps = [
      { action: "fill", value: "${env:TEST_USERNAME}" },
      { action: "fill", value: "${env:TEST_PASSWORD}" },
    ];
    expect(credentialKindsNeeded(steps as any).length).toBeGreaterThan(0);
  });

  it("sees the need across a MULTI-case replay, not just the first case", () => {
    // The route flat-maps every case's steps on purpose: a suite whose second case is the one
    // that logs in must still prompt, or that case fails exactly the way the bug above did.
    const caseA = [{ action: "click" }];
    const caseB = [{ action: "fill", value: "${env:TEST_PASSWORD}" }];
    expect(credentialKindsNeeded([...caseA, ...caseB] as any).length).toBeGreaterThan(0);
    expect(credentialKindsNeeded(caseA as any)).toEqual([]);
  });
});

/**
 * Two shapes the browser reads, which a refactor could silently change. `public/app.js` cannot be
 * imported here, and standing up the whole server to assert an event payload would be heavier than
 * the risk warrants, so these are checked against the source of the two call sites.
 */
describe("the two callers keep their distinct event shapes", () => {
  const SRC = readFileSync(new URL("../src/server/index.ts", import.meta.url), "utf8");

  it("the case-edit walk still flags caseEdit on the STARTED event only", () => {
    // app.js reads `data.caseEdit` to choose the editor's wording ("Checking this edit means
    // signing in..." rather than the run wording). Putting it on the completed event too would
    // change a payload the UI reads.
    expect(SRC).toMatch(/status === "started"\s*\?\s*\{ \.\.\.data, caseEdit: true \}\s*:\s*data/);
  });

  it("the replay emits the RUN event shape, so app.js draws the run prompt unchanged", () => {
    // A run emits { fields, url } then { provided } — not the walk's { supplied }. app.js's
    // showCredentialPrompt defaults its post URL to /api/runs/<runId>/credentials, which is
    // exactly where a replay's waiter is parked, so no frontend change is needed.
    expect(SRC).toMatch(/\{ url: data\.url, fields: data\.fields \}/);
    expect(SRC).toMatch(/\{ provided: !!data\.supplied \}/);
  });

  it("the replay actually passes creds through to runReplay", () => {
    // The whole bug was that it did not.
    expect(SRC).toMatch(/runReplay\(\{ runId, cases, label: runLabel, creds \}/);
  });
});

/**
 * Resolution ORDER, which is per-caller and deliberately not a shared default.
 *
 * A replay is started by a person, on a server whose `TEST_USERNAME` / `TEST_PASSWORD` may belong
 * to someone else entirely. What that person types has to win. The case editor's re-ground walk
 * takes the opposite order for the opposite reason: it runs inside a save the person already
 * asked for, so an operator who configured the environment should not be interrupted by it.
 */
describe("resolveCredentialsVia \u2014 prompt-first (replay)", () => {
  it("uses what the user typed EVEN WHEN the environment is set", async () => {
    process.env.TEST_USERNAME = "server@example.com";
    process.env.TEST_PASSWORD = "server-secret";
    askCredentialsMock.mockResolvedValueOnce({ username: "me@example.com", password: "mine", secret: true });
    const emit = vi.fn();

    const creds = await resolveCredentialsVia("run-p1", "https://x.test", ["username", "password"] as any, emit, "prompt-first");

    // The whole point of the order.
    expect(creds).toMatchObject({ username: "me@example.com", password: "mine" });
    expect(creds!.username).not.toBe("server@example.com");
    expect(askCredentialsMock).toHaveBeenCalledTimes(1);
  });

  it("prompts even when the environment could have answered", async () => {
    process.env.TEST_USERNAME = "server@example.com";
    process.env.TEST_PASSWORD = "server-secret";
    askCredentialsMock.mockResolvedValueOnce(null);
    const emit = vi.fn();

    await resolveCredentialsVia("run-p2", "https://x.test", ["username"] as any, emit, "prompt-first");

    // env-first would have returned without ever emitting. This is the cost of the order.
    expect(emit.mock.calls.map((c) => c[0])).toEqual(["started", "completed"]);
  });

  it("falls back to the environment when the user skips or times out", async () => {
    process.env.TEST_USERNAME = "server@example.com";
    process.env.TEST_PASSWORD = "server-secret";
    askCredentialsMock.mockResolvedValueOnce(null);          // skipped / timed out
    const emit = vi.fn();

    const creds = await resolveCredentialsVia("run-p3", "https://x.test", ["username"] as any, emit, "prompt-first");

    expect(creds).toMatchObject({ username: "server@example.com" });
    // The event reports what the PERSON did, not what the run ended up with.
    expect(emit.mock.calls[1][1]).toEqual({ supplied: false });
  });

  it("returns undefined when the user skips and the environment is empty", async () => {
    askCredentialsMock.mockResolvedValueOnce(null);
    const creds = await resolveCredentialsVia("run-p4", "https://x.test", ["username"] as any, vi.fn(), "prompt-first");
    expect(creds).toBeUndefined();
  });

  it("still does not prompt at all when no step needs a credential", () => {
    // The route decides this before calling; pinned here because it is the back-compat guarantee.
    expect(credentialKindsNeeded([{ action: "click" }] as any)).toEqual([]);
  });
});

describe("resolveCredentialsVia \u2014 env-first (the editor's walk) is unchanged", () => {
  it("never prompts when the environment answers", async () => {
    process.env.TEST_USERNAME = "ops@example.com";
    process.env.TEST_PASSWORD = "s3cret";
    const emit = vi.fn();

    const creds = await resolveCredentialsVia("run-e1", "https://x.test", ["username"] as any, emit, "env-first");

    expect(creds).toMatchObject({ username: "ops@example.com" });
    expect(askCredentialsMock).not.toHaveBeenCalled();
    expect(emit).not.toHaveBeenCalled();
  });

  it("defaults to env-first when no order is given", async () => {
    process.env.TEST_USERNAME = "ops@example.com";
    process.env.TEST_PASSWORD = "s3cret";
    const creds = await resolveCredentialsVia("run-e2", "https://x.test", ["username"] as any, vi.fn());
    expect(creds).toMatchObject({ username: "ops@example.com" });
    expect(askCredentialsMock).not.toHaveBeenCalled();
  });
});

/**
 * The containment guarantee, asserted rather than trusted: a credential value leaves this module
 * only as the return value. It must not appear in any event payload on EITHER order \u2014 events are
 * written to `runs/<id>/events.ndjson`, which is on disk and served over HTTP.
 */
describe("a credential value never leaves through an event", () => {
  it.each(["prompt-first", "env-first"] as const)("holds under %s", async (order) => {
    process.env.TEST_USERNAME = "leak-canary@example.com";
    process.env.TEST_PASSWORD = "leak-canary-password";
    askCredentialsMock.mockResolvedValueOnce({
      username: "typed-canary@example.com", password: "typed-canary-password", secret: true,
    });
    const emit = vi.fn();

    await resolveCredentialsVia("run-leak", "https://x.test", ["username", "password"] as any, emit, order);

    const emitted = JSON.stringify(emit.mock.calls);
    for (const canary of [
      "leak-canary@example.com", "leak-canary-password",
      "typed-canary@example.com", "typed-canary-password",
    ]) {
      expect(emitted).not.toContain(canary);
    }
  });
});
