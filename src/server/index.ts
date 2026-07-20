import express from "express";
import path from "node:path";
import { rmSync } from "node:fs";
import { runPipeline, makeRunId } from "../orchestrator.js";
import { record, subscribe, getEvents } from "./runRegistry.js";
import { listRuns } from "../runStore.js";
import { Semaphore } from "./concurrency.js";

// Bound concurrent runs (each launches Chromium). Tune via env as the box grows.
const runLimit = new Semaphore(Number(process.env.MAX_CONCURRENT_RUNS ?? 3));

const app = express();
app.use(express.json());
app.use(express.static("public"));
app.use("/runs", express.static("runs"));   // serves screenshots/trace/spec directly by path

// Start a run: generate the runId up front so we can hand it back immediately,
// then let the pipeline run in the background, pushing events into the registry.
app.post("/api/runs", (req, res) => {
  const { prompt, url } = req.body ?? {};
  if (!prompt || !url) return res.status(400).json({ error: "prompt and url are required" });

  const runId = makeRunId();
  // Hand back the runId immediately; the run waits for a free slot, then executes.
  // Over-cap runs sit queued (UI shows pending) until a slot frees — no dropped requests.
  runLimit.run(() => runPipeline({ prompt, url }, record, runId))
    .catch(() => { /* failure already emitted as an "error" event */ });
  res.status(202).json({ runId });
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
// makeRunId() shape before building a path — that regex has no "/", "." or ".." so it can't
// escape runs/ (and won't match "_cache"). rmSync with force so an already-gone run is a no-op.
app.delete("/api/runs/:runId", (req, res) => {
  const { runId } = req.params;
  if (!/^[\dT-]+Z-[0-9a-f]{8}$/.test(runId)) return res.status(400).json({ error: "invalid runId" });
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
