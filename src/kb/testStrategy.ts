/**
 * Static test-strategy knowledge base: what a human QA engineer would cover for a given
 * feature, as a lookup table instead of an LLM guess. Keyed by the concepts discovery
 * already extracts (Login, Search, Checkout, ...). Each category is guidance the testCases
 * stage turns into ONE grounded, human-readable case; the priority feeds the orchestrator's
 * top-N execution budget so the most important cases run first.
 *
 * ponytail: a hand-written table, not a learned/vector store — the web-QA category space is
 * small and enumerable. Add a concept here when a new feature type shows up in real prompts;
 * graduate to a learned store only if this table stops keeping up (it won't for a long time).
 */
export type TestCategory = "functional" | "security";
export type ScopeFilter = TestCategory;
export const ALL_SCOPES: TestCategory[] = ["functional", "security"];

/**
 * The routing label every test case carries. Deliberately the QA-REASONING axis (the five
 * dimensions testCases.ts already asks the model to think along), not the checklist titles
 * below.
 *
 * Why not the titles: the prompt requires first-principles cases for concepts the checklist
 * doesn't cover, and those have no title to land on — they'd all collapse into one catch-all
 * bucket, which would defeat the diversity-based case selection that partitions on this field.
 * These six actually split real cases.
 *
 * Free-form `category` strings were the shared root cause of three separate bugs: credential
 * substitution clobbering deliberate payloads, security cases surviving a functional-only run,
 * and duplicate detection having nothing reliable to group on. A closed set fixes all three.
 * The case itself is still invented freely — only the label is constrained.
 */
export const CATEGORY_IDS = [
  "valid",
  "invalid-input",
  "empty-boundary",
  "state-change",
  "security-injection",
  "security-xss",
  "functional-other",
] as const;
export type CategoryId = (typeof CATEGORY_IDS)[number];

const CATEGORY_SCOPE: Record<CategoryId, TestCategory> = {
  "valid": "functional",
  "invalid-input": "functional",
  "empty-boundary": "functional",
  "state-change": "functional",
  "security-injection": "security",
  "security-xss": "security",
  "functional-other": "functional",
};

export const scopeOf = (id: CategoryId): TestCategory => CATEGORY_SCOPE[id] ?? "functional";

export interface Category {
  title: string;
  priority: "critical" | "high" | "medium" | "low";
  intent: string;
  scope: TestCategory;
  /** Which reasoning dimension this checklist item belongs to. */
  category: CategoryId;
}

