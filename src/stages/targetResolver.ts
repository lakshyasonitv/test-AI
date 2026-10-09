import type { Page, Locator, FrameLocator } from "playwright";
import type { Target } from "../schema/ir.js";

const q = (s: string) => JSON.stringify(s);

/**
 * Where a target is looked for: the page itself, or the same-origin iframe `Target.frame` names.
 * Everything below that reads only `locator`/`getBy*` takes this rather than `Page`, because a
 * `FrameLocator` offers exactly that surface — and nothing else, which is the point: a helper
 * that also needs `waitForTimeout`/`goto`/`url` keeps the real `page` and takes the root
 * separately.
 */
export type LocatorRoot = Page | FrameLocator;

/** Separator between the per-`<iframe>` selectors in `Target.frame` (outermost first). */
export const FRAME_PATH_SEPARATOR = " >>> ";

/** `Target.frame` split into one selector per `<iframe>`, outermost first; [] for none. */
export function frameSegments(frame?: string): string[] {
  return (frame ?? "").split(FRAME_PATH_SEPARATOR).map((s) => s.trim()).filter(Boolean);
}

/**
 * The root a target's locator hangs off, as SOURCE CODE for the generated spec: `page` when the
 * target has no frame — byte-identical to every spec emitted before frames existed — else
 * `page.frameLocator(a).frameLocator(b)...`.
 */
export function frameRootCode(t: Target): string {
  return frameSegments(t.frame).reduce((acc, seg) => `${acc}.frameLocator(${q(seg)})`, "page");
}

/** The live twin of `frameRootCode`: the same chain, built on a real page. */
export function frameRoot(page: Page, t: Target): LocatorRoot {
  let root: LocatorRoot = page;
  for (const seg of frameSegments(t.frame)) root = root.frameLocator(seg);
  return root;
}

/**
 * Resolvers for target fields OTHER than role+name — label → placeholder → text → testId,
 * in priority order. role+name is handled separately below since it alone gets the
 * self-healing fallback chain: a site rename or button<->link swap is by far the most
 * common real-world locator break, and these other fields are comparatively stable (a
 * label/placeholder rarely drifts independently of the element it's attached to).
 */
const RESOLVERS: Array<{
  match: (t: Target) => boolean;
  code: (t: Target, root: string) => string;
  live: (root: LocatorRoot, t: Target) => Locator;
}> = [
  // css first: it is only ever set by discovery, from an element it verified exists, and it
  // is the only way to reach a control whose accessible name is empty (icon-only cart,
  // close, search). Everything below is a name-based guess by comparison.
  { match: (t) => !!t.css,         code: (t, r) => `${r}.locator(${q(t.css!)})`,                  live: (p, t) => p.locator(t.css!) },
  { match: (t) => !!t.label,       code: (t, r) => `${r}.getByLabel(${q(t.label!)})`,             live: (p, t) => p.getByLabel(t.label!) },
  { match: (t) => !!t.placeholder, code: (t, r) => `${r}.getByPlaceholder(${q(t.placeholder!)})`, live: (p, t) => p.getByPlaceholder(t.placeholder!) },
  { match: (t) => !!t.text,        code: (t, r) => `${r}.getByText(${q(t.text!)})`,                live: (p, t) => p.getByText(t.text!) },
  { match: (t) => !!t.testId,      code: (t, r) => `${r}.getByTestId(${q(t.testId!)})`,            live: (p, t) => p.getByTestId(t.testId!) },
];

function pick(t: Target) {
  const r = RESOLVERS.find((r) => r.match(t));
  if (!r) throw new Error(`No semantic locator for target: ${JSON.stringify(t)}`);
  return r;
}

/**
 * Actions that can only ever act on a form control. `getByText` is not merely a weak choice
 * for these — it is categorically wrong, because it matches the element CONTAINING the text,
 * which for a labelled field is the label. Seen in production: `fill { text: "Name" }` became
 * `getByText('Name')`, resolved to `<label>Full Name</label>`, and Playwright refused with
 * "Element is not an <input>, <textarea>, <select> or [contenteditable]".
 */
const FIELD_ACTIONS = new Set(["fill", "select", "check"]);

/** The human-facing string that identifies a field, whichever slot the IR put it in. */
export function fieldHint(t: Target): string {
  return t.label || t.name || t.placeholder || t.text || "";
}

export const isFieldAction = (action?: string) => !!action && FIELD_ACTIONS.has(action);

