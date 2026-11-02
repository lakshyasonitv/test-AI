import type { IR, Remembered } from "../schema/ir.js";
import type { OrgObjectNow } from "./salesforceOrgModel.js";
import { hasRunToken, lineKey } from "../text.js";

/**
 * Regression testing, step 2 "Change check" (D-73, REGRESSION_CHANGE_CHECK_ENABLED, default off).
 *
 * Before a suite runs, compare the Salesforce org NOW with what each saved case remembered when it
 * was saved (step 1), object by object, and say which cases a change will break. API reads only: no
 * browser, no model, nothing written. The mapping is the design's table:
 *
 *   field label renamed, same API name        -> info: a repair can rebind it safely
 *   field removed, or its type changed        -> blocking: the case is affected
 *   new required field on an object it creates -> likely to fail
 *   picklist value or record type it uses gone -> blocking
 *   validation rule or flow on the object changed -> info
 *   Salesforce release changed                -> a note for the whole suite
 *
 * And the rule that matters most: what could not be read is "unknown", never "unchanged".
 * This file is pure; the route reads the org and hands it over.
 */

export function regressionChangeCheckEnabled(): boolean {
  return process.env.REGRESSION_CHANGE_CHECK_ENABLED === "true";
}

export type Severity = "blocking" | "likely-fail" | "unknown" | "info";
export interface Finding {
  severity: Severity;
  object: string;
  field?: string;
  stepId?: string;
  message: string;
}
export type CaseVerdict =
  | "affected" | "likely-to-fail" | "unknown" | "changed" | "unchanged" | "no-snapshot" | "not-salesforce";

export interface OrgNow {
  objects: Record<string, OrgObjectNow | null>;
  validationRules: Record<string, { name: string; condition?: string }[]> | null;
  flows: { api: string; label: string; object?: string }[] | null;
  release?: { label: string; version: string };
}

type SnapObject = {
  api: string; label?: string;
  fields?: { label: string; api: string; type?: string; required?: boolean; picklist?: string[]; lookup?: string }[];
  recordTypes?: { name: string; id: string }[];
  validationRules?: { name: string; condition?: string }[];
};

/** Fields Salesforce fills itself; never "now required" for a test to type. */
const SYSTEM_FIELDS = new Set(["Id", "OwnerId", "CreatedById", "CreatedDate", "LastModifiedById", "LastModifiedDate",
  "SystemModstamp", "IsDeleted", "RecordTypeId", "CurrencyIsoCode"]);
const FORM_ACTIONS = new Set(["fill", "select", "check"]);

function snapObjects(r: Remembered | undefined): SnapObject[] {
  return (r?.org?.objects ?? []) as unknown as SnapObject[];
}

/** Objects whose create form the case opens. */
function createdObjects(ir: IR): Set<string> {
  const out = new Set<string>();
  for (const s of ir.steps) {
    const m = /\/lightning\/o\/([A-Za-z][A-Za-z0-9_]*)\/new\b/.exec(s.target?.url ?? "");
    if (m) out.add(m[1]);
  }
  return out;
}

/** Which org field each form step works on: the field binding the passing run recorded first
 *  (step 1B, it survives label renames), else the step's label against the snapshot's labels. */
export function fieldsUsed(ir: IR): { object: string; field: string; stepId: string; value?: string; lookup?: boolean }[] {
  const r = ir.meta.remembered;
  const objs = snapObjects(r);
  const out: { object: string; field: string; stepId: string; value?: string; lookup?: boolean }[] = [];
  for (const s of ir.steps) {
    if (!FORM_ACTIONS.has(s.action) || !s.target) continue;
    const bound = r?.elements?.[s.id]?.sfField;
    const m = bound ? /^([A-Za-z][A-Za-z0-9_]*)\.([A-Za-z][A-Za-z0-9_]*)$/.exec(bound) : null;
    if (m) {
      out.push({ object: m[1], field: m[2], stepId: s.id, ...(s.value !== undefined ? { value: s.value } : {}), ...(s.target.lookup ? { lookup: true } : {}) });
      continue;
    }
    const name = lineKey(s.target.name ?? s.target.label ?? "");
    if (!name) continue;
    for (const o of objs) {
      const f = (o.fields ?? []).find((x) => lineKey(x.label) === name || lineKey(`${o.label ?? ""} ${x.label}`) === name);
      if (f) {
        out.push({ object: o.api, field: f.api, stepId: s.id, ...(s.value !== undefined ? { value: s.value } : {}), ...((s.target.lookup || f.lookup) ? { lookup: true } : {}) });
        break;
      }
    }
  }
  return out;
}

