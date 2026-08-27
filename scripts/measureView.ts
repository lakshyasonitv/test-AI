/**
 * Phase 0 of SITE_STORE_VIEW_SPEC_v2.md — the offline measurement spike.
 *
 * Touches no shipped file. No browser, no LLM, no network. Run it, read the numbers, and only
 * then decide whether Phases 1-3 are worth building:
 *
 *   reduction >= 60% AND irCoverage 100% everywhere  -> proceed to Phase 1
 *   irCoverage < 100%                                -> ranking or retrieval is wrong; fix, re-measure
 *   reduction < 40% on both View kinds               -> the AppModel was not the token problem; STOP
 *
 * -----------------------------------------------------------------------------------------------
 * TWO BASELINES, NOT ONE — and this is a correction to the spec.
 *
 * The spec's metric table names a single `tokensAppModel`, "the AppModel exactly as it is
 * serialized into the IR prompt today", and §Phase 0 points at `toLiteModel`. Appendix C says to
 * follow the repo when a name differs, and the repo has TWO different serializers feeding TWO
 * different prompts:
 *
 *   testCases.ts:427  toLiteModel(appModel)                     -> EVERY page, capped per page
 *   ir.ts:1263        toMicroModel(filtered, {currentPageUrl})  -> ONE page, <=30 elements, 3 fields
 *
 * Measuring one number against `toLiteModel` and calling it "the IR prompt" would overstate the
 * saving for the stage that is already the most compressed thing in the pipeline. So both are
 * measured, and they line up exactly with the spec's own two purposes: `toLiteModel` is the
 * baseline for `purpose: "testcases"`, `toMicroModel` for `purpose: "ir"`.
 *
 * The raw file is measured too, but only as context. It carries `cleanedHtml`, `markdown` and
 * `accessibility`, none of which has ever reached a prompt, so scoring against it would be
 * measuring against a straw man.
 *
 * -----------------------------------------------------------------------------------------------
 * Both serializers are IMPORTED, never reimplemented. A local copy of the baseline is a copy that
 * drifts, and a drifted baseline is a number that flatters whatever it is compared against.
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { encode } from "gpt-tokenizer";
import { toLiteModel, toMicroModel, INTERACTIVE_ROLES } from "../src/schema/appModel.js";
import type { AppModel, PageModel, Element } from "../src/schema/appModel.js";

const countTokens = (s: string): number => encode(s).length;

/**
 * The ONE way a (role, name) pair becomes a lookup key.
 *
 * The spec joins on \u0000 so a name containing the separator cannot forge a collision. That is
 * fine, but it has to be the ONLY joiner: this script briefly had `role\u0000name` in some
 * functions and `role + " " + name` in others, and a NUL key never equals a space key. Every
 * comparison silently returned "missing", which reported 29/29 runs truncating and 0/0 runs
 * covered — two confident numbers, both meaningless. One helper, called everywhere.
 */
export const elKey = (role: unknown, name: unknown): string => `${role ?? ""}${NUL_SEP}${name ?? ""}`;
const NUL_SEP = "\u0000";

// ---------------------------------------------------------------------------------------------
// The View builder, first cut — Phase 2's five passes written against the AppModel shape directly.
// ---------------------------------------------------------------------------------------------

interface Budget { total: number; requiredReserve: number; navigationReserve: number }
const DEFAULT_BUDGET: Budget = {
  total: Number(process.env.VIEW_TOKEN_BUDGET ?? 2500),
  requiredReserve: Math.round(Number(process.env.VIEW_TOKEN_BUDGET ?? 2500) * 0.4),
  navigationReserve: Math.round(Number(process.env.VIEW_TOKEN_BUDGET ?? 2500) * 0.1),
};

/**
 * Hidden form inputs, identified from the page's own `forms` block.
 *
 * Found by reading §6's output, not by any metric — the View's `shared:` line for the Amazon run
 * opened with `textbox "SIGNIN_CLAIM_COLLECT"`, `textbox "true"`, `textbox "claimType"` and a
 * live CSRF token, presented as if they were controls a person could type into. Pass 3 ranks
 * `textbox` first, so they outranked the actual search box. Token reduction, `irCoverage` and the
 * A/B comparison are all structurally blind to this: it is a defect in the INPUT.
 *
 * `Element` carries no `tag` and no `inputType`, so `type=hidden` cannot be read off the element
 * itself. It CAN be read off `PageModel.forms[].fields[]`, which does carry `inputType` — a schema
 * field, not a guess about wording.
 *
 * **Match on the field's VALUE as well as its name.** The accessible name of a hidden input with
 * no label is its value, which is why the CSRF token appears to be "named" after its own contents:
 *
 *     name "appAction"          value "SIGNIN_CLAIM_COLLECT"
 *     name "anti-csrftoken-a2z" value "hEj/Wh8642+o8zAEP15lt9A5gFAdyyTAqoNqg9Fa9jHD"
 *     name "metadata1"          value "true"
 *
 * `visible === false` is checked too but is NOT sufficient on its own: measured on that run, 30 of
 * the 474 elements carry `visible: false` while `SIGNIN_CLAIM_COLLECT`, `claimType` and
 * `countryCode` are all recorded `visible: true`. Either signal alone leaves half the junk in.
 */
function hiddenInputNames(page: PageModel): Set<string> {
  const out = new Set<string>();
  for (const f of (page as any).forms ?? []) {
    for (const fld of f?.fields ?? []) {
      if (fld?.inputType !== "hidden") continue;
      if (fld.name) out.add(String(fld.name));
      if (fld.value) out.add(String(fld.value));
    }
  }
  return out;
}

