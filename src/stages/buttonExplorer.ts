import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium, type Page, type Locator } from "playwright";
import { chromiumLaunchOptions, browserContextOptions } from "../browserLaunch.js";
import { AppModel, type PageModel } from "../schema/appModel.js";
import type { Credentials } from "./credentials.js";
import { extractDomModelFromPage } from "./domDiscovery.js";
import { settleBeforeSnapshot, trackNetwork } from "./networkSettle.js";
import { screenFingerprint, screenElements, sameScreen, type ScreenFingerprint } from "./screens.js";
import {
  screenMapEnabled, screenFromPage, recordIntoScreenMap,
  type ScreenMapControl, type ScreenMapEdge, type ScreenMapScreen,
} from "./screenMap.js";
import { SCREEN_CONTROL_ROLES } from "./ir.js";
import { loginOnPage } from "./hybridDiscovery.js";
import { currentRunTargetApp } from "../runTarget.js";
import { currentRunId } from "../runContext.js";
import { scrubRunSecrets } from "../runSecrets.js";
import { pageKey } from "../text.js";

/**
 * Discovery upgrade Phase 5: the SAFE button explorer (`BUTTON_EXPLORER_ENABLED`, default off;
 * `EXPLORER_MAX_CLICKS`, default 15; `EXPLORER_BUDGET_MS`, default 120 000). README; DECISIONS D-60.
 *
 * After discovery, click SAFE controls to find screens that only a click reveals (a tab, a "New"
 * dialog, a "View" page), and add them to what the test writer sees:
 * - a click that lands on a NEW same-origin URL adds that page's real snapshot to the app model;
 * - on a Salesforce run with the screen map on, every screen seen (new URL or same-URL dialog/step)
 *   and the click that opened it go into the stored screen map, as HINTS (D-54), never grounding.
 *
 * SAFETY IS DETERMINISTIC, never the model's call (WebGuard: frontier models miss most HIGH-risk
 * actions; docs/research/.../academic_exploration.md §5):
 * 1. DENY always wins: a destructive or committing name (delete, remove, submit, save, send, pay,
 *    confirm, approve, reject, log out, publish, purchase, …), a submit button inside a <form>, a
 *    link that leaves the site's origin.
 * 2. ALLOW, structure first: `role=tab`, `aria-haspopup`, `aria-expanded`; otherwise only a short
 *    list of navigational names (New, Next, Back, View, Open, Show, More, Details, Explore, Expand).
 *    Anything else is skipped and logged.
 * 3. A NETWORK guard while exploring: any non-GET NAVIGATION (a real form post) is aborted. Non-GET
 *    fetch/XHR cannot be blocked wholesale: Salesforce Aura and many SPAs read data over POST.
 * 4. Never types. After each click: settle (Phase 1), capture, record, RESTORE (Escape, a dialog's
 *    Close, Back, reload) and check the original screen is back before the next click; a screen
 *    that cannot be restored is abandoned.
 * Every click made and every control skipped (with the reason) goes to `runs/<id>/explorer.json`.
 */
export function buttonExplorerEnabled(): boolean {
  return process.env.BUTTON_EXPLORER_ENABLED === "true";
}
const intEnv = (name: string, dflt: number) => {
  const n = Number(process.env[name] ?? dflt);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : dflt;
};
export const explorerMaxClicks = () => intEnv("EXPLORER_MAX_CLICKS", 15);
const explorerBudgetMs = () => intEnv("EXPLORER_BUDGET_MS", 120_000);
/** Pages explored per run (discovered pages first, then new ones found, breadth first). */
const MAX_PAGES = 4;
/** New URL pages a run's exploration may add to the app model. */
const MAX_NEW_PAGES = 3;

const DENY_NAME = new RegExp(
  "\\b(delete|remove|submit|save|send|pay|payment|purchase|buy|checkout|check out|confirm|approve|reject"
  + "|log ?out|sign ?out|publish|place order|order now|add to (cart|bag|basket)|register|sign ?up|subscribe"
  + "|unsubscribe|reset|clear|cancel|discard|archive|deactivate|disable|transfer|withdraw|upload|download)\\b", "i");
const ALLOW_NAME = /^(new|next|back|previous|prev|view|open|show|more|details|explore|expand|see|browse)\b/i;
const CLICK_ROLES = new Set(["button", "tab", "link", "menuitem"]);

export interface ControlFacts {
  role: string; name: string;
  /** Read live from the element (one evaluate, TD-40): */
  submitInForm?: boolean; external?: boolean; hasPopup?: boolean; expandable?: boolean;
  /** Inside a Salesforce Screen Flow (`lightning-flow` / `flowruntime-*`), walked up through shadow roots. */
  inFlow?: boolean;
  /** The page is a Salesforce Lightning APP (an internal org), not an Experience Cloud site. */
  lightningApp?: boolean;
}

