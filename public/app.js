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
    label: "3. Building & Running Tests",
    desc: "Writing the test steps and running them in a real browser, just like a person would.",
    stages: ["testcases", "ir", "generate", "execute"]
  },
  {
    key: "results",
    label: "4. Checking the Results",
    desc: "Working out what passed, what didn't, and taking screenshots along the way.",
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

// Labels are read by people who don't know what an assertion or a truncated IR is.
// "Truncated"/"Partial (no assertion)" were pipeline vocabulary leaking into the UI.
const STATUS_LABEL = {
  passed: "Passed",
  failed: "Failed",
  error: "Error",
  incomplete: "Unconfirmed",
  truncated: "Partial",
  truncated_no_assertion: "Unconfirmed",
  // Not a pass and not an app bug: the flow reached something automation can't get past,
  // like an emailed verification code or an external sign-in provider.
  blocked: "Blocked",
  // The case-selection gate's review round timed out before anything was ever picked.
  no_cases_selected: "Nothing selected",
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
const videoFigureEl = document.getElementById("videoFigure");
const resultVideoEl = document.getElementById("resultVideo");
const diagnosisEl = document.getElementById("diagnosis");
const traceLinkEl = document.getElementById("traceLink");
const suiteProgressEl = document.getElementById("suiteProgress");
const suiteProgressListEl = document.getElementById("suiteProgressList");
const suiteResultsEl = document.getElementById("suiteResults");
const suiteSummaryHeaderEl = document.getElementById("suiteSummaryHeader");
const suiteCaseListEl = document.getElementById("suiteCaseList");
const screenshotToggleEl = document.getElementById("screenshotToggle");
const screenshotGridEl = document.getElementById("screenshotGrid");
const screenshotModalEl = document.getElementById("screenshotModal");
const screenshotModalImgEl = document.getElementById("screenshotModalImg");
const screenshotModalCloseEl = document.getElementById("screenshotModalClose");
const credPromptEl = document.getElementById("credentialPrompt");
const credFormEl = document.getElementById("credForm");
const credWhyEl = document.getElementById("credWhy");
const credUserEl = document.getElementById("credUser");
const credPassEl = document.getElementById("credPass");
const credSkipEl = document.getElementById("credSkip");
const caseSelectionPanelEl = document.getElementById("case-selection-panel");
const caseRoundLabelEl = document.getElementById("case-round-label");
const casePoolCounterEl = document.getElementById("case-pool-counter");
const caseSelectionListEl = document.getElementById("case-selection-list");
const caseSelectAllBtnEl = document.getElementById("case-select-all-btn");
const caseSelectNoneBtnEl = document.getElementById("case-select-none-btn");
const caseRefineInputWrapEl = document.getElementById("case-refine-input-wrap");
const caseNewPromptInputEl = document.getElementById("case-new-prompt-input");
const caseNoticeEl = document.getElementById("caseNotice");
const caseNotSatisfiedBtnEl = document.getElementById("case-not-satisfied-btn");
const caseDoneBtnEl = document.getElementById("case-done-btn");
const caseRegenAttemptsLeftEl = document.getElementById("case-regen-attempts-left");

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------

const escapeHtml = (s) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Inline status lines for the case-selection panel. Rendered in-panel, not a toast: the
// run is paused on this section, so a message that scrolls away would go unread.
function showNotice(msg) {
  caseNoticeEl.classList.remove("hidden", "error");
  caseNoticeEl.classList.add("notice");
  caseNoticeEl.textContent = msg;
}

function showError(msg) {
  caseNoticeEl.classList.remove("hidden", "notice");
  caseNoticeEl.classList.add("error");
  caseNoticeEl.textContent = msg;
}

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
        <span class="dot">${icon("clock", { size: 11 })}</span>
        <span class="label">${p.label}</span>
        <span class="phase-badge pending">Pending</span>
      </div>
      <p class="phase-desc">${p.desc}</p>
      <p class="summary-text"></p>
      <details class="output hidden">
        <summary>${icon("code", { size: 12 })} Technical details</summary>
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
        // Report generated AND selected, with the reason. Reporting only the generated count
        // meant the UI said "Generated 15 test scenarios" and then ran 4, with nothing
        // explaining the gap.
        if (data.selected !== undefined && data.generated !== undefined) {
          const reason = data.generated > data.selected
            ? ` — duplicates removed, capped at ${data.budget ?? data.selected} for coverage`
            : "";
          return `Generated ${data.generated} scenarios → selected ${data.selected} to run${reason}`;
        }
        // Runs recorded before this event carried the counts (history is on disk forever).
        // Skip the count-based fallback when this is a case-selection gate event — those
        // events carry data.action but no generated/selected counts, so showing
        // "Generated 0 test scenarios" here is always a flicker, not real information.
        if (data.action) return "Reviewing test cases...";
        const count = data.total ?? data.length ?? 0;
        const extra = data.reactive ? ` (${data.reactive} reactive)` : "";
        return `Generated ${count} test scenarios${extra}`;
      }
      case "ir": return `Worked out the exact steps: ${data.meta?.title ?? ""}`;
      case "generate": return "Test script ready";
      case "execute": return data.passed ? "The test ran and everything it checked was correct" : "The test ran and something didn’t match what was expected";
      case "heal": return data.healed
        ? "An element had moved on the page — the test found it again and carried on"
        : "Tried to recover from a step that broke";
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
  const dotEl = li.querySelector(".dot");
  // Badge wording and the dot glyph are set together \u2014 they describe the same thing, and
  // when they were set in separate places the dot kept showing a clock on finished steps.
  const LOOK = {
    started: { cls: "running", text: "Working", ic: "loader" },
    completed: { cls: "done", text: "Done", ic: "check" },
    failed: { cls: "failed", text: "Failed", ic: "x" },
    pending: { cls: "pending", text: "Pending", ic: "clock" },
  };
  const look = LOOK[phaseStatus];
  if (look) {
    if (badgeEl) {
      badgeEl.className = `phase-badge ${look.cls}`;
      badgeEl.textContent = look.text;
    }
    if (dotEl) dotEl.innerHTML = icon(look.ic, { size: look.ic === "check" ? 12 : 11 });
  }
  if (summaryText !== undefined) {
    const summaryEl = li.querySelector(".summary-text");
    if (summaryEl) summaryEl.textContent = summaryText;
  }
}

