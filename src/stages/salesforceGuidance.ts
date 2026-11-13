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
const isRecordChange = (s: Step) => isSave(s) || /^(mark (as current stage|stage as complete)|submit|approve|reject)$/i.test(s.target?.name ?? "");

/**
 * Backs the two Save rules above. A case that ends on the dialog's Save button alone ("hidden" =
 * saved, "visible" = refused) passes when the click never registered and never sees the outcome
 * (runs 2026-10-25T12-31-05-389Z-a83f1df1 and -352Z-579a7a86 asserted only that). Append the outcome
 * Salesforce shows — the toast on a save, "We hit a snag." on a refusal — as the final step, where
 * terminal-text grounding checks it on the live page and, on an org in another language, corrects
 * it to the page's own wording. The Save assertion stays; this only adds. Returns a note, or null.
 */
/**
 * Lightning's global search runs on Enter: after typing into its box, a click on "Search" looks for a second
 * button that is not there (run 2026-11-13T15-59-07-870Z-cf7c96f8 timed out and was cut). The click after the
 * typing becomes Enter in that box. Returns notes.
 */
export function globalSearchSubmit(ir: IRSteps): string[] {
  const notes: string[] = [];
  // The global search box is "Search..." once opened; the model also calls it "Search Salesforce" (run
  // 2026-11-13T16-45-27-540Z-72773d0c could not type into it).
  for (const s of ir.steps) {
    if ((s.action !== "fill" && s.action !== "press") || !/^search\b/i.test((s.target?.name ?? "").trim()) || s.target?.name === "Search...") continue;
    if (s.target?.role && !/^(searchbox|textbox|combobox)$/.test(s.target.role)) continue;
    notes.push(`${s.id}: the global search box is "Search...", not "${s.target!.name}"`);
    s.target = { role: "searchbox", name: "Search..." };
  }
  // The box exists only once the header's "Search" button opened it (run 2026-11-13T16-53-32-808Z-11eabab6
  // typed into it straight away and was cut there): that click goes first when the case left it out.
  const firstType = ir.steps.findIndex((s) => s.action === "fill" && s.target?.name === "Search...");
  if (firstType > 0) {
    let j = firstType - 1;
    while (j >= 0 && ir.steps[j].action === "wait") j--;
    if (!(ir.steps[j]?.action === "click" && /^search$/i.test((ir.steps[j].target?.name ?? "").trim()))) {
      ir.steps.splice(firstType, 0, { id: "sf-search-box", action: "click", target: { role: "button", name: "Search" } } as Step,
        { id: "sf-search-box-wait", action: "wait", value: "800" } as Step);
      notes.push(`the global search box is opened by its "Search" button first`);
    }
  }
  for (let i = 1; i < ir.steps.length; i++) {
    const s = ir.steps[i];
    if (s.action !== "click" || !/^search$/i.test((s.target?.name ?? "").trim())) continue;
    let j = i - 1;
    while (j >= 0 && ir.steps[j].action === "wait") j--;
    const typed = ir.steps[j];
    if (!typed || typed.action !== "fill" || !/^search\b/i.test((typed.target?.name ?? typed.target?.placeholder ?? "").trim())) continue;
    ir.steps[i] = { id: s.id, action: "press", target: typed.target, value: "Enter" } as Step;
    notes.push(`${s.id}: the global search runs on Enter, not a second "Search" click`);
  }
  // Opening a record the test just made from the search results: Salesforce's search index takes a while
  // to have a new record (run 2026-11-13T16-35-10-260Z-944deb2f searched at once and found nothing). The
  // spec searches again until it shows (generator.ts, "sf-search-open-"), and grounding does not demand the
  // results screen ahead of time.
  for (let i = 1; i < ir.steps.length; i++) {
    const s = ir.steps[i];
    if (s.action !== "click" || !s.target?.name) continue;
    let j = i - 1;
    while (j >= 0 && ir.steps[j].action === "wait") j--;
    const prev = ir.steps[j];
    if (!prev || prev.action !== "press" || !/^enter$/i.test(prev.value ?? "") || !/^search\b/i.test((prev.target?.name ?? "").trim())) continue;
    let k = j - 1;
    while (k >= 0 && ir.steps[k].action === "wait") k--;
    const typed = ir.steps[k]?.action === "fill" ? ir.steps[k].value : undefined;
    // The record the test made, by the name it was given ("Quasar Robotics {{uid}}"), however the model wrote
    // the link: without its run code it could be an older record of the same name, and with ANOTHER run's
    // code ("Quasar Robotics msymz4", copied off a captured results screen, run
    // 2026-11-13T17-21-21-999Z-ecc97eb2) it is a record that is gone by the time the spec runs.
    const bare = lineKey(s.target.name.replace(/\{\{uid\}\}/g, "").replace(/\s[a-z0-9]{6}$/, ""));
    const made = ir.steps.slice(0, k).filter((x) => x.action === "fill" && x.value?.includes("{{uid}}")).map((x) => x.value!)
      .find((v) => lineKey(v.replace(/\{\{uid\}\}/g, "")) === bare);
    const name = s.target.name.includes("{{uid}}") ? s.target.name : made;
    if (!name) continue;
    ir.steps[i] = { ...s, id: `sf-search-open-${s.id}`, target: { role: "link", name }, ...(typed ? { value: typed } : {}) } as Step;
    notes.push(`${s.id}: opens the new record from the search results, searching again until Salesforce has indexed it`);
  }
  return notes;
}

/**
 * Right after a delete, Salesforce's own message names the record ('Opportunity "Delete Me ab12cd" was
 * deleted.'), so a check that the name is no longer on the page fails on that message (run
 * 2026-11-13T16-32-07-872Z-36eef730, the record was gone). The API check that it is gone is the proof;
 * such a check goes. Returns notes.
 */
export function deletedNameNotChecked(ir: IRSteps): string[] {
  const notes: string[] = [];
  const at = ir.steps.findIndex((s) => s.action === "assert" && /\bwas deleted\b/i.test(s.target?.text ?? ""));
  if (at < 0) return notes;
  const typed = ir.steps.slice(0, at).filter((s) => s.action === "fill" && s.value).map((s) => lineKey(s.value!.replace(/\{\{uid\}\}/g, "")));
  for (let i = ir.steps.length - 1; i > at; i--) {
    const s = ir.steps[i];
    if (s.action !== "assert" || s.assertion !== "hidden" || !s.target?.text) continue;
    const k = lineKey(s.target.text.replace(/\{\{uid\}\}/g, ""));
    if (!k || !typed.some((t) => t.includes(k) || k.includes(t))) continue;
    ir.steps.splice(i, 1);
    notes.push(`${s.id}: "${s.target.text}" hidden right after the delete -> dropped (Salesforce's own message names it; the API checks it is gone)`);
  }
  return notes;
}

