import { z } from "zod";
import { llm, cacheModelDimension, providerFor, modelFor } from "../llm/client.js";
import { parseJson, unwrapArray } from "../llm/json.js";
import type { Plan } from "./planner.js";
import type { AppModel } from "../schema/appModel.js";
import { toLiteModel } from "../schema/appModel.js";
import {
  strategyFor, unmatchedConcepts, filterByScope, ALL_SCOPES, CATEGORY_IDS,
  type ScopeFilter,
} from "../kb/testStrategy.js";
import { llmCacheGet, llmCacheSet, makeCacheKey, isCacheableResult, llmCacheVersion } from "../kb/llmCache.js";
import { salesforceGuidance } from "./salesforceGuidance.js";
import { llmCacheDimension } from "../llm/llmContext.js";
// The shared PIECES are imported, not copied: the TestCase schema, the compound-login filter and
// the typed "no usable cases" error. Importing does not edit testCases.ts, keeps the two
// correctness filters from drifting between the two generators, and keeps the orchestrator's
// `instanceof NoTestCasesError` check true for a Pro failure (a copied class would fail it and
// silently lose 03-cases-raw.txt). If Pro ever needs its own version of one, it stops importing it.
import {
  LLMTestCase, NoTestCasesError, dropCompoundLoginCases,
  type TestCase, type ExtendContext, type GenerationOptions,
} from "./testCases.js";
import type { SpecModel } from "../schema/spec.js";

/**
 * The Pro case generator — Pro document intake's own road to a suite.
 *
 * WHY A SEPARATE FILE AND NOT AN OPTION ON toTestCases. Pro will need its own generation LOGIC
 * later, not only extra prompt text. In its own file that divergence costs nothing and can never
 * regress the standard path, because the standard path's file is never opened:
 * `tests/testCasesNoChange.test.ts` pins toTestCases' prompt and cache key byte-for-byte.
 *
 * WHAT WAS COPIED, AND THE DRIFT RISK THAT CARRIES. The prompt, the cache key and the two-attempt
 * retry loop below began as an exact copy of `toTestCases` and then gained the spec. The copy is
 * deliberate (DECISIONS.md) and has one real hazard: the cache key. Its disk half never expires,
 * so a dimension added to toTestCases' key and not to this one would serve a stale suite here
 * forever, with no error. `tests/proTestCases.test.ts` pins the two keys position-for-position —
 * the same eleven dimensions in the same order, plus the spec as a twelfth — so that change fails
 * a test instead.
 *
 * WHAT THE SPEC IS ALLOWED TO DO. It decides which cases get written. It never reaches the IR,
 * grounding, the generator or the executor: elements still come from the application model, and
 * grounding still verifies every step against the real discovered page, not the document.
 *
 * A KNOWN GAP, STATED. `outOfScope` is honoured by the prompt only. There is no structure linking
 * a generated case to an out-of-scope item, and filtering on the case's TEXT would be exactly the
 * regex-over-model-prose check CLAUDE.md warns against (TD-01). Recorded in DECISIONS.md.
 */

export type ProGenerationOptions = GenerationOptions & { spec: SpecModel };

/** Prefixed to any Pro generation failure. The run fails — it never falls back to toTestCases,
 *  because a suite that silently ignores the document the user uploaded is worse than an error. */
export const PRO_FAILURE_PREFIX = "Pro generation failed — run again without Pro.";

// Copied from testCases.ts (not exported there). Only used inside the prompt text.
const PRIORITIES = ["low", "medium", "high", "critical"] as const;

/** Appended to the copied system instruction. Part of `system`, so part of the cache key. */
const PRO_SYSTEM_ADDENDUM = `

A REQUIREMENTS SPECIFICATION may be provided below, distilled from the user's own requirements
document and confirmed by the user. When it is present:
- Prefer cases that prove its rules and acceptance criteria. Where the application model offers a
  way to exercise a rule, write at least one case that would fail if the rule were broken.
- The user's answers to open questions are facts about the application. Use them; never contradict them.
- NEVER write a case for anything listed as out of scope.
- The specification says WHAT to test, never WHICH elements exist. Every element you name on the
  current page must still come verbatim from the application model. A rule the application model
  gives no way to reach gets no case — do not invent a page or control to test it.
- The checklist floor still applies alongside the specification.`;