/**
 * Positional fallback for a field with no accessible name and no stable selector — the
 * `<div>Full Name</div><input>` shape, where the only thing tying the control to its label is
 * layout. `:near()` is Playwright's built-in layout engine, so this needs no extra dependency,
 * and `:text()` matches on substring — which is exactly what lets a request that says "Name"
 * reach a field labelled "Full Name".
 *
 * ponytail: one positional strategy, not four. `:near` covers a label above, beside, or before
 * the input; if a layout ever needs strict direction, `:below(...)`/`:right-of(...)` are the
 * upgrade path.
 */
export function nearFieldSelector(hint: string, action?: string): string {
  const anchor = `:text(${JSON.stringify(hint)})`;
  // A `select` step must never fall back onto a plain <input>/<textarea>. `selectOption()` cannot
  // act on one — Playwright refuses with "Element is not a <select> element" — so handing back
  // whichever control happened to be physically nearest turns a resolvable step into a hard
  // failure. That is exactly how run 2026-09-04T10-38-19-619Z-bf20906d died on a valid case:
  // the anchor text "Manager" sat beside a React combobox, and this selector returned its
  // <input>. See TECH_DEBT.md TD-70.
  //
  // `[role="combobox"]` stays in, because a custom dropdown IS usually an <input> — it is the
  // ROLE, not the tag, that says the element can take a choice. What is excluded is an
  // input/textarea with nothing vouching for it.
  const tags = action === "select"
    ? ["select", '[role="combobox"]']
    : ["input", "textarea", "select"];
  return tags.map(tag => `${tag}:near(${anchor}, 120)`).join(", ");
}

// button<->link is the single most common real-world role mismatch (a styled <a> used as a
// button, or vice versa) — the fallback chain covers exactly this, not an open-ended set.
const ROLE_SWAP: Record<string, string> = { button: "link", link: "button" };

// ---------------------------------------------------------------------------
// Shared with the generated spec — ONE definition, two consumers
// ---------------------------------------------------------------------------
//
// TD-07 says `targetResolver.ts` and generator.ts's injected helpers are the same algorithm
// written twice and have already drifted. These constants are the fix for the part that matters
// most: the generated spec cannot import, but Playwright's `evaluate()` accepts a **string**, so
// the in-page logic below is authored once here and interpolated into the emitted helper verbatim.
// It is not "kept in sync" — it is the same characters in both places.

/** Anything that can take a typed or chosen value. Role, not tag: a combobox is often an input. */
export const FIELD_SELECTOR = 'input, textarea, select, [role="combobox"]';

/**
 * The field selector for one ACTION — the same narrowing `nearFieldSelector` applies, and for the
 * same reason (TD-70): `selectOption()` cannot act on a plain `<input>`, so offering one to a
 * `select` step can only turn a resolvable step into a hard failure.
 *
 * This exists because the DOM-order rung has to narrow too. While that rung was dead (TD-78) it
 * did not matter; the moment it started running, an unnarrowed version handed a `select` step the
 * `<input>` sitting after the label — re-introducing TD-70 through a different door. Caught by
 * `selectAction.test.ts`'s "does NOT resolve a select step onto a plain input", which is exactly
 * the regression test that guard was written to be.
 */
export function fieldSelectorFor(action?: string): string {
  return action === "select" ? 'select, [role="combobox"]' : FIELD_SELECTOR;
}

/**
 * An open modal. The first two are the accessible contract; the class sniff is a last resort for
 * the very common hand-rolled overlay that sets neither, and is deliberately last so a correctly
 * marked-up dialog never depends on it.
 */
export const DIALOG_SELECTOR =
  '[role="dialog"], [aria-modal="true"], [class*="dialog" i], [class*="modal" i]';

