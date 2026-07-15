const PHASES = [
  { key: "understand", label: "Understanding your request", stages: ["plan"] },
  { key: "analyze", label: "Analyzing the site", stages: ["discovery"] },
  { key: "build_run", label: "Building & running the test", stages: ["testcases", "ir", "generate", "execute"] },
  { key: "results", label: "Results", stages: ["failure_analysis"] },
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
      <pre class="output hidden"></pre>
    </li>`
  ).join("");
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
    const pre = li.querySelector(".output");
    pre.textContent = JSON.stringify(data, null, 2);
    pre.classList.remove("hidden");
  }
}

const STATUS_LABEL = { passed: "Passed", failed: "Failed", error: "Error", incomplete: "Incomplete" };

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
    </li>`).join("");
  historyListEl.querySelectorAll(".history-item:not(.no-detail)").forEach((li) => {
    li.addEventListener("click", () => connectToRun(li.dataset.runId));
  });
}

// Drives the phase panel for a run, whether it was just submitted or is being replayed
// from history. subscribe() on the server replays a finished run's full event log
// before closing the stream, so a historical runId here launches no new browser/test.
function connectToRun(runId) {
  renderPhases();
  finalResult.classList.add("hidden");
  diagnosisEl.textContent = "";

  const source = new EventSource(`/api/runs/${runId}/events`);
  source.onmessage = (ev) => {
    const event = JSON.parse(ev.data);

    if (event.stage === "done" || event.stage === "error") {
      source.close();
      finalResult.classList.remove("hidden");
      const passed = event.data?.passed;
      verdictEl.textContent =
        event.stage === "error" ? `⚠️ Pipeline error: ${event.error}` :
        passed ? "✅ Passed" : "❌ Failed";
      const traceUrl = `/runs/${runId}/generated/`;
      traceLinkEl.href = traceUrl;
      traceLinkEl.classList.remove("hidden");
      loadHistory();
      return;
    }

    setPhaseFromStage(event.stage, event.status, event.data);

    if (event.stage === "failure_analysis" && event.status === "completed") {
      diagnosisEl.textContent = event.data?.explanation
        ? `${event.data.explanation} — ${event.data.suggestedFix}`
        : "";
    }
  };
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