const isHiddenInput = (el: Element, hiddenNames: Set<string>): boolean =>
  el.visible === false || hiddenNames.has(String(el.name ?? ""));

/** A stable id for an element, so the View can address it without the model authoring a name. */
const elementId = (pageIdx: number, el: Element, ordinal: number): string =>
  `#p${pageIdx + 1}-${(el.id ?? el.genericPath ?? elKey(el.role, el.name)).slice(-6).replace(/[^\w]/g, "") || String(ordinal)}${ordinal}`;

/**
 * Pass 1 — hoist site chrome. Counts DISTINCT PAGES, not occurrences: twenty "Add to basket"
 * buttons on one page are one page, not twenty, which is the v0 bug the spec calls out.
 * Below `minPages` there is no such thing as shared chrome, so it returns empty.
 */
export function hoistShared(pages: PageModel[], minPages = 3): { shared: string[]; sharedKeys: Set<string> } {
  if (pages.length < minPages) return { shared: [], sharedKeys: new Set() };
  const pagesByKey = new Map<string, Set<number>>();
  pages.forEach((p, i) => {
    // Hidden inputs are excluded HERE as well as in the per-page filter. The hoist runs first and
    // on raw `p.elements`, so filtering only downstream still let a CSRF token lead the `shared:`
    // line — the most prominent position in the whole View — precisely because it appears on
    // every sign-in page and therefore looks like site chrome.
    const hidden = hiddenInputNames(p);
    for (const el of p.elements ?? []) {
      if (!el.name?.trim()) continue;
      if (isHiddenInput(el, hidden)) continue;
      const key = elKey(el.role, el.name);
      if (!pagesByKey.has(key)) pagesByKey.set(key, new Set());
      pagesByKey.get(key)!.add(i);
    }
  });
  const sharedKeys = new Set(
    [...pagesByKey].filter(([, ps]) => ps.size >= minPages).map(([k]) => k),
  );
  const shared = [...sharedKeys].map((k) => {
    const [role, name] = k.split(NUL_SEP);
    return `${role} "${name}" @${name.toLowerCase().replace(/\W+/g, "").slice(0, 12)}`;
  });
  return { shared, sharedKeys };
}

/**
 * Pass 2 — collapse repeated structures. The spec keys on `(parentId, tag, role,
 * childRoleSignature)`; the AppModel has NONE of those four. It does carry `genericPath` — the
 * tag chain from `<html>` with indices stripped — which is the same kind of fact: a DOM shape,
 * not a name. Twenty product cards share a genericPath and differ in name, which is exactly the
 * case the pass exists for and exactly the case grouping-by-name misses.
 *
 * Elements with no genericPath are skipped rather than guessed at, per the spec.
 */
interface Group { groupId: string; count: number; signature: string; members: Element[] }
function collapseRepeats(els: Element[]): { groups: Group[]; absorbed: Set<Element> } {
  const buckets = new Map<string, Element[]>();
  for (const el of els) {
    if (!el.genericPath) continue;
    const key = elKey(el.genericPath, el.role);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key)!.push(el);
  }
  const groups: Group[] = [];
  const absorbed = new Set<Element>();
  let n = 0;
  for (const [key, members] of buckets) {
    if (members.length < 3) continue;          // two is not a pattern
    groups.push({ groupId: `g${++n}`, count: members.length, signature: key.split(NUL_SEP)[0], members });
    for (const m of members) absorbed.add(m);
  }
  return { groups, absorbed };
}

/**
 * Pass 3 — rank on structural signals only. Never a regex over an accessible name: that is the
 * v0 bug and the failure mode CLAUDE.md's central rule names. `landmark`/`pageSection` and form
 * membership are DOM facts; role is a schema field.
 */
function priority(el: Element, formFieldNames: Set<string>): number {
  const role = (el.role ?? "").toLowerCase();
  if (["textbox", "searchbox", "combobox", "checkbox", "radio", "spinbutton"].includes(role)) return 1;
  if (role === "button" && el.name && formFieldNames.has(el.name)) return 2;
  if (role === "button") return 3;
  if (role === "link" && (el.landmark === "nav" || el.pageSection === "nav")) return 4;
  if (role === "link") return 5;
  if (role === "heading") return 6;
  return 7;
}

const renderLine = (el: Element, id: string): string =>
  `    ${el.role} "${el.name}" ${id}${el.concept ? `  (${el.concept})` : ""}`;

/**
 * Pass 4 — budget with a real tokenizer, and `continue` rather than `break`. `break` ends the
 * loop on the first oversized line even with budget to spare, which is the v0 bug.
 */
function applyBudget(
  lines: { id: string; text: string; required: boolean }[],
  budget: Budget,
): { included: string[]; skipped: number; warnings: string[] } {
  let used = 0, skipped = 0;
  const included: string[] = [];
  const warnings: string[] = [];

  for (const l of lines.filter((x) => x.required)) {   // reserved first, never pruned
    used += countTokens(l.text);
    included.push(l.text);
  }
  if (used > budget.requiredReserve) {
    warnings.push(`required ids used ${used} tokens, reserve was ${budget.requiredReserve}`);
  }
  for (const l of lines) {
    if (l.required) continue;
    const t = countTokens(l.text);
    if (used + t > budget.total) { skipped++; continue; }   // NOT break
    used += t;
    included.push(l.text);
  }
  return { included, skipped, warnings };
}

