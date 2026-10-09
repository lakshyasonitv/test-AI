/**
 * Salesforce login check — DELIBERATE STUB.
 *
 * This file exists to land a CONTRACT, not behaviour. `checkSalesforceLogin` always answers
 * "not implemented"; nothing in the server calls it yet. It is here so the Salesforce org-settings
 * work (the "Check" button on an org connection) can be built against a fixed signature while the
 * login itself is written in parallel.
 *
 * WHO FILLS IT IN: the Salesforce org-connections stream — the work that turns this into a real
 * headless login. Until then, callers must treat `{ ok: false, reason: "unknown" }` as a normal
 * answer and render `detail`, never as an error to retry.
 *
 * THE SIGNATURE IS A CONTRACT. Another stream builds against these exact types: the function name,
 * the `opts` fields and their optionality, every `SalesforceLoginResult` field, and every member of
 * `LoginFailureReason` (a caller may switch on it exhaustively, so ADDING a member is a change too).
 * Changing any of it requires telling that stream first — not after the type error shows up on
 * their branch.
 *
 * For whoever implements it:
 *   - The login is TWO screens: the password field does not exist in the DOM until the username has
 *     been submitted. Filling both up front fails.
 *   - `password` and `totpSecret` are real credentials. They stay in process memory for the length
 *     of one check — never in `detail`, never in a log line, never on disk or under runs/, which is
 *     served over HTTP (CLAUDE.md platform rule 5, TECH_DEBT.md TD-14).
 *   - A `page.evaluate` callback must not contain inner named functions — tsx injects a `__name`
 *     helper the browser does not have, and only a real `npm run serve` run shows it (TD-40).
 */

export type LoginFailureReason =
  | "bad-credentials" | "verification-required" | "mfa-required"
  | "not-found" | "timeout" | "unknown";

export interface SalesforceLoginResult {
  ok: boolean;
  reason?: LoginFailureReason;
  /** Human-readable, safe to render in a browser. Never contains the password. */
  detail?: string;
  /** Where the browser actually ended up — the evidence for `ok`. */
  landedUrl?: string;
}

export async function checkSalesforceLogin(opts: {
  loginUrl: string;
  username: string;
  password: string;
  totpSecret?: string;
}): Promise<SalesforceLoginResult> {
  return { ok: false, reason: "unknown", detail: "not implemented" };
}
