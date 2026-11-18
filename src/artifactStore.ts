/**
 * Run artifacts kept in Supabase Storage, so they survive a container restart.
 *
 * WHY: production writes every run's files to `runs/` on the container's own disk, and the Azure
 * container app has no volume mounted at /app/runs (project-brain 04-tasks: "Mount the runs
 * volume"). Every deploy and every scale-to-zero therefore deleted every screenshot, and with them
 * the PDF/Excel reports, which are built from those files.
 *
 * WHAT: when a run finishes, its screenshots and the small files the run page and the reports read
 * (stage JSON, the event log, the generated spec) are uploaded to a PRIVATE bucket under
 * `<runId>/<same relative path>`. Videos and Playwright traces are not uploaded (size). When a run's
 * files are asked for and are not on disk, the whole run is downloaded back into `runs/<runId>/`
 * first, so every existing reader (the /runs file route, runStore, the report builders) keeps
 * reading the disk exactly as before.
 *
 * Nothing here is public: the bucket is private and only the server's service-role client touches
 * it; every caller restores AFTER its own access check (canAccessRun / requireRunRole). Secrets:
 * the executor already scrubs credentials out of results.json and the page captures on disk
 * (scrubServedSecrets), and the files with no scrubbing (trace.zip) are exactly the ones skipped.
 *
 * ON BY DEFAULT where the database is on (ARTIFACTS_TO_SUPABASE=false turns it off) — a deliberate
 * exception to the flag-default-off rule, chosen by the user on 2026-11-18 so production keeps its
 * screenshots without an Azure setting change. Every failure is logged and swallowed: losing an
 * upload costs a screenshot after a restart, never a run.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getServiceClient, isDbEnabled } from "./db.js";

const RUNS_DIR = path.resolve("runs");
const UPLOAD_EXT = new Set([".png", ".jpg", ".jpeg", ".json", ".ndjson", ".ts", ".txt", ".md"]);
const SKIP_NAMES = new Set(["trace.zip", "video.webm"]);
const MAX_FILE_BYTES = 8 * 1024 * 1024;
const CONCURRENCY = 6;

export function artifactBucket(): string {
  return process.env.ARTIFACTS_BUCKET || "run-artifacts";
}

export function artifactStoreEnabled(): boolean {
  return process.env.ARTIFACTS_TO_SUPABASE !== "false" && isDbEnabled() && !!getServiceClient();
}

const CONTENT_TYPE: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".json": "application/json",
  ".ndjson": "application/x-ndjson", ".ts": "text/plain", ".txt": "text/plain", ".md": "text/markdown",
};

/** Files of a run worth keeping, as paths relative to runs/<runId>. */
export function uploadableFiles(runDir: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries: import("node:fs").Dirent[] = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(path.join(dir, e.name), r); continue; }
      if (SKIP_NAMES.has(e.name) || !UPLOAD_EXT.has(path.extname(e.name).toLowerCase())) continue;
      try { if (statSync(path.join(dir, e.name)).size > MAX_FILE_BYTES) continue; } catch { continue; }
      out.push(r);
    }
  };
  walk(runDir, "");
  return out;
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const x = items[i++]; await fn(x); }
  }));
}

let bucketReady: Promise<boolean> | null = null;
function ensureBucket(): Promise<boolean> {
  if (!bucketReady) {
    bucketReady = (async () => {
      const storage = getServiceClient()!.storage;
      const name = artifactBucket();
      const got = await storage.getBucket(name);
      if (!got.error) return true;
      const made = await storage.createBucket(name, { public: false });
      if (made.error && !/already exists/i.test(made.error.message)) {
        console.error(`[artifacts] could not create bucket ${name}: ${made.error.message}`);
        bucketReady = null; // try again next time
        return false;
      }
      return true;
    })().catch((err) => {
      console.error("[artifacts] bucket check failed:", (err as Error)?.message ?? err);
      bucketReady = null;
      return false;
    });
  }
  return bucketReady;
}

const uploading = new Map<string, Promise<void>>();