const ruleKey = (r: { name: string; condition?: string }) => `${r.name}\u0000${r.condition ?? ""}`;

/** Every finding for one saved case. */
export function checkCase(ir: IR, now: OrgNow): Finding[] {
  const r = ir.meta.remembered;
  const objs = snapObjects(r);
  const findings: Finding[] = [];
  const used = fieldsUsed(ir);
  const created = createdObjects(ir);

  for (const snap of objs) {
    const o = snap.api;
    const live = now.objects[o];
    if (!live) {
      findings.push({ severity: "unknown", object: o, message: `${snap.label ?? o} could not be read now (no access, or it no longer exists), so this case cannot be called unchanged.` });
      continue;
    }
    const snapField = new Map((snap.fields ?? []).map((f) => [f.api, f]));

    // Fields the case types into or picks from.
    for (const u of used.filter((x) => x.object === o)) {
      const was = snapField.get(u.field);
      const is = live.fields[u.field];
      if (!is) {
        findings.push({ severity: "blocking", object: o, field: u.field, stepId: u.stepId, message: `${was?.label ?? u.field} (${o}.${u.field}) was removed: step ${u.stepId} uses it.` });
        continue;
      }
      if (was?.type && is.type && was.type !== is.type) {
        findings.push({ severity: "blocking", object: o, field: u.field, stepId: u.stepId, message: `${is.label} (${o}.${u.field}) changed type from ${was.type} to ${is.type}: step ${u.stepId} may no longer work.` });
      } else if (was && lineKey(was.label) !== lineKey(is.label)) {
        findings.push({ severity: "info", object: o, field: u.field, stepId: u.stepId, message: `"${was.label}" is now labelled "${is.label}" (same field ${o}.${u.field}): a repair can rebind step ${u.stepId} safely.` });
      }
      // A picklist value the case picks that the org no longer offers.
      const offered = live.picklists[u.field];
      if (offered && u.value && !u.lookup && !hasRunToken(u.value) && !offered.some((v) => lineKey(v) === lineKey(u.value!))) {
        findings.push({ severity: "blocking", object: o, field: u.field, stepId: u.stepId, message: `"${u.value}" is no longer a choice in ${is.label} (${o}.${u.field}): step ${u.stepId} picks it.` });
      }
    }

    // A field that became required on an object the case creates, and that the case never fills.
    if (created.has(o)) {
      const filled = new Set(used.filter((x) => x.object === o).map((x) => x.field));
      for (const [api, f] of Object.entries(live.fields)) {
        if (!f.required || filled.has(api) || SYSTEM_FIELDS.has(api)) continue;
        if (snapField.get(api)?.required) continue;   // was already required and the case passed
        findings.push({ severity: "likely-fail", object: o, field: api, message: `${f.label} (${o}.${api}) is now required, and this case does not fill it: the save will likely be refused.` });
      }
    }

    // A record type the case opens its form with.
    for (const s of ir.steps) {
      const id = /[?&]recordTypeId=([A-Za-z0-9]{15,18})/.exec(s.target?.url ?? "")?.[1];
      if (!id || !new RegExp(`/lightning/o/${o}/`).test(s.target?.url ?? "")) continue;
      if (!live.recordTypes.some((t) => t.id === id)) {
        const name = snap.recordTypes?.find((t) => t.id === id)?.name ?? id;
        findings.push({ severity: "blocking", object: o, stepId: s.id, message: `The record type "${name}" of ${snap.label ?? o} is no longer available: step ${s.id} opens it.` });
      }
    }

    // Validation rules: a change is information, an unreadable answer is unknown.
    if (!r?.org?.validationRulesRead || now.validationRules === null) {
      findings.push({ severity: "unknown", object: o, message: `Validation rules on ${snap.label ?? o} could not be compared (the Tooling API was not readable ${r?.org?.validationRulesRead ? "now" : "when the case was saved"}).` });
    } else {
      const before = new Set((snap.validationRules ?? []).map(ruleKey));
      const after = new Set((now.validationRules[o] ?? []).map(ruleKey));
      const added = [...after].filter((k) => !before.has(k)).map((k) => k.split("\u0000")[0]);
      const gone = [...before].filter((k) => !after.has(k)).map((k) => k.split("\u0000")[0]);
      if (added.length || gone.length) {
        findings.push({ severity: "info", object: o, message: `Validation rules on ${live.label} changed${added.length ? `; new or edited: ${added.join(", ")}` : ""}${gone.length ? `; removed or edited: ${gone.join(", ")}` : ""}.` });
      }
    }

    // Flows that run on the object.
    if (now.flows !== null) {
      const before = new Set(((r?.org?.flows ?? []) as { api?: string; object?: string }[])
        .filter((f) => f.object === (snap.label ?? live.label)).map((f) => String(f.api)));
      const after = new Set(now.flows.filter((f) => f.object === live.label).map((f) => f.api));
      const added = [...after].filter((a) => !before.has(a));
      const gone = [...before].filter((a) => !after.has(a));
      if (added.length || gone.length) {
        findings.push({ severity: "info", object: o, message: `Flows on ${live.label} changed${added.length ? `; now active: ${added.join(", ")}` : ""}${gone.length ? `; no longer active: ${gone.join(", ")}` : ""}.` });
      }
    }
  }
  return findings;
}

