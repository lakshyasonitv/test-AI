import { readdirSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { FrontdoorSession } from "./salesforceFrontdoor.js";

/**
 * Phase D: remove the records a run created in the org (SALESFORCE_CLEANUP_ENABLED, default off).
 *
 * WHY. Every create test leaves its Account, Lead or Case behind; over a few days a test org fills
 * with "Test Account nrakm3" rows that are nobody's data and slow every list a later run reads.
 *
 * WHAT IS DELETED, AND NOTHING ELSE. The generated spec records each record page its browser
 * reached (`/lightning/r/<Object>/<Id>/view`, the page a create's Save opens) as the "sf-records"
 * annotation in results.json. That list alone is not trusted: a test can also open an existing
 * record. Each id is deleted only when the org itself confirms, through SOQL, that the record was
 * CREATED BY THE CONNECTED USER AT OR AFTER THE RUN STARTED. Anything else is left alone and
 * reported as skipped. No connected user id (the org did not say who we are) = nothing is deleted.
 */
export function cleanupEnabled(): boolean {
  return process.env.SALESFORCE_CLEANUP_ENABLED === "true";
}

export interface RecordRef { object: string; id: string }

const RECORD_PAGE = /^([A-Za-z][A-Za-z0-9_]*)\/([A-Za-z0-9]{15}(?:[A-Za-z0-9]{3})?)$/;

/** The "sf-records" annotations of one Playwright results.json, as object + id pairs. */
export function recordsFromResults(results: any): RecordRef[] {
  const out: RecordRef[] = [];
  const visit = (s: any) => {
    for (const sp of s?.specs ?? []) for (const t of sp.tests ?? []) {
      const all = [...(t.annotations ?? []), ...(t.results ?? []).flatMap((r: any) => r.annotations ?? [])];
      for (const a of all) {
        if (a?.type !== "sf-records") continue;
        let list: unknown;
        try { list = JSON.parse(a.description); } catch { continue; }
        for (const v of Array.isArray(list) ? list : []) {
          const m = RECORD_PAGE.exec(String(v));
          if (m) out.push({ object: m[1], id: m[2] });
        }
      }
    }
    for (const c of s?.suites ?? []) visit(c);
  };
  for (const s of results?.suites ?? []) visit(s);
  return out;
}

/** Every results.json a run wrote (the primary case at the root, each case, each healed retry). */
export function runRecords(runDir: string): RecordRef[] {
  const files: string[] = [];
  const walk = (d: string, depth: number) => {
    if (depth > 3 || !existsSync(d)) return;
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory() && e.name !== "artifacts") walk(path.join(d, e.name), depth + 1);
      else if (e.isFile() && e.name === "results.json") files.push(path.join(d, e.name));
    }
  };
  walk(runDir, 0);
  const seen = new Map<string, RecordRef>();
  for (const f of files) {
    let results: unknown;
    try { results = JSON.parse(readFileSync(f, "utf8")); } catch { continue; }
    for (const r of recordsFromResults(results)) seen.set(`${r.object}/${r.id}`, r);
  }
  return [...seen.values()];
}

/** Children that block or outlive their parent's delete, by lookup field. Tasks and Events go with
 *  their parent by themselves. ponytail: standard objects only; read childRelationships when a
 *  custom child shows up. */
const CHILDREN: Record<string, [string, string][]> = {
  Account: [["Opportunity", "AccountId"], ["Contact", "AccountId"], ["Case", "AccountId"]],
  Contact: [["Case", "ContactId"]],
};

export interface CleanupReport { deleted: RecordRef[]; skipped: RecordRef[]; failed: { ref: RecordRef; error: string }[]; reason?: string }

type ApiSession = Required<Pick<FrontdoorSession, "apiGet" | "apiDelete">>;

/**
 * Delete `records` that the org confirms this user created at or after `since`. Never throws: a
 * cleanup that cannot run reports why and deletes nothing.
 */
