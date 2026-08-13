import { z } from "zod";
import { gemini } from "../llm/gemini.js";
import { parseJson } from "../llm/json.js";
import type { Plan } from "./planner.js";
import type { Coverage } from "./planner.js";
import type { AppModel } from "../schema/appModel.js";
import { toLiteModel } from "../schema/appModel.js";
import {
  strategyFor, unmatchedConcepts, filterByScope, ALL_SCOPES, CATEGORY_IDS, normalizeCategory,
  type ScopeFilter,
} from "../kb/testStrategy.js";
import { llmCacheGet, llmCacheSet, makeCacheKey } from "../kb/llmCache.js";
import { looksLikeCompoundLoginCase } from "./credentials.js";

// Models sometimes ignore case ("High") or return an array where a string was asked for
// ("expected": [...]) — normalize before validating rather than rejecting valid content.
const Priority = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  z.enum(["low", "medium", "high", "critical"])
).default("medium");
const StringOrJoinedArray = z.preprocess(
  (v) => (Array.isArray(v) ? v.join(" ") : v),
  z.string()
);

/** Priority ranking for sorting (lower number = higher priority). */
const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** Hard ceiling on cases turned into runnable scripts, whatever the coverage level asks for. */
const CASE_BUDGET: Record<Coverage, number> = { minimal: 2, standard: 4, full: 5 };
const maxCases = () => {
  const raw = Number(process.env.MAX_CASES_PER_RUN ?? 5);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 5;
};

/** How many cases this run may turn into scripts: the coverage level's target, never above
 *  the MAX_CASES_PER_RUN ceiling. */
export const budgetFor = (coverage: Coverage): number =>
  Math.min(CASE_BUDGET[coverage] ?? CASE_BUDGET.standard, maxCases());

// Words that carry no distinguishing meaning in a QA case title. Dropped before comparing,
// otherwise near-identical titles look different purely because one says "the" and "of".
const STOP = new Set([
  "the", "a", "an", "of", "for", "to", "and", "or", "in", "on", "with", "is", "are", "be",
  "test", "tests", "testing", "verify", "verifies", "check", "checks", "ensure", "that",
  "user", "users", "application", "app", "page", "flow", "functionality", "feature",
]);

const titleTokens = (t: string): Set<string> =>
  new Set(
    t.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/)
      .filter(w => w.length > 1 && !STOP.has(w))
  );

/** Jaccard-style overlap, measured against the SMALLER set so a wordier restatement of the
 *  same case still scores high. */
function titleOverlap(a: string, b: string): number {
  const ta = titleTokens(a), tb = titleTokens(b);
  if (!ta.size || !tb.size) return 0;
  let shared = 0;
  for (const w of ta) if (tb.has(w)) shared++;
  return shared / Math.min(ta.size, tb.size);
}

const DUPLICATE_AT = 0.7;

/**
 * Reduce every case the run produced to the handful that will actually be turned into
 * scripts.
 *
 * This exists because case selection used to happen INSIDE toTestCases, which the pipeline
 * calls twice — once upfront and once for pages found during execution. Each call applied its
 * own limit, so one prompt produced 4 cases or 8 depending on whether live-extend found a new
 * page, and the second call restated the first call's primary case in different words because
 * it re-ran "produce the literal translation of the plan" against the same plan. Selection has
 * to be one authority over the merged list.
 */