/**
 * Find the control a visible label belongs to, by DOM ORDER rather than by pixel distance.
 *
 * THE FAILURE THIS REPLACES. Run `2026-09-06T13-05-36-248Z-db2c0b4c`: a New User modal with
 * `Full Name` and `Email` stacked ~46px apart. `Email`'s label is inside the 120px `:near()`
 * radius of the Full Name INPUT, and `.first()` breaks the tie by document order — so
 * `fill "Email"` resolved to the Full Name box and overwrote what step 10 had just typed there.
 * The screenshot shows Full Name holding an email address and Email empty. That is TD-72, and it
 * is not a tie-break bug so much as the wrong question: the control a label describes is the next
 * one AFTER it, which the DOM says exactly and geometry only approximates.
 *
 * Returns an INDEX into `root.querySelectorAll(FIELD_SELECTOR)` rather than an element, so the
 * caller can rebuild a real Locator (`root.locator(FIELD_SELECTOR).nth(i)`) instead of holding an
 * ElementHandle or mutating the page with a marker attribute. -1 when nothing matches.
 *
 * Written as a string with `for` loops and no inner named or `const`-assigned functions:
 * `tsx`/esbuild rewrites those to call a `__name` helper that does not exist in the browser
 * (CLAUDE.md sharp edges, TD-40). It passes every unit test and throws only on a real run.
 *
 * IT IS A STRING SO THE GENERATOR CAN INTERPOLATE IT AS SOURCE, not so it can be handed to
 * `evaluate()` directly. See `domOrderFieldFn` below — passing this string straight to
 * `Locator.evaluate()` silently returns `undefined`, which is TD-78.
 */
export const DOM_ORDER_FIELD_JS = `(root, arg) => {
  const FIELD_SEL = arg.fieldSel;
  const want = String(arg.wanted).replace(/\\s+/g, " ").trim().toLowerCase();
  const fields = Array.prototype.slice.call(root.querySelectorAll(FIELD_SEL));

  // Only fields a person could actually use. A hidden control can still be "next in DOM order".
  const visible = [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    let ok = false;
    try {
      const cs = getComputedStyle(f);
      const r = f.getBoundingClientRect();
      ok = r.width > 0 && r.height > 0 && cs.display !== "none" && cs.visibility !== "hidden";
    } catch (e) { ok = false; }
    if (ok) visible.push(i);
  }

  // Candidate label nodes: a real <label>, or a LEAF element whose whole text is the name — the
  // <div>Full Name</div><input> shape that has no accessible relationship at all. Restricting the
  // non-label case to leaves stops a whole card or form matching because it contains the word.
  const all = Array.prototype.slice.call(root.querySelectorAll("label, span, div, p, td, th, legend, strong, b"));
  const labels = [];
  const generic = [];
  for (let n = 0; n < all.length; n++) {
    const node = all[n];
    if (node.tagName !== "LABEL" && node.children.length > 0) continue;
    if ((node.textContent || "").replace(/\\s+/g, " ").trim().toLowerCase() !== want) continue;
    if (node.tagName === "LABEL") labels.push(node); else generic.push(node);
  }

  // An explicit for= is the strongest statement the DOM can make; take it over position.
  for (let n = 0; n < labels.length; n++) {
    const forId = labels[n].getAttribute("for");
    if (!forId) continue;
    for (let i = 0; i < fields.length; i++) {
      if (fields[i].id === forId && visible.indexOf(i) !== -1) return i;
    }
  }

  // Then position — <label> candidates BEFORE generic ones.
  //
  // This ordering was learned from the live page, not guessed. On the LMS's New User modal the
  // word "Manager" appears SIX times inside the resolution scope: five are role badges on the
  // user rows BEHIND the modal (spans), and only the sixth is the field's own <label>. Taking
  // the first match in document order picked a badge — and because a badge sits far above the
  // form, EVERY control "follows" it, so the rung returned the first select on the page (Role)
  // with complete confidence. A <label> is a statement that this text names a control; a <span>
  // carrying the same text is a guess, so the statement wins.
  //
  // Within LABELS, first in document order — unchanged behaviour, and deliberately so. Two
  // legitimately identical labels (a login form's "Email" and a footer newsletter's) is a far
  // more common page than a decoy <label>, and the first is the one in the main content.
  //
  // Within GENERIC leaves, LAST in document order, because that is where decoys actually live:
  // badges, chips and table cells repeat a word many times above the form, and the last match is
  // the one nearest its control. A spurious match AFTER the form drops out on its own, since
  // nothing follows it.
  for (let g = 0; g < 2; g++) {
    const group = g === 0 ? labels : generic;
    for (let m = 0; m < group.length; m++) {
      const node = g === 0 ? group[m] : group[group.length - 1 - m];
      // The first visible field that FOLLOWS this candidate. A label that WRAPS its input also
      // lands here: a contained node reports as following.
      for (let k = 0; k < visible.length; k++) {
        const i = visible[k];
        if (node.compareDocumentPosition(fields[i]) & Node.DOCUMENT_POSITION_FOLLOWING) return i;
      }
    }
  }
  return -1;
}`;

