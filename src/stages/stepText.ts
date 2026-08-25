import type { Step, Target } from "../schema/ir.js";

/**
 * The IR <-> plain-English mapping, in ONE place.
 *
 * `formatIrStep` renders a step as the sentence a person edits ('Click on button "Sign in"').
 * `parseIrStep` reads that sentence back. The editor round-trips through both, so they have to
 * agree exactly — two copies of this mapping is TD-07 (targetResolver's locator logic restated in
 * generator.ts, then drifting) happening again in a new place.
 *
 * `public/app.js` has its own `formatIrStep` for display, and cannot import this: it is a classic
 * script with no module surface. That copy is NOT allowed to drift — `tests/stepText.test.ts`
 * extracts it from the file, evaluates it, and asserts it renders identically to this one for
 * every step of every saved case plus a fixture corpus. Drift is a failing test, not a silent bug.
 *
 * ---------------------------------------------------------------------------
 * THE FORMAT IS LOSSY, AND THAT SHAPES THE WHOLE CONTRACT.
 *
 * A rendered sentence carries the SEMANTIC target (role, name, text) and the value. It does not
 * carry `css`, `testId`, `nth`, `label`, `placeholder` or `preAction` — the deterministic identity
 * grounding wrote, and the only thing that makes an icon-only control addressable at all.
 *
 * So `parse(format(step))` can never reproduce a grounded step on its own, and asking it to would
 * be asking the format to be something it is not. What IS true, and what the tests pin:
 *
 *     parseIrStep(formatIrStep(step), step)  deep-equals  step
 *
 * Parsing takes the ORIGINAL step as its base. An unchanged sentence returns that step untouched —
 * byte-identical, `css` and `${env:...}` and all. A CHANGED sentence changes the semantic fields
 * and CLEARS the deterministic ones, because they described the element the user just stopped
 * pointing at. That cleared target is un-grounded by construction, which is precisely what makes
 * `caseEdit.ts` re-ground it before anything is saved.
 *
 * The ambiguities the merge resolves, none of which are recoverable from text alone:
 *   - `text_contains` and `text_equals` render the SAME sentence.
 *   - `wait` renders "Wait briefly", dropping its millisecond value.
 *   - `press` renders the key, dropping its target entirely.
 *   - `navigate` reads target.url OR value, and the sentence cannot say which it came from.
 * For an unchanged line the base supplies all four. For a genuinely new step there is no base, so
 * each falls back to a documented default.
 */

// ---------------------------------------------------------------------------
// IR -> English
// ---------------------------------------------------------------------------

/** Mirror of `formatIrStep` in public/app.js. Kept identical by tests/stepText.test.ts. */
export function formatIrStep(step: Step | null | undefined): string {
  if (!step || typeof step !== "object") return String(step);
  const action = step.action;
  const target = step.target;
  const targetDesc = target?.name
    ? `${target.role ? target.role + " " : ""}"${target.name}"`
    : target?.text
    ? `text "${target.text}"`
    : target?.url
    ? `"${target.url}"`
    : target?.role || "element";

  switch (action) {
    case "navigate":
      return `Go to ${target?.url ? target.url : step.value ? step.value : '"/"'}`;
    case "fill":
      return `Type "${step.value ?? ""}" into ${targetDesc}`;
    case "click":
      return `Click on ${targetDesc}`;
    case "select":
      return `Choose "${step.value ?? ""}" from ${targetDesc}`;
    case "check":
      return `Check ${targetDesc}`;
    case "press":
      return `Press the ${step.value ?? ""} key`;
    case "wait":
      return `Wait briefly`;
    case "assert": {
      const assertion = step.assertion || "visible";
      if (assertion === "visible") return `Check that ${targetDesc} appears on the page`;
      if (assertion === "hidden") return `Check that ${targetDesc} is not shown`;
      if (assertion === "url_contains") return `Check the page address contains "${step.value || target?.url || ""}"`;
      if (assertion === "text_contains") return `Check that the text "${step.value || ""}" is displayed`;
      if (assertion === "text_equals") return `Check that the text "${step.value || ""}" is displayed`;
      if (assertion === "enabled") return `Check that ${targetDesc} is enabled`;
      if (assertion === "disabled") return `Check that ${targetDesc} is disabled`;
      return `Check ${assertion} on ${targetDesc}${step.value ? ` ("${step.value}")` : ""}`;
    }
    default:
      return `${action} ${targetDesc}`;
  }
}