export function selectCases(all: TestCase[], budget: number = maxCases()): TestCase[] {
  const byPriority = (a: TestCase, b: TestCase) => (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2);

  // 1. Dedup. The fromPrompt case is the anchor — it's what the user literally asked for —
  //    then the highest-priority survivor of each remaining cluster.
  const ordered = [...all].sort((a, b) =>
    (b.fromPrompt ? 1 : 0) - (a.fromPrompt ? 1 : 0) || byPriority(a, b));
  // Title overlap ONLY. Grouping on category+targetUrl as well looked reasonable and was
  // wrong: it threw away "Log in with valid credentials" as a duplicate of the signup
  // happy-path case, because both are `valid` on the same entry URL. Two genuinely different
  // tests share a category all the time — that's what the diversity pass below is for, not
  // dedup.
  const kept: TestCase[] = [];
  for (const c of ordered) {
    if (!kept.some(k => titleOverlap(k.title, c.title) >= DUPLICATE_AT)) kept.push(c);
  }

  // 2. Diversity before depth. Filling the budget by raw priority produces five flavours of
  //    the same check; a capped suite is only defensible if the few cases in it cover
  //    different ground. One pass takes the best case from each distinct category, and only
  //    then are leftover slots filled by priority.
  const out: TestCase[] = [];
  const primary = kept.find(c => c.fromPrompt);
  if (primary) out.push(primary);

  const seenCategories = new Set(out.map(c => c.category));
  for (const c of kept) {
    if (out.length >= budget) break;
    if (out.includes(c) || seenCategories.has(c.category)) continue;
    out.push(c);
    seenCategories.add(c.category);
  }
  for (const c of kept) {
    if (out.length >= budget) break;
    if (!out.includes(c)) out.push(c);
  }
  return out;
}

/**
 * The single decision point for "which generated cases actually become runnable scripts."
 *
 * When the case-selection gate was used, `allCases` is already the human's final, explicit
 * decision (deduped by the accumulator, capped by MAX_ACCUMULATED_CASES) — `selectCases`'s
 * budget-fill/cap exists to solve "one prompt yields 4 or 8 cases inconsistently" in the
 * UNGATED flow, and re-applying it on top of an already-final human decision silently overrides
 * it in either direction (padding a deliberately small pick back up via reactive cases, or
 * capping a deliberately large one down to the coverage default). Only `filterByScope` — a
 * defensive floor, not a count constraint — still applies.
 *
 * When the gate was NOT used, this is exactly today's behavior: `selectCases` picks a
 * budget-capped, category-diverse subset of the raw generated batch.
 */
export function finalizeCaseSelection(
  allCases: TestCase[], scope: ScopeFilter[], coverage: Coverage, gateUsed: boolean
): TestCase[] {
  const scoped = filterByScope(allCases, scope);
  return gateUsed ? scoped : selectCases(scoped, budgetFor(coverage));
}

/**
 * Hard guarantee that a case already shown to the user (accepted OR rejected in an earlier
 * selection round) never reappears in a new batch. The LLM prompt asks for novelty and the
 * cache key now includes the rejected titles, but neither of those is a guarantee — the model
 * can ignore the instruction and the cache can return a stale batch. This is the enforced
 * floor: anything overlapping an already-seen title is dropped, whatever the model said.
 * Round 1 is unaffected (seenTitles is empty), so it still gets the full upfront suite.
 */
export function filterNovelCases(all: TestCase[], seenTitles: string[]): TestCase[] {
  if (seenTitles.length === 0) return all;
  return all.filter((c) => !seenTitles.some((s) => titleOverlap(s, c.title) >= DUPLICATE_AT));
}

/**
 * Deterministic backstop for the compound-login-case bug: applyCredentials (credentials.ts)
 * only ever substitutes the LAST fill of each credential kind, so a case combining a wrong
 * attempt with a valid one is broken whichever way the model orders the two. The system prompt
 * above now forbids this shape outright — this is the code-level backstop the project's "prompt
 * nudges are never the only guard" doctrine requires for whenever the model does it anyway.
 */
