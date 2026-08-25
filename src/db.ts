import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { RunSummary } from "./runStore.js";

/**
 * Database access, behind DB_ENABLED (default off) — implentationplan.md Step 3.2.
 *
 * At this step the database is in SHADOW MODE and nothing here is ever allowed to affect what a
 * caller sees. `listRuns()` still returns the disk result; this module only reads the same data
 * back out of Postgres so the two can be compared and any divergence logged. Flipping authority
 * to the database is Step 3.3, and the plan gates that on this having run for a few days with
 * zero divergence reported.
 */

/** Must match the bootstrap migration's organisation id (phase3_bootstrap_default_org). */
export const DEFAULT_ORG_ID = "00000000-0000-4000-8000-000000000010";

/** Same 20-row cap listRuns() applies, so the two sides are comparable at all. */
const SHADOW_LIMIT = 20;

/** How often the shadow comparison is allowed to run. /api/runs is polled by the UI, and an
 *  unthrottled comparison would issue a database round-trip per poll for no added signal. */
const SHADOW_INTERVAL_MS = 60_000;

export function isDbEnabled(): boolean {
  return process.env.DB_ENABLED === "true";
}

let cachedClient: SupabaseClient | null = null;
let cachedKey = "";
let warnedMissingKey = false;

/**
 * Service-role client. Reads and writes bypass row-level security, which is deliberate and why
 * this key must never reach a browser: RLS only ever grants a signed-in user their own
 * organisation's rows, and the server — which must be able to see across organisations to
 * enforce access itself — is the only thing allowed through unrestricted.
 *
 * Exported because Step 3.4's authorization queries (membership lookups, the run→organisation
 * map) need the same client. One construction site, one cache, one missing-key warning.
 */
export function getServiceClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    // Actionable once, not once per request — this fires on a polled endpoint.
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.error(
        "[db] SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. " +
        "Copy the service_role key from Supabase Dashboard -> Project Settings -> API into .env. " +
        "Falling back to disk only; nothing is broken, but the shadow comparison and any " +
        "organisation-scoped authorization cannot run.",
      );
    }
    return null;
  }

  const cacheKey = `${url}::${key}`;
  if (cachedClient && cachedKey === cacheKey) return cachedClient;
  cachedClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  cachedKey = cacheKey;
  return cachedClient;
}

export interface DbRunRow {
  id: string;
  prompt: string | null;
  url: string | null;
  status: string | null;
  started_at: string | null;
}

/** The newest runs as the database has them, or null if it couldn't be reached. */
export async function fetchRunsFromDb(limit = SHADOW_LIMIT): Promise<DbRunRow[] | null> {
  const client = getServiceClient();
  if (!client) return null;
  try {
    // Deliberately NOT filtered by organisation. The question this comparison answers is "does
    // the database hold the same runs the disk does", and disk has no concept of an organisation
    // — so scoping to one org would report every other org's runs as "missing from disk" and
    // every run written by a second org as "missing from database". With a single organisation
    // this is identical to the previous org-filtered query.
    const { data, error } = await client
      .from("runs")
      .select("id, prompt, url, status, started_at")
      .order("started_at", { ascending: false })
      .limit(limit);
    if (error) {
      console.error("[shadow] database read failed:", error.message);
      return null;
    }
    return data ?? [];
  } catch (err) {
    console.error("[shadow] database read threw:", (err as Error)?.message ?? err);
    return null;
  }
}

/**
 * Pure comparison between the disk result and the database rows. Returns one human-readable line
 * per disagreement, empty when the two agree.
 *
 * Split out from the fire-and-forget wrapper below so it can be unit-tested directly: this is the
 * entire substance of Step 3.2, and it decides whether Step 3.3 is safe to do. Testing it through
 * a live database would make the test depend on a service-role secret and on network access.
 */
