// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const PHASES = [
  {
    key: "understand",
    label: "1. Understanding Your Request",
    desc: "The AI is analyzing your prompt to build an intelligent test plan.",
    stages: ["plan"]
  },
  {
    key: "analyze",
    label: "2. Analyzing the Website",
    desc: "Exploring web page layout, finding forms, inputs, buttons, and links.",
    stages: ["discovery"]
  },
  {
    key: "build_run",
    label: "3. Building & Executing Tests",
    desc: "Generating automated test scripts & running them in a real browser.",
    stages: ["testcases", "ir", "generate", "execute"]
  },
  {
    key: "results",
    label: "4. Evaluating Results & Verdict",
    desc: "Checking pass/fail state, verifying assertions, and capturing screenshots.",
    stages: ["failure_analysis", "heal"]
  },
];
const STAGE_TO_PHASE = Object.fromEntries(
  PHASES.flatMap((p) => p.stages.map((s) => [s, p.key]))
);

// Per-phase stage tracking: { phaseKey: { stageName: "pending"|"started"|"completed"|"failed" } }
let phaseStageStatus = {};

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
const submitBtn = form.querySelector('button[type="submit"]');
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
const screenshotToggleEl = document.getElementById("screenshotToggle");
const screenshotGridEl = document.getElementById("screenshotGrid");

// ADDED: needs-input (credentials) form references
const needsInputEl = document.getElementById("needsInput");
const needsInputReasonEl = document.getElementById("needsInputReason");
const credentialsForm = document.getElementById("credentialsForm");
const usernameLabelEl = document.getElementById("usernameLabel");
const usernameLabelTextEl = document.getElementById("usernameLabelText");
const passwordLabelEl = document.getElementById("passwordLabel");
const confirmPasswordLabelEl = document.getElementById("confirmPasswordLabel");
const credUsernameEl = document.getElementById("credUsername");
const credPasswordEl = document.getElementById("credPassword");
const credConfirmPasswordEl = document.getElementById("credConfirmPassword");

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
// Phase pipeline (progress cards)
// -----------------------------------------------------------------------------

function renderPhases() {
  phaseStageStatus = {};
  phasesEl.innerHTML = PHASES.map(
    (p) => `
    <li data-phase="${p.key}" class="pending">
      <div class="phase-header">
        <span class="dot"></span>
        <span class="label">${p.label}</span>
        <span class="phase-badge pending">Pending</span>
      </div>
      <div class="phase-desc">${p.desc}</div>
      <div class="summary-text"></div>
      <details class="output hidden">
        <summary>Technical Details (Developer View)</summary>
        <pre></pre>
      </details>
    </li>`
  ).join("");
}

function summarize(stage, data) {
  try {
    switch (stage) {
      case "plan": return data.goal ? `AI Strategy: ${data.goal}` : "";
      case "discovery": {
        const pagesCount = data.pages?.length ?? 1;
        const concepts = [...new Set((data.pages ?? []).flatMap((p) => p.concepts ?? []))];
        const conceptStr = concepts.length ? ` — Concepts: ${concepts.join(", ")}` : "";
        return `Discovered ${pagesCount} page(s)${conceptStr}`;
      }
      case "testcases": {
        const count = data.total ?? data.length ?? 0;
        const extra = data.reactive ? ` (${data.reactive} reactive)` : "";
        return `Generated ${count} test scenarios${extra}`;
      }
      case "ir": return `Test Plan Model: ${data.meta?.title ?? ""}`;
      case "generate": return "Playwright test script generated successfully";
      case "execute": return data.passed ? "✅ Test execution passed — All assertions verified" : "❌ Test execution failed";
      case "heal": return data.healed ? "🔧 Self-healed — Repaired broken UI selector automatically" : "Attempted repair";
      case "suite": return data.summary ? `Suite Progress: ${data.summary.passed}/${data.summary.total} tests passed` : "";
      default: return "";
    }
  } catch { return ""; }
}

