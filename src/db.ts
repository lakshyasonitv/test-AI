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
 * Service-role client. Reads bypass row-level security, which is deliberate and why this key must
 * never reach a browser: the tables are RLS deny-all precisely so the publishable key can't read
 * them directly, and the server is the only thing allowed through.
 */
function getServiceClient(): SupabaseClient | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) {
    // Actionable once, not once per request — this fires on a polled endpoint.
    if (!warnedMissingKey) {
      warnedMissingKey = true;
      console.error(
        "[shadow] DB_ENABLED=true but SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set. " +
        "Copy the service_role key from Supabase Dashboard -> Project Settings -> API into .env. " +
        "Falling back to disk only; nothing is broken, the shadow comparison is just not running.",
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
    const { data, error } = await client
      .from("runs")
      .select("id, prompt, url, status, started_at")
      .eq("organisation_id", DEFAULT_ORG_ID)
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
