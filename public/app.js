const PHASES = [
  { key: "understand", label: "Understanding your request", stages: ["plan"] },
  { key: "analyze", label: "Analyzing the site", stages: ["discovery"] },
  { key: "build_run", label: "Building & running the test", stages: ["testcases", "ir", "generate", "execute"] },
  { key: "results", label: "Results", stages: ["failure_analysis", "heal"] },
];
const STAGE_TO_PHASE = Object.fromEntries(
  PHASES.flatMap((p) => p.stages.map((s) => [s, p.key]))
);

const TEMPLATES = [
  { label: "Login test", prompt: "Test the login functionality: attempt to log in with invalid credentials and verify an appropriate error is shown." },
  { label: "Homepage smoke test", prompt: "Verify the homepage loads successfully and key elements (header, navigation, main content) are visible." },
  { label: "Navigation test", prompt: "Verify the main navigation links work and lead to valid pages without errors." },
  { label: "Search test", prompt: "Test the search feature: enter a query and verify relevant results are displayed." },
  { label: "Form validation test", prompt: "Find a form on the page and verify it shows validation errors when submitted with empty required fields." },
];

const templatesEl = document.getElementById("templates");
const historyListEl = document.getElementById("historyList");
const phasesEl = document.getElementById("stages");
const form = document.getElementById("runForm");
const promptEl = document.getElementById("prompt");
const urlEl = document.getElementById("url");
const finalResult = document.getElementById("finalResult");
const verdictEl = document.getElementById("verdict");
const testSummaryEl = document.getElementById("testSummary");
const testTitleEl = document.getElementById("testTitle");
const testStepsEl = document.getElementById("testSteps");
const testExpectedEl = document.getElementById("testExpected");
const screenshotFigureEl = document.getElementById("screenshotFigure");
const screenshotEl = document.getElementById("screenshot");
const diagnosisEl = document.getElementById("diagnosis");
const traceLinkEl = document.getElementById("traceLink");

function renderTemplates() {
  templatesEl.innerHTML = TEMPLATES.map(
    (t, i) => `<button type="button" class="template-btn" data-i="${i}">${t.label}</button>`
  ).join("");
  templatesEl.querySelectorAll(".template-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      promptEl.value = TEMPLATES[Number(btn.dataset.i)].prompt;
    });
  });
}

function renderPhases() {
  phasesEl.innerHTML = PHASES.map(
    (p) => `
    <li data-phase="${p.key}" class="pending">
      <span class="dot"></span>
      <span class="label">${p.label}</span>
      <span class="summary-text"></span>
      <details class="output hidden">
        <summary>Technical details</summary>
        <pre></pre>
      </details>
    </li>`
  ).join("");
}

// One short, human-readable line per stage — the raw payload (role/name targets, IR JSON,
// generated code) is still available in the collapsed <details> for anyone who wants it, but
// an end user shouldn't have to read a JSON blob to know what's happening.
function summarize(stage, data) {
  try {
    switch (stage) {
      case "plan": return data.goal ?? "";
      case "discovery": {
        const concepts = [...new Set((data.pages ?? []).flatMap((p) => p.concepts ?? []))];
        return `Found ${data.pages?.length ?? 0} page(s)${concepts.length ? " — " + concepts.join(", ") : ""}`;
      }
      case "testcases": {
        const count = data.total ?? data.length ?? 0;
        const extra = data.reactive ? ` (${data.reactive} reactive)` : "";
        return `Generated ${count} test case(s)${extra}`;
      }
      case "ir": return `Test plan: ${data.meta?.title ?? ""}`;
      case "generate": return "Test script generated";
      case "execute": return data.passed ? "Executed — passed" : "Executed — failed";
      case "heal": return data.healed ? "Automatically repaired a broken step" : "Attempted a repair — it didn't resolve the failure";
      default: return "";
    }
  } catch { return ""; }
}

// A phase spanning several internal stages naturally ends up showing the status/data
// of whichever child stage most recently reported in, since they run in fixed order.
function setPhaseFromStage(stage, status, data) {
  const phaseKey = STAGE_TO_PHASE[stage];
  if (!phaseKey) return; // "input"/"done"/"error" aren't part of any phase row
  const li = phasesEl.querySelector(`li[data-phase="${phaseKey}"]`);
  if (!li) return;
  li.className = status;
  if (data !== undefined) {
    li.querySelector(".summary-text").textContent = summarize(stage, data);
    const details = li.querySelector(".output");
    details.querySelector("pre").textContent = JSON.stringify(data, null, 2);
    details.classList.remove("hidden");
  }
}

const STATUS_LABEL = { passed: "Passed", failed: "Failed", error: "Error", incomplete: "Incomplete" };

