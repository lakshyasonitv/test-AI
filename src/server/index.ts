import express from "express";
import path from "node:path";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, makeRunId } from "../orchestrator.js";
import { record, subscribe, getEvents } from "./runRegistry.js";
import { listRuns } from "../runStore.js";
import { Semaphore } from "./concurrency.js";
import { askCredentials, settle } from "./pendingCredentials.js";
import { CaseSelectionDecisionSchema } from "../schema/caseSelection.js";
import { resolveCaseSelection, getPendingSelection } from "./pendingCaseSelection.js";
import { getAllAcceptedCases, remainingCapacity } from "./caseAccumulator.js";
import { startRetentionJob } from "./retention.js";
import { requireAuth, resolveUser, isAuthEnabled } from "./auth.js";

import { isAllowedEntryUrl } from "../stages/hybridDiscovery.js";

/** runId shape from makeRunId(). No "/", "." or ".." so it can never escape runs/. */
const RUN_ID = /^[\dT-]+Z-[0-9a-f]{8}$/;

// Bound concurrent runs (each launches Chromium). Tune via env as the box grows.
const runLimit = new Semaphore(Number(process.env.MAX_CONCURRENT_RUNS ?? 3));

const app = express();
app.use(express.json());
app.use(express.static("public"));

// Identity for every /api/* route (implentationplan.md Step 2.1). With AUTH_ENABLED off this is a
// pass-through that just attaches the synthetic LOCAL_USER, so behavior is unchanged — see
// auth.ts's header for why it attaches a user instead of skipping.
// Both of these must stay reachable without a credential, or login is unreachable by
// construction: the UI has to be able to ask "is auth even on, and where do I authenticate?"
// before it can possibly hold a token. Neither returns a secret — /api/health reports only
// whether each env var is set, /api/auth/config returns only browser-safe publishable values.
const PUBLIC_API_PATHS = new Set(["/health", "/auth/config"]);

app.use("/api", (req, res, next) => {
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  return void requireAuth(req, res, next);
});

// Access control for artifact files. Tenancy ("does THIS user own THIS run") is Step 3.4; the
// only question this phase can answer is whether the caller is authenticated at all. With
// AUTH_ENABLED off, resolveUser always returns the synthetic user, so this stays unconditionally
// true — identical to the blanket `express.static("runs")` mount this route replaced.
async function canAccessRun(req: express.Request, _runId: string): Promise<boolean> {
  return (await resolveUser(req)) !== null;
}

const RUNS_DIR = path.resolve("runs");

