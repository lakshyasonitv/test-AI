/**
 * Run by tests/twoScreenLoginUnderTsx.test.ts as `node --import tsx` — the transform the real
 * server (`npm run serve`) uses. NOT a vitest file.
 *
 * Why it exists (TD-40): esbuild, which tsx runs, wraps named functions in a `__name()` helper.
 * Inside a `page.evaluate` callback that helper does not exist in the browser, so the evaluate
 * throws `ReferenceError: __name is not defined` — on a real server only. vitest's transform does
 * not inject the helper, so no vitest test can see it. This script drives every page.evaluate the
 * two-screen login added (D-45/D-46/D-49) under tsx and prints one JSON line with the outcome.
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { chromium } from "playwright";
import { hasLoginGate } from "../../src/stages/hybridDiscovery.js";
import { checkSalesforceLogin, totpCode } from "../../src/server/salesforceLogin.js";

const SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

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

const verify = (codes: string[]) => `<!doctype html><html><body><form id="v">
<input id="code" autocomplete="one-time-code" inputmode="numeric" maxlength="6"><button type="submit">Verify</button></form>
<script>
document.getElementById("v").addEventListener("submit", function (e) {
  e.preventDefault();
  if (${JSON.stringify(codes)}.indexOf(document.getElementById("code").value) >= 0) location.href = "http://app.test/home";
});
</script></body></html>`;

const server = http.createServer((req, res) => {
  const u = new URL(req.url ?? "/", `http://${req.headers.host}`);
  res.writeHead(200, { "content-type": "text/html" });
  if (u.hostname === "app.test") return res.end("<h1>Home</h1>");
  if (u.pathname === "/verify") {
    const now = Date.now();
    return res.end(verify([totpCode(SECRET, now - 30_000), totpCode(SECRET, now), totpCode(SECRET, now + 30_000)]));
  }
  res.end(login);
});

async function main(): Promise<void> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  process.env.CHROMIUM_EXTRA_ARGS = `--proxy-server=http://127.0.0.1:${port}`;
  process.env.AUTH_VERIFY_TIMEOUT_MS = "2500";

  const out: Record<string, unknown> = {};
  // identifierFirstFields' evaluate, alone.
  const browser = await chromium.launch({ args: [`--proxy-server=http://127.0.0.1:${port}`] });
  const page = await browser.newPage();
  await page.goto("http://login.test/");
  out.gate = await hasLoginGate(page);
  await browser.close();
  // Every evaluate together: identifier-first detection, loginOnPage's two screens, the code screen.
  out.check = await checkSalesforceLogin({
    loginUrl: "http://login.test/", username: "qa@example.com", password: "pw", totpSecret: SECRET,
  });
  console.log("RESULT " + JSON.stringify(out));
}

main()
  .catch((err) => console.log("RESULT " + JSON.stringify({ error: String(err?.message ?? err) })))
  .finally(() => server.close());
