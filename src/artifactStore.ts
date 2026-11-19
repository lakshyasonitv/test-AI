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
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * The earliest run id that can be in storage, in the run-id format (`2026-11-18T08-16-00`). Uploads
 * shipped on 2026-11-18 around 08:16 UTC; anything older was never uploaded. ARTIFACTS_SINCE overrides.
 */
export function artifactsSince(): string {
  return process.env.ARTIFACTS_SINCE || "2026-11-18T08-16-00";
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
      // The run's file list, so a restore reads one small object instead of walking every folder.
      try {
        await bucket.upload(`${runId}/${MANIFEST}`, Buffer.from(JSON.stringify({ files }), "utf8"),
          { contentType: "application/json", upsert: true });
        manifests.set(runId, files);
      } catch { /* a missing manifest only costs a listing later */ }
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
/** The stored file list of a run (`<runId>/_manifest.json`), cached once read. */
const MANIFEST = "_manifest.json";
/** Marker in runs/<runId>/ meaning "small files restored, screenshots not yet". */
const SMALL_ONLY = ".restored-without-images";
const manifests = new Map<string, string[]>();
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"]);
const isImage = (rel: string): boolean => IMAGE_EXT.has(path.extname(rel).toLowerCase());

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

/** Download one stored file into runs/<runId>/<rel>. True when it is on disk afterwards. */
async function downloadOne(runId: string, rel: string): Promise<boolean> {
  const runDir = path.join(RUNS_DIR, runId);
  const dest = path.join(runDir, ...rel.split("/"));
  // Containment: a stored name can never write outside this run's folder.
  if (!path.resolve(dest).startsWith(path.resolve(runDir) + path.sep)) return false;
  if (existsSync(dest)) return true;
  const { data, error } = await getServiceClient()!.storage.from(artifactBucket()).download(`${runId}/${rel}`);
  if (error || !data) return false;
  mkdirSync(path.dirname(dest), { recursive: true });
  writeFileSync(dest, Buffer.from(await data.arrayBuffer()));
  return true;
}

/**
 * The run's stored file list: its manifest when there is one (one small download), else a walk of
 * its folders, after which the manifest is written so the walk happens once per run, ever.
 */
async function remoteFiles(runId: string): Promise<string[]> {
  const cached = manifests.get(runId);
  if (cached) return cached;
  const bucket = getServiceClient()!.storage.from(artifactBucket());
  let files: string[] = [];
  try {
    const { data } = await bucket.download(`${runId}/${MANIFEST}`);
    if (data) files = (JSON.parse(await data.text())?.files ?? []).filter((f: unknown) => typeof f === "string");
  } catch { /* no manifest yet */ }
  if (!files.length) {
    files = (await listRemote(runId)).filter((f) => f !== MANIFEST);
    if (files.length) {
      void bucket.upload(`${runId}/${MANIFEST}`, Buffer.from(JSON.stringify({ files }), "utf8"),
        { contentType: "application/json", upsert: true }).catch(() => {});
    }
  }
  if (files.length) manifests.set(runId, files);
  return files;
}

const fileMiss = new Map<string, number>();

/**
 * Make sure a run's files are on disk, downloading only what is needed, AFTER the caller's own
 * access check. Never throws; false = nothing could be had.
 *
 * - `wantRel` given: that ONE file (a screenshot the page is showing, a JSON a route reads). One
 *   download, ~0.3 s, instead of the whole run (~15 s for a large run, measured 2026-11-18).
 * - otherwise: the run's small files (stage JSON, event log, spec) for the run page and reports,
 *   and with `images: true` its screenshots too (the PDF/HTML report embeds them).
 */
export async function ensureRunLocal(runId: string, wantRel?: string, opts: { images?: boolean } = {}): Promise<boolean> {
  if (!artifactStoreEnabled()) return false;
  const runDir = path.join(RUNS_DIR, runId);
  // A run started before uploads existed was never uploaded: answer at once instead of asking
  // storage (~1.4 s per request, measured 2026-11-18). Run ids are sortable ISO stamps.
  const preUpload = runId < artifactsSince();

  if (wantRel) {
    if (existsSync(path.join(runDir, wantRel))) return true;
    if (preUpload) return false;
    const key = `${runId}/${wantRel}`;
    if ((fileMiss.get(key) ?? 0) > Date.now()) return false;
    try {
      if (!(await ensureBucket())) return false;
      if (await downloadOne(runId, wantRel)) return true;
    } catch { /* treated as missing */ }
    fileMiss.set(key, Date.now() + 30 * 60_000);
    return false;
  }

  // On disk already: a run made on this machine, or one whose small files were restored. Only a
  // run restored WITHOUT images (marked SMALL_ONLY) needs a trip to storage, and only for images.
  const onDisk = existsSync(path.join(runDir, "00-input.json"));
  const smallOnly = existsSync(path.join(runDir, SMALL_ONLY));
  if (onDisk && (!opts.images || !smallOnly)) return true;
  if (preUpload) return onDisk;
  const flag = opts.images ? "all" : "small";
  const jobKey = `${runId}:${flag}`;
  if ((missUntil.get(runId) ?? 0) > Date.now() && !existsSync(path.join(runDir, "00-input.json"))) return false;
  const inflight = restoring.get(jobKey);
  if (inflight) return inflight;

  const job = (async () => {
    try {
      if (!(await ensureBucket())) return false;
      const all = await remoteFiles(runId);
      if (!all.length) {
        missUntil.set(runId, Date.now() + 30 * 60_000);
        return existsSync(path.join(runDir, "00-input.json"));
      }
      const wanted = all.filter((rel) => (opts.images || !isImage(rel)) && !existsSync(path.join(runDir, ...rel.split("/"))));
      if (!wanted.length) return true;
      let got = 0;
      await pool(wanted, CONCURRENCY, async (rel) => {
        try { if (await downloadOne(runId, rel)) got++; } catch { /* skip */ }
      });
      // Remember whether the images are still to come, so a later report asks for them and the
      // run page does not ask storage again.
      try {
        if (flag === "small") writeFileSync(path.join(runDir, SMALL_ONLY), "");
        else rmSync(path.join(runDir, SMALL_ONLY), { force: true });
      } catch { /* marker is an optimisation */ }
      console.log(`[artifacts] ${runId}: restored ${got}/${wanted.length} ${flag === "all" ? "" : "small "}file(s) from storage`);
      return got > 0 || existsSync(path.join(runDir, "00-input.json"));
    } catch (err) {
      console.error(`[artifacts] restore of ${runId} failed:`, (err as Error)?.message ?? err);
      return false;
    } finally {
      restoring.delete(jobKey);
    }
  })();
  restoring.set(jobKey, job);
  return job;
}
