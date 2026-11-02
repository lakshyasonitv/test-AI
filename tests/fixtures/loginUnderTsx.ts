/**
 * Run by tests/twoScreenLoginUnderTsx.test.ts as `node --import tsx` — the transform the real
 * server (`npm run serve`) uses. NOT a vitest file.
 *
 * Why it exists (TD-40): esbuild, which tsx runs, wraps named functions in a `__name()` helper.
 * Inside a `page.evaluate` callback that helper does not exist in the browser, so the evaluate
 * throws `ReferenceError: __name is not defined` — on a real server only. vitest's transform does
 * not inject the helper, so no vitest test can see it. This script drives the live login code's
 * page.evaluate calls (identifier-first detection, loginOnPage's two screens, the verification-code
 * screen detector, the session check) under tsx and prints one JSON line with the outcome.
 *
 * It used to drive them through `checkSalesforceLogin` (src/server/salesforceLogin.ts, D-49), a
 * "Check login" module the server never mounted. That module was removed on 2026-11-02; this now
 * calls the same live functions directly, in the order that module did.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { chromiumLaunchOptions, browserContextOptions } from "../../src/browserLaunch.js";
import { hasLoginGate, loginOnPage, verifySession, waitForLoginGateToClear } from "../../src/stages/hybridDiscovery.js";
import { waitForAuthSettle } from "../../src/stages/authSettle.js";
import { codeEntryField } from "../../src/stages/salesforceOrgLogin.js";

/** The code the fake verification screen accepts. */
const CODE = "123456";

const login = `<!doctype html><html><body><form id="f">
<input type="hidden" name="passwordShown" value="false">
<label for="username">Username</label><input id="username" type="email" autocomplete="username">
<input type="submit" id="Login" value="Log In to Sandbox"></form>
<script>
document.getElementById("f").addEventListener("submit", function (e) {
  e.preventDefault();
  var pw = document.getElementById("password");
  if (!pw) { setTimeout(function () { var p = document.createElement("input"); p.type = "password"; p.id = "password";
    document.getElementById("f").insertBefore(p, document.getElementById("Login")); }, 200); return; }
  if (pw.value === "pw") location.href = "http://login.test/verify";
});
</script></body></html>`;

const verify = `<!doctype html><html><body><form id="v">
<input id="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6"><button type="submit">Verify</button></form>
<script>
document.getElementById("v").addEventListener("submit", function (e) {
  e.preventDefault();
  if (document.getElementById("code").value === ${JSON.stringify(CODE)}) location.href = "http://app.test/home";
});
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", `http://${req.headers.host}`);
  res.writeHead(200, { "content-type": "text/html" });
  if (u.hostname === "app.test") return res.end("<h1>Home</h1>");
  if (u.pathname === "/verify") return res.end(verify);
  res.end(login);
});

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  process.env.CHROMIUM_EXTRA_ARGS = `--proxy-server=http://127.0.0.1:${port}`;
  process.env.AUTH_VERIFY_TIMEOUT_MS = "2500";

  const out: Record<string, unknown> = {};
  // The shared launch options, so the proxy above applies exactly as it does to discovery's browser.
  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const page = await (await browser.newContext(browserContextOptions())).newPage();
    await page.goto("http://login.test/", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    out.gate = await hasLoginGate(page);              // identifier-first detection
    const gateUrl = page.url();
    await loginOnPage(page, { username: "qa@example.com", password: "pw", secret: true });
    const cleared = await waitForLoginGateToClear(page);
    const code = await codeEntryField(page);          // the verification-code screen detector
    if (code) {
      await page.locator("input").nth(code.inputIndex).fill(CODE);
      if (code.submitIndex >= 0) await page.locator('button[type="submit"], input[type="submit"]').nth(code.submitIndex).click();
      else await page.locator("input").nth(code.inputIndex).press("Enter");
      await waitForAuthSettle(page);
    }
    const ok = cleared && !!code && await verifySession(page, gateUrl);
    const landed = new URL(page.url());
    out.check = { ok, codeScreen: !!code, landedUrl: landed.origin + landed.pathname };
  } finally {
    await browser.close();
  }
  console.log("RESULT " + JSON.stringify(out));
}

main()
  .catch((err) => console.log("RESULT " + JSON.stringify({ error: String(err?.message ?? err) })))
  .finally(() => server.close());
