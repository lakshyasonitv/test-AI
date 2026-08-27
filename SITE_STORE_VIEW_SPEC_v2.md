# Site Store / Prompt View — Implementation Spec v2

**Status:** design spec, ready to implement. Supersedes `deep-research-report.md` and
`SITE_STORE_VIEW_SPEC.md` (v1). Appendix A lists v1's corrections to the research report;
Appendix B lists what changed in v2 and, importantly, **which review suggestions were rejected and
why** — so they are not re-litigated mid-implementation.

**Problem.** The merged `AppModel` handed to Gemini is large, page-unscoped, and full of fields the
model cannot use. Two consequences: prompts are token-heavy, and duplicate `(role, name)` pairs
across merged pages make grounding ambiguous (`TECH_DEBT.md` TD-05).

**Design.** Split one artifact into two, and add a deterministic retrieval layer between them:

```
AppModel  →  SiteStore  →  [retrieval]  →  View  →  LLM
             (truth)       (which part?)   (compact)
```

- **Store** — complete, on disk, never in a prompt. Every element with every field. What
  `groundingError()` and `targetResolver.ts` query.
- **Retrieval** — pure code that decides *which* pages, elements and edges a given prompt or test
  case actually needs.
- **View** — a token-budgeted text projection of that subset. The only thing an LLM sees.

The LLM addresses elements by **id**, never by authoring a name or a selector. Grounding becomes a
dictionary lookup instead of fuzzy matching.

---

## Ground rules

Non-negotiable. Violating any of them makes this change a net loss.

1. **`src/schema/ir.ts` is not replaced.** The existing IR — 8 actions, 9 assertion types,
   `preAction`, page-level assertions that take no target, `truncated` / `hasTerminalAssertion` —
   stays as it is. This spec adds **one optional field** to `Target` (`elementId?`). Nothing is
   removed.
2. **`targetResolver.ts` remains the only place a Playwright locator is constructed.** The
   resolver here produces an IR `Target`; `targetResolver.ts` turns that into a locator as it does
   today. Do not write a second locator strategy — that is `TECH_DEBT.md` TD-07 repeating.
3. **The test-case stage's prose output is not replaced with structured JSON.** See §Phase 2.5 and
   Appendix B.1 for why.
4. **No LLM inside any function in this spec.** Every pass and every retrieval step is pure code.
5. **Structure over text.** Classification rules read a role, tag, DOM relationship, or schema
   field — never a hand-written regex over an accessible name, page text, or LLM prose
   (`CLAUDE.md` central rule; TD-01). Matching prose against a **dictionary built from the Store**
   is permitted and is not the same thing — see §Phase 2.5.
6. **Zod is the contract.** New shapes go in `src/schema/`.
7. **Phase 0 gates everything.** Do not start Phase 1 until Phase 0's numbers come back.
8. **No new "what's broken" doc.** Findings go in `TECH_DEBT.md`.

---

## Phase 0 — Offline measurement spike (DO THIS FIRST)

**Effort: 1–2 days. Touches no shipped file. Zero cost — no browser, no LLM.**

The value of this whole project rests on one unmeasured number.

### What to build

`scripts/measureView.ts`, standalone:

1. Read a saved `runs/<id>/02-appmodel.json`.
2. Build a first-cut View with the Phase 2 passes, written against the AppModel shape directly.
3. Read the matching `runs/<id>/04-ir.json` and, where present, the run's test cases.
4. Print per run:

| Metric | How to compute |
|---|---|
| `tokensAppModel` | tokenizer over the AppModel **exactly as it is serialized into the IR prompt today** |
| `tokensGenericView` | tokenizer over a whole-site View (no test-case filtering) |
| `tokensTestView` | tokenizer over a View retrieved for the run's actual primary test case |
| `irCoverage` | fraction of elements referenced by grounded steps in `04-ir.json` still present in each View |
| `missingRefs` | the specific dropped elements, printed in full |

Three measurements, not two. The hypothesis has two independent halves — *projection* saves tokens,
and *retrieval* saves more — and you need to know which one is actually paying. If
`tokensGenericView` already hits target, Phase 2.5 is optional. If it doesn't and `tokensTestView`
does, Phase 2.5 is the whole product.

Use a real tokenizer (`gpt-tokenizer` / `tiktoken`). **Never estimate by splitting on whitespace** —
it undercounts this content 2–3× because ids, quotes and punctuation tokenize separately.

Run over **every** saved run in `runs/`, not one.

### Acceptance gate

| Result | Action |
|---|---|
| reduction ≥ 60% **and** `irCoverage` = 100% on every run | proceed to Phase 1 |
| coverage < 100% | ranking (Pass 3) or retrieval is wrong. Fix, re-measure. Do not proceed. |
| reduction < 40% on both View kinds | the AppModel was not the token problem. **Stop and report.** |