interface ViewResult { text: string; warnings: string[]; ids: Map<string, Element> }

/** Pass 5 — serialize. Indented text, no braces, no repeated keys, quotes only around names. */
export function buildView(
  model: AppModel,
  opts: { pageIdxs?: number[]; requiredNames?: Set<string>; budget?: Budget } = {},
): ViewResult {
  const budget = opts.budget ?? DEFAULT_BUDGET;
  const allPages = model.pages ?? [];
  const pageIdxs = opts.pageIdxs ?? allPages.map((_, i) => i);
  const pages = pageIdxs.map((i) => allPages[i]).filter(Boolean);

  const { shared, sharedKeys } = hoistShared(pages);
  const out: string[] = [];
  const ids = new Map<string, Element>();
  const warnings: string[] = [];

  if (shared.length) out.push("shared:", `  ${shared.join(" | ")}`, "");

  const lines: { id: string; text: string; required: boolean }[] = [];
  const perPageHeader: string[] = [];

  pages.forEach((p, localIdx) => {
    const globalIdx = pageIdxs[localIdx];
    const formFieldNames = new Set<string>(
      (p.forms ?? []).flatMap((f: any) => (f.fields ?? []).map((x: any) => x.label ?? x.name ?? "")),
    );
    // The same filter ir.ts applies before serializing: named, interactive elements only —
    // PLUS hidden inputs, which that filter does not catch and which this one must.
    const hidden = hiddenInputNames(p);
    const named = (p.elements ?? []).filter(
      (e) => e.name?.trim()
        && INTERACTIVE_ROLES.has((e.role ?? "").toLowerCase())
        && !isHiddenInput(e, hidden),
    );
    const notShared = named.filter((e) => !sharedKeys.has(elKey(e.role, e.name)));
    const { groups, absorbed } = collapseRepeats(notShared);
    const loose = notShared.filter((e) => !absorbed.has(e));

    perPageHeader.push(`p${globalIdx + 1}  ${p.url ?? ""}   "${p.title ?? ""}"`);

    for (const g of groups) {
      const head = `  group @${g.groupId}  ×${g.count}`;
      lines.push({ id: `@${g.groupId}`, text: head, required: false });
      g.members.slice(0, 3).forEach((m, i) => {
        const id = elementId(globalIdx, m, i);
        ids.set(id, m);
        lines.push({
          id,
          text: `    [${i}] ${m.role} "${m.name}" ${id}`,
          required: !!(opts.requiredNames && m.name && opts.requiredNames.has(m.name)),
        });
      });
      if (g.count > 3) lines.push({ id: `@${g.groupId}+`, text: `    …${g.count - 3} more members`, required: false });
    }

    loose
      .map((e, i) => ({ e, i }))
      .sort((a, b) =>
        priority(a.e, formFieldNames) - priority(b.e, formFieldNames) ||
        (a.e.order ?? a.i) - (b.e.order ?? b.i))
      .forEach(({ e, i }) => {
        const id = elementId(globalIdx, e, i);
        ids.set(id, e);
        lines.push({
          id,
          text: renderLine(e, id),
          required: !!(opts.requiredNames && e.name && opts.requiredNames.has(e.name)),
        });
      });
  });

  const { included, skipped, warnings: bw } = applyBudget(lines, budget);
  warnings.push(...bw);
  // Residue, so the model knows the View is partial and does not conclude an element is absent.
  const residue = skipped > 0 ? [`  +${skipped} more elements`] : [];

  out.push(...perPageHeader, ...included, ...residue);
  return { text: out.join("\n"), warnings, ids };
}

// ---------------------------------------------------------------------------------------------
// Coverage — does the View still contain every element the shipped IR actually grounded against?
// ---------------------------------------------------------------------------------------------

/**
 * The (role,name) pairs a saved IR's grounded steps depend on. A dropped one is a broken test.
 *
 * `04-ir.json` is NOT a bare IR — every one of the 29 saved runs stores `{ ir, updatedAppModel }`,
 * the return shape of `toIR()`. Reading `.steps` off the wrapper yields undefined, which yields
 * zero references, which made `coverage()` report a vacuous 100%. That is what the first pass of
 * this script did, and the "irCoverage 100% on 38/38" it printed measured nothing at all.
 * Unwrap first, and treat "no references" as NOT MEASURED rather than as success.
 */
export function irReferences(raw: any): { key: string; label: string }[] {
  const ir = raw?.ir ?? raw;
  const out: { key: string; label: string }[] = [];
  for (const s of ir?.steps ?? []) {
    const t = s?.target;
    if (!t?.name || !t?.role) continue;                 // page-level assertions target nothing
    out.push({ key: elKey(t.role, t.name), label: `${t.role} "${t.name}"` });
  }
  return out;
}

/**
 * `pct: null` means NOT MEASURED — the run has no grounded references to check against. It must
 * never be counted as a pass; a vacuous 100% is worse than a missing number.
 *
 * `sourceKeys` excludes live-extended references for the same reason §3.0 does: an element that
 * `liveExtend` discovered mid-IR was never in `02-appmodel.json`, so no View built from that file
 * could contain it. Counting those as coverage failures would mark every run as failing and would
 * measure when the crawl ran, not whether the ranking is right.
 */
