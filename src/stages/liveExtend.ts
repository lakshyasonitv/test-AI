import { chromium, type Page } from "playwright";
import { AppModel } from "../schema/appModel.js";
import type { Step } from "../schema/ir.js";
import { modelFromAria } from "./discovery.js";
import { resolveLive } from "./targetResolver.js";
import { credentialForTarget, type Credentials } from "./credentials.js";
import { isAuthTriggeringStep, waitForAuthSettle } from "./authSettle.js";
import { llmCacheGet, llmCacheSet, makeCacheKey } from "../kb/llmCache.js";

/** Run one grounded prefix step against a live page. Mirrors generator.ts's emitStep,
 *  but executed instead of emitted. Assertions are skipped by the caller — they only
 *  check state, they don't advance it, and a strict assertion shouldn't abort the replay. */
async function runStepLive(page: Page, step: Step, baseUrl: string, creds?: Credentials): Promise<void> {
  switch (step.action) {
    case "navigate": {
      const u = step.target?.url ?? "/";
      const full = u.startsWith("http") ? u : baseUrl.replace(/\/$/, "") + u;
      await page.goto(full, { waitUntil: "domcontentloaded" });
      return;
    }
    case "fill": {
      const val = (creds && credentialForTarget(step.target, creds)) ?? step.value ?? "";
      await (await resolveLive(page, step.target!)).fill(val);
      return;
    }
    case "click":  await (await resolveLive(page, step.target!)).click(); return;
    case "select": await (await resolveLive(page, step.target!)).selectOption(step.value ?? ""); return;
    case "check":  await (await resolveLive(page, step.target!)).check(); return;
    case "press":  await (await resolveLive(page, step.target!)).press(step.value ?? "Enter"); return;
    case "wait":   await page.waitForTimeout(Number(step.value ?? 1000)); return;
    case "assert": return; // state check only — skip during replay
  }
}

/** Replay a step prefix in a real browser and snapshot+model whatever page it lands on.
 *  Shared by extendAppModel (wants a genuinely NEW page) and refreshPageModel (wants the
 *  CURRENT truth for a page it may already know) — they differ only in how the result gets
 *  merged back into the model. */
async function replayAndSnapshot(
  model: AppModel,
  prefix: Step[],
  creds?: Credentials
): Promise<{ reachedUrl: string; pageModel: AppModel["pages"][number] }> {
  const cacheKey = makeCacheKey(model.baseUrl, JSON.stringify(prefix));
  const cached = llmCacheGet<{ reachedUrl: string; pageModel: AppModel["pages"][number] }>(cacheKey);
  if (cached) return cached;

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const step of prefix) {
      await runStepLive(page, step, model.baseUrl, creds);
      // After an auth‑triggering step (click/press on a login‑verb button),
      // wait for the SPA's own async redirect to settle before evaluating
      // whether the target page was reached.  Bounded so a hung redirect
      // doesn't stall the whole run.
      if (isAuthTriggeringStep(step)) {
        await waitForAuthSettle(page);
      }
    }
    // Let navigation triggered by the last step settle before snapshotting, else we'd
    // capture the pre-navigation page. Bounded so a site with long-lived connections
    // (never truly "idle") doesn't stall the whole run.
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    const reachedUrl = page.url();
    const title = await page.title();
    const aria = await page.locator("body").ariaSnapshot();
    const screenshotBase64 = (await page.screenshot()).toString("base64");
    const fresh = await modelFromAria(reachedUrl, title, aria, screenshotBase64);

    const pageModel = fresh.pages.find((p) => p.url === reachedUrl) ?? fresh.pages[0];
    if (!pageModel) throw new Error(`replay reached ${reachedUrl} but produced no page model`);
    const result = { reachedUrl, pageModel };
    llmCacheSet(cacheKey, result);
    return result;
  } finally {
    await browser.close();
  }
}

/**
 * Reach the state the IR needs but discovery never saw: replay the already-grounded
 * step prefix in a real browser (substituting real credentials into login fields),
 * snapshot the page it lands on, model it, and append that page to the AppModel.
 * Returns a NEW AppModel — the original is never mutated. Throws if replaying the
 * prefix fails (e.g. login rejected) or the reached page adds nothing new, so the
 * caller can fall back to a truncated test rather than loop forever.
 */
export async function extendAppModel(
  model: AppModel,
  prefix: Step[],
  creds?: Credentials
): Promise<AppModel> {
  const { reachedUrl, pageModel } = await replayAndSnapshot(model, prefix, creds);
  const knownUrls = new Set(model.pages.map((p) => p.url));
  if (knownUrls.has(reachedUrl)) {
    throw new Error(`replay reached ${reachedUrl} but discovered no page not already in the model`);
  }
  return AppModel.parse({ ...model, pages: [...model.pages, pageModel] });
}

/**
 * Self-heal's counterpart to extendAppModel: re-snapshot a page's CURRENT live state even
 * when its URL is already in the model. A selector/element failure usually means the page we
 * already know has drifted, not that a new page appeared — extendAppModel's "must be new"
 * check would throw on exactly that case. Replaces the page at that URL if present (else
 * appends it), so the fresh snapshot wins.
 */
export async function refreshPageModel(
  model: AppModel,
  prefix: Step[],
  creds?: Credentials
): Promise<AppModel> {
  const { reachedUrl, pageModel } = await replayAndSnapshot(model, prefix, creds);
  const pages = model.pages.filter((p) => p.url !== reachedUrl);
  return AppModel.parse({ ...model, pages: [...pages, pageModel] });
}
