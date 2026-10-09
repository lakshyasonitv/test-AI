/**
 * Salesforce Lightning discovery probe — a STANDALONE, read-only measurement.
 *
 * WHY THIS EXISTS.
 * `src/stages/domDiscovery.ts:459` reads `page.content()` and parses it with cheerio
 * (`domExtract.ts:663`). Neither that path nor any other in `src/` descends a `shadowRoot` or an
 * iframe. So before anyone plans a fix, the question is how much of a real Lightning page that
 * actually misses — and the answer depends on whether the org runs in synthetic shadow mode (where
 * LWC renders into the light DOM, so cheerio sees almost everything) or in real shadow mode (where
 * components are genuinely shadow-rooted and cheerio sees almost none of them).
 *
 * This script touches no shipped file. It launches Chromium with the project's own
 * `chromiumLaunchOptions()` / `browserContextOptions()`, logs in with a direct fill/click (NOT
 * through `hybridDiscovery`'s gate detection, which is known broken on Salesforce), opens a record
 * page, and prints a markdown table:
 *
 *   1. elements extracted by the current cheerio path
 *   2. elements found by `document.querySelectorAll('*')` on the live DOM
 *   3. elements found by a walk that also descends `element.shadowRoot`
 *   4. same-origin iframes present, and element counts inside each
 *   5. whether the org runs synthetic shadow (`window.lwcRuntimeFlags`, or `lightning-*` tags with
 *      no real `shadowRoot`)
 *   6. for 20 sampled interactive elements, whether a boundary-free CSS selector resolves them
 *
 * STEP ZERO. It asserts it reached an authenticated page and ABORTS, loudly, if it did not. A
 * previous run against this org never got past the login page (`/secur/forgotpassword.jsp`) and the
 * pipeline still reported "no-gate"; a measurement taken on a login screen is worse than no
 * measurement, because it is a confident wrong answer.
 *
 * TD-40. The `page.evaluate` callbacks below contain NO inner named or const-assigned functions and
 * NO inline arrow functions — only plain expressions and `for` loops. `tsx` runs through esbuild,
 * which wraps named functions in a `__name(...)` call that does not exist in the browser, so a
 * factored-out helper throws `ReferenceError: __name is not defined` on the FIRST real run while
 * every unit test stays green (vitest's transform does not inject it). See
 * `hybridDiscovery.ts:833-844`.
 *
 * CREDENTIALS. Read from the environment only, never hardcoded. Every line this script prints is
 * passed through `scrub()`, which strips the username/password values, so the GitHub Actions log is
 * safe to be public.
 *
 * RUN.
 *   SF_ORG_URL=https://my-org.my.salesforce.com \
 *   SF_RECORD_URL=https://my-org.lightning.force.com/lightning/r/Account/<id>/view \
 *   SALESFORCE_USERNAME=... SALESFORCE_PASSWORD=... \
 *   node --import tsx scripts/salesforceDiscoveryProbe.ts
 */

import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { chromiumLaunchOptions, browserContextOptions } from "../src/browserLaunch.js";
import { extractDomModelFromPage } from "../src/stages/domDiscovery.js";

/** Everything the script echoes, with the two credential values removed. */
const SECRET_VALUES: string[] = [
  process.env.SALESFORCE_USERNAME ?? "",
  process.env.SALESFORCE_PASSWORD ?? "",
].filter((v) => v.length > 0);

function scrub(line: string): string {
  let out = line;
  for (const secret of SECRET_VALUES) out = out.split(secret).join("[redacted]");
  return out;
}

/** All script output goes through here, so nothing sensitive can reach stdout by accident. */
function out(line: string): void {
  console.log(scrub(line));
}

function fail(message: string): never {
  console.error(scrub(`PROBE ABORTED: ${message}`));
  process.exit(1);
}

/**
 * The numbers the in-page measurement returns. A plain data interface — not a function, so it is
 * erased at compile time and cannot trip TD-40.
 */