/**
 * A Salesforce Lightning app, i.e. an internal org (`*.lightning.force.com`, `*.my.salesforce.com`,
 * `/lightning/...`), as opposed to an Experience Cloud site (`*.my.site.com`, `/s/...`). On an org, "Next" and
 * "Finish" drive Screen Flows and wizards that can COMMIT records between screens over Aura/LWC POSTs, which the
 * network guard cannot tell from reads. Structure of the URL, never page text.
 */
export function isLightningAppUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return /\.lightning\.force\.com$/i.test(u.hostname) || /\.my\.salesforce\.com$/i.test(u.hostname)
      || u.pathname.startsWith("/lightning/");
  } catch {
    return false;
  }
}
export type Verdict = { click: true; why: string } | { click: false; why: string };

/** The policy, pure. Deny first, then structure, then the name allow-list. */
export function classifyControl(c: ControlFacts): Verdict {
  const name = c.name.trim();
  if (DENY_NAME.test(name)) return { click: false, why: "deny: destructive or committing name" };
  if (c.submitInForm) return { click: false, why: "deny: submit button inside a form" };
  if (c.external) return { click: false, why: "deny: leaves the site's origin" };
  // A Screen Flow's buttons move a flow that may create or update records: never, on any site.
  if (c.inFlow) return { click: false, why: "deny: inside a Salesforce Screen Flow" };
  if (c.lightningApp && /^(next|finish)\b/i.test(name)) return { click: false, why: "deny: Next/Finish on a Salesforce Lightning app" };
  if (c.role === "tab") return { click: true, why: "allow: tab" };
  if (c.hasPopup) return { click: true, why: "allow: aria-haspopup" };
  if (c.expandable) return { click: true, why: "allow: aria-expanded" };
  if (ALLOW_NAME.test(name)) return { click: true, why: "allow: navigational name" };
  return { click: false, why: "skip: not on the allow list" };
}

export interface ExplorerClick {
  page: string; role: string; name: string; why: string;
  outcome: "new-page" | "new-screen" | "no-change" | "left-origin" | "click-failed";
  to?: string; restored: "yes" | "no" | "n/a"; restoredBy?: string;
}
export interface ExplorerSkip { page: string; role: string; name: string; reason: string }
export interface ExplorerReport {
  enabled: true; maxClicks: number; budgetMs: number; durationMs: number;
  pagesExplored: string[]; clicks: ExplorerClick[]; skipped: ExplorerSkip[];
  newPages: string[]; screensRecorded: number; edgesRecorded: number; stoppedBecause?: string;
}

interface Snap { url: string; page: PageModel; fp: ScreenFingerprint }

async function snap(page: Page, where: string): Promise<Snap | null> {
  await settleBeforeSnapshot(page, where);
  const m = await extractDomModelFromPage(page, page.url(), { alreadySettled: true }).catch(() => null);
  const pm = m?.pages[0];
  if (!pm) return null;
  return { url: page.url(), page: pm, fp: screenFingerprint(pm) };
}

