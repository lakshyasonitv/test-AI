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
import { currentFrontdoor, recordRef, recordRefIndex, recordRefObject } from "./salesforceFrontdoor.js";
import { hasRunToken, lineKey, shownNumber } from "../text.js";
import { requestedActions } from "./testData.js";
import { requestValues } from "./requestValues.js";
import type { IR as IRSteps, Step } from "../schema/ir.js";
import type { SalesforceOrgModel } from "../schema/appModel.js";

export type GuidanceStage = "plan" | "cases" | "ir";

/**
 * HOW AN OBJECT IS REACHED depends on how the run signed in. A password run's model holds only the
 * pages a crawl found, so a typed /lightning path is a guess and the guard rejects it: route by
 * clicking. An org-connection run (D-63) models each object's create form at /lightning/o/<Object>/new
 * and is already signed in, so the URL is the grounded route and a login step is impossible —
 * run 2026-10-24T11-34-49-878Z-a7697ccd lost all three cases inside the App Launcher by following
 * the click rules. Backed by: createFormUrls in discovery, and the navigate-URL guard (TD-82).
 */
const ROUTE = {
  click: {
    plan: `- Reach apps and objects the way a user does: "Open the App Launcher", "Open the Sales app", "Open the Accounts tab". Never plan "go to /lightning/o/Account/list" or any typed route. (Backed by: the navigate-URL guard — a navigate step to a path that is not in the application model is rejected and the IR is cut there, TD-82.)`,
    cases: `- The usual record flows, when the model shows them: open the object's tab (a list view), create a record with "New" (a form opens in a modal dialog), fill the required fields, Save; edit an existing record the test created; Cancel out of the form.`,
    ir: `- Reach apps and objects by CLICKING. The App Launcher is a button in the header that opens a dialog with a search box and app tiles; the object tabs are links in the navigation bar. Never "navigate" to a /lightning/... path unless that exact path is in the application model. (Backed by: the navigate-URL guard, TD-82.)`,
  },
  url: {
    plan: `- The run is ALREADY SIGNED IN through its org connection: plan no login, username or password step. Reach an object by its Lightning URL, which the application model holds: its list page at /lightning/o/<Object>/list (or the object's page listed in the model) and its create form at /lightning/o/<Object>/new. Never route through the App Launcher, app tiles or the navigation bar to reach an object. (Backed by: discovery models each create form at that URL; the navigate-URL guard accepts only paths in the model, TD-82.)
- Never plan to pick a record already in the org ("select an Account that has open Deals") — except one the org model lists under "records Testbench ALREADY CREATED", which is made for this test and is the "existing" record the request means: the plan creates every record it needs at its create form, in order (the parent, then each related record with the parent picked in its lookup), then acts on the records it created. (Backed by: deleteOutsideOwnRecord refuses a delete of any record the test did not create — run 2026-11-10T11-57-58-930Z-11aedc91 planned "Select an Account that has open Deals".)`,
    cases: `- The run is already signed in through its org connection: write no login step. The usual record flows: to create a record, open /lightning/o/<Object>/new directly (the form is modelled there, as a modal dialog), fill the required fields, Save; to see records, open the object's list page from the model. Never route through the App Launcher or the navigation bar; edit only a record the test created; Cancel out of the form.
- Stay on the object and the flow the request names: every case is about that object's records (create, its required fields, its validation rules, its picklists). Do not add cases about global search, the App Launcher, the navigation bar, notifications or another object unless the request asks for them; a coverage checklist item that does not fit the requested object is skipped, not stretched to fit.
- A case that creates a record ends its name fields (Last Name, Company, Account Name, a record Name) with the token {{uid}}, e.g. "Smith {{uid}}": the run replaces it with a unique code, so the org's duplicate rules never block a repeat run. Never put {{uid}} in a field a validation rule reads (Phone, Email, Country) and never in an expected result.
- An invalid-FORMAT case only where Salesforce checks a format: Email, Date, Number, Currency and Percent fields, or a field a validation rule reads. A Phone, Text or URL field accepts any text and saves it, so "an invalid phone is rejected" fails against a healthy org (run 2026-10-25T06-38-05-163Z-3a6663ef).
- A create case fills the required fields and the fields a validation rule reads, and no other field unless the request names it. A lookup field (Account Name on a Contact, Parent Account) needs an existing record: leave it alone unless it is required or the request names it. When the request names several objects, write one create case per object, never one case that creates them all: a failure in one object must not hide the others. (Backed by: the test-data pass drops unrequested optional fields and splits nothing — a combined case stays combined, so write them apart.)
- A case never relies on a record already in the org ("an Account known to have open Opportunities") — except one the org model lists under "records Testbench ALREADY CREATED": that one was made for this test, so the case picks it by that exact name and does not create another: it creates what it needs, in order, then acts on it. A rule about related records (a delete blocked while open child records exist, a roll-up) creates the parent, then the child from its own create form with the parent picked in its lookup, using values that make it count (an open Opportunity: a stage that is not Closed), then goes back to the parent and acts. This is the one case that creates several objects. (Backed by: deleteOutsideOwnRecord, which refuses a delete of any record the case did not create — run 2026-11-10T10-20-10-752Z-2c9915e1 ended after its first Save.)`,
    ir: `- The run is already signed in through its org connection: the sign-in step is supplied; write no login, username or password step. Reach a page with "navigate" to a path that is in the application model: /lightning/o/<Object>/new opens the create form as a modal dialog and its fields are in that page's model. Never click through the App Launcher or the navigation bar to reach an object. Create every record, a related one too, through its own create form path, and pick its parent in that form's lookup (an Opportunity "for that Account": /lightning/o/Opportunity/new, Account Name = that Account), never through another record page's actions menu or its "New <Object>" buttons, unless the case says to use that action. (Backed by: the navigate-URL guard, TD-82; run 2026-11-10T06-30-57-251Z-32a03bc8 lost its way in the Account page's "Show more actions" menu.)
- In a flow that creates a record, the "fill" value of each name field (Last Name, Company, Account Name, a record Name) ends with the token {{uid}}, e.g. "Smith {{uid}}"; the spec and the replay replace it with a unique code, so the org's duplicate rules never block a repeat. Never in a field a validation rule reads, never in an assertion: assert "was created", never the record's name. (Backed by: generator valueCode and runStepLive.)
- Fill only the required fields, the fields a validation rule reads, and the fields the case names. Never type into a lookup (a record reference such as Account Name on a Contact) unless the case names a record for it. (Backed by: the test-data pass drops other optional fills.)`,
  },
} as const;
type Route = keyof typeof ROUTE;

const HEADER = `

SALESFORCE ORG — this run targets a Salesforce org (production, sandbox, Developer Edition or scratch org), not an ordinary website. Everything above still applies; the rules below ADD to it and never override it. The application model is still the only source of element names: Salesforce knowledge tells you what to expect, the model tells you what is actually there.`;

const PLAN = (route: Route) => `${HEADER}

Salesforce planning rules:
- LOGIN IS OFTEN TWO SCREENS: a username screen, then a password screen. When the request describes that, or the first screen shows only a username, plan them as separate ordered steps ("Enter the username and continue", "Enter the password and sign in") rather than one "Log in" step. Discovery records the login itself; the plan only has to describe the intent. (Backed by: the two-screen login recording, D-45/D-46.)
- After a successful login the org usually moves to a DIFFERENT host (the Lightning Experience domain). That is the same application, not a redirect off-site. (Backed by: related hosts recorded from the observed login, D-47.)
- Never plan a step that needs a code sent by email or SMS, an authenticator app, or any other verification. That cannot be automated; a run that reaches one is reported as blocked, and planning around it only produces a test that cannot pass. (Backed by: the verification-required outcome in checkSalesforceLogin.)
${ROUTE[route].plan}
- Stay on what the request names. Do not add Setup, user or permission management, data import/export or deleting records unless the request asks for them.`;

const CASES = (route: Route) => `${HEADER}

Salesforce test-case rules:
- Use only objects, tabs, apps and fields that appear in the application model. Page layouts, apps and visible fields differ per org and per user profile; a field that is not in the model must not be tested, and a record or value that exists in someone's org but not in the model must not be assumed. (Backed by: IR grounding — a step that names an element the model does not contain is rejected.)
${ROUTE[route].cases} Cover the negative paths too: leaving a required field empty (Salesforce shows "Complete this field." under the field and keeps the form open), an invalid email or phone format, an invalid date.
- Salesforce confirms a save with a toast whose text contains "was created" or "was saved". A case may expect it, worded as "a confirmation that the record was created", never as a guessed record name.
- A record-triggered flow the org model lists under "automation" runs by itself after a save. When the request is about it (or about the object it runs on and its outcome), write a case that saves a record meeting its "only when" conditions and expects its effect: the field it sets showing the new value on the record page, or the record it creates; and, when the conditions can be broken, a case that saves without them and expects the field unchanged. (No deterministic check.)
- Data safety. The org may be production. Create records freely, but only edit or delete records the test itself created; never modify, merge or delete data that was already there, and never run mass actions. Give created records an obviously test-like name taken from the request.
- Do NOT write cases that need a second user, another profile or permission set, email or SMS verification, an authenticator code, a file or data import, or a sandbox refresh. Do not write cases about Setup unless the request asks: many Setup pages render inside frames and in other domains.
- Do not write a case just for logging in unless the request asks for one; login is handled once, before the cases run.`;

