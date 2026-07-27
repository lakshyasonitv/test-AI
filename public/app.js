// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

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

const STATUS_LABEL = {
  passed: "Passed", failed: "Failed", error: "Error", incomplete: "Incomplete",
  truncated: "Truncated", truncated_no_assertion: "Partial (no assertion)",
};

// -----------------------------------------------------------------------------
// DOM references
// -----------------------------------------------------------------------------

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
const suiteProgressEl = document.getElementById("suiteProgress");
const suiteProgressListEl = document.getElementById("suiteProgressList");
const suiteResultsEl = document.getElementById("suiteResults");
const suiteSummaryHeaderEl = document.getElementById("suiteSummaryHeader");
const suiteCaseListEl = document.getElementById("suiteCaseList");

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// -----------------------------------------------------------------------------
// Templates (quick-fill buttons)
// -----------------------------------------------------------------------------

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

// -----------------------------------------------------------------------------
// Phase pipeline (progress dots)
// -----------------------------------------------------------------------------

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
      case "suite": return data.summary ? `Suite: ${data.summary.passed}/${data.summary.total} passed` : "";
      default: return "";
    }
  } catch { return ""; }
}

function setPhaseFromStage(stage, status, data) {
  const phaseKey = STAGE_TO_PHASE[stage];
  if (!phaseKey) return;
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

  // -----------------------------------------------------------------------------
  // Suite progress (live updates during execution)
  // -----------------------------------------------------------------------------

  function renderSuiteProgress(suiteSummary, runningCaseId) {
    if (!suiteSummary || !suiteSummary.cases) return;
    suiteProgressEl.classList.remove("hidden");
    suiteProgressListEl.innerHTML = suiteSummary.cases.map((c, i) => {
      const isRunning = c.caseId === runningCaseId;
      const statusClass = isRunning ? "running" : c.status;
      const statusIcon = isRunning ? "⏳" :
        c.status === "passed" ? "✔" :
          c.status === "failed" ? "✘" :
            c.status === "truncated" ? "⚠" : "○";
      return `
      <div class="suite-progress-item ${statusClass}">
        <span class="suite-progress-icon">${statusIcon}</span>
        <span class="suite-progress-label">Case ${i + 1} / ${suiteSummary.cases.length}</span>
        <span class="suite-progress-title">${escapeHtml(c.title)}</span>
      </div>`;
    }).join("");
  }

  function hideSuiteProgress() {
    suiteProgressEl.classList.add("hidden");
  }

  // -----------------------------------------------------------------------------
  // Suite summary header
  // -----------------------------------------------------------------------------

  function renderSuiteSummaryHeader(suite) {
    if (!suite) return "";
    return `
    <div class="suite-summary-stats">
      <span class="suite-stat">${suite.total} Total</span>
      <span class="suite-stat suite-stat-passed">${suite.passed} Passed</span>
      <span class="suite-stat suite-stat-failed">${suite.failed} Failed</span>
      ${suite.truncated ? `<span class="suite-stat suite-stat-truncated">${suite.truncated} Truncated</span>` : ""}
      ${suite.truncated_no_assertion ? `<span class="suite-stat suite-stat-partial">${suite.truncated_no_assertion} Partial</span>` : ""}
    </div>`;
  }

  // -----------------------------------------------------------------------------
  // Case card
  // -----------------------------------------------------------------------------

  function renderCaseCard(c, runId, index) {
    const statusBadge = c.status === "passed" ? "badge-passed" :
      c.status === "failed" ? "badge-failed" :
        c.status === "truncated" ? "badge-truncated" :
          c.status === "truncated_no_assertion" ? "badge-partial" : "badge-pending";

    const statusIcon = c.status === "passed" ? "✔" :
      c.status === "failed" ? "✘" :
        c.status === "truncated" ? "⚠" : "○";

    const caseDir = `/runs/${runId}/${c.resultPath}`;
    const screenshotUrl = `${caseDir}/artifacts/trace.png`;
    const specUrl = `${caseDir}/generated.spec.ts`;
    const irUrl = `${caseDir}/04-ir.json`;
    const resultUrl = `${caseDir}/05-result.json`;
    const diagnosisUrl = `${caseDir}/06-diagnosis.json`;
    const traceUrl = `${caseDir}/artifacts`;

    return `
    <div class="case-card" data-case-id="${c.caseId}">
      <div class="case-card-header" role="button" tabindex="0">
        <span class="case-status-icon ${statusBadge}">${statusIcon}</span>
        <span class="case-title">${escapeHtml(c.title)}</span>
        <span class="case-badge ${statusBadge}">${STATUS_LABEL[c.status] ?? c.status}</span>
        <span class="case-expand-icon">▼</span>
      </div>
      <div class="case-card-body hidden">
        <figure class="case-screenshot hidden">
          <img src="${screenshotUrl}" alt="screenshot for case ${index + 1}" loading="lazy"
               onerror="this.parentElement.classList.add('hidden')" />
          <figcaption>Final state</figcaption>
        </figure>
        <div class="case-downloads">
          <a href="${specUrl}" download class="dl-btn">Generated Spec</a>
          <a href="${irUrl}" download class="dl-btn">IR JSON</a>
          <a href="${resultUrl}" download class="dl-btn">Result JSON</a>
          <a href="${traceUrl}" class="dl-btn" target="_blank">Artifacts</a>
        </div>
        <details class="case-details">
          <summary>Technical Details</summary>
          <div class="case-details-content">
            <h4>IR JSON</h4>
            <pre class="case-ir">Loading...</pre>
            <h4>Generated Playwright Spec</h4>
            <pre class="case-spec">Loading...</pre>
          </div>
        </details>
      </div>
    </div>`;
  }

  // Load technical details on demand (lazy fetch)
  function setupCaseCardListeners() {
    suiteCaseListEl.querySelectorAll(".case-card-header").forEach((header) => {
      header.addEventListener("click", () => {
        const card = header.closest(".case-card");
        const body = card.querySelector(".case-card-body");
        const isHidden = body.classList.contains("hidden");
        body.classList.toggle("hidden");
        header.querySelector(".case-expand-icon").textContent = isHidden ? "▲" : "▼";

        // Lazy-load technical details on first expand
        if (isHidden && !card.dataset.loaded) {
          card.dataset.loaded = "true";
          loadCaseDetails(card);
        }
      });
    });
  }

  async function loadCaseDetails(card) {
    const runId = card.closest(".suite-results")?.dataset?.runId;
    if (!runId) return;
    const caseId = card.dataset.caseId;
    const caseDir = `/runs/${runId}/cases/${caseId}`;

    try {
      const [irRes, specRes] = await Promise.all([
        fetch(`${caseDir}/04-ir.json`).then(r => r.ok ? r.text() : "Not found"),
        fetch(`${caseDir}/generated.spec.ts`).then(r => r.ok ? r.text() : "Not found"),
      ]);
      card.querySelector(".case-ir").textContent = irRes;
      card.querySelector(".case-spec").textContent = specRes;
    } catch {
      // Details stay as "Loading..." — non-critical
    }
  }

  // -----------------------------------------------------------------------------
  // Full suite results rendering
  // -----------------------------------------------------------------------------

  function renderSuiteResults(suite, runId) {
    if (!suite || !suite.cases) return;
    suiteResultsEl.classList.remove("hidden");
    suiteResultsEl.dataset.runId = runId;
    suiteSummaryHeaderEl.innerHTML = renderSuiteSummaryHeader(suite);
    suiteCaseListEl.innerHTML = suite.cases.map((c, i) => renderCaseCard(c, runId, i)).join("");
    setupCaseCardListeners();
  }

  function hideSuiteResults() {
    suiteResultsEl.classList.add("hidden");
    suiteResultsEl.removeAttribute("data-run-id");
    suiteSummaryHeaderEl.innerHTML = "";
    suiteCaseListEl.innerHTML = "";
  }

  // -----------------------------------------------------------------------------
  // Single-test backward-compatible rendering
  // -----------------------------------------------------------------------------

  function renderSingleTestResult(data, stage, error) {
    finalResult.classList.remove("hidden");
    const passed = data?.passed;
    const partial = data?.partial;
    const healed = data?.healed;
    verdictEl.textContent =
      stage === "error" ? `⚠️ Pipeline error: ${error}` :
        passed && healed ? "✅ Passed (self-healed — a locator broke and was automatically repaired; see below)" :
          passed ? (partial ? "✅ Passed (partial — verified as far as the flow could be grounded)" : "✅ Passed") :
            "❌ Failed";

    const test = data?.test;
    if (test) {
      testTitleEl.textContent = test.title ?? "";
      testStepsEl.innerHTML = (test.steps ?? []).map((s) => `<li>${escapeHtml(s)}</li>`).join("");
      testExpectedEl.textContent = test.expected ? `Expected: ${test.expected}` : "";
      testSummaryEl.classList.remove("hidden");
    } else {
      testSummaryEl.classList.add("hidden");
    }

    const shot = data?.screenshotUrl;
    if (shot) {
      screenshotEl.src = shot;
      screenshotFigureEl.classList.remove("hidden");
    } else {
      screenshotFigureEl.classList.add("hidden");
    }
  }

  function hideSingleTestResult() {
    finalResult.classList.add("hidden");
    testSummaryEl.classList.add("hidden");
    diagnosisEl.textContent = "";
    screenshotFigureEl.classList.add("hidden");
    screenshotEl.removeAttribute("src");
    traceLinkEl.classList.add("hidden");
  }

  // -----------------------------------------------------------------------------
  // History
  // -----------------------------------------------------------------------------

  function renderHistory(runs) {
    if (!runs.length) {
      historyListEl.innerHTML = `<li class="history-empty">No runs yet.</li>`;
      return;
    }
    historyListEl.innerHTML = runs.map((r) => {
      const suiteInfo = r.suite
        ? `<span class="h-suite">${r.suite.passed}/${r.suite.total} tests</span>`
        : "";
      return `
    <li class="history-item${r.hasEvents ? "" : " no-detail"}" data-run-id="${r.runId}">
      <span class="badge ${r.status}">${STATUS_LABEL[r.status] ?? r.status}</span>
      <span class="hprompt">${r.prompt || "(no prompt)"}</span>
      ${suiteInfo}
      <span class="hurl">${r.url}</span>
      ${r.hasEvents ? "" : '<span class="hurl">(no detailed log)</span>'}
      <button type="button" class="history-del" title="Delete this run" aria-label="Delete run">✕</button>
    </li>`;
    }).join("");

    historyListEl.querySelectorAll(".history-item:not(.no-detail)").forEach((li) => {
      li.addEventListener("click", () => connectToRun(li.dataset.runId));
    });
    historyListEl.querySelectorAll(".history-del").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const runId = btn.closest(".history-item").dataset.runId;
        if (!confirm("Delete this run permanently?")) return;
        await fetch(`/api/runs/${runId}`, { method: "DELETE" });
        loadHistory();
      });
    });
  }

  async function loadHistory() {
    const res = await fetch("/api/runs");
    const runs = await res.json();
    renderHistory(runs);
  }

  // -----------------------------------------------------------------------------
  // Event processing
  // -----------------------------------------------------------------------------

  function applyEvent(event, runId) {
    if (event.stage === "done" || event.stage === "error") {
      finalResult.classList.remove("hidden");
      const passed = event.data?.passed;
      const partial = event.data?.partial;
      const healed = event.data?.healed;
      const status = event.data?.status;
      verdictEl.className = status === "truncated_no_assertion" ? "incomplete" : "";
      verdictEl.textContent =
        event.stage === "error" ? `⚠️ Pipeline error: ${event.error}` :
          status === "truncated_no_assertion" ? "⚠️ Incomplete — didn't verify what you asked (stopped before reaching an assertion)" :
            passed && healed ? "✅ Passed (self-healed — a locator broke and was automatically repaired; see below)" :
              passed ? (partial ? "✅ Passed (partial — verified as far as the flow could be grounded)" : "✅ Passed") :
                "❌ Failed";

      if (status === "truncated_no_assertion" && event.data?.truncationNote) {
        diagnosisEl.textContent = event.data.truncationNote;
      }

      // Plain-English record of what actually ran, so the verdict isn't just a bare badge.
      const test = event.data?.test;
      if (test) {
        testTitleEl.textContent = test.title ?? "";
        testStepsEl.innerHTML = (test.steps ?? []).map((s) => `<li>${escapeHtml(s)}</li>`).join("");
        testExpectedEl.textContent = test.expected ? `Expected: ${test.expected}` : "";
        testSummaryEl.classList.remove("hidden");
        hideSuiteProgress();

        // Check if this is a suite run or a single-test run
        const suite = event.data?.suite;
        if (suite && suite.cases && suite.cases.length > 0) {
          // Suite mode
          renderSuiteResults(suite, runId);
          // Also show the primary test result for backward compatibility
          renderSingleTestResult(event.data, event.stage, event.error);
          traceLinkEl.href = `/runs/${runId}/generated/`;
          traceLinkEl.classList.remove("hidden");
        } else {
          // Single-test mode (backward compatible)
          renderSingleTestResult(event.data, event.stage, event.error);
          traceLinkEl.href = `/runs/${runId}/generated/`;
          traceLinkEl.classList.remove("hidden");
        }

        loadHistory();
        return true;
      }

      // Suite progress events
      if (event.stage === "suite" && event.status === "started" && event.data) {
        const caseId = event.data.caseId;
        // Build or update progress from the suite summary event
        if (event.data.total) {
          // This is the initial "suite started" event with total count
          renderSuiteProgress({ total: event.data.total, cases: [] }, null);
        } else if (caseId) {
          // This is a per-case "started" event — update progress
          const progressItems = suiteProgressListEl.querySelectorAll(".suite-progress-item");
          if (progressItems.length) {
            // Find the matching item and update it
            const idx = Array.from(progressItems).findIndex(el =>
              el.querySelector(".suite-progress-title")?.textContent === event.data.title
            );
            if (idx >= 0) {
              progressItems[idx].classList.add("running");
              progressItems[idx].querySelector(".suite-progress-icon").textContent = "⏳";
            }
          }
        }
      }

      if (event.stage === "suite" && event.status === "completed" && event.data?.summary) {
        // Final suite summary — update progress to show completion
        renderSuiteProgress(event.data.summary, null);
      }

      // Failure analysis
      if (event.stage === "failure_analysis" && event.status === "completed") {
        diagnosisEl.textContent = event.data?.explanation
          ? `${event.data.explanation} — ${event.data.suggestedFix}`
          : "";
      }

      // Phase progress (always update)
      setPhaseFromStage(event.stage, event.status, event.data);
      return false;
    }

    // -----------------------------------------------------------------------------
    // Polling / connection management
    // -----------------------------------------------------------------------------

    let pollGeneration = 0;

    async function connectToRun(runId) {
      const generation = ++pollGeneration;

      // Reset UI
      renderPhases();
      hideSingleTestResult();
      hideSuiteResults();
      hideSuiteProgress();
      diagnosisEl.textContent = "";

      let seen = 0;
      let fails = 0;

      while (generation === pollGeneration) {
        let done = false;
        try {
          const res = await fetch(`/api/runs/${runId}/state`);
          const events = await res.json();
          if (!Array.isArray(events)) throw new Error("bad payload");

          for (const event of events.slice(seen)) {
            if (applyEvent(event, runId)) done = true;
          }
          seen = events.length;

          // Reset failure counter on successful read
          if (fails && !done) {
            finalResult.classList.add("hidden");
            verdictEl.textContent = "";
          }
          fails = 0;
        } catch {
          if (++fails === 5) {
            finalResult.classList.remove("hidden");
            verdictEl.textContent = "⚠️ Lost contact with the server — retrying…";
          }
        }

        if (done) return;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    // -----------------------------------------------------------------------------
    // Form submission
    // -----------------------------------------------------------------------------

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

    // -----------------------------------------------------------------------------
    // Init
    // -----------------------------------------------------------------------------

    renderTemplates();
    renderPhases();
    loadHistory();
