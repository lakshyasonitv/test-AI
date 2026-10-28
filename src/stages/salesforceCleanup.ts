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
  const byObject = new Map<string, RecordRef[]>();
  for (const r of records) byObject.set(r.object, [...(byObject.get(r.object) ?? []), r]);
  for (const [object, refs] of byObject) {
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