/**
 * The same logic as a REAL function, which is the only form `evaluate()` actually runs.
 *
 * TD-78, and the reason TD-72's rung 4 never executed once. `Locator.evaluate()` accepts a
 * `string`, so `scope.evaluate(DOM_ORDER_FIELD_JS, hint)` type-checks and does not throw — but
 * Playwright evaluates a string as an EXPRESSION. The expression here is a function literal, so
 * the page dutifully constructs a function, returns it, and a function is not serialisable across
 * the CDP boundary: the call resolves to `undefined`. `undefined >= 0` is false, so the rung
 * reported "no match" every single time and every lookup fell through to geometry — which is what
 * put step 12 of run `2026-09-06T14-19-13-154Z-fed833e5` on the Role dropdown.
 *
 * Nothing failed loudly. It type-checked, it passed the unit tests (which exercise `field()`
 * end-to-end, where geometry quietly covers for the dead rung on a simple page), and it ran green
 * against a real browser. `DECISIONS.md` D-19 says a generated Playwright expression is not
 * verified until it is run once; the sharper form is that it is not verified until it is run
 * against a page where the WRONG answer differs from the right one.
 *
 * Built with `new Function` rather than by writing the body twice: the string stays the single
 * source of truth the generator interpolates, so the two implementations cannot drift (TD-07).
 * `new Function` here runs in Node only to produce the function object — the body itself is
 * serialised by Playwright and executed in the browser, exactly as before. Because it is built
 * from a literal in this file and never from input, it is not an eval-of-untrusted-data path.
 */
export const domOrderFieldFn = new Function(`return (${DOM_ORDER_FIELD_JS});`)() as
  (root: Element, arg: { wanted: string; fieldSel: string }) => number;

/** How long a select step waits for its options and for the action itself. */
export const SELECT_TIMEOUT_MS = Number(process.env.SELECT_TIMEOUT_MS ?? 10000);

/**
 * Walk from whatever the step resolved to, to the control that can actually be SELECTED.
 *
 * A `select` step's target is matched by ROLE, and a role match is not a promise about the tag.
 * The resolved node can be a wrapper `<div>`, the `<label>`, or a custom control with the real
 * `<select>` hidden behind it (the headless-UI pattern: a styled button plus a visually-hidden
 * native select that carries the form value). In all three cases neither branch of `choose()`
 * applies and the step dies on something that was never the control.
 *
 * Order: the element itself if it is already selectable; a `<select>` inside it; the control its
 * `for=` names; a `[role=combobox|listbox]` inside it; then a `<select>` in a NEARBY ancestor,
 * bounded to three levels so a match cannot come from the far side of the page. A hidden native
 * select is deliberately eligible at that last step and preferred over the custom shell, because
 * `selectOption()` on it sets the value the form actually submits.
 *
 * Returns an INDEX into `document.querySelectorAll(FIELD_SELECTOR)`, for the same reason
 * DOM_ORDER_FIELD_JS does: the caller rebuilds a real Locator instead of holding an
 * ElementHandle. -1 when the element is not selectable and nothing near it is.
 */
export const SELECTABLE_JS = `(el, fieldSel) => {
  let found = null;
  const role = el.getAttribute ? (el.getAttribute("role") || "") : "";
  if (el.tagName === "SELECT" || role === "combobox" || role === "listbox") {
    found = el;
  } else {
    const inner = el.querySelector ? el.querySelector("select") : null;
    if (inner) {
      found = inner;
    } else if (el.tagName === "LABEL" && el.getAttribute("for")) {
      const t = document.getElementById(el.getAttribute("for"));
      if (t) found = t;
    }
    if (!found && el.querySelector) {
      const cb = el.querySelector('[role="combobox"], [role="listbox"]');
      if (cb) found = cb;
    }
    // A visible custom control with the real <select> hidden alongside it. Bounded to three
    // ancestors: far enough to leave the styled shell, near enough that a match is still the
    // same field rather than the next one down the form.
    //
    // NOT querySelector("select"), which is first-in-subtree and not nearest — from a wrapper
    // inside a two-column form row, the first select in the container three levels up is the
    // OTHER field's. That is exactly the mistake the DOM-order rung above was making. Prefer a
    // select that FOLLOWS this element, and only fall back to one before it.
    if (!found) {
      let p = el.parentElement;
      for (let up = 0; up < 3 && p && !found; up++) {
        const cands = Array.prototype.slice.call(p.querySelectorAll("select"));
        for (let i = 0; i < cands.length; i++) {
          if (el.compareDocumentPosition(cands[i]) & Node.DOCUMENT_POSITION_FOLLOWING) { found = cands[i]; break; }
        }
        if (!found && cands.length > 0) found = cands[cands.length - 1];
        p = p.parentElement;
      }
    }
  }
  if (!found) return -1;
  const all = Array.prototype.slice.call(document.querySelectorAll(fieldSel));
  return all.indexOf(found);
}`;
export const selectableFn = new Function(`return (${SELECTABLE_JS});`)() as
  (el: Element, fieldSel: string) => number;