export function dropCompoundLoginCases(cases: TestCase[]): TestCase[] {
  const kept: TestCase[] = [];
  const dropped: TestCase[] = [];
  for (const c of cases) (looksLikeCompoundLoginCase(c) ? dropped : kept).push(c);
  if (!dropped.length) return cases;
  for (const d of dropped) {
    console.warn("[testCases] dropping compound login case (wrong+valid attempt in one case):", d.title);
  }
  // The dropped case may have carried the batch's only fromPrompt:true. caseSelectionGate.ts
  // throws when no case is tagged fromPrompt once the user has already made selections — promote
  // the best surviving "valid" case so a primary usually still exists after the drop.
  if (dropped.some((d) => d.fromPrompt) && !kept.some((k) => k.fromPrompt)) {
    const replacement = kept.filter((k) => k.category === "valid")
      .sort((a, b) => (rank[a.priority] ?? 2) - (rank[b.priority] ?? 2))[0];
    if (replacement) {
      replacement.fromPrompt = true;
      console.warn("[testCases] promoted", JSON.stringify(replacement.title), "to fromPrompt after dropping the compound primary case");
    } else {
      console.warn("[testCases] dropped the only fromPrompt case as compound and no 'valid' case survives to promote — batch has no primary");
    }
  }
  return kept;
}

export const TestCase = z.object({
  title: z.string(),
  priority: Priority,
  feature: z.string(),
  steps: z.array(z.string()).min(1),
  expected: StringOrJoinedArray,
  // True for the ONE case that's a direct translation of the user's own plan/request,
  // literal values and all. "priority" ranks coverage cases by severity for an eventual
  // multi-case run — it was never meant to pick a single winner, so at N=1 a "critical"
  // taxonomy case (e.g. SQL injection) was silently outranking and replacing whatever the
  // user actually asked to test. Orchestrator prefers this flag over priority for the
  // single case it runs today.
  fromPrompt: z.boolean().optional().default(false),
  // Routing label, coerced into a closed set. Everything downstream branches on this —
  // credential substitution, scope filtering, duplicate grouping, diversity selection — and
  // all three of those broke when it was free text the model could word however it liked
  // ("Security - SQL Injection" matched nothing). normalizeCategory never throws, so a label
  // nobody anticipated degrades to "functional-other" instead of failing the whole array.
  category: z.preprocess((v) => normalizeCategory(typeof v === "string" ? v : undefined),
    z.enum(CATEGORY_IDS)),
  // The model's own words for what this case is testing. The label above is constrained; the
  // reasoning is not — the checklist stays a floor, not a ceiling.
  intent: z.string().optional(),
  /** Checklist item this case came from, when it came from one. Display only. */
  checklistTitle: z.string().optional(),
  // The specific page URL this case targets. Set when the application model contains
  // multiple pages — tells later stages which page to start from / focus on. Optional
  // for backward compatibility with single-page runs.
  targetUrl: z.string().optional(),
  // Distinguishes upfront generation (before execution) from reactive generation
  // (after primary-case execution discovers new pages via live-extend). Used to
  // avoid regenerating cases for pages we already covered. Stamped in code, never
  // produced by the LLM — excluded from the LLM-facing schema below.
  generatedFrom: z.enum(["upfront", "reactive"]).optional().default("upfront"),
});
export type TestCase = z.infer<typeof TestCase>;

// LLM-facing schema: same as TestCase but WITHOUT generatedFrom — the model never
// produces this field, it's stamped in code after parsing.
const LLMTestCase = TestCase.omit({ generatedFrom: true });

// Grounding is deliberately NOT checked here. This stage only ever sees the entry-page model
// (extension enriches the model later, inside toIR), so a fuzzy check here can't tell a
// hallucinated element from one on a page discovery hasn't reached yet — it just killed
// legitimate multi-page cases before they got to the stage that can resolve them. ir.ts's
// groundingError (exact role+name) plus extendAppModel is the single grounding authority.
export interface ExtendContext {
  /** Titles already covered by an earlier batch. Present only on the reactive call. */
  existingTitles: string[];
  /** Titles the user explicitly rejected in an earlier case-selection round. The model must
   *  never propose these again, not even reworded. */
  rejectedTitles?: string[];
  /** When true, this extend call must still mint exactly one fromPrompt:true case — used
   *  when no primary has been accepted into the gate's pool yet. When false/absent,
   *  preserves today's behavior (never mint a primary on an extend call). */
  mintPrimary?: boolean;
  /** The user's latest prompt/refinement for THIS batch (round N+1's "not satisfied" reply,
   *  or the original prompt on a reactive extend). Rendered as an additive focus instruction,
   *  never as a replacement for the plan/checklist grounding. */
  latestPrompt?: string;
}

