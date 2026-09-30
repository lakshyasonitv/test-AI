import type { Step, Target } from "../schema/ir.js";
import { credentialKindsNeeded } from "./credentials.js";

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
// The vocabulary, as one exported list
// ---------------------------------------------------------------------------

/**
 * Every sentence shape `parseIrStep` accepts, written the way a person would type it.
 *
 * Exported because two callers need to SHOW it: the "ask for a change" prompt and the free-text
 * translation prompt both tell a model "use only these shapes". A second hand-maintained copy of
 * the list in a prompt file is TD-07 in miniature — the parser would gain a form, the prompt would
 * not, and the model would keep proposing sentences that no longer needed rewriting (or worse,
 * stop proposing ones that are now valid). One list, next to the parser that defines it.
 */
export const STEP_VOCABULARY: readonly string[] = [
  `Go to /path`,
  `Click on button "Name"`,
  `Type "value" into textbox "Name"`,
  `Choose "option" from combobox "Name"`,
  `Check checkbox "Name"`,
  `Press the Enter key`,
  `Wait briefly`,
  `Check that button "Name" appears on the page`,
  `Check that button "Name" is not shown`,
  `Check that the text "some words" is displayed`,
  `Check the page address contains "/path"`,
];

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
    // A css-only target has no words to show. That is not a rare edge: `buildLoginPrefix` grounds
    // every login step by css alone (`{ css: "#user-name" }`), deliberately — those selectors are
    // captured live by `loginOnPage`, never derived from the model. So every case that gets signed
    // in rendered `Type "..." into element`, `Click on element`, three times per case, in the
    // report a person actually reads. The selector is cryptic but it NAMES something; "element"
    // names nothing.
    //
    // Last, after `role`, on purpose: a target with a role already renders that word, and moving
    // css ahead of it would change what those sentences say — which `parseTargetDesc` would then
    // read as an edit and clear the grounding off an untouched line.
    : target?.role || target?.css || "element";

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

  // A bare css selector is what a css-only target renders as, and it carries NO semantic fields —
  // so it must read back the same as "element" did before it. This is the round-trip half of the
  // rendering change above: `mergeTarget` compares role/name/text/url, so returning {} leaves an
  // untouched login line semantically identical to its base and the step keeps its grounding.
  // Returning `{ name: "#user-name" }` instead would mark every such line EDITED and strip the
  // very selector the login depends on. Unquoted, so it can never collide with a real quoted name.
  if (/^[#.\[]/.test(trimmed) || trimmed.includes(">")) return {};

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

/** Actions that can change which page the flow is on, and therefore what a later step resolves
 *  against. `wait`, `fill`, `select`, `check` and `assert` cannot: they act on the page you are
 *  already on. This is what makes deleting a `Wait briefly` row free. */
const PAGE_CHANGING = new Set(["navigate", "click", "press"]);

/**
 * Pair each edited row with the original it came from.
 *
 * PASS 1 — exact text. Every row whose sentence is byte-identical to an original's rendering is
 * paired with the nearest unclaimed such original, scanning forward. That is what survives a
 * delete or an insert: the rows below the change still read exactly as they did, so they keep the
 * original they belong to rather than inheriting whichever one now sits at their index.
 *
 * PASS 2 — leftovers, in order, BETWEEN the anchors pass 1 established. An edited row (a changed
 * value, a fixed typo) matches nothing exactly, but it is still that step: pairing it keeps its
 * id and lets `parseIrStep` parse ONTO it, which is what makes a value edit free.
 *
 * The bound matters. Pairing leftovers positionally with no regard for the anchors — what the old
 * code effectively did — can hand row `i` an original from a completely different region, and
 * `parseIrStep` then resolves from the wrong step the fields a sentence cannot carry:
 * `text_contains` vs `text_equals`, `Wait briefly`'s millisecond value, `Press the Enter key`'s
 * target. Confining each run of leftovers to the originals lying between its neighbouring anchors
 * means a leftover can only ever pair with a step from the same place in the flow.
 *
 * Anything still unpaired is a genuinely new row and gets a fresh id.
 */
function alignRows(texts: string[], originals: Step[]): (number | null)[] {
  const rendered = originals.map((s) => formatIrStep(s).trim());
  const pairing: (number | null)[] = texts.map(() => null);
  const claimed = new Set<number>();

  // Pass 1, in order, so repeated identical sentences pair up first-to-first rather than all
  // fighting over one original. Scanning forward from 0 keeps the pairing stable and monotonic.
  for (let i = 0; i < texts.length; i++) {
    const raw = texts[i].trim();
    for (let j = 0; j < rendered.length; j++) {
      if (claimed.has(j) || rendered[j] !== raw) continue;
      pairing[i] = j;
      claimed.add(j);
      break;
    }
  }

  // Pass 2. Walk the anchored rows; between each consecutive pair, match the unclaimed rows
  // against the unclaimed originals that lie strictly between the same two anchors, in order.
  const anchors: number[] = [];
  for (let i = 0; i < texts.length; i++) if (pairing[i] !== null) anchors.push(i);

  const runs: { rows: number[]; lo: number; hi: number }[] = [];
  let cursorRow = 0;
  let lo = 0;
  for (const a of [...anchors, texts.length]) {
    const rows: number[] = [];
    for (let i = cursorRow; i < a; i++) if (pairing[i] === null) rows.push(i);
    const hi = a < texts.length ? (pairing[a] as number) : originals.length;
    if (rows.length) runs.push({ rows, lo, hi });
    cursorRow = a + 1;
    lo = a < texts.length ? (pairing[a] as number) + 1 : originals.length;
  }

  // Within a run, prefer an original of the SAME KIND before falling back to order.
  //
  // Without this, deleting a `Wait` and editing the row below it in one save pairs the edited
  // `Type "..." into textbox "Full Name"` with the now-unclaimed `wait` step simply because the
  // wait comes first among what is available. `parseIrStep` then parses a fill onto a wait base,
  // reports the target as changed, and charges a browser walk for a value edit.
  //
  // The kind is the sentence's leading verb — "Type", "Click", "Go", "Wait". That is this
  // system's OWN closed rendering vocabulary (`STEP_VOCABULARY`), not page text and not model
  // output, so matching on it is not the "regex over prose" trap `CLAUDE.md` warns about.
  const verb = (s: string) => s.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  for (const run of runs) {
    const available: number[] = [];
    for (let j = run.lo; j < run.hi; j++) if (!claimed.has(j)) available.push(j);

    // First pass over the run: same leading verb, in order.
    const rowsLeft: number[] = [];
    for (const row of run.rows) {
      const want = verb(texts[row]);
      const hit = available.find((j) => !claimed.has(j) && verb(rendered[j]) === want);
      if (hit === undefined) { rowsLeft.push(row); continue; }
      pairing[row] = hit;
      claimed.add(hit);
    }
    // Then whatever is left, in order — a row whose verb changed entirely is still that step.
    const rest = available.filter((j) => !claimed.has(j));
    for (let k = 0; k < rowsLeft.length && k < rest.length; k++) {
      pairing[rowsLeft[k]] = rest[k];
      claimed.add(rest[k]);
    }
  }
  return pairing;
}

/**
 * Read a whole edited step list back.
 *
 * Rows are paired with originals BY CONTENT (see `alignRows`), not by index. Position used to be
 * the whole story, and it made a delete or an insert far more expensive than it is: on the saved
 * "Admin creates a new user" case, deleting one `Wait briefly` row marked six rows changed,
 * queued five browser walks, and **renumbered every step below it** — the Full Name fill became
 * `s9`, the id the deleted Wait had, so version history and failure reports pointed at the wrong
 * step from then on (TECH_DEBT.md TD-90).
 *
 * WHEN A PAIRED ROW IS RE-GROUNDED. Two reasons, and only two:
 *
 *   (a) its own target text changed — it now points at a different element; or
 *   (b) the set of PAGE-CHANGING steps above it changed — a navigate/click/press was added,
 *       removed, or moved across it, so it may now resolve on a different page.
 *
 * (b) is deliberately about the MULTISET above the row, not "is there a page-changing step
 * anywhere above". Every row in a login case has clicks above it; what matters is whether those
 * clicks are the same ones, in the same number, as before. Deleting a `Wait` changes nothing
 * about them, so the whole tail stays instant — which is the case the defect was reported on.
 * Inserting a click at row 7 does change them for every row after it, and those rows genuinely
 * do need re-verifying.
 */
export function parseIrSteps(
  texts: string[],
  originals: Step[],
): { ok: true; result: ParsedSteps } | { ok: false; index: number; error: string } {
  if (!Array.isArray(texts) || texts.length === 0) {
    return { ok: false, index: 0, error: "a test needs at least one step" };
  }
  const pairing = alignRows(texts, originals);

  // Ids first, before any minting. A paired row keeps the id of the original it matched, so those
  // ids are spoken for — minting as the loop walks (what the old code did) lets a new row claim
  // an id a later paired row is about to keep.
  const preserved = new Set<string>();
  for (const j of pairing) if (j !== null) preserved.add(originals[j].id);
  let mintFrom: Step[] = [...originals];

  const steps: Step[] = [];
  const changedIndexes: number[] = [];
  const regroundIndexes: number[] = [];
  const usedIds = new Set<string>();

  // Reason (b) is about IDENTITY and POSITION, not wording. A page-changing step is identified by
  // the original it came from — or, for a brand-new row, by the row itself. So fixing a typo in a
  // click's name is reason (a) for that click alone; it does not claim that every later step now
  // resolves somewhere else, which keying on the name would.
  const pageChangingAbove = (upTo: number, keyAt: (n: number) => string | null): Set<string> => {
    const out = new Set<string>();
    for (let n = 0; n < upTo; n++) { const k = keyAt(n); if (k) out.add(k); }
    return out;
  };
  const originalKeyAt = (n: number) =>
    PAGE_CHANGING.has(originals[n].action) ? `o:${originals[n].id}` : null;
  const editedKeys: (string | null)[] = [];

  /**
   * Rows that MOVED — the "or moved past it" half of reason (b).
   *
   * A move is an inversion in the pairing: row `i` kept original `j`, but some other row that is
   * now on the far side of it kept an original that was on the near side. The set of
   * page-changing steps above cannot see this, because moving a step past rows that are not
   * page-changing leaves that set identical — which is exactly the "move a Save click up four
   * rows" case. Both the row that moved and the rows it crossed are re-verified: the mover runs
   * at a different point in the flow, and they run at a different point relative to it.
   */
  const moved = new Set<number>();
  for (let a = 0; a < texts.length; a++) {
    const ja = pairing[a];
    if (ja === null) continue;
    for (let b = a + 1; b < texts.length; b++) {
      const jb = pairing[b];
      if (jb === null) continue;
      if (jb < ja) { moved.add(a); moved.add(b); }
    }
  }

  for (let i = 0; i < texts.length; i++) {
    const j = pairing[i];
    const base = j === null ? undefined : originals[j];
    const parsed = parseIrStep(texts[i], base, nextStepId(mintFrom));
    if (!parsed.ok) return { ok: false, index: i, error: parsed.error };

    let step = parsed.step;
    // An id can still collide when the editor duplicated a row: both copies render identically,
    // pass 1 pairs the first and the second comes back as new but carrying the base's id.
    if (usedIds.has(step.id) || (j === null && preserved.has(step.id))) {
      step = { ...step, id: nextStepId(mintFrom) };
    }
    usedIds.add(step.id);
    mintFrom = [...mintFrom, step];

    steps.push(step);
    editedKeys.push(PAGE_CHANGING.has(step.action) ? (j === null ? `n:${i}` : `o:${originals[j].id}`) : null);
    if (parsed.changed) changedIndexes.push(i);

    if (parsed.targetChanged) {
      regroundIndexes.push(i);
    } else if (j !== null) {
      // Compare the page-changing steps above this row NOW against those that were above the
      // original it came from. Deleting a `Wait` changes neither set, so the tail stays free.
      const now = pageChangingAbove(i, (n) => editedKeys[n]);
      const then = pageChangingAbove(j, originalKeyAt);
      if (moved.has(i) || !sameSet(now, then)) regroundIndexes.push(i);
    }
  }
  return { ok: true, result: { steps, changedIndexes, regroundIndexes } };
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const k of a) if (!b.has(k)) return false;
  return true;
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
  /**
   * True when the walk has to sign in to arrive — i.e. a step it must replay was filled with a
   * real credential. The editor says so up front, because otherwise `Save — re-checks 1 step`
   * turns into an unannounced password prompt, and a surprise credential request is exactly the
   * kind of thing a person refuses on reflex.
   *
   * Cheap: read straight off the steps' `${env:...}` values, no browser, no guessing.
   */
  needsCredentials: boolean;
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

  // Mirrors regroundEditedIr's loop, which walks arrivals in ascending order and stops at the
  // cap — so the deepest prefix ACTUALLY replayed is the capped one, not `deepest`. Checking the
  // uncapped depth would promise a sign-in for steps the walk never reaches.
  const deepestWalked = arrivals.length
    ? Math.max(...[...arrivals].sort((a, b) => a - b).slice(0, cap))
    : 0;
  const needsCredentials = credentialKindsNeeded(parsed.steps.slice(0, deepestWalked)).length > 0;

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
    needsCredentials,
  };
}