// Test steps can legitimately contain raw markup (the security coverage cases fill fields
// with literal <script> payloads) — never trust them into innerHTML unescaped.
const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function loadHistory() {
  const res = await fetch("/api/runs");
  const runs = await res.json();
  if (!runs.length) {
    historyListEl.innerHTML = `<li class="history-empty">No runs yet.</li>`;
    return;
  }
  historyListEl.innerHTML = runs.map((r) => `
    <li class="history-item${r.hasEvents ? "" : " no-detail"}" data-run-id="${r.runId}">
      <span class="badge ${r.status}">${STATUS_LABEL[r.status] ?? r.status}</span>
      <span class="hprompt">${r.prompt || "(no prompt)"}</span>
      <span class="hurl">${r.url}</span>
      ${r.hasEvents ? "" : '<span class="hurl">(no detailed log)</span>'}
      <button type="button" class="history-del" title="Delete this run" aria-label="Delete run">✕</button>
    </li>`).join("");
  historyListEl.querySelectorAll(".history-item:not(.no-detail)").forEach((li) => {
    li.addEventListener("click", () => connectToRun(li.dataset.runId));
  });
  historyListEl.querySelectorAll(".history-del").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();          // don't also open the run (the <li> has a click handler)
      const runId = btn.closest(".history-item").dataset.runId;
      if (!confirm("Delete this run permanently?")) return;
      await fetch(`/api/runs/${runId}`, { method: "DELETE" });
      loadHistory();
    });
  });
}

// Render one event into the panel. Returns true if it's the run's terminal event.
function applyEvent(event, runId) {
  if (event.stage === "done" || event.stage === "error") {
    finalResult.classList.remove("hidden");
    const passed = event.data?.passed;
    const partial = event.data?.partial;
    const healed = event.data?.healed;
    verdictEl.textContent =
      event.stage === "error" ? `⚠️ Pipeline error: ${event.error}` :
      passed && healed ? "✅ Passed (self-healed — a locator broke and was automatically repaired; see below)" :
      passed ? (partial ? "✅ Passed (partial — verified as far as the flow could be grounded)" : "✅ Passed") :
      "❌ Failed";

    // Plain-English record of what actually ran, so the verdict isn't just a bare badge.
    const test = event.data?.test;
    if (test) {
      testTitleEl.textContent = test.title ?? "";
      testStepsEl.innerHTML = (test.steps ?? []).map((s) => `<li>${escapeHtml(s)}</li>`).join("");
      testExpectedEl.textContent = test.expected ? `Expected: ${test.expected}` : "";
      testSummaryEl.classList.remove("hidden");
    } else {
      testSummaryEl.classList.add("hidden");
    }

    // Show the run's screenshot (Playwright captures one on pass and fail).
    const shot = event.data?.screenshotUrl;
    if (shot) {
      screenshotEl.src = shot;
      screenshotFigureEl.classList.remove("hidden");
    } else {
      screenshotFigureEl.classList.add("hidden");
    }

    traceLinkEl.href = `/runs/${runId}/generated/`;
    traceLinkEl.classList.remove("hidden");
    loadHistory();
    return true;
  }

  setPhaseFromStage(event.stage, event.status, event.data);

  if (event.stage === "failure_analysis" && event.status === "completed") {
    diagnosisEl.textContent = event.data?.explanation
      ? `${event.data.explanation} — ${event.data.suggestedFix}`
      : "";
  }
  return false;
}

// Only the newest connectToRun may drive the panel; an older poll loop seeing a stale
// generation exits instead of fighting the current run for the same DOM nodes.
let pollGeneration = 0;

// Polls the durable event log rather than streaming it: a Cloudflare Quick Tunnel buffers
// SSE-over-GET until the connection closes, so through a tunnel the stream delivers nothing
// until the run ends. Every event is already on disk (RunStore), so this reads the same
// history — for a finished run from the History list, the first poll paints the whole thing.
async function connectToRun(runId) {
  const generation = ++pollGeneration;
  renderPhases();
  finalResult.classList.add("hidden");
  testSummaryEl.classList.add("hidden");
  diagnosisEl.textContent = "";
  screenshotFigureEl.classList.add("hidden");
  screenshotEl.removeAttribute("src");

  let seen = 0;
  let fails = 0;
  while (generation === pollGeneration) {
    let done = false;
    try {
      const res = await fetch(`/api/runs/${runId}/state`);
      const events = await res.json();
      if (!Array.isArray(events)) throw new Error("bad payload");
      for (const event of events.slice(seen)) if (applyEvent(event, runId)) done = true;
      // Only advance after a good read — moving it on a failed fetch would rewind `seen`
      // to 0 and replay the whole log on the next poll.
      seen = events.length;
      if (fails && !done) { finalResult.classList.add("hidden"); verdictEl.textContent = ""; }
      fails = 0;
    } catch {
      // A blip (mobile data, tunnel hiccup) is normal — keep the cursor and retry. But say so
      // once it's persistent, or a dead server/stale route just looks like a stuck spinner.
      if (++fails === 5) {
        finalResult.classList.remove("hidden");
        verdictEl.textContent = "⚠️ Lost contact with the server — retrying…";
      }
    }
    if (done) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const prompt = promptEl.value.trim();
  const url = urlEl.value.trim();
  if (!prompt || !url) return;

  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, url }),
  });
  const { runId } = await res.json();
  connectToRun(runId);
});

renderTemplates();
renderPhases();
loadHistory();