function computePhaseStatus(phaseKey) {
  const tracked = phaseStageStatus[phaseKey];
  if (!tracked) return "pending";
  const statuses = Object.values(tracked);
  if (statuses.length === 0) return "pending";
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.every((s) => s === "completed")) return "completed";
  if (statuses.some((s) => s === "started")) return "started";
  return "pending";
}

function applyPhaseUI(phaseKey, phaseStatus, summaryText) {
  const li = phasesEl.querySelector(`li[data-phase="${phaseKey}"]`);
  if (!li) return;
  li.className = phaseStatus;
  const badgeEl = li.querySelector(".phase-badge");
  if (badgeEl) {
    if (phaseStatus === "started") {
      badgeEl.className = "phase-badge running";
      badgeEl.textContent = "\u23f3 In Progress";
    } else if (phaseStatus === "completed") {
      badgeEl.className = "phase-badge done";
      badgeEl.textContent = "\u2705 Complete";
    } else if (phaseStatus === "failed") {
      badgeEl.className = "phase-badge failed";
      badgeEl.textContent = "\u274c Failed";
    }
  }
  if (summaryText !== undefined) {
    const summaryEl = li.querySelector(".summary-text");
    if (summaryEl) summaryEl.textContent = summaryText;
  }
}

function setPhaseFromStage(stage, status, data) {
  if (stage === "done" || stage === "error") {
    PHASES.forEach((p) => {
      const phaseStatus = computePhaseStatus(p.key);
      if (phaseStatus === "completed" || phaseStatus === "failed") return;
      if (phaseStatus === "started") {
        applyPhaseUI(p.key, "failed", "Interrupted — pipeline ended before this step finished");
      }
    });
    return;
  }

  const phaseKey = STAGE_TO_PHASE[stage];
  if (!phaseKey) return;

  if (!phaseStageStatus[phaseKey]) phaseStageStatus[phaseKey] = {};

  if (status === "started") {
    const phase = PHASES.find((p) => p.key === phaseKey);
    if (phase) {
      phase.stages.forEach((s) => {
        if (!phaseStageStatus[phaseKey][s]) phaseStageStatus[phaseKey][s] = "pending";
      });
    }
    phaseStageStatus[phaseKey][stage] = "started";
  } else if (status === "completed" || status === "failed") {
    phaseStageStatus[phaseKey][stage] = status;
  }

  const phaseStatus = computePhaseStatus(phaseKey);
  let summaryText;
  if (data !== undefined) {
    summaryText = summarize(stage, data);
  }
  applyPhaseUI(phaseKey, phaseStatus, summaryText);

  if (data !== undefined) {
    const li = phasesEl.querySelector(`li[data-phase="${phaseKey}"]`);
    if (li) {
      const details = li.querySelector(".output");
      if (details) {
        details.querySelector("pre").textContent = JSON.stringify(data, null, 2);
        details.classList.remove("hidden");
      }
    }
  }
}

// -----------------------------------------------------------------------------
// Needs-input (credentials) form
// ADDED: shown when the pipeline pauses because a login/signup page needs data
// the user didn't supply. Toggles which fields are visible based on
// event.data.requiredFields (from orchestrator.ts's "needs_input" event), and
// switches labeling for login ("username_or_email") vs signup ("username" +
// "confirmPassword").
// -----------------------------------------------------------------------------

function showNeedsInputForm(data, runId) {
  needsInputEl.classList.remove("hidden");
  needsInputReasonEl.textContent = data?.reason ?? "This site needs a bit more information to continue.";

  const fields = data?.requiredFields ?? [];
  usernameLabelEl.classList.toggle("hidden", !fields.some((f) => f === "username" || f === "username_or_email"));
  usernameLabelTextEl.textContent = fields.includes("username_or_email") ? "Username / Email" : "Username";
  passwordLabelEl.classList.toggle("hidden", !fields.includes("password"));
  confirmPasswordLabelEl.classList.toggle("hidden", !fields.includes("confirmPassword"));

  credentialsForm.dataset.runId = runId;
  credentialsForm.dataset.authType = data?.authType ?? "login";
}