interface LiveDom {
  lightCount: number;
  walkCount: number;
  iframeTotal: number;
  sameOrigin: number;
  iframeCounts: number[];
  lwcPresent: boolean;
  syntheticFlag: string;
  lightningCount: number;
  lightningWithShadow: number;
  sampled: number;
  resolvable: number;
  reachable: number;
  sampledInShadow: number;
}

async function main(): Promise<void> {
  const orgUrl = (process.env.SF_ORG_URL ?? "").trim();
  const recordUrl = (process.env.SF_RECORD_URL ?? "").trim() || orgUrl;
  const username = process.env.SALESFORCE_USERNAME ?? "";
  const password = process.env.SALESFORCE_PASSWORD ?? "";

  if (!orgUrl) fail("SF_ORG_URL is not set.");
  if (!username || !password) {
    fail("SALESFORCE_USERNAME and/or SALESFORCE_PASSWORD are not set in the environment.");
  }
  if (!(process.env.SF_RECORD_URL ?? "").trim()) {
    out("NOTE: SF_RECORD_URL is not set — measuring the org URL itself, not a specific record page.");
  }

  const browser = await chromium.launch(chromiumLaunchOptions());
  try {
    const page = await browser.newPage(browserContextOptions());
    page.setDefaultTimeout(60_000);

    // ---------------------------------------------------------------------------------------------
    // Log in — direct fill/click, deliberately NOT hybridDiscovery's gate detection.
    // ---------------------------------------------------------------------------------------------
    out(`Opening ${orgUrl}`);
    await page.goto(orgUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

    const pwHandle = await page
      .waitForSelector('input[type="password"]', { timeout: 15_000, state: "visible" })
      .catch(() => null);

    if (pwHandle) {
      out("Login form detected — filling directly (no gate detection).");
      const idBox = page.locator("#username");
      const userBox = (await idBox.count()) > 0
        ? idBox.first()
        : page.locator('input[type="text"], input[type="email"]').first();
      await userBox.fill(username);
      await page.locator('input[type="password"]').first().fill(password);

      const loginBtn = page.locator("#Login");
      if ((await loginBtn.count()) > 0) {
        await loginBtn.first().click();
      } else {
        const submit = page.locator('button[type="submit"], input[type="submit"]');
        if ((await submit.count()) > 0) await submit.first().click();
        else await page.locator('input[type="password"]').first().press("Enter");
      }
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
      await page.waitForTimeout(3_000);
    } else {
      out("No password field on the entry page — assuming an existing session.");
    }

    // ---------------------------------------------------------------------------------------------
    // STEP ZERO — prove the login. Nothing below runs if this does not hold.
    // ---------------------------------------------------------------------------------------------
    const afterLoginUrl = page.url();
    const passwordStillVisible = await page
      .locator('input[type="password"]')
      .first()
      .isVisible()
      .catch(() => false);
    const looksLikeLogin =
      /forgotpassword/i.test(afterLoginUrl) ||
      /\/secur\//i.test(afterLoginUrl) ||
      /login\.salesforce\.com/i.test(afterLoginUrl) ||
      /\/login(\?|$|\/)/i.test(afterLoginUrl);

    out(`Final URL after login: ${afterLoginUrl}`);
    out(`Password field still visible: ${passwordStillVisible}`);

    if (passwordStillVisible || looksLikeLogin) {
      fail(
        `did not reach an authenticated page (url=${afterLoginUrl}, ` +
        `passwordFieldVisible=${passwordStillVisible}). Refusing to measure a login screen.`,
      );
    }

    // ---------------------------------------------------------------------------------------------
    // Open the record page (same tab, so the session carried by the login survives).
    // ---------------------------------------------------------------------------------------------
    if (recordUrl !== page.url()) {
      out(`Opening record page ${recordUrl}`);
      await page.goto(recordUrl, { waitUntil: "domcontentloaded", timeout: 60_000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
      // Lightning paints asynchronously well after networkidle; give the components a moment so
      // the measurement is not taken mid-render.
      await page.waitForTimeout(3_000);
    }

    const recordPasswordVisible = await page
      .locator('input[type="password"]').first().isVisible().catch(() => false);
    if (recordPasswordVisible) {
      fail(`the record page (${page.url()}) shows a password field — the session was lost.`);
    }

    const currentUrl = page.url();
    out(`Measuring: ${currentUrl}`);

    // ---------------------------------------------------------------------------------------------
    // 1. The current cheerio path — the exact wrapper domDiscovery.ts:457 exposes.
    // ---------------------------------------------------------------------------------------------
    const model = await extractDomModelFromPage(page, currentUrl);
    const cheerioCount = model?.pages?.[0]?.elements?.length ?? 0;

    // ---------------------------------------------------------------------------------------------
    // 2/3/4/5/6. The live-DOM measurement. ONE evaluate callback, no inner functions (TD-40).
    // ---------------------------------------------------------------------------------------------
    const live = await page.evaluate((): LiveDom => {
      // 2. Light DOM only — what a document-scoped selector can reach.
      const lightCount = document.querySelectorAll("*").length;

      // 3. Shadow-descending walk. Iterative stack, NOT a recursive helper: an inner named
      // function would be wrapped in `__name(...)` by esbuild and throw in the browser (TD-40).
      // The stack holds light children and shadow children separately; a shadow root's contents
      // are NOT in the host's `.children`, so nothing is counted twice.
      const stack: Element[] = [];
      if (document.documentElement) stack.push(document.documentElement);
      let walkCount = 0;
      let lightningCount = 0;
      let lightningWithShadow = 0;
      const interactive: Element[] = [];
      while (stack.length > 0) {
        const el = stack.pop() as Element;
        walkCount++;
        const tag = el.tagName.toLowerCase();
        if (tag.indexOf("lightning-") === 0) {
          lightningCount++;
          if (el.shadowRoot) lightningWithShadow++;
        }
        const role = el.getAttribute("role") ?? "";
        if (
          tag === "a" || tag === "button" || tag === "input" || tag === "select" ||
          tag === "textarea" || role === "button" || role === "link" || role === "checkbox" ||
          role === "menuitem" || role === "tab" || role === "combobox" || role === "textbox" ||
          role === "radio" || role === "switch"
        ) {
          interactive.push(el);
        }
        const lightKids = el.children;
        for (let i = 0; i < lightKids.length; i++) stack.push(lightKids[i]);
        const sr = el.shadowRoot;
        if (sr) {
          const shadowKids = sr.querySelectorAll("*");
          for (let i = 0; i < shadowKids.length; i++) stack.push(shadowKids[i]);
        }
      }

      // 4. Same-origin iframes (cross-origin ones are opaque by design).
      const frames = document.querySelectorAll("iframe");
      const iframeCounts: number[] = [];
      let sameOrigin = 0;
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i] as HTMLIFrameElement;
        try {
          const doc = frame.contentDocument;
          if (doc) {
            sameOrigin++;
            iframeCounts.push(doc.querySelectorAll("*").length);
          }
        } catch (e) {
          // Cross-origin iframe — no access, not an error.
        }
      }

      // 5. Synthetic-shadow detection. `enableSyntheticShadow: true` is LWC telling us its
      // components render into the light DOM; a real `shadowRoot` on a `lightning-*` tag is the
      // opposite signal.
      let lwcPresent = false;
      let syntheticFlag = "absent";
      try {
        const flags = (window as any).lwcRuntimeFlags;
        if (flags) {
          lwcPresent = true;
          syntheticFlag = String(flags.enableSyntheticShadow);
        }
      } catch (e) {
        syntheticFlag = "unreadable";
      }

      // 6. Sample interactive elements and test a boundary-free (document-scoped) CSS selector.
      const sampleLimit = 20;
      let sampled = 0;
      let resolvable = 0;
      let reachable = 0;
      let sampledInShadow = 0;
      for (let i = 0; i < interactive.length && sampled < sampleLimit; i++) {
        const el = interactive[i];
        sampled++;
        const root = el.getRootNode();
        if (root && (root as any).host) sampledInShadow++;
        // A boundary-free (document-scoped) selector can only ever reach an element that
        // `document.contains` returns true for. Anything inside a shadow root is unreachable by
        // construction, however well-named — that is the fact this column exists to separate from
        // "reachable, but has no id/name to key on".
        if (document.contains(el)) reachable++;

        // Build a selector the site itself declared, if it declared one. No `id` and no `name`
        // means no boundary-free way to address it — which is itself the finding.
        let sel = "";
        if (el.id) {
          sel = "#" + CSS.escape(el.id);
        } else {
          const nm = el.getAttribute("name");
          if (nm && nm.indexOf('"') < 0 && nm.indexOf("\\") < 0) {
            sel = el.tagName.toLowerCase() + '[name="' + nm + '"]';
          }
        }
        if (sel.length > 0) {
          let hit = false;
          try { hit = document.querySelector(sel) === el; } catch (e) { hit = false; }
          if (hit) resolvable++;
        }
      }

      return {
        lightCount, walkCount, iframeTotal: frames.length, sameOrigin, iframeCounts,
        lwcPresent, syntheticFlag, lightningCount, lightningWithShadow,
        sampled, resolvable, reachable, sampledInShadow,
      };
    });

    // ---------------------------------------------------------------------------------------------
    // Report.
    // ---------------------------------------------------------------------------------------------
    out("");
    out("| # | Measurement | Value |");
    out("|---|---|---|");
    out(`| 1 | Elements extracted by the current cheerio path | ${cheerioCount} |`);
    out(`| 2 | Elements via \`document.querySelectorAll('*')\` (light DOM) | ${live.lightCount} |`);
    out(`| 3 | Elements via shadow-descending walk | ${live.walkCount} |`);
    out(`| 4 | Same-origin iframes (of ${live.iframeTotal} total) | ${live.sameOrigin} |`);
    if (live.iframeCounts.length > 0) {
      out(`| 4a | Elements inside same-origin iframes | ${live.iframeCounts.join(", ")} |`);
    }
    out(`| 5 | \`window.lwcRuntimeFlags\` present | ${live.lwcPresent} (enableSyntheticShadow=${live.syntheticFlag}) |`);
    out(`| 5a | \`lightning-*\` elements walked | ${live.lightningCount} |`);
    out(`| 5b | \`lightning-*\` with a REAL shadowRoot | ${live.lightningWithShadow} |`);
    out(`| 6 | Sampled interactive elements resolved by a boundary-free CSS selector | ${live.resolvable}/${live.sampled} |`);
    out(`| 6a | ...of those sampled, reachable by a document-scoped selector at all | ${live.reachable}/${live.sampled} |`);
    out(`| 6b | ...of those sampled, inside a shadow root | ${live.sampledInShadow}/${live.sampled} |`);

    // One sentence, per the brief.
    const flagSaysSynthetic = live.lwcPresent && live.syntheticFlag === "true";
    const flagSaysReal = live.lwcPresent && live.syntheticFlag === "false";
    const realShadowRatio = live.lightningCount > 0 ? live.lightningWithShadow / live.lightningCount : 0;
    const missesMuch = live.walkCount > live.lightCount * 1.2;
    const expensive = !flagSaysSynthetic && (flagSaysReal || realShadowRatio >= 0.5 || missesMuch);

    out("");
    out(
      expensive
        ? "Real shadow (expensive): Lightning components are genuinely shadow-rooted (or the shadow walk finds substantially more than the light DOM), so the existing cheerio path misses a large fraction of the page."
        : "Synthetic shadow (cheap): Lightning renders into the light DOM, so the existing cheerio path already sees almost all of the page.",
    );
  } finally {
    await browser.close().catch(() => {});
  }
}

const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  main().catch((err) => {
    console.error(scrub(`probe failed: ${err?.message ?? err}`));
    process.exit(1);
  });
}
