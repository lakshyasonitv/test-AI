import type { Page } from "playwright";
import { currentRunTargetApp } from "../runTarget.js";

/**
 * Salesforce org login hardening — everything Salesforce-specific about SIGNING IN, in one file.
 *
 * Active only on a run where the person ticked "This URL is a Salesforce org"
 * (`currentRunTargetApp() === "salesforce"`, D-50), which itself exists only with
 * SALESFORCE_ENABLED on. Unticked, nothing here is called and discovery takes exactly the path it
 * took before this file existed — `salesforceRun()` below is the one gate every call site checks.
 *
 * WHAT THIS FILE DOES NOT DO: log in. `loginOnPage` (hybridDiscovery.ts, D-45/D-46) still fills
 * and submits the form and still RECORDS the steps it took, because those recorded steps are what
 * the generated spec replays to log each test case in (D-24). Replacing it here would leave the
 * generated tests unable to sign in. This file only prepares the page for it (the production
 * guard, the ad block, the email-first switch, the slow-form wait) and explains a failure after it.
 *
 * The name is deliberately not `salesforceLogin.ts`: `src/server/salesforceLogin.ts` (D-49) is a
 * different file with a contract another stream builds against.
 *
 * TD-40: every `page.evaluate` callback below has nothing named inside it. esbuild (what tsx, and
 * so the real server, runs) wraps named functions in a `__name()` helper the browser does not have,
 * and vitest never shows it.
 */

/** True on a run whose person ticked "This URL is a Salesforce org". The ONE gate for this file. */
export function salesforceRun(): boolean {
  return currentRunTargetApp() === "salesforce";
}

// ---------------------------------------------------------------------------------------------
// The production guard
// ---------------------------------------------------------------------------------------------

export type OrgKind = "scratch" | "sandbox" | "production" | "unknown";

/** Hosts Salesforce serves an org (or its login) from. A `.scratch.`/`.sandbox.` label anywhere
 *  else is not a Salesforce org, so it must not pass the guard by spelling alone. */
function isSalesforceHost(host: string): boolean {
  return host === "salesforce.com" || host.endsWith(".salesforce.com")
    || host === "force.com" || host.endsWith(".force.com")
    || host.endsWith(".salesforce-setup.com") || host.endsWith(".visualforce.com");
}

/**
 * What kind of org a URL points at, from its host alone — no browser, no network.
 *
 *   `.scratch.` in a Salesforce host  → scratch
 *   `.sandbox.` in a Salesforce host  → sandbox
 *   any other `*.my.salesforce.com`   → production
 *   anything else                     → unknown
 *
 * Deliberately narrow, and it FAILS CLOSED: Developer Edition (`.develop.`), `login.salesforce.com`,
 * `test.salesforce.com`, legacy `cs##.salesforce.com` hosts and custom My Domains all come back
 * "production" or "unknown" and are refused. That refuses some legitimate test orgs; the refusal
 * message names the host and says why, so a person with a real sandbox knows what happened.
 */
export function classifyOrg(url: string): OrgKind {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
  if (!isSalesforceHost(host)) return "unknown";
  if (host.includes(".scratch.")) return "scratch";
  if (host.includes(".sandbox.")) return "sandbox";
  if (host.endsWith(".my.salesforce.com")) return "production";
  return "unknown";
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return url;
  }
}

/**
 * Why this URL is refused, or null when it is a scratch org or a sandbox.
 *
 * Production AND unknown are refused: an unrecognised host is not a reason to proceed. A run
 * creates real records in the org it tests.
 */
export function orgRefusal(url: string): string | null {
  const kind = classifyOrg(url);
  if (kind === "scratch" || kind === "sandbox") return null;
  const host = hostOf(url);
  const why = kind === "production"
    ? "It is a production My Domain (a *.my.salesforce.com address with no .scratch. or .sandbox. in it)."
    : "Only addresses containing .scratch. or .sandbox. under salesforce.com or force.com are accepted, "
      + "so login.salesforce.com, test.salesforce.com, cs##.salesforce.com, Developer Edition orgs and "
      + "custom domains are refused for now.";
  return `Testbench only runs against Salesforce scratch orgs and sandboxes. ${host} doesn't look like either. ${why}`;
}