const IR = (route: Route) => `${HEADER}

Salesforce IR rules:
- A create or edit form opens in a MODAL DIALOG. Its fields and its Save and Cancel buttons are inside the dialog; target the dialog's own controls from the application model (when discovery saw the dialog open they carry pageSection "dialog" and containerRole "dialog", plus containerName when the dialog has a name), not a same-named control on the page behind it. After clicking a button that opens the dialog, add a "wait" step of 500 before filling. (Backed by: the generated spec and the live resolver both look inside an open dialog first, TD-72; and the live walker tags elements inside open dialogs, across shadow roots.)
- A picklist field is a combobox. Use action "select" with the option text; the generated spec opens the list and clicks the option. A LOOKUP field also looks like a combobox: you may "fill" the text, but the suggestions that appear are not in the application model, so do NOT invent a click on one — end the case before choosing a suggestion unless the suggestion is in the model. (Backed by: grounding rejects an action on an element the model does not contain.)
${ROUTE[route].ir}
- Lightning loads asynchronously. After a click that opens a page, tab or dialog, add a "wait" step of 500 before the next action on it.
- Success after Save must be FALSE before and TRUE after. End a case that saves with the toast Salesforce shows: target { "text": "was created" } (a new record) or { "text": "was saved" } (an edit) with the "visible" assertion — Salesforce's own toast wording, never a record name you cannot see. An assertion that the dialog's Save button is "hidden" may come before it, not instead of it. (Backed by: the vacuous-assertion check, and strengthenSaveOutcome, which appends the toast when a case ends on the Save button alone.)
- A case whose Save is refused (a required field left empty, a validation rule) ends with the form STILL OPEN and the error Salesforce shows: the validation rule's own message when the case is about a rule, otherwise target { "text": "We hit a snag." } or { "text": "Complete this field." } — Salesforce's standard messages. Do not assert that a record was created. (Backed by: the existing negative-path rules above, and strengthenSaveOutcome, which appends "We hit a snag." when a case ends on the Save button alone.)
- "New", "Edit" and "Save" appear more than once on a Lightning page (page header, related lists, the dialog). Disambiguate by containerRole/containerName and "nth" exactly as the selector rules above say.
- Never use a record ID (a 15 or 18 character code), a copied URL or a value you saw only in the user's description of the org. The one exception is a record type's create form path exactly as the org model lists it (".../new?recordTypeId=..."): that is how one record type's form opens. (Backed by: the navigate guard, which accepts only paths discovery opened.)
- A dependent picklist is enabled only after its controlling field has a value: select the controlling field first, then a dependent value offered under it. (Backed by: the test data pass, which inserts or fixes the controlling step.)
- After a create's Save, Lightning opens the NEW record's page: continue there. Never click a record name you saw on another page (it is someone else's record); to find the new record in a list, use the exact name the case typed. (No deterministic check.)
- Inline edit (the request says inline or pencil): on the record page, open its "Details" tab when the fields are not shown, click the field's pencil button "Edit <Field label>", type the value, click "Save" at the bottom of the details; Salesforce shows "was saved". The page's "Edit" button opens the whole form in a dialog instead — use it when the request does not say inline. (Backed by: strengthenSaveOutcome, which reads "Edit <Field>" as an edit.)
- Path (the stage bar on an Opportunity or a Lead): "Mark Stage as Complete" moves exactly ONE stage forward. To reach a named stage, click that stage on the path (a tab or option named after it), then the button "Mark as Current Stage"; Salesforce shows "Stage changed successfully." Then check the record's Stage field shows it. A stage marked Closed opens a dialog to pick Closed Won or Closed Lost: pick it and click "Save". (No deterministic check.)
- Clone: the record page's "Clone" (in the header or its actions menu, "Show more actions") opens a "New <Object>" dialog filled with the record's values; change the name, Save; Salesforce shows "was created". (Backed by: strengthenSaveOutcome.)
- Delete: only the record THIS case created, from the record page its Save opened: "Delete" (in the header or "Show more actions"), then the confirm dialog's "Delete"; Salesforce shows "was deleted". (Backed by: deleteOutsideOwnRecord, which refuses any other delete before the steps are replayed, and strengthenSaveOutcome.)
- A quick action on a record page ("New Contact", "Log a Call") opens a dialog with its own fields; fill them and Save; a "New ..." action shows "was created". (Backed by: strengthenSaveOutcome.)
- A flow's effect (a field it sets after the save, a record it creates) appears on the new record's page a moment after the toast: add a "wait" of 2000 after the Save, then assert the field by its label and the value the flow sets (as the org model's automation line states it). (No deterministic check.)
- A field the org model lists as "calculated" (formula, roll-up summary) is read-only: never fill it; after the Save, assert it on the record page by its label and, when the value follows from the case's own inputs, the value. (Backed by: the test data pass, which drops any step typing into one.)
- If the page shows an identity-verification or "verify your identity" screen, the case cannot continue: end it there rather than guessing a code.`;

const byStage = (route: Route): Record<GuidanceStage, string> =>
  ({ plan: PLAN(route), cases: CASES(route), ir: IR(route) });

const isSave = (s: Step) => /^save$/i.test(s.target?.name ?? "");
/** A click that changes the record after its Save: the path's "Mark as Current Stage" / "Mark Stage as Complete". */
const isRecordChange = (s: Step) => isSave(s) || /^mark (as current stage|stage as complete)$/i.test(s.target?.name ?? "");

/**
 * Backs the two Save rules above. A case that ends on the dialog's Save button alone ("hidden" =
 * saved, "visible" = refused) passes when the click never registered and never sees the outcome
 * (runs 2026-10-25T12-31-05-389Z-a83f1df1 and -352Z-579a7a86 asserted only that). Append the outcome
 * Salesforce shows — the toast on a save, "We hit a snag." on a refusal — as the final step, where
 * terminal-text grounding checks it on the live page and, on an org in another language, corrects
 * it to the page's own wording. The Save assertion stays; this only adds. Returns a note, or null.
 */
