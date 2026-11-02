import { describe, it, expect, afterAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  caseFromRun, touchedObjects, orgSnapshot, oneTimeValues, rememberForSave,
  HealedNeedsReviewError, regressionMemoryEnabled,
} from "../src/stages/regressionMemory.js";
import { IR } from "../src/schema/ir.js";

/**
 * D-73, regression testing step 1 "Remember": what a saved case keeps beyond its steps. All names
 * below are made-up canaries; the org shape matches what the org model writes (salesforceOrgModel.ts).
 */

const root = mkdtempSync(path.join(os.tmpdir(), "zq-mem-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const write = (rel: string, data: unknown) => {
  const f = path.join(root, rel);
  mkdirSync(path.dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(data));
  return f;
};

const ir = (over: Partial<IR["meta"]> = {}, steps?: any[]): IR => IR.parse({
  meta: { feature: "f", title: "Create a Zq Deal", priority: "high", sourcePrompt: "p", baseUrl: "https://zq-dev.scratch.lightning.force.com", ...over },
  steps: steps ?? [
    { id: "auth-0", action: "navigate", target: { url: "${env:SF_FRONTDOOR_URL}" } },
    { id: "s1", action: "navigate", target: { url: "/lightning/o/Zq_Deal__c/new?count=1" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name", css: "input[name=\"Name\"]" }, value: "Zq Deal {{uid}}" },
    { id: "s3", action: "click", target: { role: "button", name: "Save" } },
    { id: "s4", action: "assert", target: { text: "was created" }, assertion: "visible" },
  ],
});

const cases = [
  { title: "Create a Zq Deal", steps: ["Go to the Zq Deal form.", "Type a name.", "Click Save."], expected: "The deal is created.", intent: "Create a deal", category: "valid" },
  { title: "Save a Zq Deal with the name empty", steps: ["Click Save."], expected: "An error shows.", category: "empty-boundary" },
];
const appModel = { pages: [], salesforceOrg: {
  userLocale: "en_GB", validationRulesRead: true,
  objects: [
    { api: "Zq_Deal__c", label: "Zq Deal", fields: [{ label: "Zq Name", api: "Name", type: "String", required: true }] },
    { api: "Zq_Other__c", label: "Zq Other", fields: [] },
  ],
  flows: [{ label: "Zq Deal flow", api: "Zq_Deal_Flow", type: "record-triggered", object: "Zq Deal" }, { label: "Zq x", api: "x", type: "screen" }],
} };

describe("regressionMemoryEnabled", () => {
  afterEach(() => { delete process.env.REGRESSION_MEMORY_ENABLED; });
  it("is off unless asked for", () => {
    expect(regressionMemoryEnabled()).toBe(false);
    process.env.REGRESSION_MEMORY_ENABLED = "true";
    expect(regressionMemoryEnabled()).toBe(true);
  });
});

describe("caseFromRun: the plain-English case a run compiled case-N from", () => {
  write("r1/03-cases.json", cases);
  it("takes case-N by position, cross-checked by title", () => {
    expect(caseFromRun(path.join(root, "r1"), "case-1", "Save a Zq Deal with the name empty")?.category).toBe("empty-boundary");
  });
  it("falls back to the title when the position does not match", () => {
    expect(caseFromRun(path.join(root, "r1"), "case-0", "Save a Zq Deal with the name empty")?.title).toBe("Save a Zq Deal with the name empty");
  });
  it("null when the run has no cases file", () => {
    expect(caseFromRun(path.join(root, "none"), "case-0")).toBeNull();
  });
});

describe("touchedObjects and orgSnapshot", () => {
  it("reads create forms, record pages and returns to a record", () => {
    const x = ir({}, [
      { id: "s1", action: "navigate", target: { url: "/lightning/o/Zq_Deal__c/new?count=1" } },
      { id: "s2", action: "navigate", target: { url: "/lightning/r/Account/001Zq00000AbCdE/view" } },
      { id: "s3", action: "navigate", target: { url: "${record:Contact}" } },
    ]);
    expect(touchedObjects(x).sort()).toEqual(["Account", "Contact", "Zq_Deal__c"]);
  });
  it("keeps only the touched objects and the flows on them", () => {
    const snap = orgSnapshot(appModel, ["Zq_Deal__c"], "https://zq-dev.scratch.lightning.force.com")!;
    expect(snap.host).toBe("zq-dev.scratch.lightning.force.com");
    expect(snap.objects.map((o: any) => o.api)).toEqual(["Zq_Deal__c"]);
    expect(snap.flows?.map((f: any) => f.api)).toEqual(["Zq_Deal_Flow"]);
    expect(snap.userLocale).toBe("en_GB");
  });
  it("nothing for an ordinary site (no org model) or a case touching no object", () => {
    expect(orgSnapshot({ pages: [] }, ["Zq_Deal__c"], "https://zq.example")).toBeUndefined();
    expect(orgSnapshot(appModel, [], "https://zq.example")).toBeUndefined();
  });
});

describe("oneTimeValues: values that cannot be replayed as saved", () => {
  it("flags an org record id and a fixed date; never a run token, a check, or ordinary text", () => {
    const x = ir({}, [
      { id: "s1", action: "navigate", target: { url: "/lightning/r/Account/001Zq00000AbCdEAAZ/view" } },
      { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Close" }, value: "2026-12-31" },
      { id: "s3", action: "fill", target: { role: "textbox", name: "Zq Due" }, value: "{{date:+30:en-US}}" },
      { id: "s4", action: "fill", target: { role: "textbox", name: "Zq Ref" }, value: "a0BZq0000012345" },
      { id: "s5", action: "fill", target: { role: "textbox", name: "Zq Name" }, value: "Zq Deal Northwind" },
      { id: "s6", action: "assert", target: { text: "12/31/2026" }, assertion: "text_contains", value: "12/31/2026" },
    ]);
    expect(oneTimeValues(x)).toEqual([
      { stepId: "s1", kind: "record-id", value: "001Zq00000AbCdEAAZ" },
      { stepId: "s2", kind: "fixed-date", value: "2026-12-31" },
      { stepId: "s4", kind: "record-id", value: "a0BZq0000012345" },
    ]);
  });
});

describe("rememberForSave", () => {
  const irFile = write("r2/cases/case-0/04-ir.json", {});
  write("r2/03-cases.json", cases);
  write("r2/02-appmodel.json", appModel);
  const now = new Date("2026-11-02T10:00:00Z");

  it("remembers the meaning, the org snapshot and when, and still parses as an IR", () => {
    const { ir: saved, warnings } = rememberForSave({ runsRoot: root, runId: "r2", caseId: "case-0", ir: ir(), irFile, now });
    const m = saved.meta.remembered!;
    expect(m.savedFrom).toBe("r2");
    expect(m.at).toBe("2026-11-02T10:00:00.000Z");
    expect(m.meaning).toEqual({ title: "Create a Zq Deal", steps: cases[0].steps, expected: "The deal is created.", intent: "Create a deal", category: "valid" });
    expect(m.org?.objects.map((o: any) => o.api)).toEqual(["Zq_Deal__c"]);
    expect(m.oneTimeValues).toBeUndefined();
    expect(warnings).toEqual([]);
    expect(IR.parse(saved).meta.remembered).toEqual(m);    // survives the schema the library parses with
    expect(saved.steps).toEqual(ir().steps);                // the steps themselves are untouched
  });

  it("an ordinary site: meaning only, no org", () => {
    const { ir: saved } = rememberForSave({ runsRoot: root, runId: "r2", caseId: "case-0", ir: ir({ baseUrl: "https://zq.example" }, [
      { id: "s1", action: "navigate", target: { url: "/login" } },
      { id: "s2", action: "click", target: { role: "button", name: "Zq Go" } },
    ]), irFile, now });
    expect(saved.meta.remembered?.meaning?.category).toBe("valid");
    expect(saved.meta.remembered?.org).toBeUndefined();
  });

  it("says so when the run has no plain-English case, and lists one-time values", () => {
    const { warnings } = rememberForSave({ runsRoot: root, runId: "no-cases", caseId: "case-0", ir: ir({}, [
      { id: "s1", action: "fill", target: { role: "textbox", name: "Zq Close" }, value: "12/31/2026" },
    ]), irFile, now });
    expect(warnings[0]).toMatch(/saved without it/);
    expect(warnings[1]).toMatch(/fixed date 12\/31\/2026/);
  });

  it("a healed case is refused until a person accepts it", () => {
    const healed = write("r2/cases/case-0/healed/ir.json", {});
    expect(() => rememberForSave({ runsRoot: root, runId: "r2", caseId: "case-0", ir: ir(), irFile: healed, now }))
      .toThrow(HealedNeedsReviewError);
    const ok = rememberForSave({ runsRoot: root, runId: "r2", caseId: "case-0", ir: ir(), irFile: healed, acceptHealed: true, now });
    expect(ok.ir.meta.remembered?.savedFrom).toBe("r2");
  });
});

describe("the model can never write what a case remembers", () => {
  it("toIR drops a model-written meta.remembered (structural, before grounding)", async () => {
    const src = (await import("node:fs")).readFileSync("src/stages/ir.ts", "utf8");
    expect(src).toMatch(/delete parsed\.data\.meta\.remembered;/);
  });
});