Record the numbers in `TECH_DEBT.md` either way. A negative result is a successful Phase 0.

---

## Phase 1 — Store schema and identity

### 1.1 Identity: two concerns, kept separate

v1 claimed the fingerprint id "survives across runs." That was overclaimed, and the review was
right to flag it: a fingerprint containing `name` and `ordinalInContainer` changes when a button is
renamed or two siblings swap order.

The fix is **not** to go back to counters (see Appendix B.2). It is to separate two different jobs
that v1 conflated:

| Concern | Field | Property |
|---|---|---|
| **Identity** — addressing an element inside one Store | `id` | content-addressed, collision-free, deterministic |
| **Re-identification** — recognising the same element in a later crawl | `matchKeys[]` | tiered, best-effort, tells you *how confidently* it matched |

Both are derived. Neither is a counter.

```ts
// src/store/elementId.ts
import { createHash } from "node:crypto";

const h6 = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 6);
const J  = (...parts: (string | number)[]) => parts.join("\u0000");

/** Identity within one Store. Must be unique — every distinguishing field is included. */
export function elementId(el: ExtractedElement, pageId: string): string {
  return `${pageId}-${h6(J(
    el.routePattern, el.role, el.name, el.tag,
    el.containerPath, el.ordinalInContainer,
  ))}`;
}

/**
 * Ordered candidate keys for matching this element in a LATER crawl, most stable first.
 * A later crawl matches on the first tier that yields exactly one candidate,
 * and records which tier fired.
 */
export function matchKeys(el: ExtractedElement): { tier: MatchTier; key: string }[] {
  const keys: { tier: MatchTier; key: string }[] = [];
  if (el.testId) keys.push({ tier: "testid",     key: h6(J(el.routePattern, el.testId)) });
  if (el.name)   keys.push({ tier: "role-name",  key: h6(J(el.routePattern, el.role, el.name)) });
  keys.push({ tier: "structural", key: h6(J(el.routePattern, el.role, el.tag,
                                            el.containerPath, el.ordinalInContainer)) });
  return keys;
}

export type MatchTier = "testid" | "role-name" | "structural";
```

Ids look like `p2-a3f19c`. Page-scoped by construction — the structural half of the TD-05 fix.

**Say this plainly in code comments and in the UI:** an id is stable for a *given crawl of a given
page structure*. A rename produces a new id and a `role-name` match miss; the `structural` tier
usually still catches it, and the healing diff reports "element `p2-a3f19c` matched
`p2-77bd02` at tier `structural` — name changed from X to Y." That is more useful than a false
promise of permanence.

**`pageId` is also derived, not ordinal:** `"p" + h6(routePattern).slice(0,4)`. Keep
`StoredPage.ordinal` for human-friendly `p1`/`p2` labels in the View — **display only, never an
identity**.

### 1.2 Route pattern normalization

`src/store/routePattern.ts`: lowercase; strip trailing slash; strip query and fragment unless the
app is hash-routed; replace numeric, uuid-shaped, and 24-hex segments with `:id`. Collapse slug
segments to `:slug` when two sibling URLs differ only in that segment — otherwise every product page
is its own pattern and the instance caps never engage.

**Origin comparison uses host and port only, never scheme.** A start URL of `https://x.com/` and an
href of `http://x.com/page` are the same origin. Getting this wrong classifies a site's own pages as
external and silently produces an empty crawl — observed on a real bookstore fixture where 263 of
357 edges were mislabelled external for exactly this reason.

### 1.3 Store schema

`src/schema/siteStore.ts` (Zod):

```ts
export const StoredElement = z.object({
  id: z.string(),
  pageId: z.string(),
  role: z.string(),
  name: z.string(),
  tag: z.string(),
  text: z.string().optional(),          // captured visible text — see Phase 4 (assertions)
  css: z.string().optional(),           // from discovery, never LLM-authored
  testId: z.string().optional(),

  // structural — captured at discovery time, required by Pass 2 and by context expansion
  parentId: z.string().nullable(),
  containerPath: z.string(),            // ancestor TAG chain from <body>
  childRoleSignature: z.string(),       // descendant roles in order, e.g. "img,heading,text,button"
  ordinalInContainer: z.number(),

  visible: z.boolean().optional(),
  enabled: z.boolean().optional(),
  discoveryMethod: z.enum(["dom", "vision", "hybrid"]),
  concept: z.string().optional(),       // existing AppModel field, carried through
  matchKeys: z.array(z.object({ tier: z.enum(["testid","role-name","structural"]),
                                key: z.string() })),
});

export const StoredPage = z.object({
  id: z.string(),
  url: z.string(),                      // a real visited URL for this pattern
  routePattern: z.string(),
  title: z.string().optional(),
  ordinal: z.number(),                  // display only
  elementIds: z.array(z.string()),
  forms: z.array(DomForm).optional(),   // reuse the EXISTING DomForm from appModel.ts
});

export const SiteEdge = z.object({
  id: z.string(),
  fromPageId: z.string(),
  toPageId: z.string().nullable(),      // null = known trigger, destination not crawled
  viaElementId: z.string(),
  evidence: z.enum(["clicked", "href"]),// "clicked" = actually followed
});

export const SiteStore = z.object({
  startUrl: z.string(),
  pages: z.record(StoredPage),
  elements: z.record(StoredElement),
  edges: z.array(SiteEdge),
  auth: AuthOutcome.optional(),         // reuse the EXISTING AuthOutcome from appModel.ts
  truncated: z.boolean(),
  stoppedBy: z.string().nullable(),
});
```

