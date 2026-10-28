import type { Page } from "playwright";
import { currentFrontdoor } from "./salesforceFrontdoor.js";
import { currentRunTargetApp } from "../runTarget.js";

/**
 * `SALESFORCE_FIXED_LOGIN` (D-65) — the fixed Salesforce login for GENERATED TESTS. Default off.
 * Registered in `BOOLEAN_ENV_FLAGS`. Off, every compile and every spec is exactly what it was.
 */
export function salesforceFixedLoginEnabled(): boolean {
  return process.env.SALESFORCE_FIXED_LOGIN === "true";
}

/** A ticked Salesforce run with the fixed login switched on. The one gate every D-65 path reads. */
export function fixedLoginRun(): boolean {
  // Not on an org-connection run (D-63): it signs in through frontdoor.jsp with no password form, so
  // there is no recorded password login to fix — its own `auth-*` prefix must stay as it is.
  return salesforceFixedLoginEnabled() && currentRunTargetApp() === "salesforce" && !currentFrontdoor();
}

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
  // D-70: a portal / public-site address of an org is refused with a sentence that says what it is,
  // instead of "doesn't look like" a Salesforce org — it IS one, just not the app Testbench tests.
  const parsed = parseSalesforceHost(host);
  if (parsed && (parsed.purpose === "portal" || parsed.purpose === "sites")) {
    const login = `${parsed.myDomain}${parsed.partition ? "." + parsed.partition : ""}.my.salesforce.com`;
    return `${host} is a Salesforce ${parsed.purpose === "portal" ? "Experience Cloud portal" : "public Site"} address. `
      + `Testbench tests the Salesforce app itself — use your org's login address instead, e.g. https://${login}/`;
  }
  // D-68: with SALESFORCE_ALLOW_ALL_ORGS on, any Salesforce host is accepted — production, Developer
  // Edition, login./test.salesforce.com, cs## hosts. Still a structural check on the host: a URL
  // that is not served by Salesforce at all is refused as before (the box was ticked by mistake).
  if (salesforceAllOrgsAllowed() && isSalesforceHost(host)) return null;
  const why = kind === "production"
    ? "It is a production My Domain (a *.my.salesforce.com address with no .scratch. or .sandbox. in it)."
    : "Only addresses containing .scratch. or .sandbox. under salesforce.com or force.com are accepted, "
      + "so login.salesforce.com, test.salesforce.com, cs##.salesforce.com, Developer Edition orgs and "
      + "custom domains are refused for now.";
  return `Testbench only runs against Salesforce scratch orgs and sandboxes. ${host} doesn't look like either. ${why}`;
}

/**
 * `SALESFORCE_ALLOW_ALL_ORGS` (D-68) — accept every Salesforce org, not only scratch orgs and
 * sandboxes. Default off: the guard is then exactly D-64's. Registered in `BOOLEAN_ENV_FLAGS`.
 */
export function salesforceAllOrgsAllowed(): boolean {
  return process.env.SALESFORCE_ALLOW_ALL_ORGS === "true";
}

/** Throws `orgRefusal`'s sentence. Called before discovery opens any page, so a refused org is
 *  never visited at all — the run fails at its discovery stage with this message.
 *
 *  D-68: an org let through only because SALESFORCE_ALLOW_ALL_ORGS is on is said out loud in the
 *  server log, once per call — a test run creates and changes records in the org it tests. */
export function assertTestOrg(url: string): void {
  const refusal = orgRefusal(url);
  if (refusal) throw new OrgRefusedError(refusal);
  const warning = orgWarning(url);
  if (warning) console.warn(`[salesforce] SALESFORCE_ALLOW_ALL_ORGS is on: ${warning.message}`);
}

/**
 * Thrown by `assertTestOrg`. A refusal is a decision about the address the person entered, not a
 * fault in Testbench, so it is marked structurally (`orgRefused`) for the run's error event — the
 * screen then does not add "a problem on our side" to it (D-70).
 */
export class OrgRefusedError extends Error {
  readonly orgRefused = true;
}

// ---------------------------------------------------------------------------------------------
// Salesforce host names (D-70)
// ---------------------------------------------------------------------------------------------

/** What a Salesforce host name is for. From Salesforce's "My Domain URL Formats" /
 *  "Partitioned Domains" tables (enhanced domains — enforced in every org since Winter '24;
 *  redirects from the older formats ended Winter '25 / Spring '26). */
export type SalesforcePurpose = "login" | "lightning" | "setup" | "files" | "visualforce" | "portal" | "sites";

/** Longest suffix first, so `my.salesforce-setup.com` is never read as something shorter. */
const PURPOSE_SUFFIXES: Array<[string, SalesforcePurpose]> = [
  ["my.salesforce-setup.com", "setup"],
  ["my.salesforce-sites.com", "sites"],
  ["my.salesforce.com", "login"],
  ["lightning.force.com", "lightning"],
  ["file.force.com", "files"],
  ["vf.force.com", "visualforce"],
  ["my.site.com", "portal"],
];

/** The partition word Salesforce puts after the My Domain name, by org type. Production has none. */
const PARTITIONS = new Set(["scratch", "sandbox", "develop", "patch", "demo", "trailblaze"]);