/** Upload a finished run's files. Fire-and-forget; safe to call more than once. */
export function uploadRunArtifacts(runId: string): Promise<void> {
  if (!artifactStoreEnabled()) return Promise.resolve();
  const prev = uploading.get(runId) ?? Promise.resolve();
  const next = prev.then(async () => {
    try {
      if (!(await ensureBucket())) return;
      const runDir = path.join(RUNS_DIR, runId);
      const files = uploadableFiles(runDir);
      if (!files.length) return;
      const bucket = getServiceClient()!.storage.from(artifactBucket());
      let failed = 0;
      await pool(files, CONCURRENCY, async (rel) => {
        try {
          const body = readFileSync(path.join(runDir, ...rel.split("/")));
          const { error } = await bucket.upload(`${runId}/${rel}`, body, {
            contentType: CONTENT_TYPE[path.extname(rel).toLowerCase()] ?? "application/octet-stream",
            upsert: true,
          });
          if (error) failed++;
        } catch { failed++; }
      });
      console.log(`[artifacts] ${runId}: uploaded ${files.length - failed}/${files.length} file(s) to storage`);
    } catch (err) {
      console.error(`[artifacts] upload of ${runId} failed:`, (err as Error)?.message ?? err);
    }
  });
  uploading.set(runId, next);
  next.finally(() => { if (uploading.get(runId) === next) uploading.delete(runId); });
  return next;
}

/** Upload once the run has settled: its last files (suite summary, report inputs) land just after "done". */
export function uploadRunArtifactsSoon(runId: string, delayMs = 3000): void {
  if (!artifactStoreEnabled()) return;
  setTimeout(() => { void uploadRunArtifacts(runId); }, delayMs).unref?.();
}

const restoring = new Map<string, Promise<boolean>>();
const missUntil = new Map<string, number>();

/** Every object under `<runId>/` in the bucket, as relative paths (the storage list is per folder). */
async function listRemote(runId: string): Promise<string[]> {
  const bucket = getServiceClient()!.storage.from(artifactBucket());
  const out: string[] = [];
  const walk = async (prefix: string, depth: number): Promise<void> => {
    if (depth > 8) return;
    for (let offset = 0; ; offset += 1000) {
      const { data, error } = await bucket.list(prefix, { limit: 1000, offset });
      if (error || !data?.length) return;
      for (const e of data) {
        const p = `${prefix}/${e.name}`;
        if (e.id == null) await walk(p, depth + 1); // a folder
        else out.push(p.slice(runId.length + 1));
      }
      if (data.length < 1000) return;
    }
  };
  await walk(runId, 0);
  return out;
}

/**
 * Make sure `runs/<runId>/` is on disk, downloading it from storage when it is not.
 * `wantRel`, when given, is the one file the caller needs: if it is already on disk nothing is fetched.
 * Call only AFTER the caller's own access check. Never throws; false = nothing restored.
 */
export async function ensureRunLocal(runId: string, wantRel?: string): Promise<boolean> {
  if (!artifactStoreEnabled()) return false;
  const runDir = path.join(RUNS_DIR, runId);
  if (wantRel ? existsSync(path.join(runDir, wantRel)) : existsSync(path.join(runDir, "00-input.json"))) return true;
  if ((missUntil.get(runId) ?? 0) > Date.now()) return false;
  const inflight = restoring.get(runId);
  if (inflight) return inflight;

  const job = (async () => {
    try {
      if (!(await ensureBucket())) return false;
      const files = await listRemote(runId);
      if (!files.length) { missUntil.set(runId, Date.now() + 60_000); return false; }
      const bucket = getServiceClient()!.storage.from(artifactBucket());
      let got = 0;
      await pool(files, CONCURRENCY, async (rel) => {
        const dest = path.join(runDir, ...rel.split("/"));
        // Containment: a stored name can never write outside this run's folder.
        if (!path.resolve(dest).startsWith(path.resolve(runDir) + path.sep)) return;
        if (existsSync(dest)) { got++; return; }
        const { data, error } = await bucket.download(`${runId}/${rel}`);
        if (error || !data) return;
        mkdirSync(path.dirname(dest), { recursive: true });
        writeFileSync(dest, Buffer.from(await data.arrayBuffer()));
        got++;
      });
      console.log(`[artifacts] ${runId}: restored ${got}/${files.length} file(s) from storage`);
      // A file that is still missing now does not exist in storage either; don't list again for it.
      missUntil.set(runId, Date.now() + 60_000);
      return got > 0;
    } catch (err) {
      console.error(`[artifacts] restore of ${runId} failed:`, (err as Error)?.message ?? err);
      return false;
    } finally {
      restoring.delete(runId);
    }
  })();
  restoring.set(runId, job);
  return job;
}