export function strengthenSaveOutcome(ir: IRSteps): string | null {
  const steps = ir.steps;
  // "Press Enter" on a create form never saves it: Enter only picks the open picklist's option
  // (run 2026-11-10T10-17-33-628Z-76c35740 never left the New Case dialog). With no Save click on
  // that form, the form's own Save button replaces the press.
  let onForm = false;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.action === "navigate") onForm = /\/lightning\/o\/[^/?#]+\/new\b/.test(s.target?.url ?? "");
    else if (s.action === "click" && /^(new\b.*|clone|edit\b.*)$/i.test(s.target?.name ?? "")) onForm = true;
    else if (s.action === "click" && isSave(s)) onForm = false;
    else if (onForm && s.action === "press" && /^enter$/i.test(s.value ?? "")) {
      steps[i] = { id: s.id, action: "click", target: { role: "button", name: "Save" } } as Step;
      onForm = false;
    }
  }
  const last = steps[steps.length - 1];
  // A delete ends on its confirm dialog's "Delete"; Salesforce answers '<Object> "<name>" was deleted.'
  let lastClick = -1;
  for (let i = steps.length - 1; i >= 0 && lastClick < 0; i--) if (steps[i].action === "click") lastClick = i;
  if (lastClick >= 0 && /^delete$/i.test(steps[lastClick].target?.name ?? "")
    && !steps.slice(lastClick + 1).some((s) => s.action === "assert" && s.target?.text)) {
    steps.push({ id: "sf-outcome", action: "assert", target: { text: "was deleted" }, assertion: "visible" });
    return `the case ends on a delete -> also asserts Salesforce's "was deleted"`;
  }
  if (last?.action !== "assert" || !isSave(last) || (last.assertion !== "hidden" && last.assertion !== "visible")) return null;
  let saveAt = -1;
  for (let i = steps.length - 2; i >= 0 && saveAt < 0; i--) if (steps[i].action === "click" && isSave(steps[i])) saveAt = i;
  if (saveAt < 0) return null;
  // The case already checks a message after its Save: nothing to add.
  if (steps.slice(saveAt + 1).some((s) => s.action === "assert" && s.target?.text)) return null;
  let text = "We hit a snag.";
  if (last.assertion === "hidden") {
    // What opened the form decides the toast: a create form ("New", "Clone", /lightning/o/<Obj>/new)
    // or an edit ("Edit", or an inline field's pencil "Edit Phone").
    let opener: "created" | "saved" | null = null;
    for (let i = saveAt - 1; i >= 0 && !opener; i--) {
      const s = steps[i];
      if (s.action === "navigate" && /\/lightning\/o\/[^/?#]+\/new\b/.test(s.target?.url ?? "")) opener = "created";
      // "New", "Clone", and a quick action that creates a child ("New Contact").
      else if (s.action === "click" && /^(new\b.*|clone)$/i.test(s.target?.name ?? "")) opener = "created";
      else if (s.action === "click" && /^edit\b/i.test(s.target?.name ?? "")) opener = "saved";
    }
    if (!opener) return null;
    text = `was ${opener}`;
  }
  steps.push({ id: "sf-outcome", action: "assert", target: { text }, assertion: "visible" });
  return `the case ended on the Save button alone ("${last.assertion}") -> also asserts Salesforce's "${text}"`;
}

/**
 * DATA SAFETY: a case may delete only the record it created itself, in the same case, from the
 * record page that create's Save opened. The org may hold real data, and grounding REPLAYS the
 * steps live (liveExtend), so an IR that deletes "the first Account in the list" would delete a
 * real record while the test is still being written. Checked before grounding. Returns why the
 * IR is refused, or null. Refused: a delete with no create-and-Save before it, or one reached by
 * opening another record after that Save (a navigate, or a click on a record link).
 */
export function deleteOutsideOwnRecord(ir: IRSteps): string | null {
  const steps = ir.steps;
  const del = steps.findIndex((s) => s.action === "click" && /^delete\b/i.test(s.target?.name ?? ""));
  if (del < 0) return null;
  let saved = -1;
  let opened = false;
  let form: string | null = null;
  /** Records this case created, per object: what a record reference (`${record:<Obj>:<n>}`) may open. */
  const created = new Map<string, number>();
  for (let i = 0; i < del; i++) {
    const s = steps[i];
    if (s.action === "navigate" && /\/lightning\/o\/[^/?#]+\/new\b/.test(s.target?.url ?? "")) {
      opened = true;
      form = decodeURIComponent(/\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target!.url!)![1]);
    }
    if (s.action === "click" && /^(new\b.*|clone)$/i.test(s.target?.name ?? "")) opened = true;
    if (s.action === "click" && opened && isSave(s)) {
      saved = i;
      if (form) { created.set(form, (created.get(form) ?? 0) + 1); form = null; }
    }
  }
  if (saved < 0) {
    return `Step ${steps[del].id} deletes a record this case did not create. A case may delete only the record it creates itself: create it (its create form, Save), then delete it from the record page that Save opens.`;
  }
  // The one way back allowed: a record reference to a record THIS case created and saved. It resolves
  // at run time to that record's own id, captured from its Save, so it can never reach another record
  // ("create an Account, an Opportunity for it, then delete the Account", run 2026-11-10T06-03-48-658Z-ac13a6f8).
  const ownRecord = (url?: string) => {
    const obj = recordRefObject(url);
    const n = recordRefIndex(url);
    return !!obj && n !== null && n >= 1 && n <= (created.get(obj) ?? 0);
  };
  const away = steps.slice(saved + 1, del).find((s) => (s.action === "navigate" && !ownRecord(s.target?.url))
    || (s.action === "click" && s.target?.role === "link"));
  if (away) {
    return `Step ${away.id} leaves the record this case created before deleting. Delete it from the record page its Save opened (that page's "Delete" or its actions menu), without opening another record.`;
  }
  return null;
}

/**
 * A case that opens one record type's create form proves it did: Lightning titles that form
 * "New <Object>: <Record Type>". Without it a case passed the same way whether the record type's
 * form or the default one opened (run 2026-10-25T15-42-33-878Z-ef392788 asserted only "was
 * created"; the user could not see that TB Partner was used). Inserted right after the navigate
 * and its wait, so it is never the terminal assertion. Returns one note per added step.
 */
export function assertRecordTypeForms(ir: IRSteps, org: SalesforceOrgModel | undefined): string[] {
  const notes: string[] = [];
  let n = 0;
  for (let i = 0; i < ir.steps.length; i++) {
    const s = ir.steps[i];
    const m = s.action === "navigate"
      ? /\/lightning\/o\/([^/?#]+)\/new\?(?:[^#]*&)?recordTypeId=([A-Za-z0-9]{15,18})/.exec(s.target?.url ?? "") : null;
    const o = m ? org?.objects.find((x) => x.api === decodeURIComponent(m[1])) : undefined;
    const rt = o?.recordTypes?.find((r) => r.id === m![2]);
    if (!o || !rt) continue;
    const text = `New ${o.label}: ${rt.name}`;
    let at = i + 1;
    if (ir.steps[at]?.action === "wait") at++;
    if (ir.steps.some((x) => x.action === "assert" && x.target?.text === text)) continue;
    ir.steps.splice(at, 0, { id: `sf-rt-${++n}`, action: "assert", target: { text }, assertion: "visible" });
    notes.push(`the case opens record type "${rt.name}"'s form -> asserts its header "${text}"`);
  }
  return notes;
}

/**
 * Back to a record this case created (Phase A, run 2026-10-26T07-23-21-344Z-9cd29004): after saving an
 * Opportunity for its new Account, the flow went home and clicked a link named as it had typed the
 * Account's name ("Test Account {{uid}}"). No page shows that link (the code is the run's), so the
 * case was cut there. A click on a link named exactly as a run-token value the case typed into an
 * object's create form, after that form's Save, becomes a navigate to that record (`recordRef`: the
 * object, and which of its saved create forms it was), resolved where the step runs. Any object,
 * parent or child, the same object for both included. Not inside a create form not yet saved (its
 * Save would never happen), and not when the flow went looking for it since the last Save (a name
 * typed into a search; or, when the request is about finding it, the object's tab clicked or its list
 * or home page): finding it there may be what the case checks. Returns notes.
 */
/** A request about finding the record in a list or search: the way there is then the test. */
const FINDS_IT = /\b(lists?|listed|search(es|ed)?|finds?|appears?|shows? up)\b/i;

export function returnToCreatedRecords(ir: IRSteps, request = ""): string[] {
  const notes: string[] = [];
  /** The run-token names each saved create form typed (by their words): the form's object, and which
   *  of that object's saved create forms it was (all of them count, named or not, as the spec counts). */
  const created = new Map<string, { object: string; n: number }>();
  const saved = new Map<string, number>();
  let form: string | null = null;
  let typed: string[] = [];
  let lastSave = -1;
  for (let i = 0; i < ir.steps.length; i++) {
    const s = ir.steps[i];
    if (s.action === "navigate") {
      // A create form opens; any other navigate leaves an unsaved one behind.
      const m = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "");
      form = m ? decodeURIComponent(m[1]) : null;
      typed = [];
      continue;
    }
    // A lookup typed with a record's name (the parent's) names that record, not this form's.
    if (s.action === "fill" && form && hasRunToken(s.value) && s.target?.role !== "combobox" && !s.target?.lookup) typed.push(s.value!);
    if (s.action === "click" && isSave(s)) {
      lastSave = i;
      if (!form) continue;
      const n = (saved.get(form) ?? 0) + 1;
      saved.set(form, n);
      // The first form that typed a name owns it: a later one typing it again points at that record.
      for (const v of typed) if (!created.has(lineKey(v))) created.set(lineKey(v), { object: form, n });
      form = null;
      continue;
    }
    if (form) continue;
    const name = s.action === "click" && (!s.target?.role || s.target.role === "link") ? s.target?.name ?? s.target?.text : undefined;
    const rec = name ? created.get(lineKey(name)) : undefined;
    if (!rec) continue;
    const object = rec.object;
    // Tab clicks alone are only the way there unless the request is about finding it (run
    // 2026-11-03T08-39-38-811Z-a28f4ed4: Home, Accounts, then the new Account's link, for a check of
    // its roll-up field); a name typed into a search is always looking.
    const between = ir.steps.slice(lastSave + 1, i);
    const looked = between.some((x) => ["fill", "select", "press"].includes(x.action))
      || FINDS_IT.test(request) && between.some((x) => !["navigate", "wait", "assert"].includes(x.action)
      || (x.action === "navigate" && new RegExp(`/lightning/o/${object}/(list|home)\\b`).test(x.target?.url ?? "")));
    if (looked) continue;
    ir.steps[i] = { id: s.id, action: "navigate", target: { url: recordRef(object, rec.n) } };
    // The way there goes with it: a guessed list URL is rejected by grounding (run
    // 2026-11-03T09-46-16-921Z-04a94b10), and tab clicks are nothing the case checks.
    for (let j = i - 1; j > lastSave; j--) {
      if (ir.steps[j].action !== "navigate" && ir.steps[j].action !== "click") continue;
      ir.steps.splice(j, 1);
      i--;
    }
    notes.push(`${s.id}: clicks "${name}", the name this case typed for the ${object} it created -> opens that ${object} record directly`);
  }
  return notes;
}

/**
 * A value check written without its value, when the request states it: "verify the Account's TB
 * Total Opportunity Amount shows 5,000" gave `text_contains` on "TB Total Opportunity Amount" with no
 * value in 4 of 5 attempts (run 2026-11-03T08-26-40-331Z-684ad8dc), each rejected as vacuous until the
 * check was dropped. The value is the number or quoted text the request puts right after that label
 * ("shows", "is", "=", "of", "displays", "reads"). Only an empty value is filled. Returns notes.
 */
export function valuesFromRequest(ir: IRSteps, request: string): string[] {
  const notes: string[] = [];
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const s of ir.steps) {
    // "Account's TB Total Opportunity Amount" (run 2026-11-03T09-52-32-235Z-e9e0149b): no page shows
    // the object's name with the label, and the org's label is the rest. Value and field checks only:
    // a heading's own words ("Today's Tasks") stay.
    const valueOrField = s.action === "assert" && (s.assertion === "text_contains" || s.assertion === "text_equals" || !!s.target?.field);
    for (const k of ["field", "text", "name"] as const) {
      const v = valueOrField ? s.target?.[k] : undefined;
      const bare = v?.replace(/^[A-Z][\w ]*?['’]s\s+/, "");
      if (v && bare && bare !== v) { s.target![k] = bare; notes.push(`${s.id}: the check on "${v}" -> "${bare}"`); }
    }
    if (s.action !== "assert" || (s.assertion !== "text_contains" && s.assertion !== "text_equals") || s.value?.trim()) continue;
    const label = s.target?.field ?? s.target?.text ?? s.target?.name;
    if (!label?.trim()) continue;
    const m = new RegExp(`${esc(label.trim())}\\s+(?:shows|is|=|equals|displays|reads|of)\\s+(?:"([^"]+)"|'([^']+)'|(\\$?\\d[\\d,]*(?:\\.\\d+)?%?))`, "i").exec(request);
    const value = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
    if (!value) continue;
    s.value = value;
    notes.push(`${s.id}: the check on "${label}" had no value -> "${value}", as the request states it`);
  }
  return notes;
}

/** One flow condition ("AnnualRevenue >= 1000000") against the values a create form typed, by API name.
 *  Undefined when the field was not filled: unknown, so no expectation is drawn from it. */
function conditionHolds(cond: string, valueOf: (api: string) => string | undefined): boolean | undefined {
  const m = /^(\w+)\s+(>=|<=|>|<|=|is not|contains|starts with|is blank)\s*(.*)$/.exec(cond.trim());
  if (!m) return undefined;
  const [, api, op, want] = m;
  const got = valueOf(api);
  if (op === "is blank") return got === undefined || got.trim() === "";
  if (got === undefined) return undefined;
  const num = (s: string) => Number(s.replace(/[$,\s]/g, ""));
  if (op === ">=" || op === "<=" || op === ">" || op === "<") {
    const a = num(got), b = num(want);
    if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
    return op === ">=" ? a >= b : op === "<=" ? a <= b : op === ">" ? a > b : a < b;
  }
  const g = lineKey(got), w = lineKey(want);
  return op === "=" ? g === w : op === "is not" ? g !== w : op === "contains" ? g.includes(w) : g.startsWith(w);
}

/** All of "A >= 1 and B = x" (or any, joined by " or "); undefined when a field it reads is unknown. */
function whenHolds(when: string, valueOf: (api: string) => string | undefined): boolean | undefined {
  const or = / or /.test(when) && !/ and /.test(when);
  const results = when.split(or ? / or / : / and /).map((c) => conditionHolds(c, valueOf));
  if (results.some((r) => r === undefined)) return undefined;
  return or ? results.some(Boolean) : results.every(Boolean);
}

/**
 * Phase B, flow-aware checks: what a record-triggered flow on an object this case created will do, given the
 * values the case typed, becomes a check when no step checks it. A user story ("I want it marked as a hot lead
 * and set to working, with a call task") named no field and no value the checks could be read from, and the
 * case checked only "was created" (run 2026-11-10T10-15-08-973Z-439e90e3).
 *
 * Narrow on purpose: only a flow on an object this case saved; only when every condition it reads (its "only
 * when", the branch's "when") is decided by the values the case typed, so no outcome is ever guessed; the
 * branch taken is the first whose "when" holds, else the default; and only when the request or case talks
 * about the outcome (names the flow, or a value it sets, or the record it creates). Checks: the fields it
 * sets on the record, and a record it creates by its Subject or Name. Placed after the last Save; the record
 * is opened by reference when the flow is elsewhere. Returns notes.
 */
export function flowEffectChecks(ir: IRSteps, org: {
  objects: { api: string; label: string; fields: { label: string; api?: string }[] }[];
  flows?: { label: string; object?: string; type?: string; effects?: string[] }[];
} | undefined, text = ""): string[] {
  const notes: string[] = [];
  if (!org?.flows?.length || !text.trim()) return notes;
  // The values each saved create form typed, by the org's API name; per object, the last saved.
  const saved = new Map<string, { values: Map<string, string>; n: number }>();
  let form: string | null = null;
  let typed = new Map<string, string>();
  for (const s of ir.steps) {
    if (s.action === "navigate") {
      form = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "")?.[1] ?? null;
      typed = new Map();
      continue;
    }
    if (!form) continue;
    if ((s.action === "fill" || s.action === "select") && s.value !== undefined) {
      const o = org.objects.find((x) => x.api === form);
      const name = lineKey(s.target?.name ?? s.target?.label ?? "");
      const f = o?.fields.find((x) => lineKey(x.label) === name || lineKey(`${o.label} ${x.label}`) === name);
      if (f?.api) typed.set(f.api.toLowerCase(), s.value);
    } else if (s.action === "click" && isSave(s)) {
      saved.set(form, { values: typed, n: (saved.get(form)?.n ?? 0) + 1 });
      form = null;
    }
  }
  const talksAbout = (t: string) => mentionsWord(text, t);
  for (const [api, rec] of saved) {
    const o = org.objects.find((x) => x.api === api);
    if (!o) continue;
    const valueOf = (fieldApi: string) => rec.values.get(fieldApi.toLowerCase());
    for (const fl of org.flows.filter((x) => x.object === o.label || x.object === o.api)) {
      const outcome = flowOutcome(o, fl.effects ?? [], valueOf);
      if (!outcome) continue;
      // A checkbox the flow ticks is checked through the API (salesforceOracles.flowSetChecks): a page
      // layout may not show it at all (run 2026-11-10T18-12-48-531Z-ba5c15e9: no Escalated box on the Case).
      const sets = outcome.sets.filter((x) => !/^(true|false)$/.test(x.value));
      const creates = outcome.creates;
      // Only when the request or case is about this outcome.
      const about = talksAbout(fl.label) || sets.some((x) => talksAbout(x.value) || talksAbout(x.label))
        || creates.some((c) => talksAbout(c)) || (creates.length > 0 && /\b(task|case|record)s?\b/i.test(text));
      if (!about) continue;
      const checked = (v: string) => ir.steps.some((s) => s.action === "assert"
        && [s.value, s.target?.text].some((t) => !!t && lineKey(t).includes(lineKey(v))));
      const add: Step[] = [];
      for (const x of sets) if (!checked(x.value)) add.push({ id: `sf-flow-${x.label}`.replace(/\W+/g, "-"), action: "assert", target: { field: x.label }, assertion: "text_contains", value: x.value } as Step);
      for (const c of creates) if (!checked(c)) add.push({ id: `sf-flow-${c}`.replace(/\W+/g, "-").slice(0, 60), action: "assert", target: { text: c }, assertion: "visible" } as Step);
      if (!add.length) continue;
      // After the last Save; on this record (opened by reference when the flow moved on).
      let at = ir.steps.length;
      for (let i = ir.steps.length - 1; i >= 0; i--) if (ir.steps[i].action === "click" && isSave(ir.steps[i])) { at = i + 1; break; }
      while (at < ir.steps.length && (ir.steps[at].action === "wait" || (ir.steps[at].action === "assert" && /\bwas (created|saved)\b/.test(ir.steps[at].target?.text ?? "")))) at++;
      const lastSaved = [...saved.keys()].at(-1);
      if (lastSaved !== api) add.unshift({ id: `sf-open-${api}-flow`, action: "navigate", target: { url: recordRef(api, rec.n) } });
      ir.steps.splice(at, 0, ...add);
      notes.push(`flow "${fl.label}" on the ${o.label} this case created, with the values it typed: checks ${[...sets.map((x) => `${x.label} = ${x.value}`), ...creates.map((c) => `"${c}"`)].join(", ")}`);
    }
  }
  return notes;
}

/**
 * A delete the request aims at one object ("then delete that Account") runs on THAT record. Run
 * 2026-11-10T06-30-57-251Z-32a03bc8 created an Account and an Opportunity for it, the step writer left out
 * "go back to the Account", and the delete ran on the Opportunity page. When the flow is on another
 * record at its delete (the Delete click, or the actions menu right before it), the record of the
 * named object this case saved last is opened first, by its record reference (which resolves only to
 * that record; deleteOutsideOwnRecord allows nothing else). Also: the delete's expected message, when
 * the model added quotes the request does not have, takes the request's wording. Returns notes.
 */
export function deleteNamedRecord(ir: IRSteps, org: { objects: { api: string; label: string }[] } | undefined, request = ""): string[] {
  const notes: string[] = [];
  const steps = ir.steps;
  const del = steps.findIndex((s) => s.action === "click" && /^delete\b/i.test(s.target?.name ?? ""));
  if (del < 0 || !org?.objects.length) return notes;
  // The object the request deletes: "delete (that|the|this|its)? <label>".
  const named = [...org.objects].sort((a, b) => b.label.length - a.label.length)
    .find((o) => new RegExp(`\\bdelet\\w*\\s+(?:that|the|this|its|this same|that same|an?)?\\s*${o.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(request));
  if (named) {
    // Records saved before the delete, per object, and the record the flow is on at the delete.
    const saved = new Map<string, number>();
    let form: string | null = null;
    let on: string | null = null;
    for (let i = 0; i < del; i++) {
      const s = steps[i];
      if (s.action === "navigate") {
        form = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "")?.[1] ?? null;
        on = recordRefObject(s.target?.url) ?? (form ? null : on);
      } else if (s.action === "click" && isSave(s) && form) {
        saved.set(form, (saved.get(form) ?? 0) + 1); on = form; form = null;
      }
    }
    const n = saved.get(named.api);
    if (n && on !== named.api) {
      // Before the actions menu that holds Delete, when it is the click right before it, waits aside: run
      // 2026-11-10T07-41-34-085Z-f4e0523d opened the menu, waited, and the record was opened in between.
      let p = del - 1;
      while (p >= 0 && steps[p].action === "wait") p--;
      const prev = steps[p];
      const at = prev?.action === "click" && /more actions|show actions|^actions$/i.test(prev.target?.name ?? "") ? p : del;
      steps.splice(at, 0, { id: `sf-open-${named.api}`, action: "navigate", target: { url: recordRef(named.api, n) } });
      notes.push(`the request deletes the ${named.label}, and the flow was on another record -> opens the ${named.label} this case created first`);
    }
  }
  // The expected message as the request writes it: no quotes the model added inside it.
  const unquote = (t: string) => t.replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
  for (const s of steps.slice(del)) {
    const t = s.action === "assert" ? s.target?.text : undefined;
    if (!t || !/["“”]/.test(t) || request.includes(t)) continue;
    const plain = unquote(t);
    if (plain && request.includes(plain)) { s.target!.text = plain; notes.push(`${s.id}: "${t}" -> "${plain}", as the request writes it`); }
  }
  return notes;
}

/**
 * Every field value the request asks to CHECK on a record this case created becomes a check, when the
 * steps have none. Run 2026-11-10T05-05-39-201Z-52ce7aed: "verify its Rating shows Hot, its Lead Status
 * shows Working - Contacted, and a Task ... appears": the case only "looked at" the two fields, so the
 * test checked the Task alone and could have passed without them.
 *
 * Narrow on purpose: only picklist fields of an object this case saved, and only a value that is one of
 * that field's options, written right after the field's name in the check part of the request
 * ("<field> shows|is|equals|becomes|displays|reads|changes to|is set to <option>"). The label used is the
 * one the request uses ("Lead Status", the org's "Status"; "Type", the org's "Account Type"). A field
 * two saved objects share is checked only when the request says whose ("the Account's Type"). The check
 * goes at the end; checksOnCreatedRecord opens the record and fieldChecksOnRecordView the Details tab.
 */
export function requestedFieldChecks(ir: IRSteps, org: {
  objects: { api: string; label: string; fields: { label: string; picklist?: string[] }[] }[];
} | undefined, request = ""): string[] {
  const notes: string[] = [];
  if (!org?.objects.length || !request.trim()) return notes;
  const checks = request.slice(requestedActions(request).length);
  if (!checks.trim()) return notes;
  // Objects this case saved, in order; the count says which of them recordRef means.
  const saved = new Map<string, number>();
  let form: string | null = null;
  for (const s of ir.steps) {
    if (s.action === "navigate") form = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "")?.[1] ?? null;
    else if (s.action === "click" && isSave(s) && form) { saved.set(form, (saved.get(form) ?? 0) + 1); form = null; }
  }
  if (!saved.size) return notes;
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const VERB = "(?:shows|show|is set to|is|equals|becomes|displays|reads|changes to|has changed to|=)";
  type Hit = { obj: string; label: string; value: string; owned: boolean; at: number };
  const hits: Hit[] = [];
  for (const o of org.objects.filter((x) => saved.has(x.api))) {
    for (const f of o.fields) {
      if (!f.picklist?.length) continue;
      const short = f.label.replace(/^\S+\s+/, "");
      const names = [...new Set([`${o.label} ${f.label}`, f.label, short])].sort((a, b) => b.length - a.length);
      const values = [...f.picklist].sort((a, b) => b.length - a.length).map(esc).join("|");
      for (const name of names) {
        const re = new RegExp(`(?:\\b(${esc(o.label)})(?:['’]s)?\\s+)?\\b(${esc(name)})\\s+${VERB}\\s+["']?(${values})(?![\\p{L}\\p{N}])`, "iu");
        const m = re.exec(checks);
        if (!m) continue;
        hits.push({ obj: o.api, label: m[2], value: f.picklist.find((p) => p.toLowerCase() === m[3].toLowerCase())!, owned: !!m[1], at: m.index + m[0].indexOf(m[2]) });
        break;
      }
    }
  }
  // The same words matched for two objects ("Type" on Account and Opportunity): only the one named as its owner.
  const byText = new Map<string, Hit[]>();
  for (const h of hits) byText.set(`${h.at}|${h.label.toLowerCase()}`, [...(byText.get(`${h.at}|${h.label.toLowerCase()}`) ?? []), h]);
  const chosen = [...byText.values()].flatMap((hs) => hs.length === 1 ? hs : hs.filter((h) => h.owned).slice(0, 1))
    .sort((a, b) => a.at - b.at);
  // The record the flow is on at each step, and the last Save: a requested check counts only after the
  // flow's last Save, on that object's record. Run 2026-11-10T07-19-49-819Z-0ddc0b02 checked the Account's
  // Type right after the Account's Save, before the Opportunity whose flow sets it, and then again on
  // the Opportunity's page: both checks were in the wrong place.
  const onAt: (string | null)[] = [];
  let lastSave = -1;
  {
    let f: string | null = null;
    let on: string | null = null;
    ir.steps.forEach((s, i) => {
      if (s.action === "navigate") {
        f = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "")?.[1] ?? null;
        on = recordRefObject(s.target?.url) ?? null;
      } else if (s.action === "click" && isRecordChange(s)) {
        lastSave = i;
        if (f) { on = f; f = null; }
      } else if (s.action === "click" && s.target?.role !== "tab" && !f) on = null;
      onAt[i] = on;
    });
  }
  for (const h of chosen) {
    // A check of it: that field showing the value, or the value checked as the whole text. Not a word
    // inside other text: "TB Call new hot lead" is no check that Rating shows "Hot".
    const isCheck = (s: Step) => s.action === "assert" && (
      (!!s.target?.field && lineKey(s.target.field) === lineKey(h.label) && lineKey(s.value ?? "").includes(lineKey(h.value)))
      || [s.value, s.target?.text].some((t) => !!t && lineKey(t) === lineKey(h.value)));
    if (ir.steps.some((s, i) => isCheck(s) && i > lastSave && onAt[i] === h.obj)) continue;
    // Checks of it in the wrong place go: it is checked once, after the last Save, on the right record.
    for (let i = ir.steps.length - 1; i >= 0; i--) {
      if (!isCheck(ir.steps[i])) continue;
      notes.push(`${ir.steps[i].id}: the check of "${h.value}" ran before the last Save or on another record -> moved after the last Save, on the ${h.obj}`);
      ir.steps.splice(i, 1);
      onAt.splice(i, 1);
    }
    // Right after the last Save is confirmed (its waits and "was created" check), so the request's other
    // checks that follow (a related Case "on the Account") run on that record too.
    let at = 0;
    for (let i = ir.steps.length - 1; i >= 0; i--) if (ir.steps[i].action === "click" && isRecordChange(ir.steps[i])) { at = i + 1; break; }
    while (at > 0 && at < ir.steps.length && (ir.steps[at].action === "wait"
      || (ir.steps[at].action === "assert" && /\bwas (created|saved)\b|\bstage changed\b/i.test(ir.steps[at].target?.text ?? "")))) at++;
    if (at === 0) at = ir.steps.length;
    const added: Step[] = [];
    // Opened explicitly unless the flow is already on that record there.
    if (onAt[at - 1] !== h.obj) added.push({ id: `sf-open-${h.obj}-${h.label}`.replace(/\W+/g, "-"), action: "navigate", target: { url: recordRef(h.obj, saved.get(h.obj)!) } });
    added.push({ id: `sf-check-${h.label}`.replace(/\W+/g, "-"), action: "assert", target: { field: h.label }, assertion: "text_contains", value: h.value } as Step);
    ir.steps.splice(at, 0, ...added);
    onAt.splice(at, 0, ...added.map(() => h.obj));
    // The flow's later steps were on the record it was on before; they are on this one now.
    for (let i = at + added.length; i < ir.steps.length && ir.steps[i].action !== "navigate"; i++) onAt[i] = h.obj;
    notes.push(`the request checks "${h.label}" shows "${h.value}" -> checks it on the ${h.obj} this case created, after the last Save`);
  }
  return notes;
}

/**
 * A check of a field of a record THIS case created, made away from that record, opens the record
 * first. Run 2026-11-03T08-18-32-287Z-885b1ba6: after creating an Account and an Opportunity for it,
 * the flow went home, clicked the Accounts tab and looked for "TB Total Opportunity Amount" 5,000 on
 * the Accounts LIST. The field belongs to the Account; the case created one; so the check runs on
 * that record (`recordRef`: the last one of that object it saved). Field label -> object from the org
 * model. Runs before fieldChecksOnRecordView, which then reads it on the Details tab. Returns notes.
 */
export function checksOnCreatedRecord(ir: IRSteps, org: { objects: { api: string; fields: { label: string }[]; calculated?: { label: string }[] }[] } | undefined, request = ""): string[] {
  const notes: string[] = [];
  if (!org?.objects.length) return notes;
  const ownerOf = (label: string) => {
    const owners = org.objects.filter((o) => [...o.fields, ...(o.calculated ?? [])].some((f) => f.label === label));
    return owners.length === 1 ? owners[0].api : undefined;
  };
  const saved = new Map<string, number>();
  let form: string | null = null;
  let onRecord: string | null = null;
  let lastSave = -1;
  for (let i = 0; i < ir.steps.length; i++) {
    const s = ir.steps[i];
    if (s.action === "navigate") {
      const m = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "");
      form = m ? decodeURIComponent(m[1]) : null;
      onRecord = recordRefObject(s.target?.url);
      continue;
    }
    if (s.action === "click" && isSave(s)) {
      lastSave = i;
      if (form) { saved.set(form, (saved.get(form) ?? 0) + 1); onRecord = form; }
      form = null;
      continue;
    }
    // Moving elsewhere (a nav tab, a link) leaves the record; a tab inside the record page does not.
    if (s.action === "click" && s.target?.role !== "tab") { if (!form) onRecord = null; continue; }
    if (s.action !== "assert" || form) continue;
    const valueCheck = (s.assertion === "text_contains" || s.assertion === "text_equals") && !!s.value?.trim();
    const label = s.target?.field ?? (valueCheck ? s.target?.text : undefined);
    const owner = label ? ownerOf(label) : undefined;
    if (!owner || !saved.get(owner) || onRecord === owner) continue;
    // The way the flow went looking (a guessed list URL, run 2026-11-03T09-46-16-921Z-04a94b10; tab
    // clicks) goes, unless finding the record is what the request asks.
    if (!FINDS_IT.test(request)) {
      for (let j = i - 1; j > lastSave; j--) {
        if (ir.steps[j].action !== "navigate" && ir.steps[j].action !== "click") continue;
        ir.steps.splice(j, 1);
        i--;
      }
    }
    ir.steps.splice(i, 0, { id: `sf-open-${owner}`, action: "navigate", target: { url: recordRef(owner, saved.get(owner)!) } });
    notes.push(`the check of "${label}" belongs to the ${owner} this case created -> opens that record first`);
    onRecord = owner;
    i++;
  }
  return notes;
}

/** Roles of an edit control: on a record's view page the same field is read-only text, never one of these. */
const FORM_CONTROL = /^(textbox|combobox|spinbutton|checkbox|searchbox|listbox|radiogroup)$/;
/** A value as a record page shows one: a number, read as the spec reads it ("$5,000.00", "10%"), or a
 *  date ("11/25/2026", a date token). Words with a digit in them ("Zq Children (1)") are not. */
const isShownValue = (text: string) => shownNumber(text) !== null || /^(?:\d{1,4}([./-])\d{1,2}\1\d{1,4}\b|\{\{date:)/.test(text.trim());
/** The field's label (or words of it) written as its value: a check that the label shows, not a value. */
const namesLabel = (value: string, label: string) => ` ${lineKey(label)} `.includes(` ${lineKey(value)} `);
/** The request names this label as whole words ("verify the SLA field" names "SLA"). */
const mentionsWord = (request: string, label: string) => !!lineKey(label) && ` ${lineKey(request)} `.includes(` ${lineKey(label)} `);

/**
 * The one field a bare checked value belongs to: a picklist field that offers it (text and value
 * agree) and that the request names, by its label or by its label without the object's word in
 * front ("Rating" for "Account Rating", the label the record page shows). The label returned is the
 * one the request uses. Undefined when no field, or more than one, fits.
 */
export function pickedValueField(text: string, value: string, fields: { label: string; picklist?: string[] }[], request: string,
  objectLabel = ""): { label: string; value: string } | undefined {
  if (text !== value || !request) return undefined;
  const hits = new Map<string, { label: string; value: string }>();
  for (const f of fields) {
    if (!f.picklist?.includes(value)) continue;
    // The longest name the request uses: "Lead Status" (the object's word + the org's "Status"), the
    // label itself, or the label without the object's word ("Rating" for "Account Rating").
    const short = f.label.replace(/^\S+\s+/, "");
    const label = [objectLabel ? `${objectLabel} ${f.label}` : "", f.label, short !== f.label ? short : ""]
      .find((n) => !!n && mentionsWord(request, n));
    if (label) hits.set(f.label, { label, value });
  }
  return hits.size === 1 ? [...hits.values()][0] : undefined;
}

/**
 * On a record's view page (after a Save lands there with "was created"/"was saved", or after a record
 * this test created is opened again), a check on one of the record's fields is a check on its LABEL
 * on the page's Details tab. The writer grounds it on the create form's input instead
 * (`input[name="SLAExpirationDate__c"]`), which does not exist on the view page, so a correct org
 * failed (run 2026-10-26T07-05-26-345Z-dadbec8e: the Dynamic Forms field was there).
 * A presence check becomes `{ text: <label> }`; a VALUE check (text_equals/text_contains with a value
 * other than the label, or a bare number, date or picklist option checked right after its field's
 * label) becomes `{ field: <label> }`, which the spec reads inside that field's own block. A bare
 * `getByText("$5,000.00")` could be any field's. The
 * "Details" tab is clicked first when the model's record pages have one. Only while the flow stays on
 * the view (waits, asserts, tab clicks): a click on a pencil or Edit opens inputs again, and an assert
 * there is left alone. Returns notes.
 */
export function fieldChecksOnRecordView(ir: IRSteps, model: {
  pages: { url: string; elements: { role?: string; name?: string }[] }[];
  salesforceOrg?: { objects: {
    api?: string; label?: string;
    fields: { label: string; picklist?: string[] }[]; calculated?: { label: string }[];
    visibilityRules?: { target: string; when: string }[];
  }[] };
}, request = "",
  /** The case's own title and expected result: the field a bare value belongs to may be named there only
   *  ("Test every branch of the flow" names none; the case expects "Rating = Hot", run
   *  2026-11-10T09-27-10-390Z-c915327a). Read by the bare-value rule only. */
  caseText = ""): string[] {
  const steps = ir.steps;
  const recordPages = model.pages.filter((p) => /\/lightning\/r\//.test(p.url));
  // A record page captured before Lightning drew its tabs shows none at all (run
  // 2026-11-03T07-31-20-798Z-dcc341ef: the page had Related | Details). Only a captured page WITH tabs
  // and no Details says there is none; the spec's Details click is skipped when the tab is absent.
  // No record page modelled at all says nothing either (run 2026-11-10T10-08-27-191Z-4830927e): the click is
  // inserted, and the spec skips it where the page has no Details tab.
  const hasDetailsTab = recordPages.length === 0
    || recordPages.some((p) => p.elements.some((e) => e.role === "tab" && e.name === "Details"))
    || !recordPages.some((p) => p.elements.some((e) => e.role === "tab"));
  // Phase 1: a Dynamic Forms rule's own field. The request asks about "SLA"; the writer checked
  // "SLA Expiration Date", a different, always-shown field (same run). The org's rule names the field.
  const ruleTargets = (model.salesforceOrg?.objects ?? []).flatMap((o) => o.visibilityRules ?? []).map((v) => v.target)
    .filter((t) => !t.startsWith("section ") && mentionsWord(request, t));
  // A text check naming one of the org's fields is a field check too ("Expected Revenue", run
  // 2026-10-26T07-23-19-810Z-0d14eb03: the Opportunity page opened on Activity, the field on Details).
  const fields: { label: string; picklist?: string[] }[] = (model.salesforceOrg?.objects ?? [])
    .flatMap((o) => [...o.fields, ...(o.calculated ?? [])]);
  // The names a record page and a request give a field, not only the org's label: "Lead Status" for
  // Lead's "Status", "Rating" for Account's "Account Rating" (run 2026-11-10T07-16-08-899Z-c1bf173a
  // checked text "Lead Status" for a value, and it was not read inside that field).
  const fieldLabels = new Set((model.salesforceOrg?.objects ?? []).flatMap((o) => [...o.fields, ...(o.calculated ?? [])]
    .flatMap((f) => [f.label, ...("label" in o && o.label ? [`${o.label} ${f.label}`] : []), f.label.replace(/^\S+\s+/, "")])));
  const notes: string[] = [];
  let saved = false;
  let onView = false;
  let onDetails = false;
  let tabs = 0;
  /** The field whose label the previous check (waits aside) looked for. */
  let lastLabel: string | undefined;
  /** The object whose record the flow is on, from its create page or a reopened record: a bare
   *  value belongs to that object's field ("Rating" is a Lead field too, offering "Hot" as well). */
  let onObject: string | undefined;
  const fieldsOf = (api?: string) => (model.salesforceOrg?.objects ?? []).find((o) => api && o.api === api)?.fields ?? fields;
  const labelOf = (api?: string) => (model.salesforceOrg?.objects ?? []).find((o) => api && o.api === api)?.label ?? "";
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    if (s.action === "navigate") {
      const url = String(s.target?.url ?? "");
      onObject = /\/lightning\/o\/(\w+)\/new\b/.exec(url)?.[1] ?? recordRefObject(url) ?? onObject;
    }
    if ((s.action === "assert" && saved && /\bwas (created|saved)\b/.test(s.target?.text ?? ""))
      || (s.action === "navigate" && recordRefObject(s.target?.url))) {
      onView = true; onDetails = false; lastLabel = undefined;
      continue;
    }
    if (s.action === "click" && isSave(s)) saved = true;
    if (!onView) continue;
    if (s.action === "click" && s.target?.role === "tab") { onDetails ||= s.target.name === "Details"; lastLabel = undefined; continue; }
    if (s.action !== "wait" && s.action !== "assert") { onView = false; continue; }
    if (s.action !== "assert") continue;
    const after = lastLabel;
    lastLabel = undefined;
    const valueCheck = (s.assertion === "text_equals" || s.assertion === "text_contains") && !!s.value?.trim();
    if (s.assertion !== "visible" && s.assertion !== "hidden" && !valueCheck) continue;
    const ruled = !valueCheck && s.target?.text
      ? ruleTargets.find((t) => s.target!.text !== t && s.target!.text!.startsWith(`${t} `) && !mentionsWord(request, s.target!.text!))
      : undefined;
    if (ruled) {
      notes.push(`"${s.target!.text}" -> "${ruled}", the field the org's Dynamic Forms rule shows (the request names it), its label exactly`);
      steps[i] = { ...s, target: { field: ruled } };
      if (hasDetailsTab && !onDetails) {
        const n = tabs++ ? `-${tabs}` : "";
        steps.splice(i, 0,
          { id: `sf-details${n}`, action: "click", target: { role: "tab", name: "Details" } },
          { id: `sf-details${n}-wait`, action: "wait", value: "500" });
        i += 2;
        onDetails = true;
        notes.push(`fields are on the record page's Details tab -> clicks it first`);
      }
      continue;
    }
    const text = steps[i].target?.text ?? "";
    // On Details, a visible check of text that is no field of the record (a related record's name, run
    // 2026-11-10T05-56-59-108Z-b85b16e9: the Case "TB Onboarding" on the Account) is on the Related tab.
    // A "contains" check on that text reads the same (run 2026-11-10T15-46-12-893Z-4e645505: "TB Onboarding" text_contains).
    if (onDetails && (s.assertion === "visible" || valueCheck) && text && !s.target?.role && !s.target?.field
      && !fieldLabels.has(text) && !fields.some((f) => f.picklist?.includes(text)) && !isShownValue(text)
      && !/\bwas (created|saved|deleted)\b/.test(text)
      // A value the case typed or picked (a lookup's record name) is that field's value, on Details (run
      // 2026-11-10T18-44-16-818Z-e8f15c2c: the Contact's Account Name was looked for on the Related tab).
      && !steps.slice(0, i).some((x) => (x.action === "fill" || x.action === "select") && x.value && lineKey(x.value) === lineKey(text))) {
      const n = tabs++ ? `-${tabs}` : "";
      steps.splice(i, 0,
        { id: `sf-related${n}`, action: "click", target: { role: "tab", name: "Related" } },
        { id: `sf-related${n}-wait`, action: "wait", value: "500" });
      i += 2;
      onDetails = false;
      notes.push(`"${text}" is no field of the record -> back to its Related or Activity tab first`);
      continue;
    }
    if (FORM_CONTROL.test(s.target?.role ?? "") && s.target?.name) {
      const label = s.target.name.replace(/^\*\s*|\s*\*$/g, "").trim();
      if (valueCheck && namesLabel(s.value!, label)) continue;
      if (valueCheck) {
        steps[i] = { ...s, target: { field: label } };
        notes.push(`the value check on ${s.target.role} "${s.target.name}" runs on the record page -> checks the "${label}" field shows "${s.value}"`);
      } else {
        steps[i] = { ...s, target: { text: label } };
        notes.push(`the check on ${s.target.role} "${s.target.name}" runs on the record page -> checks its label "${label}"`);
        if (s.assertion === "visible") lastLabel = label;
      }
    } else if (fieldLabels.has(text)) {
      if (valueCheck && namesLabel(s.value!, text)) continue;
      if (valueCheck) {
        steps[i] = { ...s, target: { field: text } };
        notes.push(`the value check on "${text}" -> checks the "${text}" field shows "${s.value}"`);
      } else if (s.assertion === "visible") lastLabel = text;
    } else if (after && s.assertion === "visible" && text && !s.target?.role && !/\bwas (created|saved|deleted)\b/.test(text)
      && (isShownValue(text) || fields.some((f) => f.label === after && f.picklist?.includes(text)))) {
      // A field's label, then a bare value: the value is that field's, read inside it.
      steps[i] = { ...s, target: { field: after }, assertion: "text_contains", value: text };
      notes.push(`"${text}" checked right after the "${after}" label -> checks the "${after}" field shows it`);
      continue;
    } else if (s.target?.field && !text) {
      // Already a field check (added by requestedFieldChecks): it still reads on the Details tab.
    } else if (!s.target?.role && text && pickedValueField(text, valueCheck ? s.value! : text, fieldsOf(onObject), `${request}
${caseText}`, labelOf(onObject))) {
      // A bare picklist value of a field the request names: "verify its Rating shows Hot" became
      // getByText("Hot") on the Related tab (run 2026-11-10T04-32-01-102Z-e4c449e4; a flow set it, on
      // Details). The value is that field's, read inside it, under the label the request uses: the
      // org calls it "Account Rating", the record page and the request say "Rating".
      const { label, value } = pickedValueField(text, valueCheck ? s.value! : text, fieldsOf(onObject), `${request}
${caseText}`, labelOf(onObject))!;
      steps[i] = { ...s, target: { field: label }, assertion: "text_contains", value };
      notes.push(`"${value}" is an option of the "${label}" field the request names -> checks that field shows it`);
    } else continue;
    if (hasDetailsTab && !onDetails) {
      const n = tabs++ ? `-${tabs}` : "";
      steps.splice(i, 0,
        { id: `sf-details${n}`, action: "click", target: { role: "tab", name: "Details" } },
        { id: `sf-details${n}-wait`, action: "wait", value: "500" });
      i += 2;
      onDetails = true;
      notes.push(`fields are on the record page's Details tab -> clicks it first`);
    }
  }
  return notes;
}

/** The password-run texts, exposed for tests; callers use `salesforceGuidance`. */
export const SALESFORCE_GUIDANCE = byStage("click");
const CONNECTED_GUIDANCE = byStage("url");

/**
 * The text to append to `stage`'s system prompt: the Salesforce rules when this run's target app is
 * Salesforce (the org-connection variant when the run signed in through one), otherwise "" — so a
 * non-Salesforce run's prompt is untouched.
 */
export function salesforceGuidance(stage: GuidanceStage): string {
  if (currentRunTargetApp() !== "salesforce") return "";
  return (currentFrontdoor() ? CONNECTED_GUIDANCE : SALESFORCE_GUIDANCE)[stage];
}

/**
 * The record page's own "Related" / "Details" tab, clicked the model's way (by an id such as
 * "#relatedListTab__item", whose first match can be another page's hidden tab: run
 * 2026-11-10T15-20-13-222Z-d5d2cd9e timed out there), becomes the record-tab click the passes above
 * insert, which takes the visible, unselected tab by role and name. Returns notes.
 */
export function recordTabClicks(ir: IRSteps): string[] {
  const notes: string[] = [];
  for (const s of ir.steps) {
    if (s.action !== "click" || /^sf-(related|details)/.test(s.id)) continue;
    const name = (s.target?.name ?? s.target?.text ?? "").trim();
    const tab = /^(related|details)$/i.exec(name)?.[1].toLowerCase()
      ?? /#(relatedListsTab|relatedListTab|detailTab)__item/i.exec(s.target?.css ?? "")?.[1].toLowerCase().replace(/^related.*/, "related").replace(/^detail.*/, "details");
    if (!tab || (s.target?.role && s.target.role !== "tab")) continue;
    const was = s.id;
    s.id = `sf-${tab}-${was}`;
    s.target = { role: "tab", name: tab === "related" ? "Related" : "Details" };
    notes.push(`${was}: the record's ${s.target.name} tab, by role and name`);
  }
  return notes;
}

/**
 * A link to a record the case never typed: its name carries a run token ("TB Onboard Opp for TB Customer
 * {{uid}}") that no fill or select wrote, so no such record exists and grounding cut the run there (run
 * 2026-11-10T16-01-17-338Z-d45454da: its checks had all passed). The step and what follows it go, when a check
 * comes before it; the steps that ran are the case. Returns notes.
 */
export function inventedRecordLinks(ir: IRSteps): string[] {
  const typed = new Set<string>();
  for (let i = 0; i < ir.steps.length; i++) {
    const s = ir.steps[i];
    if ((s.action === "fill" || s.action === "select") && s.value) typed.add(s.value.trim());
    const name = s.target?.name ?? s.target?.text ?? "";
    if (s.action !== "click" || !/\{\{uid\}\}/.test(name) || typed.has(name.trim())) continue;
    if (!ir.steps.slice(0, i).some((x) => x.action === "assert")) return [];
    const cut = ir.steps.length - i;
    ir.steps.splice(i);
    return [`${s.id}: a link to "${name}", which no step typed -> dropped with the ${cut - 1} step(s) after it`];
  }
  return [];
}

/**
 * A value the request asks to verify ("... and a Case whose subject starts with TB Onboarding appears")
 * that no step checks: the case writer left it out on some runs and kept it on others (run
 * 2026-11-10T17-02-55-715Z-9d0daa6b dropped "TB Onboarding" and was cut as incomplete). Added as a visible check
 * after the case's last field check on the record (else after its last Save), where
 * fieldChecksOnRecordView then takes it to the Related tab. Only values of two words or more that are
 * no object or field name. Returns notes.
 */
export function requestedTextChecks(ir: IRSteps, org: Pick<SalesforceOrgModel, "objects"> | undefined, request: string): string[] {
  const checkPart = request.slice(requestedActions(request).length);
  if (!checkPart.trim()) return [];
  const names = new Set((org?.objects ?? []).flatMap((o) => [o.label, o.labelPlural ?? "", ...o.fields.map((f) => f.label)]).map(lineKey));
  const seen = lineKey(ir.steps.map((s) => [s.value, s.target?.text, s.target?.name, s.target?.field].filter(Boolean).join(" ")).join(" "));
  const missing = requestValues(checkPart).filter((v) => v.trim().split(/\s+/).length >= 2 && !/['’]s\b/.test(v)
    && !names.has(lineKey(v)) && !seen.includes(lineKey(v)));
  if (!missing.length) return [];
  let at = -1;
  for (let i = ir.steps.length - 1; i >= 0 && at < 0; i--) if (ir.steps[i].action === "assert" && ir.steps[i].target?.field) at = i + 1;
  for (let i = ir.steps.length - 1; i >= 0 && at < 0; i--) if (ir.steps[i].action === "click" && isSave(ir.steps[i])) at = i + 1;
  if (at < 0) return [];
  ir.steps.splice(at, 0, ...missing.map((v) => ({ id: `sf-req-${v}`.replace(/\W+/g, "-").slice(0, 60), action: "assert", target: { text: v }, assertion: "visible" } as Step)));
  return missing.map((v) => `the request verifies "${v}" and no step checked it -> added`);
}

/**
 * No run token in a field a validation rule reads: "AB {{uid}}" in Company is 9 characters, so the
 * "LEN(Company) < 3" case never fired its rule (run 2026-11-10T17-54-37-180Z-5b726e4d). The token makes
 * a name unique; in a field a rule reads it changes the value the rule judges. Returns notes.
 */
export function noTokensInRuleFields(ir: IRSteps, org: Pick<SalesforceOrgModel, "objects"> | undefined): string[] {
  const notes: string[] = [];
  let form: string | null = null;
  for (const s of ir.steps) {
    if (s.action === "navigate") { form = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "")?.[1] ?? null; continue; }
    if (!form || s.action !== "fill" || !s.value || !/\{\{uid\}\}/.test(s.value)) continue;
    const o = org?.objects.find((x) => x.api === form);
    const name = lineKey(s.target?.name ?? s.target?.label ?? "");
    const f = o?.fields.find((x) => lineKey(x.label) === name);
    if (!o || !f) continue;
    const read = (o.validationRules ?? []).some((r) => r.condition && new RegExp(`\\b${f.api}\\b`).test(r.condition));
    if (!read) continue;
    const was = s.value;
    s.value = s.value.replace(/\s*\{\{uid\}\}\s*/g, " ").trim() || s.value;
    if (s.value !== was) notes.push(`${s.id}: ${f.label} is read by a validation rule -> no unique code in it ("${s.value}")`);
  }
  return notes;
}

/**
 * The path, done the way Lightning does it: a click on a stage of the path (a value of the object's
 * Stage or Status picklist) selects it only; "Mark as Current Stage" moves the record there. Run
 * 2026-11-10T18-06-01-372Z-8ea242b7 clicked "Proposal/Price Quote" and stopped. Also drops a check of
 * "<Field> <value>" right after that value was picked on the form ("Stage Prospecting"): the form shows
 * the value alone, and the pick itself is the check. Returns notes.
 */
export function pathStageClicks(ir: IRSteps, org: Pick<SalesforceOrgModel, "objects"> | undefined): string[] {
  const notes: string[] = [];
  const stages = new Set((org?.objects ?? []).flatMap((o) => o.fields.filter((f) => /^(StageName|Status)$/.test(f.api)).flatMap((f) => f.picklist ?? [])).map(lineKey));
  for (let i = 0; i < ir.steps.length; i++) {
    const s = ir.steps[i];
    const prev = ir.steps[i - 1];
    if (s.action === "assert" && s.target?.text && prev && (prev.action === "select" || prev.action === "fill") && prev.value
      && lineKey(s.target.text) === lineKey(`${prev.target?.name ?? ""} ${prev.value}`)) {
      notes.push(`${s.id}: "${s.target.text}" repeats the value just picked -> dropped`);
      ir.steps.splice(i--, 1);
      continue;
    }
    if (s.action !== "click" || !stages.has(lineKey(s.target?.name ?? "")) || !ir.steps.slice(0, i).some((x) => x.action === "click" && isSave(x))) continue;
    let j = i + 1;
    while (j < ir.steps.length && ir.steps[j].action === "wait") j++;
    if (/^mark as current stage$/i.test(ir.steps[j]?.target?.name ?? "")) continue;
    ir.steps.splice(j, 0, { id: `sf-path-mark-${s.id}`, action: "click", target: { role: "button", name: "Mark as Current Stage" } } as Step,
      { id: `sf-path-mark-${s.id}-wait`, action: "wait", value: "1500" } as Step);
    notes.push(`${s.id}: "${s.target?.name}" on the path only selects it -> clicks "Mark as Current Stage"`);
  }
  return notes;
}

/**
 * What one flow does to a record with these values (by API name), from its effect lines: the fields it
 * sets and the records it creates by name. Null when it does not run (its "only when" is false) or when
 * a condition reads a value the case did not type (never guessed). The branch taken is the first whose
 * "when" holds, else the default one.
 */
export function flowOutcome(
  o: { fields: { label: string; api?: string }[] }, lines: string[], valueOf: (api: string) => string | undefined,
): { sets: { label: string; api: string; value: string }[]; creates: string[] } | null {
  const only = lines.find((l) => l.startsWith("only when "));
  if (only && whenHolds(only.slice("only when ".length), valueOf) !== true) return null;
  const branches = lines.filter((l) => l.startsWith("branch "));
  let effects: string;
  if (branches.length) {
    let taken: string | undefined;
    for (const b of branches) {
      const when = /: when (.*?) ->/.exec(b)?.[1];
      if (!when) { taken ??= b; continue; }        // the default branch: taken when none before holds
      const h = whenHolds(when, valueOf);
      if (h === undefined) return null;
      if (h) { taken = b; break; }
    }
    if (!taken) return null;
    effects = taken.slice(taken.indexOf("->") + 2);
  } else {
    effects = lines.filter((l) => !l.startsWith("only when ")).join("; ");
  }
  const sets: { label: string; api: string; value: string }[] = [];
  for (const m of effects.matchAll(/\bsets (.+?)(?=;|$)/g)) {
    if (/ on [A-Z][\w ]*$/.test(m[1])) continue;
    for (const part of m[1].split(/,\s+(?=\w+ = )/)) {
      const a = /^(\w+) = (.+)$/.exec(part.trim());
      const f = a ? o.fields.find((x) => x.api?.toLowerCase() === a[1].toLowerCase()) : undefined;
      if (a && f?.api) sets.push({ label: f.label, api: f.api, value: /^(true|false)$/i.test(a[2].trim()) ? a[2].trim().toLowerCase() : a[2].trim() });
    }
  }
  return { sets, creates: [...effects.matchAll(/creates an? \w+ "([^"]+)"/g)].map((m) => m[1]) };
}
