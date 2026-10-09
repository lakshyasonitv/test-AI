import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { rmSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import {
  codeEntryField, submitVerificationCode, loginOnPage, verifySession,
} from "../src/stages/hybridDiscovery.js";
import { askQuestion, settleQuestion } from "../src/server/pendingQuestions.js";
import {
  withRunSession, setRunSession, currentRunSession, runSessionContextOptions, runSessionCacheDimension,
  specSessionEnv, sessionFromEnv, SESSION_ENV, type SessionState,
} from "../src/runSession.js";
import { runSpec } from "../src/stages/executor.js";

/**
 * Run questions and the session they unlock (DECISIONS.md D-51).
 *
 * The fixture site is the Salesforce shape that motivated this: a two-screen login (username, then
 * password) followed by a "verify your identity" screen wanting a one-time code — and a browser
 * that has passed the code once is TRUSTED afterwards, by a cookie, so it is not asked again. That
 * trust cookie is what the kept session carries to the later browsers. Real Chromium throughout
 * (D-19): every claim here is about what a browser actually does with a stored session.
 *
 * Local server only: no network, no LLM, no real credentials. Salesforce's own trust rules cannot
 * be exercised here; this pins the mechanism, not Salesforce's policy.
 */

const USER = "qa@example.com";
const PASS = "right-pw";
const CODE = "424242";
const SESSION = "sid=ok";
const TRUSTED = "device=trusted";

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`;

const LOGIN = page(`
<form method="POST" action="/login">
  <input id="username" name="username" type="email" autocomplete="username">
  <input type="submit" id="Login" value="Log In to Sandbox">
</form>`);
const PASSWORD = (user: string) => page(`
<form method="POST" action="/password">
  <input type="hidden" name="username" value="${user}">
  <input id="password" name="pw" type="password">
  <input type="submit" id="Login" value="Log In">
</form>`);
const VERIFY = page(`
<h1>Verify your identity</h1>
<form method="POST" action="/verify">
  <input id="emc" name="emc" type="text" inputmode="numeric" maxlength="6">
  <input type="submit" value="Verify">
</form>`);
const HOME = page(`<h1>Home</h1><a href="/accounts">Accounts</a>`);

function body(req: http.IncomingMessage): Promise<URLSearchParams> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => resolve(new URLSearchParams(raw)));
  });
}

function makeServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = (req.url ?? "/").split("?")[0];
    const cookies = req.headers.cookie ?? "";
    const html = (b: string, headers: Record<string, string | string[]> = {}) => {
      res.writeHead(200, { "Content-Type": "text/html", ...headers });
      res.end(b);
    };
    if (url === "/" || url === "/login") {
      if (req.method === "POST") return html(PASSWORD((await body(req)).get("username") ?? ""));
      return html(LOGIN);
    }
    if (url === "/password" && req.method === "POST") {
      const f = await body(req);
      if (f.get("username") !== USER || f.get("pw") !== PASS) return html(PASSWORD(f.get("username") ?? ""));
      // A trusted browser goes straight in; an unknown one is asked for a code.
      if (cookies.includes(TRUSTED)) {
        res.writeHead(302, { Location: "/home", "Set-Cookie": `${SESSION}; Path=/` });
        return res.end();
      }
      return html(VERIFY);
    }
    if (url === "/verify" && req.method === "POST") {
      if ((await body(req)).get("emc") !== CODE) return html(VERIFY);
      res.writeHead(302, {
        Location: "/home",
        "Set-Cookie": [`${SESSION}; Path=/`, `${TRUSTED}; Path=/; Max-Age=86400`],
      });
      return res.end();
    }
    if (url === "/home" || url === "/accounts") {
      if (!cookies.includes(SESSION)) { res.writeHead(302, { Location: "/login" }); return res.end(); }
      return html(HOME);
    }
    res.writeHead(404); res.end();
  });
}

let server: http.Server;
let base: string;
let browser: Browser;

beforeAll(async () => {
  server = makeServer();
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browser = await chromium.launch();
  process.env.AUTH_VERIFY_TIMEOUT_MS = "2500";
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => server.close(() => r()));
  delete process.env.AUTH_VERIFY_TIMEOUT_MS;
});

const creds = { username: USER, password: PASS, secret: true as const };

/** Log in the way discovery does with RUN_QUESTIONS on, answering the code; return the session. */
async function loginAnsweringCode(): Promise<SessionState> {
  const context = await browser.newContext();
  const p = await context.newPage();
  await p.goto(base + "/login");
  const steps = await loginOnPage(p, creds);
  expect(steps).not.toBeNull();
  const field = await codeEntryField(p);
  expect(field).not.toBeNull();
  await submitVerificationCode(p, field!, CODE);
  expect(await verifySession(p, base + "/login")).toBe(true);
  const state = await context.storageState();
  await context.close();
  return state;
}

describe("the verification screen, in a real browser", () => {
  it("is recognised after a two-screen login, and a typed code gets past it", async () => {
    const state = await loginAnsweringCode();
    expect(state.cookies.map((c) => `${c.name}=${c.value}`)).toEqual(expect.arrayContaining([SESSION, TRUSTED]));
  }, 60_000);

  it("is not mistaken for anything on the login screens themselves", async () => {
    const p = await browser.newPage();
    await p.goto(base + "/login");
    // The username box is autocomplete="username" — never a code field.
    expect(await codeEntryField(p)).toBeNull();
    await p.close();
  }, 30_000);

  it("a fresh browser meets the code screen again — the problem the kept session solves", async () => {
    const p = await browser.newPage();
    await p.goto(base + "/login");
    await loginOnPage(p, creds);
    expect(await codeEntryField(p)).not.toBeNull();
    await p.close();
  }, 30_000);

  it("a browser started from the kept session logs in again WITHOUT being asked", async () => {
    const state = await loginAnsweringCode();
    // Exactly what liveExtend does: newPage with the session spread into its options.
    const options = await withRunSession(async () => {
      setRunSession(state);
      return runSessionContextOptions();
    });
    const p = await browser.newPage(options);
    await p.goto(base + "/login");
    await loginOnPage(p, creds);
    expect(await codeEntryField(p)).toBeNull();
    expect(new URL(p.url()).pathname).toBe("/home");
    await p.close();
  }, 60_000);
});

describe("the generated spec's runner picks the session up (playwright.config.ts)", () => {
  const runDir = path.join("runs", `test-run-session-${process.pid}`);
  afterEach(() => rmSync(runDir, { recursive: true, force: true }));

  // The D-19 check: not "the env var is set", but a real `playwright test` child process whose
  // browser arrives signed in. /home redirects to /login without the session cookie.
  it("a spec run with the kept session reaches a signed-in page directly", async () => {
    const state = await loginAnsweringCode();
    const spec = `import { test, expect } from "@playwright/test";
test("signed in", async ({ page }) => {
  await page.goto(${JSON.stringify(base + "/home")});
  await expect(page.locator("h1")).toHaveText("Home");
});
`;
    const withSession = await withRunSession(async () => {
      setRunSession(state);
      return runSpec(spec, runDir);
    });
    expect(withSession.passed).toBe(true);

    rmSync(runDir, { recursive: true, force: true });
    // Control: the same spec with no session lands on the login page and fails.
    const without = await runSpec(spec.replace(`toHaveText("Home")`, `toHaveText("Home", { timeout: 1500 })`), runDir);
    expect(without.passed).toBe(false);
  }, 180_000);
});

describe("runSession", () => {
  it("answers 'nothing' outside a run, and inside one until discovery sets a session", () => {
    expect(currentRunSession()).toBeNull();
    expect(runSessionContextOptions()).toEqual({});
    expect(runSessionCacheDimension()).toBeNull();
    expect(specSessionEnv()).toEqual({});
    withRunSession(() => {
      expect(runSessionContextOptions()).toEqual({});
      expect(runSessionCacheDimension()).toBeNull();
    });
  });

  it("setRunSession outside a run is a no-op, never a process-wide session", () => {
    setRunSession({ cookies: [], origins: [] });
    expect(currentRunSession()).toBeNull();
  });

  it("hands a session to the child as one env var, and reads it back", () => {
    const state: SessionState = { cookies: [{ name: "sid", value: "ok", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" }], origins: [] };
    const env = withRunSession(() => { setRunSession(state); return specSessionEnv(); });
    expect(Object.keys(env)).toEqual([SESSION_ENV]);
    expect(sessionFromEnv(env)).toEqual({ storageState: state });
  });

  it("a session too large for one env string is not passed at all — the spec logs in itself", () => {
    const big = "x".repeat(100 * 1024);
    const state: SessionState = { cookies: [], origins: [{ origin: "http://a", localStorage: [{ name: "k", value: big }] }] };
    expect(withRunSession(() => { setRunSession(state); return specSessionEnv(); })).toEqual({});
  });

  it("a malformed env value is ignored, never thrown — a throwing config fails every test", () => {
    expect(sessionFromEnv({ [SESSION_ENV]: "{not json" })).toEqual({});
    expect(sessionFromEnv({ [SESSION_ENV]: JSON.stringify({ nope: 1 }) })).toEqual({});
    expect(sessionFromEnv({})).toEqual({});
  });
});

describe("pendingQuestions", () => {
  it("parks until answered, and only the matching question id can answer it", async () => {
    let id = "";
    const answer = askQuestion({ runId: "r1", kind: "verification-code", url: "http://x" }, (q) => { id = q; });
    expect(id).not.toBe("");
    expect(settleQuestion("r1", "some-other-question", "111111")).toBe(false);
    expect(settleQuestion("r1", id, "424242")).toBe(true);
    await expect(answer).resolves.toBe("424242");
    // Already settled: a second answer is refused.
    expect(settleQuestion("r1", id, "424242")).toBe(false);
  });

  it("a new question for the same run releases the old one as skipped", async () => {
    let first = "";
    const a = askQuestion({ runId: "r2", kind: "verification-code", url: "http://x" }, (q) => { first = q; });
    let second = "";
    const b = askQuestion({ runId: "r2", kind: "verification-code", url: "http://x" }, (q) => { second = q; });
    await expect(a).resolves.toBeNull();
    expect(settleQuestion("r2", first, "1")).toBe(false);
    expect(settleQuestion("r2", second, "2")).toBe(true);
    await expect(b).resolves.toBe("2");
  });

  it("times out to null, so a run is never parked forever", async () => {
    process.env.QUESTION_WAIT_MS = "50";
    try {
      const a = askQuestion({ runId: "r3", kind: "verification-code", url: "http://x" }, () => {});
      await expect(a).resolves.toBeNull();
    } finally {
      delete process.env.QUESTION_WAIT_MS;
    }
  });
});