/**
 * An activity's Subject (Log a Call, New Task, New Event) is a type-ahead box: it suggests Call, Email, Send
 * Letter… and takes any text. A select there picks the suggestion the value contains: "Intro call" was saved
 * as "Call" (run 2026-11-13T14-46-59-658Z-c76ab6b0). A Subject that is no plain suggestion is typed. Returns notes.
 */
const ACTIVITY_SUGGESTIONS = /^(call|email|send letter|send quote|other)$/i;
export function activitySubjectTyped(ir: IRSteps): string[] {
  const notes: string[] = [];
  let onActivity = false;
  ir.steps.forEach((s, i) => {
    if (s.action === "navigate") { onActivity = /\/lightning\/o\/(Task|Event)\/new\b/.test(s.target?.url ?? ""); return; }
    if (s.action === "click" && /^(log a call|new task|new event|new activity)$/i.test((s.target?.name ?? "").trim())) { onActivity = true; return; }
    if (s.action === "click" && isSave(s)) { onActivity = false; return; }
    if (!onActivity || s.action !== "select" || !/^subject$/i.test((s.target?.name ?? "").replace(/^\*\s*|\s*\*$/g, "").trim())) return;
    if (!s.value || ACTIVITY_SUGGESTIONS.test(s.value.trim())) return;
    ir.steps[i] = { ...s, action: "fill", target: { role: "combobox", name: "Subject" } } as Step;
    notes.push(`${s.id}: the activity's Subject "${s.value}" is typed (the box only suggests Call, Email...)`);
  });
  return notes;
}

/**
 * An edit's Save (after "Edit", or an inline field's pencil "Edit Phone") confirmed by Salesforce's own
 * '"<name>" was saved.' when the case left it out. Without it the record page never counts as reached:
 * run 2026-11-13T14-13-29-358Z-ac7a1e04 checked Priority on the edit form's own dropdown, and the API check
 * did not count the edit. Returns notes.
 */
export function editSaveConfirmed(ir: IRSteps): string[] {
  const notes: string[] = [];
  let editing = false;
  for (let i = 0; i < ir.steps.length; i++) {
    const s = ir.steps[i];
    if (s.action === "navigate") { editing = false; continue; }
    if (s.action === "click" && /^edit\b/i.test((s.target?.name ?? "").trim())) { editing = true; continue; }
    if (!editing || s.action !== "click" || !isSave(s)) continue;
    editing = false;
    let j = i + 1;
    while (j < ir.steps.length && ir.steps[j].action === "wait") j++;
    if (j < ir.steps.length && ir.steps[j].action === "assert" && /\bwas saved\b|\bwe hit a snag\b|\breview the (following|errors)\b/i.test(ir.steps[j].target?.text ?? "")) continue;
    ir.steps.splice(i + 1, 0, { id: `sf-saved-${s.id}`, action: "assert", target: { text: "was saved" }, assertion: "visible" } as Step);
    notes.push(`${s.id}: the edit's Save -> checks Salesforce's "was saved" first`);
  }
  return notes;
}

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
/** The compound address field ("Billing Address") an earlier step typed this value into a part of. */
function addressPartTyped(before: Step[], value: string): string | undefined {
  const hit = [...before].reverse().find((s) => s.action === "fill" && lineKey(s.value ?? "") === lineKey(value) && !!lineKey(value));
  const m = /^(Billing|Shipping|Mailing|Other)\s+(Street|City|State\/Province|State|Province|Zip\/Postal Code|Zip|Postal Code|Country)$/i
    .exec((hit?.target?.name ?? hit?.target?.field ?? "").replace(/^\*\s*|\s*\*$/g, "").trim());
  return m ? `${m[1][0].toUpperCase()}${m[1].slice(1).toLowerCase()} Address` : undefined;
}

/** "Stage Closed Lost" -> ["Stage", "Closed Lost"]: the longest field label the text starts with, and the rest. */
function labelThenValue(text: string, labels: Set<string>): [string, string] | undefined {
  const t = text.trim();
  const label = [...labels].filter((l) => l && t.length > l.length + 1 && t.toLowerCase().startsWith(`${l.toLowerCase()} `))
    .sort((a, b) => b.length - a.length)[0];
  const rest = label ? t.slice(label.length).replace(/^[\s:=-]+/, "").trim() : "";
  return label && rest ? [label, rest] : undefined;
}

/** The field an earlier step typed this value into (its label as the org names it), or undefined. */
function typedInto(before: Step[], labels: Set<string>, value: string): string | undefined {
  const n = shownNumber(value);
  const hit = [...before].reverse().find((s) => s.action === "fill" && typeof s.value === "string"
    && (s.value.trim() === value.trim() || (n !== null && shownNumber(s.value) === n)));
  const label = (hit?.target?.name ?? hit?.target?.field ?? "").replace(/^\*\s*|\s*\*$/g, "").trim();
  return label && labels.has(label) ? label : undefined;
}

