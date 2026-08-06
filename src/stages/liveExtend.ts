import { chromium, type Page } from "playwright";
import { AppModel } from "../schema/appModel.js";
import type { IR, Step } from "../schema/ir.js";
import { extractDomModelFromPage } from "./domDiscovery.js";
import {
  modelFromAria, detectInteractiveElements, formatInteractiveElements, attachElementIdentity,
} from "./discovery.js";
import { resolveLive } from "./targetResolver.js";
import {
  credentialForTarget, redactCredentials, credentialFieldMap, credentialKindForTarget,
  lastFillIndexByKind, type Credentials, type CredentialKind, type CredentialPolicy,
} from "./credentials.js";
import { isAuthTriggeringStep, waitForAuthSettle } from "./authSettle.js";
import { llmCacheGet, llmCacheSet, makeCacheKey } from "../kb/llmCache.js";
import { cutAtBoundary } from "../text.js";

/** Run one grounded prefix step against a live page. Mirrors generator.ts's emitStep,
 *  but executed instead of emitted. Assertions are skipped by the caller — they only
 *  check state, they don't advance it, and a strict assertion shouldn't abort the replay. */
export async function runStepLive(
  page: Page, step: Step, baseUrl: string, creds?: Credentials,
  /** Same DOM-derived field map the IR uses. Without it the replay can't tell which box is
   *  the password on an unlabelled login form, types the wrong value, never gets past the
   *  login, and every later step loses its grounding. */
  fieldMap?: Map<string, CredentialKind>,
  policy: CredentialPolicy = "full",
  /** False for an earlier, deliberately-different login attempt in a compound case (e.g. the
   *  wrong-password half of a "verify invalid login, then verify valid login" flow) — mirrors
   *  applyCredentials's own lastFillIndexByKind rule so live replay doesn't type the real
   *  credential into a fill the executed test will leave alone. Defaults true: every existing
   *  single-occurrence call is unaffected. */
  isFinalCredentialAttempt: boolean = true,
): Promise<void> {
  switch (step.action) {
    case "navigate": {
      const u = step.target?.url ?? "/";
      const full = u.startsWith("http") ? u : baseUrl.replace(/\/$/, "") + u;
      await page.goto(full, { waitUntil: "domcontentloaded" });
      return;
    }
    case "fill": {
      const val = (creds && isFinalCredentialAttempt ? credentialForTarget(step.target, creds, fieldMap, policy) : undefined) ?? step.value ?? "";
      await (await resolveLive(page, step.target!)).fill(val);
      return;
    }
    case "click": await (await resolveLive(page, step.target!)).click(); return;
    case "select": await (await resolveLive(page, step.target!)).selectOption(step.value ?? ""); return;
    case "check": await (await resolveLive(page, step.target!)).check(); return;
    case "press": await (await resolveLive(page, step.target!)).press(step.value ?? "Enter"); return;
    case "wait": await page.waitForTimeout(Number(step.value ?? 1000)); return;
    case "assert": return; // state check only — skip during replay
  }
}

/** Visible body text, normalized and capped — used both to ground text-only assertions
 *  against reality and as a cheap, comparable snapshot for logging. */
async function capturePageText(page: Page): Promise<string> {
  try {
    const text = await page.locator("body").innerText();
    const normalized = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return normalized.length > 8000 ? cutAtBoundary(normalized, 8000) : normalized;
  } catch {
    return "";
  }
}

export interface ReplayResult {
  reachedUrl: string;
  pageModel: AppModel["pages"][number];
  /** Normalized visible text of the page as it stood right after the replay. */
  pageText: string;
}

/** Replay a step prefix in a real browser and snapshot+model whatever page it lands on.
 *  Shared by extendAppModel (wants a genuinely NEW page) and refreshPageModel (wants the
 *  CURRENT truth for a page it may already know) — they differ only in how the result gets
 *  merged back into the model. */
