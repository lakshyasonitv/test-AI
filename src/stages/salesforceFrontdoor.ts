import { AsyncLocalStorage } from "node:async_hooks";
import type { Page } from "playwright";

/**
 * The Salesforce org connection a run signs in with (SALESFORCE_OAUTH_ENABLED, D-63).
 *
 * WHY. A Salesforce org's login is the hardest page this product meets: two screens on one URL,
 * verification codes, MFA, SSO, passkeys. Typing a password into it is what truncated run
 * `2026-10-24T02-55-58-550Z-29189dcc` right before the password (TD-84's guard misfires on an
 * identifier-first login). With an OAuth connection the person signs in on Salesforce's own page,
 * once, and every browser this run opens is signed in through `frontdoor.jsp` instead — no form,
 * no password, no second screen.
 *
 * A RAIL, like runTarget.ts / runContext.ts / llmBudget.ts: discovery, the grounding replay
 * (liveExtend.ts) and the executor's child env all need the session, none of them is called by
 * the route that knows it, and AsyncLocalStorage keeps concurrent runs apart by construction.
 * Entered on EVERY run by the orchestrator, null for a run without a connection, so a run can
 * never inherit another's. Absent (null) means every consumer behaves exactly as before.
 *
 * THE URL IS A SECRET. `mint()` returns a URL that carries the org's access token. It is never
 * logged, emitted, saved, cached or put into a model: the IR and the spec carry FRONTDOOR_REF,
 * an env reference resolved at the last moment (here for the replay, executor.ts for the child).
 */
export interface FrontdoorSession {
  /** Opaque, random connection id. Never a token. */
  connectionId: string;
  /** The org's instance host (e.g. `acme--uat.sandbox.my.salesforce.com`) — safe to log. */
  instanceHost: string;
  /** A fresh signed-in frontdoor URL. Carries the access token: never log, emit, save or cache. */
  mint(): Promise<string>;
  /**
   * GET `<instance>/services/data/v62.0<path>` with the connection's token (in a header only), parsed
   * as JSON. Read-only by construction: there is no other verb. Throws a sentence with the HTTP status
   * and never the token. Optional so a test session can leave it out.
   */
  apiGet?(path: string): Promise<any>;
  /**
   * DELETE `<instance>/services/data/v62.0<path>`. Used by ONE caller only, the Phase D cleanup
   * (salesforceCleanup.ts), behind SALESFORCE_CLEANUP_ENABLED, and only on records the org confirms
   * the run itself created. Discovery never deletes. Throws a sentence with the HTTP status.
   */
  apiDelete?(path: string): Promise<void>;
}

/** The env name the generated spec reads the frontdoor URL from. */
export const FRONTDOOR_ENV = "SF_FRONTDOOR_URL";
/** What an IR step carries instead of the URL. Same `${env:...}` shape as credential fills. */
export const FRONTDOOR_REF = "${env:SF_FRONTDOOR_URL}";

export function isFrontdoorRef(u: unknown): boolean {
  return u === FRONTDOOR_REF;
}

const frontdoorContext = new AsyncLocalStorage<FrontdoorSession | null>();

/** Make `session` this run's connection for the rest of its async chain (orchestrator, every run). */
export function enterWithFrontdoor(session: FrontdoorSession | null): void {
  frontdoorContext.enterWith(session);
}

/** The scoped form, for tests and request handlers. */
export function withFrontdoor<T>(session: FrontdoorSession | null, fn: () => T): T {
  return frontdoorContext.run(session, fn);
}

/** This run's org connection, or null (no connection, or outside a run). */
export function currentFrontdoor(): FrontdoorSession | null {
  return frontdoorContext.getStore() ?? null;
}

/** An error message with the frontdoor URL and any `sid=` value taken out. */
export function withoutFrontdoorSecret(message: string, url?: string): string {
  let out = String(message);
  if (url) out = out.split(url).join("[frontdoor URL]");
  return out.replace(/sid=[^&\s"'<>)]+/gi, "sid=[redacted]");
}

/**
 * Sign `page` in through the org connection and wait until Salesforce has left frontdoor.
 * Returns where it landed, origin + path only (a query can carry a session id).
 *
 * Throws a sentence that names the org host and never the URL when it does not sign in. "Did not
 * sign in" is decided by structure: a visible password box after frontdoor means Salesforce showed
 * its login form instead of the app, i.e. the token was refused (expired or revoked).
 */
export async function openFrontdoor(page: Page, session: FrontdoorSession | null = currentFrontdoor()): Promise<string> {
  if (!session) {
    throw new Error("This step signs in through a Salesforce org connection, but the run has none. Connect the org and run again.");
  }
  const url = await session.mint();
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  } catch (err: any) {
    throw new Error(`Opening ${session.instanceHost} through its org connection failed: ${withoutFrontdoorSecret(err?.message ?? String(err), url).split("\n")[0]}`);
  }
  // frontdoor.jsp answers with a redirect chain into Lightning. Wait for whichever comes first: it
  // left frontdoor, or a password box appeared (a refused token shows the login form, possibly
  // without leaving the frontdoor URL — waiting for the URL alone then hangs the full timeout).
  const passwordBox = page.locator('input[type="password"]').first();
  await Promise.race([
    page.waitForURL((u) => !/frontdoor\.jsp/i.test(u.pathname), { timeout: 60_000 }),
    passwordBox.waitFor({ state: "visible", timeout: 60_000 }),
  ]).catch(() => { });
  await page.waitForLoadState("domcontentloaded").catch(() => { });
  const loginShown = await passwordBox.isVisible().catch(() => false);
  if (loginShown) {
    throw new Error(`The org connection for ${session.instanceHost} did not sign in: Salesforce showed its login form. The access may have expired or been revoked; connect the org again.`);
  }
  const landed = new URL(page.url());
  return landed.origin + landed.pathname;
}
