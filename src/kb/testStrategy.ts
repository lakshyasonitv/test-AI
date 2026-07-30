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
export interface Category { title: string; priority: "critical" | "high" | "medium" | "low"; intent: string; scope: TestCategory; }

const STRATEGY: Record<string, Category[]> = {
  login: [
    { title: "Valid credentials",       priority: "high",     intent: "log in with valid credentials; expect to reach the authenticated area / dashboard", scope: "functional" },
    { title: "Invalid password",        priority: "high",     intent: "valid identifier + wrong password; expect an error and staying logged out", scope: "functional" },
    { title: "Empty identifier",        priority: "medium",   intent: "submit with the email/username field blank; expect a validation error", scope: "functional" },
    { title: "Empty password",          priority: "medium",   intent: "submit with the password field blank; expect a validation error", scope: "functional" },
    { title: "Malformed email",         priority: "low",      intent: "an email without '@'; expect a format validation error", scope: "functional" },
    { title: "SQL injection in login",  priority: "critical", intent: "enter ' OR '1'='1 as the identifier; expect rejection, no authentication bypass", scope: "security" },
  ],
  signup: [
    { title: "Valid registration",      priority: "high",     intent: "register with valid, unique details; expect success/confirmation", scope: "functional" },
    { title: "Existing account",        priority: "high",     intent: "register with an email that already exists; expect a 'already registered' error", scope: "functional" },
    { title: "Password mismatch",       priority: "medium",   intent: "confirm-password differs from password; expect a mismatch error", scope: "functional" },
    { title: "Weak password",           priority: "medium",   intent: "a too-short/weak password; expect a strength/validation error", scope: "functional" },
    { title: "Empty required fields",   priority: "medium",   intent: "submit with required fields blank; expect validation errors", scope: "functional" },
  ],
  search: [
    { title: "Valid query",             priority: "high",     intent: "search a term expected to have results; expect relevant results shown", scope: "functional" },
    { title: "No-results query",        priority: "medium",   intent: "search gibberish unlikely to match; expect an empty/'no results' state, not an error", scope: "functional" },
    { title: "Empty query",             priority: "low",      intent: "submit search with no input; expect it handled gracefully", scope: "functional" },
    { title: "Special characters",      priority: "medium",   intent: "search with <script> / SQL-ish characters; expect them handled safely, no injection", scope: "security" },
  ],
  checkout: [
    { title: "Complete a purchase",     priority: "high",     intent: "add an item and complete checkout with valid details; expect an order confirmation", scope: "functional" },
    { title: "Empty cart checkout",     priority: "medium",   intent: "attempt checkout with an empty cart; expect it blocked or an empty-cart message", scope: "functional" },
    { title: "Missing shipping info",   priority: "medium",   intent: "submit checkout with required address fields blank; expect validation errors", scope: "functional" },
    { title: "Invalid card",            priority: "high",     intent: "enter an invalid/expired card number; expect a payment error, order not placed", scope: "functional" },
  ],
  cart: [
    { title: "Add item to cart",        priority: "high",     intent: "add an item; expect the cart count/contents to update", scope: "functional" },
    { title: "Remove item from cart",   priority: "medium",   intent: "remove an item from the cart; expect it to disappear and totals to update", scope: "functional" },
  ],
  contact: [
    { title: "Valid submission",        priority: "medium",   intent: "fill the form with valid values and submit; expect a success/thank-you state", scope: "functional" },
    { title: "Empty required fields",   priority: "medium",   intent: "submit with required fields blank; expect validation errors", scope: "functional" },
    { title: "Malformed email",         priority: "low",      intent: "an email without '@'; expect a format validation error", scope: "functional" },
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
  { title: "Submit with all required fields empty", priority: "medium", intent: "submit the primary form with required fields blank; expect validation, not a silent success", scope: "functional" },
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

/** Classify a user prompt into a test-type scope using keyword heuristics.
 *  Returns ALL_SCOPES when no scope signal is present (full taxonomy = no filtering). */
export function classifyScope(prompt: string): ScopeFilter[] {
  const p = norm(prompt);
  const wantsSecurity = /\b(security|inject|sql|xss|vulnerab|exploit|penetrat)\b/.test(p);
  const wantsFunctional = /\b(functional|functionalit|just check|verify that|does .+ work|smoke|happy path)\b/.test(p);
  if (wantsSecurity && !wantsFunctional) return ["security"];
  if (wantsFunctional && !wantsSecurity) return ["functional"];
  if (wantsSecurity && wantsFunctional) return ["functional", "security"];
  return ALL_SCOPES;
}

/** Filter a list of test cases to only those whose category scope matches the given scope.
 *  Cases with no category are kept (they can't be classified, so default to included).
 *  The fromPrompt case is always kept regardless of scope. */
export function filterByScope<T extends { category?: string; fromPrompt?: boolean }>(cases: T[], scope: ScopeFilter[]): T[] {
  return cases.filter(c => {
    if (c.fromPrompt) return true;
    if (!c.category) return true;
    const cat = ALL_CATEGORIES.find(sc => sc.title === c.category);
    return cat ? scope.includes(cat.scope) : true;
  });
}

/** Flat list of all defined categories with their scope, for lookup by title. */
const ALL_CATEGORIES: Category[] = Object.values(STRATEGY).flat().concat(GENERIC);

// Covered by tests/strategy.test.ts (`npm test`).