/** Options that shape generation without switching it into "extend" mode. Kept separate from
 *  ExtendContext so round 1 (which must mint exactly one fromPrompt case) can carry them
 *  without tripping the extend branch's "never set fromPrompt" rule. */
export interface GenerationOptions {
  /** The literal source prompt of the run. Used in the cache key so two runs whose plans
   *  happen to be identical (a rephrased prompt) never collide on a stale cached suite. */
  sourcePrompt?: string;
}

export async function toTestCases(
  p: Plan, appModel: AppModel, extend?: ExtendContext, opts: GenerationOptions = {}
): Promise<TestCase[]> {
  // A human QA engineer doesn't stop at the happy path. Pull the standard coverage
  // categories for whatever features discovery found, and require one case per category —
  // this is what turns "test the login" (one bare case before) into a real suite.
  const concepts = [...new Set(appModel.pages.flatMap(pg => pg.concepts))];

  // Scope reaches the PROMPT now, not just a post-filter. Generating security cases and then
  // discarding them wasted a Gemini call and skewed the suite toward attack shapes even when
  // the user asked for a functionality test.
  const scope = (p.testTypeScope ?? ALL_SCOPES) as ScopeFilter[];
  const wantsSecurity = scope.includes("security");
  // The checklist itself must obey scope too — telling the model "do NOT write security
  // cases" while still handing it a "[critical] SQL injection in login" line item is a
  // contradiction the model doesn't reliably resolve in the instruction's favor.
  const categories = strategyFor(concepts).filter(c => scope.includes(c.scope));
  const strategyList = categories.map(c => `- [${c.priority}] ${c.title}: ${c.intent}`).join("\n");
  const gaps = unmatchedConcepts(concepts);
  const scopeLine = wantsSecurity
    ? "valid path, invalid inputs, empty fields, boundaries, and security."
    : `valid path, invalid inputs, empty fields, and boundaries.
This run is FUNCTIONAL testing only. Do NOT write security cases — no SQL injection, no XSS,
no payloads. A case whose point is an attack is out of scope and will be discarded.`;
  const securityDimension = wantsSecurity
    ? "  4. Security — injection/XSS — wherever a free-text input exists\n"
    : "";
  // The literal-translation instruction is right for the first batch and actively harmful on
  // the extension batch: re-running it against the SAME plan produced a reworded copy of the
  // primary case ("Verify end-to-end account creation and authentication flow" vs "Verify the
  // end-to-end functionality of user account creation and authentication").
  const rejectedBlock = (extend?.rejectedTitles?.length ?? 0)
    ? `\nThe user explicitly REJECTED the cases below in an earlier selection round. Do NOT propose
any of them again, and do NOT write a near-reworded copy of any of them. Rejected:
${extend!.rejectedTitles!.map((t) => `  - ${t}`).join("\n")}`
    : "";
  // Appended only where a primary actually gets minted (never on the "extend, no mintPrimary"
  // branch, which has no primary to carve anything out of) — see the "never combine" rule below
  // for why a literal request describing both legs still can't become one compound case.
  const compoundLoginCarveOut = `
If the plan/request itself literally describes BOTH a deliberately-wrong login attempt and a
genuinely-valid one, do not combine them into the fromPrompt case even though the request
describes both. Split them: the fromPrompt case is ONLY the valid-login half, using the plan's own
concrete values verbatim; write the wrong-attempt half as a separate, ordinary case with category
"invalid-input" ("fromPrompt" omitted or false) — it may stand in for the checklist's own "Invalid
password" item rather than duplicating it.`;
  const fromPromptRule = extend
    ? (extend.mintPrimary
        ? `These cases EXTEND an existing suite, but no primary case has been accepted yet.
Exactly ONE case in this batch must be tagged "fromPrompt": true — the direct, literal translation
of the plan itself, using the plan's own concrete values. Do NOT restate anything already covered
below. Already covered:
${extend.existingTitles.map(t => `  - ${t}`).join("\n")}${rejectedBlock}${compoundLoginCarveOut}`
        : `These cases EXTEND an existing suite. Do NOT restate anything already covered — write
only cases for behaviour the list below does not reach. Never set "fromPrompt"; the suite already
has its primary case. Already covered:
${extend.existingTitles.map(t => `  - ${t}`).join("\n")}${rejectedBlock}`)
    : `Exactly ONE case — the direct, literal translation of the plan itself — must be tagged
"fromPrompt": true.${compoundLoginCarveOut}`;

  const system =
    `You write concrete, human-readable QA test cases from a plan and an application model. Output ONLY a JSON array, no prose, no markdown fences.

You write a SUITE, not a single happy-path case — the way a QA engineer covers a feature:
${scopeLine}

A coverage checklist is provided below for common feature types (login, checkout, search, ...).
It is a KNOWN-RELIABLE FLOOR, not the ceiling of what to test — it exists because past runs
proved that asking for coverage with no guidance produces one bare happy-path case and nothing
else. Produce at least one case per applicable checklist item, using the tag shown as that
case's "priority".

The checklist does not cover every kind of feature. For EVERY concept in the application model
— whether or not it's on the checklist — additionally reason from first principles using these
QA dimensions, applied to the actual elements you see for that concept, not just the checklist:
  1. Valid / expected use
  2. Invalid or malformed input
  3. Empty or boundary values
${securityDimension}  5. A verifiable state change the action should cause
This applies with extra weight to any concept with no checklist entry: don't fall back to a
single generic case for it — work out real coverage for what that feature actually does.

The application model may describe one or more pages. Each page has its own URL, concepts, and
elements. A later stage drives the app for real and verifies steps against each page as it
reaches them, so steps beyond the first page are expected.

${fromPromptRule} Its steps must use whatever concrete values the plan/request actually gave
(a specific email, password, search term, etc.) VERBATIM, never a different placeholder. This is
the case a later stage runs today when it can only execute one; it must be the one the user
actually asked for, not whichever checklist item happens to rank most severe. Every other case
(checklist or first-principles) omits "fromPrompt" or sets it false.

Rules, follow exactly:
- For the CURRENT page — the page this case targets, before any navigating action (login submit, add to cart, checkout) in this test case — every UI element, label, or button name you mention must be taken verbatim from the application model. Never invent an element on that page.
- AFTER a navigating action, the next page isn't in the model yet. Still write those steps: describe the real next action in plain language (e.g. "Add the backpack to the cart", "Complete checkout"). Do not invent a specific element NAME for a page you can't see — describe the intent and let the later stage resolve it against the real page.
- Only write a case whose FIRST action targets an element that actually exists on the target page. Skip a checklist item if the target page has no element to start it (e.g. no search box → skip search cases).
- "targetUrl" must be the URL of the page this case tests, taken verbatim from the application model's pages array. When the model has multiple pages, this tells the later stage which page to start from. When there is only one page, set it to that page's URL.
- "feature" must be one of the application model's concepts.
- "category" MUST be exactly one of: ${CATEGORY_IDS.join(" | ")} — the QA dimension this case exercises. Pick the closest one; never invent a value.
- "intent" is one short free-text sentence in your own words describing what this case proves. The category is a fixed label; the intent is your reasoning.
- "checklistTitle" is the checklist item title when the case came from the checklist below, omitted otherwise.
- "steps" are concrete, ordered, human-readable actions (e.g. "Click the 'Log in' button"), not vague ("Test the login").
- "expected" is the concrete, observable outcome — an element becoming visible, a URL changing, specific text appearing — not a vague pass/fail statement.
- A case must never combine a deliberately-WRONG credential attempt with a genuinely-valid one in the same case/browser session (e.g. never "log in with the wrong password, verify the error, then log in again with the right password" as one case). Write these as two separate cases instead — the checklist below already lists them as two distinct items, "Valid credentials" (category "valid") and "Invalid password" (category "invalid-input"), each getting its own case and its own browser session. This is not a style preference: credentials are substituted once per case, matched to the LAST fill of each kind — a case that fills a password field twice (once wrong, once right) either overwrites the deliberately-wrong attempt with the real password (silently turning a negative test into a no-op) or leaves the valid attempt with an invented value that never authenticates. The case is broken either way it's ordered.

The example below is a SHAPE reference only. Its element names, URLs and values belong to the
example, never to your output: take every element name from the application model you were
given, and take any credential or literal value from the plan/request. A positive case must
carry the request's OWN values verbatim — never an address or password invented to look
plausible, and never one copied from this example.

Example of the exact shape required — note the first steps name real entry-page elements
verbatim, steps after a navigating action describe intent for pages not yet in the model, category is populated,
targetUrl points to the page being tested, and
exactly one case (the plan's own literal ask) carries "fromPrompt": true:
[ { "title": "Log in with the given credentials", "priority": "high", "feature": "Login", "fromPrompt": true, "category": "valid", "intent": "proves a real user can authenticate with the credentials given", "checklistTitle": "Valid credentials", "targetUrl": "https://example.com/login",
    "steps": ["Navigate to /login", "Fill '<the model's own identifier field>' with '<the identifier from the request>'", "Fill '<the model's own password field>' with '<the password from the request>'", "Click '<the model's own submit button>'"],
    "expected": "Login succeeds and the authenticated area is shown" },
  { "title": "Login with invalid password", "priority": "high", "feature": "Login", "category": "invalid-input", "intent": "proves a wrong password is rejected rather than silently accepted", "checklistTitle": "Invalid password", "targetUrl": "https://example.com/login",
    "steps": ["Navigate to /login", "Fill '<the model's own identifier field>' with '<the identifier from the request>'", "Fill '<the model's own password field>' with 'an-incorrect-password'", "Click '<the model's own submit button>'"],
    "expected": "An 'invalid credentials' error is shown and the user stays on the login page" } ]`;
  const gapsLine = gaps.length
    ? `\nConcepts with NO checklist entry — apply the 5 reasoning dimensions above to these directly, do not just emit one generic case: ${gaps.join(", ")}\n`
    : "";
  const liteModel = toLiteModel(appModel);
  // The literal prompt is part of the key: two runs whose plans are identical (a rephrased
  // request) must NOT collide on a cached batch, or "customizing" silently returns yesterday's
  // suite. The round's refinement prompt joins too, so a new focus direction in a later gate
  // round forces a fresh generation instead of the previous batch.
  // `system` joins for the same reason every other real input does: the disk cache never
  // expires, so a rule this prompt gains or loses would otherwise never reach any plan+model
  // combination already seen. Hashing the text means nobody has to remember to bump a version.
  const cacheKey = makeCacheKey(
    JSON.stringify(p), JSON.stringify(liteModel), scope.join(","),
    (extend?.existingTitles ?? []).join("|"), (extend?.rejectedTitles ?? []).join("|"),
    opts.sourcePrompt ?? "", extend?.latestPrompt ?? "",
    system, process.env.GEMINI_MODEL ?? "default");
  const cachedCases = llmCacheGet<TestCase[]>(cacheKey);
  if (cachedCases) return cachedCases;

  // Additive focus for a regeneration round: the user's "not satisfied" reply steers WHAT to
  // cover, but the plan, the checklist floor, and the element-grounding rules still apply — a
  // refinement must not be able to invent elements or drag the batch away from the model.
  const focusBlock = extend?.latestPrompt
    ? `\nThe user refined the request for this round. Cover what they asked for below, but stay
grounded: elements on the CURRENT page must still come verbatim from the application model, the
checklist floor above still applies, and nothing already covered or rejected may be restated.
Refinement:
${extend.latestPrompt}
`
    : "";

  const user =
    `Plan: ${JSON.stringify(p)}
Application model: ${JSON.stringify(liteModel)}

Coverage checklist floor (produce one grounded case per applicable item):
${strategyList}
${gapsLine}
${focusBlock}Return JSON array: [ { "title","priority","feature","steps":string[],"expected","fromPrompt","category","intent","checklistTitle","targetUrl" } ]`;

  console.log("[testCases] prompt chars:", user.length, "| approx tokens:", Math.round(user.length / 4), "| pages:", liteModel.pages.length);

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await gemini(user, { systemInstruction: system, json: true });
    try {
      const parsed: any = parseJson(raw);
      const arr = Array.isArray(parsed) ? parsed : parsed.testCases ?? [];
      // Parse against LLM-facing schema (no generatedFrom) — the model never produces it.
      const result = z.array(LLMTestCase).safeParse(arr);
      if (result.success) {
        // Stamp generatedFrom in code — this is pipeline provenance, not LLM output.
        const stamped: TestCase[] = result.data.map(c => ({ ...c, generatedFrom: "upfront" as const }));
        // Scope filtering stays as a backstop for a model that ignores the instruction above.
        // Case COUNT is no longer decided here — selectCases() is the single authority over the
        // merged upfront + reactive list, so this stage can't cap twice and produce 4-or-8.
        const scoped = filterByScope(stamped, scope);
        const finalCases = dropCompoundLoginCases(scoped);
        llmCacheSet(cacheKey, finalCases);
        return finalCases;
      }
      lastErr = result.error.message;
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
    }
  }
  throw new Error(`Test cases failed schema validation after retry: ${lastErr}`);
}

