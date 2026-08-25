// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------

const PHASES = [
  {
    key: "understand",
    label: "1 · Understanding your request",
    desc: "Reading the prompt and forming a plan.",
    stages: ["plan"]
  },
  {
    key: "analyze",
    label: "2 · Analyzing the website",
    desc: "Mapping pages, forms and controls.",
    stages: ["discovery"]
  },
  {
    key: "build_run",
    label: "3 · Building & running tests",
    desc: "Writing Playwright scripts and executing them.",
    stages: ["testcases", "ir", "generate", "execute"]
  },
  {
    key: "results",
    label: "4 · Checking the results",
    desc: "Diagnosing failures and self-healing.",
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
// Session (implentationplan.md Step 2.2)
//
// Deliberately dependency-free: Supabase Auth is a plain REST API and the rest of this app is
// offline-safe (see icons.js's header on why no CDN), so pulling in supabase-js just to trade an
// email/password for a JWT would be the one thing that introduces a network dependency.
//
// EVERYTHING here is inert unless the server reports authEnabled:true. With auth off (the
// default) `required` stays false, `token` stays null, the fetch wrapper adds no header, and the
// app behaves exactly as it did before this block existed.
// -----------------------------------------------------------------------------

const AUTH_STORAGE_KEY = "testbench.session";

const auth = {
  required: false,          // set from GET /api/auth/config
  url: null,
  publishableKey: null,
  token: null,
  email: null,
  // Step 3.4. Populated from GET /api/auth/me after sign-in; used ONLY to decide what the UI
  // draws. Every action these gate is independently enforced server-side — hiding a button is a
  // courtesy, not a control, and tampering with these values in devtools buys nothing.
  role: null,
  organisationId: null,
  userId: null,
  // Which credential screen an unauthenticated visitor is looking at: "login" or "signup".
  screen: "login",
};

/** Role ladder, mirrored from src/server/authz.ts. Kept in sync by hand — it is only ever used
 *  to hide controls, so a drift shows up as a visible affordance the server then refuses. */
const ROLE_RANK = { viewer: 1, tester: 2, admin: 3, owner: 4 };
const roleAtLeast = (actual, required) => (ROLE_RANK[actual] || 0) >= (ROLE_RANK[required] || 0);

// Restore synchronously, before the first applyRoute() at the bottom of this file — otherwise an
// already-signed-in user would flash the login view on every reload.
try {
  const saved = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY) || "null");
  if (saved && saved.token) {
    auth.token = saved.token;
    auth.email = saved.email || null;
  }
} catch { /* corrupt/blocked storage just means "not signed in" */ }

/** The artifact route is hit by <img src>/<video src>, which can't carry an Authorization
 *  header — so the token also rides along as a cookie for those. Same-site, session-scoped. */
function writeSessionCookie(token) {
  document.cookie = token
    ? `sb-access-token=${encodeURIComponent(token)}; path=/; SameSite=Strict`
    : "sb-access-token=; path=/; Max-Age=0; SameSite=Strict";
}

function setSession(token, email) {
  auth.token = token || null;
  auth.email = email || null;
  if (token) localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token, email: auth.email }));
  else localStorage.removeItem(AUTH_STORAGE_KEY);
  writeSessionCookie(token);
}

if (auth.token) writeSessionCookie(auth.token);

// One wrapper instead of editing ~20 call sites. A per-call edit would eventually miss one, and a
// missed call site fails only when auth is switched on — the worst time to discover it. With no
// token this is a pure pass-through: same arguments, same behavior, no header added.
const rawFetch = window.fetch.bind(window);
window.fetch = function (input, init) {
  if (!auth.token) return rawFetch(input, init);

  const url = typeof input === "string" ? input : (input && input.url) || "";
  // Only attach to this app's own endpoints. A relative path is same-origin by definition; an
  // absolute one must be checked, so a token can never leak to a third-party host.
  const sameOrigin = !/^https?:\/\//i.test(url) || url.startsWith(location.origin);
  if (!sameOrigin) return rawFetch(input, init);

  const next = { ...(init || {}) };
  const headers = new Headers(next.headers || (typeof input === "object" && input.headers) || {});
  if (!headers.has("Authorization")) headers.set("Authorization", `Bearer ${auth.token}`);
  next.headers = headers;
  return rawFetch(input, next);
};

/**
 * Reflect the caller's role in what the UI offers.
 *
 * Expressed as RESTRICTION classes (`role-no-edit` / `role-no-admin`) rather than permission
 * classes, so the default — no class, nothing hidden — is exactly today's behaviour. A permission
 * model would hide every control until JS proved otherwise, which would make the whole UI flicker
 * on load with auth off.
 */
function applyRoleRestrictions() {
  const body = document.body;
  // Auth off, or role not yet known: restrict nothing. The server is still the real gate.
  const unrestricted = !auth.required || !auth.role;
  body.classList.toggle("role-no-edit", !unrestricted && !roleAtLeast(auth.role, "tester"));
  body.classList.toggle("role-no-admin", !unrestricted && !roleAtLeast(auth.role, "admin"));

  // Team is an admin/owner screen. With auth off there is no team to manage — the synthetic
  // user is the only member — so the entry point stays hidden, exactly as before this existed.
  const teamBtn = document.getElementById("teamBtn");
  if (teamBtn) {
    const showTeam = auth.required && !!auth.token && roleAtLeast(auth.role, "admin");
    teamBtn.classList.toggle("hidden", !showTeam);
  }

  const badge = document.getElementById("sessionBadge");
  const emailEl = document.getElementById("sessionEmail");
  const roleEl = document.getElementById("sessionRole");
  if (!badge) return;
  if (auth.required && auth.token && auth.role) {
    emailEl.textContent = auth.email || "";
    roleEl.textContent = auth.role;
    badge.classList.remove("hidden");
  } else {
    badge.classList.add("hidden");
  }
}

/**
 * Make sure the signed-in account belongs to an organisation, then learn our role in it.
 *
 * bootstrap runs after every sign-in, not just after sign-up: an account created directly in the
 * Supabase dashboard never touches this server, and would otherwise have a working login that
 * could do nothing at all.
 */
async function refreshIdentity() {
  if (!auth.required || !auth.token) {
    auth.role = null;
    auth.organisationId = null;
    auth.userId = null;
    applyRoleRestrictions();
    return;
  }
  try {
    await fetch("/api/auth/bootstrap", { method: "POST" });
    const me = await fetch("/api/auth/me").then((r) => (r.ok ? r.json() : null));
    if (me) {
      auth.role = me.role || null;
      auth.organisationId = me.organisationId || null;
      auth.userId = me.userId || null;
      if (me.email) auth.email = me.email;
    }
  } catch {
    // Non-fatal: an unknown role simply restricts nothing in the UI, and the server still
    // enforces every action independently.
  }
  applyRoleRestrictions();
  // Which projects are visible follows from the role we just learned — an admin sees every one,
  // a viewer only what they've been assigned — so the tree has to be re-fetched, not just redrawn.
  await loadProjects();
}

