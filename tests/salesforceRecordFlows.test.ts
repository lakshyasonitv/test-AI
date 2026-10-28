import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "@playwright/test";
import { recordPages, recordRef, recordRefIndex, recordRefObject } from "../src/stages/salesforceFrontdoor.js";
import { SF_FIELD_MATCH_JS, generateSpec } from "../src/stages/generator.js";
import { prepareReplayPage, runStepLive } from "../src/stages/liveExtend.js";
import { groundingError, trackPages } from "../src/stages/ir.js";
import { stepsMissingValues } from "../src/stages/requestValues.js";
import type { IR, Step } from "../src/schema/ir.js";
import type { AppModel } from "../src/schema/appModel.js";

/**
 * Phase A, executed. Two pieces of a Salesforce case that only exist when the test RUNS:
 *  - going back to the record the case created (recordRef): run 2026-10-26T07-23-21-344Z-9cd29004 saved
 *    an Opportunity for its new Account and could not get back to the Account. Every 2026-10-26 run
 *    ended on `/lightning/r/<Id>/view`, with no object in it, so the record a create's Save opened is
 *    known by the create form before it, not by its URL;
 *  - a field's VALUE read inside that field's own block, not anywhere on the page.
 * The helpers are lifted out of a REAL generated spec (as assertGoneBrowser.test.ts does), so what runs
 * here is what a spec runs. Hosts, objects, ids and values are made-up canaries.
 */

const BASE = "https://zq.example";
const PARENT_ID = "a0P000000000001AAA";
const CHILD_ID = "a0C000000000002AAA";

const spec = (steps: Step[]): string => generateSpec({
  meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: BASE },
  steps: [{ id: "auth-0", action: "navigate", target: { url: "${env:SF_FRONTDOOR_URL}" } }, ...steps],
} as unknown as IR);