/** Throws `orgRefusal`'s sentence. Called before discovery opens any page, so a refused org is
 *  never visited at all — the run fails at its discovery stage with this message. */
export function assertTestOrg(url: string): void {
  const refusal = orgRefusal(url);
  if (refusal) throw new Error(refusal);
}

// ---------------------------------------------------------------------------------------------
// The ad block
// ---------------------------------------------------------------------------------------------

/** The one host blocked. Not `*.edgesuite.net`: that is Akamai's shared CDN, used by thousands of
 *  unrelated sites. Its name only appears in the error page Akamai returns when it refuses
 *  `c.salesforce.com` — block that request and there is no refusal and no error page. */
export const SALESFORCE_AD_HOST = "c.salesforce.com";

/**
 * Abort every request to `c.salesforce.com` on this page.
 *
 * WHY HERE AND NOT IN browserLaunch.ts: the shared browser setup applies to every run, so a block
 * there would change unticked runs too. Registered on discovery's one shared page (sharedPage(),
 * D-23), it covers the whole crawl of a Salesforce run and nothing else.
 */
export async function blockLoginAds(page: Page): Promise<void> {
  await page.route((url) => url.hostname === SALESFORCE_AD_HOST, (route) => route.abort());
}

// ---------------------------------------------------------------------------------------------
// Getting to the username form
// ---------------------------------------------------------------------------------------------

/** How long to keep looking for the username form. Salesforce's first screen can redirect once or
 *  twice and render late; 20s covers that without hiding a page that never shows a form. */
export const REACH_FORM_BUDGET_MS = 20_000;
/** Pause after clicking the switch link: long enough for its screen swap to start, short enough
 *  that the loop asks the page again almost at once. */
const AFTER_SWITCH_CLICK_MS = 500;
/** Gap between two looks at the page while waiting for the form to render. */
const POLL_MS = 250;

const SWITCH_LINK = /log in with username/i;
const USERNAME_BOX = '#username, input[name="username"]';
const PASSWORD_BOX = '#password, input[name="pw"], input[type="password"]';

/**
 * Bring the username form on screen, whichever first screen Salesforce chose to show.
 *
 * The first screen VARIES — the same org shows a different one on different visits, because the
 * choice depends on cookies — so the page is asked again on every pass rather than identified once.
 *
 * WHY THE SWITCH LINK IS CHECKED BEFORE THE USERNAME BOX: on the email-first screen the EMAIL box
 * may also carry `id="username"`. Checking the username box first would type a Salesforce username
 * into an email field and be refused for an invalid email address. A visible "Log In with Username"
 * control is the one reliable sign that this is NOT yet the form we want. (Matching the link's
 * label is how a control to CLICK is found, like `AUTH_VERB_TEXT` for submit buttons; no outcome is
 * ever decided from page wording.)
 *
 * Throws, naming where it stopped, when no username form appears within the budget.
 */
export async function reachUsernameForm(page: Page, budgetMs: number = REACH_FORM_BUDGET_MS): Promise<void> {
  const deadline = Date.now() + budgetMs;
  const switchLink = page.getByText(SWITCH_LINK).first();
  const usernameBox = page.locator(USERNAME_BOX).first();
  while (Date.now() < deadline) {
    if (await switchLink.isVisible().catch(() => false)) {
      await switchLink.click({ timeout: 5_000 }).catch(() => {});
      await page.waitForTimeout(AFTER_SWITCH_CLICK_MS);
      continue;
    }
    if (await usernameBox.isVisible().catch(() => false)) return;
    await page.waitForTimeout(POLL_MS);
  }
  throw new Error(`No Salesforce username form appeared within ${Math.round(budgetMs / 1000)}s. Still at ${originAndPath(page.url())}.`);
}

/** How long a one-screen form gets to draw its password box. */
export const ONE_SCREEN_GRACE_MS = 2_500;