async function signOut() {
  const { url, publishableKey, token } = auth;
  auth.role = null;
  auth.organisationId = null;
  auth.userId = null;
  auth.screen = "login";
  // Drop the previous account's visible projects, or the next person to sign in on this browser
  // sees the last one's sidebar until their own fetch lands.
  projectsCache = null;
  projectsUnavailable = false;
  suitesCache = [];
  allRunsCache = [];
  expandedProjects.clear();
  applyRoleRestrictions();
  setSession(null, null);
  // Best-effort server-side revoke; the local session is already gone either way, so a failure
  // here must not strand the user on a screen they can't leave.
  if (url && publishableKey && token) {
    rawFetch(`${url}/auth/v1/logout`, {
      method: "POST",
      headers: { apikey: publishableKey, Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }
  applyRoute();
}

async function initAuth() {
  let cfg;
  try {
    cfg = await rawFetch("/api/auth/config").then((r) => r.json());
  } catch {
    return; // config unreachable — leave auth off rather than locking the user out of a working app
  }
  if (!cfg || !cfg.authEnabled) return; // the default path: nothing below ever runs

  auth.required = true;
  auth.url = cfg.url;
  auth.publishableKey = cfg.publishableKey;

  const signOutBtn = document.getElementById("signOutBtn");
  if (signOutBtn) {
    signOutBtn.classList.remove("hidden");
    signOutBtn.addEventListener("click", signOut);
  }

  const form = document.getElementById("loginForm");
  const errorEl = document.getElementById("loginError");
  const submitEl = document.getElementById("loginSubmit");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.classList.add("hidden");
    submitEl.disabled = true;
    submitEl.textContent = "Signing in…";
    try {
      const res = await rawFetch(`${auth.url}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: auth.publishableKey },
        body: JSON.stringify({
          email: document.getElementById("loginEmail").value,
          password: document.getElementById("loginPassword").value,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.access_token) {
        throw new Error(body.error_description || body.msg || "Could not sign in.");
      }
      setSession(body.access_token, body.user && body.user.email);
      document.getElementById("loginPassword").value = "";
      await refreshIdentity();
      navigate("#/");
      applyRoute();
      loadHistory();
    } catch (err) {
      errorEl.textContent = err.message || "Could not sign in.";
      errorEl.classList.remove("hidden");
    } finally {
      submitEl.disabled = false;
      submitEl.textContent = "Sign in";
    }
  });

  // --- sign up -------------------------------------------------------------
  const signupForm = document.getElementById("signupForm");
  const signupError = document.getElementById("signupError");
  const signupSubmit = document.getElementById("signupSubmit");

  signupForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    signupError.classList.add("hidden");

    const email = document.getElementById("signupEmail").value.trim();
    const password = document.getElementById("signupPassword").value;

    // Client-side checks are UX only — Supabase validates both again server-side.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      signupError.textContent = "Enter a valid email address.";
      signupError.classList.remove("hidden");
      return;
    }
    if (password.length < 8) {
      signupError.textContent = "Password must be at least 8 characters.";
      signupError.classList.remove("hidden");
      return;
    }

    signupSubmit.disabled = true;
    signupSubmit.textContent = "Creating account…";
    try {
      // Our own server, NOT Supabase's public /auth/v1/signup. That endpoint 504s on this project
      // — it tries to send a confirmation email through the free-tier sender, which hangs, and no
      // account is ever created. The server creates a pre-confirmed account with the Admin API and
      // hands back a session, so there is no "check your email" state to land in. See
      // src/server/signup.ts.
      const res = await rawFetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.accessToken) {
        throw new Error(body.error || "Could not create the account.");
      }

      // The server already gave the new account its own organisation, so this session is usable
      // immediately — straight to Home, signed in, rather than back to a login screen.
      setSession(body.accessToken, (body.user && body.user.email) || email);
      document.getElementById("signupPassword").value = "";
      await refreshIdentity();
      navigate("#/");
      applyRoute();
      loadHistory();
    } catch (err) {
      signupError.textContent = err.message || "Could not create the account.";
      signupError.classList.remove("hidden");
    } finally {
      signupSubmit.disabled = false;
      signupSubmit.textContent = "Create account";
    }
  });

  // Switching between the two credential screens goes through showView() like every other view
  // change — applyRoute() reads auth.screen and renders the right one.
  document.getElementById("goSignup").addEventListener("click", () => {
    auth.screen = "signup";
    document.getElementById("loginError").classList.add("hidden");
    applyRoute();
  });
  document.getElementById("goLogin").addEventListener("click", () => {
    auth.screen = "login";
    document.getElementById("signupError").classList.add("hidden");
    applyRoute();
  });

  // A restored session still needs its role resolved before the UI can reflect it.
  if (auth.token) await refreshIdentity();

  // Re-run routing now that we know auth is on: a signed-out visitor gets redirected to the
  // login view they'd otherwise have slipped past while this request was in flight.
  applyRoute();
}

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
const screenshotModalLabelEl = document.getElementById("screenshotModalLabel");
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
        <span class="phase-badge pending">PENDING</span>
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
    // A replay (Step 5.3) skips planning, discovery and IR compilation, and says so on the card
    // rather than leaving a blank one. Checked first so any stage can carry the note; purely
    // additive — a normal run never sets `skipped`, so every case below is reached exactly as
    // before.
    if (data && typeof data.skipped === "string") return data.skipped;
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
    started: { cls: "running", text: "WORKING", ic: "loader" },
    completed: { cls: "done", text: "DONE", ic: "check" },
    failed: { cls: "failed", text: "FAILED", ic: "x" },
    pending: { cls: "pending", text: "PENDING", ic: "clock" },
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
          <!-- Step 5.2's bridge: keep this run's test plan as a reusable case. Offered to
               testers and above; the server refuses anyone lower regardless of what is drawn. -->
          <button type="button" class="dl-btn case-save-btn">${icon("plus", { size: 13 })} Save case</button>
        </div>
        <div class="case-save-panel hidden"></div>
        <details class="case-details">
          <summary>${icon("code", { size: 13 })} Technical details (for developers)</summary>
          <div class="case-details-content">
            ${c.intent ? `<h4>QA reasoning</h4><pre>${escapeHtml(c.intent)}</pre>` : ""}
            ${c.llmCalls ? `<h4>Cost</h4><pre>${c.llmCalls} AI call(s), ${c.llmTokens ?? 0} tokens</pre>` : ""}
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

  // Save-case (Step 5.2). A viewer never gets the control — and the server refuses them anyway,
  // which is the actual guarantee.
  suiteCaseListEl.querySelectorAll(".case-save-btn").forEach((btn) => {
    if (!roleAtLeast(auth.role, "tester")) { btn.remove(); return; }
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openSaveCasePanel(btn.closest(".case-card"));
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

/**
 * The inline "save this case into the library" panel (Step 5.2).
 *
 * Inline rather than a modal: the run's result is the context for the decision, and a modal would
 * cover the very card being saved. It asks for a project because a case's project is what governs
 * who can see it afterwards — defaulting silently would file authored work somewhere the author
 * did not choose.
 */
async function openSaveCasePanel(card) {
  const panel = card.querySelector(".case-save-panel");
  if (!panel) return;
  if (!panel.classList.contains("hidden")) { panel.classList.add("hidden"); return; }

  panel.classList.remove("hidden");
  panel.innerHTML = `<p class="hrow-meta">Loading projects…</p>`;

  let projects = [], suites = [];
  try {
    [projects, suites] = await Promise.all([
      api("/api/projects").then((r) => r.projects ?? []),
      api("/api/suites").then((r) => r.suites ?? []),
    ]);
  } catch (err) {
    panel.innerHTML = `<p class="team-error">${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!projects.length) {
    panel.innerHTML = `<p class="team-error">You're not in any project yet, so there's nowhere to save this.</p>`;
    return;
  }

  const runId = suiteResultsEl.dataset.runId;
  const caseId = card.dataset.caseId;
  const title = card.querySelector(".case-title")?.textContent ?? "";

  panel.innerHTML = `
    <div class="case-save-form">
      <label class="field">
        <span class="field-label">Project</span>
        <select class="team-select" data-role="project">
          ${projects.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")}
        </select>
      </label>
      <label class="field">
        <span class="field-label">Suite (optional)</span>
        <select class="team-select" data-role="suite">
          <option value="">— none —</option>
          ${suites.map((s) => `<option value="${escapeHtml(s.id)}" data-project="${escapeHtml(s.projectId)}">${escapeHtml(s.name)}</option>`).join("")}
        </select>
      </label>
      <button type="button" class="dl-btn" data-role="confirm">Save to library</button>
    </div>
    <p class="hrow-meta">Saved cases re-run with no AI calls at all.</p>
    <div data-role="feedback"></div>`;

  const projectSel = panel.querySelector('[data-role="project"]');
  const suiteSel = panel.querySelector('[data-role="suite"]');

  // Only offer suites belonging to the chosen project — the server refuses a cross-project pair,
  // so offering one would be offering a guaranteed error.
  const syncSuites = () => {
    [...suiteSel.options].forEach((o) => {
      if (!o.value) return;
      o.hidden = o.dataset.project !== projectSel.value;
    });
    const chosen = suiteSel.selectedOptions[0];
    if (chosen && chosen.value && chosen.hidden) suiteSel.value = "";
  };
  syncSuites();
  projectSel.addEventListener("change", syncSuites);

  panel.querySelector('[data-role="confirm"]').addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const saved = await api(`/api/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(caseId)}/save`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: projectSel.value,
          title,
          ...(suiteSel.value ? { suiteId: suiteSel.value } : {}),
        }),
      });
      panel.querySelector('[data-role="feedback"]').innerHTML =
        `<p class="team-ok">Saved. <a href="#/case/${encodeURIComponent(saved.id)}">Open the case</a></p>`;
    } catch (err) {
      panel.querySelector('[data-role="feedback"]').innerHTML =
        `<p class="team-error">${escapeHtml(err.message)}</p>`;
      btn.disabled = false;
    }
  });
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
    return { cls: "blocked", ic: "alert-circle", head: "Couldn’t run this",
             detail: error
               ? error + " This is a problem on our side, not a result about your site."
               : "The run stopped before it could test anything. This is a problem on our side, not a result about your site." };
  }
  if (status === "blocked") {
    return { cls: "blocked", ic: "slash-circle", head: "Couldn’t finish — the site needs something a test can’t provide",
             detail: `${data?.blockedBy ?? "The flow hit a step automation can’t pass."} The screenshot below is where it stopped.` };
  }
  if (status === "truncated_no_assertion") {
    return { cls: "incomplete", ic: "minus-circle", head: "Ran, but couldn’t confirm everything",
             detail: "One or more cases finished without a conclusive assertion — usually a step the test could not reach. That is neither a pass nor a failure." };
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
    return { cls: "passed", ic: "check", head: "Passed",
             detail: "Everything checked out. Every selected case reached its expected outcome." };
  }
  return { cls: "failed", ic: "x", head: "Failed",
           detail: "The site did not do what at least one test expected. Open the failing case below for the diagnosis." };
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
  screenshotModalLabelEl.textContent = alt || "";
  screenshotModalEl.classList.remove("hidden");
  document.addEventListener("keydown", handleScreenshotModalKeydown);
  screenshotModalCloseEl.focus();
}

function closeScreenshotModal() {
  screenshotModalEl.classList.add("hidden");
  screenshotModalImgEl.src = "";
  screenshotModalLabelEl.textContent = "";
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
      navigate("#/run/" + li.dataset.runId);
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

const RECENT_RUNS_SHOWN = 5;

// Every run ever fetched from /api/runs, kept around so the Projects tree can
// re-render on expand/collapse (a UI-only state change) without refetching.
let allRunsCache = [];

// Sidebar tree state. Declared here, beside the run cache they pair with, rather than next to
// renderProjectsTree() further down: loadHistory() runs at module load and reaches them through
// loadProjects(), so declaring them later would be a temporal-dead-zone crash waiting on a
// scheduling change.
const expandedProjects = new Set();
/** Projects the server says we may see; null until the first load resolves, and null again if the
 *  server can't answer (no database configured — see loadProjects()). */
let projectsCache = null;
/** True once a load has been attempted and failed, which is how the tree tells "not loaded yet"
 *  apart from "this deployment has no project rows to serve". */
let projectsUnavailable = false;
/** Saved suites, shown under their project in the sidebar (Step 5.5). Always an array — the tree
 *  renders it inline, and a null here would mean guarding every use. */
let suitesCache = [];

// The sidebar's inline "new suite" form. Module state rather than DOM state because
// renderProjectsTree() re-renders wholesale on every history refresh — anything held only in the
// input would be wiped mid-typing by a background reload.
let newSuiteFor = null;     // project id whose form is open, or null
let newSuiteName = "";
let newSuiteError = "";

async function loadHistory() {
  const res = await fetch("/api/runs");
  const runs = await res.json().catch(() => null);
  // /api/runs can legitimately answer with a non-array body — a 401 `{error}` when auth is on and
  // the visitor hasn't signed in yet, which happens on every cold load before initAuth() resolves.
  // Bail instead of crashing on .slice(); the login flow calls loadHistory() again once signed in.
  if (!Array.isArray(runs)) return;
  allRunsCache = runs;
  renderHistory(runs.slice(0, RECENT_RUNS_SHOWN));
  // Projects come from their own endpoint (Step 5.1) — the sidebar can no longer be derived from
  // the run list, because which projects you may see is a server decision, and a project you can
  // see may legitimately have no runs in the newest-20 window.
  await loadProjects();
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

  currentRunId = runId;
  resetRunUI();

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
      body: JSON.stringify({ prompt, url, coverage, options: runOptions }),
    });
    if (!res.ok) throw new Error(`Server responded with HTTP ${res.status}`);
    const { runId } = await res.json();
    if (!runId) throw new Error("Server didn't return a run id");
    navigate("#/run/" + runId);
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
document.getElementById("runIcon").innerHTML = icon("play", { size: 14 });
document.getElementById("credIcon").innerHTML = icon("key", { size: 18 });
document.getElementById("caseSelectionIcon").innerHTML = icon("list", { size: 18 });