export function coverage(
  view: ViewResult, refs: { key: string; label: string }[], sourceKeys: Set<string>,
) {
  refs = refs.filter((r) => sourceKeys.has(r.key));
  // THROW rather than return a figure. Returning 1 for "nothing to check" is what made the first
  // Phase 0 report "irCoverage 100% on 38/38" while measuring nothing at all — the same shape as
  // TD-01, a check that passes because it never looked. Callers that legitimately have no
  // references must say so themselves; see the driver, which records null for NOT MEASURED.
  if (refs.length === 0) throw new Error("coverage() called with no references — nothing to measure");
  const present = new Set<string>();
  for (const el of view.ids.values()) present.add(elKey(el.role, el.name));
  const missing = refs.filter((r) => !present.has(r.key)).map((r) => r.label);
  const uniq = [...new Set(refs.map((r) => r.key))];
  const missedUniq = new Set(refs.filter((r) => !present.has(r.key)).map((r) => r.key));
  return { pct: (uniq.length - missedUniq.size) / uniq.length, missing: [...new Set(missing)] };
}

// ---------------------------------------------------------------------------------------------
// Retrieval, first cut — names the primary test case mentions, matched against a Store-supplied
// dictionary. Per §2.5.1 this is a HINT, never an authority: a miss widens the View, never
// narrows it wrongly. `confidence: none` falls back to every page.
// ---------------------------------------------------------------------------------------------

function extractRequirements(model: AppModel, testCase: any) {
  const text = JSON.stringify(testCase ?? {}).toLowerCase();
  const names = new Set<string>();
  const pageIdxs = new Set<number>();
  (model.pages ?? []).forEach((p, i) => {
    for (const el of p.elements ?? []) {
      const n = el.name?.trim();
      if (n && n.length >= 3 && text.includes(n.toLowerCase())) { names.add(n); pageIdxs.add(i); }
    }
    const title = p.title?.trim();
    if (title && title.length >= 3 && text.includes(title.toLowerCase())) pageIdxs.add(i);
  });
  pageIdxs.add(0);                                       // entry page, always
  const confidence = names.size === 0 ? "none" : names.size < 3 ? "partial" : "matched";
  return {
    requiredNames: names,
    // Fall back to WIDER, never narrower.
    pageIdxs: confidence === "none" ? (model.pages ?? []).map((_, i) => i) : [...pageIdxs].sort((a, b) => a - b),
    confidence,
  };
}

// ---------------------------------------------------------------------------------------------
// §3.0 — does the EXISTING baseline drop an element the IR actually used?
//
// Phase 0 measured coverage for the new View and never for the thing it was proposed to replace.
// That is the wrong way round: if `toMicroModel` truncates a needed element, then the IR prompt is
// small AND wrong, and "the View is bigger" stops being an argument for keeping the baseline.
//
// This replicates ir.ts's prompt path EXACTLY rather than approximating it — Phase 0 used
// `pages[0].url` as the entry, which is not what ir.ts does and would mis-attribute a page-filter
// miss as a cap miss. Every step below is the same line ir.ts runs, and `toMicroModel` is imported,
// never reimplemented.
// ---------------------------------------------------------------------------------------------

/**
 * `live-extended` is the one that is NOT a defect, and separating it out is the whole reason this
 * check can be trusted.
 *
 * `04-ir.json` stores `{ ir, updatedAppModel }` — the model as it stood AFTER generation, because
 * `liveExtend` discovers pages and elements mid-IR that the original crawl never saw. A run whose
 * `02-appmodel.json` holds five elements can legitimately produce an IR grounded against eleven.
 * Scoring those as "toMicroModel dropped them" would blame the serializer for elements that did
 * not exist when it ran, and would have reported 29/29 runs truncating when the real answer is
 * different. A reference is only a truncation if it was in the source model and did not survive.
 */
type MissCause = "live-extended" | "page-filter" | "not-interactive" | "element-cap";

interface BaselineCheck {
  refs: number;
  missing: { label: string; cause: MissCause }[];
  entryUrl: string | null;
  pagesSent: number;
}