**There is no separate `SiteGraph` type.** `pages` + `edges` *is* the graph; graph queries are
functions over the Store (`src/store/graphQuery.ts`). Duplicating page data into graph nodes is how
two representations drift apart.

**Carry `auth` through unchanged.** `AuthOutcome.loginSteps` is what `buildLoginPrefix()` replays;
it was captured live and must never be re-derived from `elements` (`DECISIONS.md` D-22–D-26).

### 1.4 Store is derived; AppModel stays

Do not rewrite discovery in this phase.

```ts
// src/store/fromAppModel.ts
export function buildStore(model: AppModel): SiteStore
```

Discovery keeps producing `AppModel`; the Store is built from it. Any bug is then isolated to one
pure function that replays against saved artifacts for free.

`parentId`, `containerPath`, `childRoleSignature`, `ordinalInContainer` are **not** in the current
AppModel. Add them to `src/schema/appModel.ts` and populate them in `domExtract.ts` — cheerio
already walks the tree, so this is ancestor bookkeeping, not an extra traversal. Until they exist,
`buildStore` falls back to `containerRole`/`order` and Pass 2 degrades to a **no-op rather than
mis-grouping**.

### 1.5 Secrets

The Store is written under `runs/<id>/`, which is served publicly (TD-14). Route whatever writes it
through `scrubServedSecrets` in `executor.ts` and extend that function's coverage to the Store path.
`StoredElement.text` in particular can capture a value a user typed.

---

## Phase 2 — View builder

`src/store/buildView.ts`. Pure. Low-level entry point:

```ts
export interface ViewSpec {
  purpose: "testcases" | "ir" | "heal";
  budget: TokenBudget;
  pageIds: string[];                 // exactly which pages to render
  requiredElementIds: string[];      // never pruned
  reachPaths?: ReachPath[];          // rendered as [reach: …] annotations
}

export interface TokenBudget {
  total: number;                     // default 2500, env VIEW_TOKEN_BUDGET
  requiredReserve: number;           // default 40% — required ids draw from here first
  navigationReserve: number;         // default 10% — shared chrome + reach lines
}

export function buildView(store: SiteStore, spec: ViewSpec): ViewResult
```

Splitting the budget matters: without a reserve, one large required element can consume the whole
allowance and leave no room for the context that makes it usable. If required ids overflow
`requiredReserve`, they still render (they are required) but the overflow is reported in
`ViewResult.warnings` so it shows up in tests rather than silently squeezing everything else.

### Pass 1 — Hoist site chrome

Count **distinct pages**, not element occurrences. (v0's bug: 20 "Add to Cart" buttons on one page
counted as 20 and got filed as global navigation.)

```ts
function hoistShared(store: SiteStore, pageIds: string[], minPages = 3) {
  if (pageIds.length < minPages) return { shared: [], perPage: groupByPage(store, pageIds) };

  const pagesByKey = new Map<string, Set<string>>();
  for (const id of allElementIds(store, pageIds)) {
    const el = store.elements[id];
    const key = `${el.role}\u0000${el.name}`;
    (pagesByKey.get(key) ?? pagesByKey.set(key, new Set()).get(key)!).add(el.pageId);
  }

  const sharedKeys = new Set([...pagesByKey]
    .filter(([, pages]) => pages.size >= minPages)
    .map(([k]) => k));
  // ... partition into shared / perPage on sharedKeys
}
```

**A shared entry is a key, not an element id.** v1 emitted one representative id and told the
resolver to map it back — which lies about identity in the artifact itself. Instead:

```text
shared:
  link "Cart" @cart | link "Home" @home | link "Sign in" @signin
```

`@cart` is a **shared key**, not an element. `resolveSharedKey(key, currentPageId, store)` returns
the real element id on the page the step is actually on. If the current page has no member of that
key, that is a genuine grounding error and must be reported, not silently resolved to another
page's element.

### Pass 2 — Collapse repeated structures into groups