export async function cleanupRecords(session: ApiSession, records: RecordRef[], since: Date): Promise<CleanupReport> {
  const report: CleanupReport = { deleted: [], skipped: [], failed: [] };
  if (!records.length) return report;
  let me: string | undefined;
  try { me = (await session.apiGet("/chatter/users/me"))?.id; } catch { /* below */ }
  if (typeof me !== "string" || !/^005[A-Za-z0-9]{12,15}$/.test(me)) {
    return { ...report, skipped: records, reason: "the org did not say which user is connected, so nothing was deleted" };
  }
  const sinceIso = since.toISOString().replace(/\.\d{3}Z$/, "Z");
  // Children no page showed: an Opportunity made from the Account's "New Opportunity" dialog (run
  // 2026-11-10T14-18-09-285Z-5df7a7ee), a Case a flow made on it (2026-11-10T14-03-50-411Z-95d5ec39). Found under the run's own
  // parents, by the same rule (this user, since the run began), and added last so they go first.
  records = [...records];
  // A converted Lead became an Account, a Contact and maybe an Opportunity (run
  // 2026-11-10T19-47-57-184Z-b4313d16 deleted only the Lead). Added Account first so the reverse order deletes
  // the Opportunity, then the Contact, then the Account; each is still confirmed below like any other.
  const leads = records.filter((r) => r.object === "Lead" && /^[A-Za-z0-9]{15,18}$/.test(r.id)).map((r) => `'${r.id}'`).join(",");
  if (leads) {
    try {
      const q = `SELECT ConvertedAccountId, ConvertedContactId, ConvertedOpportunityId FROM Lead WHERE Id IN (${leads}) AND IsConverted = true`;
      for (const row of (await session.apiGet(`/query?q=${encodeURIComponent(q)}`))?.records ?? []) {
        for (const [object, id] of [["Account", row?.ConvertedAccountId], ["Contact", row?.ConvertedContactId], ["Opportunity", row?.ConvertedOpportunityId]] as const) {
          if (typeof id === "string" && /^[A-Za-z0-9]{15,18}$/.test(id) && !records.some((r) => r.id.slice(0, 15) === id.slice(0, 15))) records.push({ object, id });
        }
      }
    } catch { /* the org will not say: the converted records stay, reported nowhere */ }
  }
  for (const parent of [...new Set(records.map((r) => r.object))]) {
    const ids = records.filter((r) => r.object === parent).map((r) => `'${r.id}'`).join(",");
    if (!ids || !/^[A-Za-z][A-Za-z0-9_]*$/.test(parent)) continue;
    // The standard children above, plus the parent's CUSTOM children the org does not delete with it
    // (its describe's childRelationships, cascadeDelete false).
    const kids: [string, string][] = [...(CHILDREN[parent] ?? [])];
    try {
      for (const r of (await session.apiGet(`/sobjects/${parent}/describe`))?.childRelationships ?? []) {
        if (/__c$/.test(r?.childSObject ?? "") && r?.field && !r.cascadeDelete && !kids.some(([c]) => c === r.childSObject)) kids.push([r.childSObject, r.field]);
      }
    } catch { /* no describe: the standard children only */ }
    for (const [child, field] of kids) {
      try {
        const q = `SELECT Id FROM ${child} WHERE ${field} IN (${ids}) AND CreatedById = '${me}' AND CreatedDate >= ${sinceIso}`;
        for (const x of (await session.apiGet(`/query?q=${encodeURIComponent(q)}`))?.records ?? []) {
          const id = String(x?.Id ?? "");
          if (/^[A-Za-z0-9]{15,18}$/.test(id) && !records.some((r) => r.id.slice(0, 15) === id.slice(0, 15))) records.push({ object: child, id });
        }
      } catch { /* a child the org will not list: the parent's delete then reports why */ }
    }
  }
  const byObject = new Map<string, RecordRef[]>();
  for (const r of records) byObject.set(r.object, [...(byObject.get(r.object) ?? []), r]);
  // Children before parents: objects in the reverse of the order the run first reached them (the
  // Opportunity made after its Account goes first; TB Account Delete Guard refuses the other order).
  for (const [object, refs] of [...byObject].reverse()) {
    let confirmed = new Set<string>();
    try {
      const ids = refs.map((r) => `'${r.id}'`).join(",");
      const q = `SELECT Id FROM ${object} WHERE Id IN (${ids}) AND CreatedById = '${me}' AND CreatedDate >= ${sinceIso}`;
      const res = await session.apiGet(`/query?q=${encodeURIComponent(q)}`);
      // 15- and 18-character ids name the same record: compare on the first 15.
      confirmed = new Set((res?.records ?? []).map((x: any) => String(x?.Id).slice(0, 15)));
    } catch (err) {
      for (const ref of refs) report.failed.push({ ref, error: `could not confirm who created it: ${(err as Error)?.message ?? err}` });
      continue;
    }
    for (const ref of refs) {
      if (!confirmed.has(ref.id.slice(0, 15))) { report.skipped.push(ref); continue; }
      try {
        await session.apiDelete(`/sobjects/${object}/${ref.id}`);
        report.deleted.push(ref);
      } catch (err) {
        const msg = (err as Error)?.message ?? String(err);
        // Already gone: the test deleted it itself, or deleting its parent took it along.
        if (/HTTP 404\b/.test(msg)) report.deleted.push(ref);
        else report.failed.push({ ref, error: msg });
      }
    }
  }
  return report;
}