async function replayAndSnapshot(
  model: AppModel,
  prefix: Step[],
  creds?: Credentials,
  policy: CredentialPolicy = "full",
): Promise<ReplayResult> {
  // Policy is folded in because the fill values it produces differ by policy, and relying on
  // that difference to always change the prefix's own JSON (rather than asserting it) is the
  // exact caching-bug shape that has already bitten this codebase twice.
  const cacheKey = makeCacheKey(model.baseUrl, JSON.stringify(prefix), policy);
  const cached = llmCacheGet<ReplayResult>(cacheKey);
  if (cached) return cached;

  const fieldMap = credentialFieldMap(model);
  // Same "only the LAST attempt at a given credential kind gets substituted" rule
  // applyCredentials applies at execution time — computed here too so a compound case's
  // grounding replay doesn't type the real password into its earlier, deliberately-wrong leg.
  const lastOfKind = lastFillIndexByKind(prefix, fieldMap);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let urlBeforeLastStep = model.baseUrl;
    for (let i = 0; i < prefix.length; i++) {
      if (i === prefix.length - 1) urlBeforeLastStep = page.url();
      const step = prefix[i];
      const kind = credentialKindForTarget(step.target, fieldMap);
      const isFinalAttempt = kind ? lastOfKind.get(kind) === i : true;
      await runStepLive(page, step, model.baseUrl, creds, fieldMap, policy, isFinalAttempt);
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
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => { });

    // A last step that opens a modal (e.g. an "Add New" button) doesn't navigate at all —
    // domcontentloaded above is already satisfied, but the dialog's content can still be
    // mid-render (React/Next state update). Seen in practice: a modal's form fields came
    // back with only the page's static chrome modeled, none of the fields inside it. Prefer
    // a real signal — a dialog becoming visible — over a blind sleep; not `networkidle`,
    // which generator.ts deliberately strips from generated specs because it hangs on real
    // sites, so it's avoided here too. Falls back to a short bounded wait when no dialog
    // appears, since the last step might not have opened one at all.
    //
    // Only worth probing when the last step DIDN'T navigate: a step that changed pages can't
    // have opened a modal we care about (the merge branch below ignores dialogSeen in that
    // case anyway), and paying the 2500ms timeout on every ordinary login/checkout replay
    // added ~3s to each one. The 600ms floor is kept on both paths though — sitting directly
    // above capturePageText and the DOM extraction, it doubles as settle time for an SPA
    // that updates the URL before rendering the page it navigated to.
    const navigatedAway = page.url() !== urlBeforeLastStep;
    let dialogSeen = false;
    if (navigatedAway) {
      await page.waitForTimeout(600);
    } else {
      await page.waitForSelector('[role="dialog"], [aria-modal="true"]', { state: "visible", timeout: 2500 })
        .then(() => { dialogSeen = true; })
        .catch(() => page.waitForTimeout(600));
    }

    const reachedUrl = page.url();
    const title = await page.title();
    const pageText = await capturePageText(page);

    // Try DOM-based discovery first for the reached page. Snapshot the replay's OWN page
    // handle — its session/cookies are intact, so an authenticated URL is modeled as the
    // real post-login page. discoverUsingCrawler would launch a fresh, session-less browser
    // that hits the login redirect: the resulting LOGIN-page snapshot is non-empty, so the
    // vision fallback below was never consulted to correct it, and the wrong model got
    // cached under dom:reachedUrl for every later run.
    let fresh: AppModel | null = null;
    try {
      fresh = await extractDomModelFromPage(page, reachedUrl);
    } catch {
      // DOM discovery failed for the reached page
    }

    // Consult vision when either:
    //  - DOM found nothing at all (existing case), or
    //  - the last step opened a dialog WITHOUT navigating (the modal case). DOM extraction
    //    from the live page usually sees the dialog's fields too, but it is attribute-based:
    //    a custom-built dialog's fields can be real <input> elements (so DOM sees them) or,
    //    in component libraries that skip semantic HTML, effectively invisible to it. Vision
    //    reads pixels, so it catches that case. A dialog signal never REPLACES the DOM result
    //    (unlike the empty case) — it's merged in, adding whatever elements vision saw that
    //    DOM's page didn't already have, by role+name. This keeps DOM's richer structured
    //    fields (forms, buttons, ...) as the base instead of discarding them for a strictly
    //    poorer vision-only model.
    const domEmpty = !fresh || !fresh.pages[0]?.elements?.length;
    const consultVision = domEmpty || (dialogSeen && !navigatedAway);

    if (consultVision) {
      const aria = await page.locator("body").ariaSnapshot();
      const detected = await detectInteractiveElements(page);
      const screenshotBase64 = (await page.screenshot()).toString("base64");
      const visionModel = attachElementIdentity(
        await modelFromAria(reachedUrl, title, aria + formatInteractiveElements(detected), screenshotBase64),
        detected
      );
      if (domEmpty) {
        fresh = visionModel;
      } else {
        const basePage = fresh!.pages.find((p) => p.url === reachedUrl) ?? fresh!.pages[0];
        const visionPage = visionModel.pages.find((p) => p.url === reachedUrl) ?? visionModel.pages[0];
        const known = new Set(basePage.elements.map((e) => `${e.role.toLowerCase()}|${e.name.toLowerCase()}`));
        const extra = (visionPage?.elements ?? []).filter(
          (e) => !known.has(`${e.role.toLowerCase()}|${e.name.toLowerCase()}`)
        );
        if (extra.length) {
          console.log(`[liveExtend] modal detected — vision found ${extra.length} element(s) DOM missed`);
          fresh = {
            ...fresh!,
            pages: fresh!.pages.map((p) =>
              p.url === basePage.url ? { ...p, elements: [...p.elements, ...extra] } : p
            ),
          };
        }
      }
    }
    // Always non-null here: the domEmpty branch above unconditionally assigns it, and the
    // merge branch only runs when it was already non-null.
    const pageModel = fresh!.pages.find((p) => p.url === reachedUrl) ?? fresh!.pages[0];
    if (!pageModel) throw new Error(`replay reached ${reachedUrl} but produced no page model`);
    // The replay just typed the user's real credentials into this page, and a logged-in page
    // routinely echoes the identifier back. Scrub before anything persists it: this result is
    // cached under runs/_cache and its pageModel ends up inside 04-ir.json, both of which the
    // server exposes as static files. No-op for the public demo accounts.
    const result = redactCredentials<ReplayResult>({ reachedUrl, pageModel, pageText }, creds);
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
  creds?: Credentials,
  policy: CredentialPolicy = "full",
): Promise<AppModel> {
  const { reachedUrl, pageModel } = await replayAndSnapshot(model, prefix, creds, policy);
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
  creds?: Credentials,
  policy: CredentialPolicy = "full",
): Promise<AppModel> {
  const { reachedUrl, pageModel } = await replayAndSnapshot(model, prefix, creds, policy);
  const pages = model.pages.filter((p) => p.url !== reachedUrl);
  return AppModel.parse({ ...model, pages: [...pages, pageModel] });
}