/** The spec, rendered for the user prompt. Only non-empty sections appear. */
function specBlock(spec: SpecModel): string {
  const list = (title: string, items: string[]) =>
    items.length ? `${title}\n${items.map((i) => `  - ${i}`).join("\n")}\n` : "";
  const answers = spec.answers.length
    ? `Answers the user gave to open questions:\n${spec.answers.map((a) => `  - Q: ${a.question}\n    A: ${a.answer}`).join("\n")}\n`
    : "";
  const body =
    list("Rules (testable constraints):", spec.rules) +
    list("Acceptance criteria:", spec.criteria) +
    answers +
    list("Out of scope — write NO case for these:", spec.outOfScope);
  return body ? `\nRequirements specification (from the user's document, confirmed by the user):\n${body}` : "";
}

/**
 * Generate a suite steered by the confirmed spec. Same contract as `toTestCases` (same arguments
 * plus `opts.spec`, same return), so the case-selection gate can be handed either one.
 *
 * Every failure is rethrown with PRO_FAILURE_PREFIX. A NoTestCasesError stays a NoTestCasesError
 * (same class, same raw response), so the orchestrator still saves 03-cases-raw.txt for it.
 */
export async function proTestCases(
  p: Plan, appModel: AppModel, extend: ExtendContext | undefined, opts: ProGenerationOptions,
): Promise<TestCase[]> {
  try {
    return await generateProCases(p, appModel, extend, opts);
  } catch (err: any) {
    if (err instanceof Error && !err.message.startsWith(PRO_FAILURE_PREFIX)) {
      err.message = `${PRO_FAILURE_PREFIX} ${err.message}`;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------------------------
// The copied skeleton of toTestCases, with the spec added. Kept in the original's order so a diff
// against testCases.ts reads as "the same function, plus the spec".
// ---------------------------------------------------------------------------------------------

async function generateProCases(
  p: Plan, appModel: AppModel, extend: ExtendContext | undefined, opts: ProGenerationOptions,
): Promise<TestCase[]> {
  const { spec } = opts;
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

  const baseSystem =
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
- "priority" MUST be exactly one of: ${PRIORITIES.join(" | ")} — how urgent this case is. Copy the tag shown in the checklist above where there is one; otherwise pick the closest. Never invent a value, and never put a test TYPE or SCOPE here ("functional", "security", "smoke" are not priorities).
- "category" MUST be exactly one of: ${CATEGORY_IDS.join(" | ")} — the QA dimension this case exercises. Pick the closest one; never invent a value.
- "intent" is one short free-text sentence, in QA terms, describing what this case proves. The category is a fixed label; the intent is your reasoning. Required on every case.
- "whyItMatters" is a SEPARATE sentence, for someone who has never written or read a test before. No QA vocabulary (never use the words "proves", "verifies", "validates", "constraint", "enforces"). Describe the real consequence for a real person if this breaks — what a visitor experiences, or what the site owner loses — not what gets checked. Bad: "Proves that the contact form enforces its required Email field constraint." Good: "If this breaks, someone trying to contact you gets a silent failure and you never hear from them." Required on every case.
- "checklistTitle" is the checklist item title when the case came from the checklist below, omitted otherwise.
- "steps" are concrete, ordered actions written as full sentences describing what a person does, not terse imperatives echoing raw element names. Bad: "Fill 'Email *' with 'a@b.c'". Good: "Type an email address into the 'Email' field." Bad: "Click 'Submit'". Good: "Click the 'Submit' button to send the form." Always keep the real element's name in quotes exactly as the application model gives it, wherever it falls in the sentence — later stages match against that literal quoted name, so it must never be paraphrased, only the sentence AROUND it.
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
[ { "title": "Log in with the given credentials", "priority": "high", "feature": "Login", "fromPrompt": true, "category": "valid", "intent": "proves a real user can authenticate with the credentials given", "whyItMatters": "If this breaks, real customers can't get into their accounts at all — the site is effectively unusable for anyone already signed up.", "checklistTitle": "Valid credentials", "targetUrl": "https://example.com/login",
    "steps": ["Go to the '/login' page.", "Type the given identifier into the '<the model's own identifier field>' field.", "Type the given password into the '<the model's own password field>' field.", "Click the '<the model's own submit button>' button to sign in."],
    "expected": "Login succeeds and the authenticated area is shown" },
  { "title": "Login with invalid password", "priority": "high", "feature": "Login", "category": "invalid-input", "intent": "proves a wrong password is rejected rather than silently accepted", "whyItMatters": "If this breaks, someone else's guess at a password could get into an account it doesn't belong to — a real security hole, not just a bug.", "checklistTitle": "Invalid password", "targetUrl": "https://example.com/login",
    "steps": ["Go to the '/login' page.", "Type the given identifier into the '<the model's own identifier field>' field.", "Type an incorrect password into the '<the model's own password field>' field.", "Click the '<the model's own submit button>' button."],
    "expected": "An 'invalid credentials' error is shown and the user stays on the login page" } ]`;
  // "" unless this is a Salesforce run — then `system`, and the cache key that hashes it, differ.
  const system = baseSystem + PRO_SYSTEM_ADDENDUM + salesforceGuidance("cases");
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
    system, cacheModelDimension("main"), llmCacheDimension("main"), llmCacheVersion(),
    // PRO ONLY — the twelfth dimension. The confirmed spec lives in the USER prompt, not in
    // `system`, so hashing `system` alone would let two runs with different documents share one
    // cached suite. Zod-parsed upstream, so its key order is the schema's and the JSON is stable.
    JSON.stringify(spec));
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
${specBlock(spec)}
${focusBlock}Return JSON array: [ { "title","priority","feature","steps":string[],"expected","fromPrompt","category","intent","whyItMatters","checklistTitle","targetUrl" } ]`;

  console.log("[proTestCases] prompt chars:", user.length, "| approx tokens:", Math.round(user.length / 4), "| pages:", liteModel.pages.length);

  let lastErr = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const { content: raw, finishReason } = await llm(user, {
      systemInstruction: system,
      json: true,
      jsonEnvelope: "cases",
      role: "main",
      stage: "testcases",
    });
    try {
      const parsed: any = parseJson(raw);
      // Tolerant array unwrap — a model asked for a top-level array sometimes wraps it in an
      // envelope (`{"testCases":[...]}`, `{"cases":[...]}`, or a single-key object whose value is
      // the array). Bare arrays and every one of those shapes come back the same way here.
      const arr = unwrapArray(parsed, ["cases", "testCases", "test_cases"]) ?? [];
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
        if (finalCases.length === 0) {
          // An empty case list is a failed stage — the model (or the cache) returned "no
          // answers". Never let this look like a clean empty-generation outcome: no cache
          // write, and the orchestrator ends the run as blocked/error after saving the raw
          // response for diagnosis. provider/model name who actually billed the attempt.
          const provider = providerFor("main");
          const modelOrDeployment = modelFor("main");
          throw new NoTestCasesError(provider, modelOrDeployment, raw, finishReason);
        }
        if (isCacheableResult(finalCases)) llmCacheSet(cacheKey, finalCases);
        return finalCases;
      }
      lastErr = result.error.message;
    } catch (err: any) {
      // A NoTestCasesError is a definite "no answer", not a retryable parse/schema flake —
      // letting the generic catch swallow it would convert the staged failure into silent
      // retries (and re-bill / re-cache for a result we already know is empty).
      if (err instanceof NoTestCasesError) throw err;
      lastErr = err?.message ?? String(err);
    }
  }
  throw new Error(`Test cases failed schema validation after retry: ${lastErr}`);
}