function setPhaseFromStage(stage, status, data) {
  if (stage === "done" || stage === "error") {
    // Terminal event. A phase still "started" was interrupted mid-step — always a failure,
    // regardless of whether the run overall succeeded (a genuinely unfinished step can't be
    // reported "completed" just because a LATER phase went on to pass). A phase that was
    // never started is "pending": on "done" the pipeline finished without ever needing it
    // (the results phase's stages only fire when there is a failure to analyze), on "error"
    // it was aborted before reaching it. Without the pending case, the final "Evaluating
    // Results & Verdict" phase stayed stuck on "Pending" forever after every passing run.
    const interrupted = stage === "error";
    PHASES.forEach((p) => {
      const phaseStatus = computePhaseStatus(p.key);
      if (phaseStatus === "completed" || phaseStatus === "failed") return;
      if (phaseStatus === "started") {
        applyPhaseUI(p.key, "failed", "Interrupted — pipeline ended before this step finished");
        return;
      }
      const summary = interrupted
        ? "Skipped — the run aborted before reaching this step"
        : "Pipeline finished — nothing left to evaluate";
      applyPhaseUI(p.key, interrupted ? "failed" : "completed", summary);
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
// Suite progress (live updates during execution)
// -----------------------------------------------------------------------------

function renderSuiteProgress(suiteSummary, runningCaseId) {
  if (!suiteSummary || !suiteSummary.cases) return;
  suiteProgressEl.classList.remove("hidden");
  suiteProgressListEl.innerHTML = suiteSummary.cases.map((c, i) => {
    const isRunning = c.caseId === runningCaseId;
    const statusClass = isRunning ? "running" : c.status;
    const statusIcon = icon(isRunning ? "loader" : (STATUS_ICON[c.status] ?? "circle"), { size: 14 });
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
      <span class="suite-stat">${suite.total} checks</span>
      <span class="suite-stat suite-stat-passed">${icon("check", { size: 13 })} ${suite.passed} passed</span>
      <span class="suite-stat suite-stat-failed">${icon("x", { size: 13 })} ${suite.failed} failed</span>
      ${suite.truncated ? `<span class="suite-stat suite-stat-truncated">${icon("alert-triangle", { size: 13 })} ${suite.truncated} partial</span>` : ""}
      ${suite.truncated_no_assertion ? `<span class="suite-stat suite-stat-partial">${icon("minus-circle", { size: 13 })} ${suite.truncated_no_assertion} unconfirmed</span>` : ""}
      ${suite.blocked ? `<span class="suite-stat suite-stat-blocked">${icon("slash-circle", { size: 13 })} ${suite.blocked} blocked</span>` : ""}
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
        <img src="${escapeHtml(c.screenshotUrl)}" alt="Case ${i + 1}" loading="lazy" />
        <span class="screenshot-tile-label ${badge}">${escapeHtml(c.title)}</span>
      </div>`;
  }).join("");
}

function setupScreenshotToggle(suite, runId) {
  const hasScreenshots = suite?.cases?.some(c => c.screenshotUrl);
  screenshotToggleEl.classList.toggle("hidden", !hasScreenshots);
  screenshotGridEl.innerHTML = renderScreenshotGrid(suite, runId);
  screenshotGridEl.classList.add("hidden");
  screenshotToggleEl.innerHTML = `${icon("image", { size: 14 })} View all screenshots`;
}

// -----------------------------------------------------------------------------
// Case card
// -----------------------------------------------------------------------------

function renderCaseCard(c, runId, index) {
  // One lookup, so the badge colour and the icon can never disagree about a status.
  // "blocked" was absent from the old chain, which rendered a blocked case as a grey
  // "pending" dot \u2014 the opposite of the point of having the status at all.
  const BADGE = {
    passed: "badge-passed", failed: "badge-failed", blocked: "badge-blocked",
    truncated: "badge-truncated", truncated_no_assertion: "badge-partial",
  };
  const statusBadge = BADGE[c.status] ?? "badge-pending";
  const statusIcon = icon(STATUS_ICON[c.status] ?? "circle", { size: 16 });

  // `whyItMatters` (required in the schema since this redesign) is the headline: a plain,
  // real-world consequence sentence with no QA vocabulary, meant for someone who's never
  // written a test in their life. `expected` (always present) is the concrete, technical
  // "what should happen" detail — real but secondary, so it's a smaller line underneath
  // rather than the thing a non-technical user reads first. `intent` (QA reasoning, e.g.
  // "Proves that...") moves into the technical-details panel instead of the card body.
  const whyItMatters = c.whyItMatters || c.intent || c.expected || "";
  const expected = c.expected || "";

  const caseDir = `/runs/${runId}/${c.resultPath}`;
  const screenshotUrl = c.screenshotUrl || "";
  const specUrl = `${caseDir}/generated.spec.ts`;
  const irUrl = `${caseDir}/04-ir.json`;
  const resultUrl = `${caseDir}/05-result.json`;
  const traceUrl = `${caseDir}/artifacts`;

  // Failed/blocked cases open already-expanded, so the diagnosis a user came for is the first
  // thing they see rather than something they must know to click for.
  const autoExpand = c.status === "failed" || c.status === "blocked";

  return `
    <div class="case-card${autoExpand ? " open" : ""}" data-case-id="${escapeHtml(c.caseId)}" data-status="${escapeHtml(c.status)}">
      <div class="case-card-header" role="button" tabindex="0" aria-expanded="${autoExpand}">
        <span class="case-status-icon ${statusBadge}">${statusIcon}</span>
        <span class="case-heading">
          <span class="case-title">${escapeHtml(c.title)}</span>
          ${whyItMatters ? `<p class="case-intent">${escapeHtml(whyItMatters)}</p>` : ""}
          ${expected && expected !== whyItMatters ? `<p class="case-expected"><span>What should happen:</span> ${escapeHtml(expected)}</p>` : ""}
        </span>
        <span class="case-badge ${statusBadge}">${escapeHtml(STATUS_LABEL[c.status] ?? c.status)}</span>
        ${c.healed && c.status === "passed" ? `<span class="case-badge case-badge-healed" title="This failed on the first attempt; the system automatically found a fix and re-ran it, and it passed.">${icon("refresh", { size: 11 })} Fixed automatically</span>` : ""}
        <span class="case-expand-icon">${icon("chevron-down", { size: 14 })}</span>
      </div>
      <div class="case-card-body">
        ${c.blockedBy ? `<p class="blocked-note">Couldn't finish: ${escapeHtml(c.blockedBy)}. The screenshot below is where it stopped.</p>` : ""}
        <div class="case-narrative hidden"></div>
        <div class="case-diagnosis-block hidden"></div>
        ${screenshotUrl ? `
        <figure class="case-screenshot">
          <img src="${escapeHtml(screenshotUrl)}" alt="screenshot for case ${index + 1}" loading="lazy"
               tabindex="0" role="button" aria-label="View full-size screenshot"
               onerror="this.parentElement.classList.add('hidden')" />
          <figcaption>Final state — click to zoom in</figcaption>
        </figure>` : ""}
        ${c.videoUrl ? `
        <figure class="case-video">
          <video controls preload="none" ${screenshotUrl ? `poster="${escapeHtml(screenshotUrl)}"` : ""}
                 onerror="this.parentElement.classList.add('hidden')">
            <source src="${escapeHtml(c.videoUrl)}" type="video/webm" />
          </video>
          <figcaption>Recording of the run — nothing downloads until you press play</figcaption>
        </figure>` : ""}
        <div class="case-downloads">
          <a href="${escapeHtml(specUrl)}" download="${escapeHtml(c.title || 'test')}.spec.ts" class="dl-btn">${icon("file-text", { size: 13 })} Download test script</a>
          <a href="${escapeHtml(resultUrl)}" download="result.json" class="dl-btn">${icon("download", { size: 13 })} Download full result</a>
        </div>
        <details class="case-details">
          <summary>${icon("code", { size: 13 })} Technical details (for developers)</summary>
          <div class="case-details-content">
            ${c.intent ? `<h4>QA reasoning</h4><pre>${escapeHtml(c.intent)}</pre>` : ""}
            ${c.groqCalls ? `<h4>Cost</h4><pre>${c.groqCalls} AI call(s), ${c.groqTokens ?? 0} tokens</pre>` : ""}
            <h4>Step-by-step test plan (JSON) <a href="${escapeHtml(irUrl)}" download="ir.json" class="dl-btn dl-btn-inline">${icon("download", { size: 12 })} download</a></h4>
            <pre class="case-ir">Loading…</pre>
            <h4>Full test code <a href="${escapeHtml(specUrl)}" download="${escapeHtml(c.title || 'test')}.spec.ts" class="dl-btn dl-btn-inline">${icon("download", { size: 12 })} download</a></h4>
            <pre class="case-spec">Loading…</pre>
            <h4>All files (screenshots, trace, video) <a href="${escapeHtml(traceUrl)}" class="dl-btn dl-btn-inline" target="_blank">${icon("external-link", { size: 12 })} open</a></h4>
          </div>
        </details>
      </div>
    </div>`;
}

function toggleCaseCard(card, open) {
  const header = card.querySelector(".case-card-header");
  card.classList.toggle("open", open);
  header.setAttribute("aria-expanded", String(open));
  if (open && !card.dataset.loaded) {
    card.dataset.loaded = "true";
    loadCaseDetails(card);
  }
}

// Load technical details on demand (lazy fetch)
function setupCaseCardListeners() {
  suiteCaseListEl.querySelectorAll(".case-card-header").forEach((header) => {
    const card = header.closest(".case-card");
    const activate = () => toggleCaseCard(card, !card.classList.contains("open"));
    header.addEventListener("click", activate);
    // role="button" on a <div> gets no native Enter/Space activation — wire it by hand.
    header.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(); }
    });
  });

  suiteCaseListEl.querySelectorAll(".case-screenshot img").forEach((img) => {
    const open = () => openScreenshotModal(img.src, img.alt);
    img.addEventListener("click", open);
    img.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); }
    });
  });

  // Cards that rendered already-expanded (failed/blocked) never fire the click/keydown
  // handler above, so their detail fetch — including the diagnosis block — has to be kicked
  // off here instead. Loading them from the click listener alone would leave every
  // auto-expanded card stuck on "Loading…" forever.
  const preExpanded = suiteCaseListEl.querySelectorAll(".case-card.open");
  preExpanded.forEach((card) => {
    if (!card.dataset.loaded) {
      card.dataset.loaded = "true";
      loadCaseDetails(card);
    }
  });
  // Scroll only the first one into view — the point is "notice this," not a scroll fight
  // between several failed cards.
  if (preExpanded.length) {
    preExpanded[0].scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
}

async function loadCaseDetails(card) {
  const runId = card.closest(".suite-results")?.dataset?.runId;
  if (!runId) return;
  const caseId = card.dataset.caseId;
  const status = card.dataset.status;
  const caseDir = `/runs/${runId}/cases/${caseId}`;

  try {
    const [irRes, specRes, diagnosis] = await Promise.all([
      fetch(`${caseDir}/04-ir.json`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`${caseDir}/generated.spec.ts`).then(r => r.ok ? r.text() : "Not found"),
      // diagnosisPath is only ever written when the case actually failed — don't ask for a
      // file that was never produced for a passed/blocked case.
      status === "failed"
        ? fetch(`${caseDir}/06-diagnosis.json`).then(r => r.ok ? r.json() : null).catch(() => null)
        : Promise.resolve(null),
    ]);
    // Run-level 04-ir.json wraps { ir, updatedAt }; the per-case copy is the raw IR itself.
    // Handle both shapes rather than assume one — same defensive pattern as
    // tests/irPostClickReveal.test.ts's loader.
    const ir = irRes?.ir ?? irRes;
    card.querySelector(".case-ir").textContent = ir ? JSON.stringify(ir, null, 2) : "Not found";
    card.querySelector(".case-spec").textContent = specRes;

    const suite = currentSuite;
    const c = suite?.cases?.find((x) => x.caseId === caseId);
    const narrativeEl = card.querySelector(".case-narrative");
    const diagEl = card.querySelector(".case-diagnosis-block");
    if (status === "passed" && c) renderCaseNarrative(narrativeEl, c, ir);
    if (status === "failed") renderCaseDiagnosisBlock(diagEl, diagnosis);
  } catch {
    // Details stay as "Loading..." — non-critical
  }
}

// -----------------------------------------------------------------------------
// Full suite results rendering
// -----------------------------------------------------------------------------

// Tracks the suite currently on screen so loadCaseDetails (fired later, on expand) can look
// up a case's whyItMatters/intent for the passed-case narrative without re-fetching it.
let currentSuite = null;

function renderSuiteResults(suite, runId) {
  if (!suite || !suite.cases) return;
  currentSuite = suite;
  suiteResultsEl.classList.remove("hidden");
  suiteResultsEl.dataset.runId = runId;
  suiteSummaryHeaderEl.innerHTML = renderSuiteSummaryHeader(suite);
  setupScreenshotToggle(suite, runId);
  suiteCaseListEl.innerHTML = suite.cases.map((c, i) => renderCaseCard(c, runId, i)).join("");
  setupCaseCardListeners();
}

function hideSuiteResults() {
  currentSuite = null;
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

// -----------------------------------------------------------------------------
// Verdict wording
// -----------------------------------------------------------------------------

/**
 * One place for the headline sentence, used by both the live path and the replay path,
 * which previously carried two copies of this copy that could drift.
 *
 * Written for someone who doesn't know what an assertion is. "Blocked" in particular must
 * never read as a failure — the site is fine, the test simply hit something no automation
 * can get past, like a code emailed to a human.
 */
function verdictFor(data, stage, error) {
  const status = data?.status;
  if (stage === "error") {
    return { cls: "failed", ic: "alert-circle", head: "Something went wrong while running this",
             detail: error || "" };
  }
  if (status === "blocked") {
    return { cls: "blocked", ic: "slash-circle", head: "Couldn’t finish — the site needs something a test can’t provide",
             detail: `${data?.blockedBy ?? "The flow hit a step automation can’t pass."} The screenshot below is where it stopped.` };
  }
  if (status === "truncated_no_assertion") {
    return { cls: "incomplete", ic: "minus-circle", head: "Ran, but couldn’t confirm the result",
             detail: "It stopped before it got far enough to check the outcome, so this isn’t a pass or a failure." };
  }
  if (status === "no_cases_selected") {
    return { cls: "incomplete", ic: "minus-circle", head: "No test cases were selected",
             detail: "The review round timed out before anything was picked, so nothing ran. Start a new run and pick at least one case before it times out." };
  }
  if (data?.passed && data?.healed) {
    return { cls: "passed", ic: "check", head: "Passed",
             detail: "One element had moved on the page — the test found it again and carried on." };
  }
  if (data?.passed && data?.partial) {
    return { cls: "passed", ic: "check", head: "Passed, as far as it could go",
             detail: "Everything it was able to reach behaved correctly." };
  }
  if (data?.passed) {
    return { cls: "passed", ic: "check", head: "Passed", detail: "Everything checked out." };
  }
  return { cls: "failed", ic: "x", head: "Failed",
           detail: "The site didn’t do what this test expected. Details below." };
}

/** Paint the verdict heading from that description. */
function paintVerdict(v) {
  verdictEl.className = v.cls;
  verdictEl.innerHTML =
    `${icon(v.ic, { size: 20 })}<span>${escapeHtml(v.head)}` +
    `${v.detail ? `<span class="verdict-detail">${escapeHtml(v.detail)}</span>` : ""}</span>`;
}

function formatIrStep(step) {
  if (!step || typeof step !== "object") return String(step);
  const action = step.action;
  const target = step.target;
  const targetDesc = target?.name
    ? `${target.role ? target.role + " " : ""}"${target.name}"`
    : target?.text
    ? `text "${target.text}"`
    : target?.url
    ? `"${target.url}"`
    : target?.role || "element";

  switch (action) {
    case "navigate":
      return `Go to ${target?.url ? target.url : step.value ? step.value : '"/"'}`;
    case "fill":
      return `Type "${step.value ?? ""}" into ${targetDesc}`;
    case "click":
      return `Click on ${targetDesc}`;
    case "select":
      return `Choose "${step.value ?? ""}" from ${targetDesc}`;
    case "check":
      return `Check ${targetDesc}`;
    case "press":
      return `Press the ${step.value ?? ""} key`;
    case "wait":
      return `Wait briefly`;
    case "assert": {
      const assertion = step.assertion || "visible";
      if (assertion === "visible") return `Check that ${targetDesc} appears on the page`;
      if (assertion === "hidden") return `Check that ${targetDesc} is not shown`;
      if (assertion === "url_contains") return `Check the page address contains "${step.value || target?.url || ""}"`;
      if (assertion === "text_contains") return `Check that the text "${step.value || ""}" is displayed`;
      if (assertion === "text_equals") return `Check that the text "${step.value || ""}" is displayed`;
      if (assertion === "enabled") return `Check that ${targetDesc} is enabled`;
      if (assertion === "disabled") return `Check that ${targetDesc} is disabled`;
      return `Check ${assertion} on ${targetDesc}${step.value ? ` ("${step.value}")` : ""}`;
    }
    default:
      return `${action} ${targetDesc}`;
  }
}

// Plain-language reason per failure category (src/stages/classify.ts's KNOWN_CATEGORIES —
// the real, closed set the classifier and analyzeFailure() actually produce; "other" is the
// deliberate fallback for anything outside it, never left blank).
const CATEGORY_REASON = {
  selector_changed: "The page's layout changed since this test was written, so the element could no longer be found the same way.",
  element_missing: "The button, link, or field the test needed never appeared on the page.",
  element_not_interactable: "The element was there, but something (like being covered or disabled) stopped the test from using it.",
  element_hidden: "The element was on the page but stayed hidden, so the test couldn't do what it needed with it.",
  multiple_matches: "More than one element matched the description, and the test likely used the wrong one.",
  detached: "The element disappeared from the page while the test was still trying to use it.",
  timeout: "The page took longer to respond than the test was willing to wait.",
  assertion_failed: "The page did something different from what the test expected to see.",
  navigation_error: "The page failed to load, or went somewhere the test didn't expect.",
  network: "A network request the page needed failed or was blocked.",
  other: "This doesn't match a common failure pattern — see the technical details below.",
};

// Grounded in the IR's own last step, not an invented image description — there's no vision
// call in this path (adding one would be a new backend cost this change deliberately avoids),
// so the caption only ever states what the last recorded step actually asserted or did.
function describeScreenshot(steps) {
  if (!steps || !steps.length) return "The page as it looked when the test finished.";
  const last = steps[steps.length - 1];
  if (last.action !== "assert") return `The page right after the last step: ${formatIrStep(last).toLowerCase()}.`;
  const target = last.target;
  const targetDesc = target?.name ? `"${target.name}"` : target?.text ? `"${target.text}"` : "the expected element";
  const assertion = last.assertion || "visible";
  if (assertion === "visible") return `The page showing ${targetDesc}, confirming it appeared as expected.`;
  if (assertion === "hidden") return `The page after confirming ${targetDesc} was not shown.`;
  if (assertion === "url_contains") return "The page at the address the test expected to land on.";
  if (assertion === "text_contains" || assertion === "text_equals") return "The page showing the text the test was checking for.";
  return "The page in its final, confirmed state.";
}

// "join them into a coherent sentence" per the design brief — a flowing run-on of the plain-
// English step descriptions already produced by formatIrStep, not a second LLM summarization
// pass (this path makes no new API calls; see the file header on public/preview.js for why
// that constraint is deliberate here).
function buildStepNarrative(steps) {
  if (!steps || !steps.length) return "";
  // formatIrStep returns imperative fragments ("Go to X", "Click on Y") — gluing them after a
  // subject like "The test ___" needs verb conjugation ("go" -> "goes") this function doesn't
  // have (an early version read "The test go to /, check heading..." for exactly this reason).
  // A colon-introduced list sidesteps conjugation entirely: each fragment stays grammatical on
  // its own, the way steps in an instruction list normally read.
  const parts = steps.map((s) => {
    const d = formatIrStep(s);
    return d.charAt(0).toLowerCase() + d.slice(1);
  });
  const sentence = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")}, then ${parts[parts.length - 1]}`;
  return `Here's what happened: ${sentence}.`;
}

function renderCaseNarrative(container, c, ir) {
  const steps = ir?.steps;
  const whatHappened = steps?.length ? buildStepNarrative(steps) : (c.whyItMatters || c.intent || "");
  if (!whatHappened) { container.classList.add("hidden"); return; }
  const whatImage = c.screenshotUrl ? describeScreenshot(steps) : "";
  container.innerHTML = `
    <p class="case-narrative-line"><b>What happened:</b> ${escapeHtml(whatHappened)}</p>
    ${whatImage ? `<p class="case-narrative-line"><b>What the image shows:</b> ${escapeHtml(whatImage)}</p>` : ""}`;
  container.classList.remove("hidden");
}

function renderCaseDiagnosisBlock(container, diagnosis) {
  if (!diagnosis) { container.classList.add("hidden"); return; }
  const whatWrong = diagnosis.explanation || "The test hit a problem it couldn't get past.";
  const why = CATEGORY_REASON[diagnosis.category] || CATEGORY_REASON.other;
  const bullets = [];
  if (diagnosis.suggestedFix) {
    bullets.push(diagnosis.suggestedFix);
    // Honest, not a self-heal claim: suite cases (unlike the primary case) don't get an
    // automatic heal retry, so "re-run and it may auto-correct" would be false here. A full
    // re-run genuinely can help with transient causes, so that's the true fallback offered.
    bullets.push("Run the whole test again — if this was a timing hiccup (a slow page, a flaky request), it may pass next time.");
  } else {
    bullets.push("Try re-running with a more specific prompt, or check if the site has changed since the last discovery.");
  }
  container.innerHTML = `
    <div class="diag-card">
      <div class="diag-card-header">
        <span class="diag-badge">What happened</span>
        <h4>${escapeHtml(whatWrong)}</h4>
      </div>
      <div class="diag-card-body">
        <div class="diag-item"><p class="diag-text"><b>Why it happened:</b> ${escapeHtml(why)}</p></div>
        <div class="diag-item diag-fix-box">
          <span class="diag-label fix-label">💡 What you can do</span>
          <ul class="diag-fix-list">${bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join("")}</ul>
        </div>
        <details class="diag-tech-details">
          <summary>Technical details (for developers)</summary>
          <code>Category: ${escapeHtml(diagnosis.category || "unknown")} · Failing step: ${escapeHtml(diagnosis.failingStepId || "unknown")}</code>
        </details>
      </div>
    </div>`;
  container.classList.remove("hidden");
}

// -----------------------------------------------------------------------------
// Screenshot zoom modal — pure JS/CSS, no external libraries. Only one focusable element
// lives inside the modal (the close button; the image itself isn't a tab stop), so the focus
// trap is just "Tab/Shift+Tab always lands back on that button" rather than a full cycle.
// -----------------------------------------------------------------------------

let modalPreviouslyFocused = null;

function openScreenshotModal(src, alt) {
  modalPreviouslyFocused = document.activeElement;
  screenshotModalImgEl.src = src;
  screenshotModalImgEl.alt = alt || "Screenshot, full size";
  screenshotModalEl.classList.remove("hidden");
  document.addEventListener("keydown", handleScreenshotModalKeydown);
  screenshotModalCloseEl.focus();
}

function closeScreenshotModal() {
  screenshotModalEl.classList.add("hidden");
  screenshotModalImgEl.src = "";
  document.removeEventListener("keydown", handleScreenshotModalKeydown);
  // Return focus to whatever opened the modal (the screenshot thumbnail), so a keyboard user
  // isn't dropped back at the top of the page.
  if (modalPreviouslyFocused && typeof modalPreviouslyFocused.focus === "function") {
    modalPreviouslyFocused.focus();
  }
  modalPreviouslyFocused = null;
}

function handleScreenshotModalKeydown(e) {
  if (e.key === "Escape") { closeScreenshotModal(); return; }
  if (e.key === "Tab") { e.preventDefault(); screenshotModalCloseEl.focus(); }
}

screenshotModalCloseEl.addEventListener("click", closeScreenshotModal);
screenshotModalEl.addEventListener("click", (e) => {
  // Only the backdrop itself closes on click — a click that lands on the image (a child
  // element, so a different e.target) must not.
  if (e.target === screenshotModalEl) closeScreenshotModal();
});

function renderEnterpriseDiagnostic(data, stage, error) {
  if (data?.passed && !data?.partial) {
    diagnosisEl.innerHTML = "";
    diagnosisEl.classList.add("hidden");
    return;
  }

  const status = data?.status;
  const note = data?.truncationNote || data?.ir?.meta?.truncationNote;
  const diagnosis = data?.diagnosis;
  const blockedBy = data?.blockedBy;

  let headline = "Test Analysis";
  let description = "";
  let fixPrompt = "";
  let techDetails = "";

  if (status === "truncated_no_assertion" || status === "truncated" || note) {
    headline = "The test stopped partway through";
    if (/admin|role|permission|authorized/i.test(note || "")) {
      description = "It signed in successfully, but couldn't find the Admin section on the page. This usually means the account it used doesn't have Admin access.";
      fixPrompt = 'Tell it which account to use:\n"Log in with email: user@example.com and password: yourpassword then click Admin..."';
    } else if (/hydration|dynamically|load/i.test(note || "")) {
      description = "It tried to interact with part of the page before that part had finished loading.";
      fixPrompt = 'Give the page a moment to catch up:\n"Log in, wait 2 seconds for the dashboard to load, then click Admin..."';
    } else {
      description = "It couldn't find a button, link, or field it needed on the page.";
      fixPrompt = "Check that the wording in your request (button or link names) matches what actually appears on the website.";
    }
    techDetails = note || "";
  } else if (status === "blocked") {
    headline = "The site stopped the test";
    description = blockedBy || "The test hit something automation can't get past on its own — like a code sent to a phone or email, or a \"prove you're not a robot\" check.";
    fixPrompt = "Try a test version of the site with that extra step turned off, or point the test at a page that's already logged in.";
    techDetails = blockedBy || "";
  } else if (diagnosis) {
    headline = "Something didn't work as expected";
    description = diagnosis.explanation || "The test hit a problem partway through and couldn't continue.";
    fixPrompt = diagnosis.suggestedFix || "Check that the button or field the test needs is visible and available on the page.";
    techDetails = `Category: ${diagnosis.category || 'unknown'} · Failing step: ${diagnosis.failingStepId || 'unknown'}`;
  } else if (error || stage === "error") {
    headline = "Something went wrong on our end";
    description = error || "We hit an unexpected problem while running this test.";
    fixPrompt = "Check that the website address is correct and reachable, then try again.";
    techDetails = error || "";
  } else {
    return;
  }

  diagnosisEl.innerHTML = `
    <div class="diag-card">
      <div class="diag-card-header">
        <span class="diag-badge">What happened</span>
        <h4>${escapeHtml(headline)}</h4>
      </div>
      <div class="diag-card-body">
        <div class="diag-item">
          <p class="diag-text">${escapeHtml(description)}</p>
        </div>
        ${fixPrompt ? `
        <div class="diag-item diag-fix-box">
          <span class="diag-label fix-label">💡 Try this next time</span>
          <pre class="diag-fix-code">${escapeHtml(fixPrompt)}</pre>
        </div>` : ""}
        ${techDetails ? `
        <details class="diag-tech-details">
          <summary>Technical details (for developers)</summary>
          <code>${escapeHtml(techDetails)}</code>
        </details>` : ""}
      </div>
    </div>`;
  diagnosisEl.classList.remove("hidden");
}

function renderSingleTestResult(data, stage, error) {
  finalResult.classList.remove("hidden");
  const passed = data?.passed;
  const partial = data?.partial;
  const healed = data?.healed;
  paintVerdict(verdictFor(data, stage, error));

  const test = data?.test;
  const ir = data?.ir;
  if (test || ir) {
    testTitleEl.textContent = test?.title || ir?.meta?.title || "";
    const stepsToRender = ir?.steps?.length
      ? ir.steps.map(formatIrStep)
      : (test?.steps ?? []);
    testStepsEl.innerHTML = stepsToRender.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
    testExpectedEl.textContent = test?.expected ? `Expected: ${test.expected}` : "";
    testSummaryEl.classList.remove("hidden");
  } else {
    testSummaryEl.classList.add("hidden");
  }

  renderEnterpriseDiagnostic(data, stage, error);

  const shot = data?.screenshotUrl;
  if (shot) {
    screenshotEl.src = shot;
    screenshotFigureEl.classList.remove("hidden");
  } else {
    screenshotFigureEl.classList.add("hidden");
  }

  const vid = data?.videoUrl;
  if (vid) {
    resultVideoEl.innerHTML = `<source src="${escapeHtml(vid)}" type="video/webm" />`;
    if (shot) resultVideoEl.poster = shot;
    videoFigureEl.classList.remove("hidden");
  } else {
    videoFigureEl.classList.add("hidden");
    resultVideoEl.removeAttribute("src");
    resultVideoEl.innerHTML = "";
  }
}

function hideSingleTestResult() {
  finalResult.classList.add("hidden");
  testSummaryEl.classList.add("hidden");
  videoFigureEl.classList.add("hidden");
  resultVideoEl.innerHTML = "";
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
    <li class="history-item" data-run-id="${escapeHtml(r.runId)}" data-prompt="${escapeHtml(r.prompt || "")}" data-url="${escapeHtml(r.url || "")}">
      <span class="badge ${escapeHtml(r.status)}" title="${escapeHtml(STATUS_LABEL[r.status] ?? r.status)}">${icon(STATUS_ICON[r.status] ?? "circle", { size: 14 })}</span>
      <span class="hprompt">${escapeHtml(r.prompt || "(no prompt)")}</span>
      ${suiteInfo}
      <span class="hurl">${escapeHtml(r.url)}</span>
      <button type="button" class="history-del" title="Delete this run" aria-label="Delete run">${icon("trash", { size: 13 })}</button>
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
      if (currentRunId === runId) {
        pollGeneration++;
      }
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

// -----------------------------------------------------------------------------
// Credential prompt (a run pauses here when the site needs a login)
// -----------------------------------------------------------------------------

// The run this prompt belongs to. Also the guard against a stale prompt: the poller replays
// events, and a second run must never post its answer to the previous run's id.
let credRunId = null;

function showCredentialPrompt(runId, data) {
  credRunId = runId;
  const host = (() => { try { return new URL(data?.url).host; } catch { return data?.url ?? "this site"; } })();
  credWhyEl.textContent =
    `The tests for ${host} need to sign in, and there's no built-in account for it. ` +
    `Add credentials to test the flow past the login, or skip to test only what's reachable without one.`;
  credUserEl.value = "";
  credPassEl.value = "";
  credFormEl.querySelectorAll("button, input").forEach((el) => { el.disabled = false; });
  credPromptEl.classList.remove("hidden");
  credUserEl.focus();
}

function hideCredentialPrompt() {
  credRunId = null;
  // Don't leave the password sitting in the DOM once it's been handed over.
  credUserEl.value = "";
  credPassEl.value = "";
  credPromptEl.classList.add("hidden");
}

async function submitCredentials(body) {
  if (!credRunId) return;
  const runId = credRunId;
  credFormEl.querySelectorAll("button, input").forEach((el) => { el.disabled = true; });
  try {
    await fetch(`/api/runs/${runId}/credentials`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    // The pipeline's own wait timeout is the backstop, so a lost request can't wedge the run.
  }
  hideCredentialPrompt();
}

credFormEl.addEventListener("submit", (e) => {
  e.preventDefault();
  const username = credUserEl.value.trim();
  const password = credPassEl.value;
  // Both or neither: half a login can't authenticate, and sending it would just fail slower.
  if (!username || !password) return submitCredentials({ skip: true });
  submitCredentials({ username, password });
});

credSkipEl.addEventListener("click", () => submitCredentials({ skip: true }));

// -----------------------------------------------------------------------------
// Case-selection panel (the gate pauses a run here to review generated cases)
// -----------------------------------------------------------------------------

// The run this panel belongs to. Guards against a stale panel the way credRunId guards the
// credential prompt: the poller replays events, and a decision must never post to an old run.
let caseRunId = null;

// The batch currently on screen and how many cases were already accepted before this round.
let currentBatch = [];
let acceptedSoFarCount = 0;

// Local mirrors of the gate's pool cap and regeneration budget, so the panel can render its
// counters and notes without asking the backend for every number.
const CASE_POOL_CAP = 5; // MAX_ACCUMULATED_CASES
const MAX_CASE_REGEN_ATTEMPTS_LOCAL = 3; // MAX_CASE_REGEN_ATTEMPTS

function renderCaseSelectionPanel(batch, attempt, acceptedCount) {
  currentBatch = Array.isArray(batch) ? batch : [];
  acceptedSoFarCount = acceptedCount || 0;

  caseRoundLabelEl.textContent = `Round ${attempt} — review the test cases`;
  casePoolCounterEl.textContent =
    `${acceptedSoFarCount} of ${CASE_POOL_CAP} case${acceptedSoFarCount === 1 ? "" : "s"} accepted so far`;

  caseSelectionListEl.innerHTML = currentBatch.map((c, i) => {
    const primary = c.fromPrompt ? `<span class="case-primary-badge">Primary</span>` : "";
    const title = escapeHtml(c.title || `Case ${i + 1}`);
    // whyItMatters (required since this redesign) is what a person picking cases actually
    // needs to judge one: a plain consequence, not QA phrasing. `expected` — the concrete,
    // technical outcome — sits underneath as a second, smaller line, still visible because
    // it IS useful, just not the thing to read first.
    const whyItMatters = c.whyItMatters || c.intent || c.expected || "";
    const expected = c.expected || "";
    const checked = c.fromPrompt ? "checked" : "";
    return `
      <li>
        <input type="checkbox" id="case-pick-${i}" data-index="${i}" ${checked} />
        <label for="case-pick-${i}" class="case-label">
          <span class="case-label-row">
            <span class="case-title">${title}</span>${primary}
          </span>
          ${whyItMatters ? `<span class="case-intent">${escapeHtml(whyItMatters)}</span>` : ""}
          ${expected && expected !== whyItMatters ? `<span class="case-expected"><b>What should happen:</b> ${escapeHtml(expected)}</span>` : ""}
        </label>
      </li>`;
  }).join("");

  caseRefineInputWrapEl.classList.add("hidden");
  caseNewPromptInputEl.value = "";
  caseNotSatisfiedBtnEl.textContent = "Not satisfied — refine";
  caseRegenAttemptsLeftEl.textContent =
    `Refine attempts left: ${Math.max(0, MAX_CASE_REGEN_ATTEMPTS_LOCAL - attempt)} of ${MAX_CASE_REGEN_ATTEMPTS_LOCAL}`;
  caseNoticeEl.classList.add("hidden");
  caseNoticeEl.textContent = "";

  updateDoneButtonState();
  caseSelectionPanelEl.classList.remove("hidden");
  // The panel used to just appear wherever it sat in the page flow, with nothing drawing
  // the eye to it — easy to miss while watching the progress timeline above. Guarantee it
  // enters the viewport the moment a round is actually ready for review.
  caseSelectionPanelEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideCaseSelectionPanel() {
  caseRunId = null;
  currentBatch = [];
  acceptedSoFarCount = 0;
  caseSelectionPanelEl.classList.add("hidden");
}

function getCheckedCaseIndexes() {
  return Array.from(caseSelectionListEl.querySelectorAll('input[type="checkbox"]:checked'))
    .map((cb) => Number(cb.dataset.index));
}

// Done can't be clicked until there's at least one case to run: accepted in earlier rounds
// or checked in this one. The label doubles as a running count.
function updateDoneButtonState() {
  const total = acceptedSoFarCount + getCheckedCaseIndexes().length;
  caseDoneBtnEl.disabled = total === 0;
  caseDoneBtnEl.textContent = total === 0
    ? "Run selected tests"
    : `Run ${total} test${total === 1 ? "" : "s"}`;
}

async function postCaseSelectionDecision(runId, decision) {
  try {
    const res = await fetch(`/api/runs/${runId}/case-selection`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(decision),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showError(err.error ?? "Failed to submit case selection");
      return false;
    }
    return true;
  } catch {
    showError("Failed to submit case selection");
    return false;
  }
}

caseSelectAllBtnEl.addEventListener("click", () => {
  caseSelectionListEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = true; });
  updateDoneButtonState();
});

caseSelectNoneBtnEl.addEventListener("click", () => {
  const primaryWasChecked = Array.from(caseSelectionListEl.querySelectorAll('input[type="checkbox"]'))
    .some((cb) => cb.checked && currentBatch[Number(cb.dataset.index)]?.fromPrompt);
  caseSelectionListEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => { cb.checked = false; });
  if (primaryWasChecked) {
    showNotice("Primary case unselected — if you refine again, the next round will generate a new primary case.");
  }
  updateDoneButtonState();
});

caseDoneBtnEl.addEventListener("click", async () => {
  if (!caseRunId) return;
  const selectedIndexes = getCheckedCaseIndexes();
  if (acceptedSoFarCount + selectedIndexes.length === 0) return;
  const ok = await postCaseSelectionDecision(caseRunId, { action: "done", selectedIndexes });
  if (ok) hideCaseSelectionPanel();
});

caseNotSatisfiedBtnEl.addEventListener("click", async () => {
  if (!caseRunId) return;
  if (caseRefineInputWrapEl.classList.contains("hidden")) {
    caseRefineInputWrapEl.classList.remove("hidden");
    caseNotSatisfiedBtnEl.textContent = "Confirm refine";
    caseNewPromptInputEl.focus();
    return;
  }
  const newPrompt = caseNewPromptInputEl.value.trim();
  if (!newPrompt) {
    showError("Describe what should change before refining.");
    return;
  }
  const selectedIndexes = getCheckedCaseIndexes();
  const ok = await postCaseSelectionDecision(caseRunId, { action: "not_satisfied", selectedIndexes, newPrompt });
  if (ok) hideCaseSelectionPanel();
});

caseSelectionListEl.addEventListener("change", (e) => {
  if (e.target.matches('input[type="checkbox"]')) updateDoneButtonState();
});

function applyEvent(event, runId) {
  setPhaseFromStage(event.stage, event.status, event.data);

  if (event.stage === "credentials") {
    if (event.status === "started") showCredentialPrompt(runId, event.data);
    else hideCredentialPrompt();   // answered, skipped or timed out — the run has moved on
    return;
  }

  // Case-selection gate. The batch to review rides in the event; the accepted-so-far count
  // comes from the accumulator, since that's the number the pool cap and Done button depend on.
  if (event.stage === "testcases" && event.data?.action === "case_round_requested") {
    caseRunId = runId;
    const batch = event.data.batch ?? [];
    const attempt = event.data.attempt ?? 1;
    fetch(`/api/runs/${runId}/accepted-cases`)
      .then((res) => res.json())
      .then(({ count }) => renderCaseSelectionPanel(batch, attempt, count))
      .catch(() => renderCaseSelectionPanel(batch, attempt, 0));
    return false;
  }

  if (event.stage === "testcases" && event.data?.action === "case_pool_cap_warning") {
    const cap = event.data.poolCap ?? CASE_POOL_CAP;
    showNotice(`The case pool is full — ${cap} of ${cap} cases already accepted. The run will continue with what's been picked.`);
    return false;
  }

  if (event.stage === "testcases" && event.data?.action === "case_end_of_capacity") {
    showNotice("No new test cases could be generated — everything the model produced repeats a case you already saw. The run will continue with the cases you've picked.");
    return false;
  }

  if (event.stage === "testcases" && event.data?.action === "case_selection_finalized") {
    hideCaseSelectionPanel();
    return false;
  }

  if (event.stage === "done" || event.stage === "error") {
    submitBtn.disabled = false;
    submitBtn.innerHTML = `${icon("play", { size: 14 })} <span class="run-btn-text">Run test</span>`;

    finalResult.classList.remove("hidden");
    const passed = event.data?.passed;
    const partial = event.data?.partial;
    const healed = event.data?.healed;
    const status = event.data?.status;
    paintVerdict(verdictFor(event.data, event.stage, event.error));

    renderEnterpriseDiagnostic(event.data, event.stage, event.error);

    // Plain-English record of what actually ran, so the verdict isn't just a bare badge.
    const test = event.data?.test;
    const ir = event.data?.ir;
    if (test || ir) {
      testTitleEl.textContent = test?.title || ir?.meta?.title || "";
      const stepsToRender = ir?.steps?.length
        ? ir.steps.map(formatIrStep)
        : (test?.steps ?? []);
      testStepsEl.innerHTML = stepsToRender.map((s) => `<li>${escapeHtml(s)}</li>`).join("");
      testExpectedEl.textContent = test?.expected ? `Expected: ${test.expected}` : "";
      testSummaryEl.classList.remove("hidden");
    } else {
      testSummaryEl.classList.add("hidden");
    }

    hideSuiteProgress();
    hideCaseSelectionPanel();

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
            <span class="suite-progress-icon">${icon("circle", { size: 14 })}</span>
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
        item.querySelector(".suite-progress-icon").innerHTML = icon("loader", { size: 14 });
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
        // Named iconEl, not icon — a local `icon` would shadow the global icon() helper.
        const iconEl = item.querySelector(".suite-progress-icon");
        if (iconEl) {
          iconEl.innerHTML = icon(STATUS_ICON[statusClass] ?? "check", { size: 14 });
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
  hideCredentialPrompt();
  hideCaseSelectionPanel();
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
        submitBtn.innerHTML = `${icon("play", { size: 14 })} <span class="run-btn-text">Run test</span>`;
        finalResult.classList.remove("hidden");
        paintVerdict({ cls: "incomplete", ic: "alert-triangle",
          head: "Lost contact with the server",
          detail: "Still trying to reconnect — the run may still be going." });
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
  submitBtn.innerHTML = `${icon("loader", { size: 14 })} <span class="run-btn-text">Running\u2026</span>`;

  try {
    const res = await fetch("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt, url }),
    });
    if (!res.ok) throw new Error(`Server responded with HTTP ${res.status}`);
    const { runId } = await res.json();
    if (!runId) throw new Error("Server didn't return a run id");
    connectToRun(runId);
  } catch (err) {
    // A failed POST previously left the button stuck on "Running\u2026" forever. Reset it and
    // surface the reason instead of silently swallowing the error.
    submitBtn.disabled = false;
    submitBtn.innerHTML = `${icon("play", { size: 14 })} <span class="run-btn-text">Run test</span>`;
    finalResult.classList.remove("hidden");
    paintVerdict({ cls: "incomplete", ic: "alert-triangle",
      head: "Couldn't start the run",
      detail: err?.message ?? "The server didn't accept the request. Try again." });
  }
});

// -----------------------------------------------------------------------------
// Init
// -----------------------------------------------------------------------------

// Static chrome icons — set once, here, so index.html stays free of inline SVG.
document.getElementById("brandMark").innerHTML = icon("zap", { size: 18 });
document.getElementById("newRunIcon").innerHTML = icon("plus", { size: 15 });
document.getElementById("urlIcon").innerHTML = icon("globe", { size: 15 });
document.getElementById("runIcon").innerHTML = icon("play", { size: 14 });
document.getElementById("credIcon").innerHTML = icon("key", { size: 18 });
document.getElementById("caseSelectionIcon").innerHTML = icon("list", { size: 18 });
document.getElementById("themeIconSun").innerHTML = icon("sun", { size: 14 });
document.getElementById("themeIconMoon").innerHTML = icon("moon", { size: 14 });

// -----------------------------------------------------------------------------
// Theme (light/dark)
// -----------------------------------------------------------------------------

const themeToggleEl = document.getElementById("themeToggle");
const themeToggleLabelEl = document.getElementById("themeToggleLabel");

function applyTheme(theme) {
  const isLight = theme === "light";
  if (isLight) document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;

  themeToggleEl.classList.toggle("is-light", isLight);
  themeToggleEl.setAttribute("aria-pressed", String(isLight));
  themeToggleEl.setAttribute("aria-label", isLight ? "Switch to dark theme" : "Switch to light theme");
  themeToggleLabelEl.textContent = isLight ? "Light" : "Dark";

  try { localStorage.setItem("theme", theme); } catch {}
}

// The inline script in index.html's <head> already applied a saved "light" preference
// before first paint (to avoid a flash of the wrong theme) — this just syncs the toggle's
// own UI state to match on load, and defaults to dark when nothing is saved yet.
applyTheme(document.documentElement.dataset.theme === "light" ? "light" : "dark");

themeToggleEl.addEventListener("click", () => {
  applyTheme(themeToggleEl.classList.contains("is-light") ? "dark" : "light");
});

// "New run" clears the workspace without a page reload, so an in-flight poll is abandoned
// (pollGeneration is what stops the old loop touching the DOM again).
document.getElementById("newRunBtn").addEventListener("click", () => {
  pollGeneration++;
  promptEl.value = "";
  urlEl.value = "";
  renderPhases();
  hideSingleTestResult();
  hideSuiteResults();
  hideSuiteProgress();
  hideCredentialPrompt();
  hideCaseSelectionPanel();
  diagnosisEl.textContent = "";
  submitBtn.disabled = false;
  submitBtn.innerHTML = `${icon("play", { size: 14 })} <span class="run-btn-text">Run test</span>`;
  historyListEl.querySelectorAll(".history-item").forEach(i => i.classList.remove("active"));
  promptEl.focus();
});

renderTemplates();
renderPhases();
loadHistory();

screenshotToggleEl.addEventListener("click", () => {
  const isOpen = !screenshotGridEl.classList.contains("hidden");
  screenshotGridEl.classList.toggle("hidden");
  screenshotToggleEl.innerHTML = isOpen
    ? `${icon("image", { size: 14 })} View all screenshots`
    : `${icon("chevron-down", { size: 14 })} Hide screenshots`;
});