Group by **structure**, not name. (v0's bug: grouping by `(containerRole, role, name)` never fires
on list items, because their names differ — "Smartphone X", "Laptop Y" — which is the only case the
pass exists for.)

```ts
export interface RepeatedGroup {
  groupId: string;                   // "g1", stable within a View
  representativeId: string;
  count: number;
  containerTag: string;
  members: { elementId: string; discriminator?: string }[];
}

function collapseRepeats(ids: string[], store: SiteStore): {
  groups: RepeatedGroup[]; absorbed: Set<string>;
} {
  const buckets = new Map<string, string[]>();
  for (const id of ids) {
    const el = store.elements[id];
    if (!el.parentId) continue;                        // structural fields unavailable → skip
    const key = [el.parentId, el.tag, el.role, el.childRoleSignature].join("\u0000");
    (buckets.get(key) ?? buckets.set(key, []).get(key)!).push(id);
  }
  // groups of >= 3 only; 2 is not a pattern
}
```

**The discriminator is what makes a group usable.** For each member, compute a discriminator from
the member's own subtree: the text of its first heading/link descendant, or its own `text`. Render:

```text
p2  /catalogue/category/:slug        "Books"
  group @g1  product_pod ×20
    [0] "A Light in the Attic"   button "Add to basket" #p2-55cd08
    [1] "Tipping the Velvet"     button "Add to basket" #p2-91ae44
    [2] "Soumission"             button "Add to basket" #p2-3c7f10
    …17 more members
```

The model then selects `@g1` + a discriminator, or a specific member id — never an invented `nth`.
Downstream this becomes a container-scoped locator:

```ts
page.locator('.product_pod').filter({ hasText: 'Soumission' }).getByRole('button', { name: 'Add to basket' })
```

`filter({ hasText })` is a real Playwright option. `filter({ visible })` is not — that shipped once
as a silent no-op (`DECISIONS.md` D-19). **Run any new generated-locator shape once for real
against synthetic HTML before calling it done.**

How many members to render is a budget decision: render `min(3, count)` by default, more if
`requiredElementIds` names specific members.

### Pass 3 — Rank

Structural signals only. (v0's bug: `/^(add|submit|checkout)/i` over the accessible name — a regex
over page text, the exact failure mode `CLAUDE.md` names.)

```ts
function priority(el: StoredElement, store: SiteStore): number {
  if (["textbox","combobox","checkbox","radio"].includes(el.role))              return 1;
  if (el.tag === "button" && isInsideForm(el, store))                           return 2;
  if (store.edges.some(e => e.viaElementId === el.id && e.evidence === "clicked")) return 3;
  if (el.role === "button")                                                     return 4;
  if (el.role === "link")                                                       return 5;
  return 6;
}
```

`isInsideForm` walks `parentId` upward against `StoredPage.forms` — a DOM fact. "Has a followed
edge" — a graph fact. Neither reads page wording. Stable tiebreak on `ordinalInContainer` so the
same input always yields byte-identical output.

### Pass 4 — Budget

Real tokenizer; `continue`, not `break`. (v0's bug: `break` ended the loop on the first oversized
line even with budget to spare.)

```ts
import { encode } from "gpt-tokenizer";
const countTokens = (s: string) => encode(s).length;

function applyBudget(ranked: string[], store: SiteStore, budget: TokenBudget,
                     required: Set<string>) {
  let used = 0, skipped = 0;
  const included: string[] = [];
  const warnings: string[] = [];

  for (const id of ranked.filter(i => required.has(i))) {   // reserved first, never pruned
    used += countTokens(renderLine(store.elements[id]));
    included.push(id);
  }
  if (used > budget.requiredReserve) {
    warnings.push(`required ids used ${used} tokens, reserve was ${budget.requiredReserve}`);
  }

  for (const id of ranked) {
    if (required.has(id)) continue;
    const t = countTokens(renderLine(store.elements[id]));
    if (used + t > budget.total) { skipped++; continue; }   // NOT break
    used += t; included.push(id);
  }
  return { included, skipped, warnings };
}
```

Emit the residue per page — `+34 more links` — so the model knows the View is partial and does not
conclude an element does not exist. Assert the cap in a unit test; without it the View silently
grows back.

### Pass 5 — Serialize

Indented text. No braces, no repeated keys, no quotes except around names.

```text
shared:
  link "Home" @home | link "Cart" @cart | link "Sign in" @signin

session: authenticated as ${env:TEST_USER}   — login steps are prepended in code; do not write them

p1  /                                "Bookstore"
  form @f1 (search)
    textbox "Search" #p1-4c2a11  required
    button "Go" #p1-9e7b02
  link "Books" #p1-77af31 -> p2
  +31 more links

p2  /catalogue/category/:slug        "Books"   [reach: p1 -> click #p1-77af31]
  group @g1  product_pod ×20
    [0] "A Light in the Attic"   button "Add to basket" #p2-55cd08
    [1] "Tipping the Velvet"     button "Add to basket" #p2-91ae44
    …18 more members
  +12 more links

not crawled: 69 pages queued, stopped by max_pages
```