// "New run" clears the workspace without a page reload, so an in-flight poll is abandoned
// (pollGeneration is what stops the old loop touching the DOM again).
document.getElementById("newRunBtn").addEventListener("click", () => {
  pollGeneration++;
  currentRunId = null;
  promptEl.value = "";
  urlEl.value = "";
  resetRunUI();
  navigate("#/");
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

// -----------------------------------------------------------------------------
// Shell: views, routing, and the one reset site
// -----------------------------------------------------------------------------

const sidebarEl = document.getElementById("sidebar");
const sidebarTreeEl = document.getElementById("sidebarTree");
const sidebarSearchEl = document.getElementById("sidebarSearch");
const sidebarOpenEl = document.getElementById("sidebarOpen");
const sidebarCloseEl = document.getElementById("sidebarClose");
const scrimEl = document.getElementById("scrim");
const crumbsEl = document.getElementById("crumbs");
const crumbRootEl = document.getElementById("crumbRoot");
const historyBtnEl = document.getElementById("historyBtn");
const teamBtnEl = document.getElementById("teamBtn");
const allRunsBtnEl = document.getElementById("allRunsBtn");
const settingsBtnEl = document.getElementById("settingsBtn");
const settingsPopEl = document.getElementById("settingsPop");
const gateToggleEl = document.getElementById("gateToggle");
const healToggleEl = document.getElementById("healToggle");
const coverageSegEl = document.getElementById("coverageSeg");
const toastEl = document.getElementById("toast");
const runTitleEl = document.getElementById("runTitle");
const runScopeLabelEl = document.getElementById("runScopeLabel");
const runMetaEl = document.getElementById("runMeta");

/**
 * Backend status -> the vocabulary the UI speaks.
 *
 * Two collapses here are deliberate, not tidying:
 *
 *  - truncated / truncated_no_assertion / incomplete all become "unconfirmed".
 *    They are three names for one situation: the test ran and proved nothing.
 *    Reporting any of them as a pass is what problems.md calls out under
 *    "a truncated test can report green".
 *
 *  - error becomes "blocked", NOT "failed". An invalid API key or a dead model
 *    id is not the site under test misbehaving, and reporting it as a failure is
 *    the single most expensive defect in problems.md ("you were told your
 *    website has failing tests when the truth was that your API key was
 *    invalid"). --blocked carries its own hue precisely so "we couldn't run"
 *    can never be read as "your site is broken".
 */
const RUN_STATUS = {
  passed: { key: "passed", label: "Passed" },
  failed: { key: "failed", label: "Failed" },
  blocked: { key: "blocked", label: "Blocked" },
  error: { key: "blocked", label: "Couldn't run" },
  truncated: { key: "unconfirmed", label: "Unconfirmed" },
  truncated_no_assertion: { key: "unconfirmed", label: "Unconfirmed" },
  incomplete: { key: "unconfirmed", label: "Unconfirmed" },
  no_cases_selected: { key: "blocked", label: "Nothing selected" },
  running: { key: "running", label: "Running" },
  pending: { key: "pending", label: "Queued" },
  draft: { key: "draft", label: "Not run yet" },
};
const statusKey = (s) => (RUN_STATUS[s] || RUN_STATUS.pending).key;
const statusText = (s) => (RUN_STATUS[s] || { label: s }).label;

/** The app's only general notification channel. showNotice() is not one: it
 *  writes inside #case-selection-panel, so its message is invisible whenever
 *  that panel is closed. */
let toastTimer = null;
function toast(message) {
  toastEl.textContent = message;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.add("hidden"), 3200);
}

// -----------------------------------------------------------------------------
// The test-case library — Suite, Case and Compare (Steps 5.2, 5.3, 5.5)
//
// These three views existed as empty stubs in the router from the first slice. They render real
// data now. Everything is scoped by project on the server, so a viewer only ever sees suites and
// cases inside projects they were added to — this code never has to filter for access, and must
// not try to: hiding a row is a courtesy, the server's refusal is the control.
//
// Execution is always a REPLAY (POST /api/replay): stored IR straight to generateSpec/runSpec,
// zero LLM calls. Whole suite, a chosen subset, or one case are the same call with a different
// selection, which is why there is one runReplay() helper below rather than three.
// -----------------------------------------------------------------------------

const CASE_BADGE = {
  passed: "badge-passed", failed: "badge-failed", blocked: "badge-blocked",
  truncated: "badge-truncated", truncated_no_assertion: "badge-partial",
};
const caseBadgeClass = (s) => CASE_BADGE[s] ?? "badge-pending";
const caseStatusLabel = (s) => (s ? (STATUS_LABEL[s] ?? s) : "Not run yet");

/** One line of a step, as plain English. The IR is role+name; a person reads verbs. */
function stepText(step, i) {
  const t = step.target ?? {};
  const what = t.name || t.label || t.text || t.placeholder || t.url || t.css || "";
  const verb = {
    navigate: "Go to", click: "Click", fill: "Fill", select: "Select",
    check: "Check", press: "Press", wait: "Wait for", assert: "Assert",
  }[step.action] ?? step.action;
  const value = step.value ? ` with "${step.value}"` : "";
  const assertion = step.assertion ? ` (${step.assertion.replace(/_/g, " ")})` : "";
  return `${i + 1}. ${verb}${what ? ` ${what}` : ""}${value}${assertion}`;
}

/** A timestamp as something readable. Falls back to the raw value rather than "Invalid Date". */
function formatWhen(ts) {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
}

async function api(path, init) {
  const res = await fetch(path, init);
  if (res.status === 204) return null;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `That didn't work (${res.status}).`);
  return body;
}

/**
 * Start a replay and follow it on the Run view.
 *
 * The run it creates is a first-class run — it appears in history and its artifacts are guarded
 * exactly like any other — so handing off to the existing Run view is the whole integration.
 */
async function startReplay(selection, label) {
  try {
    const { runId } = await api("/api/replay", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...selection, label }),
    });
    toast("Replaying — this costs nothing, the steps are already saved.");
    navigate("#/run/" + runId);
  } catch (err) {
    toast(err.message);
  }
}

// ---------------------------------------------------------------- Suite view