/** From `start` to the end of the first function declared at or after it (braces counted). */
function lift(src: string, start: string, fn: string): string {
  const at = src.indexOf(start);
  const f = src.indexOf(fn, at);
  if (at < 0 || f < 0) throw new Error(`generated spec has no ${fn}`);
  let depth = 0;
  for (let i = src.indexOf("{", f); i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error("unbalanced");
}

const valueCheck = (field: string, value: string, assertion = "text_contains"): Step =>
  ({ id: "v", action: "assert", target: { field }, assertion, value } as Step);
const back = (object: string, n = 1): Step => ({ id: "b", action: "navigate", target: { url: recordRef(object, n) } } as Step);

describe("recordRef", () => {
  it("names one object and which of its created records, and nothing else reads as one", () => {
    expect(recordRefObject(recordRef("Zq_Parent__c", 2))).toBe("Zq_Parent__c");
    expect(recordRefIndex(recordRef("Zq_Parent__c", 2))).toBe(2);
    for (const u of ["/lightning/o/Zq_Parent__c/new", "${env:SF_FRONTDOOR_URL}", "${record:}", "${record:Zq_Parent__c}", "${record:Zq_Parent__c:0}", undefined]) {
      expect(recordRefObject(u), String(u)).toBeNull();
      expect(recordRefIndex(u), String(u)).toBeNull();
    }
  });
});

describe("recordPages: the records this browser created, and only those", () => {
  it("the record page right after a create form is the record it created, object in the URL or not", () => {
    const p = recordPages();
    p.visit(`${BASE}/lightning/o/Zq_Parent__c/new?count=1`);
    p.visit(`${BASE}/lightning/r/${PARENT_ID}/view`);
    p.visit(`${BASE}/lightning/o/Zq_Child__c/new?count=1`);
    p.visit(`${BASE}/lightning/r/Zq_Child__c/${CHILD_ID}/view`);
    p.visit(`${BASE}/`);
    expect(p.created("Zq_Parent__c", 1)).toBe(PARENT_ID);
    expect(p.created("Zq_Child__c", 1)).toBe(CHILD_ID);
    // Another parent opened by its link later (no create form before it) was not created by this test.
    p.visit(`${BASE}/lightning/r/a0P000000000009AAA/view`);
    p.visit(`${BASE}/lightning/r/Zq_Parent__c/a0P000000000008AAA/view`);
    expect(p.created("Zq_Parent__c", 1)).toBe(PARENT_ID);
    expect(p.created("Zq_Parent__c", 2)).toBeNull();
  });

  it("two records of ONE object (a parent and its child) are the first and the second it created", () => {
    const p = recordPages();
    for (const id of ["a0A000000000001AAA", "a0A000000000002AAA"]) {
      p.visit(`${BASE}/lightning/o/Zq_Acct__c/new?count=1`);
      p.visit(`${BASE}/lightning/r/${id}/view`);
    }
    // The child's page shows its parent's link; opening the parent again is not a third record.
    p.visit(`${BASE}/lightning/r/a0A000000000001AAA/view`);
    expect([1, 2, 3].map((n) => p.created("Zq_Acct__c", n))).toEqual(["a0A000000000001AAA", "a0A000000000002AAA", null]);
  });

  it("a page of another object, a page seen before, or one opened after leaving the form is not the form's record", () => {
    const p = recordPages();
    // The URL names another object, or the id's prefix is another object's.
    p.visit(`${BASE}/lightning/r/Zq_Parent__c/${PARENT_ID}/view`);
    p.visit(`${BASE}/lightning/o/Zq_Child__c/new`);
    p.visit(`${BASE}/lightning/r/a0P000000000003AAA/view`);
    p.visit(`${BASE}/lightning/o/Zq_Child__c/new`);
    p.visit(`${BASE}/lightning/r/Zq_Parent__c/a0P000000000004AAA/view`);
    // Cancelled back to the record it was opened from.
    p.visit(`${BASE}/lightning/o/Zq_Parent__c/new`);
    p.visit(`${BASE}/lightning/r/${PARENT_ID}/view`);
    // Left for the list, then an existing record opened from it.
    p.visit(`${BASE}/lightning/o/Zq_Parent__c/new`);
    p.visit(`${BASE}/lightning/o/Zq_Parent__c/list?filterName=Recent`);
    p.visit(`${BASE}/lightning/r/a0P000000000005AAA/view`);
    // Related-list pages are not record pages.
    p.visit(`${BASE}/lightning/o/Zq_Parent__c/new`);
    p.visit(`${BASE}/lightning/r/Zq_Parent__c/a0P000000000006AAA/related/Zq_Children__r/view`);
    expect(p.created("Zq_Parent__c", 1)).toBeNull();
    expect(p.created("Zq_Child__c", 1)).toBeNull();
  });
});

describe("SF_FIELD_MATCH_JS: does a field block show the value", () => {
  const match = new Function(`return (${SF_FIELD_MATCH_JS});`)() as (lines: string[], label: string, expected: string, mode: string) => boolean;
  const block = (label: string, value: string) => [label, value, `Edit ${label}`];

  it("numbers compare as numbers, whatever the formatting", () => {
    for (const want of ["5000", "5,000", "$5,000.00", "5000.00"]) expect(match(block("Zq Total", "$5,000.00"), "Zq Total", want, "contains"), want).toBe(true);
    expect(match(block("Zq Total", "5.000,00 €"), "Zq Total", "5000", "equals")).toBe(true);
    expect(match(block("Zq Rate", "10%"), "Zq Rate", "10", "equals")).toBe(true);
    expect(match(block("Zq Total", "$1,000.00"), "Zq Total", "100", "contains")).toBe(false);
    expect(match(block("Zq Total", "$5,000.00"), "Zq Total", "500", "contains")).toBe(false);
  });

  it("text compares as text; the label and its pencil are not the value", () => {
    expect(match(block("Zq Heat", "Zq Hot"), "Zq Heat", "Zq Hot", "equals")).toBe(true);
    expect(match(block("Zq Heat", "Zq Hot"), "Zq Heat", "Hot", "contains")).toBe(true);
    expect(match(block("Zq Heat", "Zq Hot"), "Zq Heat", "Hot", "equals")).toBe(false);
    expect(match(block("Zq Heat", ""), "Zq Heat", "Zq Heat", "equals")).toBe(false);
    expect(match(["Zq Due", "11/25/2026"], "Zq Due", "11/25/2026", "equals")).toBe(true);
    expect(match(["Zq Total $5,000.00"], "Zq Total", "5000", "equals")).toBe(true);
  });
});

describe("generateSpec: emitted only when used", () => {
  it("a step back to a created record opens it through sfOpenRecord; a field value check reads the field", () => {
    const s = spec([back("Zq_Parent__c"), valueCheck("Zq Total", "5,000")]);
    expect(s).toContain(`await sfOpenRecord(page, "${BASE}", "Zq_Parent__c", 1);`);
    expect(s).toContain(`await sfReveal(page, "Zq Total");`);
    expect(s).toContain(`await sfFieldValue(page, "Zq Total", "5,000", "contains");`);
    expect(s).toContain("Go back to the Zq_Parent__c record this test created");
    expect(s).toContain("Assert 'Zq Total' contains '5,000'");
    expect(spec([back("Zq_Parent__c", 2)])).toContain("Go back to the Zq_Parent__c record this test created, number 2");
    for (const h of ["async function sfOpenRecord(", "async function sfFieldValue(", "async function sfReveal("]) expect(s).toContain(h);
  });

  it("a spec without them carries none of their code", () => {
    const s = spec([{ id: "n", action: "navigate", target: { url: "/lightning/o/Zq_Parent__c/new" } } as Step,
      { id: "a", action: "assert", target: { text: "Zq Total" }, assertion: "text_contains", value: "5,000" } as Step]);
    for (const h of ["sfOpenRecord", "sfFieldValue", "sfFieldMatch", "sfRecordPages"]) expect(s).not.toContain(h);
  });
});

describe("grounding: a step back to a created record", () => {
  const model = {
    baseUrl: BASE,
    pages: [
      { url: `${BASE}/lightning/o/Zq_Parent__c/new`, elements: [] },
      { url: `${BASE}/lightning/r/Zq_Parent__c/a0P000000000005AAA/view`, elements: [{ role: "tab", name: "Details", css: "#zq-details" }] },
    ],
  } as unknown as AppModel;
  const flow = {
    meta: { feature: "f", title: "t", priority: "high", sourcePrompt: "p", baseUrl: BASE },
    steps: [
      { id: "s1", action: "navigate", target: { url: "/lightning/o/Zq_Parent__c/new" } },
      { id: "s2", action: "navigate", target: { url: "/" } },
      { ...back("Zq_Parent__c"), id: "s3" },
      { id: "s4", action: "click", target: { role: "tab", name: "Details" } },
    ],
  } as unknown as IR;

  it("is not refused as a guessed route, and the flow is on that object's record page after it", () => {
    expect(groundingError(structuredClone(flow), model)).toBeNull();
    expect(trackPages(flow, model).pageAt[3]?.url).toBe(model.pages[1].url);
  });

  it("a field check carries its label for the request-values check", () => {
    expect(stepsMissingValues([valueCheck("Zq Total Amount", "5,000")], { steps: ["check Zq Total Amount"], expected: "" }, ["Zq Total Amount"])).toEqual([]);
  });
});

// A fake org: every create form has a Save that moves to the new record the way Lightning does after a
// Save — a same-document URL change to /lightning/r/<Id>/view (history.pushState), no object in it.
const PAGE = `<!doctype html><html><body><h1 id="where"></h1><button id="save">Save</button><script>
  const ids = { Zq_Parent__c: "${PARENT_ID}", Zq_Child__c: "${CHILD_ID}" };
  const m = /\\/lightning\\/o\\/([^/]+)\\/new/.exec(location.pathname);
  document.getElementById("where").textContent = location.pathname;
  document.getElementById("save").onclick = () => { if (m) history.pushState({}, "", "/lightning/r/" + ids[m[1]] + "/view"); };
</script></body></html>`;

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 120_000);
afterAll(async () => { await browser?.close(); });