Three lines earn their place beyond the element list:

- `[reach: …]` — the payoff for having a graph. The model can be told to reach a page
  deterministically instead of guessing a URL.
- `session:` — on an authenticated run, tells the model not to write login steps, since
  `buildLoginPrefix()` prepends them in code.
- `not crawled:` — prevents a truncated crawl from reading as a complete site.

**Never in the View:** `css`, `testId`, `containerPath`, `childRoleSignature`, `ordinalInContainer`,
`matchKeys`, `visible`, `enabled`, `discoveryMethod`. Resolver business, most of the bytes, and
handing the model a `css` string invites it to author one.

---

## Phase 2.5 — Retrieval: deciding what goes in the View

This is the layer v1 was missing. `ViewSpec.pageIds` and `requiredElementIds` were parameters with
no specified producer.

**The two purposes have different inputs, and conflating them is a mistake.**

| Purpose | When | Driven by | Breadth |
|---|---|---|---|
| `testcases` | before any test case exists | the **user prompt** + site structure | broad: every page, shallow per page |
| `ir` | after a case is selected | the **selected test case** | narrow: only pages/elements that case needs, deep |

A test-case View cannot be retrieved from a test case — the case does not exist yet. What it needs
is *coverage*: enough of the site that the model proposes cases about things that exist. What an IR
View needs is *precision*.

### 2.5.1 The safety invariant

**Requirement extraction is a hint, never an authority. A miss produces a larger View — never a
wrong element.** Every retrieval function below falls back to "include more" on failure. Nothing in
this phase can cause a mis-grounding, because grounding still happens in Phase 3 against the Store.

State this in the code. It is what makes matching against LLM prose acceptable here when it is
forbidden elsewhere.

### 2.5.2 Requirement extraction (no LLM, no change to `testCases.ts`)

Do **not** change the test-case stage to emit structured JSON steps (Appendix B.1). Instead, extract
requirements from the prose case by matching it against a **dictionary built from the Store**:

```ts
// src/store/testCaseRequirements.ts
export interface TestCaseRequirements {
  pageIds: string[];              // pages the case names, by title / path / route pattern
  elementIds: string[];           // elements whose (role,name) appears verbatim in the case
  groupIds: string[];             // repeated groups a named member belongs to
  unmatchedTerms: string[];       // quoted strings the case names that the Store does NOT have
  confidence: "matched" | "partial" | "none";
}

export function extractRequirements(store: SiteStore, testCase: TestCase): TestCaseRequirements
```

Mechanics: build `Map<normalizedName, elementId[]>` and `Map<normalizedTitle|path, pageId>` from the
Store, then look for those **Store-supplied terms** inside the case text. This is dictionary lookup,
not pattern guessing — the terms come from discovered reality, not from a hand-written regex, which
is why it does not fall foul of ground rule 5.

`unmatchedTerms` is valuable on its own: a quoted string in a test case that no discovered element
matches is an early signal the model invented something. Log it; do not fail on it.

Fallbacks, in order:
- `confidence: "none"` → `pageIds` = all pages, budget unchanged. A generic View.
- `confidence: "partial"` → matched pages plus their direct neighbours.

### 2.5.3 Subgraph retrieval

```ts
// src/store/graphQuery.ts
export function retrieveSubgraph(store: SiteStore, req: TestCaseRequirements): {
  pageIds: string[]; reachPaths: ReachPath[]; unreachable: string[];
}
```

1. Seed with `req.pageIds` (plus the entry page, always).
2. For each consecutive pair of seed pages, compute the shortest path over `edges` and include the
   intermediate pages. A case that goes Products → Checkout needs Cart in the View even though the
   case never names it.
3. **Guard the review missed:** if no path exists — a truncated crawl, or JS-only navigation with no
   recorded edge — do **not** silently drop the page. Include it anyway, add it to `unreachable`,
   and render it without a `[reach: …]` line. A missing path is a fact about the crawl, not a reason
   to hide a page the case needs.
4. Expand context around each `req.elementIds` member: its parent, and its siblings within its
   repeated group. This is what turns a bare button id into a legible product card.

### 2.5.4 The two public entry points

```ts
export function buildPromptView(store: SiteStore, userPrompt: string, opts?): ViewResult
// purpose "testcases": every page, top-N elements per page, groups collapsed hard.
// Prompt terms matched against the Store dictionary only to RAISE priority, never to exclude a page.

export function buildIrView(store: SiteStore, testCase: TestCase, opts?): ViewResult
// purpose "ir": requirements → subgraph → context expansion → ViewSpec → buildView.
```