async function renderSuiteView(suiteId) {
  const body = document.getElementById("suiteViewBody");
  body.innerHTML = `<div class="tree-empty" style="padding:36px 16px;text-align:center">Loading…</div>`;

  let suite, cases;
  try {
    const suites = (await api("/api/suites")).suites ?? [];
    suite = suites.find((s) => s.id === suiteId);
    if (!suite) throw new Error("That suite no longer exists, or you don't have access to it.");
    cases = (await api(`/api/suites/${encodeURIComponent(suiteId)}/cases`)).cases ?? [];
  } catch (err) {
    body.innerHTML = `<div class="tree-empty" style="padding:36px 16px;text-align:center">${escapeHtml(err.message)}</div>`;
    return;
  }

  setCrumbs(["Suite", suite.name]);
  const canAuthor = roleAtLeast(auth.role, "tester");
  const canDelete = roleAtLeast(auth.role, "admin");

  body.innerHTML = `
    <div>
      <div class="eyebrow">TEST SUITE</div>
      <h1 class="page-head-title">${escapeHtml(suite.name)}</h1>
      <p class="tagline">${cases.length} case${cases.length === 1 ? "" : "s"} — they run in the order below.
      Re-running a saved suite makes no AI calls at all.</p>
    </div>
    <div class="lib-toolbar">
      ${canAuthor ? `<button type="button" class="dl-btn-inline" data-act="add-cases">+ Add cases</button>` : ""}
      ${canAuthor ? `<button type="button" class="dl-btn-inline" data-act="rename">Rename suite</button>` : ""}
      ${canDelete ? `<button type="button" class="dl-btn-inline" data-act="delete-suite">Delete suite</button>` : ""}
      <span class="lib-toolbar-gap"></span>
      ${canAuthor ? `
        <button type="button" class="dl-btn-inline" data-act="run-selected" disabled>▸ Run 0 selected</button>
        <button type="button" class="run-btn lib-run-all" data-act="run-all">▸ Run all</button>` : ""}
    </div>
    <div id="suiteFeedback"></div>
    <div id="suiteAddPanel"></div>
    <div class="panel"><div id="suiteRows"></div></div>`;

  const rows = document.getElementById("suiteRows");
  if (!cases.length) {
    rows.innerHTML = `<div class="tree-empty" style="padding:36px 16px;text-align:center">
      No cases in this suite yet. Finish a run, then use <b>Save case</b> on a result to add one.</div>`;
  } else {
    rows.innerHTML = cases.map((c, i) => `
      <div class="hrow lib-row" data-case-id="${escapeHtml(c.id)}">
        ${canAuthor ? `<input type="checkbox" class="lib-check" aria-label="Select ${escapeHtml(c.title)}" />` : ""}
        <span class="lib-pos">${i + 1}</span>
        <span class="case-badge ${caseBadgeClass(c.lastRunStatus)}">${escapeHtml(caseStatusLabel(c.lastRunStatus))}</span>
        <div class="hrow-main">
          <div class="hrow-label">${escapeHtml(c.title)}</div>
          <div class="hrow-meta">v${c.currentVersion}${c.feature ? ` · ${escapeHtml(c.feature)}` : ""}${c.lastRunAt ? ` · last run ${formatWhen(c.lastRunAt)}` : ""}</div>
        </div>
        <div class="hrow-actions">
          ${canAuthor ? `<button type="button" class="dl-btn-inline" data-act="up" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>` : ""}
          ${canAuthor ? `<button type="button" class="dl-btn-inline" data-act="down" title="Move down" ${i === cases.length - 1 ? "disabled" : ""}>↓</button>` : ""}
          <button type="button" class="dl-btn-inline" data-act="open">Open</button>
          ${canAuthor ? `<button type="button" class="dl-btn-inline" data-act="run-one">▸ Run</button>` : ""}
          ${canAuthor ? `<button type="button" class="dl-btn-inline" data-act="remove">Remove</button>` : ""}
        </div>
      </div>`).join("");
  }

  const feedback = (msg, isError) => {
    document.getElementById("suiteFeedback").innerHTML =
      `<p class="${isError ? "team-error" : "team-ok"}">${escapeHtml(msg)}</p>`;
  };

  /**
   * Pick saved cases from this project and file them into this suite.
   *
   * Only offers cases NOT already in the suite: `suite_cases` has (suite_id, case_id) as its key,
   * so re-adding one is a guaranteed error, and offering it would be offering a mistake. Same
   * reasoning as the Team screen's addable-users list.
   */
  const openAddPanel = async () => {
    const panel = document.getElementById("suiteAddPanel");
    panel.innerHTML = `<div class="case-save-panel"><p class="hrow-meta">Loading cases…</p></div>`;
    let pool;
    try {
      const all = (await api(`/api/cases?projectId=${encodeURIComponent(suite.projectId)}`)).cases ?? [];
      const already = new Set(cases.map((c) => c.id));
      pool = all.filter((c) => !already.has(c.id));
    } catch (err) {
      panel.innerHTML = `<div class="case-save-panel"><p class="team-error">${escapeHtml(err.message)}</p></div>`;
      return;
    }

    if (!pool.length) {
      panel.innerHTML = `<div class="case-save-panel">
        <p class="hrow-meta">Every saved case in this project is already in this suite.
        Save another from a finished run to add more.</p>
        <button type="button" class="dl-btn-inline" data-add="close">Close</button>
      </div>`;
    } else {
      panel.innerHTML = `<div class="case-save-panel">
        <div class="lib-steps-head">Add saved cases to “${escapeHtml(suite.name)}”</div>
        <div class="suite-add-list">
          ${pool.map((c) => `
            <label class="suite-add-row">
              <input type="checkbox" class="lib-check" value="${escapeHtml(c.id)}" />
              <span class="hrow-label">${escapeHtml(c.title)}</span>
              <span class="hrow-meta">v${c.currentVersion}${c.feature ? ` · ${escapeHtml(c.feature)}` : ""}</span>
            </label>`).join("")}
        </div>
        <div class="step-edit-actions">
          <button type="button" class="dl-btn-inline" data-add="close">Cancel</button>
          <span class="lib-toolbar-gap"></span>
          <button type="button" class="run-btn lib-run-all" data-add="confirm" disabled>Add 0 cases</button>
        </div>
      </div>`;
    }

    const picked = () => [...panel.querySelectorAll(".lib-check")].filter((c) => c.checked).map((c) => c.value);
    const confirmBtn = panel.querySelector('[data-add="confirm"]');
    panel.querySelectorAll(".lib-check").forEach((cb) => cb.addEventListener("change", () => {
      const n = picked().length;
      confirmBtn.textContent = `Add ${n} case${n === 1 ? "" : "s"}`;
      confirmBtn.disabled = n === 0;
    }));

    panel.querySelectorAll("[data-add]").forEach((btn) => btn.addEventListener("click", async () => {
      if (btn.dataset.add === "close") { panel.innerHTML = ""; return; }
      const ids = picked();
      btn.disabled = true;
      try {
        // Sequential, not Promise.all: each POST appends, so the order they arrive in is the
        // order they end up in. Parallel requests would land in a nondeterministic order.
        for (const caseId of ids) {
          await api(`/api/suites/${encodeURIComponent(suiteId)}/cases`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ caseId }),
          });
        }
        toast(`Added ${ids.length} case${ids.length === 1 ? "" : "s"}.`);
        await loadProjects();                 // suite case-counts in the sidebar
        return renderSuiteView(suiteId);
      } catch (err) {
        btn.disabled = false;
        panel.querySelector(".case-save-panel").insertAdjacentHTML(
          "beforeend", `<p class="team-error">${escapeHtml(err.message)}</p>`);
      }
    }));
  };

  const order = () => [...rows.querySelectorAll(".lib-row")].map((r) => r.dataset.caseId);
  const selected = () => [...rows.querySelectorAll(".lib-row")]
    .filter((r) => r.querySelector(".lib-check")?.checked)
    .map((r) => r.dataset.caseId);

  const refreshSelectedBtn = () => {
    const btn = body.querySelector('[data-act="run-selected"]');
    if (!btn) return;
    const n = selected().length;
    btn.textContent = `▸ Run ${n} selected`;
    btn.disabled = n === 0;
  };
  rows.querySelectorAll(".lib-check").forEach((cb) => cb.addEventListener("change", refreshSelectedBtn));

  body.querySelectorAll("[data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.dataset.act;
      const row = btn.closest(".lib-row");
      const caseId = row?.dataset.caseId;
      try {
        if (act === "run-all") return startReplay({ suiteId }, `Replayed suite "${suite.name}"`);
        if (act === "run-selected") {
          const ids = selected();
          return startReplay({ suiteId, caseIds: ids },
            `Replayed ${ids.length} case${ids.length === 1 ? "" : "s"} from "${suite.name}"`);
        }
        if (act === "run-one") {
          const title = row.querySelector(".hrow-label").textContent;
          return startReplay({ caseIds: [caseId] }, `Replayed "${title}"`);
        }
        if (act === "open") return navigate("#/case/" + encodeURIComponent(caseId));
        if (act === "add-cases") return openAddPanel();

        if (act === "rename") {
          const name = prompt("Rename this suite", suite.name);
          if (!name || name === suite.name) return;
          await api(`/api/suites/${encodeURIComponent(suiteId)}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name }),
          });
          return renderSuiteView(suiteId);
        }
        if (act === "delete-suite") {
          if (!confirm(`Delete the suite "${suite.name}"? The cases themselves are kept.`)) return;
          await api(`/api/suites/${encodeURIComponent(suiteId)}`, { method: "DELETE" });
          toast("Suite deleted — its cases were kept.");
          return navigate("#/");
        }
        if (act === "remove") {
          await api(`/api/suites/${encodeURIComponent(suiteId)}/cases/${encodeURIComponent(caseId)}`,
            { method: "DELETE" });
          return renderSuiteView(suiteId);
        }
        if (act === "up" || act === "down") {
          const ids = order();
          const i = ids.indexOf(caseId);
          const j = act === "up" ? i - 1 : i + 1;
          if (j < 0 || j >= ids.length) return;
          [ids[i], ids[j]] = [ids[j], ids[i]];
          await api(`/api/suites/${encodeURIComponent(suiteId)}/order`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ caseIds: ids }),
          });
          return renderSuiteView(suiteId);
        }
      } catch (err) {
        feedback(err.message, true);
      }
    });
  });
}

// ----------------------------------------------------------------- Case view

/** Which tab the Case screen is on. Module-level so a re-render keeps the reader where they were. */
let caseTab = "steps";

// -------------------------------------------------------- inline step editor
//
// Edits a case's steps in place and PATCHes the whole IR back, which mints a version and feeds
// Compare. The server's Zod parse (src/schema/ir.ts, via library.ts's parseIr) stays the ONLY
// authority on what a valid step is — nothing here re-implements it, because a second copy of
// that schema is exactly the drift DECISIONS.md D-01 is about. What lives here is only which
// inputs to draw for a given action.

let caseEditor = null;   // { caseId, steps, original, errorAt, errorMsg } — non-null while editing

const STEP_ACTIONS = ["navigate", "click", "fill", "select", "check", "press", "wait", "assert"];
const STEP_ASSERTIONS = [
  "visible", "hidden", "text_equals", "text_contains",
  "url_contains", "title_contains", "title_equals", "enabled", "disabled",
];
// Page-level assertions take no target — see the note on the title/url assertions in schema/ir.ts.
const PAGE_ASSERTIONS = new Set(["url_contains", "title_contains", "title_equals"]);
/** generator.ts's emitAssert REFUSES to emit these without a comparison value ("refusing to emit
 *  a vacuous assertion"). Zod accepts the step, so without a nudge here the failure would only
 *  surface at replay. Rendered as a warning, never a block — blocking would be a second
 *  validator to drift out of step with the generator. */
const VALUE_ASSERTIONS = new Set(["url_contains", "text_contains", "text_equals", "title_contains", "title_equals"]);

/** Which inputs a step shows, driven by its action — so an invalid step is hard to express. */
function stepFields(step) {
  switch (step.action) {
    case "navigate": return { url: true };
    case "press": return { value: true };
    case "fill":
    case "select": return { role: true, name: true, value: true };
    case "click":
    case "check":
    case "wait": return { role: true, name: true };
    case "assert":
      return PAGE_ASSERTIONS.has(step.assertion)
        ? { assertion: true, value: true }
        : { assertion: true, role: true, name: true, value: VALUE_ASSERTIONS.has(step.assertion) };
    default: return { role: true, name: true, value: true };
  }
}

/**
 * Write one edited field back into a step.
 *
 * Mutates the step and its EXISTING target rather than rebuilding either. That is deliberate and
 * load-bearing: a grounded target can carry `css`, `testId`, `nth`, `label`, `text` and
 * `placeholder`, none of which this editor draws. `css` in particular is written during grounding
 * and is "what makes icon-only controls addressable at all" (schema/ir.ts). Rebuilding a target
 * from the two fields shown here would drop it — producing an IR that still validates but no
 * longer resolves the element it was grounded against. Mutating in place makes that impossible
 * by construction rather than by remembering to copy each field.
 */
function setStepField(step, field, raw) {
  const filled = raw.trim() !== "";
  if (field === "action") {
    step.action = raw;
    // Leaving a stale assertion on a non-assert step is harmless to Zod but confusing to read
    // back, and it reappears if the user switches to assert and away again.
    if (raw !== "assert") delete step.assertion;
    else if (!step.assertion) step.assertion = "visible";
    return;
  }
  if (field === "assertion") { step.assertion = raw || undefined; return; }
  // Stored untrimmed: a value may be a `${env:...}` credential reference or contain meaningful
  // spacing, and this editor must hand both back exactly as it found them.
  if (field === "value") { if (filled) step.value = raw; else delete step.value; return; }

  step.target = step.target || {};
  if (filled) step.target[field] = raw;
  else delete step.target[field];
  if (!Object.keys(step.target).length) delete step.target;
}

/** A fresh step id that cannot collide with one already in use — ids are referenced by
 *  failing-step reporting, so reusing one would misattribute a failure. */
function nextStepId(steps) {
  const used = new Set(steps.map((s) => s.id));
  let n = steps.length + 1;
  while (used.has(`s${n}`)) n++;
  return `s${n}`;
}

function caseEditorDirty() {
  return !!caseEditor && JSON.stringify(caseEditor.steps) !== caseEditor.original;
}

/** The server reports the offending path as e.g. `steps.3.action …` — pull the index out so the
 *  message can be shown against that row instead of floating above the whole list. */
function errorStepIndex(message) {
  const m = /steps\.(\d+)/.exec(message || "");
  return m ? Number(m[1]) : null;
}

/** One editable step. Inputs carry data-i/data-f so a single delegated listener writes them all
 *  back — twelve per-input handlers would be twelve chances to miss one. */
function stepEditorRow(step, i, total) {
  const f = stepFields(step);
  const t = step.target || {};
  const err = caseEditor.errorAt === i ? caseEditor.errorMsg : "";
  const needsValue =
    step.action === "assert" && VALUE_ASSERTIONS.has(step.assertion) && !String(step.value ?? "").trim();

  const field = (label, name, value, wide) => `
    <label class="step-f${wide ? " step-f-wide" : ""}">
      <span>${label}</span>
      <input type="text" data-i="${i}" data-f="${name}" value="${escapeHtml(String(value ?? ""))}" />
    </label>`;

  return `
    <div class="step-edit${err ? " step-edit-bad" : ""}">
      <div class="step-edit-main">
        <span class="lib-pos">${i + 1}</span>
        <label class="step-f">
          <span>Action</span>
          <select data-i="${i}" data-f="action">
            ${STEP_ACTIONS.map((a) =>
              `<option value="${a}"${a === step.action ? " selected" : ""}>${a}</option>`).join("")}
          </select>
        </label>
        ${f.assertion ? `
          <label class="step-f">
            <span>Assertion</span>
            <select data-i="${i}" data-f="assertion">
              ${STEP_ASSERTIONS.map((a) =>
                `<option value="${a}"${a === step.assertion ? " selected" : ""}>${a.replace(/_/g, " ")}</option>`).join("")}
            </select>
          </label>` : ""}
        ${f.url ? field("URL", "url", t.url, true) : ""}
        ${f.role ? field("Role", "role", t.role) : ""}
        ${f.name ? field("Name", "name", t.name, true) : ""}
        ${f.value ? field(step.action === "press" ? "Key" : "Value", "value", step.value, true) : ""}
        <span class="step-edit-btns">
          <button type="button" class="dl-btn-inline" data-ed="up" data-i="${i}" title="Move up"${i === 0 ? " disabled" : ""}>↑</button>
          <button type="button" class="dl-btn-inline" data-ed="down" data-i="${i}" title="Move down"${i === total - 1 ? " disabled" : ""}>↓</button>
          <button type="button" class="dl-btn-inline" data-ed="insert" data-i="${i}" title="Insert a step below">+</button>
          <button type="button" class="dl-btn-inline" data-ed="del" data-i="${i}" title="Remove this step">×</button>
        </span>
      </div>
      ${err ? `<p class="step-edit-err">${escapeHtml(err)}</p>` : ""}
      ${needsValue ? `<p class="step-edit-warn">“${escapeHtml(String(step.assertion).replace(/_/g, " "))}” needs a comparison value — the run cannot generate this step without one.</p>` : ""}
    </div>`;
}

/** The editor body. Re-rendered wholesale on every structural change; field edits mutate state
 *  in place and only repaint when the visible field set actually changes. */
function paintStepEditor(el, c, caseId, repaint) {
  const steps = caseEditor.steps;

  el.innerHTML = `
    <div class="lib-steps">
      <div class="lib-steps-head">
        Steps — edit in place
        ${caseEditorDirty() ? `<span class="case-badge badge-truncated">UNSAVED</span>` : ""}
      </div>
      ${caseEditor.errorMsg && caseEditor.errorAt === null
        ? `<p class="team-error">${escapeHtml(caseEditor.errorMsg)}</p>` : ""}
      <div class="step-edit-list">
        ${steps.length
          ? steps.map((s, i) => stepEditorRow(s, i, steps.length)).join("")
          : `<p class="hrow-meta">No steps. A test plan needs at least one — add one below.</p>`}
      </div>
      <div class="step-edit-actions">
        <button type="button" class="dl-btn-inline" data-ed="add">+ Add step</button>
        <span class="lib-toolbar-gap"></span>
        <button type="button" class="dl-btn-inline" data-ed="cancel">Cancel</button>
        <button type="button" class="run-btn lib-run-all" data-ed="save">Save changes</button>
      </div>
      <p class="hrow-meta">Target: ${escapeHtml(c.ir.meta.baseUrl)}</p>
    </div>`;

  // Field edits. `change` (not `input`) so a repaint never steals focus mid-typing; the action
  // and assertion selects repaint because they change which inputs exist.
  el.querySelectorAll("[data-f]").forEach((input) => {
    input.addEventListener("change", () => {
      const i = Number(input.dataset.i);
      const before = JSON.stringify(stepFields(steps[i]));
      setStepField(steps[i], input.dataset.f, input.value);
      caseEditor.errorAt = null;
      caseEditor.errorMsg = "";
      if (JSON.stringify(stepFields(steps[i])) !== before || input.dataset.f === "action") repaint();
      else paintStepEditor(el, c, caseId, repaint);   // refresh the UNSAVED badge and warnings
    });
  });

  el.querySelectorAll("[data-ed]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.dataset.ed;
      const i = Number(btn.dataset.i);
      caseEditor.errorAt = null;
      caseEditor.errorMsg = "";

      if (act === "up" || act === "down") {
        const j = act === "up" ? i - 1 : i + 1;
        [steps[i], steps[j]] = [steps[j], steps[i]];
        return repaint();
      }
      if (act === "del") { steps.splice(i, 1); return repaint(); }
      if (act === "insert") {
        steps.splice(i + 1, 0, { id: nextStepId(steps), action: "click", target: { role: "button" } });
        return repaint();
      }
      if (act === "add") {
        steps.push({ id: nextStepId(steps), action: "click", target: { role: "button" } });
        return repaint();
      }
      if (act === "cancel") {
        if (caseEditorDirty() && !confirm("Discard your unsaved step changes?")) return;
        caseEditor = null;
        return repaint();
      }
      if (act === "save") {
        if (!caseEditorDirty()) { caseEditor = null; return repaint(); }
        btn.disabled = true;
        try {
          // meta is carried through untouched — this editor owns steps and nothing else.
          const updated = await api(`/api/cases/${encodeURIComponent(caseId)}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ir: { ...c.ir, steps }, changeNote: "Edited steps" }),
          });
          caseEditor = null;
          toast(`Saved as v${updated.currentVersion}.`);
          caseTab = "versions";        // the new version is the payoff; show it immediately
          return renderCaseView(caseId);
        } catch (err) {
          btn.disabled = false;
          caseEditor.errorMsg = err.message;
          caseEditor.errorAt = errorStepIndex(err.message);
          return repaint();
        }
      }
    });
  });
}

