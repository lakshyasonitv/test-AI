import { chromium, type Page } from "playwright";
import { AppModel } from "../schema/appModel.js";
import type { Step } from "../schema/ir.js";
import { modelFromAria } from "./discovery.js";
import { resolveLive } from "./targetResolver.js";
import { credentialForTarget, type Credentials } from "./credentials.js";

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
      await resolveLive(page, step.target!).fill(val);
      return;
    }
    case "click":  await resolveLive(page, step.target!).click(); return;
    case "select": await resolveLive(page, step.target!).selectOption(step.value ?? ""); return;
    case "check":  await resolveLive(page, step.target!).check(); return;
    case "press":  await resolveLive(page, step.target!).press(step.value ?? "Enter"); return;
    case "wait":   await page.waitForTimeout(Number(step.value ?? 1000)); return;
    case "assert": return; // state check only — skip during replay
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
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const step of prefix) {
      await runStepLive(page, step, model.baseUrl, creds);
    }
    // Let navigation triggered by the last step settle before snapshotting, else we'd
    // capture the pre-navigation page. Bounded so a site with long-lived connections
    // (never truly "idle") doesn't stall the whole run.
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    const reachedUrl = page.url();
    const title = await page.title();
    const aria = await page.locator("body").ariaSnapshot();
    const fresh = await modelFromAria(reachedUrl, title, aria);

    const knownUrls = new Set(model.pages.map((p) => p.url));
    const newPages = fresh.pages.filter((p) => !knownUrls.has(p.url));
    if (!newPages.length) {
      throw new Error(`replay reached ${reachedUrl} but discovered no page not already in the model`);
    }
    return AppModel.parse({ ...model, pages: [...model.pages, ...newPages] });
  } finally {
    await browser.close();
  }
}