export function diffRuns(diskRuns: RunSummary[], dbRows: DbRunRow[]): string[] {
  const disk = new Map(diskRuns.map((r) => [r.runId, r]));
  const db = new Map(dbRows.map((r) => [r.id, r]));
  const problems: string[] = [];

  for (const [runId, d] of disk) {
    const row = db.get(runId);
    if (!row) {
      problems.push(`missing from database: ${runId}`);
      continue;
    }
    if ((row.status ?? "") !== d.status) {
      problems.push(`status differs for ${runId}: disk=${d.status} db=${row.status}`);
    }
    if ((row.url ?? "") !== d.url) {
      problems.push(`url differs for ${runId}: disk=${JSON.stringify(d.url)} db=${JSON.stringify(row.url)}`);
    }
    if ((row.prompt ?? "") !== d.prompt) {
      problems.push(`prompt differs for ${runId}`);
    }
  }

  // Only flag database rows the disk side should have seen. Disk is capped at the newest 20, so
  // an older row legitimately present in the database is NOT a divergence — comparing without
  // this window check would report a false mismatch on every single call once there are more
  // than 20 runs, which is already true here (51).
  const diskTimes = diskRuns.map((r) => r.startedAt).filter((n) => Number.isFinite(n));
  const oldestOnDisk = diskTimes.length ? Math.min(...diskTimes) : 0;
  for (const [id, row] of db) {
    if (disk.has(id)) continue;
    const rowMs = row.started_at ? Date.parse(row.started_at) : NaN;
    if (Number.isFinite(rowMs) && rowMs >= oldestOnDisk) {
      problems.push(`present in database but not on disk: ${id}`);
    }
  }

  return problems;
}

// ---------------------------------------------------------------------------
// Writes (Step 3.4's dependency)
//
// Authorization asks "which organisation owns this run?". Until new runs are written to the
// database that question has no answer for anything created after the one-off backfill, so
// tenancy could only ever be enforced on historical rows. These writes are what make it real.
//
// Every one of them is fire-and-forget and non-fatal, exactly like the shadow read above: a run
// is a long, expensive, user-visible operation and a database hiccup must never fail it, delay
// it, or lose it. Disk remains authoritative for reads — flipping that is Step 3.3.
// ---------------------------------------------------------------------------

export interface NewRunRow {
  id: string;
  organisation_id: string;
  started_by: string | null;
  prompt: string | null;
  url: string | null;
  status: string;
  started_at: string;
}

/** Record a newly-started run. Idempotent: re-running never duplicates or clobbers. */
export function recordRunStarted(row: NewRunRow): void {
  if (!isDbEnabled()) return;
  const client = getServiceClient();
  if (!client) return;

  void (async () => {
    try {
      // onConflict ignoreDuplicates: a retried request must not reset a run's status back to
      // "incomplete" after it has already finished.
      const { error } = await client
        .from("runs")
        .upsert(row, { onConflict: "id", ignoreDuplicates: true });
      if (error) console.error(`[db] could not record run ${row.id}:`, error.message);
    } catch (err) {
      console.error(`[db] recording run ${row.id} threw:`, (err as Error)?.message ?? err);
    }
  })();
}

/** Move a run to its terminal status once the pipeline reports done/error. */
export function recordRunStatus(runId: string, status: string): void {
  if (!isDbEnabled()) return;
  const client = getServiceClient();
  if (!client) return;

  void (async () => {
    try {
      const { error } = await client.from("runs").update({ status }).eq("id", runId);
      if (error) console.error(`[db] could not update run ${runId}:`, error.message);
    } catch (err) {
      console.error(`[db] updating run ${runId} threw:`, (err as Error)?.message ?? err);
    }
  })();
}

/** Which organisation AND project each run belongs to. */
export interface RunScope {
  organisationId: string;
  projectId: string | null;
}

/**
 * The org + project each of these runs belongs to.
 *
 * Step 5.1 scopes visibility by project as well as organisation, so one lookup now has to answer
 * both questions. Runs with no row are absent from the map, and for authorization that must mean
 * "deny" — never "allow".
 */
export async function fetchRunScopes(runIds: string[]): Promise<Map<string, RunScope> | null> {
  if (runIds.length === 0) return new Map();
  const client = getServiceClient();
  if (!client) return null;
  try {
    const { data, error } = await client
      .from("runs")
      .select("id, organisation_id, project_id")
      .in("id", runIds);
    if (error) {
      console.error("[db] run scope lookup failed:", error.message);
      return null;
    }
    return new Map(
      (data ?? []).map((r: { id: string; organisation_id: string; project_id: string | null }) =>
        [r.id, { organisationId: r.organisation_id, projectId: r.project_id }] as const),
    );
  } catch (err) {
    console.error("[db] run scope lookup threw:", (err as Error)?.message ?? err);
    return null;
  }
}

