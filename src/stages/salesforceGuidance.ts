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
import { currentFrontdoor, recordRef, recordRefObject } from "./salesforceFrontdoor.js";
import { hasRunToken, lineKey, shownNumber } from "../text.js";
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
    plan: `- The run is ALREADY SIGNED IN through its org connection: plan no login, username or password step. Reach an object by its Lightning URL, which the application model holds: its list page at /lightning/o/<Object>/list (or the object's page listed in the model) and its create form at /lightning/o/<Object>/new. Never route through the App Launcher, app tiles or the navigation bar to reach an object. (Backed by: discovery models each create form at that URL; the navigate-URL guard accepts only paths in the model, TD-82.)`,
    cases: `- The run is already signed in through its org connection: write no login step. The usual record flows: to create a record, open /lightning/o/<Object>/new directly (the form is modelled there, as a modal dialog), fill the required fields, Save; to see records, open the object's list page from the model. Never route through the App Launcher or the navigation bar; edit only a record the test created; Cancel out of the form.
- Stay on the object and the flow the request names: every case is about that object's records (create, its required fields, its validation rules, its picklists). Do not add cases about global search, the App Launcher, the navigation bar, notifications or another object unless the request asks for them; a coverage checklist item that does not fit the requested object is skipped, not stretched to fit.
- A case that creates a record ends its name fields (Last Name, Company, Account Name, a record Name) with the token {{uid}}, e.g. "Smith {{uid}}": the run replaces it with a unique code, so the org's duplicate rules never block a repeat run. Never put {{uid}} in a field a validation rule reads (Phone, Email, Country) and never in an expected result.
- An invalid-FORMAT case only where Salesforce checks a format: Email, Date, Number, Currency and Percent fields, or a field a validation rule reads. A Phone, Text or URL field accepts any text and saves it, so "an invalid phone is rejected" fails against a healthy org (run 2026-10-25T06-38-05-163Z-3a6663ef).
- A create case fills the required fields and the fields a validation rule reads, and no other field unless the request names it. A lookup field (Account Name on a Contact, Parent Account) needs an existing record: leave it alone unless it is required or the request names it. When the request names several objects, write one create case per object, never one case that creates them all: a failure in one object must not hide the others. (Backed by: the test-data pass drops unrequested optional fields and splits nothing — a combined case stays combined, so write them apart.)`,
    ir: `- The run is already signed in through its org connection: the sign-in step is supplied; write no login, username or password step. Reach a page with "navigate" to a path that is in the application model: /lightning/o/<Object>/new opens the create form as a modal dialog and its fields are in that page's model. Never click through the App Launcher or the navigation bar to reach an object. (Backed by: the navigate-URL guard, TD-82.)
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
- Clone: the record page's "Clone" (in the header or its actions menu, "Show more actions") opens a "New <Object>" dialog filled with the record's values; change the name, Save; Salesforce shows "was created". (Backed by: strengthenSaveOutcome.)
- Delete: only the record THIS case created, from the record page its Save opened: "Delete" (in the header or "Show more actions"), then the confirm dialog's "Delete"; Salesforce shows "was deleted". (Backed by: deleteOutsideOwnRecord, which refuses any other delete before the steps are replayed, and strengthenSaveOutcome.)
- A quick action on a record page ("New Contact", "Log a Call") opens a dialog with its own fields; fill them and Save; a "New ..." action shows "was created". (Backed by: strengthenSaveOutcome.)
- A flow's effect (a field it sets after the save, a record it creates) appears on the new record's page a moment after the toast: add a "wait" of 2000 after the Save, then assert the field by its label and the value the flow sets (as the org model's automation line states it). (No deterministic check.)
- A field the org model lists as "calculated" (formula, roll-up summary) is read-only: never fill it; after the Save, assert it on the record page by its label and, when the value follows from the case's own inputs, the value. (Backed by: the test data pass, which drops any step typing into one.)
- If the page shows an identity-verification or "verify your identity" screen, the case cannot continue: end it there rather than guessing a code.`;

const byStage = (route: Route): Record<GuidanceStage, string> =>
  ({ plan: PLAN(route), cases: CASES(route), ir: IR(route) });

const isSave = (s: Step) => /^save$/i.test(s.target?.name ?? "");

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
  for (let i = 0; i < del; i++) {
    const s = steps[i];
    if (s.action === "navigate" && /\/lightning\/o\/[^/?#]+\/new\b/.test(s.target?.url ?? "")) opened = true;
    if (s.action === "click" && /^(new\b.*|clone)$/i.test(s.target?.name ?? "")) opened = true;
    if (s.action === "click" && opened && isSave(s)) saved = i;
  }
  if (saved < 0) {
    return `Step ${steps[del].id} deletes a record this case did not create. A case may delete only the record it creates itself: create it (its create form, Save), then delete it from the record page that Save opens.`;
  }
  const away = steps.slice(saved + 1, del).find((s) => s.action === "navigate" || (s.action === "click" && s.target?.role === "link"));
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
 * Save would never happen), and not when the flow went looking for it since the last Save (anything
 * but navigates, waits and asserts: the object's tab clicked, the name typed into a search; or the
 * object's list or home page): finding it there may be what the case checks. Returns notes.
 */
export function returnToCreatedRecords(ir: IRSteps): string[] {
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
    const looked = ir.steps.slice(lastSave + 1, i).some((x) => !["navigate", "wait", "assert"].includes(x.action)
      || (x.action === "navigate" && new RegExp(`/lightning/o/${object}/(list|home)\\b`).test(x.target?.url ?? "")));
    if (looked) continue;
    ir.steps[i] = { id: s.id, action: "navigate", target: { url: recordRef(object, rec.n) } };
    notes.push(`${s.id}: clicks "${name}", the name this case typed for the ${object} it created -> opens that ${object} record directly`);
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
  salesforceOrg?: { objects: { fields: { label: string; picklist?: string[] }[]; calculated?: { label: string }[] }[] };
}): string[] {
  const steps = ir.steps;
  const hasDetailsTab = model.pages.some((p) => /\/lightning\/r\//.test(p.url)
    && p.elements.some((e) => e.role === "tab" && e.name === "Details"));
  // A text check naming one of the org's fields is a field check too ("Expected Revenue", run
  // 2026-10-26T07-23-19-810Z-0d14eb03: the Opportunity page opened on Activity, the field on Details).
  const fields: { label: string; picklist?: string[] }[] = (model.salesforceOrg?.objects ?? [])
    .flatMap((o) => [...o.fields, ...(o.calculated ?? [])]);
  const fieldLabels = new Set(fields.map((f) => f.label));
  const notes: string[] = [];
  let saved = false;
  let onView = false;
  let onDetails = false;
  let tabs = 0;
  /** The field whose label the previous check (waits aside) looked for. */
  let lastLabel: string | undefined;
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
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
    const text = s.target?.text ?? "";
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
