import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import {
  checkSalesforceLogin,
  totpCode,
  type LoginFailureReason,
  type SalesforceLoginResult,
} from "../src/server/salesforceLogin.js";

/**
 * checkSalesforceLogin, EXECUTED end to end in a real Chromium (D-49).
 *
 * One local server plays two hosts — `login.test` (the org's login page) and `app.test` (where a
 * successful sign-in lands) — reached through Chromium's `--proxy-server`, supplied the way every
 * deployment supplies browser flags: `CHROMIUM_EXTRA_ARGS`, read by `chromiumLaunchOptions()`. So
 * each check below goes through the real shared launch path and a genuine cross-host sign-in.
 *
 * The login page reproduces Salesforce's real first screen (fetched for D-45): a username box
 * `type="email" autocomplete="username"`, a `type="submit"` labelled "Log In to Sandbox", the hidden
 * `passwordShown` input, and no password box until the username is submitted.
 */

const USER = "qa@example.com";
const MFA_USER = "mfa@example.com";
const PASS = "right-pw-7f3a";
// RFC 6238's own seed ("12345678901234567890"), base32.
const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const SESSION = "SESSION-ID-must-not-leak";

const loginPage = `<!doctype html><html><body>
<form id="f">
  <input type="hidden" name="passwordShown" value="false">
  <label for="username">Username</label>
  <input id="username" name="username" type="email" autocomplete="username">
  <input type="submit" id="Login" value="Log In to Sandbox">
</form>
<script>
  document.getElementById("f").addEventListener("submit", function (e) {
    e.preventDefault();
    var user = document.getElementById("username").value;
    var pw = document.getElementById("password");
    if (!pw) {
      if (user !== ${JSON.stringify(USER)} && user !== ${JSON.stringify(MFA_USER)}) return;
      setTimeout(function () {
        var p = document.createElement("input");
        p.type = "password"; p.id = "password";
        document.getElementById("f").insertBefore(p, document.getElementById("Login"));
      }, 300);
      return;
    }
    if (pw.value !== ${JSON.stringify(PASS)}) return;
    location.href = user === ${JSON.stringify(MFA_USER)}
      ? "http://login.test/verify"
      : "http://app.test/home?sid=${SESSION}";
  });
</script></body></html>`;

const verifyPage = (codes: string[]) => `<!doctype html><html><body>
<form id="v">
  <label for="code">Verification Code</label>
  <input id="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6">
  <button type="submit">Verify</button>
</form>
<script>
  document.getElementById("v").addEventListener("submit", function (e) {
    e.preventDefault();
    if (${JSON.stringify(codes)}.indexOf(document.getElementById("code").value) >= 0) {
      location.href = "http://app.test/home?sid=${SESSION}";
    }
  });
</script></body></html>`;

const appPage = `<!doctype html><html><body><h1>Home</h1><a href="/accounts">Accounts</a></body></html>`;

let server: http.Server;
let port = 0;
const savedEnv = { args: process.env.CHROMIUM_EXTRA_ARGS, verify: process.env.AUTH_VERIFY_TIMEOUT_MS };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://${req.headers.host}`);
    const html = (body: string, status = 200) => { res.writeHead(status, { "content-type": "text/html" }); res.end(body); };
    if (u.hostname === "login.test" && u.pathname === "/") return html(loginPage);
    if (u.hostname === "login.test" && u.pathname === "/verify") {
      // The codes an authenticator would show now, and one step either side of it.
      const now = Date.now();
      return html(verifyPage([totpCode(SECRET, now - 30_000), totpCode(SECRET, now), totpCode(SECRET, now + 30_000)]));
    }
    if (u.hostname === "login.test" && u.pathname === "/plain") return html(appPage);
    if (u.hostname === "app.test") return html(appPage);
    if (u.hostname === "gone.test") return html("<h1>Not here</h1>", 404);
    req.socket.destroy(); // an address with nothing behind it
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  port = (server.address() as AddressInfo).port;
  process.env.CHROMIUM_EXTRA_ARGS = `--proxy-server=http://127.0.0.1:${port}`;
  // The verify/clear polls default to 10s; the failure paths below would sit that out.
  process.env.AUTH_VERIFY_TIMEOUT_MS = "2500";
}, 30_000);

afterAll(async () => {
  for (const [k, v] of [["CHROMIUM_EXTRA_ARGS", savedEnv.args], ["AUTH_VERIFY_TIMEOUT_MS", savedEnv.verify]] as const) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  await new Promise<void>((r) => server.close(() => r()));
});