// ---------------------------------------------------------------------------
// English -> IR
// ---------------------------------------------------------------------------

export type ParseResult =
  | {
      ok: true;
      step: Step;
      /** Anything about the step differs — enough to mint a version. */
      changed: boolean;
      /**
       * The step now points at a DIFFERENT element, so its grounding was stripped and has to be
       * re-derived against the live site.
       *
       * This is the distinction the whole cost model rests on. Retyping a fill's VALUE changes
       * the step but not which box it types into — the `css` survives, nothing needs verifying,
       * and the save stays instant and free. Changing the box does need a browser. Conflating the
       * two would charge a browser walk for editing a password.
       */
      targetChanged: boolean;
    }
  | { ok: false; error: string };

/** Identity fields grounding wrote. Cleared whenever the semantic target changes — they point at
 *  the element the user just stopped describing, and a stale css is worse than none: it resolves,
 *  silently, to the wrong control. */
const GROUNDED_FIELDS = ["css", "testId", "nth", "label", "placeholder"] as const;

/** `role "name"` | `"name"` | `text "X"` | `role` | `element` */
function parseTargetDesc(desc: string): Target | null {
  const trimmed = desc.trim();
  if (!trimmed || trimmed === "element") return {};

  let m = /^text\s+"([\s\S]*)"$/.exec(trimmed);
  if (m) return { text: m[1] };

  // `role "name"` — role is a bare word before the quoted name.
  m = /^([A-Za-z][\w-]*)\s+"([\s\S]*)"$/.exec(trimmed);
  if (m) return { role: m[1], name: m[2] };

  // A bare quoted string is a name. It is also how a url-only target renders, but that only
  // happens for `navigate`, which never reaches here.
  m = /^"([\s\S]*)"$/.exec(trimmed);
  if (m) return { name: m[1] };

  // A bare word with no quotes is a role and nothing else.
  if (/^[A-Za-z][\w-]*$/.test(trimmed)) return { role: trimmed };

  return null;
}

/** True when two targets describe the same element semantically (ignoring grounded identity). */
function sameSemanticTarget(a: Target | undefined, b: Target | undefined): boolean {
  return (a?.role ?? "") === (b?.role ?? "")
    && (a?.name ?? "") === (b?.name ?? "")
    && (a?.text ?? "") === (b?.text ?? "")
    && (a?.url ?? "") === (b?.url ?? "");
}

/**
 * Build the target to store, given what the sentence said and what was there before.
 *
 * Unchanged -> the base target verbatim, `css` and all. Changed -> the parsed semantic fields
 * only, with every grounded field dropped so `groundingError` is forced to re-derive them.
 */
function mergeTarget(parsed: Target, base: Target | undefined): { target: Target; changed: boolean } {
  if (base && sameSemanticTarget(parsed, base)) return { target: { ...base }, changed: false };
  const next: Target = { ...parsed };
  for (const field of GROUNDED_FIELDS) delete (next as Record<string, unknown>)[field];
  return { target: next, changed: true };
}

/**
 * Read one edited sentence back into a step.
 *
 * `base` is the step the sentence was rendered from. When the text is unchanged this returns it
 * untouched — that identity is the round-trip property, and it is what stops an untouched line
 * from costing a browser walk. Omit `base` for a genuinely new step.
 */
