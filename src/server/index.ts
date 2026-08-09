import express from "express";
import path from "node:path";
import { rmSync } from "node:fs";
import { runPipeline, makeRunId } from "../orchestrator.js";
import { record, subscribe, getEvents } from "./runRegistry.js";
import { listRuns } from "../runStore.js";
import { Semaphore } from "./concurrency.js";
import { askCredentials, settle } from "./pendingCredentials.js";
import { CaseSelectionDecisionSchema } from "../schema/caseSelection.js";
import { resolveCaseSelection, getPendingSelection } from "./pendingCaseSelection.js";
import { getAllAcceptedCases, remainingCapacity } from "./caseAccumulator.js";

import { isAllowedEntryUrl } from "../stages/hybridDiscovery.js";

/** runId shape from makeRunId(). No "/", "." or ".." so it can never escape runs/. */
const RUN_ID = /^[\dT-]+Z-[0-9a-f]{8}$/;

// Bound concurrent runs (each launches Chromium). Tune via env as the box grows.
const runLimit = new Semaphore(Number(process.env.MAX_CONCURRENT_RUNS ?? 3));

const app = express();
app.use(express.json());
app.use(express.static("public"));
app.use("/runs", express.static("runs"));   // serves screenshots/trace/spec directly by path

// Uniform validation middleware for any route parameter named :runId
app.param("runId", (_req, res, next, runId) => {
  if (!RUN_ID.test(runId)) return res.status(400).json({ error: "invalid runId" });
  next();
});

// Start a run: generate the runId up front so we can hand it back immediately,
// then let the pipeline run in the background, pushing events into the registry.
app.post("/api/runs", (req, res) => {
  const { prompt, url, urls, coverage } = req.body ?? {};
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

  const runId = makeRunId();
  // Hand back the runId immediately; the run waits for a free slot, then executes.
  // Over-cap runs sit queued (UI shows pending) until a slot frees — no dropped requests.
  runLimit.run(() => runPipeline({ prompt, url, urls, coverage }, record, runId, askCredentials))
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

app.get("/", (_req, res) => {
  res.sendFile(path.resolve("public/index.html"));
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`AI Test Platform UI: http://localhost:${port}`));
