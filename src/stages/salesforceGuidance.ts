/**
 * Salesforce-specific guidance appended to the planner, test-case and IR system prompts when the
 * person ticked "This URL is a Salesforce org" (`currentRunTargetApp()`, D-50).
 *
 * WHAT THIS IS, AND IS NOT. `CLAUDE.md`'s central rule: an LLM instruction is a preference, not a
 * constraint. Everything below is a preference. Where a rule has a deterministic check behind it
 * the comment next to it names that check, so a reader can tell what is enforced from what is only
 * asked for. Where there is none, that is said too — those lines are advice and can be ignored by
 * the model without anything noticing.
 *
 * NULL MEANS UNCHANGED. For any run that is not a Salesforce run `salesforceGuidance()` returns
 * the empty string, so each stage's system prompt — and therefore its LLM cache key, which hashes
 * the prompt text — is byte-identical to what it was before this file existed.
 * `tests/fixtures/salesforceTarget/null-run-prompts.json` pins that against a capture taken from
 * the code BEFORE this change.
 *
 * NO SITE-SPECIFIC VALUES. Nothing here names an org, a user, a record or a credential
 * (`CLAUDE.md` "Don't": a real password once shipped inside a few-shot example). Salesforce's own
 * standard wording ("Complete this field.", "was created") is product text, not org data.
 *
 * NOT VERIFIED AGAINST A LIVE ORG. This is general knowledge of Lightning Experience written
 * without access to one. Page layouts, apps and tab names differ per org and per profile — which is
 * why the rules keep sending the model back to the application model rather than to remembered
 * Salesforce names.
 */
import { currentRunTargetApp } from "../runTarget.js";

export type GuidanceStage = "plan" | "cases" | "ir";

const HEADER = `

SALESFORCE ORG — this run targets a Salesforce org (production, sandbox, Developer Edition or scratch org), not an ordinary website. Everything above still applies; the rules below ADD to it and never override it. The application model is still the only source of element names: Salesforce knowledge tells you what to expect, the model tells you what is actually there.`;

const PLAN = `${HEADER}

Salesforce planning rules:
- LOGIN IS OFTEN TWO SCREENS: a username screen, then a password screen. When the request describes that, or the first screen shows only a username, plan them as separate ordered steps ("Enter the username and continue", "Enter the password and sign in") rather than one "Log in" step. Discovery records the login itself; the plan only has to describe the intent. (Backed by: the two-screen login recording, D-45/D-46.)
- After a successful login the org usually moves to a DIFFERENT host (the Lightning Experience domain). That is the same application, not a redirect off-site. (Backed by: related hosts recorded from the observed login, D-47.)
- Never plan a step that needs a code sent by email or SMS, an authenticator app, or any other verification. That cannot be automated; a run that reaches one is reported as blocked, and planning around it only produces a test that cannot pass. (Backed by: the verification-required outcome in checkSalesforceLogin.)
- Reach apps and objects the way a user does: "Open the App Launcher", "Open the Sales app", "Open the Accounts tab". Never plan "go to /lightning/o/Account/list" or any typed route. (Backed by: the navigate-URL guard — a navigate step to a path that is not in the application model is rejected and the IR is cut there, TD-82.)
- Stay on what the request names. Do not add Setup, user or permission management, data import/export or deleting records unless the request asks for them.`;

const CASES = `${HEADER}

Salesforce test-case rules:
- Use only objects, tabs, apps and fields that appear in the application model. Page layouts, apps and visible fields differ per org and per user profile; a field that is not in the model must not be tested, and a record or value that exists in someone's org but not in the model must not be assumed. (Backed by: IR grounding — a step that names an element the model does not contain is rejected.)
- The usual record flows, when the model shows them: open the object's tab (a list view), create a record with "New" (a form opens in a modal dialog), fill the required fields, Save; edit an existing record the test created; Cancel out of the form. Cover the negative paths too: leaving a required field empty (Salesforce shows "Complete this field." under the field and keeps the form open), an invalid email or phone format, an invalid date.
- Salesforce confirms a save with a toast whose text contains "was created" or "was saved". A case may expect it, worded as "a confirmation that the record was created", never as a guessed record name.
- Data safety. The org may be production. Create records freely, but only edit or delete records the test itself created; never modify, merge or delete data that was already there, and never run mass actions. Give created records an obviously test-like name taken from the request.
- Do NOT write cases that need a second user, another profile or permission set, email or SMS verification, an authenticator code, a file or data import, or a sandbox refresh. Do not write cases about Setup unless the request asks: many Setup pages render inside frames and in other domains.
- Do not write a case just for logging in unless the request asks for one; login is handled once, before the cases run.`;

const IR = `${HEADER}

Salesforce IR rules:
- A create or edit form opens in a MODAL DIALOG. Its fields and its Save and Cancel buttons are inside the dialog; target the dialog's own controls from the application model (when discovery saw the dialog open they carry pageSection "dialog" and containerRole "dialog", plus containerName when the dialog has a name), not a same-named control on the page behind it. After clicking a button that opens the dialog, add a "wait" step of 500 before filling. (Backed by: the generated spec and the live resolver both look inside an open dialog first, TD-72; and the live walker tags elements inside open dialogs, across shadow roots.)
- A picklist field is a combobox. Use action "select" with the option text; the generated spec opens the list and clicks the option. A LOOKUP field also looks like a combobox: you may "fill" the text, but the suggestions that appear are not in the application model, so do NOT invent a click on one — end the case before choosing a suggestion unless the suggestion is in the model. (Backed by: grounding rejects an action on an element the model does not contain.)
- Reach apps and objects by CLICKING. The App Launcher is a button in the header that opens a dialog with a search box and app tiles; the object tabs are links in the navigation bar. Never "navigate" to a /lightning/... path unless that exact path is in the application model. (Backed by: the navigate-URL guard, TD-82.)
- Lightning loads asynchronously. After a click that opens a page, tab or dialog, add a "wait" step of 500 before the next action on it.
- Success after Save must be FALSE before and TRUE after. Prefer asserting that the dialog's Save button is now "hidden" (the dialog closed). If the case's expected result names a confirmation, you may assert target { "text": "was created" } or { "text": "was saved" } with the "visible" assertion — Salesforce's own toast wording, never a record name you cannot see. (Backed by: the vacuous-assertion check.)
- A required-field case ends with the form STILL OPEN: assert that the dialog's Save button is still "visible", or target { "text": "Complete this field." } — Salesforce's standard message. Do not assert that a record was created. (Backed by: the existing negative-path rules above.)
- "New", "Edit" and "Save" appear more than once on a Lightning page (page header, related lists, the dialog). Disambiguate by containerRole/containerName and "nth" exactly as the selector rules above say.
- Never use a record ID (a 15 or 18 character code), a copied URL or a value you saw only in the user's description of the org.
- If the page shows an identity-verification or "verify your identity" screen, the case cannot continue: end it there rather than guessing a code.`;

const BY_STAGE: Record<GuidanceStage, string> = { plan: PLAN, cases: CASES, ir: IR };

/** Exposed for tests; callers use `salesforceGuidance`. */
export const SALESFORCE_GUIDANCE = BY_STAGE;

/**
 * The text to append to `stage`'s system prompt: the Salesforce rules when this run's target app is
 * Salesforce, otherwise "" — so a non-Salesforce run's prompt is untouched.
 */
export function salesforceGuidance(stage: GuidanceStage): string {
  return currentRunTargetApp() === "salesforce" ? BY_STAGE[stage] : "";
}