/** The one field label the request gives this value ("Expected Revenue is $100.00"), or undefined. */
function valueNamedField(request: string, labels: Iterable<string>, value: string): string | undefined {
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hits = [...new Set(labels)].filter((l) => l && new RegExp(
    `\\b${esc(l)}\\s+(?:is|shows|equals|reads|=|should be|of)\\s+["'“]?${esc(value.trim())}(?![\\p{N}])`, "iu").test(request));
  // The longest wins when one label holds another ("Revenue" inside "Expected Revenue").
  const longest = hits.sort((a, b) => b.length - a.length)[0];
  return longest && hits.every((h) => h === longest || longest.toLowerCase().includes(h.toLowerCase())) ? longest : undefined;
}

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
    // customLinkSteps' own check of the link's text is on Details by design (run
    // 2026-11-13T07-54-34-011Z-9a55e65c was sent to Related, where there is none).
    // A field's label and its value as one text ("Customer Priority Medium") is that field's check, on
    // Details: run 2026-11-13T13-50-37-642Z-f2f97e6d sent it to the Related tab first.
    const labelValue = !!text && !s.target?.role && !!labelThenValue(text, fieldLabels) && (() => {
      const [label, v] = labelThenValue(text, fieldLabels)!;
      return fields.some((f) => f.label === label && f.picklist?.some((p) => lineKey(p) === lineKey(v)))
        || steps.slice(0, i).some((x) => (x.action === "fill" || x.action === "select") && lineKey(x.value ?? "") === lineKey(v))
        || isShownValue(v);
    })();
    if (onDetails && !labelValue && !s.id.startsWith("sf-cl-") && (s.assertion === "visible" || valueCheck) && text && !s.target?.role && !s.target?.field
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
    } else if (!s.target?.role && text && isShownValue(valueCheck ? s.value! : text)
      && (valueNamedField(`${request}\n${caseText}`, fieldLabels, valueCheck ? s.value! : text) ?? typedInto(steps.slice(0, i), fieldLabels, valueCheck ? s.value! : text))) {
      // A bare number the request gives a field ("verify Expected Revenue is $100.00"): getByText("$100.00")
      // could be any field's (run 2026-11-13T07-31-06-677Z-c4484063), so it is read inside that field. So is a
      // number the case typed into a field: the page shows "$1,234.56" for a typed "1234.56" (run
      // 2026-11-13T12-02-09-298Z-fc1e4b67), and the field check compares numbers by value.
      const v = valueCheck ? s.value! : text;
      const label = (valueNamedField(`${request}\n${caseText}`, fieldLabels, v) ?? typedInto(steps.slice(0, i), fieldLabels, v))!;
      steps[i] = { ...s, target: { field: label }, assertion: "text_contains", value: v };
      notes.push(`the request says "${label}" is "${v}" -> checks that field shows it`);
    } else if (!s.target?.role && text && addressPartTyped(steps.slice(0, i), valueCheck ? s.value! : text)) {
      // A value typed into a part of an address (Billing Country "Canada"): the record page shows the address
      // as ONE field, "Billing Address" = "Toronto, Ontario M5V 2T6 Canada", never a "Billing Country" field
      // (run 2026-11-13T12-58-06-198Z-0bdc663a). The value is read inside that address.
      const v = valueCheck ? s.value! : text;
      const label = addressPartTyped(steps.slice(0, i), v)!;
      steps[i] = { ...s, target: { field: label }, assertion: "text_contains", value: v };
      notes.push(`"${v}" was typed into an address part -> checks the "${label}" field shows it`);
    } else if (labelValue) {
      // Only a real value of that field (labelValue): an option it offers, a value the case typed, a number
      // or a date. "Description Information" is a section heading, not Description's value.
      // A field's label and its value as one text ("Stage Closed Lost", run 2026-11-13T12-23-59-973Z-80c3f152):
      // the page never shows them as one string. The value is that field's, read inside it.
      const [label, v] = labelThenValue(text, fieldLabels)!;
      steps[i] = { ...s, target: { field: label }, assertion: "text_contains", value: v };
      notes.push(`"${text}" is the "${label}" field and its value -> checks that field shows "${v}"`);
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
  // Calculated fields too: "Expected Revenue" is a field, not a missing value (run
  // 2026-11-13T07-31-06-677Z-c4484063 checked its label as text before the record existed).
  const names = new Set((org?.objects ?? []).flatMap((o) => [o.label, o.labelPlural ?? "", ...o.fields.map((f) => f.label), ...(o.calculated ?? []).map((f) => f.label)]).map(lineKey));
  const seen = lineKey(ir.steps.map((s) => [s.value, s.target?.text, s.target?.name, s.target?.field].filter(Boolean).join(" ")).join(" "));
  const missing = requestValues(checkPart).filter((v) => v.trim().split(/\s+/).length >= 2 && !/['’]s\b/.test(v)
    && !names.has(lineKey(v)) && !seen.includes(lineKey(v)));
  if (!missing.length) return [];
  let at = -1;
  for (let i = ir.steps.length - 1; i >= 0 && at < 0; i--) if (ir.steps[i].action === "assert" && ir.steps[i].target?.field) at = i + 1;
  for (let i = ir.steps.length - 1; i >= 0 && at < 0; i--) if (ir.steps[i].action === "click" && isSave(ir.steps[i])) at = i + 1;
  if (at < 0) return [];
  // Never ahead of the Save's own confirmation: the record page is not there yet.
  while (at < ir.steps.length && (ir.steps[at].action === "wait"
    || (ir.steps[at].action === "assert" && /\bwas (created|saved)\b/.test(ir.steps[at].target?.text ?? "")))) at++;
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
export function pathStageClicks(ir: IRSteps, org: Pick<SalesforceOrgModel, "objects"> | undefined, request = ""): string[] {
  const notes: string[] = [];
  const stageValues = (org?.objects ?? []).flatMap((o) => o.fields.filter((f) => /^(StageName|Status)$/.test(f.api)).flatMap((f) => f.picklist ?? []));
  const stages = new Set(stageValues.map(lineKey));
  // "use the path to move it to <stage>": "Mark Stage as Complete" moves ONE stage (run
  // 2026-11-10T19-52-39-662Z-c714e22c never reached Closed Won). Its click becomes the way to THAT stage:
  // the stage, then "Mark as Current Stage"; a closing stage goes through the path's "Closed" stage and
  // its dialog ("Select Closed Stage", pick the stage, Save).
  if (/\bpath\b/i.test(request)) {
    // The destination: the stage the request names LAST ("with Stage Prospecting ... close it as Closed Won").
    // The longest name was taken before, and run 2026-11-10T20-53-08-719Z-6f08f37a "moved" to Prospecting.
    const words = ` ${lineKey(request)} `;
    const target = stageValues.filter((v) => mentionsWord(request, v))
      .map((v) => ({ v, at: words.lastIndexOf(` ${lineKey(v)} `) }))
      .sort((a, b) => b.at - a.at || b.v.length - a.v.length)[0]?.v;
    const mark = ir.steps.findIndex((s) => s.action === "click" && /^mark stage as complete$/i.test(s.target?.name ?? ""));
    // No path step at all (run 2026-11-12T07-04-54-099Z-74db9cd3 saved Prospecting and went straight to
    // checking Closed Won): the path steps go right after the Save is confirmed.
    const pathy = (s: Step) => s.action === "click" && /^(closed|select closed stage|mark as current stage|mark stage as complete)$/i.test(s.target?.name ?? "");
    let at = mark, remove = 1;
    if (mark < 0 && !ir.steps.some(pathy)) {
      for (let i = ir.steps.length - 1; i >= 0 && at < 0; i--) if (ir.steps[i].action === "click" && isSave(ir.steps[i])) at = i + 1;
      while (at > 0 && at < ir.steps.length && (ir.steps[at].action === "wait"
        || (ir.steps[at].action === "assert" && /\bwas (created|saved)\b/.test(ir.steps[at].target?.text ?? "")))) at++;
      remove = 0;
    }
    if (target && at >= 0 && !ir.steps.some((s) => s.action === "click" && lineKey(s.target?.name ?? "") === lineKey(target))) {
      const id = mark >= 0 ? ir.steps[mark].id : "sf-path";
      const closing = /^closed\b/i.test(target);
      ir.steps.splice(at, remove, ...(closing
        ? [{ id: `${id}-closed`, action: "click", target: { role: "button", name: "Closed" } },
          { id: `${id}-select`, action: "click", target: { role: "button", name: "Select Closed Stage" } },
          { id: `${id}-wait`, action: "wait", value: "1000" },
          { id: `${id}-stage`, action: "select", target: { role: "combobox", name: "Stage" }, value: target },
          { id: `${id}-save`, action: "click", target: { role: "button", name: "Save" } }]
        : [{ id: `${id}-stage`, action: "click", target: { role: "button", name: target } },
          { id: `${id}-mark`, action: "click", target: { role: "button", name: "Mark as Current Stage" } }]) as Step[],
        { id: `${id}-wait2`, action: "wait", value: "1500" } as Step);
      notes.push(`${id}: ${mark >= 0 ? `"Mark Stage as Complete" moves one stage` : "no step used the path"} -> moves the path to "${target}"${closing ? " through the Closed dialog" : ""}`);
    }
  }
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
    // A closing stage is no stage of the path: the path shows one "Closed", whose dialog picks Won or Lost
    // (run 2026-11-10T21-35-47-447Z-6d016a28 clicked "Closed Won" and was given "Mark as Current Stage").
    if (/^closed\b/i.test(s.target?.name ?? "") && lineKey(s.target?.name ?? "") !== "closed") {
      const target = s.target!.name!;
      let j = i + 1;
      while (j < ir.steps.length && (ir.steps[j].action === "wait" || /^mark as current stage$/i.test(ir.steps[j].target?.name ?? ""))) j++;
      ir.steps.splice(i, j - i,
        { id: `${s.id}-closed`, action: "click", target: { role: "button", name: "Closed" } } as Step,
        { id: `${s.id}-select`, action: "click", target: { role: "button", name: "Select Closed Stage" } } as Step,
        { id: `${s.id}-wait`, action: "wait", value: "1000" } as Step,
        { id: `${s.id}-stage`, action: "select", target: { role: "combobox", name: "Stage" }, value: target } as Step,
        { id: `${s.id}-save`, action: "click", target: { role: "button", name: "Save" } } as Step,
        { id: `${s.id}-wait2`, action: "wait", value: "1500" } as Step);
      notes.push(`${s.id}: "${target}" is set through the path's Closed dialog`);
      i += 5;
      continue;
    }
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
): { sets: { label: string; api: string; value: string }[]; creates: string[]; made: CreatedByFlow[]; notMade: CreatedByFlow[] } | null {
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
  // The records it makes on THIS record, and those other branches make and this one must not (Warm/Cold: no
  // call task), with the due date and the link the org model read (createdLine).
  const made = createdByFlow(effects);
  const notMade = createdByFlow(branches.join("; ")).filter((x) => !made.some((m) => m.object === x.object && m.name === x.name));
  return { sets, creates: [...effects.matchAll(/creates an? \w+ "([^"]+)"/g)].map((m) => m[1]), made, notMade };
}

export interface CreatedByFlow { object: string; name: string; dueDays?: number; link?: string }
/** 'creates a Task "X" due today + 1, linked to the record by WhoId' as data. */
export function createdByFlow(text: string): CreatedByFlow[] {
  const out: CreatedByFlow[] = [];
  for (const m of text.matchAll(/creates an? (\w+) "([^"]+)"( due today(?: ([+-]) (\d+))?)?(?:, linked to the record by (\w+))?/g)) {
    if (out.some((x) => x.object === m[1] && x.name === m[2])) continue;
    out.push({ object: m[1], name: m[2], ...(m[3] ? { dueDays: m[5] ? (m[4] === "-" ? -1 : 1) * Number(m[5]) : 0 } : {}), ...(m[6] ? { link: m[6] } : {}) });
  }
  return out;
}

/**
 * A lookup to an object Testbench seeded (org.seeded, "TB Seed <uid>") picks that record by its exact
 * name when the step left it empty or named a record the case never typed: run
 * 2026-11-10T19-01-03-810Z-5876ab5f left "Account Name" empty ("the first suggestion") and passed on
 * "was created" alone. Returns notes.
 */
export function seededLookups(ir: IRSteps, org: Pick<SalesforceOrgModel, "objects" | "seeded"> | undefined): string[] {
  const notes: string[] = [];
  if (!org?.seeded?.length) return notes;
  let form: string | null = null;
  ir.steps.forEach((s, i) => {
    if (s.action === "navigate") { form = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "")?.[1] ?? null; return; }
    if (!form || s.action !== "select" || !s.target?.lookup) return;
    const o = org.objects.find((x) => x.api === form);
    // The form names a lookup by its target ("Account Name") where the org's label is "Account ID" (run
    // 2026-11-10T19-26-01-521Z-0028eba6 left it empty for that reason): the lookup to the object the name starts with.
    const name = lineKey(s.target?.name ?? "");
    const f = o?.fields.find((x) => lineKey(x.label) === name)
      ?? o?.fields.find((x) => !!x.lookup && name.startsWith(lineKey(x.lookup)));
    const seed = org.seeded!.find((r) => r.object === f?.lookup);
    if (!seed) return;
    const typedBefore = ir.steps.slice(0, i).some((x) => x.action === "fill" && x.value && s.value && lineKey(x.value) === lineKey(s.value));
    if (s.value?.trim() && (typedBefore || lineKey(s.value) === lineKey(seed.name))) return;
    notes.push(`${s.id}: "${s.target.name}" -> the ${seed.label} Testbench seeded, "${seed.name}"`);
    s.value = seed.name;
  });
  // The link is the point: once saved, the new record shows the seeded one's name (a lookup value, on Details).
  for (const seed of org.seeded) {
    if (!ir.steps.some((s) => s.action === "select" && s.value === seed.name)) continue;
    if (ir.steps.some((s) => s.action === "assert" && lineKey(s.target?.text ?? s.value ?? "") === lineKey(seed.name))) continue;
    let at = -1;
    for (let i = ir.steps.length - 1; i >= 0 && at < 0; i--) if (ir.steps[i].action === "click" && isSave(ir.steps[i])) at = i + 1;
    if (at < 0) continue;
    while (at < ir.steps.length && (ir.steps[at].action === "wait" || (ir.steps[at].action === "assert" && /\bwas created\b/.test(ir.steps[at].target?.text ?? "")))) at++;
    ir.steps.splice(at, 0, { id: `sf-seed-link`, action: "assert", target: { text: seed.name }, assertion: "visible" } as Step);
    notes.push(`the new record links the seeded ${seed.label} -> checks "${seed.name}" shows on it`);
  }
  return notes;
}

/**
 * A message the request spells with a field in angle brackets ("verify the message Contact <Last Name> was
 * created") is checked whole, with the value the case typed in that field: run
 * 2026-11-10T19-50-02-464Z-cabd0c06 checked only "was created". The last check on the message's fixed
 * words keeps its locator and also checks the whole message (run tokens resolve where it runs). Returns notes.
 */
export function placeholderMessages(ir: IRSteps, request: string): string[] {
  const m = /\bmessage\s+["“']?(.+?<[^>]+>.*?)["”']?(?:\s+is\s+(?:shown|displayed|visible)|\s+appears|[.;]|$)/i.exec(request);
  if (!m) return [];
  let missing = false;
  const whole = m[1].trim().replace(/<([^>]+)>/g, (_x, field: string) => {
    const typed = ir.steps.find((s) => s.action === "fill" && lineKey(s.target?.name ?? s.target?.label ?? "") === lineKey(field));
    if (!typed?.value) missing = true;
    return typed?.value ?? "";
  });
  if (missing) return [];
  const fixed = m[1].split(/<[^>]+>/).map((p) => p.trim()).filter(Boolean).sort((a, b) => b.length - a.length);
  for (let i = ir.steps.length - 1; i >= 0; i--) {
    const s = ir.steps[i];
    if (s.action !== "assert" || !s.target?.text) continue;
    if (!fixed.some((f) => lineKey(f).includes(lineKey(s.target!.text!)) || lineKey(s.target!.text!).includes(lineKey(f)))) continue;
    if (s.value && lineKey(s.value) === lineKey(whole)) return [];
    ir.steps[i] = { ...s, assertion: "text_contains", value: whole };
    return [`${s.id}: "${s.target.text}" -> also checks the whole message "${whole}"`];
  }
  return [];
}

/**
 * A record a published platform event's flow made (seeding wrote 'creates a Account "TB Event <uid>"' into
 * the flow's lines) is found through the header's global search, whatever the steps did before: the case
 * writer kept opening the Accounts "Recently Viewed" list, which never holds it (runs
 * 2026-11-10T13-35-43-065Z-74193e13, 2026-11-10T20-49-59-426Z-28d7a837). The steps are the ones of the
 * passing run 2026-11-10T15-28-58-549Z-d2677d83. Returns notes.
 */
export function eventRecordSearch(ir: IRSteps, org: Pick<SalesforceOrgModel, "flows"> | undefined): string[] {
  const names = (org?.flows ?? []).filter((f) => f.type === "platform-event")
    .flatMap((f) => (f.effects ?? []).flatMap((l) => [...l.matchAll(/creates an? \w+ "(TB Event [a-z0-9]+)"/g)].map((m) => m[1])));
  const notes: string[] = [];
  for (const name of new Set(names)) {
    const at = ir.steps.findIndex((s) => s.action === "assert" && lineKey(s.target?.text ?? "") === lineKey(name));
    if (at < 0) continue;
    if (ir.steps.slice(0, at).some((s) => s.action === "fill" && lineKey(s.value ?? "") === lineKey(name) && /search/i.test(s.target?.name ?? ""))) continue;
    const search = { role: "searchbox", name: "Search..." };
    ir.steps.splice(at, 0, ...[
      { id: "sf-ev-home", action: "navigate", target: { url: "/lightning/page/home" } },
      { id: "sf-ev-search", action: "click", target: { role: "button", name: "Search" } },
      { id: "sf-ev-wait", action: "wait", value: "500" },
      { id: "sf-ev-type", action: "fill", target: search, value: name },
      { id: "sf-ev-enter", action: "press", target: search, value: "Enter" },
      { id: "sf-ev-wait2", action: "wait", value: "1500" },
    ] as Step[]);
    notes.push(`"${name}" is found through global search, the way the passing run found it`);
  }
  return notes;
}

/**
 * Lead convert, done the way Lightning does it: the header's "Convert" opens the dialog, and the dialog's own
 * "Convert" converts. Run 2026-11-12T09-31-35-264Z-96ce8e8e clicked a page-wide "Convert" twice (the second
 * matched the header again), the dialog stayed open, and its "Converted" check matched the Lead's path. The
 * second click is scoped to the dialog, and the check is Salesforce's own "Your lead has been converted".
 * Returns notes.
 */
export function leadConvertSteps(ir: IRSteps): string[] {
  const clicks = ir.steps.map((s, i) => [s, i] as const).filter(([s]) => s.action === "click" && /^convert$/i.test(s.target?.name ?? ""));
  if (clicks.length < 2) return [];
  const notes: string[] = [];
  const [dialogClick, at] = clicks[1];
  if (!/role=dialog/.test(dialogClick.target?.css ?? "")) {
    ir.steps[at] = { ...dialogClick, target: { role: "button", name: "Convert", css: 'role=dialog >> role=button[name="Convert"s]' } };
    notes.push(`${dialogClick.id}: the dialog's own "Convert"`);
  }
  for (let i = at + 1; i < ir.steps.length; i++) {
    const s = ir.steps[i];
    if (s.action !== "assert") continue;
    // "was created" after the dialog is the Lead's own earlier toast (run 2026-11-12T09-57-37-571Z-94237239
    // "passed" on it with nothing converted); "Converted" is also a path stage.
    // "was saved" is no conversion's message either (run 2026-11-13T14-47-12-463Z-4594d2b5 converted the Lead
    // and then failed waiting for it).
    if (/\bwas (created|saved)\b/i.test(s.target?.text ?? "")) { ir.steps.splice(i--, 1); notes.push(`${s.id}: "${(s.target?.text ?? "").trim()}" after Convert is no conversion message -> dropped`); continue; }
    const text = (s.target?.text ?? "").trim();
    if (!/\bconvert/i.test(text) || /your lead has been converted/i.test(text)) continue;
    // Any other wording of it ("Converted" is also a path stage; "was converted" is never shown: run
    // 2026-11-12T12-38-55-246Z-2a2e742f converted the Lead and failed on it) is Salesforce's own message.
    ir.steps[i] = { ...s, target: { text: "Your lead has been converted" }, assertion: "visible" };
    notes.push(`${s.id}: "${text}" -> checks "Your lead has been converted"`);
  }
  if (!ir.steps.slice(at + 1).some((s) => s.action === "assert" && /your lead has been converted/i.test(s.target?.text ?? ""))) {
    ir.steps.splice(at + 1, 0, { id: "sf-convert-wait", action: "wait", value: "3000" } as Step,
      { id: "sf-convert-done", action: "assert", target: { text: "Your lead has been converted" }, assertion: "visible" } as Step);
    notes.push(`the conversion is checked by Salesforce's own "Your lead has been converted"`);
  }
  return notes;
}

/**
 * A check that a calculated field's LABEL is visible ("Expected Revenue") checks nothing about its value
 * (run 2026-11-12T09-37-44-530Z-ffcf8ece). On a record the case saved, it becomes a read of the value the
 * page shows for that field (generator sfFieldShown), which the API check compares with the value
 * Salesforce computed. Returns notes.
 */
export function calculatedFieldReads(ir: IRSteps, org: Pick<SalesforceOrgModel, "objects"> | undefined): string[] {
  const notes: string[] = [];
  let form: string | null = null;
  let on: string | null = null;
  ir.steps.forEach((s, i) => {
    if (s.action === "navigate") { form = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "")?.[1] ?? null; on = recordRefObject(s.target?.url) ?? (form ? null : on); return; }
    if (s.action === "click" && isSave(s) && form) { on = form; form = null; return; }
    if (s.action !== "assert" || s.assertion !== "visible" || !s.target?.text || !on) return;
    const o = org?.objects.find((x) => x.api === on);
    const c = o?.calculated?.find((x) => lineKey(x.label) === lineKey(s.target!.text!));
    if (!c) return;
    ir.steps[i] = { id: `sf-calc-${s.id}`, action: "assert", target: { field: c.label }, assertion: "visible" } as Step;
    notes.push(`${s.id}: "${c.label}" is calculated -> reads the value it shows, for the API check`);
  });
  return notes;
}

/**
 * A custom link the request names ("…then check its Delivery Status link opens the FedEx tracking page"),
 * on a record the case saved: the record is opened again, its Details tab (where the "Custom Links"
 * section is), and the link is checked by the address it opens. That address is the link's URL with its
 * {!merge} fields filled from what the case typed; past the first one the case did not type, only the
 * part before it is checked. The case's own steps on the link after the Save (a click that opens a new
 * tab, a check of an address) are replaced. A custom button is checked the same way, from the record header.
 */
export function customLinkSteps(ir: IRSteps, org: Pick<SalesforceOrgModel, "objects" | "customLinks"> | undefined, request: string): string[] {
  // Named AS a link or button ("its Delivery Status link", "the TB Search Deal button", or in quotes): the
  // org's "Billing" link is no reason to click anything for "a billing address in Toronto" (run
  // 2026-11-13T12-26-08-557Z-f7e2c00c clicked it and failed).
  const req = ` ${lineKey(request)} `;
  const named = (org?.customLinks ?? []).filter((l) => {
    const k = lineKey(l.label);
    return new RegExp(` ${k} (custom )?(link|button|url)s? | (link|button) (called |named )?${k} `).test(req)
      || new RegExp(`["“']${l.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["”']`, "i").test(request);
  });
  // "TB Delivery Status" names that link, not also the "Delivery Status" inside its words.
  const asked = named.filter((l) => !named.some((m) => m !== l && m.object === l.object && lineKey(m.label).length > lineKey(l.label).length
    && ` ${lineKey(m.label)} `.includes(` ${lineKey(l.label)} `)));
  if (!asked.length) return [];
  // The records the case saved, by object, in order (recordRef numbers them the same way).
  let form: string | null = null;
  const saves: { object: string; at: number; n: number }[] = [];
  ir.steps.forEach((s, i) => {
    if (s.action === "navigate") { form = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "")?.[1] ?? null; return; }
    if (s.action === "click" && isSave(s) && form) {
      saves.push({ object: form, at: i, n: saves.filter((x) => x.object === form).length + 1 });
      form = null;
    }
  });
  const notes: string[] = [];
  for (const link of asked) {
    const saved = saves.filter((x) => x.object === link.object).at(-1);
    if (!saved) continue;
    const o = org!.objects.find((x) => x.api === link.object);
    // What the case typed, by field label, before that Save.
    const typed = new Map<string, string>();
    for (const s of ir.steps.slice(0, saved.at)) {
      const label = s.target?.field ?? s.target?.name;
      if ((s.action === "fill" || s.action === "select") && label && typeof s.value === "string") typed.set(lineKey(label), s.value);
    }
    let expected = "";
    let rest = link.url;
    for (let m = /\{!\s*([^}]+?)\s*\}/.exec(rest); m; m = /\{!\s*([^}]+?)\s*\}/.exec(rest)) {
      // {!Opportunity_Tracking_Number} or {!Opportunity.TrackingNumber__c}: the field after the object.
      const name = m[1].replace(new RegExp(`^(${link.object}|${(o?.label ?? link.object).replace(/\W+/g, "_")})[._]`, "i"), "");
      const f = o?.fields.find((x) => x.api.toLowerCase() === name.toLowerCase() || lineKey(x.label) === lineKey(name.replace(/_/g, " ")));
      const value = f ? typed.get(lineKey(f.label)) : undefined;
      if (value === undefined || hasRunToken(value)) { expected += rest.slice(0, m.index); rest = ""; break; }
      expected += rest.slice(0, m.index) + encodeURIComponent(value);
      rest = rest.slice(m.index + m[0].length);
    }
    expected += rest;
    // The record's own Name merge ({!Account_Name}) is cut above unless typed; an address cut to nothing
    // proves nothing.
    if (!/^(https?:\/\/[^/?#]+|\/[^?#]+)/.test(expected)) continue;
    // The case's own steps on this link, or on an opened address, after the Save.
    const before = ir.steps.length;
    ir.steps = ir.steps.filter((s, i) => i <= saved.at || !(
      (s.target?.name && lineKey(s.target.name) === lineKey(link.label))
      || (s.target?.text && lineKey(s.target.text) === lineKey(link.label))
      || (s.action === "assert" && s.assertion === "url_contains")));
    const added: Step[] = link.kind === "link" ? [
      { id: `sf-cl-open-${notes.length}`, action: "navigate", target: { url: recordRef(link.object, saved.n) } } as Step,
      { id: `sf-cl-details-${notes.length}`, action: "click", target: { role: "tab", name: "Details" } } as Step,
      { id: `sf-cl-wait-${notes.length}`, action: "wait", value: "1500" } as Step,
      // The link's own text, which scrolls it into view: Lightning draws the section without its "Custom
      // Links" heading (run 2026-11-13T08-00-06-682Z-51e74c8b: "Delivery Status" shown, no heading).
      { id: `sf-cl-shown-${notes.length}`, action: "assert", target: { text: link.label }, assertion: "visible" } as Step,
      { id: `sf-cl-check-${notes.length}`, action: "assert", target: { role: "link", name: link.label }, assertion: "opens_url_contains", value: expected } as Step,
    ] : [
      // A custom button is under the record header's "Show more actions" menu: Lightning shows only the
      // first few actions (run 2026-11-13T08-38-54-510Z-c42b0bec: Follow, Edit, New Case, New Note, then the
      // menu). Opened as a step of its own, so grounding sees the menu item. Where the header shows the
      // button itself, the spec clicks that instead.
      { id: `sf-cl-open-${notes.length}`, action: "navigate", target: { url: recordRef(link.object, saved.n) } } as Step,
      { id: `sf-cl-wait-${notes.length}`, action: "wait", value: "2000" } as Step,
      { id: `sf-cl-menu-${notes.length}`, action: "click", target: { role: "button", name: "Show more actions" } } as Step,
      { id: `sf-cl-wait-menu-${notes.length}`, action: "wait", value: "800" } as Step,
      { id: `sf-cl-check-${notes.length}`, action: "assert", target: { role: "menuitem", name: link.label }, assertion: "opens_url_contains", value: expected } as Step,
    ];
    ir.steps.push(...added);
    notes.push(`the ${o?.label ?? link.object}'s custom ${link.kind} "${link.label}" -> checks it opens "${expected}"${before > ir.steps.length - added.length ? ` (replacing ${before - (ir.steps.length - added.length)} step(s) of the case's)` : ""}`);
  }
  return notes;
}

/**
 * Phase C, an approval done the way Lightning does it, when the request asks for one ("submit it for
 * approval, then approve it and verify its Description shows TB Approved") on an object with an approval
 * process: the case writer left the approval steps out in runs 2026-11-12T09-57-07-371Z-96fab553 and
 * 2026-11-12T10-04-34-678Z-eff2eb27. Added after the record's confirmed Save: Submit for Approval (from the
 * actions menu) with a comment; then, when asked, the decision from the record's Related tab ("Approve" or
 * "Reject", a comment, the dialog's button); then the field the request names, checked on the record.
 * Nothing is added when a step already submits. Returns notes.
 */
export function approvalSteps(ir: IRSteps, org: Pick<SalesforceOrgModel, "objects" | "approvals"> | undefined, request: string, approverSignIn?: string): string[] {
  const approval = org?.approvals?.[0] && /\bsubmit\w*\b[^.]*\bapproval\b/i.test(request) ? org.approvals : undefined;
  if (!approval) return [];
  // The record: the last one the case saved on an object with an approval process.
  let form: string | null = null;
  let saved: { object: string; at: number; n: number } | null = null;
  const count = new Map<string, number>();
  ir.steps.forEach((s, i) => {
    if (s.action === "navigate") { form = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "")?.[1] ?? null; return; }
    if (s.action === "click" && isSave(s) && form) {
      const n = (count.get(form) ?? 0) + 1;
      count.set(form, n);
      if (approval.some((a) => a.object === form)) saved = { object: form, at: i, n };
      form = null;
    }
  });
  if (!saved) return [];
  const { object, n } = saved as { object: string; at: number; n: number };
  // Lazy: "submit it for approval, then recall the approval request" keeps "then recall …".
  const after = request.replace(/\bsubmit\w*\b[^.]*?\bapproval\b/i, "");
  // Recall: the submitter pulls the request back (same Approval History menu, a "Recall Approval Request"
  // dialog; checked live 2026-11-13, the API then says Removed).
  const decision = /\b(recall\w*|withdr[ae]w\w*)\b/i.test(after) ? "Recall"
    : /\breject\w*\b/i.test(after) ? "Reject"
    : /\bapprov(e|es|ed|ing)\b/i.test(after) ? "Approve" : null;
  const dialog = (name: string) => ({ role: "button", name, css: `role=dialog >> role=button[name="${name}"s]` });
  // The dialog's own Comments box: the generic "a field near Comments in the last open modal" lookup found
  // a part of the dialog's footer instead in round 2 (run 2026-11-13T09-41-55-553Z-49dcdab1, the dialog open).
  const comments = { role: "textbox", name: "Comments", css: 'role=dialog >> role=textbox[name="Comments"s]' };
  // The case's own submission (runs 2026-11-12T13-02-29-047Z-33e9cc1b and -13-03-30-475Z-d74a26c5 submitted
  // correctly, then wandered: an "Approval History(0)" link, a task's menu, never the approver) is kept up
  // to its confirmation; everything after it is this pass's. Without one, the submission is added too.
  const submitAt = ir.steps.findIndex((s) => s.action === "click" && /^submit for approval$/i.test(s.target?.name ?? ""));
  let at: number;
  const steps: Step[] = [];
  // A submission the case left half done (run 2026-11-13T04-55-33-374Z-b71d138e opened "Submit for Approval"
  // and stopped) is replaced by the whole one below.
  const send = submitAt < 0 ? -1 : ir.steps.findIndex((s, i) => i > submitAt && s.action === "click" && /^submit$/i.test(s.target?.name ?? ""));
  if (submitAt >= 0 && send >= 0) {
    // The case's menu click before "Submit for Approval" is the RECORD's "Show more actions", by its exact
    // name: run 2026-11-13T09-29-33-938Z-d995d351 had it grounded to a task row's "Show more actions - TB
    // Review large deal" (by a CSS path into the activity list) and the whole approval was cut.
    for (let i = submitAt - 1; i >= 0 && i >= submitAt - 3; i--) {
      const s = ir.steps[i];
      if (s.action === "click" && /^show more actions\b/i.test(s.target?.name ?? "")) {
        ir.steps[i] = { ...s, target: { role: "button", name: "Show more actions" } };
        break;
      }
    }
    at = send + 1;
    while (at < ir.steps.length && (ir.steps[at].action === "wait" || (ir.steps[at].action === "assert" && /submitted/i.test(ir.steps[at].target?.text ?? "")))) at++;
    if (!decision && !ir.steps.slice(at).some((s) => s.action !== "wait")) return [];
    if (!ir.steps.slice(send, at).some((s) => s.action === "assert")) steps.push({ id: "sf-ap-sent", action: "assert", target: { text: "submitted for approval" }, assertion: "visible" } as Step);
  } else {
    at = (saved as { at: number }).at + 1;
    while (at < ir.steps.length && (ir.steps[at].action === "wait" || (ir.steps[at].action === "assert" && /\bwas created\b/.test(ir.steps[at].target?.text ?? "")))) at++;
    // "Submit for Approval" is in the record's actions menu (run 2026-11-12T12-27-14-303Z-faacdd52 submitted there).
    steps.push(
      { id: "sf-ap-menu", action: "click", target: { role: "button", name: "Show more actions" } } as Step,
      { id: "sf-ap-submit", action: "click", target: { role: "menuitem", name: "Submit for Approval" } } as Step,
      { id: "sf-ap-wait", action: "wait", value: "1500" } as Step,
      { id: "sf-ap-comment", action: "fill", target: comments, value: "Testbench approval test" } as Step,
      { id: "sf-ap-send", action: "click", target: dialog("Submit") } as Step,
      { id: "sf-ap-sent", action: "assert", target: { text: "submitted for approval" }, assertion: "visible" } as Step,
    );
  }
  // What the case wrote after that is not the approval (a check of the outcome before the decision, a click
  // elsewhere). The request's own check is added at the end instead.
  const dropped = ir.steps.length - at;
  ir.steps.splice(at);
  if (decision) {
    // Phase C, two users: the approver decides. The same browser signs in as them (approverSignIn is the
    // run's second user, SECOND_USER_REF) and opens the record the first user created.
    // A recall is the submitter's own action: no switch to the approver.
    if (approverSignIn && decision !== "Recall") steps.push({ id: "sf-ap-as-approver", action: "navigate", target: { url: approverSignIn } } as Step);
    // A multi-step approval the request asks to take through ("approve both steps"): one decision per
    // step of the object's longest process. Each approval opens the next step's request. A rejection
    // or a recall ends the request at once.
    const most = Math.max(1, ...approval.filter((a) => a.object === object).map((a) => a.steps?.length ?? 1));
    const rounds = decision === "Approve" && /\b(both|all|each|every|two|2|three|3)\s+(approval\s+)?steps?\b|\bmulti-?step\b|\btwice\b|\bevery approver\b/i.test(request) ? most : 1;
    for (let k = 0; k < rounds; k++) {
      const x = k ? `-${k + 1}` : "";
      steps.push(
        { id: `sf-ap-open${x}`, action: "navigate", target: { url: recordRef(object, n) } } as Step,
        { id: `sf-ap-related${x}`, action: "click", target: { role: "tab", name: "Related" } } as Step,
        { id: `sf-ap-wait2${x}`, action: "wait", value: "1500" } as Step,
        // The Approval History list keeps Approve / Reject behind its own actions menu (run
        // 2026-11-12T13-02-29-047Z-33e9cc1b: "Show actions for Approval History", no Approve button on the page).
        { id: `sf-ap-actions${x}`, action: "click", target: { role: "button", name: "Show actions for Approval History" } } as Step,
        { id: `sf-ap-wait-menu${x}`, action: "wait", value: "800" } as Step,
        { id: `sf-ap-decide${x}`, action: "click", target: { role: "menuitem", name: decision } } as Step,
        { id: `sf-ap-wait3${x}`, action: "wait", value: "1500" } as Step,
        { id: `sf-ap-comment2${x}`, action: "fill", target: comments, value: `Testbench ${decision.toLowerCase()} test${x ? ` (step ${k + 1})` : ""}` } as Step,
        { id: `sf-ap-confirm${x}`, action: "click", target: dialog(decision) } as Step,
        { id: `sf-ap-wait4${x}`, action: "wait", value: "2500" } as Step,
      );
    }
  }
  // The field the request names ("its Description shows TB Approved"), on the record after the decision.
  const o = org!.objects.find((x) => x.api === object);
  const m = /\b(?:its\s+|the\s+)?([A-Z][\w ]*?)\s+(?:shows|is|says|reads)\s+["“]?([^".,;”]+?)["”]?\s*(?:$|[.,;])/.exec(request);
  const f = m && o?.fields.find((x) => lineKey(x.label) === lineKey(m[1]));
  if (m && f) {
    steps.push({ id: "sf-ap-reopen", action: "navigate", target: { url: recordRef(object, n) } } as Step,
      { id: `sf-ap-check-${f.api}`, action: "assert", target: { field: f.label }, assertion: "text_contains", value: m[2].trim() } as Step);
  }
  ir.steps.push(...steps);
  return [`the request ${decision ? `submits and ${decision === "Approve" ? "approves" : decision === "Reject" ? "rejects" : "recalls"}` : "submits"} the ${o?.label ?? object} for approval -> the approval steps${dropped ? ` (replacing ${dropped} step(s) after the Save)` : ""}${m && f ? `, then checks ${f.label} shows "${m[2].trim()}"` : ""}`];
}