/**
 * Is this `<select>` populated, and does it hold the wanted option?
 *
 * Returns both facts in one round trip so the caller can tell "not loaded yet" from "loaded, and
 * your value is not in it" — the distinction that decides whether waiting is useful. `populated`
 * ignores the placeholder row (`<option value="">Select...</option>`), which is present from the
 * first paint and would otherwise make an empty control look ready.
 *
 * Matching is trimmed and case-insensitive on label OR value, then containment either way.
 * `selectOption()` itself is an exact match, which is why a step saying `prashant mishra` could
 * not select `<option>Prashant Mishra</option>` (TD-76).
 */
export const OPTION_PROBE_JS = `(el, wanted) => {
  const want = String(wanted).replace(/\\s+/g, " ").trim().toLowerCase();
  const opts = el.options || [];
  let populated = false;
  for (let i = 0; i < opts.length; i++) {
    const label = (opts[i].label || opts[i].textContent || "").replace(/\\s+/g, " ").trim();
    const val = (opts[i].value || "").replace(/\\s+/g, " ").trim();
    if (val.length > 0 || (label.length > 0 && i > 0)) populated = true;
    if (label.toLowerCase() === want || val.toLowerCase() === want) return { index: i, populated: true };
  }
  for (let i = 0; i < opts.length; i++) {
    const label = (opts[i].label || opts[i].textContent || "").replace(/\\s+/g, " ").trim().toLowerCase();
    if (label.length > 0 && (label.indexOf(want) !== -1 || want.indexOf(label) !== -1)) {
      return { index: i, populated: true };
    }
  }
  return { index: -1, populated: populated };
}`;
export const optionProbeFn = new Function(`return (${OPTION_PROBE_JS});`)() as
  (el: Element, wanted: string) => { index: number; populated: boolean };

/** The same matching, over a list of strings — for a custom dropdown, whose items are not options. */
export const MATCH_OPTION_INDEX_JS = `(texts, wanted) => {
  const want = String(wanted).replace(/\\s+/g, " ").trim().toLowerCase();
  for (let i = 0; i < texts.length; i++) {
    if (String(texts[i]).replace(/\\s+/g, " ").trim().toLowerCase() === want) return i;
  }
  for (let i = 0; i < texts.length; i++) {
    const t = String(texts[i]).replace(/\\s+/g, " ").trim().toLowerCase();
    if (t.length > 0 && (t.indexOf(want) !== -1 || want.indexOf(t) !== -1)) return i;
  }
  return -1;
}`;
export const matchOptionIndexFn = new Function(`return (${MATCH_OPTION_INDEX_JS});`)() as
  (texts: string[], wanted: string) => number;

/**
 * The message a missing option fails with.
 *
 * Playwright's own is "did not find some options", which names neither the value that was wanted
 * nor the ones that exist — so the only way to learn the option was spelled differently was to
 * re-run the case and watch the video. Listing what was on offer turns that into a ten-second
 * fix, and it is what the case card renders under Defect 1's error line.
 */
export const OPTION_ERROR_JS = `(wanted, available) => {
  const list = Array.prototype.slice.call(available || []);
  const shown = list.slice(0, 12).map(t => JSON.stringify(String(t))).join(", ");
  const more = list.length > 12 ? " (+" + (list.length - 12) + " more)" : "";
  if (list.length === 0) {
    return 'select: no option matching ' + JSON.stringify(String(wanted)) +
      ' — the control had no options at all (it may not be the right control, or its list never loaded).';
  }
  return 'select: no option matching ' + JSON.stringify(String(wanted)) +
    '. Available: ' + shown + more;
}`;
export const optionErrorMessage = new Function(`return (${OPTION_ERROR_JS});`)() as
  (wanted: string, available: string[]) => string;

/**
 * Locator expression as source code (for the generator). role+name targets call the
 * `locate()` helper generator.ts injects once per spec — its LOCATE_HELPER constant mirrors
 * resolveRoleWithFallback() below. Kept in sync manually: the generated spec is a separate,
 * self-contained file (no deps beyond @playwright/test), so the algorithm can't be shared
 * as an import — only as the same logic written twice.
 */