`buildIrView` internally:

```ts
const req      = extractRequirements(store, testCase);
const subgraph = retrieveSubgraph(store, req);
const spec: ViewSpec = {
  purpose: "ir",
  budget: opts?.budget ?? DEFAULT_BUDGET,
  pageIds: subgraph.pageIds,
  requiredElementIds: [...req.elementIds, ...loginRelevantIds(store)],
  reachPaths: subgraph.reachPaths,
};
return buildView(store, spec);
```

Both are thin. All the logic lives in the four named functions, each independently testable.

### 2.5.5 Later, not now

Per-test-type retrieval policies — smoke tests want breadth from the entry node, navigation tests
want all clickable edges, healing wants the failed node's neighbourhood plus alternates — are a
natural extension once `retrieveSubgraph` exists. **Do not build them in this phase.** One retrieval
policy that measurably works beats five that are untested.

---

## Phase 3 — Resolver

Produces an IR `Target` in the **existing** schema and stops. `targetResolver.ts` stays the only
locator builder.

```ts
// src/store/resolveElementId.ts
export function resolveElementId(id: string, store: SiteStore): Target {
  const el = store.elements[id];
  if (!el) throw new GroundingError(`unknown element id: ${id}`);

  if (el.name) {
    const sameNameOnPage = store.pages[el.pageId].elementIds
      .filter(i => store.elements[i].role === el.role && store.elements[i].name === el.name);
    return sameNameOnPage.length > 1
      ? { role: el.role, name: el.name, nth: sameNameOnPage.indexOf(id), elementId: id }
      : { role: el.role, name: el.name, elementId: id };
  }
  if (el.testId) return { testId: el.testId, elementId: id };
  if (el.css)    return { css: el.css, elementId: id };
  throw new GroundingError(`element ${id} has no addressable handle`);
}

export function resolveSharedKey(key: string, currentPageId: string, store: SiteStore): Target
export function resolveGroupMember(groupId: string, discriminator: string,
                                   currentPageId: string, store: SiteStore): Target
export function resolvePageRef(pageId: string, store: SiteStore): Target  // → { url: page.url }
```

`nth` is now computed from the Store rather than guessed — the within-page half of TD-05.

**`resolvePageRef` is why navigation stops being invented.** A URL comes from a page record or an
edge, never from an element's accessible name. (v0's bug: `{ type: 'goto', url: el.name }` navigates
to the string "Cart".)

### Schema change to `ir.ts` — additive only

```ts
Target: {
  url?, role?, name?, nth?, label?, text?, placeholder?, testId?, css?,
  elementId?: string,   // NEW — provenance. Written in code, never by the LLM.
}
```

Nothing else changes. An IR produced without a Store still runs, because the fields
`targetResolver.ts` reads are untouched.

---

## Phase 4 — Assertion text

The largest single failure bucket: the model expects "Message sent successfully" and the page says
"Thanks for contacting us!". **A View reduces prompt size; it does not tell the model what words are
on the page.** Handle it explicitly.

1. **Put real text in the View for assertion candidates.** Headings, status regions, alerts, and any
   element with non-empty `text`: emit it verbatim — `heading "Order complete" #p3-2ba901`. The
   model quotes something that exists instead of inventing something plausible.
2. **Ground text assertions against the Store.** For `text_equals` / `text_contains` with a
   `targetId`, compare `step.value` against `store.elements[targetId].text`. On mismatch, prefer the
   Store's text and record the correction in the run artifacts.
3. **Keep the existing live replay as final authority.** The Store is a crawl-time snapshot; the
   page at execution time wins. This reduces how often the replay has to correct — it does not
   replace it.

**Measure it.** Count how many text assertions the live replay currently corrects across saved runs,
and re-count after. If the number does not drop, this phase did not work.

---

## Phase 5 — Failure modes

| Failure | Detection | Response |
|---|---|---|
| Model returns an unknown id | `resolveElementId` throws | Feed back as a grounding correction, as `groundingError()` already does. **Never fall back to fuzzy name matching** — that reintroduces the ambiguity this design removes. |
| Model returns an id from the wrong page | compare `el.pageId` to the step's tracked page | Reject with a correction naming the right page. |
| Model cites `@g1` with no discriminator | group `count > 1`, no discriminator | Reject and ask for one. Never silently `.first()`. |
| Shared key unresolvable on the current page | `resolveSharedKey` finds no member | Genuine grounding error — report it. Do not borrow another page's element. |
| Required element pruned | Phase 0 coverage test | Add to `requiredElementIds`; if recurring, fix ranking. |
| Requirement extraction misses everything | `confidence: "none"` | Falls back to a generic View. Logged, not fatal — this is the safety invariant working. |
| Required page unreachable in the graph | `subgraph.unreachable` non-empty | Render the page without a reach line and surface the fact. Never drop it. |
| Store stale vs live page | element not found at execution | Existing self-heal. Because ids are content-addressed and `matchKeys` are tiered, a re-crawl can diff old vs new Store and report exactly what moved and at which tier. |
| Crawl truncated | `store.truncated` | Already in the View's `not crawled:` line. |