export interface SalesforceHost {
  /** The org's My Domain name, sandbox suffix included (`acme--uat`), package suffix removed. */
  myDomain: string;
  /** "scratch" | "sandbox" | "develop" | … , or "" for a production org. */
  partition: string;
  purpose: SalesforcePurpose;
}

/**
 * Read an org-specific Salesforce host name as (My Domain name, partition, purpose), or null when it
 * is not one (a shared Salesforce host such as `b.static.lightning.force.com`, or any other site).
 *
 *   ruby-data-2200-dev-ed.scratch.lightning.force.com  -> ruby-data-2200-dev-ed | scratch | lightning
 *   acme--uat.sandbox.my.salesforce.com                -> acme--uat | sandbox | login
 *   acme--c.vf.force.com                               -> acme | "" | visualforce
 *
 * Pure string work on the host — the same three parts Salesforce documents for every host.
 */
export function parseSalesforceHost(hostOrUrl: string): SalesforceHost | null {
  let host = hostOrUrl.toLowerCase();
  try { if (host.includes("/")) host = new URL(hostOrUrl).hostname.toLowerCase(); } catch { return null; }
  for (const [suffix, purpose] of PURPOSE_SUFFIXES) {
    if (!host.endsWith("." + suffix)) continue;
    const labels = host.slice(0, -(suffix.length + 1)).split(".");
    let partition = "";
    if (labels.length === 2 && PARTITIONS.has(labels[1])) partition = labels.pop()!;
    if (labels.length !== 1 || !labels[0]) return null;
    let myDomain = labels[0];
    // Visualforce hosts carry a package name after the last "--" (MyDomainName--PackageName).
    if (purpose === "visualforce") {
      const cut = myDomain.lastIndexOf("--");
      if (cut <= 0) return null;
      myDomain = myDomain.slice(0, cut);
    }
    return { myDomain, partition, purpose };
  }
  return null;
}

/** The app's own purposes: one login hands its session across all of these (seen in a real login:
 *  my.salesforce.com -> file.force.com -> lightning.force.com). Portals and public Sites are other
 *  applications of the same org, and are not included. */
const APP_PURPOSES = new Set<SalesforcePurpose>(["login", "lightning", "setup", "files", "visualforce"]);

/**
 * True when both URLs are the SAME org's Salesforce app: same My Domain name and partition, each on
 * one of the app's host names. Another org, a portal, or any non-Salesforce host is false.
 */
export function sameSalesforceApp(a: string, b: string): boolean {
  const pa = parseSalesforceHost(a);
  const pb = parseSalesforceHost(b);
  if (!pa || !pb) return false;
  return pa.myDomain === pb.myDomain && pa.partition === pb.partition
    && APP_PURPOSES.has(pa.purpose) && APP_PURPOSES.has(pb.purpose);
}

/**
 * D-70: true when a fixed-login Salesforce test checks nothing after logging in — every assertion
 * after the leading `auth-*` steps is on one of the login form's own controls (the selectors the
 * login used), or there is no assertion after it at all. Such a test proves only that login works.
 *
 * Structural only: the IR's step ids, actions and verified selectors — never a title or step text
 * (CLAUDE.md, TD-01). Only for IRs `toIR` marked `fixedLogin: "salesforce"`; everything else is false.
 */
export function onlyChecksLogin(ir: { meta: { fixedLogin?: string }; steps: Array<{ id: string; action: string; target?: { css?: string } }> } | null | undefined): boolean {
  if (!ir || ir.meta?.fixedLogin !== "salesforce") return false;
  let i = 0;
  const loginSelectors = new Set<string>();
  for (; i < ir.steps.length && /^auth-\d+$/.test(ir.steps[i].id); i++) {
    const css = ir.steps[i].target?.css;
    if (css) loginSelectors.add(css);
  }
  if (i === 0) return false;
  const checks = ir.steps.slice(i).filter((s) => s.action === "assert");
  return checks.every((s) => !!s.target?.css && loginSelectors.has(s.target.css));
}

/** What the person running a test is told about the org: kind, host, and one sentence. */
export interface OrgWarning {
  kind: "production" | "other";
  host: string;
  message: string;
}

/**
 * D-68: the warning for a Salesforce org that is NOT a scratch org or a sandbox, or null.
 *
 * Decided from the URL alone (`classifyOrg` + `isSalesforceHost`), so the server log, the discovery
 * event the screen reads, and the HTML report all say the same thing without storing anything new.
 * Not gated on SALESFORCE_ALLOW_ALL_ORGS: with that flag off such an org is refused before
 * discovery, so no event or report for it ever reaches a reader of this function.
 */
export function orgWarning(url: string): OrgWarning | null {
  const kind = classifyOrg(url);
  if (kind === "scratch" || kind === "sandbox") return null;
  const host = hostOf(url);
  if (!isSalesforceHost(host)) return null;
  return kind === "production"
    ? { kind: "production", host, message: `${host} is a PRODUCTION Salesforce org. Generated tests may create or change real records there.` }
    : { kind: "other", host, message: `${host} is not a Salesforce scratch org or sandbox. Generated tests may create or change real records there.` };
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
