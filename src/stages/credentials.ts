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

/**
 * No built-in demo-account registry. An earlier version hardcoded published demo
 * credentials for a few well-known test sites (saucedemo, the-internet.herokuapp.com);
 * that per-site data is gone so the platform never assumes anything about a given host.
 * A user's own credentials take the `secret: true` path above instead.
 */
export function credentialsFor(_url: string): Credentials | undefined {
  return undefined;
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
export function redactCredentials<T>(value: T, creds?: Credentials): T {
  if (!creds?.secret) return value;
  const secrets = [creds.password, creds.username].filter((s) => s && s.length >= 4);
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
  const wording = [
    testCase.title, testCase.expected, testCase.intent ?? "", ...(testCase.steps ?? []),
  ].join(" ");

  // Veto first, and deliberately before the password pattern below: a malformed-email case is
  // routinely worded "Login with invalid email and valid password", which matches BOTH. Getting
  // this order wrong would overwrite the deliberately-broken identifier with the real one —
  // the same class of bug, one category over.
  if (IDENTIFIER_AT_FAULT.test(wording)) return "none";
  const category = testCase.category ?? "";
  if (category === "empty-boundary" || category.startsWith("security-")) return "none";

  if (NEGATIVE_CATEGORY.has(category)) {
    // A real account with the wrong password is the stronger test: it proves an actual account
    // is protected, where a nonexistent user only proves unknown identifiers are rejected —
    // often an entirely different code path.
    return PASSWORD_AT_FAULT.test(wording) ? "identifier-only" : "none";
  }

  // The user's own literal values in the prompt win over anything supplied separately.
  if (testCase.fromPrompt) return promptHasCredentials ? "none" : "full";
  return category === "valid" ? "full" : "none";
}

/** Does this case receive any substitution at all? Thin wrapper over the policy. */
export function wantsRealCredentials(testCase: TestCase, promptHasCredentials: boolean): boolean {
  return credentialPolicyFor(testCase, promptHasCredentials) !== "none";
}

const REGISTRATION_URL = /register|signup|sign-up|create-account|join/i;

/** For each credential kind, the index of its LAST fill step in this list that would actually
 *  be substituted — registration-leg fills (per `legUrlAt`) are excluded from consideration, so
 *  "last occurrence" can't land on a leg that's skipped for an unrelated reason and accidentally
 *  suppress substitution on BOTH the real login leg and the doomed registration leg.
 *
 *  A case with only one login attempt (the overwhelming majority) has exactly one eligible entry
 *  per kind, so this changes nothing for them — "last occurrence" and "only occurrence" coincide.
 *  A case with two attempts (a compound valid+invalid flow, e.g. "log in with the wrong password,
 *  verify the error, then log in for real") is the one this exists for: only the FINAL attempt
 *  should receive the real credential — earlier attempts are load-bearing test content (the
 *  case's own deliberately-wrong values) and must survive untouched, or the earlier attempt
 *  silently stops testing what its wording says. */
export function lastFillIndexByKind(
  steps: { action: string; target?: Target }[],
  fieldMap?: Map<string, CredentialKind>,
  legUrlAt?: (string | null | undefined)[],
): Map<CredentialKind, number> {
  const last = new Map<CredentialKind, number>();
  steps.forEach((step, i) => {
    if (step.action !== "fill") return;
    if (legUrlAt && REGISTRATION_URL.test(legUrlAt[i] ?? "")) return;
    const kind = credentialKindForTarget(step.target, fieldMap);
    if (kind) last.set(kind, i);
  });
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