const STRATEGY: Record<string, Category[]> = {
  login: [
    { title: "Valid credentials",       priority: "high",     intent: "log in with valid credentials; expect to reach the authenticated area / dashboard", scope: "functional" , category: "valid" },
    { title: "Invalid password",        priority: "high",     intent: "valid identifier + wrong password; expect an error and staying logged out", scope: "functional" , category: "invalid-input" },
    { title: "Empty identifier",        priority: "medium",   intent: "submit with the email/username field blank; expect a validation error", scope: "functional" , category: "empty-boundary" },
    { title: "Empty password",          priority: "medium",   intent: "submit with the password field blank; expect a validation error", scope: "functional" , category: "empty-boundary" },
    { title: "Malformed email",         priority: "low",      intent: "an email without '@'; expect a format validation error", scope: "functional" , category: "invalid-input" },
    { title: "SQL injection in login",  priority: "critical", intent: "enter ' OR '1'='1 as the identifier; expect rejection, no authentication bypass", scope: "security" , category: "security-injection" },
  ],
  signup: [
    { title: "Valid registration",      priority: "high",     intent: "register with valid, unique details; expect success/confirmation", scope: "functional" , category: "valid" },
    { title: "Existing account",        priority: "high",     intent: "register with an email that already exists; expect a 'already registered' error", scope: "functional" , category: "invalid-input" },
    { title: "Password mismatch",       priority: "medium",   intent: "confirm-password differs from password; expect a mismatch error", scope: "functional" , category: "invalid-input" },
    { title: "Weak password",           priority: "medium",   intent: "a too-short/weak password; expect a strength/validation error", scope: "functional" , category: "invalid-input" },
    { title: "Empty required fields",   priority: "medium",   intent: "submit with required fields blank; expect validation errors", scope: "functional" , category: "empty-boundary" },
  ],
  search: [
    { title: "Valid query",             priority: "high",     intent: "search a term expected to have results; expect relevant results shown", scope: "functional" , category: "valid" },
    { title: "No-results query",        priority: "medium",   intent: "search gibberish unlikely to match; expect an empty/'no results' state, not an error", scope: "functional" , category: "empty-boundary" },
    { title: "Empty query",             priority: "low",      intent: "submit search with no input; expect it handled gracefully", scope: "functional" , category: "empty-boundary" },
    { title: "Special characters",      priority: "medium",   intent: "search with <script> / SQL-ish characters; expect them handled safely, no injection", scope: "security" , category: "security-injection" },
  ],
  checkout: [
    { title: "Complete a purchase",     priority: "high",     intent: "add an item and complete checkout with valid details; expect an order confirmation", scope: "functional" , category: "valid" },
    { title: "Empty cart checkout",     priority: "medium",   intent: "attempt checkout with an empty cart; expect it blocked or an empty-cart message", scope: "functional" , category: "empty-boundary" },
    { title: "Missing shipping info",   priority: "medium",   intent: "submit checkout with required address fields blank; expect validation errors", scope: "functional" , category: "empty-boundary" },
    { title: "Invalid card",            priority: "high",     intent: "enter an invalid/expired card number; expect a payment error, order not placed", scope: "functional" , category: "invalid-input" },
  ],
  cart: [
    { title: "Add item to cart",        priority: "high",     intent: "add an item; expect the cart count/contents to update", scope: "functional" , category: "state-change" },
    { title: "Remove item from cart",   priority: "medium",   intent: "remove an item from the cart; expect it to disappear and totals to update", scope: "functional" , category: "state-change" },
  ],
  contact: [
    { title: "Valid submission",        priority: "medium",   intent: "fill the form with valid values and submit; expect a success/thank-you state", scope: "functional" , category: "valid" },
    { title: "Empty required fields",   priority: "medium",   intent: "submit with required fields blank; expect validation errors", scope: "functional" , category: "empty-boundary" },
    { title: "Malformed email",         priority: "low",      intent: "an email without '@'; expect a format validation error", scope: "functional" , category: "invalid-input" },
  ],
};

// Concept strings come from an LLM, so they vary ("Sign In", "Log In", "Registration").
// Map the common wordings onto the canonical keys above; unmatched concepts just fall through.
const ALIASES: Record<string, keyof typeof STRATEGY> = {
  "login": "login", "log in": "login", "sign in": "login", "signin": "login", "authentication": "login", "auth": "login",
  "signup": "signup", "sign up": "signup", "register": "signup", "registration": "signup", "create account": "signup", "create an account": "signup",
  "search": "search", "find": "search",
  "checkout": "checkout", "payment": "checkout", "billing": "checkout", "order": "checkout",
  "cart": "cart", "basket": "cart", "bag": "cart",
  "contact": "contact", "contact us": "contact", "feedback": "contact", "enquiry": "contact", "inquiry": "contact",
};

// Applies to any input/form page whatever the concept — the floor of coverage.
const GENERIC: Category[] = [
  { title: "Submit with all required fields empty", priority: "medium", intent: "submit the primary form with required fields blank; expect validation, not a silent success", scope: "functional" , category: "empty-boundary" },
];

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/** The coverage categories a human QA engineer would apply to these page concepts:
 *  the union of every matched concept's categories, plus the generic floor, deduped. */
export function strategyFor(concepts: string[]): Category[] {
  const seen = new Set<string>();
  const out: Category[] = [];
  const add = (c: Category) => { if (!seen.has(c.title)) { seen.add(c.title); out.push(c); } };

  for (const concept of concepts) {
    const key = ALIASES[norm(concept)];
    if (key) for (const c of STRATEGY[key]) add(c);
  }
  for (const c of GENERIC) add(c);
  return out;
}