function hideNeedsInputForm() {
  needsInputEl.classList.add("hidden");
  credUsernameEl.value = "";
  credPasswordEl.value = "";
  credConfirmPasswordEl.value = "";
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

function renderScreenshotGrid(suite, runId) {
  if (!suite || !suite.cases) return "";
  const withScreenshots = suite.cases.filter(c => c.screenshotUrl);
  if (withScreenshots.length === 0) return "";
  return withScreenshots.map((c, i) => {
    const badge = c.status === "passed" ? "badge-passed" :
      c.status === "failed" ? "badge-failed" : "badge-pending";
    return `
    <div class="screenshot-tile">
      <img src="${c.screenshotUrl}" alt="Case ${i + 1}" loading="lazy" />
      <span class="screenshot-tile-label ${badge}">${escapeHtml(c.title)}</span>
    </div>`;
  }).join("");
}

function setupScreenshotToggle(suite, runId) {
  const hasScreenshots = suite?.cases?.some(c => c.screenshotUrl);
  screenshotToggleEl.classList.toggle("hidden", !hasScreenshots);
  screenshotGridEl.innerHTML = renderScreenshotGrid(suite, runId);
  screenshotGridEl.classList.add("hidden");
  screenshotToggleEl.textContent = "View All Screenshots";
}

// -----------------------------------------------------------------------------
// Case card
// -----------------------------------------------------------------------------

function renderCaseCard(c, runId, index) {
  const statusBadge = c.status === "passed" ? "badge-passed" :
    c.status === "failed" ? "badge-failed" :
      c.status === "truncated" ? "badge-truncated" :
        c.status === "truncated_no_assertion" ? "badge-partial" : "badge-pending";

  const statusIcon = c.status === "passed" ? "\u2714" :
    c.status === "failed" ? "\u2718" :
      c.status === "truncated" ? "\u26a0" : "\u25cb";

  const caseDir = `/runs/${runId}/${c.resultPath}`;
  const screenshotUrl = c.screenshotUrl || "";
  const specUrl = `${caseDir}/generated.spec.ts`;
  const irUrl = `${caseDir}/04-ir.json`;
  const resultUrl = `${caseDir}/05-result.json`;
  const traceUrl = `${caseDir}/artifacts`;

  return `
  <div class="case-card" data-case-id="${c.caseId}">
    <div class="case-card-header" role="button" tabindex="0">
      <span class="case-status-icon ${statusBadge}">${statusIcon}</span>
      <span class="case-title">${escapeHtml(c.title)}</span>
      <span class="case-badge ${statusBadge}">${STATUS_LABEL[c.status] ?? c.status}</span>
      <span class="case-expand-icon">\u25bc</span>
    </div>
    <div class="case-card-body hidden">
      ${screenshotUrl ? `
      <figure class="case-screenshot">
        <img src="${screenshotUrl}" alt="screenshot for case ${index + 1}" loading="lazy"
             onerror="this.parentElement.classList.add('hidden')" />
        <figcaption>Final state</figcaption>
      </figure>` : ""}
      <div class="case-downloads">
        <a href="${specUrl}" download="${escapeHtml(c.title || 'test')}.spec.ts" class="dl-btn">Generated Spec</a>
        <a href="${irUrl}" download="ir.json" class="dl-btn">IR JSON</a>
        <a href="${resultUrl}" download="result.json" class="dl-btn">Result JSON</a>
        <a href="${traceUrl}" class="dl-btn" target="_blank">Artifacts</a>
      </div>
      <details class="case-details">
        <summary>Technical Details (Developer View)</summary>
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
  setupScreenshotToggle(suite, runId);
  suiteCaseListEl.innerHTML = suite.cases.map((c, i) => renderCaseCard(c, runId, i)).join("");
  setupCaseCardListeners();
}

function hideSuiteResults() {
  suiteResultsEl.classList.add("hidden");
  suiteResultsEl.removeAttribute("data-run-id");
  suiteSummaryHeaderEl.innerHTML = "";
  suiteCaseListEl.innerHTML = "";
  screenshotToggleEl.classList.add("hidden");
  screenshotGridEl.classList.add("hidden");
  screenshotGridEl.innerHTML = "";
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
  if (traceLinkEl) traceLinkEl.classList.add("hidden");
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
  <li class="history-item" data-run-id="${r.runId}" data-prompt="${escapeHtml(r.prompt || "")}" data-url="${escapeHtml(r.url || "")}">
    <span class="badge ${r.status}">${STATUS_LABEL[r.status] ?? r.status}</span>
    <span class="hprompt">${escapeHtml(r.prompt || "(no prompt)")}</span>
    ${suiteInfo}
    <span class="hurl">${escapeHtml(r.url)}</span>
    <button type="button" class="history-del" title="Delete this run" aria-label="Delete run">✕</button>
  </li>`;
  }).join("");

  historyListEl.querySelectorAll(".history-item").forEach((li) => {
    li.addEventListener("click", () => {
      historyListEl.querySelectorAll(".history-item").forEach(item => item.classList.remove("active"));
      li.classList.add("active");
      if (li.dataset.prompt) promptEl.value = li.dataset.prompt;
      if (li.dataset.url) urlEl.value = li.dataset.url;
      connectToRun(li.dataset.runId);
    });
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
  setPhaseFromStage(event.stage, event.status, event.data);

  // ADDED: pipeline paused, waiting on user-supplied login/signup data.
  // Mirrors the "done"/"error" handling below in that it re-enables the Run
  // button and stops polling — but instead of showing a verdict, it shows the
  // credentials form so the user can supply what's missing and resume.
 let needsInputHandled = false;

if (event.stage === "needs_input" && event.status === "completed") {
  submitBtn.disabled = false;
  submitBtn.textContent = "Run";
  showNeedsInputForm(event.data, runId);
  return true; // stop polling — resumes only after the user submits the form
}

  if (event.stage === "done" || event.stage === "error") {
    submitBtn.disabled = false;
    submitBtn.textContent = "Run";

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
    } else {
      testSummaryEl.classList.add("hidden");
    }

    hideSuiteProgress();

    // Check if this is a suite run or a single-test run
    const suite = event.data?.suite;
    if (suite && suite.cases && suite.cases.length > 0) {
      // Suite mode
      renderSuiteResults(suite, runId);
      // Also show the primary test result for backward compatibility
      renderSingleTestResult(event.data, event.stage, event.error);
      if (traceLinkEl) {
        traceLinkEl.href = `/runs/${runId}/generated.spec.ts`;
        traceLinkEl.classList.remove("hidden");
      }
    } else {
      // Single-test mode (backward compatible)
      renderSingleTestResult(event.data, event.stage, event.error);
      if (traceLinkEl) {
        traceLinkEl.href = `/runs/${runId}/generated.spec.ts`;
        traceLinkEl.classList.remove("hidden");
      }
    }

    loadHistory();
    return true; // Stop polling
  }

  // Suite progress events
  if (event.stage === "suite" && event.status === "started" && event.data) {
    const caseId = event.data.caseId;
    if (event.data.total && !caseId) {
      // Initial "suite started" event with total count — create placeholder items
      suiteProgressEl.classList.remove("hidden");
      suiteProgressListEl.innerHTML = "";
      for (let i = 0; i < event.data.total; i++) {
        const item = document.createElement("div");
        item.className = "suite-progress-item pending";
        item.innerHTML = `
          <span class="suite-progress-icon">○</span>
          <span class="suite-progress-label">Case ${i + 1} / ${event.data.total}</span>
          <span class="suite-progress-title">Waiting…</span>`;
        suiteProgressListEl.appendChild(item);
      }
    } else if (caseId) {
      // Per-case "started" event — find or create the progress item
      const progressItems = suiteProgressListEl.querySelectorAll(".suite-progress-item");
      let item = null;
      for (const el of progressItems) {
        if (el.dataset.caseId === caseId) { item = el; break; }
      }
      if (!item && progressItems.length > 0) {
        // Use the first pending item as a slot for this case
        item = Array.from(progressItems).find(el =>
          el.classList.contains("pending") && !el.dataset.caseId
        );
      }
      if (item) {
        item.dataset.caseId = caseId;
        item.className = "suite-progress-item running";
        item.querySelector(".suite-progress-icon").textContent = "⏳";
        if (event.data.title) {
          item.querySelector(".suite-progress-title").textContent = event.data.title;
        }
      }
    }
  }

  if (event.stage === "suite" && event.status === "completed" && event.data && !event.data.summary) {
    // Per-case completed — update the corresponding progress item
    const caseId = event.data.caseId;
    if (caseId) {
      const item = suiteProgressListEl.querySelector(`[data-case-id="${caseId}"]`);
      if (item) {
        const statusClass = event.data.status || "passed";
        item.className = `suite-progress-item ${statusClass}`;
        const icon = item.querySelector(".suite-progress-icon");
        if (icon) {
          icon.textContent = statusClass === "passed" ? "✔" :
            statusClass === "failed" ? "✘" :
              statusClass === "truncated" ? "⚠" : "✔";
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
  let needsInputShown = false;
  // Reset UI
  renderPhases();
  hideSingleTestResult();
  hideSuiteResults();
  hideSuiteProgress();
  hideNeedsInputForm(); // ADDED: clear any stale credentials form from a previous run
  diagnosisEl.textContent = "";

  let seen = 0;
  let fails = 0;

  while (generation === pollGeneration) {
    let done = false;
    try {
      const res = await fetch(`/api/runs/${runId}/state`);
      const events = await res.json();
      if (!Array.isArray(events)) throw new Error("bad payload");

     const newEvents = events.slice(seen);
      if (newEvents.length > 0) {
        for (const event of newEvents) {
          if (event.stage === "needs_input" && event.status === "completed") {
            if (needsInputShown) continue; // already showed it once this session — skip replay
            needsInputShown = true;
          }
          if (applyEvent(event, runId)) done = true;
        }
        seen = events.length;
      }

      // Reset failure counter on successful read
      if (fails && !done) {
        finalResult.classList.add("hidden");
        verdictEl.textContent = "";
      }
      fails = 0;
    } catch {
      if (++fails === 5) {
        submitBtn.disabled = false;
        submitBtn.textContent = "Run";
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

  submitBtn.disabled = true;
  submitBtn.textContent = "Running\u2026";

  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, url }),
  });
  const { runId } = await res.json();
  connectToRun(runId);
});

// ADDED: credentials form submission — resumes a paused run with the data the
// user just supplied (POSTs to /api/runs/:runId/credentials), then reconnects
// to the same run's event stream to watch it continue.
credentialsForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const runId = credentialsForm.dataset.runId;
  const authType = credentialsForm.dataset.authType;

  const body = {
    username: credUsernameEl.value.trim(),
    password: credPasswordEl.value,
  };
  if (authType === "signup") {
    body.confirmPassword = credConfirmPasswordEl.value;
  }

  const submitBtnInForm = credentialsForm.querySelector('button[type="submit"]');
  submitBtnInForm.disabled = true;
  submitBtnInForm.textContent = "Continuing…";

  await fetch(`/api/runs/${runId}/credentials`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  hideNeedsInputForm();
  submitBtnInForm.disabled = false;
  submitBtnInForm.textContent = "Continue";
  connectToRun(runId); // resume polling the same run
});

// -----------------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------------

renderTemplates();
renderPhases();
loadHistory();

screenshotToggleEl.addEventListener("click", () => {
  const isOpen = !screenshotGridEl.classList.contains("hidden");
  screenshotGridEl.classList.toggle("hidden");
  screenshotToggleEl.textContent = isOpen ? "View All Screenshots" : "Hide Screenshots";
});