export function parseIrStep(text: string, base?: Step, idHint?: string): ParseResult {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, error: "a step cannot be blank" };

  // Fast path, and the guarantee: an unedited sentence is the step it came from. Nothing is
  // re-derived, so `${env:...}` values, `preAction`, `nth` and `css` all survive by construction.
  if (base && raw === formatIrStep(base).trim()) return { ok: true, step: base, changed: false, targetChanged: false };

  const id = base?.id ?? idHint ?? "s1";
  const keep = <T,>(v: T | undefined, fallback: T): T => (v === undefined ? fallback : v);
  let m: RegExpExecArray | null;

  // -- navigate ------------------------------------------------------------
  if ((m = /^Go to\s+([\s\S]+)$/i.exec(raw))) {
    const dest = m[1].trim().replace(/^"([\s\S]*)"$/, "$1");
    if (!dest) return { ok: false, error: `step ${id}: "Go to" needs a path or URL` };
    // The sentence cannot say whether this came from target.url or value. Follow the base when
    // there is one; default to target.url otherwise, which is what every grounded IR uses.
    if (base && !base.target?.url && base.value !== undefined) {
      const changed = base.value !== dest;
      return { ok: true, step: { ...base, value: dest }, changed, targetChanged: false };
    }
    const changed = !base || base.target?.url !== dest;
    return { ok: true, step: { ...(base ?? { id, action: "navigate" }), id, action: "navigate", target: { url: dest }, ...(base?.value !== undefined ? { value: base.value } : {}) }, changed, targetChanged: changed };
  }

  // -- assert --------------------------------------------------------------
  // Tried before the bare `Check <target>` form below, which would otherwise swallow all of these.
  if ((m = /^Check the page address contains\s+"([\s\S]*)"$/i.exec(raw))) {
    const value = m[1];
    const changed = !base || base.assertion !== "url_contains" || (base.value || base.target?.url || "") !== value;
    return { ok: true, step: { ...(base ?? { id, action: "assert" }), id, action: "assert", assertion: "url_contains", value, target: undefined }, changed, targetChanged: false };
  }
  if ((m = /^Check that the text\s+"([\s\S]*)"\s+is displayed$/i.exec(raw))) {
    const value = m[1];
    // text_contains and text_equals render identically. Preserve whichever the base used;
    // default new steps to the looser one, which is what a person means by "is displayed".
    const assertion = base?.assertion === "text_equals" ? "text_equals" : "text_contains";
    const changed = !base || (base.value ?? "") !== value || (base.assertion !== "text_contains" && base.assertion !== "text_equals");
    return { ok: true, step: { ...(base ?? { id, action: "assert" }), id, action: "assert", assertion, value, target: keep(base?.target, undefined) }, changed, targetChanged: false };
  }
  const ASSERT_FORMS: [RegExp, Step["assertion"]][] = [
    [/^Check that\s+([\s\S]+?)\s+appears on the page$/i, "visible"],
    [/^Check that\s+([\s\S]+?)\s+is not shown$/i, "hidden"],
    [/^Check that\s+([\s\S]+?)\s+is enabled$/i, "enabled"],
    [/^Check that\s+([\s\S]+?)\s+is disabled$/i, "disabled"],
  ];
  for (const [re, assertion] of ASSERT_FORMS) {
    if ((m = re.exec(raw))) {
      const parsed = parseTargetDesc(m[1]);
      if (!parsed) return { ok: false, error: `step ${id}: could not read "${m[1]}" — write it as role "name", or text "the words on screen"` };
      const { target, changed: tChanged } = mergeTarget(parsed, base?.target);
      const changed = tChanged || !base || base.action !== "assert" || base.assertion !== assertion;
      return { ok: true, step: { ...(base ?? { id, action: "assert" }), id, action: "assert", assertion, target, value: keep(base?.value, undefined) }, changed, targetChanged: tChanged };
    }
  }

  // -- plain actions -------------------------------------------------------
  if ((m = /^Type\s+"([\s\S]*)"\s+into\s+([\s\S]+)$/i.exec(raw))) {
    const value = m[1];
    const parsed = parseTargetDesc(m[2]);
    if (!parsed) return { ok: false, error: `step ${id}: could not read "${m[2]}" — write it as role "name"` };
    const { target, changed: tChanged } = mergeTarget(parsed, base?.target);
    const changed = tChanged || !base || base.action !== "fill" || (base.value ?? "") !== value;
    return { ok: true, step: { ...(base ?? { id, action: "fill" }), id, action: "fill", target, value }, changed, targetChanged: tChanged };
  }
  if ((m = /^Click on\s+([\s\S]+)$/i.exec(raw))) {
    const parsed = parseTargetDesc(m[1]);
    if (!parsed) return { ok: false, error: `step ${id}: could not read "${m[1]}" — write it as role "name"` };
    const { target, changed: tChanged } = mergeTarget(parsed, base?.target);
    const changed = tChanged || !base || base.action !== "click";
    return { ok: true, step: { ...(base ?? { id, action: "click" }), id, action: "click", target, value: keep(base?.value, undefined) }, changed, targetChanged: tChanged };
  }
  if ((m = /^Choose\s+"([\s\S]*)"\s+from\s+([\s\S]+)$/i.exec(raw))) {
    const value = m[1];
    const parsed = parseTargetDesc(m[2]);
    if (!parsed) return { ok: false, error: `step ${id}: could not read "${m[2]}" — write it as role "name"` };
    const { target, changed: tChanged } = mergeTarget(parsed, base?.target);
    const changed = tChanged || !base || base.action !== "select" || (base.value ?? "") !== value;
    return { ok: true, step: { ...(base ?? { id, action: "select" }), id, action: "select", target, value }, changed, targetChanged: tChanged };
  }
  if ((m = /^Press the\s+([\s\S]*?)\s+key$/i.exec(raw))) {
    const value = m[1].trim();
    // The sentence drops the target entirely, so an edited "Press the X key" can only carry the
    // base's target forward. A new one has none, and the executor presses on the page body.
    const changed = !base || base.action !== "press" || (base.value ?? "") !== value;
    return { ok: true, step: { ...(base ?? { id, action: "press" }), id, action: "press", value, target: keep(base?.target, undefined) }, changed, targetChanged: false };
  }
  if (/^Wait briefly$/i.test(raw)) {
    // Renders without its millisecond value, so an edit can only preserve the base's.
    const changed = !base || base.action !== "wait";
    return { ok: true, step: { ...(base ?? { id, action: "wait" }), id, action: "wait", target: keep(base?.target, undefined), value: keep(base?.value, undefined) }, changed, targetChanged: false };
  }
  // Last, so every `Check that ...` assert form above wins over it.
  if ((m = /^Check\s+([\s\S]+)$/i.exec(raw))) {
    const parsed = parseTargetDesc(m[1]);
    if (parsed) {
      const { target, changed: tChanged } = mergeTarget(parsed, base?.target);
      const changed = tChanged || !base || base.action !== "check";
      return { ok: true, step: { ...(base ?? { id, action: "check" }), id, action: "check", target, value: keep(base?.value, undefined) }, changed, targetChanged: tChanged };
    }
  }

  return {
    ok: false,
    error:
      `step ${id}: could not read "${raw}". Write one of: ` +
      `Go to /path · Click on button "Name" · Type "value" into textbox "Name" · ` +
      `Choose "option" from combobox "Name" · Check checkbox "Name" · Press the Enter key · ` +
      `Check that button "Name" appears on the page · Check that the text "..." is displayed · ` +
      `Check the page address contains "/path"`,
  };
}

