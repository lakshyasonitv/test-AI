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
export interface Category { title: string; priority: "critical" | "high" | "medium" | "low"; intent: string; }

const STRATEGY: Record<string, Category[]> = {
  login: [
    { title: "Valid credentials",       priority: "high",     intent: "log in with valid credentials; expect to reach the authenticated area / dashboard" },
    { title: "Invalid password",        priority: "high",     intent: "valid identifier + wrong password; expect an error and staying logged out" },
    { title: "Empty identifier",        priority: "medium",   intent: "submit with the email/username field blank; expect a validation error" },
    { title: "Empty password",          priority: "medium",   intent: "submit with the password field blank; expect a validation error" },
    { title: "Malformed email",         priority: "low",      intent: "an email without '@'; expect a format validation error" },
    { title: "SQL injection in login",  priority: "critical", intent: "enter ' OR '1'='1 as the identifier; expect rejection, no authentication bypass" },
  ],
  signup: [
    { title: "Valid registration",      priority: "high",     intent: "register with valid, unique details; expect success/confirmation" },
    { title: "Existing account",        priority: "high",     intent: "register with an email that already exists; expect a 'already registered' error" },
    { title: "Password mismatch",       priority: "medium",   intent: "confirm-password differs from password; expect a mismatch error" },
    { title: "Weak password",           priority: "medium",   intent: "a too-short/weak password; expect a strength/validation error" },
    { title: "Empty required fields",   priority: "medium",   intent: "submit with required fields blank; expect validation errors" },
  ],
  search: [
    { title: "Valid query",             priority: "high",     intent: "search a term expected to have results; expect relevant results shown" },
    { title: "No-results query",        priority: "medium",   intent: "search gibberish unlikely to match; expect an empty/'no results' state, not an error" },
    { title: "Empty query",             priority: "low",      intent: "submit search with no input; expect it handled gracefully" },
    { title: "Special characters",      priority: "medium",   intent: "search with <script> / SQL-ish characters; expect them handled safely, no injection" },
  ],
  checkout: [
    { title: "Complete a purchase",     priority: "high",     intent: "add an item and complete checkout with valid details; expect an order confirmation" },
    { title: "Empty cart checkout",     priority: "medium",   intent: "attempt checkout with an empty cart; expect it blocked or an empty-cart message" },
    { title: "Missing shipping info",   priority: "medium",   intent: "submit checkout with required address fields blank; expect validation errors" },
    { title: "Invalid card",            priority: "high",     intent: "enter an invalid/expired card number; expect a payment error, order not placed" },
  ],
  cart: [
    { title: "Add item to cart",        priority: "high",     intent: "add an item; expect the cart count/contents to update" },
    { title: "Remove item from cart",   priority: "medium",   intent: "remove an item from the cart; expect it to disappear and totals to update" },
  ],
  contact: [
    { title: "Valid submission",        priority: "medium",   intent: "fill the form with valid values and submit; expect a success/thank-you state" },
    { title: "Empty required fields",   priority: "medium",   intent: "submit with required fields blank; expect validation errors" },
    { title: "Malformed email",         priority: "low",      intent: "an email without '@'; expect a format validation error" },
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
  { title: "Submit with all required fields empty", priority: "medium", intent: "submit the primary form with required fields blank; expect validation, not a silent success" },
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

// One runnable check: node --import tsx src/kb/testStrategy.ts
if (process.argv[1]?.replace(/\\/g, "/").endsWith("src/kb/testStrategy.ts")) {
  const login = strategyFor(["Sign In"]);
  if (!login.some(c => /sql injection/i.test(c.title))) throw new Error("FAIL: 'Sign In' should alias to login and include the injection case");
  if (login.length < 6) throw new Error(`FAIL: expected a real login suite, got ${login.length}`);
  const generic = strategyFor(["Totally Unknown Concept"]);
  if (generic.length !== GENERIC.length) throw new Error("FAIL: an unknown concept should fall back to exactly the generic floor");
  const deduped = strategyFor(["Login", "Sign In"]); // same concept twice → no dupes
  if (deduped.length !== login.length) throw new Error("FAIL: duplicate concepts must not duplicate categories");
  console.log(`OK: login suite = ${login.length} categories, generic floor = ${generic.length}, dedupe holds`);
}
