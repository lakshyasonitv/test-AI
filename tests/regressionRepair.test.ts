import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import {
  attemptRepair, failureKindFor, isMassFailure, laterHiddenCheckOnSameElement, withNewLocator,
  regressionRepairEnabled,
} from "../src/stages/regressionRepair.js";
import { runReplay } from "../src/stages/replay.js";
import { IR } from "../src/schema/ir.js";

/**
 * D-73 step 3, the safe repair, against a real browser (D-19). A local site plays the website before
 * and after a deploy: `version` decides which page it serves. The saved case was grounded on v1.
 */

const PAGES: Record<string, string> = {
  // v1: what the case was saved against.
  v1: `<label for="n">Zq Name</label><input id="n" name="nameV1"><button id="save">Save</button><p id="out"></p>`,
  // v2: only the input's name attribute changed — the saved css no longer matches.
  v2: `<label for="n">Zq Name</label><input id="n" name="nameV2"><button id="save">Save</button><p id="out"></p>`,
  // v3: the css changed AND a second box carries the same name — not certain, so no repair.
  v3: `<label for="a">Zq Name</label><input id="a" name="x1"><label for="b">Zq Name</label><input id="b" name="x2"><button id="save">Save</button><p id="out"></p>`,
  // v5: the input name AND the Save button changed: repairing the one broken step cannot make it pass.
  v5: `<label for="n">Zq Name</label><input id="n" name="nameV5"><button id="store">Store</button><p id="out"></p>`,
  // v4: a Salesforce-style rename: same field, new label, new css.
  v4: `<div data-target-selection-name="sfdc:RecordField.Zq_Deal__c.Name"><label for="n">Zq Deal Title</label><input id="n" name="titleV4"></div><button id="save">Save</button><p id="out"></p>`,
};
let version = "v1";
const page = (body: string) => `<!doctype html><html><head><title>Zq</title></head><body><main>${body}
<script>document.getElementById("save").onclick = () => {
  const v = (document.querySelector("input[id]") || {}).value || "";
  document.getElementById("out").textContent = "Saved " + v;
};</script></main></body></html>`;

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    if (req.url?.startsWith("/form")) res.end(page(PAGES[version]).replace('getElementById("save")', version === "v5" ? 'getElementById("store")' : 'getElementById("save")')); else { res.statusCode = 404; res.end(""); }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const runRoot = path.join("runs", `0000-regression-repair-${process.pid}-${Date.now()}`);
afterAll(() => rmSync(runRoot, { recursive: true, force: true }));
afterEach(() => { version = "v1"; delete process.env.REGRESSION_REPAIR_ENABLED; });
let n = 0;
const caseDir = () => { const d = path.join(runRoot, `case-${n++}`); mkdirSync(d, { recursive: true }); return d; };

/** The case as saved on v1: grounded css, plus what step 1 remembered. */
const saved = (extraSteps: any[] = [], sfField?: string): IR => IR.parse({
  meta: {
    feature: "f", title: "Save a Zq name", priority: "high", sourcePrompt: "p", baseUrl: base,
    ...(sfField ? { remembered: { savedFrom: "r1", at: "t", elements: { s2: { path: "/form", matches: 1, role: "", sfField } } } } : {}),
  },
  steps: [
    { id: "s1", action: "navigate", target: { url: "/form" } },
    { id: "s2", action: "fill", target: { role: "textbox", name: "Zq Name", css: "input[name=\"nameV1\"]" }, value: "Northwind" },
    { id: "s3", action: "click", target: { role: "button", name: "Save", css: "#save" } },
    { id: "s4", action: "assert", target: { text: "Saved Northwind" }, assertion: "visible" },
    ...extraSteps,
  ],
});

describe("pure rules", () => {
  it("is off unless asked for", () => {
    expect(regressionRepairEnabled()).toBe(false);
    process.env.REGRESSION_REPAIR_ENABLED = "true";
    expect(regressionRepairEnabled()).toBe(true);
  });
  it("the failing step's ACTION decides the kind: an action is element-changed, a check is result-changed", () => {
    const ir = saved();
    expect(failureKindFor(ir, { failedStep: 2, error: "Timeout 10000ms exceeded" }).kind).toBe("element-changed");
    expect(failureKindFor(ir, { failedStep: 4, error: "expect(locator).toBeVisible() failed" }).kind).toBe("result-changed");
    expect(failureKindFor(ir, { failedStep: 1, error: "net::ERR_CONNECTION_REFUSED" }).kind).toBe("site-unreachable");
    expect(failureKindFor(ir, {}).kind).toBe("unknown");
  });
  it("most of a suite failing at once is not a locator problem", () => {
    expect(isMassFailure(4, 3)).toBe(true);
    expect(isMassFailure(6, 3)).toBe(false);
    expect(isMassFailure(2, 2)).toBe(false);
  });
  it("only the locator changes: value, frame, lookup and field stay exactly as they were", () => {
    const step = { id: "s9", action: "select", value: "Zq", target: { role: "combobox", name: "Old", css: "#x", nth: 2, frame: "iframe#f", lookup: true, field: "Zq F" } } as any;
    expect(withNewLocator(step, { role: "combobox", name: "New" })).toEqual(
      { id: "s9", action: "select", value: "Zq", target: { role: "combobox", name: "New", frame: "iframe#f", lookup: true, field: "Zq F" } });
  });
  it("a later 'is gone' check on the same element is found", () => {
    const ir = saved([{ id: "s5", action: "assert", target: { role: "textbox", name: "Zq Name", css: "input[name=\"nameV1\"]" }, assertion: "hidden" }]);
    expect(laterHiddenCheckOnSameElement(ir, 1)).toBe("s5");
    expect(laterHiddenCheckOnSameElement(saved(), 1)).toBeNull();
  });
});