// ---------------------------------------------------------------------------
// Text-assertion grounding — replace a guessed message with the real one
// ---------------------------------------------------------------------------

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

// A short, message-shaped line — the kind of thing a UI shows as a single banner or
// validation string, not a paragraph of body copy. Deliberately generic: this scans for
// "something that reads like a status message," not specifically failure or success
// wording, because grounding should work for both directions.
const MESSAGE_LIKE = /\b(invalid|error|incorrect|wrong|fail(s|ed|ure)?|denied|required|unable|cannot|success|welcome|congratulations|confirmed|complete[ds]?|already|must|please)\b/i;

function candidateMessageLines(pageText: string): string[] {
  return pageText
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.length >= 4 && l.length <= 200 && MESSAGE_LIKE.test(l));
}

/** True when the step is a terminal-style pure-text assertion: exactly the kind
 *  groundingError exempts (no role/name to check against the AppModel), and therefore the
 *  one kind whose asserted text is never verified against anything real. */
export function isPureTextAssertion(step: Step): boolean {
  if (step.action !== "assert") return false;
  const t = step.target;
  if (!t?.text || t.role || t.name) return false;
  return step.assertion === "visible" || step.assertion === "hidden"
    || step.assertion === "text_contains" || step.assertion === "text_equals";
}

