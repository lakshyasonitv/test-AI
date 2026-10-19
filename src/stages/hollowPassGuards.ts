import type { Page } from "playwright";
import type { AppModel } from "../schema/appModel.js";

/**
 * TD-162: a valid case must not PASS without doing what it was asked. Run
 * 2026-10-19T13-44-20-358Z-8e01a75f typed the literal word "email" into an email field, clicked Next
 * on step 1 of a 3-step form, and the final assertion became the site's own "Please enter a valid
 * email address." — so the case passed with nothing submitted. Every guard here is behind
 * `HOLLOW_PASS_GUARDS_ENABLED` (default off; README) and reads STRUCTURE — ARIA roles and states,
 * the case's category — never the wording of the page or the model (TD-01).
 */
export function hollowPassGuardsEnabled(): boolean {
  return process.env.HOLLOW_PASS_GUARDS_ENABLED === "true";
}

/**
 * Categories whose case must END on its success outcome. Everything else either expects a
 * rejection on purpose (invalid-input, empty-boundary, security-*: an error message is the point)
 * or is the catch-all "functional-other", which can legitimately expect either, so it keeps
 * today's behaviour.
 */
export const POSITIVE_CATEGORIES: ReadonlySet<string> = new Set(["valid", "state-change"]);

export function isPositiveCase(testCase: { category?: string }): boolean {
  return !!testCase.category && POSITIVE_CATEGORIES.has(testCase.category);
}

const MAX_ERROR_ELEMENTS = 20;

/** The structural signal that marked something as the page's own error. Every refusal logs it, so
 *  false incompletes can be measured on real runs. */
export type ErrorMarkerKind = "role-alert" | "aria-live-assertive" | "aria-invalid" | "aria-errormessage" | "aria-describedby";
export interface ErrorMarker { kind: ErrorMarkerKind; text: string }

/** One line per marker, for logs and for the reason the model and the truncation note carry. */
export function describeMarkers(markers: ErrorMarker[]): string {
  return markers.map((m) => `${m.kind} "${m.text}"`).join(", ");
}

/**
 * What the page itself marks as an error, read in the live page at the end of a replay. Only these
 * structural signals count, never wording, and never `role="status"` or `aria-live="polite"` (success
 * toasts use those):
 *  - an `aria-invalid="true"` field: the messages its `aria-errormessage` and `aria-describedby` point
 *    at (resolved in the field's own shadow root, as Lightning renders it) or, with none, the field;
 *  - a shown message an `aria-errormessage` points at, even on a field not (yet) marked invalid;
 *  - a shown `role="alert"` or `aria-live="assertive"` region inside a form.
 *
 * `aria-describedby` counts only on an INVALID field: on any other field it is hint text ("We'll never
 * share your email"), and every form with a hint would look failed. "Inside a form" is deliberate
 * too: a page-level `role="alert"` is not always an error (Next.js's route announcer is one that
 * reads out the new page's title after every navigation, 8 of them in this repo's saved runs, and a
 * Lightning toast can announce a success through one). A form's own alert is its validation. "Shown"
 * is the walker's rule (`liveDomDiscovery.ts`): not display:none, not visibility:hidden, not opacity
 * 0, and a box — Playwright's `:visible` alone still counts an opacity-0 alert a fade left behind.
 *
 * Best-effort: a failure returns what was read so far. Evaluate callbacks are fully inlined, with
 * no inner named functions (TD-40).
 */
export async function captureErrorMarkers(page: Page): Promise<ErrorMarker[]> {
  const out: ErrorMarker[] = [];
  try {
    const fields = page.locator('[aria-invalid="true"]:visible, [aria-errormessage]:visible');
    const n = Math.min(await fields.count(), MAX_ERROR_ELEMENTS);
    for (let i = 0; i < n; i++) {
      const f = await fields.nth(i).evaluate((el) => {
        const root = el.getRootNode() as Document | ShadowRoot;
        const invalid = el.getAttribute("aria-invalid") === "true";
        const linked: { kind: "aria-errormessage" | "aria-describedby"; text: string }[] = [];
        for (const kind of ["aria-errormessage", "aria-describedby"] as const) {
          if (kind === "aria-describedby" && !invalid) continue;
          for (const id of (el.getAttribute(kind) ?? "").split(" ").filter((s) => s.length > 0)) {
            const t = root.getElementById(id) as HTMLElement | null;
            if (!t) continue;
            const cs = getComputedStyle(t);
            const box = t.getBoundingClientRect();
            const shown = cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) !== 0
              && box.width > 0 && box.height > 0;
            const text = (t.innerText || t.textContent || "").trim();
            // An invalid field's message counts even when only a screen reader gets it; an
            // aria-errormessage on a field NOT marked invalid counts only once it is on screen.
            if (text && (invalid || shown)) linked.push({ kind, text });
          }
        }
        const name = (el.getAttribute("aria-label") || (el as HTMLInputElement).labels?.[0]?.innerText
          || el.getAttribute("placeholder") || el.getAttribute("name") || el.id || el.tagName.toLowerCase()).trim();
        return { invalid, linked, name };
      }, undefined, { timeout: 1000 }).catch(() => null);
      if (!f) continue;
      out.push(...f.linked);
      if (f.invalid && !f.linked.length) out.push({ kind: "aria-invalid", text: `field "${f.name}" is marked invalid` });
    }
    const alerts = page.locator('[role="alert"]:visible, [aria-live="assertive"]:visible');
    const m = Math.min(await alerts.count(), MAX_ERROR_ELEMENTS);
    for (let i = 0; i < m; i++) {
      const hit = await alerts.nth(i).evaluate((el) => {
        const cs = getComputedStyle(el);
        const box = el.getBoundingClientRect();
        return {
          role: el.getAttribute("role"),
          text: ((el as HTMLElement).innerText || el.textContent || "").trim(),
          inForm: !!el.closest('form, [role="form"]'),
          shown: cs.display !== "none" && cs.visibility !== "hidden" && Number(cs.opacity) !== 0
            && box.width > 0 && box.height > 0,
        };
      }, undefined, { timeout: 1000 }).catch(() => null);
      if (!hit?.inForm || !hit.shown || !hit.text || hit.role === "status") continue;
      out.push({ kind: hit.role === "alert" ? "role-alert" : "aria-live-assertive", text: hit.text });
    }
  } catch {
    // keep whatever was read before the failure
  }
  return out.map((m) => ({ ...m, text: m.text.slice(0, 500) }));
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Every error marker on the replayed page: the live capture above, plus what the page model already
 * says. The walker tags a `role="alert"` element with the landmark it sits in (`tagLandmarks`,
 * innermost wins), so a visible alert whose landmark is "form" is a form's own message; that second
 * source backs up a capture that failed or timed out part-way. One marker per text, the first wins.
 */
export function errorMarkersOf(result: {
  errorMarkers?: ErrorMarker[];
  pageModel?: Pick<AppModel["pages"][number], "elements">;
}): ErrorMarker[] {
  const markers = [...(result.errorMarkers ?? [])];
  for (const e of result.pageModel?.elements ?? []) {
    if (e.role === "alert" && e.landmark === "form" && e.visible !== false && e.name) markers.push({ kind: "role-alert", text: e.name });
  }
  const seen = new Set<string>();
  return markers.filter((m) => {
    const k = norm(m.text);
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
