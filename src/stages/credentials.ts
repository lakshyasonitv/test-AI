import type { Target } from "../schema/ir.js";
import type { TestCase } from "./testCases.js";
import type { AppModel } from "../schema/appModel.js";

export interface Credentials {
  username: string;
  password: string;
  /** True for credentials the USER supplied for their own site. These must never reach disk:
   *  runs/ is served publicly (server/index.ts), and both 04-ir.json and generated.spec.ts
   *  live there. applyCredentials writes an env reference instead of the literal for these,
   *  and executor.ts injects the real value into the test's child process at run time. */
  secret?: boolean;
}




// ---------------------------------------------------------------------------
// Field matching — one source of truth for "does this field want a credential"
// ---------------------------------------------------------------------------

export type CredentialKind = "username" | "password";

// Password is checked first (more specific); the identifier family is broad. Login forms
// don't tag fields machine-readably — the AppModel just has role "textbox" with a human
// name — so this matches on that name.
const PASSWORD_NAME = /pass/i;
const USERNAME_NAME = /user|email|login|account/i;

const normKey = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * Identifying strings (placeholder / name / label / id) → which credential that field wants,
 * derived from the DOM's own input types instead of guessed from a human-readable name.
 *
 * Why this exists: a login form with no <label> and no name attribute gives its inputs an
 * accessible name taken from the PLACEHOLDER. Seen in a real run —
 *   role=textbox name='you@thinkvibes.com'   (the placeholder)
 *   role=textbox name='*********'            (the placeholder)
 * Neither matches the name patterns below ("*********" contains no letters at all), so the
 * user's supplied credentials were silently ignored and the model's invented account was typed
 * instead. The answer was already in the same app model — inputType email / password — and
 * simply wasn't being read.
 */
export function credentialFieldMap(appModel: AppModel): Map<string, CredentialKind> {
  const map = new Map<string, CredentialKind>();
  const add = (field: { name?: string; placeholder?: string; label?: string; id?: string },
               kind: CredentialKind) => {
    for (const s of [field.placeholder, field.name, field.label, field.id]) {
      const k = normKey(s ?? "");
      // First writer wins: a password field's own strings must never be relabelled by a
      // later field that happens to share a placeholder.
      //
      // Known limitation: this is one flat map across every page and form in the model. Once
      // live-extend has added a register page alongside the login page, a placeholder both
      // share (say "you@example.com") is claimed by whichever page was walked first. The
      // per-step REGISTRATION_URL guard in applyCredentials still blocks substitution on the
      // register leg, so the blast radius is contained — but if a login field ever resolves to
      // the wrong kind, this merge is where to look.
      if (k && !map.has(k)) map.set(k, kind);
    }
  };

  for (const page of appModel.pages) {
    for (const form of page.forms ?? []) {
      const fields = form.fields ?? [];
      fields.forEach((f, i) => {
        const type = (f.inputType ?? "").toLowerCase();
        if (type === "password") return add(f, "password");
        if (type === "email") return add(f, "username");
        // A text field immediately before a password field is the identifier — that's how
        // login forms are built, and it's the only thing that catches an unlabelled
        // type="text" username box. Best-effort: it can only be joined back to an IR target
        // if this field carries at least one identifying string the target also uses.
        const next = (fields[i + 1]?.inputType ?? "").toLowerCase();
        if (next === "password" && (type === "text" || type === "" || type === "tel")) {
          add(f, "username");
        }
      });
    }
  }
  return map;
}

/** Which credential a fill target wants, or undefined for a non-login field (a search box,
 *  a "Full Name") whose model-generated value should be left alone.
 *
 *  Consults the DOM-derived map first, then falls back to matching the accessible name —
 *  which still carries sites whose fields are properly labelled "username"/"password", and
 *  sites where DOM discovery found no forms at all. */
