import express from "express";
import path from "node:path";
import { runPipeline, makeRunId } from "../orchestrator.js";
import { record, subscribe } from "./runRegistry.js";
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

// SSE stream of progress for one run.
app.get("/api/runs/:runId/events", (req, res) => {
  subscribe(req.params.runId, res);
});

// History list: every run that has ever been executed, newest first.
app.get("/api/runs", (_req, res) => {
  res.json(listRuns());
});

app.get("/", (_req, res) => {
  res.sendFile(path.resolve("public/index.html"));
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`AI Test Platform UI: http://localhost:${port}`));