export function resolveCode(t: Target, action?: string): string {
  // `page`, or the iframe chain `Target.frame` names. locate()/field() only call locator/getBy*
  // on their first argument, so a FrameLocator is a drop-in for it (tests/frameTarget.test.ts
  // runs the emitted helpers against a real iframe to keep that true).
  const root = frameRootCode(t);
  // A verified selector beats role+name even when both are present — role+name may be a
  // name discovery derived (e.g. "shopping cart link"), which getByRole cannot match.
  if (t.css) {
    const base = `${root}.locator(${q(t.css)})`;
    return t.nth !== undefined && t.nth !== null ? `${base}.nth(${t.nth})` : `${base}.first()`;
  }
  // A field action routes through the field() helper regardless of which slot carried the
  // hint, so a role+name whose name was inferred from an adjacent <div> still resolves —
  // getByRole cannot match a name the DOM does not actually have.
  if (isFieldAction(action) && fieldHint(t)) {
    return `(await field(${root}, ${q(fieldHint(t))}, ${q(action!)}))`;
  }
  if (t.role && t.name) {
    // If nth is specified, use it to disambiguate duplicate elements
    if (t.nth !== undefined && t.nth !== null) {
      return `(await locate(${root}, ${q(t.role)}, ${q(t.name)}, ${t.nth}))`;
    }
    return `(await locate(${root}, ${q(t.role)}, ${q(t.name)}))`;
  }
  return `${pick(t).code(t, root)}.first()`;
}

/**
 * Try the exact role, the common alternate interactive role with the same name, then a
 * broad text match — first candidate resolving to exactly one element wins. Falls back to
 * the original locator if none are unique, so an unrecoverable failure's error message is
 * unchanged; this only adds chances to succeed, never removes the existing path.
 */
async function resolveRoleWithFallback(page: LocatorRoot, role: string, name: string): Promise<Locator> {
  // exact: true throughout — kept deliberately in step with generator.ts's LOCATE_HELPER,
  // which needs the same thing for the same reason (TECH_DEBT.md TD-32: getByRole's default
  // substring matching picked an unrelated video-player button over the real target). TD-07
  // already flags that these two implementations can drift; this is one of the places they
  // must not.
  const original = page.getByRole(role as any, { name, exact: true });
  const candidates: Locator[] = [original];
  const alt = ROLE_SWAP[role.toLowerCase()];
  if (alt) candidates.push(page.getByRole(alt as any, { name, exact: true }));
  candidates.push(page.getByText(name, { exact: true }));
  for (const c of candidates) {
    if (await c.count() === 1) return c;
  }
  return original.first();
}

/**
 * Live counterpart of the generated spec's field() helper. Tries the ways a field can be
 * named, in decreasing order of how much the DOM actually vouches for them, and takes the
 * first that identifies exactly one element — same "count() === 1" shape
 * resolveRoleWithFallback uses. Falls through to the positional match, so a control with no
 * accessible name at all is still reachable.
 */
/**
 * Where to look: the open modal if there is one, otherwise the whole page.
 *
 * A modal covers the page it opened over, and that page routinely has a field or button with the
 * same name — an "Email" input in a filter bar, a page-level "Save". Resolving a step against the
 * document while a dialog is open can therefore act on something the user cannot even see. Run
 * `2026-09-06T13-05-36-248Z-db2c0b4c` is the New User modal case.
 *
 * Returns a Locator either way, so every caller uses one uniform API (`Locator` has `getByLabel`,
 * `getByRole`, `locator`, `evaluate` — the same surface as `Page` for what is needed here).
 * `.last()` because a stacked dialog puts the newest on top.
 */
export async function resolveScope(page: LocatorRoot): Promise<Locator> {
  const dialogs = page.locator(DIALOG_SELECTOR).filter({ visible: true } as any);
  try {
    if (await dialogs.count() > 0) return dialogs.last();
  } catch { /* selector unsupported on some engines — fall through to the page */ }
  return page.locator("body");
}

/** First candidate resolving to exactly one VISIBLE element, or null. */
async function firstUnique(candidates: Locator[]): Promise<Locator | null> {
  for (const c of candidates) {
    try {
      const vis = c.locator(":visible");
      if (await vis.count() === 1) return vis;
      if (await c.count() === 1 && await c.isVisible().catch(() => false)) return c;
    } catch { /* try the next rung */ }
  }
  return null;
}