const fakeOrg = async (): Promise<Page> => {
  const page = await browser.newPage();
  await page.route(`${BASE}/**`, (route) => route.fulfill({ contentType: "text/html", body: PAGE }));
  return page;
};

describe("sfOpenRecord, executed", () => {
  it("goes back to the parent this test created after the child's Save", async () => {
    const helper = lift(spec([back("Zq_Parent__c")]), "let sfRecordPages = null;", "async function sfOpenRecord(");
    const hooks: ((a: { page: Page }) => void)[] = [];
    const test = { beforeEach: (fn: (a: { page: Page }) => void) => hooks.push(fn) };
    const sfOpenRecord = new Function("test", `${helper}\nreturn sfOpenRecord;`)(test);
    const page = await fakeOrg();
    try {
      hooks.forEach((h) => h({ page }));
      for (const object of ["Zq_Parent__c", "Zq_Child__c"]) {
        await page.goto(`${BASE}/lightning/o/${object}/new?count=1`);
        await page.click("#save");
      }
      expect(page.url()).toBe(`${BASE}/lightning/r/${CHILD_ID}/view`);
      await sfOpenRecord(page, BASE, "Zq_Parent__c", 1);
      expect(page.url()).toBe(`${BASE}/lightning/r/Zq_Parent__c/${PARENT_ID}/view`);
      await sfOpenRecord(page, BASE, "Zq_Child__c", 1);
      expect(page.url()).toBe(`${BASE}/lightning/r/Zq_Child__c/${CHILD_ID}/view`);
      // Never another record of the object: opening one is not creating it.
      await expect(sfOpenRecord(page, BASE, "Zq_Parent__c", 2)).rejects.toThrow(/No Zq_Parent__c record this test created \(number 2\) was reached/);
      await expect(sfOpenRecord(page, BASE, "Zq_Other__c", 1)).rejects.toThrow(/No Zq_Other__c record this test created \(number 1\) was reached/);
    } finally { await page.close(); }
  }, 60_000);
});

