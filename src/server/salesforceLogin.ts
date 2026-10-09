/**
 * Salesforce login check — log in once, headlessly, and say exactly what happened (D-49).
 *
 * Behind the "Check" button on an org connection. Nothing in the server calls it yet; the route
 * belongs to the org-settings stream.
 *
 * THE SIGNATURE IS A CONTRACT. Another stream builds against these exact types: the function name,
 * the `opts` fields and their optionality, every `SalesforceLoginResult` field, and every member of
 * `LoginFailureReason` (a caller may switch on it exhaustively, so ADDING a member is a change too).
 * Changing any of it requires telling that stream first — not after the type error shows up on
 * their branch. `totpCode` below is an extra export for tests, not part of that contract.
 *
 * NOTHING HERE IS SPECIFIC TO ONE ORG. Production, sandbox, scratch, developer, custom domain: the
 * login is found and driven by the same live-DOM code discovery uses (`hasLoginGate`,
 * `loginOnPage`, `verifySession`), which handles both one-screen logins and the two-screen kind
 * Salesforce serves, where the password box appears only after the username is sent (D-45/D-46).
 *
 * WHY EACH REASON IS DECIDED BY STRUCTURE, never by reading the page's words (CLAUDE.md's central
 * rule): a login form still on screen after submitting is `bad-credentials`; a lone code-shaped
 * input with no login form is a verification step; anything that cannot be told apart is
 * `unknown`, with the page it stopped on. Salesforce's own error wording is never parsed.
 *
 * SECRETS. `password` and `totpSecret` stay in memory for one check: every `detail` goes through
 * `redactCredentials` and has the TOTP secret stripped, and `landedUrl` is cut to origin + path,
 * because a sign-in redirect can carry a session id in its query string (`sid=`). Never logged,
 * never written under runs/ (CLAUDE.md platform rule 5, TD-14).
 *
 * TD-40: every `page.evaluate` callback here is written with nothing named inside it — esbuild,
 * which tsx and so the real server run, wraps named functions in a `__name()` helper the browser
 * does not have, and vitest never shows it.
 */

import crypto from "node:crypto";
import { chromium, type Browser, type Page } from "playwright";
import { chromiumLaunchOptions, browserContextOptions } from "../browserLaunch.js";
import {
  hasLoginGate, isAllowedEntryUrl, loginOnPage, verifySession, waitForLoginGateToClear,
} from "../stages/hybridDiscovery.js";
import { waitForAuthSettle } from "../stages/authSettle.js";
import { redactCredentials, type Credentials } from "../stages/credentials.js";

export type LoginFailureReason =
  | "bad-credentials" | "verification-required" | "mfa-required"
  | "not-found" | "timeout" | "unknown";

export interface SalesforceLoginResult {
  ok: boolean;
  reason?: LoginFailureReason;
  /** Human-readable, safe to render in a browser. Never contains the password. */
  detail?: string;
  /** Where the browser actually ended up — the evidence for `ok`. */
  landedUrl?: string;
}

/** Navigation budget for the login page itself — the same 30s discovery gives an entry page. */
const NAV_TIMEOUT_MS = 30_000;