export function checkMicroBaseline(
  model: AppModel, ir: any, primaryCase: any, entryUrl: string | null,
): BaselineCheck {
  const refs = irReferences(ir);
  const uniqueRefs = [...new Map(refs.map((r) => [r.key, r])).values()];
  if (!entryUrl || uniqueRefs.length === 0) {
    return { refs: uniqueRefs.length, missing: [], entryUrl, pagesSent: 0 };
  }

  // ir.ts:1106-1107 and :1234
  let entryOrigin: string, entryPath: string;
  try {
    const u = new URL(entryUrl);
    entryOrigin = u.origin;
    entryPath = (u.pathname + u.search) || "/";
  } catch {
    return { refs: uniqueRefs.length, missing: [], entryUrl, pagesSent: 0 };
  }

  // ir.ts:1235-1246 — relevance filter on the case's own `feature`, entry page always kept.
  const featureLower = String(primaryCase?.feature ?? "").toLowerCase();
  const relevantPages = (model.pages ?? []).filter((p) => {
    if (p.url?.startsWith(entryOrigin) && entryPath && p.url.includes(entryPath)) return true;
    if (featureLower && (p.concepts ?? []).some((c) => c.toLowerCase().includes(featureLower))) return true;
    if (featureLower && p.url?.toLowerCase().includes(featureLower)) return true;
    return false;
  });
  const pagesToSend = relevantPages.length > 0 ? relevantPages : (model.pages ?? []).slice(0, 1);

  // ir.ts:1251+ — lead page first. Mirrors the fix: the case's own targetUrl decides, the path
  // test is only trusted when there IS a path, and a bare origin falls back to exact page
  // identity rather than to "whichever page contains '/'", i.e. all of them.
  const pk = (u: string) => {
    try { const x = new URL(u); return x.origin + (x.pathname.replace(/\/+$/, "") || "/"); }
    catch { return u; }
  };
  const targetPage = primaryCase?.targetUrl
    ? pagesToSend.find((p) => p.url && pk(p.url) === pk(String(primaryCase.targetUrl)))
    : undefined;
  const entryPage = entryPath !== "/"
    ? pagesToSend.find((p) => p.url?.startsWith(entryOrigin) && p.url.includes(entryPath))
    : pagesToSend.find((p) => p.url && pk(p.url) === pk(entryUrl));
  const leadPage = targetPage ?? entryPage;
  const orderedPages = leadPage ? [leadPage, ...pagesToSend.filter((p) => p !== leadPage)] : pagesToSend;

  // ir.ts:1257-1262
  const isInteractive = (e: Element) =>
    !!e.name && !!e.name.trim() && INTERACTIVE_ROLES.has((e.role ?? "").toLowerCase());
  const filtered = orderedPages.map((p) => ({ ...p, elements: (p.elements ?? []).filter(isInteractive) }));

  // ir.ts:1263+ — the real function, on the real input, told which page ir.ts chose rather than
  // left to re-resolve the entry URL and disagree.
  const micro = toMicroModel(
    { ...model, pages: filtered }, { currentPageUrl: filtered[0]?.url ?? entryUrl });

  // What the model can actually SEE is not `elements[]` alone. toMicroModel also emits a
  // `navigation` tree (each node carrying `text` and `role`) and a `forms` block (each field
  // carrying a `label`), and both go into the prompt verbatim. Counting only `elements[]` reported
  // three nav links on run 2026-08-25T10-06-10 as "dropped by the element cap" when the nav tree
  // listed all three, as links, with hrefs. A truncation check that ignores two thirds of the
  // prompt measures the serializer, not the model's knowledge.
  const inMicro = new Set<string>();
  const addNav = (nodes: any[] | undefined) => {
    for (const n of nodes ?? []) {
      if (n?.text) inMicro.add(elKey(n.role ?? "link", n.text));
      addNav(n?.children);
    }
  };
  for (const p of micro.pages ?? []) {
    for (const e of p.elements ?? []) inMicro.add(elKey(e.role, e.name));
    addNav((p as any).navigation);
    for (const f of (p as any).forms ?? []) {
      for (const fld of f?.fields ?? []) {
        if (!fld?.label) continue;
        // A form field reaches the model as a label; the IR may ground it under any input role.
        for (const role of ["textbox", "searchbox", "combobox", "checkbox", "radio"]) {
          inMicro.add(elKey(role, fld.label));
        }
      }
    }
  }

  // Where each survivor stood BEFORE toMicroModel, so a miss can be attributed rather than guessed.
  const onSentPages = new Set<string>();
  const onSentPagesInteractive = new Set<string>();
  for (const p of orderedPages) {
    for (const e of p.elements ?? []) {
      onSentPages.add(elKey(e.role, e.name));
      if (isInteractive(e)) onSentPagesInteractive.add(elKey(e.role, e.name));
    }
  }
  // toMicroModel keeps ONE page; anything on the others was never a cap decision.
  const microPageUrl = micro.pages?.[0]?.url;
  const onMicroPage = new Set<string>();
  for (const p of filtered) {
    if (p.url !== microPageUrl) continue;
    for (const e of p.elements ?? []) onMicroPage.add(elKey(e.role, e.name));
  }

  // Everything the SOURCE model ever contained, on any page. A reference absent from this was
  // never available to toMicroModel and cannot have been truncated by it.
  const inSourceModel = new Set<string>();
  for (const p of model.pages ?? []) {
    for (const e of p.elements ?? []) inSourceModel.add(elKey(e.role, e.name));
  }

  const missing = uniqueRefs
    .filter((r) => !inMicro.has(r.key))
    .map((r) => {
      let cause: MissCause;
      if (!inSourceModel.has(r.key)) cause = "live-extended";       // not a truncation — see MissCause
      else if (!onSentPages.has(r.key)) cause = "page-filter";
      else if (!onSentPagesInteractive.has(r.key)) cause = "not-interactive";
      else if (!onMicroPage.has(r.key)) cause = "page-filter";      // toMicroModel's single-page pick
      else cause = "element-cap";                                   // reached the page, lost to cap/compression
      return { label: r.label, cause };
    });

  return { refs: uniqueRefs.length, missing, entryUrl, pagesSent: orderedPages.length };
}

// ---------------------------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------------------------

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
const reduction = (base: number, now: number) => (base === 0 ? 0 : (base - now) / base);

/** §2.1 — a mean is the wrong headline for a token-pressure problem. */
export function stats(xs: number[]) {
  if (xs.length === 0) return { max: 0, p95: 0, median: 0, mean: 0, min: 0 };
  const s = [...xs].sort((a, b) => a - b);
  const at = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  return {
    max: s[s.length - 1], min: s[0],
    p95: at(0.95), median: at(0.5),
    mean: xs.reduce((a, b) => a + b, 0) / xs.length,
  };
}