async function renderCaseView(caseId) {
  // An editor belongs to exactly one case. Rendering a different one drops it — the route guard
  // has already asked about unsaved work by this point, so anything still here was abandoned.
  if (caseEditor && caseEditor.caseId !== caseId) caseEditor = null;

  const body = document.getElementById("caseViewBody");
  body.innerHTML = `<div class="tree-empty" style="padding:36px 16px;text-align:center">Loading…</div>`;

  let c;
  try {
    c = await api(`/api/cases/${encodeURIComponent(caseId)}`);
  } catch (err) {
    body.innerHTML = `<div class="tree-empty" style="padding:36px 16px;text-align:center">${escapeHtml(err.message)}</div>`;
    return;
  }

  setCrumbs(["Case", c.title]);
  const canAuthor = roleAtLeast(auth.role, "tester");
  const canDelete = roleAtLeast(auth.role, "admin");

  body.innerHTML = `
    <div>
      <div class="eyebrow">TEST CASE</div>
      <h1 class="page-head-title">${escapeHtml(c.title)}</h1>
      <p class="tagline">
        <span class="case-badge ${caseBadgeClass(c.lastRunStatus)}">${escapeHtml(caseStatusLabel(c.lastRunStatus))}</span>
        <span class="hrow-meta">v${c.currentVersion}${c.sourceRunId ? ` · saved from ${escapeHtml(c.sourceRunId)}` : ""}</span>
      </p>
    </div>
    <div class="lib-toolbar">
      ${canAuthor ? `<button type="button" class="dl-btn-inline" data-act="rename">Rename</button>` : ""}
      ${c.versions.length > 1 ? `<button type="button" class="dl-btn-inline" data-act="compare">Compare versions</button>` : ""}
      ${canDelete ? `<button type="button" class="dl-btn-inline" data-act="delete">Delete case</button>` : ""}
      <span class="lib-toolbar-gap"></span>
      ${canAuthor ? `<button type="button" class="run-btn lib-run-all" data-act="run">▸ Run case</button>` : ""}
    </div>
    <div id="caseFeedback"></div>
    <div id="caseSuites"></div>
    <div class="seg" id="caseTabs" role="group" aria-label="Case sections">
      <button type="button" class="seg-btn${caseTab === "steps" ? " active" : ""}" data-tab="steps">Steps</button>
      <button type="button" class="seg-btn${caseTab === "versions" ? " active" : ""}" data-tab="versions">Versions</button>
    </div>
    <div class="panel"><div id="caseBody"></div></div>`;

  /**
   * Which suites this case is in, and a way into another one.
   *
   * `suite_cases` is a join table precisely so a case can live in several suites at once — a login
   * case belongs in both "Smoke" and "Auth". Without this the many-to-many is a schema detail
   * nobody can reach: a case could only ever be filed at save time, into exactly one suite.
   */
  const paintSuites = async () => {
    const el = document.getElementById("caseSuites");
    let all = [];
    try {
      all = ((await api(`/api/suites?projectId=${encodeURIComponent(c.projectId)}`)).suites ?? []);
    } catch { el.innerHTML = ""; return; }

    const inIds = new Set(c.suiteIds || []);
    const inSuites = all.filter((s) => inIds.has(s.id));
    const available = all.filter((s) => !inIds.has(s.id));

    el.innerHTML = `
      <div class="case-suites">
        <span class="case-suites-label">Suites</span>
        ${inSuites.length
          ? inSuites.map((s) => `
              <button type="button" class="case-suite-chip" data-goto="${escapeHtml(s.id)}"
                      title="Open ${escapeHtml(s.name)}">${escapeHtml(s.name)}</button>`).join("")
          : `<span class="hrow-meta">Not in any suite yet.</span>`}
        ${canAuthor && available.length ? `
          <select class="case-suite-pick" id="caseSuitePick" aria-label="Add this case to a suite">
            <option value="">Add to suite…</option>
            ${available.map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("")}
          </select>` : ""}
      </div>`;

    el.querySelectorAll("[data-goto]").forEach((b) =>
      b.addEventListener("click", () => navigate("#/suite/" + encodeURIComponent(b.dataset.goto))));

    const pick = document.getElementById("caseSuitePick");
    if (pick) pick.addEventListener("change", async () => {
      const suiteId = pick.value;
      if (!suiteId) return;
      pick.disabled = true;
      try {
        await api(`/api/suites/${encodeURIComponent(suiteId)}/cases`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ caseId }),
        });
        toast("Added to the suite.");
        await loadProjects();
        return renderCaseView(caseId);
      } catch (err) {
        pick.disabled = false;
        document.getElementById("caseFeedback").innerHTML =
          `<p class="team-error">${escapeHtml(err.message)}</p>`;
      }
    });
  };
  paintSuites();

  const paint = () => {
    const el = document.getElementById("caseBody");
    if (caseTab === "steps" && caseEditor && caseEditor.caseId === caseId) {
      paintStepEditor(el, c, caseId, paint);
    } else if (caseTab === "steps") {
      el.innerHTML = `
        <div class="lib-steps">
          <div class="lib-steps-head">
            Steps — what this test actually does
            ${canAuthor ? `<button type="button" class="dl-btn-inline" id="editStepsBtn">Edit steps</button>` : ""}
          </div>
          <ol class="lib-step-list">
            ${c.ir.steps.map((s, i) => `<li>${escapeHtml(stepText(s, i).replace(/^\d+\.\s*/, ""))}</li>`).join("")}
          </ol>
          <p class="hrow-meta">Target: ${escapeHtml(c.ir.meta.baseUrl)}</p>
        </div>`;
      const edit = document.getElementById("editStepsBtn");
      if (edit) edit.addEventListener("click", () => {
        // Deep clone: every edit mutates this copy, so Cancel is just "throw it away" and the
        // rendered case object is never touched until a PATCH succeeds.
        const steps = JSON.parse(JSON.stringify(c.ir.steps));
        caseEditor = { caseId, steps, original: JSON.stringify(steps), errorAt: null, errorMsg: "" };
        paint();
      });
    } else {
      el.innerHTML = c.versions.length
        ? c.versions.map((v) => `
          <div class="hrow">
            <span class="case-badge badge-pending">v${v.version}</span>
            <div class="hrow-main">
              <div class="hrow-label">${escapeHtml(v.changeNote || "No note")}</div>
              <div class="hrow-meta">${v.savedAt ? formatWhen(v.savedAt) : ""}</div>
            </div>
            <div class="hrow-actions">
              ${v.version !== c.currentVersion
                ? `<button type="button" class="dl-btn-inline" data-act="compare-v" data-v="${v.version}">Compare with current</button>`
                : `<span class="hrow-meta">current</span>`}
            </div>
          </div>`).join("")
        : `<div class="tree-empty" style="padding:24px 16px;text-align:center">No version history yet.</div>`;

      el.querySelectorAll('[data-act="compare-v"]').forEach((b) => {
        b.addEventListener("click", () =>
          navigate(`#/compare/${encodeURIComponent(caseId)}?from=${b.dataset.v}&to=${c.currentVersion}`));
      });
    }
  };
  paint();

  document.getElementById("caseTabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".seg-btn");
    if (!btn) return;
    caseTab = btn.dataset.tab;
    document.querySelectorAll("#caseTabs .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
    paint();
  });

  body.querySelectorAll(".lib-toolbar [data-act]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const act = btn.dataset.act;
      try {
        if (act === "run") return startReplay({ caseIds: [caseId] }, `Replayed "${c.title}"`);
        if (act === "compare") {
          const prev = c.versions.find((v) => v.version !== c.currentVersion);
          return navigate(`#/compare/${encodeURIComponent(caseId)}?from=${prev?.version ?? 1}&to=${c.currentVersion}`);
        }
        if (act === "rename") {
          const title = prompt("Rename this case", c.title);
          if (!title || title === c.title) return;
          await api(`/api/cases/${encodeURIComponent(caseId)}`, {
            method: "PATCH", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title }),
          });
          return renderCaseView(caseId);
        }
        if (act === "delete") {
          if (!confirm(`Delete "${c.title}"? This removes it from every suite it is in.`)) return;
          await api(`/api/cases/${encodeURIComponent(caseId)}`, { method: "DELETE" });
          toast("Case deleted.");
          return navigate("#/");
        }
      } catch (err) {
        document.getElementById("caseFeedback").innerHTML =
          `<p class="team-error">${escapeHtml(err.message)}</p>`;
      }
    });
  });
}

// -------------------------------------------------------------- Compare view