/**
 * Replay the IR's steps up to (not including) its terminal assertion, read what the page
 * actually shows afterward, and check the asserted text against reality — correcting it
 * when it's wrong rather than just flagging it.
 *
 * This is the grounding groundingError() cannot do: it deliberately exempts pure-text
 * targets because a post-action banner isn't in the discovery snapshot, which is correct,
 * but it leaves the text itself as an unvalidated LLM guess. In practice that guess is
 * often wrong in a specific way — right general shape ("an error appeared"), wrong exact
 * wording (asserted "Your username is invalid!" when the real page said "Your password is
 * invalid!", because the username was in fact valid). assertionContradictsCase catches the
 * subset of that where the guess reads as SUCCESS wording on a case that should fail; it
 * cannot catch two failure-shaped strings just being the wrong one. This does, because it
 * checks against the real page instead of pattern-matching the guess.
 *
 * Best-effort and non-fatal by design: replay can fail for reasons that have nothing to do
 * with the assertion (site flakiness, a login that needs different creds this time), and
 * the existing pattern-based guards in ir.ts remain the safety net for whatever this can't
 * fix. Returns the same IR unchanged whenever it can't confidently improve on it.
 */
export async function groundTerminalTextAssertion(
  ir: IR, model: AppModel, creds?: Credentials, policy: CredentialPolicy = "full",
): Promise<{ ir: IR; grounded: boolean; corrected: boolean }> {
  const last = ir.steps[ir.steps.length - 1];
  if (!isPureTextAssertion(last)) return { ir, grounded: false, corrected: false };

  const prefix = ir.steps.slice(0, -1);
  if (!prefix.length) return { ir, grounded: false, corrected: false };

  let pageText: string;
  try {
    // Defaulted, not asserted: replayAndSnapshot's result is cached to disk by llmCache, and
    // only its in-memory half honours the TTL — a pre-`pageText` entry written before this
    // function existed is returned verbatim, forever. Without the default, norm() below
    // throws on it, outside this try, escaping toIR's loop instead of degrading to
    // "leave the assertion alone" like every other failure here.
    ({ pageText = "" } = await replayAndSnapshot(model, prefix, creds, policy));
  } catch (err: any) {
    console.log("[liveExtend] text-assertion grounding: replay failed, leaving assertion as-is:", err?.message ?? err);
    return { ir, grounded: false, corrected: false };
  }

  const asserted = norm(last.target!.text!);
  const pageNorm = norm(pageText);

  // Real text found verbatim (as a substring) — the guess was right. Nothing to correct,
  // and now confirmed against the live page rather than just pattern-matched.
  if (asserted && pageNorm.includes(asserted)) {
    return { ir, grounded: true, corrected: false };
  }

  // Not found — the asserted text doesn't match what the page actually shows. Look for a
  // real message-shaped line to correct it to, closest in length to the original guess
  // (the closest proxy available, without reintroducing a general string-similarity
  // matcher, for "probably the same message, differently worded").
  const candidates = candidateMessageLines(pageText);
  if (!candidates.length) {
    console.log("[liveExtend] text-assertion grounding: no message-shaped text found on the replayed page, leaving assertion as-is");
    return { ir, grounded: false, corrected: false };
  }
  const targetLen = last.target!.text!.length;
  const best = candidates.reduce((a, b) =>
    Math.abs(b.length - targetLen) < Math.abs(a.length - targetLen) ? b : a
  );

  console.log(`[liveExtend] text-assertion grounding: corrected "${last.target!.text}" -> "${best}"`);
  const corrected: IR = {
    ...ir,
    steps: ir.steps.map((s, i) =>
      i === ir.steps.length - 1
        ? { ...s, target: { ...s.target, text: best }, ...(s.value !== undefined ? { value: best } : {}) }
        : s
    ),
  };
  return { ir: corrected, grounded: true, corrected: true };
}