/** The single verdict a case gets: its worst finding. */
export function verdictOf(findings: Finding[]): CaseVerdict {
  if (findings.some((f) => f.severity === "blocking")) return "affected";
  if (findings.some((f) => f.severity === "likely-fail")) return "likely-to-fail";
  if (findings.some((f) => f.severity === "unknown")) return "unknown";
  if (findings.length) return "changed";
  return "unchanged";
}

const isSalesforceHost = (url: string) => {
  try { return /\.(force|salesforce|salesforce-setup)\.com$/i.test(new URL(url).hostname); } catch { return false; }
};

export interface CaseReport {
  caseId: string;
  title: string;
  verdict: CaseVerdict;
  findings: Finding[];
  /** One sentence for verdicts that carry no findings. */
  note?: string;
}

export interface SuiteReport {
  checkedAt: string;
  org?: { host: string; release?: { label: string; version: string } };
  /** Set when the release the cases were saved under differs from the org's release now. */
  releaseNote?: string;
  cases: CaseReport[];
}

/** The whole suite's report. Cases with no Salesforce snapshot are listed, never silently passed. */
export function checkSuite(
  cases: { id: string; title: string; ir: IR }[], now: OrgNow | null, host: string | null, at = new Date(),
): SuiteReport {
  const report: SuiteReport = { checkedAt: at.toISOString(), cases: [] };
  if (host) report.org = { host, ...(now?.release ? { release: now.release } : {}) };
  const savedUnder = new Set<string>();
  for (const c of cases) {
    const r = c.ir.meta.remembered;
    if (!r?.org) {
      const sf = isSalesforceHost(c.ir.meta.baseUrl) || c.ir.steps.some((s) => /\$\{env:SF_FRONTDOOR_URL\}/.test(s.target?.url ?? ""));
      report.cases.push(sf
        ? { caseId: c.id, title: c.title, verdict: "no-snapshot", findings: [], note: "Saved before the org was remembered: re-save it from a passing run to check it." }
        : { caseId: c.id, title: c.title, verdict: "not-salesforce", findings: [], note: "Not a Salesforce case: there is no metadata to compare, so the run itself is the check." });
      continue;
    }
    if (!now) {
      report.cases.push({ caseId: c.id, title: c.title, verdict: "unknown", findings: [], note: "The org could not be read, so nothing can be called unchanged." });
      continue;
    }
    if (r.org.release?.label) savedUnder.add(r.org.release.label);
    const findings = checkCase(c.ir, now);
    report.cases.push({ caseId: c.id, title: c.title, verdict: verdictOf(findings), findings });
  }
  const nowRelease = now?.release?.label;
  const older = [...savedUnder].filter((l) => l !== nowRelease);
  if (nowRelease && older.length) {
    report.releaseNote = `Salesforce release is now ${nowRelease}; ${older.length === 1 ? "cases were" : "some cases were"} saved under ${older.join(", ")}. Page code may have moved even where the org's setup did not.`;
  }
  return report;
}