export async function checkSalesforceLogin(opts: {
  loginUrl: string;
  username: string;
  password: string;
  totpSecret?: string;
}): Promise<SalesforceLoginResult> {
  // `secret: true` is what makes redactCredentials redact at all — without it it is a no-op, and
  // a detail quoting a URL that carries the password went out verbatim (caught by a test).
  const creds: Credentials = { username: opts.username, password: opts.password, secret: true };
  // Every human-readable string leaves through here: it is rendered in a browser.
  const safe = (text: string): string => {
    let out = redactCredentials(text, creds);
    if (opts.totpSecret) out = out.split(opts.totpSecret).join("[redacted]");
    return out;
  };
  const fail = (reason: LoginFailureReason, detail: string, page?: Page): SalesforceLoginResult => ({
    ok: false, reason, detail: safe(detail), ...(page ? { landedUrl: originAndPath(page.url()) } : {}),
  });

  // The server opens this URL, and an admin typed it: the same SSRF guard POST /api/runs applies.
  const allowed = isAllowedEntryUrl(opts.loginUrl);
  if (!allowed.ok) return fail("not-found", `Not checked: ${allowed.reason}`);

  let browser: Browser | null = null;
  try {
    // The shared launch and context options, so this browser presents exactly what every other
    // browser this server opens does (browserLaunch.ts explains why that matters).
    browser = await chromium.launch(chromiumLaunchOptions());
    const context = await browser.newContext(browserContextOptions());
    const page = await context.newPage();

    let status: number | null = null;
    try {
      const res = await page.goto(opts.loginUrl, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      status = res?.status() ?? null;
    } catch (err) {
      return isTimeout(err)
        ? fail("timeout", `Timed out opening ${opts.loginUrl}.`)
        : fail("not-found", `Could not open ${opts.loginUrl}: ${firstLine(err)}`);
    }
    if (status === 404 || status === 410) {
      return fail("not-found", `${opts.loginUrl} answered HTTP ${status}.`, page);
    }
    // The settle discovery gives a page before deciding whether it is a login gate.
    await page.waitForTimeout(800);
    if (!(await hasLoginGate(page))) {
      return fail("not-found", `No login form was found at ${originAndPath(page.url())}.`, page);
    }
    const gateUrl = page.url();

    await loginOnPage(page, creds);
    // Still a login form after submitting — the password box (or, two-screen, the username box).
    if (!(await waitForLoginGateToClear(page))) {
      return fail("bad-credentials", "Still on the login form after submitting: the username or password " +
        "was not accepted.", page);
    }

    let code = await codeEntryField(page);
    if (code) {
      if (!opts.totpSecret) {
        return fail("verification-required", "The username and password were accepted, but the org asked " +
          "for a verification code (from email, a text message or an authenticator app). Add this " +
          "server's outgoing IP address as a trusted IP in the org, or supply the user's authenticator " +
          "secret.", page);
      }
      let otp: string;
      try {
        otp = totpCode(opts.totpSecret);
      } catch {
        return fail("mfa-required", "The authenticator secret supplied is not valid base32, so no code " +
          "could be generated from it.", page);
      }
      await page.locator("input").nth(code.inputIndex).fill(otp, { timeout: 10_000 });
      if (code.submitIndex >= 0) {
        await page.locator('button[type="submit"], input[type="submit"]').nth(code.submitIndex).click({ timeout: 10_000 });
      } else {
        await page.locator("input").nth(code.inputIndex).press("Enter");
      }
      await waitForAuthSettle(page);
      code = await codeEntryField(page);
      if (code) {
        return fail("mfa-required", "A code generated from the supplied authenticator secret was not " +
          "accepted. Check the secret belongs to this user's authenticator registration.", page);
      }
    }

    if (await verifySession(page, gateUrl)) {
      return { ok: true, detail: safe("Signed in."), landedUrl: originAndPath(page.url()) };
    }
    return fail("unknown", "The login form went away, but the session did not survive reloading the page " +
      "it landed on.", page);
  } catch (err) {
    return isTimeout(err)
      ? fail("timeout", `Timed out during sign-in: ${firstLine(err)}`)
      : fail("unknown", `The check failed: ${firstLine(err)}`);
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * A verification-code screen: exactly one visible, enabled text-entry input, no password box, no
 * username box, and that input is CODE-SHAPED by its attributes — `autocomplete="one-time-code"`,
 * a numeric `inputmode`, `type` tel/number, or a `maxlength` of 4–10. Structure only.
 *
 * Returns indexes, not selectors: the result is used once, right here, and never recorded or
 * replayed, so a positional handle is enough and needs none of loginOnPage's selector ladder.
 */
async function codeEntryField(page: Page): Promise<{ inputIndex: number; submitIndex: number } | null> {
  // Nothing named inside this callback — TD-40 (see the file header).
  return await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll("input"));
    let idx = -1;
    let entries = 0;
    for (let i = 0; i < inputs.length; i++) {
      const el = inputs[i];
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["text", "email", "tel", "number", "search", "url", "password"].indexOf(type) < 0) continue;
      if (el.disabled) continue;
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden")) continue;
      entries++;
      idx = i;
    }
    if (entries !== 1) return null;
    const el = inputs[idx];
    const type = (el.getAttribute("type") || "text").toLowerCase();
    if (type === "password" || type === "email") return null;
    const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    if (autocomplete.indexOf("username") >= 0) return null;
    const inputmode = (el.getAttribute("inputmode") || "").toLowerCase();
    const maxlength = Number(el.getAttribute("maxlength") || "0");
    const codeShaped = autocomplete.indexOf("one-time-code") >= 0
      || inputmode === "numeric" || inputmode === "decimal"
      || type === "tel" || type === "number"
      || (maxlength >= 4 && maxlength <= 10);
    if (!codeShaped) return null;

    const scope: ParentNode = el.closest("form") ?? document;
    const submit = scope.querySelector('button[type="submit"], input[type="submit"]');
    const allSubmits = Array.from(document.querySelectorAll('button[type="submit"], input[type="submit"]'));
    return { inputIndex: idx, submitIndex: submit ? allSubmits.indexOf(submit) : -1 };
  });
}

/**
 * RFC 6238 time-based one-time password: HMAC-SHA1 over the 30-second step counter, dynamic
 * truncation, `digits` decimal digits — what every authenticator app shows. `secret` is base32
 * (RFC 4648), the form an authenticator QR code carries; spaces, padding and case are ignored.
 * Throws on anything that is not base32.
 *
 * Exported for tests (RFC 6238's own vectors pin it). NOT part of the contract above.
 */
export function totpCode(secret: string, nowMs: number = Date.now(), digits = 6, periodSeconds = 30): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const clean = secret.replace(/[\s=]/g, "").toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean)) throw new Error("secret is not base32");
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    buffer = (buffer << 5) | alphabet.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      bytes.push((buffer >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMs / 1000 / periodSeconds)));
  const hmac = crypto.createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(binary % 10 ** digits).padStart(digits, "0");
}

/** Origin + path only: a sign-in redirect can carry a session id in its query (`sid=`). */
function originAndPath(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return "";
  }
}

function isTimeout(err: unknown): boolean {
  return (err as { name?: string })?.name === "TimeoutError";
}

/** The first line of an error's message — Playwright appends a multi-line call log. */
function firstLine(err: unknown): string {
  return String((err as { message?: string })?.message ?? err).split("\n")[0].trim();
}