export async function resolveField(page: LocatorRoot, hint: string, action?: string): Promise<Locator> {
  const scope = await resolveScope(page);

  // Accessible relationships first, in decreasing order of how much the DOM actually vouches for
  // them, and `exact: true` throughout: a substring match on "Email" also matches "Email address"
  // and "Confirm Email", which is how a two-field form silently binds both steps to one control.
  // For a `select` the list is narrowed rather than reordered — a textbox or checkbox cannot
  // satisfy the action at all, so offering them can only produce a wrong match.
  const semantic: Locator[] = action === "select"
    ? [
      scope.getByRole("combobox", { name: hint, exact: true }),
      scope.getByLabel(hint, { exact: true }),
    ]
    : [
      scope.getByLabel(hint, { exact: true }),
      scope.getByPlaceholder(hint, { exact: true }),
      scope.getByRole("textbox", { name: hint, exact: true }),
      scope.getByRole("combobox", { name: hint, exact: true }),
      scope.getByRole("checkbox", { name: hint, exact: true }),
    ];
  const bySemantics = await firstUnique(semantic);
  if (bySemantics) return bySemantics;

  // DOM order: the control that FOLLOWS the label text. This is the rung that fixes TD-72 —
  // it answers "which control does this label describe" instead of "which control is nearest".
  try {
    // domOrderFieldFn, NOT the string: a string is evaluated as an expression and yields
    // `undefined` rather than running (TD-78). The selector is passed in rather than baked in, so
    // the index and the Locator rebuilt from it below index the SAME list — and so a select step
    // is never handed a plain <input> (TD-70).
    const fieldSel = fieldSelectorFor(action);
    const idx = await scope.evaluate(domOrderFieldFn, { wanted: hint, fieldSel }) as unknown as number;
    if (typeof idx === "number" && idx >= 0) return scope.locator(fieldSel).nth(idx);
  } catch { /* fall through to geometry */ }

  // Geometry, last. Still useful for a layout the DOM order genuinely does not express (a label
  // rendered to the RIGHT of its input, a grid). Prefer a control the label sits above or left of,
  // rather than whichever came first in the document.
  const near = scope.locator(nearFieldSelector(hint, action));
  try {
    const n = await near.count();
    if (n > 1) {
      const anchor = await scope.locator(`:text-is(${JSON.stringify(hint)})`).first()
        .boundingBox().catch(() => null);
      if (anchor) {
        for (let i = 0; i < n; i++) {
          const box = await near.nth(i).boundingBox().catch(() => null);
          if (box && (box.y >= anchor.y || box.x >= anchor.x + anchor.width)) return near.nth(i);
        }
      }
    }
  } catch { /* fall through */ }
  return near.first();
}

/** Live Playwright Locator against a running page (for the replay runner). */
export async function resolveLive(page: Page, t: Target, action?: string): Promise<Locator> {
  // The same root resolveCode emits, built live. Everything below uses only locator/getBy*.
  const root = frameRoot(page, t);
  if (t.css) {
    const base = root.locator(t.css);
    return t.nth !== undefined && t.nth !== null ? base.nth(t.nth) : base.first();
  }
  if (isFieldAction(action) && fieldHint(t)) {
    return resolveField(root, fieldHint(t), action);
  }
  if (t.role && t.name) {
    // If nth is specified, use it to disambiguate duplicate elements. exact: true for the same
    // reason resolveRoleWithFallback uses it — and it matters MORE here, not less: an nth index
    // is only meaningful against the element set it was computed for, so letting substring
    // matches widen that set silently shifts which element nth points at.
    if (t.nth !== undefined && t.nth !== null) {
      const locator = root.getByRole(t.role as any, { name: t.name, exact: true });
      return locator.nth(t.nth);
    }
    return resolveRoleWithFallback(root, t.role, t.name);
  }
  return pick(t).live(root, t).first();
}

/**
 * Select `value` on `target`, live. The executable twin of the generated spec's `choose()`, and
 * deliberately the same shape: walk to the real control, wait for the options only while waiting
 * can still help, match leniently, and fail with what was actually on offer.
 *
 * Kept here rather than in liveExtend.ts so it sits beside the matching logic it shares with the
 * generator — the two implementations having drifted apart is TD-07, and the point of the shared
 * `*_JS` constants above is that the matching itself cannot.
 */