/** The next never-before-used step id. Ids name the failing step in a report, so reusing one
 *  misattributes a failure to a step that is no longer there. */
export function nextStepId(steps: Step[]): string {
  let max = 0;
  for (const s of steps) {
    const m = /^s(\d+)$/.exec(s.id ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `s${max + 1}`;
}

export interface ParsedSteps {
  steps: Step[];
  /** Indices that differ in any way — enough to mint a new version. */
  changedIndexes: number[];
  /**
   * Indices that now point at a different element, and so must be re-verified against the live
   * site. A subset of `changedIndexes`, and the ONLY thing that makes a save cost anything: an
   * empty list means the save is instant, free, and never opens a browser.
   */
  regroundIndexes: number[];
}

/**
 * Read a whole edited step list back.
 *
 * `originals` are matched positionally, which is what makes an untouched row free: same text at
 * the same index returns the same object. A row that moved is treated as changed, because its
 * target may now be resolved on a different page — position is part of a step's meaning here.
 */
export function parseIrSteps(
  texts: string[],
  originals: Step[],
): { ok: true; result: ParsedSteps } | { ok: false; index: number; error: string } {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { ok: false, index: 0, error: "a test needs at least one step" };
  }
  const steps: Step[] = [];
  const changedIndexes: number[] = [];
  const regroundIndexes: number[] = [];
  const usedIds = new Set<string>();

  for (let i = 0; i < texts.length; i++) {
    const base = originals[i];
    const parsed = parseIrStep(texts[i], base, nextStepId([...originals, ...steps]));
    if (!parsed.ok) return { ok: false, index: i, error: parsed.error };

    let step = parsed.step;
    // Two rows can only share an id if the editor duplicated one; mint a fresh id rather than
    // letting a failure report point at an ambiguous step.
    if (usedIds.has(step.id)) step = { ...step, id: nextStepId([...originals, ...steps]) };
    usedIds.add(step.id);

    steps.push(step);
    if (parsed.changed) changedIndexes.push(i);
    // A step that MOVED is caught by this same check without special handling: originals are
    // matched POSITIONALLY, so a step that shifted is compared against whatever used to sit at
    // its new index, and a different element there reads as a changed target. That is the right
    // answer — a step's target resolves on whatever page the steps before it arrive at, so
    // moving it genuinely does need re-verifying.
    if (parsed.targetChanged) regroundIndexes.push(i);
  }
  return { ok: true, result: { steps, changedIndexes, regroundIndexes } };
}

export interface RegroundEstimate {
  /** Rows that differ at all. */
  changedSteps: number;
  /** Rows whose element must be re-verified — what actually costs anything. */
  stepsToVerify: number;
  /** Step ids of those rows, so the editor can mark exactly which ones will be checked. */
  stepIdsToVerify: string[];
  /** Steps that must be EXECUTED to arrive at the earliest change. You cannot check step 7
   *  without running 1-6, and this is the number that dominates the wait. */
  stepsToReplay: number;
  /** Browser walks. Deduped by arrival point and capped by MAX_LIVE_EXTENSIONS. */
  snapshots: number;
  /** Upper bound on model calls. Grounding is DOM-first and usually spends none; a page that
   *  needs vision to model costs one per snapshot, so this is the ceiling, not the expectation. */
  maxLlmCalls: number;
  /** Rough seconds, for setting expectations only. */
  estimatedSeconds: number;
  /** True when the save needs no browser at all — the fast path. */
  instant: boolean;
}

/**
 * What a save would cost, WITHOUT doing any of it.
 *
 * Pure arithmetic over the diff — no browser, no model, no database write. This is what lets the
 * editor say "this will re-check 2 steps, about 40 seconds" *before* Save is clicked, so a save
 * that spends real time and money is never a surprise.
 */
export function estimateRegrounding(
  parsed: ParsedSteps,
  opts: { maxSnapshots?: number } = {},
): RegroundEstimate {
  const cap = opts.maxSnapshots ?? Number(process.env.MAX_LIVE_EXTENSIONS ?? 5);
  const toVerify = parsed.regroundIndexes;

  // One walk per distinct arrival point; two edits on the same page share a walk. An edit at
  // index 0 acts on the entry page, which needs no walk to reach.
  const arrivals = [...new Set(toVerify.map((i) => i))].filter((i) => i > 0);
  const snapshots = Math.min(arrivals.length, cap);
  const stepsToReplay = toVerify.length ? Math.max(0, Math.min(...toVerify)) : 0;
  // The deepest walk dominates; earlier ones are cached by prefix.
  const deepest = arrivals.length ? Math.max(...arrivals) : 0;

  return {
    changedSteps: parsed.changedIndexes.length,
    stepsToVerify: toVerify.length,
    stepIdsToVerify: toVerify.map((i) => parsed.steps[i]?.id).filter(Boolean) as string[],
    stepsToReplay,
    snapshots,
    maxLlmCalls: snapshots,
    // ~2s per replayed step plus ~8s of browser launch and settle per snapshot. Deliberately a
    // coarse over-estimate: a save that finishes sooner than promised is a good surprise.
    estimatedSeconds: snapshots === 0 ? 0 : Math.round(snapshots * 8 + deepest * 2),
    instant: toVerify.length === 0,
  };
}