/** Longest-common-subsequence diff over step lines, so an inserted step shifts nothing after it. */
function diffSteps(a, b) {
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const left = [], right = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { left.push({ t: a[i], k: "same" }); right.push({ t: b[j], k: "same" }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { left.push({ t: a[i], k: "removed" }); i++; }
    else { right.push({ t: b[j], k: "added" }); j++; }
  }
  while (i < n) left.push({ t: a[i++], k: "removed" });
  while (j < m) right.push({ t: b[j++], k: "added" });
  return { left, right };
}

async function renderCompareView(caseId, fromV, toV) {
  const body = document.getElementById("compareViewBody");
  body.innerHTML = `<div class="tree-empty" style="padding:36px 16px;text-align:center">Loading…</div>`;

  let c, A, B;
  try {
    c = await api(`/api/cases/${encodeURIComponent(caseId)}`);
    const from = Number(fromV) || 1;
    const to = Number(toV) || c.currentVersion;
    [A, B] = await Promise.all([
      api(`/api/cases/${encodeURIComponent(caseId)}/versions/${from}`),
      api(`/api/cases/${encodeURIComponent(caseId)}/versions/${to}`),
    ]);
  } catch (err) {
    body.innerHTML = `<div class="tree-empty" style="padding:36px 16px;text-align:center">${escapeHtml(err.message)}</div>`;
    return;
  }

  setCrumbs(["Compare", c.title]);
  const aLines = A.ir.steps.map((s, i) => stepText(s, i).replace(/^\d+\.\s*/, ""));
  const bLines = B.ir.steps.map((s, i) => stepText(s, i).replace(/^\d+\.\s*/, ""));
  const { left, right } = diffSteps(aLines, bLines);
  const added = right.filter((r) => r.k === "added").length;
  const removed = left.filter((r) => r.k === "removed").length;

  const col = (label, note, side) => `
    <div class="cmp-col">
      <div class="cmp-col-head">
        <span class="case-badge badge-pending">v${label}</span>
        <span class="hrow-meta">${escapeHtml(note || "")}</span>
      </div>
      <div class="cmp-steps">
        ${side.map((s) => `<div class="cmp-step cmp-${s.k}">${escapeHtml(s.t)}</div>`).join("")}
      </div>
    </div>`;

  body.innerHTML = `
    <div>
      <div class="eyebrow">COMPARE VERSIONS</div>
      <h1 class="page-head-title">${escapeHtml(c.title)}</h1>
      <p class="tagline">${added} step${added === 1 ? "" : "s"} added, ${removed} removed
      between v${A.version} and v${B.version}.</p>
    </div>
    <div class="lib-toolbar">
      <button type="button" class="dl-btn-inline" data-act="back">Back to case</button>
    </div>
    <div class="cmp-grid">
      ${col(A.version, A.changeNote, left)}
      ${col(B.version, B.changeNote, right)}
    </div>`;

  body.querySelector('[data-act="back"]').addEventListener("click", () =>
    navigate("#/case/" + encodeURIComponent(caseId)));
}

const VIEWS = ["home", "run", "suite", "case", "compare", "history", "login", "signup", "team"];
let currentView = "home";

/**
 * The ONLY thing that switches screens.
 *
 * The pre-router code hid panels from three separate places and already leaked
 * because of it (preview.js's play() forgot hideCaseSelectionPanel, so switching
 * scenes left that panel open). With six screens that failure mode multiplies,
 * so every hide lives here and nowhere else.
 */
function showView(name) {
  if (!VIEWS.includes(name)) name = "home";
  currentView = name;
  document.querySelectorAll(".view").forEach((v) => {
    v.classList.toggle("view-active", v.dataset.view === name);
  });
  closeSidebarDrawer();
  window.scrollTo(0, 0);
}

/** Clears every run-scoped panel. Called on a new run, on switching runs, and
 *  by preview.js between scenes — one function, so a new panel is registered
 *  once instead of in three places that can drift apart. */
function resetRunUI() {
  renderPhases();
  hideSingleTestResult();
  hideSuiteResults();
  hideSuiteProgress();
  hideCredentialPrompt();
  hideCaseSelectionPanel();
  diagnosisEl.textContent = "";
  runTitleEl.textContent = "";
  runMetaEl.textContent = "";
}

function setCrumbs(parts) {
  const tail = parts
    .map((p) => `<span class="crumb-sep">/</span><span class="crumb-current">${escapeHtml(p)}</span>`)
    .join("");
  crumbsEl.innerHTML =
    `<button type="button" class="crumb crumb-root" id="crumbRoot">Testbench</button>${tail}`;
  crumbsEl.querySelector("#crumbRoot").addEventListener("click", () => navigate("#/"));
}

function navigate(hash) {
  if (location.hash === hash) applyRoute();
  else location.hash = hash;
}

// Where we were before the current hash change, so an unsaved edit can put it back.
let lastHash = location.hash;
let restoringHash = false;

/** The browser's own guard, for reload / close / an external link — the in-app one below cannot
 *  see those. The message is the browser's; the string only marks the event as blocking. */
window.addEventListener("beforeunload", (e) => {
  if (!caseEditorDirty()) return;
  e.preventDefault();
  e.returnValue = "";
});

/** Hash routing: no server routes needed, and express.static already 404s
 *  anything it doesn't recognise, so a deep link can't hit the backend. */
function applyRoute() {
  const raw = (location.hash || "#/").replace(/^#\/?/, "");
  const [head, id] = raw.split("/");

  // Unsaved step edits. Leaving the case they belong to would discard them with no warning, and
  // the back button reaches here too — so the check lives in the router rather than on each link.
  if (restoringHash) { restoringHash = false; lastHash = location.hash; return; }
  const stayingOnCase = head === "case" && id && id.split("?")[0] === caseEditor?.caseId;
  if (caseEditorDirty() && !stayingOnCase) {
    if (!confirm("You have unsaved step changes. Leave and discard them?")) {
      // Guarded: if the hash is somehow already correct this would never fire hashchange, and
      // the flag would poison the next navigation instead.
      if (location.hash !== lastHash) { restoringHash = true; location.hash = lastHash; }
      return;
    }
    caseEditor = null;
  }
  lastHash = location.hash;

  // Auth gate (Step 2.2). `auth.required` is only ever true when the server reported
  // authEnabled:true, so with auth off this whole branch is dead code and routing behaves
  // exactly as it always has. Routed through showView() like everything else — never by
  // toggling .hidden, which is the bug showView()'s own comment documents.
  if (auth.required && !auth.token) {
    const wantsSignup = auth.screen === "signup";
    showView(wantsSignup ? "signup" : "login");
    setCrumbs([wantsSignup ? "Sign up" : "Sign in"]);
    return;
  }

  if (head === "run" && id) {
    showView("run");
    setCrumbs(["Run"]);
    if (id !== currentRunId) connectToRun(id);
    return;
  }
  if (head === "history") {
    showView("history");
    setCrumbs(["History"]);
    renderHistoryView();
    return;
  }
  if (head === "team") {
    showView("team");
    setCrumbs(["Team"]);
    renderTeamView();
    return;
  }
  // The library (Steps 5.2/5.3/5.5). These were empty stubs from the first slice; they render
  // real data now. Each render sets its own crumbs once it knows the suite/case name, so the
  // placeholder here is only what shows while the fetch is in flight.
  //
  // `id` is split off the hash above, so a query string rides along on it — strip it before use
  // and read the version pair from it for Compare.
  if (head === "suite" && id) {
    showView("suite");
    setCrumbs(["Suite"]);
    renderSuiteView(id.split("?")[0]);
    return;
  }
  if (head === "case" && id) {
    showView("case");
    setCrumbs(["Case"]);
    renderCaseView(id.split("?")[0]);
    return;
  }
  if (head === "compare" && id) {
    showView("compare");
    setCrumbs(["Compare"]);
    const [bare, query] = id.split("?");
    const params = new URLSearchParams(query ?? "");
    renderCompareView(bare, params.get("from"), params.get("to"));
    return;
  }

  showView("home");
  setCrumbs([]);
}

window.addEventListener("hashchange", applyRoute);

// -----------------------------------------------------------------------------
// Sidebar drawer (narrow viewports only)
// -----------------------------------------------------------------------------

function openSidebarDrawer() {
  sidebarEl.classList.add("open");
  scrimEl.classList.remove("hidden");
}
function closeSidebarDrawer() {
  sidebarEl.classList.remove("open");
  scrimEl.classList.add("hidden");
}
sidebarOpenEl.addEventListener("click", openSidebarDrawer);
sidebarCloseEl.addEventListener("click", closeSidebarDrawer);
scrimEl.addEventListener("click", closeSidebarDrawer);

// -----------------------------------------------------------------------------
// Run options — the Settings popover
//
// These are per-run request options, not persisted server settings. The server
// reads ENABLE_CASE_SELECTION_GATE from its own env; sending an override with a
// run is what lets the popover mean anything without a settings backend.
// -----------------------------------------------------------------------------

// Only keys the user actually toggled are sent. An untouched popover therefore
// leaves the server on its own env-configured default rather than the client
// silently overriding it with a hardcoded guess.
const runOptions = {};
const optionDefaults = { gateReview: false, selfHeal: true };

function paintToggle(el, on) { el.setAttribute("aria-pressed", String(on)); }

function bindToggle(el, key) {
  paintToggle(el, optionDefaults[key]);
  el.addEventListener("click", () => {
    const next = !(key in runOptions ? runOptions[key] : optionDefaults[key]);
    runOptions[key] = next;
    paintToggle(el, next);
  });
}
bindToggle(gateToggleEl, "gateReview");
bindToggle(healToggleEl, "selfHeal");

fetch("/api/health")
  .then((r) => r.json())
  .then((h) => {
    if (!h || !h.defaults) return;
    Object.assign(optionDefaults, h.defaults);
    if (!("gateReview" in runOptions)) paintToggle(gateToggleEl, optionDefaults.gateReview);
    if (!("selfHeal" in runOptions)) paintToggle(healToggleEl, optionDefaults.selfHeal);
  })
  .catch(() => { /* health is a diagnostic; the toggles still work without it */ });

settingsBtnEl.addEventListener("click", () => {
  const open = settingsPopEl.classList.toggle("hidden");
  settingsBtnEl.setAttribute("aria-expanded", String(!open));
});
document.addEventListener("click", (e) => {
  if (settingsPopEl.classList.contains("hidden")) return;
  if (settingsPopEl.contains(e.target) || settingsBtnEl.contains(e.target)) return;
  settingsPopEl.classList.add("hidden");
  settingsBtnEl.setAttribute("aria-expanded", "false");
});

// -----------------------------------------------------------------------------
// Coverage segmented control
// -----------------------------------------------------------------------------

let coverage = "standard";
coverageSegEl.addEventListener("click", (e) => {
  const btn = e.target.closest(".seg-btn");
  if (!btn) return;
  coverage = btn.dataset.coverage;
  coverageSegEl.querySelectorAll(".seg-btn").forEach((b) => {
    b.classList.toggle("active", b === btn);
  });
});

// -----------------------------------------------------------------------------
// Sidebar Projects tree — real projects, from GET /api/projects.
//
// This used to group runs by URL client-side because no project entity existed.
// Step 5.1 made projects real rows, and the server now decides which ones you
// may see: admins and owners get every project in the organisation, everyone
// else only the ones they've been added to. So the list must come from the API —
// grouping locally would show a viewer projects the server would refuse to serve
// runs for.
//
// Run rows still come from allRunsCache (GET /api/runs), which is already scoped
// the same way, matched to their project by the same normalised URL key the
// backfill migration used. Depth is padding-left only via .tree-row.tree-*
// (style.css) — a collapsed project simply never emits its run rows, so this
// stays one flat array per that existing tree contract.
// -----------------------------------------------------------------------------

// Run-level status -> the .sdot modifier class (style.css). Run statuses that
// don't have their own dot color share the nearest semantic one: an infra
// "error" reads as blocked (couldn't complete), not failed (assertion broke).
const RUN_SDOT_CLASS = {
  passed: "passed",
  failed: "failed",
  incomplete: "unconfirmed",
  truncated_no_assertion: "unconfirmed",
  error: "blocked",
};

/** MUST match normaliseUrlKey() in src/server/projects.ts and the backfill migration's SQL —
 *  it's how a run row finds the project row it belongs under. */
function normalizeUrlKey(url) {
  return (url || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * Fetch the projects this account may see.
 *
 * Never throws. A FAILED load is not the same as "no projects": running with no database
 * configured at all is a supported mode (it is the default), and in it `/api/projects` can't
 * answer because project rows live in Postgres. Falling back to the pre-Step-5.1 behaviour —
 * grouping the run list by URL client-side — keeps that setup's sidebar exactly as it was
 * instead of emptying it.
 */
async function loadProjects() {
  try {
    const res = await fetch("/api/projects");
    const data = res.ok ? await res.json() : null;
    projectsCache = data && Array.isArray(data.projects) ? data.projects : null;
  } catch {
    projectsCache = null;
  }
  projectsUnavailable = projectsCache === null;

  // Suites are a separate call and a softer failure: without them the sidebar simply shows no
  // library, which is strictly better than showing no projects either.
  try {
    const res = await fetch("/api/suites");
    const data = res.ok ? await res.json() : null;
    suitesCache = data && Array.isArray(data.suites) ? data.suites : [];
  } catch {
    suitesCache = [];
  }

  renderProjectsTree(allRunsCache);
}

/** Runs sharing a normalised URL become one pseudo-project. The pre-Step-5.1 sidebar, kept as the
 *  fallback for the no-database case where real project rows are unreachable. */
function groupRunsByUrl(runs) {
  const groups = new Map();
  for (const r of runs || []) {
    const key = normalizeUrlKey(r.url) || "(no url)";
    if (!groups.has(key)) groups.set(key, { id: key, name: r.url || "(no url)", runCount: 0 });
    groups.get(key).runCount++;
  }
  return [...groups.values()];
}

function renderProjectsTree(runs) {
  if (!sidebarTreeEl) return;

  if (projectsCache === null && !projectsUnavailable) {
    sidebarTreeEl.innerHTML = `<div class="tree-empty">Loading projects…</div>`;
    return;
  }

  // No database configured: fall back to the client-side URL grouping this sidebar used before
  // projects were real rows, so that setup looks exactly as it did.
  const projects = projectsCache === null ? groupRunsByUrl(runs) : projectsCache;

  if (!projects.length) {
    // Two very different situations, and telling them apart matters: someone who just signed up
    // has been deliberately given no access yet and needs to know who to ask, whereas an admin
    // with an empty workspace just hasn't run anything. A bare "No projects yet" reads as a bug
    // to the first person.
    const needsAccess = auth.required && auth.role && !roleAtLeast(auth.role, "admin");
    sidebarTreeEl.innerHTML = needsAccess
      ? `<div class="tree-empty">You're not in any project yet. Ask an admin to add you to one.</div>`
      : `<div class="tree-empty">No projects yet. Runs you start will appear here.</div>`;
    return;
  }

  // Bucket the visible runs under their project by URL key.
  const byKey = new Map();
  for (const r of runs || []) {
    const key = normalizeUrlKey(r.url);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }

  sidebarTreeEl.innerHTML = projects.map((p) => {
    const open = expandedProjects.has(p.id);
    const projectRuns = byKey.get(normalizeUrlKey(p.name) || p.name) || [];
    // The server's count is authoritative — it covers every run in the project, while the
    // sidebar's own list is capped at the newest 20 from disk.
    const count = typeof p.runCount === "number" ? p.runCount : projectRuns.length;
    const projectRow = `
      <div class="tree-row tree-project" data-toggle-key="${escapeHtml(p.id)}">
        <span class="tree-chevron">${icon(open ? "chevron-down" : "chevron-right", { size: 9 })}</span>
        <span class="tree-label" title="${escapeHtml(p.baseUrl || p.name)}">${escapeHtml(p.name)}</span>
        <span class="tree-count">${count}</span>
      </div>`;
    // Saved suites first, then recent runs. The suites are the reusable, zero-cost thing — a
    // project's library is more useful to reach than its scrollback, so it sits above.
    const suiteRows = !open ? "" : (suitesCache
      .filter((s) => s.projectId === p.id)
      .map((s) => `
      <div class="tree-row tree-suite" data-suite-id="${escapeHtml(s.id)}">
        <span class="tree-label" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
        <span class="tree-count">${s.caseCount}</span>
      </div>`).join(""));

    // Creating a suite belongs where the suites already are — someone looking at a project's
    // suites and wanting another looks right here. Naming happens inline rather than through a
    // prompt() so the server's refusal (duplicate name, project you can't see) has somewhere to
    // land. `tester`+ only; the server enforces it regardless (POST /api/suites).
    const canAuthorSuites = !auth.required || roleAtLeast(auth.role, "tester");
    const newSuiteRow = !open || !canAuthorSuites ? "" : (newSuiteFor === p.id
      ? `<div class="tree-row tree-suite-new">
           <input type="text" class="suite-new-input" id="newSuiteInput"
                  placeholder="Suite name" value="${escapeHtml(newSuiteName)}"
                  aria-label="Name for the new suite" />
           <button type="button" class="dl-btn-inline" data-suite-create="${escapeHtml(p.id)}">Add</button>
           <button type="button" class="dl-btn-inline" data-suite-cancel="1" title="Cancel">×</button>
         </div>
         ${newSuiteError ? `<div class="suite-new-err">${escapeHtml(newSuiteError)}</div>` : ""}`
      : `<div class="tree-row tree-suite-add" data-suite-add="${escapeHtml(p.id)}">
           <span class="tree-label">+ New suite</span>
         </div>`);

    const caseRows = !open ? "" : (projectRuns.length
      ? projectRuns.map((r) => `
      <div class="tree-row tree-case${r.runId === currentRunId ? " active" : ""}" data-run-id="${escapeHtml(r.runId)}" data-prompt="${escapeHtml(r.prompt || "")}" data-url="${escapeHtml(r.url || "")}">
        <span class="sdot sdot-sm ${RUN_SDOT_CLASS[r.status] || "pending"}" title="${escapeHtml(STATUS_LABEL[r.status] ?? r.status)}"></span>
        <span class="tree-label" title="${escapeHtml(r.prompt || "")}">${escapeHtml(r.prompt || "(no prompt)")}</span>
      </div>`).join("")
      : `<div class="tree-empty" style="padding-left:40px">No recent runs.</div>`);
    return projectRow + suiteRows + newSuiteRow + caseRows;
  }).join("");

  sidebarTreeEl.querySelectorAll("[data-suite-add]").forEach((row) => {
    row.addEventListener("click", () => {
      newSuiteFor = row.dataset.suiteAdd;
      newSuiteName = "";
      newSuiteError = "";
      renderProjectsTree(allRunsCache);
      document.getElementById("newSuiteInput")?.focus();
    });
  });
  sidebarTreeEl.querySelectorAll("[data-suite-cancel]").forEach((btn) => {
    btn.addEventListener("click", () => {
      newSuiteFor = null; newSuiteName = ""; newSuiteError = "";
      renderProjectsTree(allRunsCache);
    });
  });

  const createSuite = async (projectId) => {
    const name = newSuiteName.trim();
    if (!name) { newSuiteError = "Give the suite a name."; return renderProjectsTree(allRunsCache); }
    try {
      const created = await api("/api/suites", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, name }),
      });
      newSuiteFor = null; newSuiteName = ""; newSuiteError = "";
      await loadProjects();                       // refresh suitesCache so the new row appears
      // Land in the new (empty) suite — adding cases is the obvious next step and it should be
      // in front of them rather than something they have to go find.
      navigate("#/suite/" + encodeURIComponent(created.id));
    } catch (err) {
      newSuiteError = err.message;
      renderProjectsTree(allRunsCache);
      document.getElementById("newSuiteInput")?.focus();
    }
  };

  const nameInput = document.getElementById("newSuiteInput");
  if (nameInput) {
    nameInput.addEventListener("input", () => { newSuiteName = nameInput.value; });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); createSuite(newSuiteFor); }
      if (e.key === "Escape") {
        newSuiteFor = null; newSuiteName = ""; newSuiteError = "";
        renderProjectsTree(allRunsCache);
      }
    });
  }
  sidebarTreeEl.querySelectorAll("[data-suite-create]").forEach((btn) => {
    btn.addEventListener("click", () => createSuite(btn.dataset.suiteCreate));
  });

  sidebarTreeEl.querySelectorAll("[data-toggle-key]").forEach((row) => {
    row.addEventListener("click", () => {
      const key = row.dataset.toggleKey;
      if (expandedProjects.has(key)) expandedProjects.delete(key);
      else expandedProjects.add(key);
      renderProjectsTree(allRunsCache);
    });
  });
  sidebarTreeEl.querySelectorAll(".tree-row.tree-suite").forEach((row) => {
    row.addEventListener("click", () => navigate("#/suite/" + encodeURIComponent(row.dataset.suiteId)));
  });
  sidebarTreeEl.querySelectorAll(".tree-row.tree-case").forEach((row) => {
    row.addEventListener("click", () => {
      if (row.dataset.prompt) promptEl.value = row.dataset.prompt;
      if (row.dataset.url) urlEl.value = row.dataset.url;
      navigate("#/run/" + row.dataset.runId);
    });
  });
}