export async function chooseLive(page: Page, target: Locator, value: string, root: LocatorRoot = page): Promise<void> {
  // Walk to something selectable when the resolved node is a wrapper, a label, or a custom shell.
  try {
    const tag0 = (await target.evaluate((el) => el.tagName).catch(() => "")) || "";
    const role0 = (await target.getAttribute("role").catch(() => "")) || "";
    if (tag0.toUpperCase() !== "SELECT" && role0 !== "combobox" && role0 !== "listbox") {
      const si = await target.evaluate(selectableFn, FIELD_SELECTOR).catch(() => -1) as number;
      // `root`, not `page`: the index is into the target's OWN document, which for a target in an
      // iframe is the frame's (frameRoot). Defaults to `page`, so every existing caller is unchanged.
      if (typeof si === "number" && si >= 0) target = root.locator(FIELD_SELECTOR).nth(si);
    }
  } catch { /* stay with what we were given */ }

  const tag = ((await target.evaluate((el) => el.tagName).catch(() => "")) || "").toUpperCase();

  if (tag === "SELECT") {
    const deadline = Date.now() + SELECT_TIMEOUT_MS;
    let idx = -1;
    for (;;) {
      const probe = await target.evaluate(optionProbeFn, value).catch(() => null);
      if (probe && probe.index >= 0) { idx = probe.index; break; }
      // Populated and still no match: the list is real and the value is not in it. Waiting the
      // rest of the timeout would only delay the same failure — and would hide a wrong-control
      // resolution behind what looks like a slow network.
      if (probe && probe.populated) break;
      if (Date.now() >= deadline) break;
      await page.waitForTimeout(100);
    }
    if (idx >= 0) {
      await target.selectOption({ index: idx }, { timeout: SELECT_TIMEOUT_MS });
      return;
    }
    const available = await target.evaluate((el) => Array.prototype.slice
      .call((el as HTMLSelectElement).options || [])
      .map((o: HTMLOptionElement) => (o.textContent || "").trim())
      .filter((t: string) => t.length > 0)).catch(() => [] as string[]);
    throw new Error(optionErrorMessage(value, available as string[]));
  }

  // Custom dropdown: open it, wait for items, then match the same way.
  await target.click({ timeout: SELECT_TIMEOUT_MS });
  const outer = await resolveScope(root);
  // Wait on the OPEN popup, not the whole scope. `:visible` matters twice over: several
  // [role="listbox"] nodes on one form means `.first()` is a CLOSED one, and a native <select>
  // anywhere on the page contributes <option> elements whose implicit role is "option" — so an
  // unscoped count is non-zero before this dropdown has rendered anything and the wait exits
  // immediately. Both found by running it, not by reading it.
  const optDeadline = Date.now() + SELECT_TIMEOUT_MS;
  let where = outer;
  for (;;) {
    const popup = outer.locator('[role="listbox"]:visible, [role="menu"]:visible');
    const open = (await popup.count()) > 0 ? popup.first() : null;
    where = open ?? outer;
    // role="option" is only one way a dropdown announces its choices; plenty render plain
    // <div>/<li> items, which the text fallback below handles. Any rendered text in the open
    // popup counts as ready, or a dropdown that was ready at once burns the whole timeout.
    if (await where.getByRole("option").count() > 0) break;
    if (open && ((await open.textContent().catch(() => "")) || "").trim().length > 0) break;
    if (Date.now() >= optDeadline) break;
    await page.waitForTimeout(100);
  }
  const opts = where.getByRole("option");
  const n = await opts.count();
  if (n > 0) {
    const texts: string[] = [];
    for (let i = 0; i < n; i++) {
      texts.push(((await opts.nth(i).textContent().catch(() => "")) || "").replace(/\s+/g, " ").trim());
    }
    const pick = matchOptionIndexFn(texts, value);
    if (pick >= 0) { await opts.nth(pick).click({ timeout: SELECT_TIMEOUT_MS }); return; }
    throw new Error(optionErrorMessage(value, texts));
  }

  const exact = where.getByText(value, { exact: true });
  if (await exact.count() > 0) { await exact.first().click({ timeout: SELECT_TIMEOUT_MS }); return; }
  const offered = (await where.locator('[role="option"], li, [role="menuitem"]')
    .allTextContents().catch(() => [] as string[]))
    .map((t) => (t || "").replace(/\s+/g, " ").trim()).filter((t) => t.length > 0);
  throw new Error(optionErrorMessage(value, offered));
}
