import { runPipeline } from "./orchestrator.js";

type Coverage = "minimal" | "standard" | "full";
const VALID_COVERAGE: Coverage[] = ["minimal", "standard", "full"];

const args = process.argv.slice(2);
const arg = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const prompt = arg("prompt");
const url = arg("url");
const urlsRaw = arg("urls");
const coverageRaw = arg("coverage") ?? "standard";

if (!prompt || (!url && !urlsRaw)) {
  console.error('Usage: npm run generate -- --prompt "..." --url "https://..."');
  console.error('   or: npm run generate -- --prompt "..." --urls "https://page1,https://page2"');
  console.error('Options:');
  console.error('  --coverage <minimal|standard|full>  Number of test cases (default: standard)');
  process.exit(1);
}

if (!VALID_COVERAGE.includes(coverageRaw as Coverage)) {
  console.error(`Invalid coverage "${coverageRaw}". Use: minimal, standard, or full`);
  process.exit(1);
}
const coverage = coverageRaw as Coverage;

const urls = urlsRaw ? urlsRaw.split(",").map((s) => s.trim()).filter(Boolean) : undefined;

runPipeline({ prompt, url, urls, coverage }, (e) => {
  const mark = e.status === "started" ? "…" : e.status === "completed" ? "✓" : "✗";
  console.log(`[${mark}] ${e.stage}${e.error ? ": " + e.error : ""}`);
})
  .then(r => {
    if (!r.result) {
      console.log(`\nRun ${r.runId}: no test cases were selected — nothing ran.`);
    } else {
      console.log(`\nRun ${r.runId}: ${r.result.passed ? "✅ PASSED" : "❌ FAILED"}`);
    }
    console.log(`Artifacts: ${r.runDir}`);
    if (r.diagnosis) console.log(`Diagnosis: ${r.diagnosis.explanation}`);
  })
  .catch(e => { console.error(e); process.exit(1); });
