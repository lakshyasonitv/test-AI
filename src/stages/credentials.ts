import type { Target } from "../schema/ir.js";
import type { TestCase } from "./testCases.js";

export interface Credentials { username: string; password: string }

/**
 * Published test credentials for well-known public demo sites. These are NOT secrets —
 * the sites print them on their own login pages — so it's fine for them to end up in a
 * generated spec. Private/real credentials should instead come from the environment and
 * be emitted as `process.env` references in the spec so they never hit disk (the runs/
 * dir is served publicly). ponytail: built-in map covers the demo now; add the env +
 * secret-reference path when a real login actually needs testing.
 */
const DEMO_CREDS: Record<string, Credentials> = {
  "www.saucedemo.com": { username: "standard_user", password: "secret_sauce" },
  "saucedemo.com": { username: "standard_user", password: "secret_sauce" },
  "the-internet.herokuapp.com": { username: "tomsmith", password: "SuperSecretPassword!" },
};

export function credentialsFor(url: string): Credentials | undefined {
  try { return DEMO_CREDS[new URL(url).hostname]; } catch { return undefined; }
}

/**
 * Which credential (if any) a fill target wants. Login forms don't tag fields as
 * username/password in a machine-readable way — the AppModel just has role "textbox"
 * with a human name — so match on that name. Password is checked first (more specific);
 * the username family is broad. Returns undefined for non-login fields (search boxes,
 * etc.) so their model-generated values are left untouched.
 */
export function credentialForTarget(target: Target | undefined, creds: Credentials): string | undefined {
  const name = (target?.name ?? "").toLowerCase();
  if (!name) return undefined;
  if (/pass/.test(name)) return creds.password;
  if (/user|email|login|account/.test(name)) return creds.username;
  return undefined;
}

/**
 * Returns true if credential substitution should be skipped for this case.
 * Skips for fromPrompt cases and deliberate negative credential test categories.
 */
export function shouldSkipCredentialSubstitution(testCase: TestCase): boolean {
  if (testCase.fromPrompt) return true;
  const cat = testCase.category;
  if (!cat) return false;
  const negativeCategories = new Set([
    "Invalid password",
    "Empty password",
    "Empty identifier",
    "Malformed email",
    "SQL injection in login"
  ]);
  return negativeCategories.has(cat);
}

/** Substitute real credentials into an IR's login fill steps, in place. */
export function applyCredentials(
  steps: { action: string; target?: Target; value?: string }[],
  creds: Credentials,
  testCase?: TestCase
): void {
  if (testCase && shouldSkipCredentialSubstitution(testCase)) return;
  for (const step of steps) {
    if (step.action !== "fill") continue;
    const cred = credentialForTarget(step.target, creds);
    if (cred !== undefined) step.value = cred;
  }
}