interface Row {
  run: string; pages: number; els: number;
  raw: number; lite: number; micro: number; generic: number; test: number; irView: number;
  /** §3.2 decides the threshold in CHARS, so the plot has to carry both. */
  liteChars: number; testChars: number;
  covGeneric: number | null; covTest: number | null; missing: string[]; warnings: string[];
  baseline: BaselineCheck;
}

function main() {
  const root = "runs";
  const runIds = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name !== "_cache")
    .map((d) => d.name)
    .filter((id) => existsSync(path.join(root, id, "02-appmodel.json")))
    .sort();

  const rows: Row[] = [];

  for (const id of runIds) {
    const dir = path.join(root, id);
    const rawText = readFileSync(path.join(dir, "02-appmodel.json"), "utf8");
    let model: AppModel;
    try { model = JSON.parse(rawText); } catch { console.warn(`skip ${id}: unparseable appmodel`); continue; }
    const pages = model.pages ?? [];
    if (pages.length === 0) { console.warn(`skip ${id}: appmodel has no pages`); continue; }

    const readJson = (f: string) => {
      const p = path.join(dir, f);
      if (!existsSync(p)) return null;
      try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
    };
    const ir = readJson("04-ir.json");
    const cases = readJson("03-cases.json");
    const primaryCase = Array.isArray(cases) ? cases[0] : cases?.cases?.[0] ?? cases?.[0] ?? null;
    // ir.ts takes entryUrl as an argument; the run recorded it in its own input event.
    const input = readJson("00-input.json");
    const entryUrl: string | null = input?.url ?? ir?.meta?.baseUrl ?? null;

    // --- the two REAL baselines, produced by the repo's own functions -------------------------
    const withFilteredElements = (ps: PageModel[]) => ps.map((p) => ({
      ...p,
      elements: (p.elements ?? []).filter(
        (e) => e.name?.trim() && INTERACTIVE_ROLES.has((e.role ?? "").toLowerCase()),
      ),
    }));
    const liteJson = JSON.stringify(toLiteModel(model));                       // testCases.ts
    const microJson = JSON.stringify(
      toMicroModel({ ...model, pages: withFilteredElements(pages) }, { currentPageUrl: pages[0]?.url }),
    );                                                                          // ir.ts

    // --- the two Views ------------------------------------------------------------------------
    const generic = buildView(model);
    const req = primaryCase ? extractRequirements(model, primaryCase) : null;
    const test = req
      ? buildView(model, { pageIdxs: req.pageIdxs, requiredNames: req.requiredNames })
      : generic;

    // APPLES TO APPLES for the IR baseline. toMicroModel emits exactly ONE page; comparing it
    // against a View that renders every page measures page scope, not projection, and would
    // report a loss that is really just "the View was asked to carry more". So the IR-purpose
    // View is built over the same single page toMicroModel would have chosen.
    const irView = buildView(model, { pageIdxs: [0] });

    const refs = irReferences(ir);
    const sourceKeys = new Set<string>();
    for (const p of pages) for (const e of p.elements ?? []) sourceKeys.add(elKey(e.role, e.name));
    const checkable = refs.filter((r) => sourceKeys.has(r.key)).length > 0;
    const cg = checkable ? coverage(generic, refs, sourceKeys) : { pct: null, missing: [] as string[] };
    const ct = checkable ? coverage(test, refs, sourceKeys) : { pct: null, missing: [] as string[] };

    rows.push({
      run: id, pages: pages.length,
      els: pages.reduce((n, p) => n + (p.elements?.length ?? 0), 0),
      raw: countTokens(rawText),
      lite: countTokens(liteJson),
      micro: countTokens(microJson),
      generic: countTokens(generic.text),
      irView: countTokens(irView.text),
      test: countTokens(test.text),
      liteChars: liteJson.length, testChars: test.text.length,
      covGeneric: cg.pct, covTest: ct.pct,
      missing: ct.missing,
      warnings: [...generic.warnings, ...test.warnings],
      baseline: checkMicroBaseline(model, ir, primaryCase, entryUrl),
    });
  }

  // --- per-run table --------------------------------------------------------------------------
  console.log(`\nPhase 0 — View measurement over ${rows.length} run(s) with a saved AppModel\n`);
  console.log(
    "run".padEnd(21), "pg".padStart(3), "el".padStart(4),
    "raw".padStart(7), "lite".padStart(6), "micro".padStart(6),
    "genView".padStart(8), "testView".padStart(9),
    "vs lite".padStart(8), "vs micro".padStart(9), "cov".padStart(6),
  );
  console.log("-".repeat(112));
  for (const r of rows) {
    console.log(
      r.run.slice(0, 19).padEnd(21), String(r.pages).padStart(3), String(r.els).padStart(4),
      String(r.raw).padStart(7), String(r.lite).padStart(6), String(r.micro).padStart(6),
      String(r.generic).padStart(8), String(r.test).padStart(9),
      pct(reduction(r.lite, r.test)).padStart(8),
      pct(reduction(r.micro, r.test)).padStart(9),
      (r.covTest === null ? "n/m" : pct(r.covTest)).padStart(6),
    );
  }

  // --- aggregate ------------------------------------------------------------------------------
  const sum = (f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0);
  const tLite = sum((r) => r.lite), tMicro = sum((r) => r.micro);
  const tGen = sum((r) => r.generic), tTest = sum((r) => r.test);
  const measured = rows.filter((r) => r.covTest !== null);
  const fullCoverage = measured.filter((r) => (r.covTest ?? 0) >= 1).length;
  const withRefs = rows.filter((r) => r.missing.length > 0);

  console.log("\n" + "=".repeat(112));
  console.log("TOTALS");
  console.log(`  baseline  toLiteModel  (testCases.ts prompt)  ${tLite} tokens`);
  console.log(`  baseline  toMicroModel (ir.ts prompt)         ${tMicro} tokens`);
  console.log(`  generic View                                  ${tGen} tokens`);
  console.log(`  retrieved test View                           ${tTest} tokens`);
  console.log();
  console.log(`  generic View vs toLiteModel   ${pct(reduction(tLite, tGen))}`);
  console.log(`  test View    vs toLiteModel   ${pct(reduction(tLite, tTest))}`);
  const tIrView = sum((r) => r.irView);
  console.log(`  single-page IR View                           ${tIrView} tokens`);
  console.log(`  IR View      vs toMicroModel  ${pct(reduction(tMicro, tIrView))}   <- the fair, page-for-page IR comparison`);
  console.log(`  generic View vs toMicroModel  ${pct(reduction(tMicro, tGen))}   (all pages vs one — scope, not projection)`);
  console.log();
  console.log(`  irCoverage 100% on ${fullCoverage}/${measured.length} runs THAT HAVE grounded references`);
  console.log(`  (${rows.length - measured.length} run(s) have no saved IR references — NOT MEASURED, not counted as a pass)`);

  if (withRefs.length) {
    console.log("\n  DROPPED ELEMENTS (printed in full, per the spec):");
    for (const r of withRefs) console.log(`    ${r.run}: ${r.missing.join(" | ")}`);
  }
  const warned = rows.filter((r) => r.warnings.length);
  if (warned.length) {
    console.log("\n  BUDGET WARNINGS:");
    for (const r of warned) console.log(`    ${r.run}: ${r.warnings.join(" | ")}`);
  }

  // --- §3.0: does the EXISTING baseline truncate? ----------------------------------------------
  console.log("\n" + "=".repeat(112));
  console.log("§3.0  BASELINE TRUNCATION CHECK — does toMicroModel drop an element the IR used?");
  const checked = rows.filter((r) => r.baseline.refs > 0 && r.baseline.entryUrl);
  const isTruncation = (c: MissCause) => c !== "live-extended";
  const truncating = checked.filter((r) => r.baseline.missing.some((m) => isTruncation(m.cause)));
  const liveOnly = checked.filter(
    (r) => r.baseline.missing.length > 0 && !r.baseline.missing.some((m) => isTruncation(m.cause)));

  const byCause = new Map<MissCause, number>();
  for (const r of checked) {
    for (const m of r.baseline.missing) byCause.set(m.cause, (byCause.get(m.cause) ?? 0) + 1);
  }
  console.log(`  runs with a saved IR and a resolvable entry URL: ${checked.length}/${rows.length}`);
  console.log(`  reference misses by cause: ${[...byCause].map(([c, n]) => `${c}=${n}`).join("  ") || "none"}`);
  console.log(`  runs whose only misses are live-extended (NOT a truncation): ${liveOnly.length}`);
  console.log(`  runs where toMicroModel genuinely dropped an available element: ${truncating.length}`);

  if (truncating.length === 0) {
    console.log("  VERDICT: toMicroModel never drops an element it was actually given.");
    console.log("           The IR path is confirmed fine — close that half in TD-56.");
  } else {
    console.log("  AFFECTED RUNS:");
    for (const r of truncating) {
      console.log(`    ${r.run}  (${r.pages}pg ${r.els}el, ${r.baseline.pagesSent} page(s) sent)`);
      for (const m of r.baseline.missing.filter((x) => isTruncation(x.cause))) {
        console.log(`        [${m.cause}] ${m.label}`);
      }
    }
    console.log("  VERDICT: small-and-wrong beats big-and-right here. File as its own TD entry.");
  }

  // --- §2.1: distribution, and reduction against baseline size ---------------------------------
  console.log("\n" + "=".repeat(112));
  console.log("§2.1  TEST-CASES REDUCTION — distribution, not a mean");
  const perRun = rows.map((r) => reduction(r.lite, r.test));
  const s = stats(perRun);
  console.log(`  max ${pct(s.max)}   p95 ${pct(s.p95)}   median ${pct(s.median)}   mean ${pct(s.mean)}   min ${pct(s.min)}`);
  console.log(`  runs measuring a REGRESSION (View larger): ${perRun.filter((x) => x < 0).length}/${rows.length}`);

  console.log("\n  REDUCTION vs BASELINE SIZE  (this is what §3.2's threshold is picked from)");
  console.log("  " + "baseline chars".padStart(16), "runs".padStart(5), "median red.".padStart(12),
    "min red.".padStart(10), "  all positive?");
  const buckets: [number, number][] = [[0, 500], [500, 1000], [1000, 2000], [2000, 5000], [5000, 1e9]];
  for (const [lo, hi] of buckets) {
    const inB = rows.filter((r) => r.liteChars >= lo && r.liteChars < hi);
    if (inB.length === 0) continue;
    const red = inB.map((r) => reduction(r.lite, r.test));
    const st = stats(red);
    const label = hi >= 1e9 ? `>= ${lo}` : `${lo}-${hi}`;
    console.log("  " + label.padStart(16), String(inB.length).padStart(5),
      pct(st.median).padStart(12), pct(st.min).padStart(10),
      "  " + (st.min > 0 ? "YES" : "no"));
  }

  // Baseline SIZE turned out not to separate the winners from the losers: 87 elements in 15.5k
  // chars reduces 69%, while 108 elements in 6.1k chars REGRESSES 25%. What separates them is how
  // much of the baseline is NOT elements — toLiteModel also carries forms, navigation trees,
  // buttons, headings and breadcrumbs per page, and the View drops all of it. A baseline that is
  // mostly bare elements has nothing to give up, and the View's per-element ids then cost more
  // than compact JSON. So the honest predictor is baseline chars PER ELEMENT.
  console.log("\n  REDUCTION vs BASELINE DENSITY (chars per element) — the predictor that actually separates");
  console.log("  " + "chars/element".padStart(16), "runs".padStart(5), "median red.".padStart(12),
    "min red.".padStart(10), "  all positive?");
  const dens: [number, number][] = [[0, 60], [60, 90], [90, 130], [130, 1e9]];
  for (const [lo, hi] of dens) {
    const inB = rows.filter((r) => {
      const d = r.liteChars / Math.max(1, r.els);
      return d >= lo && d < hi;
    });
    if (inB.length === 0) continue;
    const red = inB.map((r) => reduction(r.lite, r.test));
    const st = stats(red);
    const label = hi >= 1e9 ? `>= ${lo}` : `${lo}-${hi}`;
    console.log("  " + label.padStart(16), String(inB.length).padStart(5),
      pct(st.median).padStart(12), pct(st.min).padStart(10),
      "  " + (st.min > 0 ? "YES" : "no"));
  }

  // Where exactly does the sign flip? Bucket boundaries hide the margin either side of the cliff,
  // and the threshold is only defensible if the gap around it is visible.
  console.log("\n  EVERY RUN BY DENSITY — the boundary, un-bucketed");
  console.log("  " + "ch/el".padStart(7), "els".padStart(5), "reduction".padStart(10), "  run");
  const byDensity = [...rows]
    .map((r) => ({ r, d: r.liteChars / Math.max(1, r.els), red: reduction(r.lite, r.test) }))
    .sort((a, b) => a.d - b.d);
  let flipped = false;
  for (const { r, d, red } of byDensity) {
    const marker = !flipped && red > 0 ? (flipped = true, "  <-- sign flips here") : "";
    console.log("  " + d.toFixed(1).padStart(7), String(r.els).padStart(5),
      pct(red).padStart(10), "  " + r.run.slice(0, 19) + marker);
  }
  const lastNeg = Math.max(...byDensity.filter((x) => x.red <= 0).map((x) => x.d));
  const firstPos = Math.min(...byDensity.filter((x) => x.red > 0).map((x) => x.d));
  console.log(`\n  highest density that still REGRESSES: ${lastNeg.toFixed(1)} ch/el`);
  console.log(`  lowest density that IMPROVES:         ${firstPos.toFixed(1)} ch/el`);
  console.log(`  usable gap for a threshold:           ${lastNeg.toFixed(1)} .. ${firstPos.toFixed(1)}`);

  console.log("\n  CHARS vs TOKENS — the plan gates on chars; these must track for that to be sound");
  const ratios = rows.map((r) => r.liteChars / Math.max(1, r.lite));
  const rs = stats(ratios);
  console.log(`    liteChars / liteTokens:  median ${rs.median.toFixed(2)}   min ${rs.min.toFixed(2)}   max ${rs.max.toFixed(2)}`);

  console.log("\n  THE LARGEST RUNS, named:");
  [...rows].sort((a, b) => b.lite - a.lite).slice(0, 5).forEach((r) => {
    console.log(`    ${r.run}  ${String(r.pages).padStart(2)}pg ${String(r.els).padStart(4)}el` +
      `  baseline ${String(r.lite).padStart(5)}tok / ${String(r.liteChars).padStart(6)}ch` +
      `  ->  ${pct(reduction(r.lite, r.test))}`);
  });

  // --- the gate -------------------------------------------------------------------------------
  // Each purpose is judged against the baseline it would actually replace.
  const testcasesReduction = reduction(tLite, tTest);   // View replaces toLiteModel
  const irReduction = reduction(tMicro, tIrView);       // View replaces toMicroModel
  const bestReduction = Math.max(testcasesReduction, irReduction);
  const coverageOk = measured.length > 0 && fullCoverage === measured.length;
  console.log("\n" + "=".repeat(112));
  console.log("ACCEPTANCE GATE");
  console.log(`  purpose "testcases"  View vs toLiteModel   ${pct(testcasesReduction)}`);
  console.log(`  purpose "ir"         View vs toMicroModel  ${pct(irReduction)}`);
  if (!coverageOk) {
    console.log("  VERDICT: coverage < 100%. Ranking or retrieval is wrong. Fix and re-measure.");
    console.log("           Do NOT proceed to Phase 1.");
  } else if (bestReduction >= 0.6) {
    console.log(`  VERDICT: reduction ${pct(bestReduction)} >= 60% and coverage 100%. Proceed to Phase 1.`);
  } else if (bestReduction < 0.4) {
    console.log(`  VERDICT: reduction ${pct(bestReduction)} < 40% on both View kinds.`);
    console.log("           The AppModel was not the token problem. STOP AND REPORT.");
  } else {
    console.log(`  VERDICT: reduction ${pct(bestReduction)} is between 40% and 60% — inconclusive.`);
    console.log("           The spec names no action for this band. Report and decide.");
  }
  console.log();
}

// Importing this file (the self-test does) must not run the whole measurement. Same guard shape
// as src/server/index.ts uses for app.listen().
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) main();
