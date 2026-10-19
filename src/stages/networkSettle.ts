import type { Page, Request } from "playwright";

/**
 * "Has this page really finished loading?" — the wait before a discovery snapshot or a screen
 * capture. Discovery upgrade Phase 1, behind `NETWORK_SETTLE_ENABLED` (default off; README).
 *
 * Salesforce (and any SPA) keeps fetching after the DOM looks ready: a list or a form's fields
 * arrive from an Apex / UI API call a second or two after `domcontentloaded`, so a snapshot taken
 * at the call sites' fixed 800 ms models half a page. `networkidle` is NOT the answer and is
 * avoided on purpose across this codebase (liveExtend.ts, generator.ts): Salesforce holds a CometD
 * long-poll open, so the network is never idle and the wait always runs to its timeout.
 *
 * So this counts in-flight fetch/XHR requests itself and IGNORES the long-lived ones, the approach
 * Copado's open-source QWeb engine takes for Lightning (docs/research/.../salesforce_specialists.md
 * §2): a request is long-lived if it is a streaming / long-poll endpoint by URL or by its Bayeux
 * body (`"connectionType":"long-polling"`), or simply if it has been open longer than
 * LONG_LIVED_MS. The page counts as settled once none of the rest have been in flight for
 * QUIET_MS, capped at CAP_MS. Best-effort, like waitForScreenSettle: at the cap it returns and the
 * snapshot proceeds; nothing here ever fails a run.
 *
 * A tracker only sees requests that START after it is attached, so call `trackNetwork(page)` as
 * soon as the page exists (before its first `goto`). It is idempotent per page.
 */

export function networkSettleEnabled(): boolean {
  return process.env.NETWORK_SETTLE_ENABLED === "true";
}

/** Open longer than this and a request is treated as a background stream, not page content. */
export const LONG_LIVED_MS = 3000;
const QUIET_MS = 500;
const CAP_MS = 5000;
const POLL_MS = 100;

/** Streaming / push endpoints by URL. Product protocols (CometD/Bayeux, SSE, long-poll), never a
 *  site's own paths. */
const LONG_LIVED_URL = /\/cometd\b|\/streaming\b|long-?poll|\/eventsource\b|\/sse\b|\/socket(?:\.io)?\b/i;

function isLongLivedByShape(r: Request): boolean {
  if (LONG_LIVED_URL.test(r.url())) return true;
  try {
    return /"connectionType"\s*:\s*"long-polling"/.test(r.postData() ?? "");
  } catch {
    return false;
  }
}

export interface NetworkTracker {
  /** Requests that count right now: fetch/XHR, not long-lived by shape, open < LONG_LIVED_MS. */
  pending(): number;
  /** How many requests were set aside as long-lived (by shape or by age) so far. */
  ignored(): number;
}

/**
 * ONE tracker per page: a second call returns the first tracker, so the listeners are attached
 * once and nothing is counted twice, however many call sites attach (the crawl attaches at page
 * creation, the snapshot again). Keyed weakly, so a closed and unreferenced page takes its tracker
 * and listeners with it; `close` also clears the tracker's own state at once.
 */
const trackers = new WeakMap<Page, NetworkTracker>();

export function trackNetwork(page: Page): NetworkTracker {
  const existing = trackers.get(page);
  if (existing) return existing;
  // Only requests still being counted are held; one that ages out is dropped and only counted,
  // so a long crawl past a held-open stream does not accumulate Request objects.
  const startedAt = new Map<Request, number>();
  let ignoredCount = 0;
  page.on("request", (r) => {
    const type = r.resourceType();
    if (type !== "fetch" && type !== "xhr") return;
    if (isLongLivedByShape(r)) { ignoredCount++; return; }
    startedAt.set(r, Date.now());
  });
  const done = (r: Request) => { startedAt.delete(r); };
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  page.once("close", () => { startedAt.clear(); trackers.delete(page); });
  const tracker: NetworkTracker = {
    pending() {
      const now = Date.now();
      for (const [r, t] of startedAt) {
        if (now - t >= LONG_LIVED_MS) { startedAt.delete(r); ignoredCount++; }
      }
      return startedAt.size;
    },
    ignored: () => ignoredCount,
  };
  trackers.set(page, tracker);
  return tracker;
}

export interface SettleResult {
  /** True when the quiet window was reached; false when the cap was hit first. */
  settled: boolean;
  waitedMs: number;
  /** Long-lived requests set aside (by URL/body shape or by age), cumulative for the page. */
  ignoredLongLived: number;
}

/** Wait until no counted request has been in flight for `quietMs`, at most `capMs`. */
export async function waitForNetworkSettle(
  page: Page, quietMs = QUIET_MS, capMs = CAP_MS,
): Promise<SettleResult> {
  const tracker = trackNetwork(page);
  const start = Date.now();
  let idleSince = tracker.pending() === 0 ? start : 0;
  while (Date.now() - start < capMs) {
    if (tracker.pending() === 0) {
      if (!idleSince) idleSince = Date.now();
      if (Date.now() - idleSince >= quietMs) {
        return { settled: true, waitedMs: Date.now() - start, ignoredLongLived: tracker.ignored() };
      }
    } else {
      idleSince = 0;
    }
    await page.waitForTimeout(POLL_MS);
  }
  return { settled: false, waitedMs: Date.now() - start, ignoredLongLived: tracker.ignored() };
}

/** Spinners and busy regions: ARIA's own, plus the Lightning Design System's spinner class (a
 *  product class, not org data). */
const BUSY_SELECTOR =
  '[role="progressbar"]:visible, [aria-busy="true"]:visible, .slds-spinner:visible, .slds-spinner_container:visible';
const CONTROL_SELECTOR =
  'input:visible, select:visible, textarea:visible, button:visible, [role="combobox"]:visible, [role="textbox"]:visible';

/**
 * Wait until no spinner is visible and the number of visible controls is the same on two polls in
 * a row, bounded by `budgetMs`. Locator counts only — no `page.evaluate`, so nothing here can trip
 * TD-40's `__name` trap under tsx. Best-effort: on timeout it returns and the capture proceeds.
 * (Moved here from liveExtend.ts, which re-exports it, so domDiscovery can use it without an
 * import cycle.)
 */
export async function waitForScreenSettle(page: Page, budgetMs = 6000, pollMs = 250): Promise<void> {
  const deadline = Date.now() + budgetMs;
  let last = -1;
  let stableFor = 0;
  while (Date.now() < deadline) {
    const busy = await page.locator(BUSY_SELECTOR).count().catch(() => 0);
    const controls = await page.locator(CONTROL_SELECTOR).count().catch(() => 0);
    if (busy === 0 && controls === last) {
      if (++stableFor >= 2) return;
    } else {
      stableFor = 0;
    }
    last = controls;
    await page.waitForTimeout(pollMs);
  }
}

/**
 * The full Phase 1 wait before a snapshot: the network first (the data that will build the page),
 * then the DOM (the render that follows it). Logs one line, so a live run shows what it cost.
 */
export async function settleBeforeSnapshot(page: Page, where: string): Promise<SettleResult> {
  const net = await waitForNetworkSettle(page);
  await waitForScreenSettle(page);
  console.log(
    `[settle] ${where}: network ${net.settled ? "quiet" : "capped"} after ${net.waitedMs}ms`
    + (net.ignoredLongLived ? `, ${net.ignoredLongLived} long-lived request(s) ignored` : ""),
  );
  return net;
}