/**
 * Give a one-screen login form time to draw its password box before `loginOnPage` decides which
 * kind of login this is. Resolves true when the box appeared (one screen), false when it did not
 * (two screens — or a one-screen form slower than the grace period).
 *
 * WHY WAIT 2500ms RATHER THAN CHECK ONCE: `loginOnPage` decides one-screen vs two-screen with a
 * single instant `count()` of password boxes. On a slow page that instant can fall between the
 * username box rendering and the password box rendering, and the form is then treated as
 * two-screen. Waiting here, BEFORE `loginOnPage` runs, makes its instant check see the settled page
 * without changing `loginOnPage` itself — which every other site still uses exactly as before.
 */
export async function waitForOneScreenPassword(page: Page, graceMs: number = ONE_SCREEN_GRACE_MS): Promise<boolean> {
  return page.locator(PASSWORD_BOX).first().waitFor({ state: "visible", timeout: graceMs })
    .then(() => true).catch(() => false);
}

// ---------------------------------------------------------------------------------------------
// Explaining a failed login
// ---------------------------------------------------------------------------------------------

/**
 * A verification-code screen: exactly one visible, enabled text-entry input, no password box, no
 * username box, and that input is CODE-SHAPED by its attributes — `autocomplete="one-time-code"`,
 * a numeric `inputmode`, `type` tel/number, or a `maxlength` of 4–10. Structure only.
 *
 * Moved here from `src/server/salesforceLogin.ts` (D-49), which now imports it: discovery needs
 * the same detector, and a stage importing the server module that imports the stage would be an
 * import cycle. One definition, unchanged.
 *
 * Returns indexes, not selectors: the result is used once by its caller and never recorded or
 * replayed, so a positional handle is enough.
 */
export async function codeEntryField(page: Page): Promise<{ inputIndex: number; submitIndex: number } | null> {
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

export const LOGIN_FAILURE = {
  sso: (host: string) =>
    `The login left Salesforce for ${host}: this org signs in through single sign-on, which Testbench `
    + "can't drive. Use a user who logs in with a Salesforce username and password.",
  verification:
    "Salesforce asked for a verification code — it doesn't recognise this IP address. Add "
    + "0.0.0.0–255.255.255.255 to the Login IP Ranges on this user's profile, or run from an IP "
    + "address the org already knows.",
  passwordChange:
    "Salesforce wants this user's password changed before it lets them in. Log in once by hand, "
    + "set a new password, and run again.",
  badCredentials:
    "Still on the Salesforce login form after submitting: the username or password was not accepted.",
  sandboxHint:
    " Sandbox usernames are the production username plus the sandbox name, e.g. user@example.com.uat",
} as const;

/**
 * Why a Salesforce login did not establish a session, decided from the page's STRUCTURE where it
 * stopped — never from Salesforce's wording (CLAUDE.md's central rule, as D-49 does). Returns null
 * when the page matches none of these, and the caller keeps its own generic description.
 *
 * Checked in this order, most specific first:
 *   1. the address left every Salesforce host            → single sign-on
 *   2. one lone code-shaped input, no login form           → verification code
 *   3. two or more password boxes                          → forced password change
 *   4. a username or password box still on screen          → credentials not accepted
 *                                                            (+ the sandbox-username hint)
 */
export async function describeLoginFailure(page: Page, entryUrl: string): Promise<string | null> {
  const landedHost = hostOf(page.url());
  if (landedHost && !isSalesforceHost(landedHost)) return LOGIN_FAILURE.sso(landedHost);
  if (await codeEntryField(page).catch(() => null)) return LOGIN_FAILURE.verification;
  const passwordBoxes = await page.locator('input[type="password"]:visible').count().catch(() => 0);
  if (passwordBoxes >= 2) return LOGIN_FAILURE.passwordChange;
  const formStillThere = passwordBoxes > 0
    || await page.locator(USERNAME_BOX).first().isVisible().catch(() => false);
  if (formStillThere) {
    return LOGIN_FAILURE.badCredentials + (classifyOrg(entryUrl) === "sandbox" ? LOGIN_FAILURE.sandboxHint : "");
  }
  return null;
}

/** Origin + path only: a sign-in redirect can carry a session id in its query (`sid=`). */
function originAndPath(url: string): string {
  try {
    const u = new URL(url);
    return u.origin + u.pathname;
  } catch {
    return url;
  }
}