// Serves screenshots/trace/spec/every stage-JSON snapshot directly by path — was
// `express.static("runs")`, replaced with an explicit route so a guard can sit in front of it
// (Phase 1, Step 1.1). The wildcard captures the full remainder of the path: artifact trees nest
// arbitrarily deep under a Playwright-generated slug directory
// (`cases/<caseId>/artifacts/<slug>/video.webm`), so this can't be a small set of fixed patterns —
// it must pass through anything under runs/<runId>/**, same as the static mount did.
app.get("/runs/:runId/*", async (req, res) => {
  // @types/express doesn't type the trailing "*" segment's capture group on req.params — it's
  // real at runtime (Express 4's wildcard route matching), just not reflected in the types.
  const rel = (req.params as Record<string, string>)[0] ?? "";
  const abs = path.resolve(RUNS_DIR, req.params.runId, rel);
  // Path traversal guard: the resolved path must stay inside RUNS_DIR.
  if (!abs.startsWith(RUNS_DIR + path.sep)) return res.sendStatus(403);
  if (!(await canAccessRun(req, req.params.runId))) return res.sendStatus(403); // no-op today
  res.sendFile(abs, (err) => {
    // sendFile already sent a response (or started one) on success; only translate a real miss
    // (nonexistent file, or a directory — sendFile can't serve those either) into a 404, matching
    // what the static mount effectively returned for the same cases.
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

// Uniform validation middleware for any route parameter named :runId
app.param("runId", (_req, res, next, runId) => {
  if (!RUN_ID.test(runId)) return res.status(400).json({ error: "invalid runId" });
  next();
});

// Start a run: generate the runId up front so we can hand it back immediately,
// then let the pipeline run in the background, pushing events into the registry.
app.post("/api/runs", (req, res) => {
  const { prompt, url, urls, coverage, options } = req.body ?? {};
  if (!prompt || (!url && !urls?.length)) return res.status(400).json({ error: "prompt and url (or urls) are required" });

  const checkUrls = (urls && Array.isArray(urls) && urls.length ? urls : [url]) as unknown[];
  for (const u of checkUrls) {
    if (typeof u !== "string") {
      return res.status(400).json({ error: "URLs must be strings" });
    }
    const check = isAllowedEntryUrl(u);
    if (!check.ok) {
      return res.status(400).json({ error: check.reason });
    }
  }

  const VALID_COVERAGE = ["minimal", "standard", "full"];
  if (coverage && !VALID_COVERAGE.includes(coverage)) {
    return res.status(400).json({ error: `Invalid coverage "${coverage}". Use: minimal, standard, or full` });
  }

  // Only the two known booleans are forwarded — the body is untrusted input, and
  // spreading it straight into runPipeline would let a caller set anything.
  const runOptions = options && typeof options === "object"
    ? {
      ...(typeof options.gateReview === "boolean" ? { gateReview: options.gateReview } : {}),
      ...(typeof options.selfHeal === "boolean" ? { selfHeal: options.selfHeal } : {}),
    }
    : undefined;

  const runId = makeRunId();
  // Hand back the runId immediately; the run waits for a free slot, then executes.
  // Over-cap runs sit queued (UI shows pending) until a slot frees — no dropped requests.
  runLimit.run(() => runPipeline({ prompt, url, urls, coverage, options: runOptions }, record, runId, askCredentials))
    .catch(() => { /* failure already emitted as an "error" event */ });
  res.status(202).json({ runId });
});

// Answer a paused run's credential prompt. `{ skip: true }` (or empty values) means "carry on
// without them" — the same thing the wait timeout does.
//
// The body is never logged, never emitted as an event and never written to a run directory:
// it goes straight into the waiting promise and lives only in the pipeline's memory. The
// generated spec gets a process.env reference instead of the value (see credentials.ts).
app.post("/api/runs/:runId/credentials", (req, res) => {
  const { runId } = req.params;
  if (!RUN_ID.test(runId)) return res.status(400).json({ error: "invalid runId" });

  const { username, password, skip } = req.body ?? {};
  const supplied = !skip && typeof username === "string" && typeof password === "string"
    && username.length > 0 && password.length > 0;

  // `secret: true` is what routes these away from the on-disk literal path.
  const answered = settle(runId, supplied ? { username, password, secret: true } : null);
  if (!answered) return res.status(409).json({ error: "this run is not waiting for credentials" });
  res.status(204).end();
});

// Submit the user's pick for a paused run's case-selection round. `done` with no picks is
// rejected when nothing was accumulated yet, so an accidental click can't end the round with
// an empty pool. Like the credential prompt, the decision goes straight into the waiting
// promise and lives only in the pipeline's memory.
app.post("/api/runs/:runId/case-selection", express.json(), (req, res) => {
  const { runId } = req.params;
  if (!getPendingSelection(runId)) {
    return res.status(409).json({ error: "No case-selection round is pending for this run" });
  }
  const parsed = CaseSelectionDecisionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (parsed.data.action === "done") {
    const willHaveAny =
      getAllAcceptedCases(runId).length > 0 || parsed.data.selectedIndexes.length > 0;
    if (!willHaveAny) {
      return res.status(400).json({ error: "Select at least one case before clicking Done" });
    }
  }
  const resolved = resolveCaseSelection(runId, parsed.data);
  if (!resolved) {
    return res.status(409).json({ error: "This round was already resolved or timed out" });
  }
  res.status(200).json({ ok: true });
});

// Current accumulated pool state, for the frontend to render accepted cases and how much
// capacity remains before the pool's cap forces newer picks into overflow.
app.get("/api/runs/:runId/accepted-cases", (req, res) => {
  const cases = getAllAcceptedCases(req.params.runId);
  res.json({
    cases,
    count: cases.length,
    cap: Number(process.env.MAX_ACCUMULATED_CASES ?? 5),
    remainingCapacity: remainingCapacity(req.params.runId),
  });
});

// Snapshot of the currently-pending round, for polling (SSE buffers behind a Cloudflare
// tunnel, so the UI polls this instead). NOT a new event type — just what's parked right now.
app.get("/api/runs/:runId/case-selection-status", (req, res) => {
  const pending = getPendingSelection(req.params.runId);
  if (!pending) {
    return res.status(404).json({ error: "No case-selection round is pending" });
  }
  res.json({
    attempt: pending.attempt,
    batch: pending.batch,
    acceptedCount: getAllAcceptedCases(req.params.runId).length,
    cap: Number(process.env.MAX_ACCUMULATED_CASES ?? 5),
  });
});

// SSE stream of progress for one run. Fine locally; a Cloudflare Quick Tunnel buffers
// text/event-stream sent over GET and only flushes when the connection closes (which
// subscribe() never does), so the UI polls /state instead. See cloudflared#1449.
app.get("/api/runs/:runId/events", (req, res) => {
  subscribe(req.params.runId, res);
});

// Full event log as one JSON snapshot. Polling this can't be buffered by a proxy the way
// a stream can — the RunStore already persists every event, so this is just a read.
app.get("/api/runs/:runId/state", (req, res) => {
  res.json(getEvents(req.params.runId));
});

// History list: every run that has ever been executed, newest first.
app.get("/api/runs", (_req, res) => {
  res.json(listRuns());
});

// Delete one run's directory. runId comes from the URL, so validate it against the exact
// makeRunId() shape before building a path (see RUN_ID above — it also won't match "_cache").
// rmSync with force so an already-gone run is a no-op.
app.delete("/api/runs/:runId", (req, res) => {
  const { runId } = req.params;
  if (!RUN_ID.test(runId)) return res.status(400).json({ error: "invalid runId" });
  try {
    rmSync(path.join("runs", runId), { recursive: true, force: true });
    res.status(204).end();
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "delete failed" });
  }
});

// Health-check / diagnostic endpoint — never exposes secret values, only reports
// whether each critical env var is present so deployment problems surface fast.
app.get("/api/health", (_req, res) => {
  const check = (name: string) => {
    const val = process.env[name];
    return { set: !!val, length: val?.length ?? 0 };
  };
  res.json({
    status: "ok",
    env: {
      GEMINI_API_KEYS: check("GEMINI_API_KEYS"),
      GEMINI_API_KEY:  check("GEMINI_API_KEY"),
      GEMINI_MODEL:    check("GEMINI_MODEL"),
      GEMINI_MODEL_LITE: check("GEMINI_MODEL_LITE"),
      NODE_ENV:        check("NODE_ENV"),
      PORT:            check("PORT"),
    },
    // Server-side defaults for the two per-run options a client may override. The
    // UI reads these so its Settings toggles open in the state the server is
    // actually in, instead of a hardcoded guess that silently disagrees.
    defaults: {
      gateReview: process.env.ENABLE_CASE_SELECTION_GATE === "true",
      selfHeal: true,
    },
    // ADDITIVE field (Step 2.2) — appended, never reordering or replacing anything above, per
    // implentationplan.md Rule 2. The UI branches on this to decide whether a login view exists
    // at all; with auth off it's `false` and the frontend behaves exactly as it always has.
    authEnabled: isAuthEnabled(),
  });
});

// What the browser needs to talk to Supabase Auth directly (Step 2.2). A NEW route rather than
// more fields on /api/health, because health's contract is "whether each env var is set, never a
// value" and this genuinely returns values.
//
// Nothing secret is exposed: the publishable key is designed to ship in client code (it grants
// only what RLS allows). The service-role key is never read here. With auth off, the URL and key
// aren't sent at all — there's nothing for the client to do with them.
app.get("/api/auth/config", (_req, res) => {
  if (!isAuthEnabled()) return res.json({ authEnabled: false });
  res.json({
    authEnabled: true,
    url: process.env.SUPABASE_URL ?? null,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? null,
  });
});

app.get("/", (_req, res) => {
  res.sendFile(path.resolve("public/index.html"));
});

const port = Number(process.env.PORT ?? 3000);

export { app };

// Only actually start listening (and run startup-only diagnostics/jobs) when this file is
// executed directly (`npm run serve`/`start`), not when a test imports `app` to exercise routes
// via supertest — importing must never bind a real port or spin up background timers.
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  // Startup diagnostic — log which key env vars are detected so Render's deploy
  // log immediately shows whether secrets were injected.
  console.log("[startup] Environment variable check:");
  for (const v of ["GEMINI_API_KEYS", "GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_MODEL_LITE", "NODE_ENV", "PORT"]) {
    const val = process.env[v];
    console.log(`  ${v}: ${val ? `SET (${val.length} chars)` : "NOT SET"}`);
  }

  app.listen(port, () => console.log(`AI Test Platform UI: http://localhost:${port}`));

  // No-op unless RUN_RETENTION_DAYS is set (TECH_DEBT.md TD-16) — see src/server/retention.ts.
  startRetentionJob();
}