const controlsOf = (p: PageModel): ScreenMapControl[] => {
  const seen = new Set<string>();
  const out: ScreenMapControl[] = [];
  for (const e of screenElements(p.elements)) {
    if (!e.name?.trim() || !SCREEN_CONTROL_ROLES.has(e.role.toLowerCase())) continue;
    const id = `${e.role}\u0000${e.name}\u0000${e.enabled === false}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ role: e.role, name: e.name, ...(e.enabled === false ? { enabled: false } : {}) });
  }
  return out;
};

const isSame = (a: Snap, b: Snap) => sameScreen({ url: a.url, fp: a.fp }, { url: b.url, fp: b.fp });

/** One evaluate, a single expression with no inner functions (TD-40). */
async function factsOf(loc: Locator, origin: string): Promise<Pick<ControlFacts, "submitInForm" | "external" | "hasPopup" | "expandable" | "inFlow">> {
  // One callback, no inner functions (TD-40). The flow check walks up THROUGH shadow roots (a shadow
  // root's host), because Lightning renders a flow's buttons inside nested components.
  return loc.evaluate((el, o) => {
    let inFlow = false;
    let n: any = el;
    for (let k = 0; k < 300 && n; k++) {
      const tg = String(n.tagName || "").toUpperCase();
      if (tg === "LIGHTNING-FLOW" || tg.indexOf("LIGHTNING-FLOW-") === 0 || tg.indexOf("FLOWRUNTIME-") === 0) { inFlow = true; break; }
      n = n.parentElement || (n.parentNode && n.parentNode.host) || null;
    }
    return {
      inFlow,
      submitInForm: !!el.closest("form") && (
        (el.tagName === "BUTTON" && ((el.getAttribute("type") || "submit").toLowerCase() === "submit"))
        || (el.tagName === "INPUT" && ["submit", "image"].includes(((el as HTMLInputElement).type || "").toLowerCase()))),
      external: el.tagName === "A" && !!(el as HTMLAnchorElement).href
        && !(el as HTMLAnchorElement).href.startsWith("javascript:")
        && new URL((el as HTMLAnchorElement).href, location.href).origin !== o,
      hasPopup: !!el.getAttribute("aria-haspopup") && el.getAttribute("aria-haspopup") !== "false",
      expandable: el.getAttribute("aria-expanded") === "false",
    };
  }, origin);
}

/** Put the page back where it was; true when `baseline` is the screen again. */
async function restore(page: Page, baseline: Snap, targetUrl: string): Promise<{ ok: boolean; by: string }> {
  const tries: Array<[string, () => Promise<unknown>]> = [
    ["Escape", () => page.keyboard.press("Escape")],
    ["dialog Close", async () => {
      const close = page.locator('[role="dialog"]:visible, [aria-modal="true"]:visible').last()
        .getByRole("button", { name: /^(close|×|x|dismiss)$/i });
      if (await close.count() === 1) await close.click({ timeout: 2000 });
    }],
    ["Back", () => page.goBack({ waitUntil: "domcontentloaded", timeout: 8000 })],
    ["reload", () => page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 15000 })],
  ];
  for (const [by, act] of tries) {
    // Escape and Close only make sense on the same URL (a dialog); Back only after a navigation.
    const sameUrl = pageKey(page.url()) === pageKey(baseline.url);
    if ((by === "Escape" || by === "dialog Close") && !sameUrl) continue;
    if (by === "Back" && sameUrl) continue;
    await act().catch(() => {});
    const now = await snap(page, "explorer restore");
    if (now && isSame(now, baseline)) return { ok: true, by };
  }
  return { ok: false, by: "none" };
}

/**
 * Explore `model`'s pages and return the model with any new same-origin pages appended. Never throws:
 * an explorer failure leaves discovery's model exactly as it was.
 */
export async function exploreButtons(
  model: AppModel, opts: { runDir?: string; creds?: Credentials } = {},
): Promise<{ model: AppModel; report: ExplorerReport }> {
  const started = Date.now();
  const report: ExplorerReport = {
    enabled: true, maxClicks: explorerMaxClicks(), budgetMs: explorerBudgetMs(), durationMs: 0,
    pagesExplored: [], clicks: [], skipped: [], newPages: [], screensRecorded: 0, edgesRecorded: 0,
  };
  const newPages: PageModel[] = [];
  const screens: ScreenMapScreen[] = [];
  const edges: Omit<ScreenMapEdge, "seen">[] = [];
  const now = new Date();
  const recordScreens = screenMapEnabled() && currentRunTargetApp() === "salesforce";
  let origin = "";
  try { origin = new URL(model.baseUrl).origin; } catch { /* no base url: nothing to explore */ }
  const browser = origin ? await chromium.launch(chromiumLaunchOptions()) : null;
  try {
    if (!browser) { report.stoppedBecause = "no base URL"; return { model, report }; }
    // One context, one page for the whole exploration: a session in sessionStorage survives only
    // on the same tab (TD-41 / D-23).
    const context = await browser.newContext(browserContextOptions());
    const page = await context.newPage();
    trackNetwork(page);
    if (model.auth?.status === "authenticated" && model.auth.loginUrl && opts.creds) {
      await page.goto(model.auth.loginUrl, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
      await loginOnPage(page, opts.creds).catch(() => null);
    }
    // The network guard (rule 3), installed after any login so the login's own post goes through.
    await page.route("**/*", (route) => {
      const r = route.request();
      if (r.isNavigationRequest() && r.method() !== "GET") return route.abort();
      return route.continue();
    });

    const known = new Set(model.pages.map((p) => pageKey(p.url)));
    const queue = model.pages.map((p) => ({ url: p.url, depth: 0 }));
    const explored = new Set<string>();
    const clickedHere = new Set<string>();
    const outOfBudget = () => {
      if (report.clicks.length >= report.maxClicks) { report.stoppedBecause = "EXPLORER_MAX_CLICKS reached"; return true; }
      if (Date.now() - started >= report.budgetMs) { report.stoppedBecause = "time budget reached"; return true; }
      return false;
    };

    while (queue.length && explored.size < MAX_PAGES && !outOfBudget()) {
      const target = queue.shift()!;
      if (explored.has(pageKey(target.url))) continue;
      explored.add(pageKey(target.url));
      try {
        await page.goto(target.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
      } catch { continue; }
      const baseline = await snap(page, "explorer baseline");
      if (!baseline) continue;
      report.pagesExplored.push(baseline.url);
      if (recordScreens) screens.push(screenFromPage({ ...baseline.page, screen: baseline.fp }, controlsOf(baseline.page), now));

      const candidates = baseline.page.elements.filter((e) =>
        CLICK_ROLES.has(e.role.toLowerCase()) && e.name?.trim() && e.visible !== false && e.enabled !== false);
      for (const el of candidates) {
        if (outOfBudget()) break;
        const id = `${pageKey(baseline.url)}\u0000${el.role}\u0000${el.name}`;
        if (clickedHere.has(id)) continue; // click once (Crawljax's clickOnce)
        clickedHere.add(id);
        const loc = el.css ? page.locator(el.css) : page.getByRole(el.role as any, { name: el.name, exact: true });
        if (await loc.count().catch(() => 0) !== 1) {
          report.skipped.push({ page: baseline.url, role: el.role, name: el.name, reason: "skip: not uniquely locatable" });
          continue;
        }
        const facts = await factsOf(loc, origin).catch(() => ({}));
        const verdict = classifyControl({ role: el.role.toLowerCase(), name: el.name, ...facts, lightningApp: isLightningAppUrl(baseline.url) });
        if (!verdict.click) {
          report.skipped.push({ page: baseline.url, role: el.role, name: el.name, reason: verdict.why });
          continue;
        }
        const click: ExplorerClick = { page: baseline.url, role: el.role, name: el.name, why: verdict.why, outcome: "no-change", restored: "n/a" };
        report.clicks.push(click);
        try {
          await loc.click({ timeout: 3000 });
        } catch {
          click.outcome = "click-failed";
          continue;
        }
        const after = await snap(page, "explorer click");
        if (!after) { click.outcome = "click-failed"; }
        else if (new URL(after.url).origin !== origin) { click.outcome = "left-origin"; click.to = after.url; }
        else if (pageKey(after.url) !== pageKey(baseline.url)) {
          click.outcome = "new-page"; click.to = after.url;
          if (!known.has(pageKey(after.url)) && newPages.length < MAX_NEW_PAGES) {
            known.add(pageKey(after.url));
            newPages.push(after.page);
            report.newPages.push(after.url);
          }
          if (target.depth < 1) queue.push({ url: after.url, depth: target.depth + 1 });
        } else if (!isSame(after, baseline)) {
          click.outcome = "new-screen"; click.to = after.fp.title || after.fp.key;
        }
        if (after && recordScreens && (click.outcome === "new-page" || click.outcome === "new-screen")) {
          screens.push(screenFromPage({ ...after.page, screen: after.fp }, controlsOf(after.page), now));
          edges.push({ from: baseline.fp.key, action: { role: el.role, name: el.name }, to: after.fp.key });
        }
        if (click.outcome !== "no-change") {
          const back = await restore(page, baseline, target.url);
          click.restored = back.ok ? "yes" : "no";
          click.restoredBy = back.by;
          if (!back.ok) { report.stoppedBecause = `could not restore ${baseline.url}; page abandoned`; break; }
        }
      }
    }
    await context.close().catch(() => {});
  } catch (err: any) {
    report.stoppedBecause = `explorer error: ${err?.message ?? err}`;
  } finally {
    await browser?.close().catch(() => {});
  }

  if (recordScreens && screens.length) {
    try {
      recordIntoScreenMap(model.baseUrl, opts.creds, screens, edges, now);
      report.screensRecorded = screens.length;
      report.edgesRecorded = edges.length;
    } catch (err: any) {
      console.log("[explorer] screen map: could not record:", err?.message ?? err);
    }
  }
  report.durationMs = Date.now() - started;
  const runId = currentRunId();
  if (opts.runDir) {
    try {
      mkdirSync(opts.runDir, { recursive: true });
      writeFileSync(path.join(opts.runDir, "explorer.json"),
        JSON.stringify(runId ? scrubRunSecrets(runId, report) : report, null, 2));
    } catch { /* the report is best-effort */ }
  }
  console.log(`[explorer] ${report.clicks.length} click(s), ${report.skipped.length} skipped, `
    + `${report.newPages.length} new page(s), ${report.screensRecorded} screen(s) / ${report.edgesRecorded} edge(s) recorded, `
    + `${report.durationMs}ms${report.stoppedBecause ? ` (${report.stoppedBecause})` : ""}`);
  const merged = newPages.length ? AppModel.parse({ ...model, pages: [...model.pages, ...newPages] }) : model;
  return { model: merged, report };
}