/**
 * Generate test cases for pages that were discovered reactively during primary-case
 * execution (via live-extend). Filters the updated AppModel to only include pages
 * not present in the original page URLs, then generates cases for those new pages.
 * All generated cases are tagged with `generatedFrom: "reactive"` to distinguish
 * them from upfront-generated cases.
 */
export async function generateCasesForNewPages(
  updatedAppModel: AppModel,
  originalPageUrls: string[],
  plan: Plan,
  prompt: string,
  /** Titles already covered, so this batch extends the suite instead of restating it. */
  existingTitles: string[] = []
): Promise<TestCase[]> {
  // Filter to only new pages not in the original set
  const originalUrlsSet = new Set(originalPageUrls);
  const newPages = updatedAppModel.pages.filter(page => !originalUrlsSet.has(page.url));

  if (newPages.length === 0) {
    return []; // No new pages discovered
  }

  // Create a filtered AppModel with only new pages
  const filteredModel: AppModel = {
    baseUrl: updatedAppModel.baseUrl,
    pages: newPages,
  };

  // Generate cases for the new pages. The run's own prompt is threaded through as this
  // batch's latestPrompt AND part of the cache key, so reactive cases follow the user's
  // actual request instead of anchoring to whatever feature the first page happened to have.
  const cases = await toTestCases(plan, filteredModel, { existingTitles, latestPrompt: prompt }, { sourcePrompt: prompt });

  // Tag all as reactive, and clear fromPrompt: toTestCases' prompt mandates exactly one
  // fromPrompt case per call, so this batch mints its own — but the run already has a
  // primary case from the upfront batch. Leaving both set made suiteRunner graft the
  // primary's already-executed result onto an unrelated reactive case (seen in practice:
  // two cases reporting "reused": true for different titles).
  return cases.map(c => ({ ...c, generatedFrom: "reactive" as const, fromPrompt: false }));
}