describe("the grounding replay goes back the same way", () => {
  it("runStepLive opens the record the replayed flow created", async () => {
    const steps: Step[] = [
      { id: "s1", action: "navigate", target: { url: `${BASE}/lightning/o/Zq_Parent__c/new` } },
      { id: "s2", action: "click", target: { role: "button", name: "Save" } },
      { id: "s3", action: "navigate", target: { url: `${BASE}/lightning/o/Zq_Child__c/new` } },
      { id: "s4", action: "click", target: { role: "button", name: "Save" } },
      { ...back("Zq_Parent__c"), id: "s5" },
    ] as Step[];
    const page = await fakeOrg();
    try {
      prepareReplayPage(page, steps);
      for (const s of steps) await runStepLive(page, s, BASE);
      expect(page.url()).toBe(`${BASE}/lightning/r/Zq_Parent__c/${PARENT_ID}/view`);
    } finally { await page.close(); }
    // A page not prepared for it (no step back in its prefix) has nothing to go back to.
    const bare = await fakeOrg();
    try {
      await expect(runStepLive(bare, { ...back("Zq_Parent__c"), id: "s9" }, BASE)).rejects.toThrow(/no Zq_Parent__c record this test created \(number 1\) was reached before step s9/);
    } finally { await bare.close(); }
  }, 60_000);
});

// Lightning's record page in shape: each field is an SLDS form element holding its label and its
// value; a record layout item wraps it; some of it inside an open shadow root; a highlights panel at the
// top repeats a field; a tab not shown holds a stale copy.
const RECORD = `
<records-highlights-details-item><p class="slds-text-title" title="Zq Amount">Zq Amount</p><p>$5,000.00</p></records-highlights-details-item>
<section>
  <records-record-layout-item><div class="slds-form-element"><span class="test-id__field-label">Zq Amount</span>
    <div><span>$5,000.00</span><button><span class="slds-assistive-text">Edit Zq Amount</span></button></div></div></records-record-layout-item>
  <div id="host"></div>
  <div class="slds-form-element"><span>Zq Heat</span><div><span>Zq Hot</span></div></div>
</section>
<div style="display:none"><div class="slds-form-element"><span>Zq Total</span><div>$9,999.00</div></div></div>
<script>
  const root = document.getElementById("host").attachShadow({ mode: "open" });
  root.innerHTML = '<div class="slds-form-element"><span>Zq Total</span><div><span>$100.00</span></div></div>';
</script>`;

describe("sfFieldValue, executed", () => {
  let sfFieldValue: (page: Page, label: string, expected: string, mode: string) => Promise<void>;
  beforeAll(() => {
    const helper = lift(spec([valueCheck("Zq Total", "1")]), "const sfFieldMatch = ", "async function sfFieldValue(");
    // A short deadline, or every failing check below waits the spec's full assertion timeout.
    const quick = helper.replace(/const deadline = Date\.now\(\) \+ \d+;/, "const deadline = Date.now() + 600;");
    expect(quick).not.toBe(helper);
    sfFieldValue = new Function(`${quick}\nreturn sfFieldValue;`)();
  });

  const onRecord = async (): Promise<Page> => {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><html><body>${RECORD}</body></html>`);
    return page;
  };

  it("reads each field inside its own block, shadow DOM included", async () => {
    const page = await onRecord();
    try {
      await sfFieldValue(page, "Zq Total", "$100.00", "contains");
      await sfFieldValue(page, "Zq Total", "100", "equals");
      await sfFieldValue(page, "Zq Amount", "5000", "equals");
      await sfFieldValue(page, "Zq Heat", "Zq Hot", "equals");
    } finally { await page.close(); }
  }, 60_000);

  it("another field's value, or a hidden copy, is not this field's: it fails and says what the field shows", async () => {
    const page = await onRecord();
    try {
      // "$5,000.00" is on the page (Zq Amount) but not in Zq Total; "$9,999.00" is a hidden tab's copy.
      await expect(sfFieldValue(page, "Zq Total", "5,000", "contains")).rejects.toThrow(/The "Zq Total" field does not show "5,000": it shows "Zq Total \/ \$100\.00"/);
      await expect(sfFieldValue(page, "Zq Total", "9999", "contains")).rejects.toThrow(/does not show/);
      await expect(sfFieldValue(page, "Zq Missing", "1", "contains")).rejects.toThrow(/no visible field labelled "Zq Missing"/);
    } finally { await page.close(); }
  }, 60_000);
});
