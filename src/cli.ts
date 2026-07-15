import { runPipeline } from "./orchestrator.js";

const args = process.argv.slice(2);
const arg = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const prompt = arg("prompt");
const url = arg("url");

if (!prompt || !url) {
  console.error('Usage: npm run generate -- --prompt "..." --url "https://..."');
  process.exit(1);
}

runPipeline({ prompt, url }, (e) => {
  const mark = e.status === "started" ? "…" : e.status === "completed" ? "✓" : "✗";
  console.log(`[${mark}] ${e.stage}${e.error ? ": " + e.error : ""}`);
})
  .then(r => {
    console.log(`\nRun ${r.runId}: ${r.result.passed ? "✅ PASSED" : "❌ FAILED"}`);
    console.log(`Artifacts: ${r.runDir}`);
    if (r.diagnosis) console.log(`Diagnosis: ${r.diagnosis.explanation}`);
  })
  .catch(e => { console.error(e); process.exit(1); });