---

## Phase 6 — Testing

Per `CLAUDE.md`: artifact replay over live runs. Everything below is free.

**Unit tests, one per pass:**

- `elementId` — same input → same id; changed `name` → different id; **shuffled crawl order → same
  id** (regression test for the counter bug).
- `matchKeys` — a renamed element still matches at tier `structural`; a `testId` element matches at
  tier `testid` after both a rename and a reorder.
- `hoistShared` — 20 identically-named buttons on **one** page are **not** hoisted (v0 regression);
  a nav link on 3 pages **is**; a 2-page crawl skips the pass entirely.
- `collapseRepeats` — 20 cards with **different** names collapse into one group with `count: 20`
  (v0 regression); 2 similar elements do not collapse; every member gets a discriminator.
- `priority` — a button named "Add to cart" **outside** a form ranks below a form input, proving
  ranking is not name-driven.
- `applyBudget` — a long line does not terminate the loop; required ids survive `total: 0`; overflow
  of `requiredReserve` produces a warning.
- `buildView` — byte-identical output for the same `(store, spec)`, twice.
- `buildView` — `countTokens(output) <= budget.total` for every saved run.
- `extractRequirements` — a case naming a real button yields its id; a case naming nothing yields
  `confidence: "none"` and a full-site View, **not** an empty one.
- `retrieveSubgraph` — Products→Checkout pulls in Cart; a disconnected page lands in `unreachable`
  and is still rendered.
- `resolveElementId` — two same-named elements on a page produce distinct `nth`.
- `resolveSharedKey` — resolves to the current page's element, not the representative's page.

**Replay tests over `runs/`:**

- Coverage: for every saved `04-ir.json`, every grounded target appears in `buildIrView()` of the
  matching store. **This test must never go red.**
- Token reduction, per run, all three measurements, checked into `TECH_DEBT.md` as a baseline.

**One live check at the end — say so first, it costs money:** a single authenticated end-to-end run
confirming the login prefix still replays and the spec still passes. Before judging it, verify the
server process started **after** the edit — `npm run serve` has no watch (TD-02). If the change
touches emitted Playwright API surface (the `filter({ hasText })` locator in Pass 2 does), run it
once against synthetic HTML first (D-19).

---

## Roadmap

| Phase | Effort | Gate before continuing |
|---|---|---|
| 0. Offline measurement spike (3 metrics) | 1–2 d | ≥60% reduction **and** 100% IR coverage on every saved run |
| 1. Store schema, identity, structural fields in `domExtract.ts` | 3 d | `buildStore()` round-trips every saved AppModel; ids identical across two builds with shuffled input |
| 2. View builder (5 passes) | 3 d | all Pass unit tests green; token cap test green |
| 2.5. Retrieval (`extractRequirements`, `retrieveSubgraph`, two entry points) | 3 d | `tokensTestView` < `tokensGenericView` on saved runs with coverage still 100% |
| 3. Resolver + `elementId?` on `Target` | 2 d | `npx tsc --noEmit` clean; IRs without a Store still run |
| 4. Assertion text grounding | 2 d | live text-assertion corrections drop measurably vs baseline |
| 5. Wire into the IR prompt | 2 d | one authenticated end-to-end run passes |
| 6. Failure modes + healing diff | 2 d | every row of the Phase 5 table has a test |

**Total: 18–19 days**, kill gate at day 2.

---

## Appendix A — Corrections carried forward from `deep-research-report.md`

Do not reintroduce any of these.

1. **Counter-based ids** (`p{n}-e{n}`, counter never reset per page) → content-addressed id. The
   draft's ids changed on every crawl-order change, and its `elemCounter` was global, so page 2's
   first element was `p2-e54`.
2. **`hoistShared` counted element instances** → counts distinct pages.
3. **`collapseRepeats` grouped by `(containerRole, role, name)`** → groups by
   `(parentId, tag, role, childRoleSignature)`. Name-keyed grouping never fires on list items with
   differing text, the only case it exists for.
4. **Ranking used `/^(add|submit|checkout)/i` over the accessible name** → structural signals.
5. **Token counting via `split(/\s+/)`** → real tokenizer. The draft undercounted 2–3×.
6. **`applyBudget` used `break`** → `continue`.
7. **`resolveAction` returned `{type:'goto', url: el.name}`** → `resolvePageRef`.
8. **`resolveAction` returned raw `cssPath`** → returns an IR `Target`; `targetResolver.ts` stays
   the sole locator builder (TD-07).