renderProjectsTree(allRunsCache);

historyBtnEl.addEventListener("click", () => navigate("#/history"));
teamBtnEl.addEventListener("click", () => navigate("#/team"));
allRunsBtnEl.addEventListener("click", () => navigate("#/history"));

// -----------------------------------------------------------------------------
// History screen — the full-page list, distinct from the sidebar's recent list.
//
// listRuns() on the server is hard-capped at the newest 20 run directories and
// has no paging, so the heading says 20 rather than claiming "every run".
// -----------------------------------------------------------------------------

async function renderHistoryView() {
  const body = document.getElementById("historyViewBody");
  body.innerHTML = `
    <div>
      <div class="eyebrow">RESULTS HISTORY</div>
      <h1 class="page-head-title">Your 20 most recent runs</h1>
    </div>
    <div class="panel"><div id="historyRows"></div></div>`;

  // Same guard as loadHistory(): a 401 resolves successfully with an `{error}` object, so
  // .catch() alone isn't enough to guarantee an array here.
  const raw = await fetch("/api/runs").then((r) => r.json()).catch(() => []);
  const runs = Array.isArray(raw) ? raw : [];
  const rows = document.getElementById("historyRows");
  if (!runs.length) {
    rows.innerHTML = `<div class="tree-empty" style="padding:36px 16px;text-align:center">No runs recorded yet.</div>`;
    return;
  }

  rows.innerHTML = runs.map((r) => {
    const st = statusKey(r.status);
    const suite = r.suite ? `${r.suite.passed}/${r.suite.total} passed` : "";
    const when = r.startedAt ? new Date(r.startedAt).toLocaleString() : "";
    return `
    <div class="hrow" data-run-id="${escapeHtml(r.runId)}">
      <span class="case-badge badge-${escapeHtml(st)}">${escapeHtml(statusText(r.status))}</span>
      <div class="hrow-main">
        <div class="hrow-label">${escapeHtml(r.prompt || "(no prompt)")}</div>
        <div class="hrow-meta">${escapeHtml([suite, when, r.url].filter(Boolean).join(" · "))}</div>
      </div>
      <div class="hrow-actions">
        <button type="button" class="dl-btn-inline" data-act="view">View</button>
        <button type="button" class="dl-btn-inline" data-act="rerun">Re-run</button>
        <button type="button" class="dl-btn-inline hrow-del" data-act="delete">Delete</button>
      </div>
    </div>`;
  }).join("");

  rows.querySelectorAll(".hrow").forEach((row) => {
    const runId = row.dataset.runId;
    row.querySelectorAll("[data-act]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === "view") return navigate("#/run/" + runId);
        if (act === "rerun") {
          const src = runs.find((r) => r.runId === runId);
          if (!src) return;
          promptEl.value = src.prompt || "";
          urlEl.value = src.url || "";
          navigate("#/");
          toast("Loaded that run into the composer — press Run test to go again");
          return;
        }
        if (!confirm("Delete this run permanently?")) return;
        await fetch(`/api/runs/${runId}`, { method: "DELETE" }).catch(() => {});
        renderHistoryView();
        loadHistory();
        toast("Run deleted");
      });
    });
  });
}