describe("in real Chromium", () => {
  it("(a) the input's name attribute changed: an exact unique match repairs it, the whole test passes again, proposed", async () => {
    version = "v2";
    const dir = caseDir();
    const p = await attemptRepair({ ir: saved(), stepIndex: 1, caseDir: dir, session: null });
    expect(p.state, p.reason).toBe("proposed");
    expect(p.rung).toBe("exact-match");
    expect(p.after).toEqual({ role: "textbox", name: "Zq Name" });
    expect(p.changes?.map((c) => c.field)).toContain("css");
    expect(p.verification?.passed).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, "repair", "proposal.json"), "utf8")).state).toBe("proposed");
    // Only that one step changed in the IR it verified.
    const verified = JSON.parse(readFileSync(path.join(dir, "repair", "ir.json"), "utf8"));
    expect(verified.steps.filter((s: any, i: number) => JSON.stringify(s) !== JSON.stringify(saved().steps[i])).map((s: any) => s.id)).toEqual(["s2"]);
  }, 240_000);

  it("(b) two elements now carry the name: no repair, because it is not certain", async () => {
    version = "v3";
    const p = await attemptRepair({ ir: saved(), stepIndex: 1, caseDir: caseDir(), session: null });
    expect(p.state).toBe("no-repair");
    expect(p.reason).toMatch(/2 elements are a textbox named "Zq Name"/);
  }, 120_000);

  it("(c) the saved locator still finds the same element: a slow page, not a repair", async () => {
    version = "v1";
    const p = await attemptRepair({ ir: saved(), stepIndex: 1, caseDir: caseDir(), session: null });
    expect(p.state).toBe("no-repair");
    expect(p.reason).toMatch(/page was slow/);
  }, 120_000);

  it("(d) a later 'is gone' check on the old element: the repair goes to a person, unverified, unapplied", async () => {
    version = "v2";
    const ir = saved([{ id: "s5", action: "assert", target: { role: "textbox", name: "Zq Name", css: "input[name=\"nameV1\"]" }, assertion: "hidden" }]);
    const dir = caseDir();
    const p = await attemptRepair({ ir, stepIndex: 1, caseDir: dir, session: null });
    expect(p.state).toBe("needs-person");
    expect(p.reason).toMatch(/s5/);
    expect(p.verification).toBeUndefined();
    expect(existsSync(path.join(dir, "repair", "ir.json"))).toBe(false);
  }, 120_000);

  it("(g) the repaired step is found, but the test still fails later: NOT proposed (one step only)", async () => {
    version = "v5";
    const p = await attemptRepair({ ir: saved(), stepIndex: 1, caseDir: caseDir(), session: null });
    expect(p.state).toBe("no-repair");
    expect(p.verification?.passed).toBe(false);
    expect(p.reason).toMatch(/still does not pass from step 1/);
  }, 240_000);

  it("(e) Salesforce field binding: same field, renamed label, found through the org's current label", async () => {
    version = "v4";
    const session: any = {
      connectionId: "zq", instanceHost: "zq.example", mint: async () => "",
      apiGet: async (p: string) => (p.startsWith("/ui-api/object-info/Zq_Deal__c") ? { fields: { Name: { label: "Zq Deal Title", dataType: "String" } } } : null),
    };
    const p = await attemptRepair({ ir: saved([], "Zq_Deal__c.Name"), stepIndex: 1, caseDir: caseDir(), session });
    expect(p.state, p.reason).toBe("proposed");
    expect(p.rung).toBe("field-binding");
    expect(p.after).toEqual({ role: "textbox", name: "Zq Deal Title" });
    expect(p.reason).toMatch(/Same Salesforce field Zq_Deal__c\.Name/);
  }, 240_000);

  it("(f) a replay with repair on attaches the proposal to the run; the case still counts as failed", async () => {
    version = "v2";
    process.env.REGRESSION_REPAIR_ENABLED = "true";
    const runId = `0000-regression-repair-replay-${process.pid}-${Date.now()}`;
    try {
      const out = await runReplay({ runId, cases: [{ id: "lib-1", version: 3, title: "Save a Zq name", ir: saved() }], label: "zq" });
      const r = out.results[0];
      expect(r.status).toBe("failed");
      expect(r.repair).toMatchObject({ state: "proposed", caseId: "lib-1", fromVersion: 3, stepId: "s2", rung: "exact-match" });
      expect((out.summary.cases[0] as any).repair.state).toBe("proposed");
    } finally {
      rmSync(path.join("runs", runId), { recursive: true, force: true });
    }
  }, 300_000);
});