/** When the run began, from its id ("2026-10-26T06-15-41-827Z-23c2fab6"); null when unreadable. */
export function runStartedAt(runId: string): Date | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(runId);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * What a published platform event's flow made (salesforceSeed.ts): saved by the Automated Process user,
 * so the "this user created it" rule above never matches it (run 2026-11-10T15-28-58-549Z-d2677d83 left
 * its "TB Event a8e8ic" Account). Found instead by the run-unique name seeding gave it ("TB Event <uid>"),
 * created since the run began; nothing without the "TB Event " prefix is ever touched.
 */
export async function cleanupSeeded(session: ApiSession, made: { object: string; name: string }[], since: Date): Promise<CleanupReport> {
  const report: CleanupReport = { deleted: [], skipped: [], failed: [] };
  const sinceIso = since.toISOString().replace(/\.\d{3}Z$/, "Z");
  for (const m of made) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(m.object) || !/^TB Event [a-z0-9]{4,12}$/.test(m.name)) continue;
    let ids: string[] = [];
    try {
      const q = `SELECT Id FROM ${m.object} WHERE Name = '${m.name}' AND CreatedDate >= ${sinceIso}`;
      ids = ((await session.apiGet(`/query?q=${encodeURIComponent(q)}`))?.records ?? []).map((x: any) => String(x?.Id));
    } catch (err) {
      report.failed.push({ ref: { object: m.object, id: m.name }, error: (err as Error)?.message ?? String(err) });
      continue;
    }
    for (const id of ids.filter((x) => /^[A-Za-z0-9]{15,18}$/.test(x))) {
      try { await session.apiDelete(`/sobjects/${m.object}/${id}`); report.deleted.push({ object: m.object, id }); }
      catch (err) { report.failed.push({ ref: { object: m.object, id }, error: (err as Error)?.message ?? String(err) }); }
    }
  }
  return report;
}

/**
 * What a SCREEN flow made: the test never opens that record's page, so it is in no "sf-records" list (run
 * 2026-11-10T20-48-38-298Z-86ccdda4, TB New Contact Screen, left its Contact). Found by a value the case
 * typed on the flow's screens with the run's unique code in it ("TestLast ab12cd"), in the object the flow
 * creates, made by this user since the run began. A value without the code is never searched for.
 */
export function screenFlowMade(
  irSteps: { action: string; target?: { url?: string; name?: string }; value?: string }[],
  flows: { api: string; type: string; effects?: string[] }[] | undefined,
  ctx: { uid: string },
): { object: string; name: string }[] {
  const out: { object: string; name: string }[] = [];
  let flow: { api: string; type: string; effects?: string[] } | undefined;
  for (const s of irSteps) {
    if (s.action === "navigate") {
      const api = /\/flow\/(\w+)/.exec(s.target?.url ?? "")?.[1];
      flow = api ? (flows ?? []).find((f) => f.api === api && f.type === "screen") : undefined;
      continue;
    }
    if (!flow || s.action !== "fill" || !s.value?.includes("{{uid}}")) continue;
    const name = s.value.replace(/\{\{uid\}\}/g, ctx.uid).trim();
    for (const l of flow.effects ?? []) {
      const m = /^creates an? (\w+)/.exec(l);
      if (m && !out.some((o) => o.object === m[1] && o.name === name)) out.push({ object: m[1], name });
    }
  }
  return out;
}