// -----------------------------------------------------------------------------
// Team screen — the members of your organisation, and the controls to manage them.
//
// This is the UI for routes that already existed and were already enforced
// (/api/organisations/:orgId/members, Step 3.4). It adds no permission of its own: every
// button here maps to a call the server independently authorises, and the two guard rails
// that matter — nobody grants above themselves, an org always keeps one owner — live in
// src/server/organisations.ts and are surfaced here by rendering the server's own message.
//
// Hiding a control is a courtesy so a tester isn't offered a button that would only 403.
// It is NOT the control. Tampering with auth.role in devtools changes what is drawn and
// nothing else.
// -----------------------------------------------------------------------------

/** Role descriptions, kept next to the picker so an admin assigning one can see what it means. */
const ROLE_HELP = {
  viewer: "Read-only — can see runs and results, cannot start or delete them.",
  tester: "Runs tests — talks to the AI, answers login prompts, picks cases. Cannot delete.",
  admin: "Manages people and can delete runs.",
  owner: "Full control of the organisation.",
};

/** Lowest to highest — the same order as ROLES in src/server/authz.ts. */
const ROLES_ASC = ["viewer", "tester", "admin", "owner"];

function teamRoleOptions(selected, maxRole) {
  // Never offer a role the server would refuse to grant — the ladder is mirrored from
  // src/server/authz.ts, and offering `owner` to an admin only produces a 403 they can't act on.
  return ROLES_ASC
    .filter((r) => roleAtLeast(maxRole, r))
    .map((r) => `<option value="${r}"${r === selected ? " selected" : ""}>${r}</option>`)
    .join("");
}

async function renderTeamView() {
  const body = document.getElementById("teamViewBody");
  const orgId = auth.organisationId;

  body.innerHTML = `
    <div>
      <div class="eyebrow">TEAM</div>
      <h1 class="page-head-title">Who can use this workspace</h1>
      <p class="tagline">Roles decide what each person may do. Every role is enforced on the
      server — hiding a button here is only a convenience.</p>
    </div>
    <div id="teamFeedback"></div>
    <div id="teamAddWrap"></div>
    <div class="panel"><div id="teamRows"></div></div>`;

  const rows = document.getElementById("teamRows");

  if (!orgId) {
    rows.innerHTML = `<div class="tree-empty" style="padding:36px 16px;text-align:center">
      Sign in to see your organisation's members.</div>`;
    return;
  }

  const isAdmin = roleAtLeast(auth.role, "admin");

  // Add-member form, admins and owners only. The server refuses POST from anyone lower, so
  // this is purely about not offering a dead control.
  if (isAdmin) {
    document.getElementById("teamAddWrap").innerHTML = `
      <div class="team-add">
        <label class="field">
          <span class="field-label">Email of an existing account</span>
          <input id="teamAddEmail" type="email" placeholder="someone@example.com"
            autocomplete="off" spellcheck="false" list="teamAddSuggestions" />
          <!-- Suggestions are filled in below, after the list of addable accounts loads. A
               datalist is used deliberately: it needs no CSS, no keyboard handling and no new
               class names, and the field stays plain free text if the list never arrives. -->
          <datalist id="teamAddSuggestions"></datalist>
        </label>
        <label class="field" style="flex:0 0 150px">
          <span class="field-label">Role</span>
          <select id="teamAddRole" class="team-select">
            ${teamRoleOptions("tester", auth.role)}
          </select>
        </label>
        <div class="team-add-actions">
          <button type="button" id="teamAddBtn" class="dl-btn-inline">Add to team</button>
        </div>
      </div>`;

    document.getElementById("teamAddBtn").addEventListener("click", async () => {
      const email = document.getElementById("teamAddEmail").value.trim();
      const role = document.getElementById("teamAddRole").value;
      if (!email) return teamFeedback("Enter the email address of an existing account.", true);
      await teamCall(
        `/api/organisations/${encodeURIComponent(orgId)}/members`,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, role }) },
        `${email} added as ${role}.`,
      );
    });

    // Populate the suggestions without blocking the roster render below. A failure here is
    // silent by design — the field still works as free text, which is exactly what it did before.
    fetch(`/api/organisations/${encodeURIComponent(orgId)}/addable-users`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const list = document.getElementById("teamAddSuggestions");
        if (!list || !data || !Array.isArray(data.emails)) return;
        list.innerHTML = data.emails
          .map((e) => `<option value="${escapeHtml(e)}"></option>`)
          .join("");
      })
      .catch(() => { /* suggestions are a convenience, never a requirement */ });
  }

  rows.innerHTML = `<div class="tree-empty" style="padding:24px 16px;text-align:center">Loading…</div>`;

  const res = await fetch(`/api/organisations/${encodeURIComponent(orgId)}/members`)
    .then((r) => r.json())
    .catch(() => null);
  const members = res && Array.isArray(res.members) ? res.members : [];

  // Project assignments — what each person may SEE, the second axis alongside their role.
  // Admin-only endpoints, so only fetched when we're an admin; a non-admin's Team screen is
  // read-only anyway.
  let assignments = {};
  let allProjects = [];
  if (isAdmin) {
    const [aRes, pRes] = await Promise.all([
      fetch(`/api/organisations/${encodeURIComponent(orgId)}/assignments`)
        .then((r) => (r.ok ? r.json() : null)).catch(() => null),
      fetch("/api/projects").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    assignments = (aRes && aRes.assignments) || {};
    allProjects = (pRes && Array.isArray(pRes.projects)) ? pRes.projects : [];
  }
  const projectName = new Map(allProjects.map((p) => [p.id, p.name]));

  if (!members.length) {
    rows.innerHTML = `<div class="tree-empty" style="padding:36px 16px;text-align:center">
      ${escapeHtml((res && res.error) || "No members found.")}</div>`;
    return;
  }

  const ownerCount = members.filter((m) => m.role === "owner").length;

  rows.innerHTML = members.map((m) => {
    const isYou = m.userId === auth.userId;
    // Mirrors the server's rules so the UI doesn't offer something guaranteed to 403:
    //  - you cannot act on someone whose role outranks yours
    //  - the last owner can be neither demoted nor removed
    const outranksYou = !roleAtLeast(auth.role, m.role);
    const lastOwner = m.role === "owner" && ownerCount <= 1;
    const canEdit = isAdmin && !outranksYou && !lastOwner;

    const roleControl = canEdit
      ? `<select class="team-select" data-role-for="${escapeHtml(m.userId)}">
           ${teamRoleOptions(m.role, auth.role)}
         </select>`
      : `<span class="team-role-static" title="${escapeHtml(
            lastOwner ? "The last owner cannot be changed" :
            outranksYou ? "This member outranks you" : ROLE_HELP[m.role] || "")}">${escapeHtml(m.role)}</span>`;

    const removeBtn = canEdit
      ? `<button type="button" class="dl-btn-inline hrow-del" data-remove="${escapeHtml(m.userId)}">Remove</button>`
      : "";

    // Which projects this person may see. Admins and owners see everything by role, so listing
    // projects for them would be a lie the moment a new one is created — say the rule instead.
    const seesEverything = roleAtLeast(m.role, "admin");
    const mine = assignments[m.userId] || [];
    const projectsCell = !isAdmin ? "" : seesEverything
      ? `<div class="team-projects"><span class="team-projects-all">Sees every project (by role)</span></div>`
      : `<div class="team-projects">
          ${mine.length
            ? mine.map((pid) => `
              <span class="team-chip">${escapeHtml(projectName.get(pid) || "project")}
                <button type="button" class="team-chip-x" data-unassign="${escapeHtml(m.userId)}"
                  data-project="${escapeHtml(pid)}" title="Remove from this project">&times;</button>
              </span>`).join("")
            : `<span class="team-projects-none">No projects yet — they can't see anything.</span>`}
          ${allProjects.length > mine.length ? `
          <select class="team-select team-assign" data-assign="${escapeHtml(m.userId)}">
            <option value="">+ Add to project…</option>
            ${allProjects.filter((p) => !mine.includes(p.id))
              .map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")}
          </select>` : ""}
        </div>`;

    return `
    <div class="team-row">
      <div class="team-row-main">
        <span class="team-email">${escapeHtml(m.email || "(unknown address)")}${
          isYou ? `<span class="team-you">YOU</span>` : ""}</span>
        <span class="team-meta">${escapeHtml(ROLE_HELP[m.role] || "")}</span>
        ${projectsCell}
      </div>
      <div class="team-row-actions">${roleControl}${removeBtn}</div>
    </div>`;
  }).join("");

  // Project assignment — add and remove. Both are admin-only on the server too.
  rows.querySelectorAll("[data-assign]").forEach((sel) => {
    sel.addEventListener("change", async () => {
      if (!sel.value) return;
      await teamCall(
        `/api/projects/${encodeURIComponent(sel.value)}/members`,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userId: sel.dataset.assign }) },
        "Added to the project.",
      );
    });
  });

  rows.querySelectorAll("[data-unassign]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      await teamCall(
        `/api/projects/${encodeURIComponent(btn.dataset.project)}/members/${encodeURIComponent(btn.dataset.unassign)}`,
        { method: "DELETE" },
        "Removed from the project.",
      );
    });
  });

  rows.querySelectorAll("[data-role-for]").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const userId = sel.dataset.roleFor;
      await teamCall(
        `/api/organisations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
        { method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ role: sel.value }) },
        `Role changed to ${sel.value}.`,
      );
    });
  });

  rows.querySelectorAll("[data-remove]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const userId = btn.dataset.remove;
      if (!confirm("Remove this person from the organisation?")) return;
      await teamCall(
        `/api/organisations/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
        { method: "DELETE" },
        "Member removed.",
      );
    });
  });
}

function teamFeedback(message, isError) {
  const el = document.getElementById("teamFeedback");
  if (!el) return;
  el.innerHTML = `<p class="${isError ? "team-error" : "team-ok"}" role="${
    isError ? "alert" : "status"}">${escapeHtml(message)}</p>`;
}

/**
 * One place every member mutation goes through, so the guard rails always surface.
 *
 * A 403 ("you cannot grant the owner role — it is above your own") and a 409 ("this is the last
 * owner") are the two sentences that explain the whole permission model, and swallowing them
 * would make a refused action look like a broken button. The server's own message is rendered
 * verbatim rather than being restated here, so the two can never drift apart.
 */
async function teamCall(url, init, successMessage) {
  try {
    const res = await fetch(url, init);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `That didn't work (${res.status}).`);
    }
    // Order matters: renderTeamView() rebuilds the whole view body, #teamFeedback included, so
    // writing the message first means the re-render silently eats it. The error path below is
    // unaffected — it throws past the re-render — which is exactly why this was invisible until
    // a successful add was tried in a browser.
    await renderTeamView();
    teamFeedback(successMessage, false);
    // Our own role may have just changed (an owner promoting someone, or leaving), and the
    // topbar badge plus the restriction classes are derived from it.
    await refreshIdentity();
  } catch (err) {
    teamFeedback(err.message || "That didn't work.", true);
  }
}

let currentRunId = null;
applyRoute();

// Async, and deliberately AFTER the synchronous applyRoute() above: with auth off this resolves
// to a no-op, so the first paint is unchanged. With auth on it re-routes to the login view.
initAuth();