export function credentialKindForTarget(
  target: Target | undefined,
  fieldMap?: Map<string, CredentialKind>,
): CredentialKind | undefined {
  if (fieldMap?.size) {
    // Target carries placeholder/label directly as well as the accessible name, and any of
    // them can be the string the DOM field was keyed by. `#id`/`[data-x]` css selectors are
    // stripped to their bare value so an id-keyed field still matches.
    for (const s of [target?.name, target?.placeholder, target?.label, target?.css, target?.testId]) {
      const hit = s && fieldMap.get(normKey(String(s).replace(/^#/, "")));
      if (hit) return hit;
    }
  }
  const name = target?.name ?? "";
  if (!name) return undefined;
  if (PASSWORD_NAME.test(name)) return "password";
  if (USERNAME_NAME.test(name)) return "username";
  return undefined;
}

/** The literal credential a fill target wants. Used by liveExtend's in-process replay,
 *  which never writes what it types to disk.
 *
 *  `policy` mirrors the skip `applyCredentials` already applies to the static-substitution
 *  path: under "identifier-only" the case's own deliberately-wrong password must survive a
 *  live replay too, or grounding logs in successfully and has nothing to correct against. */
export function credentialForTarget(
  target: Target | undefined,
  creds: Credentials,
  fieldMap?: Map<string, CredentialKind>,
  policy: CredentialPolicy = "full",
): string | undefined {
  const kind = credentialKindForTarget(target, fieldMap);
  if (!kind) return undefined;
  if (policy === "identifier-only" && kind === "password") return undefined;
  return creds[kind];
}

// ---------------------------------------------------------------------------
// Does this run need credentials it doesn't have?
// ---------------------------------------------------------------------------

// Roles that can actually be typed into. Without this the identifier pattern above matches
// a BUTTON named "Login" and every site with a login link looks like it needs credentials.
const FILLABLE_ROLE = /textbox|searchbox|combobox/i;
// Auth-shaped wording, used for the indirect signal below.
const AUTH_WORDING = /\b(log ?in|logged ?in|sign ?in|sign ?up|signup|register|authenticat\w*|credential|password)\b/i;

/**
 * The credential fields this run will have to fill but has no values for. Empty means don't
 * interrupt the user.
 *
 * Two signals, because one isn't enough. Discovery models the ENTRY page, so a site whose
 * login form lives behind a "Log in" link (the common SPA shape — verified against a real
 * run whose entry page had zero textboxes) shows no password field at all at this point:
 *
 *  1. DIRECT — a fillable field named like a password/identifier was actually discovered.
 *  2. INTENT — nothing discovered yet, but the test cases are about authentication AND the
 *     entry page offers a way in (a login/sign-up link or button). The form is one click
 *     away and toIR will reach it via live-extend, at which point it needs real values.
 *
 * Always returns both kinds when it returns anything: a login form needs an identifier and
 * a password together, and asking for half of a pair is a worse experience than asking once.
 */
export function credentialFieldsNeeded(appModel: AppModel, cases: TestCase[]): CredentialKind[] {
  const both: CredentialKind[] = ["username", "password"];

  const elements = appModel.pages.flatMap((p) => p.elements);
  const fillable = elements.filter((e) => FILLABLE_ROLE.test(e.role));
  if (fillable.some((e) => PASSWORD_NAME.test(e.name))) return both;

  // A DOM-discovered <input type="password"> is the strongest signal there is — it survives
  // a field with no label at all, which the name patterns above cannot see.
  if (appModel.pages.some((p) => (p.forms ?? []).some((f) =>
    (f.fields ?? []).some((fld) => fld.inputType === "password")))) return both;

  const authCase = cases.some((c) =>
    AUTH_WORDING.test(c.title) || AUTH_WORDING.test(c.expected) ||
    AUTH_WORDING.test(c.category ?? "") || c.steps.some((s) => AUTH_WORDING.test(s))
  );
  const wayIn = elements.some((e) =>
    /link|button/i.test(e.role) && /\b(log ?in|sign ?in|sign ?up|signup|register)\b/i.test(e.name)
  );
  return authCase && wayIn ? both : [];
}

/**
 * True when the prompt already carries credentials, so asking for them again would be
 * redundant.
 *
 * The hard part is telling "my password is hunter2" from "check the password field is
 * masked" — both are the keyword followed by a word. Two signals, neither of which a mere
 * mention satisfies: an explicit `:`/`=` separator, or a following token that looks like a
 * value (quoted, or containing a digit or symbol) rather than an English noun.
 *
 * Errs toward asking. An all-letters password ("password secretpass") is missed, which costs
 * one dialog the user dismisses with Skip — far cheaper than suppressing the prompt on a run
 * that genuinely needed it and then failing at the login.
 */
export function promptCarriesCredentials(prompt: string): boolean {
  const KEY = String.raw`\b(?:pass(?:word)?|pwd)\b`;
  if (new RegExp(KEY + String.raw`\s*[:=]\s*\S`, "i").test(prompt)) return true;
  return new RegExp(KEY + String.raw`\s+(?:is\s+)?["'\x60]?[^\s"'\x60]*[\d!@#$%^&*_.+-]`, "i").test(prompt);
}

/**
 * What can sit between a key and its value. A dash is included because people write
 * "email - 'a@b.com'" constantly, and `[:=]?` silently captured the dash ITSELF as the value.
 * A dash must be surrounded by whitespace so a hyphenated word ("email-address") isn't read as
 * a key/value pair.
 */
const KEY_VALUE_SEP = String.raw`\s*[:=]\s*|\s+is\s+|\s+[-–—]\s+`;

/**
 * The value that follows `keyPattern`, chosen from EVERY occurrence rather than the first.
 *
 * Taking the first match is the bug this replaced. `.match()` is leftmost-first, so a trigger
 * word appearing in ordinary prose wins over the real labelled value later in the sentence:
 * "check the add user flow, email: 'a@b.com'" extracted username "flow", because "user" in
 * "add user flow" matched before "email:" was ever reached. That is the same failure already
 * recorded for the word "login" (see extractCredentialsFromPrompt below) — dropping the
 * trigger word fixed it there, but "user" cannot be dropped: it is how people write usernames.
 *
 * So rank instead of dropping. A quoted value is the strongest signal that this is a real
 * key/value pair, an explicit separator the next strongest, a bare space the weakest — and
 * prose almost never carries either marker. First occurrence wins ties, so behaviour is
 * unchanged whenever only one candidate exists.
 */
function extractValueAfter(prompt: string, keyPattern: string): string | undefined {
  const re = new RegExp(
    `${keyPattern}(?:(${KEY_VALUE_SEP})|\\s+)(?:["'\`]([^"'\`]+)["'\`]|(\\S+))`,
    "gi",
  );

  let best: string | undefined;
  let bestScore = -1;
  for (const m of prompt.matchAll(re)) {
    const [, sep, quoted, bare] = m;
    const val = (quoted ?? bare)?.trim()?.replace(/[,.;:]+$/, "");
    if (!val) continue;
    const score = (quoted !== undefined ? 2 : 0) + (sep !== undefined ? 1 : 0);
    if (score > bestScore) { best = val; bestScore = score; }
  }
  return best;
}

/**
 * Pull real, user-supplied credentials directly out of the prompt text — e.g. "login using
 * email: alice@example.com and password is 'hunter2'". Returns undefined unless BOTH an
 * identifier and a password are found: a half-extracted credential (e.g. password only) would
 * silently substitute an empty username somewhere, which is worse than substituting nothing.
 *
 * Always `secret: true` — a value the user typed directly into the prompt is exactly as
 * sensitive as one typed into the credential-prompt UI, and gets the same env-var-reference
 * treatment (never written to disk literally; see ENV_VALUE_PREFIX below).
 */
export function extractCredentialsFromPrompt(prompt: string): Credentials | undefined {
  // Deliberately NOT "login" — it's commonly a verb in casual phrasing ("login to the
  // website using...") that appears well before the actual "email:"/"username:" field the
  // value follows, so including it as a trigger word grabbed the wrong next token entirely.
  const username = extractValueAfter(prompt, String.raw`\b(?:e-?mail|user(?:\s*name)?)\b`);
  const password = extractValueAfter(prompt, String.raw`\b(?:pass(?:word)?|pwd)\b`);
  if (!username || !password) return undefined;
  return { username, password, secret: true };
}

// ---------------------------------------------------------------------------
// Keeping user-supplied credentials off disk
// ---------------------------------------------------------------------------

// A step's `value` normally holds the literal string to type, and that value is written to
// 04-ir.json and quoted into generated.spec.ts — both under runs/, which the server exposes
// as static files. For the user's OWN credentials that would publish their password. This
// sentinel means "read this from the environment at run time" instead: generator.ts emits a
// process.env reference, executor.ts puts the real value in the child process's env, and
// nothing in between ever holds the literal.
const ENV_VALUE_PREFIX = "${env:";
const ENV_VALUE_SUFFIX = "}";

/** The only env var names generator.ts will reference — a fixed pair, never derived from LLM
 *  or user text, so splicing them into generated code can't turn into arbitrary env reads. */
const ENV_VAR: Record<CredentialKind, "TEST_USERNAME" | "TEST_PASSWORD"> = {
  username: "TEST_USERNAME",
  password: "TEST_PASSWORD",
};
export type CredentialEnvVar = (typeof ENV_VAR)[CredentialKind];

/** The sentinel for a credential kind, so a step's value can be an env reference rather than
 *  the literal. Exported for `ir.ts`'s login prefix, which sets these directly instead of going
 *  through `applyCredentials` — that path re-derives which box is the password from the model,
 *  and the model is empty of forms on exactly the SPA logins the prefix exists to handle. */
export function envValueRef(kind: CredentialKind): string {
  return ENV_VALUE_PREFIX + ENV_VAR[kind] + ENV_VALUE_SUFFIX;
}

/** Returns the env var name if `value` is an env-reference sentinel, else null. Only the two
 *  known names are accepted, so a crafted prompt can't smuggle another variable through. */
export function isEnvValueRef(value: string | undefined): CredentialEnvVar | null {
  if (!value?.startsWith(ENV_VALUE_PREFIX) || !value.endsWith(ENV_VALUE_SUFFIX)) return null;
  const name = value.slice(ENV_VALUE_PREFIX.length, -ENV_VALUE_SUFFIX.length);
  return name === "TEST_USERNAME" || name === "TEST_PASSWORD" ? name : null;
}

/** The env vars to inject into the Playwright child process — empty unless the run has
 *  secret credentials, and harmless to pass either way (an unset var no spec references is
 *  a no-op). */
export function credentialEnvVars(creds?: Credentials): Partial<Record<CredentialEnvVar, string>> {
  if (!creds?.secret) return {};
  return { TEST_USERNAME: creds.username, TEST_PASSWORD: creds.password };
}

/**
 * The credentials the environment already holds, if any — the reverse of `credentialEnvVars`.
 *
 * A saved case's login steps carry `${env:TEST_USERNAME}` / `${env:TEST_PASSWORD}` rather than
 * literals (see ENV_VALUE_PREFIX). Those names ARE the contract, so reading them back belongs
 * here beside the writer rather than at a call site that would have to restate them.
 *
 * `secret: true` unconditionally: a value the operator put in the environment for their own site
 * is exactly as sensitive as one typed into the prompt, and must get the same never-to-disk
 * treatment. BOTH must be present — half a credential cannot authenticate, and returning it would
 * type an empty string into the other box and fail slower than not trying.
 */
export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): Credentials | undefined {
  const username = env.TEST_USERNAME;
  const password = env.TEST_PASSWORD;
  if (!username || !password) return undefined;
  return { username, password, secret: true };
}

/**
 * Which credential kinds a step list will actually need typed into it.
 *
 * Deliberately NOT a guess from field names — the steps say so themselves. `applyCredentials`
 * already rewrote every login fill to the `${env:...}` sentinel when the case was authored, so a
 * step whose value is that sentinel is a field that was filled with a real credential and will
 * need one again. Anything else is an ordinary fill whose literal value is the test.
 *
 * That precision is what lets `/estimate` promise "this will ask you to sign in" cheaply and
 * correctly, without opening a browser to find out.
 */
export function credentialKindsNeeded(steps: { value?: string }[]): CredentialKind[] {
  const kinds = new Set<CredentialKind>();
  for (const step of steps) {
    const envVar = isEnvValueRef(step.value);
    if (envVar === "TEST_USERNAME") kinds.add("username");
    if (envVar === "TEST_PASSWORD") kinds.add("password");
  }
  // A login form wants both together; asking for half a pair is a worse experience than asking
  // once, and matches what credentialFieldsNeeded already does for a run.
  return kinds.size ? ["username", "password"] : [];
}

/** Stand-in written wherever a secret credential would otherwise have been recorded. */
export const REDACTED = "[redacted]";

/**
 * Strip a run's secret credentials out of anything derived from a live replay.
 *
 * The replay has to type the REAL values into a real browser — you cannot log in with a
 * placeholder. Everything it produces afterwards is therefore contaminated: the page text it
 * captures and the page model it builds both come from a page the user is now logged into,
 * and sites routinely echo the identifier back ("Signed in as you@example.com"). That output
 * flows to two publicly-served places — the shared cache under runs/_cache and the
 * updatedAppModel embedded in 04-ir.json — and also into the next LLM prompt.
 *
 * Redacting at the single point where replay output is produced covers every one of those
 * sinks at once, and keeps covering them if another is added later. Only meaningful for
 * `secret` credentials — there is no built-in demo-account registry anymore.
 * Values shorter than 4 characters are left alone — replacing a 1-2 character string would
 * shred unrelated text for no benefit.
 */
/**
 * Tokens that mean something to a DOM, so replacing them destroys structure instead of
 * protecting anything.
 *
 * Real case (run 2026-08-22T04-18-57-530Z-040dd5ae): the user's password was the literal string
 * `password`. Blind replacement turned `inputType: "password"` into `"[redacted]"`, `id:
 * "password"` into `"[redacted]"`, and `css: "#password"` into `"#[redacted]"` — 8 structural
 * replacements. Downstream, credentialFieldMap could no longer find a password field and the
 * generator emitted `#[redacted]`, a selector matching nothing.
 *
 * Skipping these is not a weakening: a value that appears verbatim across ordinary markup was
 * never concealed by redacting it, so the trade is "no confidentiality gained" against "model
 * destroyed". Deliberately a value-level guard rather than a key-aware object walk —
 * redactCredentials is also called on RAW STRINGS (executor.ts scrubs final-page.txt and the
 * error-context files through it), and a key-aware walk finds no keys in a string, which would
 * silently stop scrubbing those files.
 */
const DOM_KEYWORDS = new Set([
  "password", "email", "text", "user", "username", "login", "signin", "submit",
  "button", "search", "form", "hidden", "admin", "input", "name", "value", "checkbox",
]);

export function redactCredentials<T>(value: T, creds?: Credentials): T {
  if (!creds?.secret) return value;
  const secrets = [creds.password, creds.username]
    .filter((s) => s && s.length >= 4 && !DOM_KEYWORDS.has(s.toLowerCase()));
  if (!secrets.length) return value;
  let json = JSON.stringify(value);
  if (json === undefined) return value;
  for (const secret of secrets) json = json.split(JSON.stringify(secret).slice(1, -1)).join(REDACTED);
  return JSON.parse(json) as T;
}

/**
 * Taxonomy categories (from kb/testStrategy.ts) whose whole point is that the action must
 * FAIL. Substituting working credentials into these would defeat the case; asserting a
 * success message in these is the inverted-assertion bug. Shared by both checks.
 */
export const NEGATIVE_CATEGORIES = new Set([
  "Invalid password",
  "Empty password",
  "Empty identifier",
  "Malformed email",
  "SQL injection in login",
  "Empty required fields",
  "Password mismatch",
  "Weak password",
  "Existing account",
  "Invalid card",
  "Missing shipping info",
  "Empty cart checkout",
  "Empty query",
  "Special characters",
  "Submit with all required fields empty",
]);

/**
 * Does this case mean to authenticate as a genuine user?
 *
 * OPT-IN, deliberately. The old rule was opt-out — substitute into every credential-shaped
 * field unless the case's category appeared in a hardcoded blocklist — and a blocklist over
 * model-authored strings can only leak. It did: a case labelled "Security - SQL Injection"
 * matched nothing, so its `' OR '1'='1` payload was overwritten with the user's real email and
 * the test stopped injecting anything at all.
 *
 * Default is NO. The cost of not substituting is a test that types an invented placeholder,
 * which is what happened before credentials existed. The cost of substituting wrongly is a test
 * that silently stops testing what its title says — strictly worse, because it still reports
 * "passed".
 */
export type CredentialPolicy =
  /** Substitute both fields — the case is meant to authenticate successfully. */
  | "full"
  /** Substitute the identifier only; the case's own deliberately-wrong password stands. */
  | "identifier-only"
  /** Touch nothing. The values the case chose ARE the test. */
  | "none";

/** Categories whose whole point is that the input is wrong. */
const NEGATIVE_CATEGORY = new Set([
  "invalid-input", "empty-boundary", "security-injection", "security-xss",
]);

// The identifier is itself the thing under test — a malformed/empty/invalid email or username.
// Its value must survive untouched, so this VETOES substitution outright.
const IDENTIFIER_AT_FAULT =
  /\b(?:e-?mail|username|user name|identifier|login id)\b[^.]{0,40}?\b(?:invalid|malformed|empty|blank|missing|format|incorrect|wrong)\b|\b(?:invalid|malformed|empty|blank|missing|bad)\b[^.]{0,25}?\b(?:e-?mail|username|identifier)\b/i;

// The PASSWORD is the wrong thing — the classic "valid user, bad password" test.
const PASSWORD_AT_FAULT = /\b(?:invalid|incorrect|wrong|bad)\s+(?:password|credential)/i;

/**
 * How much of the supplied credentials this case may receive.
 *
 * A boolean could not express what a good negative login test needs, and the ordering here IS
 * the bug this replaced: `fromPrompt` used to be checked FIRST and short-circuited, so a case
 * that was both the literal translation of the user's request AND a negative test ("log in with
 * invalid credentials") received working credentials, logged in successfully, and then failed
 * its own assertion. The negative checks now run before anything else.
 *
 * Default is "none". Substituting where we shouldn't silently guts the test while it still
 * reports a verdict; not substituting merely leaves the model's invented value in place.
 */
export function credentialPolicyFor(
  testCase: TestCase, promptHasCredentials: boolean,
): CredentialPolicy {
  // Tested per FIELD, not joined into one string (TECH_DEBT.md D3). A joined string let a
  // trigger word in one field and a fault word in a different, unrelated field bridge together
  // through IDENTIFIER_AT_FAULT/PASSWORD_AT_FAULT's "any character but a period" gaps —
  // reproduced directly: title "Log in with valid email and password" + step "Verify no fields
  // are missing before login" wrongly vetoed a genuine happy-path case. Testing each field on
  // its own still catches a fault that's fully contained within one field.
  const fields = [
    testCase.title, testCase.expected, testCase.intent ?? "", ...(testCase.steps ?? []),
  ];
  const matchesAny = (re: RegExp) => fields.some((f) => re.test(f));

  // Veto first, and deliberately before the password pattern below: a malformed-email case is
  // routinely worded "Login with invalid email and valid password", which matches BOTH. Getting
  // this order wrong would overwrite the deliberately-broken identifier with the real one —
  // the same class of bug, one category over.
  if (matchesAny(IDENTIFIER_AT_FAULT)) return "none";
  const category = testCase.category ?? "";
  if (category === "empty-boundary" || category.startsWith("security-")) return "none";

  if (NEGATIVE_CATEGORY.has(category)) {
    // A real account with the wrong password is the stronger test: it proves an actual account
    // is protected, where a nonexistent user only proves unknown identifiers are rejected —
    // often an entirely different code path.
    return matchesAny(PASSWORD_AT_FAULT) ? "identifier-only" : "none";
  }

  // A prompt-derived case always gets "full" now — even when promptHasCredentials is true.
  // The old assumption here was "the model already copied the user's literal value into the
  // case text, so don't bother substituting" — but that's exactly the case that was failing:
  // the model routinely invents a placeholder (e.g. admin@learnvibes.com) instead of faithfully
  // copying the real value. extractCredentialsFromPrompt now supplies the actual verified value
  // as runCreds, so always substituting is strictly safer: if the model WAS faithful this is a
  // no-op (identical value in, identical value out); if it wasn't, this is the only thing that
  // fixes it.
  if (testCase.fromPrompt) return "full";
  return category === "valid" ? "full" : "none";
}

/** Does this case receive any substitution at all? Thin wrapper over the policy. */
export function wantsRealCredentials(testCase: TestCase, promptHasCredentials: boolean): boolean {
  return credentialPolicyFor(testCase, promptHasCredentials) !== "none";
}

const REGISTRATION_URL = /register|signup|sign-up|create-account|join/i;

/** For each credential kind, the index of its fill step in this list that would actually
 *  be substituted.
 *
 *  When a password field is present, the login form is the form containing the LAST password
 *  fill step (handling compound valid+invalid attempts), and the paired username field is the
 *  username fill step immediately associated with that password field. Post-login fields
 *  (e.g. Email in an Add User or Checkout form) that appear after the login form are excluded. */
export function lastFillIndexByKind(
  steps: { action: string; target?: Target }[],
  fieldMap?: Map<string, CredentialKind>,
  legUrlAt?: (string | null | undefined)[],
): Map<CredentialKind, number> {
  const last = new Map<CredentialKind, number>();

  const fillInfos: { index: number; kind: CredentialKind }[] = [];
  steps.forEach((step, i) => {
    if (step.action !== "fill") return;
    if (legUrlAt && REGISTRATION_URL.test(legUrlAt[i] ?? "")) return;
    const kind = credentialKindForTarget(step.target, fieldMap);
    if (kind) {
      fillInfos.push({ index: i, kind });
    }
  });

  const lastPasswordInfo = [...fillInfos].reverse().find((f) => f.kind === "password");

  if (lastPasswordInfo) {
    last.set("password", lastPasswordInfo.index);
    // Paired username field: closest username fill step at or before (or immediately adjacent to)
    // the last password field.
    const pairedUsername = [...fillInfos]
      .filter((f) => f.kind === "username" && f.index <= lastPasswordInfo.index + 2)
      .pop();
    if (pairedUsername) {
      last.set("username", pairedUsername.index);
    }
  } else {
    // Fallback if no password field was identified
    const lastUsername = [...fillInfos].reverse().find((f) => f.kind === "username");
    if (lastUsername) last.set("username", lastUsername.index);
  }

  return last;
}

/** Substitute credentials into an IR's login fill steps, in place. Secret (user-supplied)
 *  credentials become env references rather than literals — see ENV_VALUE_PREFIX above.
 *
 *  `legUrlAt[i]` is the URL the flow is on entering step i (see trackPages in ir.ts). It's what
 *  makes this decision PER STEP rather than per case, which matters because a single case can
 *  do both: the run that prompted this was one "account creation and authentication" case whose
 *  register leg must keep its invented values while its login leg needs the real ones. */
export function applyCredentials(
  steps: { action: string; target?: Target; value?: string }[],
  creds: Credentials,
  policy: CredentialPolicy = "full",
  legUrlAt?: (string | null | undefined)[],
  fieldMap?: Map<string, CredentialKind>,
): void {
  if (policy === "none") return;
  const lastOfKind = lastFillIndexByKind(steps, fieldMap, legUrlAt);
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (step.action !== "fill") continue;
    const kind = credentialKindForTarget(step.target, fieldMap);
    if (!kind) continue;
    // Never sign a user up with their own login credentials, whatever the case-level intent.
    if (legUrlAt && REGISTRATION_URL.test(legUrlAt[i] ?? "")) continue;
    // A repeated attempt at the same credential kind that ISN'T the last one is an earlier,
    // deliberately-different login attempt (e.g. the wrong-password half of a compound case) —
    // leave it as the model authored it.
    if (lastOfKind.get(kind) !== i) continue;
    // The point of identifier-only: a real account, a deliberately wrong password. Overwriting
    // the password here would turn the negative test into a successful login.
    if (policy === "identifier-only" && kind === "password") continue;
    step.value = creds.secret
      ? ENV_VALUE_PREFIX + ENV_VAR[kind] + ENV_VALUE_SUFFIX
      : creds[kind];
  }
}

// ---------------------------------------------------------------------------
// Compound-login-case detection — deterministic backstop for testCases.ts's prompt rule
// ---------------------------------------------------------------------------

// Quote delimiter kept flexible — LLM output occasionally uses "double" or `backtick` quoting
// instead of the 'single' quotes the testCases.ts system-prompt example models. Same flexible
// class as extractValueAfter's own quote handling above, for the identical reason.
const FILL_TARGET = /\bfill\b\s*["'`]([^"'`]+)["'`]/i;
const CLICK_TARGET = /\bclick\b\s+(?:the\s+)?["'`]([^"'`]+)["'`]/i;

/**
 * Does this case combine a deliberately-wrong login attempt with a genuinely-valid one? The
 * signal is structural, not name-based: a real production case (learnvibes.vercel.app) has an
 * unlabelled password field whose accessible name is the masked placeholder '*********' — no
 * literal word "password" anywhere in its steps, so a name-keyed check misses it entirely. The
 * reliable signal is the SAME quoted fill-target filled twice and the SAME quoted click-target
 * clicked twice in one case, gated by AUTH_WORDING so a legitimate two-fill "change password"
 * flow (old password + new password, ONE submit) doesn't false-positive.
 */
export function looksLikeCompoundLoginCase(
  testCase: Pick<TestCase, "title" | "expected" | "category" | "steps">,
): boolean {
  const text = [
    testCase.title, testCase.expected, testCase.category ?? "", ...(testCase.steps ?? []),
  ].join(" ");
  if (!AUTH_WORDING.test(text)) return false;

  const fillCounts = new Map<string, number>();
  const clickCounts = new Map<string, number>();
  for (const step of testCase.steps ?? []) {
    const fill = step.match(FILL_TARGET);
    if (fill) fillCounts.set(fill[1], (fillCounts.get(fill[1]) ?? 0) + 1);
    const click = step.match(CLICK_TARGET);
    if (click) clickCounts.set(click[1], (clickCounts.get(click[1]) ?? 0) + 1);
  }
  return [...fillCounts.values()].some((n) => n >= 2) && [...clickCounts.values()].some((n) => n >= 2);
}