/**
 * The records the grounding replays saved: every value a create form typed with the run's code ("Ruiz
 * {{uid}}"), with each code a replay used in its place ("Ruiz uqzh6b"), on that form's object. Only
 * objects whose records have a Name (Case and Task are named by Subject). An object with no Name field is found
 * by the field the code was typed in (a Work Order by its Subject: the Name query failed with HTTP 400 and
 * left 14 replay Work Orders, run 2026-11-13T18-30-28-619Z-653368f1). cleanupByTypedName then deletes
 * exactly those, this user's, made since the run began.
 */
export function replayMade(
  steps: { action: string; value?: string; target?: { url?: string; name?: string } }[], codes: string[],
  org?: { objects: { api: string; fields: { label: string; api: string }[] }[] },
): { object: string; name: string; field?: string }[] {
  const out: { object: string; name: string; field?: string }[] = [];
  let form: string | null = null;
  for (const s of steps) {
    if (s.action === "navigate") { form = /\/lightning\/o\/([^/?#]+)\/new\b/.exec(s.target?.url ?? "")?.[1] ?? null; continue; }
    if (!form || /^(Case|Task|Event)$/.test(form) || s.action !== "fill" || !s.value?.includes("{{uid}}") || /@/.test(s.value)) continue;
    for (const code of codes) {
      if (!/^[a-z0-9]{4,12}$/.test(code)) continue;
      const name = s.value.replace(/\{\{uid\}\}/g, code).replace(/\{\{[^}]*\}\}/g, "").trim();
      const o = org?.objects.find((x) => x.api === form);
      const api = o?.fields.find((f) => f.label.toLowerCase() === (s.target?.name ?? "").trim().toLowerCase())?.api;
      const field = o && !o.fields.some((f) => f.api === "Name") && api ? api : undefined;
      if (name && !out.some((x) => x.object === form && x.name === name)) out.push({ object: form, name, ...(field ? { field } : {}) });
    }
  }
  return out;
}

/** A value inside a SOQL LIKE '%...%': backslash, quote, % and _ escaped (O'Brien, Zq_1). The old
 *  replace(/'/g, "\'") was a no-op ("\'" is "'"), so a name with a quote broke the query. */
export const soqlLike = (v: string) => v.replace(/[\\'%_]/g, (c) => "\\" + c);

/** Delete records named like `made` (a typed value with the run's code), this user's, since `since`. */
export async function cleanupByTypedName(session: ApiSession, made: { object: string; name: string; field?: string }[], since: Date): Promise<CleanupReport> {
  const report: CleanupReport = { deleted: [], skipped: [], failed: [] };
  if (!made.length) return report;
  let me: string | undefined;
  try { me = (await session.apiGet("/chatter/users/me"))?.id; } catch { /* below */ }
  if (typeof me !== "string" || !/^005[A-Za-z0-9]{12,15}$/.test(me)) return { ...report, reason: "the org did not say which user is connected, so nothing was deleted" };
  const sinceIso = since.toISOString().replace(/\.\d{3}Z$/, "Z");
  for (const m of made) {
    const field = m.field ?? "Name";
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(m.object) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(field) || !/^[\w .'-]{4,80}$/.test(m.name)) continue;
    const like = soqlLike(m.name);
    try {
      const q = `SELECT Id FROM ${m.object} WHERE ${field} LIKE '%${like}%' AND CreatedById = '${me}' AND CreatedDate >= ${sinceIso}`;
      for (const x of (await session.apiGet(`/query?q=${encodeURIComponent(q)}`))?.records ?? []) {
        const id = String(x?.Id ?? "");
        if (!/^[A-Za-z0-9]{15,18}$/.test(id)) continue;
        try { await session.apiDelete(`/sobjects/${m.object}/${id}`); report.deleted.push({ object: m.object, id }); }
        catch (err) { report.failed.push({ ref: { object: m.object, id }, error: (err as Error)?.message ?? String(err) }); }
      }
    } catch (err) {
      report.failed.push({ ref: { object: m.object, id: m.name }, error: (err as Error)?.message ?? String(err) });
    }
  }
  return report;
}
