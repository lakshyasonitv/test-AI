import type { Target } from "../schema/ir.js";
import type { TestCase } from "./testCases.js";

export interface Credentials {
  username: string;
  password: string;
  confirmPassword?: string;
}

const DEMO_CREDS: Record<string, Credentials> = {
  "www.saucedemo.com": { username: "standard_user", password: "secret_sauce" },
  "saucedemo.com": { username: "standard_user", password: "secret_sauce" },
  "the-internet.herokuapp.com": { username: "tomsmith", password: "SuperSecretPassword!" },
};

export function credentialsFor(url: string): Credentials | undefined {
  try { return DEMO_CREDS[new URL(url).hostname]; } catch { return undefined; }
}

/**
 * True if a field's name LOOKS like a password field even without the literal word
 * "password" in it — covers sites where discovery captured a masked placeholder
 * (dots/bullets/asterisks) as the field's accessible name instead of a real label
 * (seen in practice: name === "*********").
 */
function looksLikeMaskedPassword(name: string): boolean {
  return /^[*•●]{4,}$/.test(name);
}

/**
 * Which credential (if any) a fill target wants, based on its name alone. Returns
 * undefined when the name gives no signal — callers (applyCredentials) fall back to
 * sequence-based reasoning in that case, since a single field in isolation sometimes
 * carries no usable text (e.g. an email field whose "name" is just an example address
 * like "you@thinkvibes.com", which contains no literal "email"/"user" substring).
 */
export function credentialForTarget(target: Target | undefined, creds: Credentials): string | undefined {
  const name = (target?.name ?? "").toLowerCase();
  if (!name) return undefined;
  if (/confirm/.test(name) && (/pass(word)?|pwd/.test(name) || looksLikeMaskedPassword(target!.name!))) {
    return creds.confirmPassword ?? creds.password;
  }
  if (/pass(word)?|pwd/.test(name) || looksLikeMaskedPassword(target!.name!)) return creds.password;
  if (/user(name)?|e[-]?mail|login|identifier|account/.test(name)) return creds.username;
  return undefined;
}

/** Categories representing deliberate negative-credential test cases — substitution
 * must always skip these, regardless of where the credentials came from, since these
 * cases intentionally carry wrong/malformed values as the whole point of the test. */
const NEGATIVE_CREDENTIAL_CATEGORIES = new Set([
  "Invalid password",
  "Empty password",
  "Empty identifier",
  "Malformed email",
  "SQL injection in login",
]);

/**
 * Used when credentials came from the automatic demo-site lookup (credentialsFor).
 * Skips negative-test categories AND fromPrompt cases — a fromPrompt case carries the
 * user's own literal values on purpose, so silently swapping in demo credentials would
 * test something different than what was actually asked.
 */
export function shouldSkipCredentialSubstitution(testCase: TestCase): boolean {
  if (testCase.fromPrompt) return true;
  const cat = testCase.category;
  return cat ? NEGATIVE_CREDENTIAL_CATEGORIES.has(cat) : false;
}

/**
 * Used when credentials came from an EXPLICIT user submission (the needs_input /
 * pause-and-ask form). Still skips deliberate negative-test categories, but NOT
 * fromPrompt cases — when the user is filling in exactly the data their own prompt's
 * case needed (e.g. they asked to test login and then supplied real login credentials
 * when asked), substitution should proceed rather than being blocked.
 */
export function shouldSkipNegativeCredentialCategory(testCase: TestCase): boolean {
  const cat = testCase.category;
  return cat ? NEGATIVE_CREDENTIAL_CATEGORIES.has(cat) : false;
}

/**
 * Substitute real credentials into an IR's login/signup fill steps, in place.
 *
 * `explicitlySupplied` distinguishes where `creds` came from:
 *  - true  -> creds came from the user's needs_input form submission. Only negative-
 *             test categories are skipped; fromPrompt cases DO get substituted, since
 *             the user is supplying exactly the data that case needed.
 *  - false (default) -> creds came from the automatic demo-site lookup. The broader
 *             shouldSkipCredentialSubstitution check applies (also skips fromPrompt).
 *
 * Two passes for the actual substitution:
 *  1. Name-based — credentialForTarget matches on keywords or a masked-password shape.
 *  2. Positional fallback — any "fill" step that pass 1 couldn't classify, but that sits
 *     immediately before a step pass 1 DID classify as a password, is assumed to be the
 *     identifier field (username/email) for that same form. This covers fields whose
 *     accessible name is an opaque example value (e.g. "you@thinkvibes.com") with no
 *     matchable keyword at all — common on forms with no real <label>, only a
 *     placeholder captured as the name.
 */
export function applyCredentials(
  steps: { action: string; target?: Target; value?: string }[],
  creds: Credentials,
  testCase?: TestCase,
  explicitlySupplied: boolean = false
): void {
  if (testCase) {
    const shouldSkip = explicitlySupplied
      ? shouldSkipNegativeCredentialCategory(testCase)
      : shouldSkipCredentialSubstitution(testCase);
    if (shouldSkip) return;
  }

  const fillIndices = steps
    .map((s, i) => (s.action === "fill" ? i : -1))
    .filter(i => i !== -1);

  const resolved = new Map<number, string>(); // step index -> value to set

  // Pass 1: name-based matching.
  for (const i of fillIndices) {
    const cred = credentialForTarget(steps[i].target, creds);
    if (cred !== undefined) resolved.set(i, cred);
  }

  // Pass 2: positional fallback for unmatched fields sitting right before a
  // password-classified field — treat as the identifier (username/email).
  for (let k = 0; k < fillIndices.length; k++) {
    const i = fillIndices[k];
    if (resolved.has(i)) continue;
    const next = fillIndices[k + 1];
    if (next !== undefined && resolved.get(next) === creds.password) {
      resolved.set(i, creds.username);
    }
  }

  for (const [i, value] of resolved) {
    steps[i].value = value;
  }
}