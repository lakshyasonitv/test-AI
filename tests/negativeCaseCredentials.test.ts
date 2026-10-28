import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

// TD-156 follow-up. A "none"-policy case (most negative cases: security-*, empty-boundary, most
// invalid-input) compiled with `creds` undefined, so finalize skipped applyCredentials, whose first
// pass turns a fill of the user's REAL credential into the `${env:...}` reference. Run
// 2026-10-20T04-19-54-377Z-240a1566: SauceDemo's two negative cases typed the real password (read off
// the login page, which prints it) and it reached 04-ir.json and both spec copies. Now the run's
// credentials go in with the case's own policy; for "none" only that literal pass runs.
// The values below are canaries, not credentials.

const { geminiMock } = vi.hoisted(() => ({ geminiMock: vi.fn() }));
vi.mock("../src/llm/gemini.js", () => ({ gemini: geminiMock }));

const { toIR } = await import("../src/stages/ir.js");
const { generateSpec } = await import("../src/stages/generator.js");
const { runSpec } = await import("../src/stages/executor.js");
const { credentialEnvVars } = await import("../src/stages/credentials.js");
const { extractDomModelFromPage } = await import("../src/stages/domDiscovery.js");
const { chromiumLaunchOptions } = await import("../src/browserLaunch.js");

const RUN_CREDS = { username: "zz-canary-user", password: "zz-Canary-Pass-7391", secret: true };

// Says which password arrived, so a spec can assert the env reference really resolved at run time.
const LOGIN = `<!doctype html><html><head><title>Login</title></head><body data-pw="${RUN_CREDS.password}"><main>
<form onsubmit="return false">
  <label for="u">Username</label><input id="u">
  <label for="p">Password</label><input id="p" type="password">
  <button type="button" id="go">Login</button>
</form>
<p id="out" role="status" data-ok="The run's password arrived" data-bad="A different password arrived"></p>
<script>
document.getElementById("go").onclick = () => {
  const out = document.getElementById("out");
  out.textContent = document.getElementById("p").value === document.body.dataset.pw ? out.dataset.ok : out.dataset.bad;
};
</script></main></body></html>`;

let server: http.Server;
let base = "";
let model: any;
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/login")) res.end(LOGIN); else { res.statusCode = 404; res.end(""); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const page = await browser.newPage();
    await page.goto(base + "/login");
    model = await extractDomModelFromPage(page, base + "/login");
  } finally { await browser.close(); }
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
});

const saved = process.env.LLM_CACHE_VERSION;
beforeEach(() => { geminiMock.mockReset(); process.env.LLM_CACHE_VERSION = `test-negcreds-${Date.now()}-${Math.random()}`; });
afterEach(() => { if (saved === undefined) delete process.env.LLM_CACHE_VERSION; else process.env.LLM_CACHE_VERSION = saved; });

const reply = (ir: any) => ({ content: JSON.stringify(ir), usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 } });
const loginIr = (username: string, password: string) => ({
  meta: { feature: "Login", title: "Login", priority: "high", sourcePrompt: "p", baseUrl: base },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/login" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Username" }, value: username },
    { id: "s3", action: "fill", target: { role: "textbox", name: "Password" }, value: password },
    { id: "s4", action: "click", target: { role: "button", name: "Login" } },
    { id: "s5", action: "wait", value: "300" },
    { id: "s6", action: "assert", target: { text: "The run's password arrived" }, assertion: "visible" },
  ],
});
async function compile(category: string, title: string, username: string, password: string) {
  geminiMock.mockImplementation(async (_p: string, opts: any) =>
    /accessibility snapshot/i.test(opts?.systemInstruction ?? "")
      ? reply({ baseUrl: base, pages: [{ url: base, title: "", concepts: [], elements: [] }] })
      : reply(loginIr(username, password)));
  const testCase: any = { title, priority: "high", feature: "Login", steps: ["Try to log in"],
    expected: "The login is refused", category, generatedFrom: "upfront" };
  return (await toIR(testCase, model, `Test the login. ${Date.now()}-${Math.random()}`, base + "/login", undefined, RUN_CREDS)).ir;
}
const fillValue = (ir: any, id: string) => ir.steps.find((s: any) => s.id === id)?.value;

describe("a none-policy (negative) case never keeps the real credential as a literal", () => {
  it("the real password typed in a security case becomes ${env:TEST_PASSWORD}, in the IR and the spec", async () => {
    const ir = await compile("security-injection", "SQL injection attempt in username field", "' OR 1=1 --", RUN_CREDS.password);
    expect(fillValue(ir, "s3")).toBe("${env:TEST_PASSWORD}");
    expect(fillValue(ir, "s2")).toBe("' OR 1=1 --"); // the injection itself is the case's own value
    expect(JSON.stringify(ir)).not.toContain(RUN_CREDS.password);
    const spec = generateSpec(ir);
    expect(spec).toContain("process.env.TEST_PASSWORD");
    expect(spec).not.toContain(RUN_CREDS.password);
  }, 120_000);

  it("the real username and password in an empty-boundary case both become references", async () => {
    const ir = await compile("empty-boundary", "Log in with the real account but an empty captcha", RUN_CREDS.username, RUN_CREDS.password);
    expect(fillValue(ir, "s2")).toBe("${env:TEST_USERNAME}");
    expect(fillValue(ir, "s3")).toBe("${env:TEST_PASSWORD}");
  }, 120_000);

  it("a deliberately WRONG or EMPTY password is kept exactly as written", async () => {
    for (const [category, title] of [["security-injection", "SQL injection attempt in username field"],
      ["empty-boundary", "Log in with an empty password"]] as const) {
      for (const wrong of ["wrong_password", ""]) {
        const ir = await compile(category, title, "someone", wrong);
        // normalizeIR drops an empty `value` (it always has), so "" reads back as undefined: still
        // empty, and never the credential or its reference.
        expect(fillValue(ir, "s3") ?? "").toBe(wrong);
        expect(fillValue(ir, "s2")).toBe("someone");
      }
    }
  }, 240_000);
});

describe("at run time the reference resolves to the run's password (real Playwright run)", () => {
  // suiteRunner.ts:429 hands EVERY case's process the run's credentials, whatever the case's policy:
  //   let result = await runSpec(spec, caseDir, credentialEnvVars(runCreds));
  // This runs the spec of a none-policy case through the real executor the same way. Playwright only
  // finds specs under ./runs (playwright.config.ts testDir), so a short-lived folder is used there,
  // named to sort after every real run, and removed afterwards.
  const runDir = path.join("runs", `0000-negcreds-${process.pid}-${Date.now()}`);
  afterAll(() => rmSync(runDir, { recursive: true, force: true }));

  it("passes with the run's credentials in the env, and fails without them", async () => {
    const ir = await compile("security-injection", "SQL injection attempt in username field", "' OR 1=1 --", RUN_CREDS.password);
    expect(fillValue(ir, "s3")).toBe("${env:TEST_PASSWORD}");
    mkdirSync(runDir, { recursive: true });
    const spec = generateSpec(ir, path.join(runDir, "artifacts"));
    const withCreds = await runSpec(spec, runDir, credentialEnvVars(RUN_CREDS) as Record<string, string>);
    expect(withCreds.passed).toBe(true); // the page received the run's password
    const without = await runSpec(spec, runDir, {});
    expect(without.passed).toBe(false); // so it was the env var that carried it
  }, 300_000);
});