/** Concepts with no entry in the table (e.g. "Attendance", "Kanban Board") — this table
 *  only covers ~6 common web-app feature types, so most real applications will have some.
 *  testCases.ts uses this to tell the LLM exactly which concepts it must reason about from
 *  first principles, rather than silently falling back to just the generic floor for them. */
export function unmatchedConcepts(concepts: string[]): string[] {
  return concepts.filter(c => !ALIASES[norm(c)]);
}

/** Checklist titles, normalized, to their category id — the first thing normalizeCategory tries. */
const TITLE_TO_CATEGORY: Record<string, CategoryId> = Object.fromEntries(
  [...Object.values(STRATEGY).flat(), ...GENERIC].map(c => [norm(c.title), c.category])
);

/**
 * Coerce whatever the model wrote into a CategoryId. Never throws and never returns
 * undefined — a label the pipeline can't parse must not be able to fail a whole run, since
 * toTestCases validates the entire array at once and would reject every case alongside it.
 *
 * Order matters: "invalid" contains "valid", so the negative families are tested first.
 */
export function normalizeCategory(raw: string | undefined): CategoryId {
  const n = norm(String(raw ?? "").replace(/[_-]+/g, " "));
  if (!n) return "functional-other";
  if ((CATEGORY_IDS as readonly string[]).includes(n.replace(/\s+/g, "-"))) {
    return n.replace(/\s+/g, "-") as CategoryId;
  }
  const byTitle = TITLE_TO_CATEGORY[n];
  if (byTitle) return byTitle;
  if (/xss|cross.?site|script/.test(n)) return "security-xss";
  if (/inject|sqli|\bsql\b|csrf|traversal|exploit|vulnerab|security/.test(n)) return "security-injection";
  if (/empty|blank|boundary|required|missing|max|min|length|limit/.test(n)) return "empty-boundary";
  if (/invalid|malformed|incorrect|wrong|mismatch|weak|duplicate|existing|expired|bad /.test(n)) return "invalid-input";
  if (/state|change|add |remove|delete|update|persist/.test(n)) return "state-change";
  if (/valid|success|happy|correct|end.?to.?end/.test(n)) return "valid";
  return "functional-other";
}

/**
 * Classify a user prompt into a test-type scope using keyword heuristics.
 * Returns ALL_SCOPES when no scope signal is present (full taxonomy = no filtering).
 *
 * Matched on STEMS, not whole words. The previous `\b(functional|functionalit)\b` could not
 * match "functionality" at all — the trailing "y" blocks the closing word boundary — so
 * "test the login and signup functionality" classified as BOTH scopes and the run produced
 * SQL-injection and XSS cases nobody asked for.
 */
export function classifyScope(prompt: string): ScopeFilter[] {
  const p = norm(prompt);
  const wantsSecurity = /\bsecurit|\binject|\bsql\b|\bxss\b|\bvulnerab|\bexploit|\bpenetrat/.test(p);
  const wantsFunctional = /\bfunctional|\bjust check|\bverify that|does .+ work|\bsmoke\b|\bhappy path/.test(p);
  if (wantsSecurity && !wantsFunctional) return ["security"];
  if (wantsFunctional && !wantsSecurity) return ["functional"];
  return ALL_SCOPES;
}

/** Filter test cases to those whose category scope is in `scope`. The fromPrompt case is
 *  always kept — it's what the user literally asked for. Every category now resolves through
 *  normalizeCategory, so an unrecognised label can no longer smuggle a security case into a
 *  functional-only run. */
export function filterByScope<T extends { category?: string; fromPrompt?: boolean }>(cases: T[], scope: ScopeFilter[]): T[] {
  return cases.filter(c => c.fromPrompt || scope.includes(scopeOf(normalizeCategory(c.category))));
}

// Covered by tests/strategy.test.ts (`npm test`).