const check = (over: Partial<Parameters<typeof checkSalesforceLogin>[0]> = {}) =>
  checkSalesforceLogin({ loginUrl: "http://login.test/", username: USER, password: PASS, ...over });

/** No result may carry a secret anywhere — detail, landedUrl, or any field added later. */
const noSecrets = (r: SalesforceLoginResult) => {
  const s = JSON.stringify(r);
  expect(s).not.toContain(PASS);
  expect(s).not.toContain(SECRET);
  expect(s).not.toContain(SESSION);
};

describe("checkSalesforceLogin — signs in", () => {
  it("a two-screen login that lands on another host: ok, with the landing page as evidence", async () => {
    const r = await check();
    expect(r).toMatchObject({ ok: true, landedUrl: "http://app.test/home" });
    expect(r.reason).toBeUndefined();
    noSecrets(r); // the ?sid= on the landing URL is cut off
  }, 60_000);

  it("enters the authenticator code from totpSecret when the org asks for one", async () => {
    const r = await check({ username: MFA_USER, totpSecret: SECRET });
    expect(r).toMatchObject({ ok: true, landedUrl: "http://app.test/home" });
    noSecrets(r);
  }, 60_000);
});

describe("checkSalesforceLogin — names the exact failure", () => {
  const cases: [string, Parameters<typeof check>[0], LoginFailureReason][] = [
    ["a wrong password", { password: "wrong" }, "bad-credentials"],
    ["a username the org refuses (the password box never appears)", { username: "nobody@example.com" }, "bad-credentials"],
    ["a verification code with no authenticator secret", { username: MFA_USER }, "verification-required"],
    ["an authenticator secret that is not this user's", { username: MFA_USER, totpSecret: "JBSWY3DPEHPK3PXP" }, "mfa-required"],
    ["an authenticator secret that is not base32", { username: MFA_USER, totpSecret: "not base32!" }, "mfa-required"],
    ["a login URL answering 404", { loginUrl: "http://gone.test/" }, "not-found"],
    ["a page with no login form", { loginUrl: "http://login.test/plain" }, "not-found"],
    ["an address with nothing behind it", { loginUrl: "http://nothing.test/" }, "not-found"],
    ["a private address — the same SSRF guard as POST /api/runs", { loginUrl: "http://127.0.0.1:9/" }, "not-found"],
  ];
  for (const [name, over, reason] of cases) {
    it(name, async () => {
      const r = await check(over);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(reason);
      expect(r.detail && r.detail.length).toBeTruthy();
      noSecrets(r);
    }, 60_000);
  }

  it("redacts the password even when the detail would quote it", async () => {
    // The not-found detail quotes the URL it could not open — here one that carries the password,
    // as a pasted link sometimes does. Without redactCredentials this detail would contain it.
    const r = await check({ loginUrl: `http://nothing.test/?pw=${PASS}` });
    expect(r.reason).toBe("not-found");
    expect(r.detail).toContain("nothing.test");
    expect(JSON.stringify(r)).not.toContain(PASS);
  }, 60_000);
});

describe("totpCode — RFC 6238's own test vectors (SHA-1, 8 digits)", () => {
  for (const [seconds, want] of [[59, "94287082"], [1111111109, "07081804"], [1111111111, "14050471"],
    [1234567890, "89005924"], [2000000000, "69279037"]] as const) {
    it(`T=${seconds} -> ${want}`, () => {
      expect(totpCode(SECRET, seconds * 1000, 8)).toBe(want);
    });
  }

  it("defaults to the 6 digits an authenticator shows, and ignores spaces, padding and case", () => {
    expect(totpCode("gezd gnbv gy3t qojq gezd gnbv gy3t qojq==", 59_000)).toBe("287082");
  });

  it("refuses a secret that is not base32", () => {
    expect(() => totpCode("not base32!")).toThrow();
  });
});

describe("the contract's types (unchanged since the stub landed)", () => {
  it("every LoginFailureReason is a valid `reason`", () => {
    // Listed in full so adding or removing a member breaks this test as well as the other stream's
    // build — the file's header comment says a change here must be announced first.
    const reasons: LoginFailureReason[] = [
      "bad-credentials", "verification-required", "mfa-required", "not-found", "timeout", "unknown",
    ];
    const results: SalesforceLoginResult[] = reasons.map((reason) => ({ ok: false, reason }));
    expect(results.map((r) => r.reason)).toEqual(reasons);
  });
});