/** Record which project a run belongs to, once inferred. Fire-and-forget like every write here. */
export function recordRunProject(runId: string, projectId: string): void {
  if (!isDbEnabled()) return;
  const client = getServiceClient();
  if (!client) return;

  void (async () => {
    try {
      const { error } = await client.from("runs").update({ project_id: projectId }).eq("id", runId);
      if (error) console.error(`[db] could not set project for run ${runId}:`, error.message);
    } catch (err) {
      console.error(`[db] setting project for run ${runId} threw:`, (err as Error)?.message ?? err);
    }
  })();
}

/**
 * Record which saved cases a run executed, so a case can show its own run history.
 *
 * A join table rather than a `runs.case_id` column: a suite replay runs several cases under one
 * run id, so a single column would only ever be right for single-case replays — and a case that
 * usually runs as part of a suite would show an empty history forever.
 *
 * Fire-and-forget and non-fatal, like every write in this file. The run and its artifacts are
 * already on disk; losing the index row costs a history entry, never a result.
 */
export function recordRunCases(
  runId: string,
  cases: { testCaseId: string; caseIndex: number; status?: string | null }[],
): void {
  if (!isDbEnabled() || cases.length === 0) return;
  const client = getServiceClient();
  if (!client) return;

  void (async () => {
    try {
      const { error } = await client.from("run_cases").upsert(
        cases.map((c) => ({
          run_id: runId,
          test_case_id: c.testCaseId,
          case_index: c.caseIndex,
          status: c.status ?? null,
        })),
        { onConflict: "run_id,test_case_id" },
      );
      if (error) console.error(`[db] could not record run cases for ${runId}:`, error.message);
    } catch (err) {
      console.error(`[db] recording run cases for ${runId} threw:`, (err as Error)?.message ?? err);
    }
  })();
}

/**
 * Which organisation owns each of these runs. Runs with no row are simply absent from the map —
 * the caller decides what that means, and for authorization it must mean "deny", never "allow".
 */
export async function fetchRunOrgIds(runIds: string[]): Promise<Map<string, string> | null> {
  if (runIds.length === 0) return new Map();
  const client = getServiceClient();
  if (!client) return null;
  try {
    const { data, error } = await client
      .from("runs")
      .select("id, organisation_id")
      .in("id", runIds);
    if (error) {
      console.error("[db] run ownership lookup failed:", error.message);
      return null;
    }
    return new Map((data ?? []).map((r: { id: string; organisation_id: string }) => [r.id, r.organisation_id]));
  } catch (err) {
    console.error("[db] run ownership lookup threw:", (err as Error)?.message ?? err);
    return null;
  }
}

let lastShadowRunMs = 0;

/**
 * Compare what the database has against what disk just returned, and log the difference.
 *
 * Deliberately fire-and-forget: the caller does NOT await this, so `listRuns()` stays synchronous
 * and the /api/runs response is never delayed or endangered by a database round-trip. A slow or
 * unreachable database is invisible to the user, which is the whole point of shadow mode.
 *
 * What you're watching for: with zero divergence, this logs NOTHING at all. Any `[shadow]` line
 * naming a run id is a real disagreement worth reading before Step 3.3 flips authority.
 */
export function shadowCompareRuns(diskRuns: RunSummary[]): void {
  if (!isDbEnabled()) return;

  const now = Date.now();
  if (now - lastShadowRunMs < SHADOW_INTERVAL_MS) return;
  lastShadowRunMs = now;

  void (async () => {
    const dbRows = await fetchRunsFromDb();
    if (dbRows === null) return; // unreachable/misconfigured — already logged, never fatal

    const problems = diffRuns(diskRuns, dbRows);
    if (problems.length === 0) return; // the good case: silence
    console.error(
      `[shadow] ${problems.length} divergence(s) between disk and database ` +
      `(disk=${diskRuns.length} rows, db=${dbRows.length} rows). Disk remains authoritative:`,
    );
    for (const p of problems) console.error(`[shadow]   ${p}`);
  })();
}