9. **A new 4-action `IRStep` replacing `src/schema/ir.ts`** → `ir.ts` untouched apart from one
   optional field. The draft silently dropped `press`/`select`/`check`/`wait`, `preAction`,
   page-level assertions, and `truncated`/`hasTerminalAssertion`.
10. **Assertion text left as model-authored `step.value`** → Phase 4.
11. **No auth anywhere** → `AuthOutcome`/`loginSteps` carried through unchanged.
12. **No secret handling** → Store goes through `scrubServedSecrets`.
13. **Origin compared by scheme** → host and port only.
14. **Fabricated benchmark table** → Phase 0 measures it.
15. **`traverseFrom` off-by-one** — final frontier queued but never marked visited, returning pages
    to `depth - 1`.
16. **Decisive measurement at day 8** → Phase 0, day 1.

---

## Appendix B — v2 changes, and rejected suggestions

### Adopted from review

| # | Change | Where |
|---|---|---|
| B.a | Test-case-specific retrieval was missing — the largest real gap in v1 | Phase 2.5 |
| B.b | Shared entries emit a **key**, not a representative element id | Pass 1 |
| B.c | Repeated groups become an explicit `RepeatedGroup` with members + discriminators | Pass 2 |
| B.d | Token budget split into reserves | `TokenBudget` |
| B.e | Measure three token figures, not two | Phase 0 |
| B.f | No separate `SiteGraph` type — the graph is queries over Store relations | §1.3 |
| B.g | Identity overclaimed in v1; separated into `id` + tiered `matchKeys` | §1.1 |
| B.h | Do not add `patternRef` to IR yet | (not present) |

### Rejected, with reasons

**B.1 — "The test-case LLM should emit structured JSON steps instead of prose."**
Rejected. Three costs the suggestion does not price:

- The case-selection gate exists so a **human** reads and accepts cases before anything runs
  (`ARCHITECTURE.md`, `caseSelectionGate.ts`). Prose is the readable form; JSON steps are worse for
  the one job that stage has.
- It moves target selection into the test-case stage — which is IR's job. That is a second IR
  without IR's grounding, retry budget, or truncation handling.
- It modifies a shipped, working stage to serve a retrieval optimisation that has not yet been
  measured (Phase 0 is not done).

The dictionary-matching extractor in §2.5.2 gets the same requirements with **zero changes to
`testCases.ts`**, and degrades safely when it misses. If Phase 0 shows retrieval is where the
savings are and the extractor is the bottleneck, revisit then — with data.

**B.2 — "Use `p7c31:e4` instance ids plus a separate fingerprint."**
Rejected. `e4` is a counter, which is the exact bug corrected in Appendix A.1. And the proposed
fingerprint (`routePattern + role + tag + structuralPath`, dropping `name` **and**
`ordinalInContainer`) **collides**: two buttons in the same container become the same fingerprint,
so cross-run matching cannot tell "Add to Cart" from "Buy Now". The stated problem — that a rename
changes the id — is real and is addressed by tiered `matchKeys` (§1.1) without either a counter or a
colliding key.

**B.3 — "Per-test-type graph views (smoke / navigation / regression / healing)."**
Deferred, not rejected. Correct direction, but it multiplies retrieval policies before one has been
measured. §2.5.5 records it as the intended extension.

**B.4 — The review's end-to-end diagram feeds a "Test Case View" to the test-case LLM built from
requirements extracted from a test case.**
That is circular — no test case exists at that point. v2 splits the two purposes explicitly
(§2.5): the test-case View is retrieved from the **user prompt** and optimised for breadth; only the
IR View is retrieved from a test case.

### Added in v2, from neither document

- **Shortest-path guard** (§2.5.3.3): an unreachable required page is rendered without a reach line
  and reported, never silently dropped.
- **The retrieval safety invariant** (§2.5.1): extraction failures widen the View, never
  mis-ground. This is what makes prose matching acceptable in this one place.
- **`session:` line in the View** (Pass 5): stops the model writing login steps on an authenticated
  run, where `buildLoginPrefix()` already prepends them.
- **`unmatchedTerms`** (§2.5.2): a quoted string in a case that matches nothing in the Store is an
  early hallucination signal worth logging.

---

## Appendix C — Names to verify before editing

This spec references the repo from documentation. Confirm real symbols before wiring:
`domExtract.ts`, `hybridDiscovery.ts::discoverSiteHybrid`, `appModel.ts::toLiteModel`,
`ir.ts::groundingError` / `normalizeIR` / `buildLoginPrefix` / `PAGE_LEVEL_ASSERTIONS`,
`targetResolver.ts`, `caseSelectionGate.ts`, `executor.ts::scrubServedSecrets`, `runStore.ts`.
If a name differs, follow the repo, not this document.
