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
const urlSchemeEl = document.getElementById("urlScheme");
const urlErrorEl = document.getElementById("urlError");

// -----------------------------------------------------------------------------
// URL field: scheme lives beside the input, never inside its value
// -----------------------------------------------------------------------------

/** True once the person has chosen a scheme themselves, so nothing auto-overrides it after. */
let urlSchemeChosen = false;
/** True only while a submit is in flight — read by refreshNewRunState(). Declared here, not
 *  beside currentRunId at the bottom of this file, because init-time calls run earlier and a
 *  `let` read before its declaration is a TDZ ReferenceError, not undefined. */
let runInFlight = false;

const urlScheme = () => (urlSchemeEl.textContent.trim() === "http://" ? "http://" : "https://");
function setUrlScheme(scheme, byUser) {
  urlSchemeEl.textContent = scheme;
  if (byUser) urlSchemeChosen = true;
}

/** Host+path only: no scheme, no surrounding whitespace, no leading slashes. */
function stripScheme(raw) {
  return String(raw ?? "").trim().replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/^\/+/, "");
}

/** localhost and 127.0.0.1 do not serve https — default the prefix, unless the user chose one. */
function autoSchemeFor(value) {
  if (urlSchemeChosen) return null;
  return /^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(value) ? "http://" : null;
}

/**
 * Normalise what is in the field, flipping the prefix when a pasted URL carried its own scheme,
 * and keeping the caret where the person left it.
 *
 * The caret is preserved by applying the SAME transform to the text before the caret and using
 * its length — which is correct however many characters the strip removed, and needs no counting.
 */
function normalizeUrlField(preserveCaret) {
  const before = urlEl.value;
  const pasted = before.match(/^\s*([a-z][a-z0-9+.-]*):\/\//i);
  if (pasted) {
    const scheme = pasted[1].toLowerCase();
    // An explicit scheme in what they typed or pasted wins, and counts as their choice.
    if (scheme === "http" || scheme === "https") setUrlScheme(scheme + "://", true);
  }

  const after = stripScheme(before);
  if (after !== before) {
    const caret = urlEl.selectionStart ?? before.length;
    const headAfter = stripScheme(before.slice(0, caret));
    urlEl.value = after;
    if (preserveCaret && document.activeElement === urlEl) {
      const pos = Math.min(headAfter.length, after.length);
      urlEl.setSelectionRange(pos, pos);
    }
  }

  const auto = autoSchemeFor(urlEl.value);
  if (auto) setUrlScheme(auto, false);
}

/** Put a possibly-absolute URL into the field, splitting the scheme out to the prefix. */
function setUrlFieldValue(raw) {
  urlEl.value = String(raw ?? "");
  normalizeUrlField(false);
  clearUrlError();
  refreshComposerState();
}

/** The absolute URL the pipeline receives — unchanged contract, just assembled here. */
function absoluteUrl() {
  return urlScheme() + stripScheme(urlEl.value);
}

// ---- validation: on blur and submit only, never while typing --------------------

function clearUrlError() {
  urlErrorEl.textContent = "";
  urlErrorEl.classList.add("hidden");
  urlEl.removeAttribute("aria-invalid");
}

function showUrlError(msg) {
  urlErrorEl.textContent = msg;
  urlErrorEl.classList.remove("hidden");
  urlEl.setAttribute("aria-invalid", "true");
}

/**
 * What is wrong with the URL, in words the person can act on — or "" when it is fine.
 *
 * Deliberately specific: "Invalid URL" tells someone nothing about which of the several possible
 * mistakes they made, so each case names the problem and the fix.
 */
function urlProblem() {
  const value = stripScheme(urlEl.value);
  if (!value) return "Enter the address of the page to test — for example example.com/cart.";

  const host = value.split(/[/?#]/)[0];
  if (!host) return "That looks like a path with no site — add the domain, like example.com/cart.";

  const bare = host.replace(/:\d+$/, "");
  const isLocal = /^(localhost|127\.0\.0\.1)$/i.test(bare);
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(bare);
  if (isLocal || isIp) return "";

  if (!bare.includes(".")) {
    return `"${host}" is missing a domain ending — did you mean ${bare}.com?`;
  }
  if (!/^[a-z0-9.-]+$/i.test(bare) || /^[.-]|[.-]$|\.\./.test(bare)) {
    return `"${host}" is not a valid domain — use something like example.com.`;
  }
  const tld = bare.split(".").pop();
  if (!/^[a-z]{2,}$/i.test(tld)) {
    return `"${host}" does not end in a valid domain — did you mean ${bare.split(".").slice(0, -1).join(".")}.com?`;
  }
  return "";
}

/**
 * "New run" is pointless when the workspace is already new — disable it then.
 *
 * Derived from state the page already keeps (CLAUDE.md: no new store): no run being viewed, no
 * run in flight, and both composer fields empty. `runInFlight` is read off the submit button's
 * own disabled-while-running state rather than a new flag.
 */
function refreshNewRunState() {
  const btn = document.getElementById("newRunBtn");
  if (!btn) return;
  const fresh =
    !currentRunId &&
    !runInFlight &&
    promptEl.value.trim() === "" &&
    urlEl.value.trim() === "";
  // Only a real <button> has a meaningful .disabled; guard so this stays a no-op elsewhere.
  if (typeof btn.disabled === "boolean") btn.disabled = fresh;
  btn.setAttribute("aria-disabled", fresh ? "true" : "false");
  btn.title = fresh ? "You're already on a new chat" : "Start a new run";
}

/** Run test stays disabled until there is both a description and a URL. */
function refreshComposerState() {
  const ready = promptEl.value.trim().length > 0 && urlEl.value.trim().length > 0;
  submitBtn.disabled = !ready;
  refreshNewRunState();
}
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
const caseWriteOwnBtnEl = document.getElementById("case-write-own-btn");
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
      refreshComposerState();
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
        ? data.deterministicHeal
          ? "An element had moved on the page — the test matched it against the crawled model (no model call) and carried on"
          : "An element had moved on the page — the test found it again and carried on"
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
    ${currentRunPrompt ? `<p class="case-narrative-line"><b>You asked:</b> ${escapeHtml(currentRunPrompt)}</p>` : ""}
    <div class="suite-summary-stats">
      <span class="suite-stat">${suite.total} checks</span>
      <span class="suite-stat suite-stat-passed">${icon("check", { size: 13 })} ${suite.passed} passed</span>
      <span class="suite-stat suite-stat-failed">${icon("x", { size: 13 })} ${suite.failed} failed</span>
      ${suite.truncated ? `<span class="suite-stat suite-stat-truncated">${icon("alert-triangle", { size: 13 })} ${suite.truncated} partial</span>` : ""}
      ${suite.truncated_no_assertion ? `<span class="suite-stat suite-stat-partial">${icon("minus-circle", { size: 13 })} ${suite.truncated_no_assertion} unconfirmed</span>` : ""}
      ${suite.blocked ? `<span class="suite-stat suite-stat-blocked">${icon("slash-circle", { size: 13 })} ${suite.blocked} blocked</span>` : ""}
    </div>
    ${renderUsageLine()}`;
}

/**
 * What this run cost, from the terminal event's `llmUsage`.
 *
 * A replay is called out explicitly rather than shown as "0 tokens": re-running a saved case for
 * no model spend at all is the reason the library exists, and a bare zero reads like missing data.
 *
 * Reuses `.hrow-meta`, the existing muted-metadata class — no new class name (rule 3).
 */
function renderUsageLine() {
  if (currentRunIsReplay) {
    return `<div class="hrow-meta">Replayed from saved steps &mdash; <b>0 AI calls</b>, no tokens spent.</div>`;
  }
  const u = currentRunUsage;
  if (!u || !u.calls) return "";

  const stages = Object.entries(u.byStage ?? {})
    .sort((a, b) => (b[1].totalTokens ?? 0) - (a[1].totalTokens ?? 0));
  const top = stages[0];
  const topPart = top
    ? ` &middot; most of it in <b>${escapeHtml(top[0])}</b> (${top[1].calls} call${top[1].calls === 1 ? "" : "s"}, ${fmtTokens(top[1].totalTokens ?? 0)})`
    : "";
  const cap = u.exhausted ? " &middot; <b>budget exhausted</b>" : "";
  // A self-heal is a second full test run AND a full IR regeneration, so it is a real part of
  // what a run cost — but it is invisible in `byStage`, which folds the heal's IR call into the
  // ordinary `ir` total. Counted separately from the suite events. TD-83.
  const healCount = currentRunPrimaryHeals + currentRunSuiteHeals;
  const heals = healCount > 0
    ? ` &middot; <b>${healCount} self-heal retr${healCount === 1 ? "y" : "ies"}</b>`
    : "";
  return `<div class="hrow-meta">${u.calls} AI call${u.calls === 1 ? "" : "s"} &middot; ${fmtTokens(u.totalTokens ?? 0)} tokens${heals}${topPart}${cap}</div>`;
}

/** 1234 -> "1.2k". Token counts are for a sense of scale, not accounting. */
function fmtTokens(n) {
  if (!Number.isFinite(n)) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
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
        ${c.healed && c.status === "passed" ? `<span class="case-badge case-badge-healed" title="This failed on the first attempt; the system automatically found a fix and re-ran it, and it passed.${c.deterministicHeal ? " This fix was found deterministically, without a model call." : ""}">${icon("refresh", { size: 11 })} Fixed automatically${c.deterministicHeal ? ` ${icon("zap", { size: 10 })}` : ""}</span>` : ""}
        ${c.deterministicHeal ? `<span class="case-badge case-badge-deterministic" title="The fix was found by matching the element's structure in the crawled page model — no model call, essentially free.">${icon("zap", { size: 10 })} Healed deterministically</span>` : ""}
        <span class="case-expand-icon">${icon("chevron-down", { size: 14 })}</span>
      </div>
      <div class="case-card-body">
        ${c.blockedBy ? `<p class="blocked-note">Couldn't finish: ${escapeHtml(c.blockedBy)}. The screenshot below is where it stopped.</p>` : ""}
        ${renderCaseErrorBlock(c, screenshotUrl)}
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
        `<p class="team-ok">Saved. <a href="${caseHash(projectSel.value, saved.id)}">Open the case</a></p>`;
    } catch (err) {
      panel.querySelector('[data-role="feedback"]').innerHTML =
        `<p class="team-error">${escapeHtml(err.message)}</p>`;
      btn.disabled = false;
    }
  });
}

/**
 * The natural-language request that produced the run currently on screen.
 *
 * NOT fetched: it already arrives on the run's own event stream. The `input` event carries
 * `{ prompt, url, urls, coverage }` — the same field `summariseRun` reads to build a RunSummary —
 * and `applyEvent` sees every event, replayed ones included, so this survives a page reload with
 * no request and no route change.
 */
let currentRunPrompt = "";

/**
 * The run's LLM spend, from the terminal event's `llmUsage`. Already on `/state` for both a normal
 * run and a replay (which sends explicit zeroes), so this needs no request and no new route.
 * Cleared with the rest of the run-scoped state in hideSuiteResults.
 */
let currentRunUsage = null;
let currentRunIsReplay = false;
/**
 * Self-heal retries observed in THIS run. Counted from the events rather than read from
 * 08-llm-usage.json, which records tokens by stage and has no notion of a retry — the heal's IR
 * regeneration is folded into the `ir` stage total. TD-83.
 *
 * TWO counters, because the two heal paths report differently and mixing them double-counts. The
 * primary case heals under its own "heal" StageName and emits once per attempt (relative, so
 * increment). Suite cases carry `healsUsedInRun`, which is already a running total (absolute, so
 * take the max). The primary case is reused by the suite rather than re-healed, so the two never
 * describe the same retry and summing them is correct.
 */
let currentRunPrimaryHeals = 0;
let currentRunSuiteHeals = 0;

function hideSuiteResults() {
  currentRunPrompt = "";
  currentRunUsage = null;
  currentRunIsReplay = false;
  currentRunPrimaryHeals = 0;
  currentRunSuiteHeals = 0;
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
             detail: data?.deterministicHeal
               ? "One element had moved on the page — the test matched it against the crawled model deterministically (no model call) and carried on."
               : "One element had moved on the page — the test found it again and carried on." };
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

/**
 * What a failed case says for itself, with no model call.
 *
 * A replay makes zero LLM calls by design, so `renderCaseDiagnosisBlock` below has nothing to
 * render — and the card showed a red X and no text at all. The failing step and the Playwright
 * error were sitting in `05-result.json` unread the whole time. This is the floor every failed
 * case gets, whatever the run type; a diagnosis, when one exists, renders BELOW it rather than
 * instead of it. TECH_DEBT.md TD-80.
 *
 * Rendered straight from the summary, so it appears with the card instead of waiting on the
 * per-case fetch the diagnosis block needs. Every class here already exists (rule 3).
 */
/**
 * The one-line retry note on a suite progress row.
 *
 * `.hrow-meta` is the existing muted-metadata class this file already uses for the cost line —
 * no new CSS class (rule 3). Passing `null` removes the note, so a row that is reused for a
 * later case cannot inherit a stale one.
 */
function setSuiteRetryNote(item, text) {
  let note = item.querySelector(".hrow-meta");
  if (text === null) { if (note) note.remove(); return; }
  if (!note) {
    note = document.createElement("span");
    note.className = "hrow-meta";
    item.appendChild(note);
  }
  note.textContent = text;
}

function renderCaseErrorBlock(c, screenshotUrl) {
  if (c.status !== "failed" && c.status !== "blocked") return "";
  if (!c.error && c.failedStep === undefined) return "";

  const where = c.failedStep !== undefined
    ? `Step ${c.failedStep}${c.failedStepTitle ? ` — ${c.failedStepTitle}` : ""}`
    : "The test stopped here";

  return `
    <div class="diag-card">
      <div class="diag-card-header">
        <span class="diag-badge">Where it stopped</span>
        <h4>${escapeHtml(where)}</h4>
      </div>
      <div class="diag-card-body">
        ${c.error ? `<div class="diag-item"><p class="diag-text">${escapeHtml(c.error)}</p></div>` : ""}
        ${screenshotUrl ? `<div class="diag-item"><p class="diag-text"><a href="${escapeHtml(screenshotUrl)}" target="_blank" rel="noopener">Screenshot at the point it stopped</a></p></div>` : ""}
        ${c.errorDetail && c.errorDetail !== c.error ? `
        <details class="diag-tech-details">
          <summary>Full error (for developers)</summary>
          <code>${escapeHtml(c.errorDetail)}</code>
        </details>` : ""}
      </div>
    </div>`;
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

  // A missing video used to be indistinguishable from a run that simply passed (video is
  // retain-on-failure). When ffmpeg is absent the server now says so explicitly, so show that
  // rather than an unexplained gap — reusing .tree-empty, no new class (rule 3). TD-71.
  const noVid = document.getElementById("videoUnavailable");
  if (noVid) {
    if (!vid && data?.videoUnavailable) {
      noVid.textContent = data.videoUnavailable;
      noVid.classList.remove("hidden");
    } else {
      noVid.classList.add("hidden");
    }
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
      <span class="hurl" title="${escapeHtml(r.url || "")}">${escapeHtml(displayUrl(r.url))}</span>
      <button type="button" class="history-del" title="Delete this run" aria-label="Delete run">${icon("trash", { size: 13 })}</button>
    </li>`;
  }).join("");

  historyListEl.querySelectorAll(".history-item").forEach((li) => {
    li.addEventListener("click", () => {
      historyListEl.querySelectorAll(".history-item").forEach(item => item.classList.remove("active"));
      li.classList.add("active");
      if (li.dataset.prompt) promptEl.value = li.dataset.prompt;
      refreshComposerState();
      if (li.dataset.url) setUrlFieldValue(li.dataset.url);
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
let newSuiteFor = null;     // project id whose form is open, NEW_SUITE_ANY, or null
let newSuiteName = "";
let newSuiteError = "";

// Sentinel for `newSuiteFor`: the create form was opened from the Projects heading rather than
// from inside one project, so the project is CHOSEN in the form instead of implied by where the
// form was opened. Cannot collide with a real id — project ids are UUIDs.
const NEW_SUITE_ANY = "*";

// Which project the heading-level form is filing the new suite under. Module state, not just the
// <select>'s DOM value: loadHistory() -> loadProjects() -> renderProjectsTree() fires on a poll and
// replaces the whole tree, so a choice held only in the DOM would silently snap back to the first
// project mid-typing — and the suite would be created in the wrong one.
let newSuiteProject = null;

let renameSuiteId = null;   // suite id whose rename form is open, or null
let renameSuiteName = "";
let renameSuiteError = "";

// The sidebar's inline project form, for both create and edit — same shape, same two fields, so
// one form serves both and `projectFormId` is what tells them apart (null = creating). Module
// state for the same reason as the suite form: a background history refresh re-renders the whole
// tree and would otherwise wipe what's being typed.
let projectFormOpen = false;
let projectFormId = null;   // project being edited, or null when creating
let projectFormName = "";
let projectFormUrl = "";
let projectFormError = "";

/** Creating and editing a project is admin+, and impossible at all without a database — with none
 *  configured the sidebar is showing URL groupings, not project rows, so there is nothing to edit
 *  and offering the control would be a lie. */
function canManageProjects() {
  return (!auth.required || roleAtLeast(auth.role, "admin")) && !projectsUnavailable;
}

/**
 * Suite gates. Two of them, because the server splits the same way: composing the library is
 * authoring (`tester` — POST/PATCH /api/suites) and destroying authored work is administration
 * (`admin` — DELETE /api/suites/:id).
 *
 * Both keep the `!auth.required ||` escape hatch that canManageProjects() has. With auth off the
 * server hands the synthetic local user `owner` rather than skipping the check, so a UI gate
 * without the hatch hides controls the server would happily honour.
 *
 * `!projectsUnavailable` because with no database the tree is showing URL groupings synthesised
 * from run history, not real suites — there is nothing there to rename or delete.
 */
function canAuthorSuites() {
  return (!auth.required || roleAtLeast(auth.role, "tester")) && !projectsUnavailable;
}
function canDeleteSuites() {
  return (!auth.required || roleAtLeast(auth.role, "admin")) && !projectsUnavailable;
}

function closeProjectForm() {
  projectFormOpen = false;
  projectFormId = null;
  projectFormName = "";
  projectFormUrl = "";
  projectFormError = "";
}

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
// Where the answer is POSTed. A run and a case-edit park on the SAME server-side waiter table,
// keyed by run id or job id, so the only thing that differs is this URL — which is why this is one
// variable rather than a second modal.
let credPostUrl = null;

function showCredentialPrompt(runId, data, postUrl) {
  credRunId = runId;
  credPostUrl = postUrl ?? `/api/runs/${runId}/credentials`;
  const host = (() => { try { return new URL(data?.url).host; } catch { return data?.url ?? "this site"; } })();
  credWhyEl.textContent = data?.caseEdit
    // Editing says something different on purpose: nothing is being tested yet, and skipping here
    // does not "test less" — it fails the check outright, because the walk cannot reach the step.
    ? `Checking this edit means signing in to ${host} first — the step you changed is behind the login. ` +
      `Add credentials to verify it, or skip and the check will stop at the login.`
    : `The tests for ${host} need to sign in, and there's no built-in account for it. ` +
      `Add credentials to test the flow past the login, or skip to test only what's reachable without one.`;
  credUserEl.value = "";
  credPassEl.value = "";
  credFormEl.querySelectorAll("button, input").forEach((el) => { el.disabled = false; });
  credPromptEl.classList.remove("hidden");
  credUserEl.focus();
}

function hideCredentialPrompt() {
  credRunId = null;
  credPostUrl = null;
  // Don't leave the password sitting in the DOM once it's been handed over.
  credUserEl.value = "";
  credPassEl.value = "";
  credPromptEl.classList.add("hidden");
}

async function submitCredentials(body) {
  if (!credRunId) return;
  const url = credPostUrl;
  credFormEl.querySelectorAll("button, input").forEach((el) => { el.disabled = true; });
  try {
    await fetch(url, {
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

// --- Drafts -----------------------------------------------------------------
//
// Everything a reviewer types here is a DRAFT until the round is approved. Nothing is sent as it
// is typed, which is the same promise the saved-case editor makes: a model proposes, a person
// approves, and only then does anything travel.
//
// Drafts live in localStorage because the panel is rebuilt from the run's replayed event stream,
// and that event carries the batch the model ORIGINALLY produced. Without this, refreshing the
// page while the round is still parked and waiting would silently throw the reviewer's work away.
// Keyed by run AND attempt, so a refine round starts clean instead of inheriting edits aimed at
// cases that no longer exist.
let gateAttempt = 0;
let gateDrafts = emptyGateDrafts();
let gateAiAvailable = false;
const gateProposals = {};   // index -> proposal. Transient: a proposal is never a draft.

function emptyGateDrafts() {
  return { edits: {}, added: [], removed: {}, checked: {} };
}

function gateDraftKey(runId, attempt) { return `testbench.gate.${runId}.${attempt}`; }

function loadGateDrafts(runId, attempt) {
  gateDrafts = emptyGateDrafts();
  try {
    const raw = localStorage.getItem(gateDraftKey(runId, attempt));
    if (!raw) return;
    const p = JSON.parse(raw);
    const obj = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
    gateDrafts = {
      edits: obj(p.edits),
      added: Array.isArray(p.added) ? p.added : [],
      removed: obj(p.removed),
      checked: obj(p.checked),
    };
  } catch {
    // Corrupt or unavailable storage (private mode, quota, a hand-edited value) must never stop
    // the round being reviewable. No drafts just means "show what the model proposed".
  }
}

function saveGateDrafts() {
  if (!caseRunId) return;
  try {
    localStorage.setItem(gateDraftKey(caseRunId, gateAttempt), JSON.stringify(gateDrafts));
  } catch {
    // Storage full or blocked. The edits still work for this page view, they just will not
    // survive a refresh. Failing loudly here would be worse than losing a draft.
  }
}

/** Drop every attempt's drafts for a run once its gate is over, so storage does not accumulate
 *  one entry per round per run forever. */
function clearGateDrafts(runId) {
  if (!runId) return;
  try {
    const prefix = `testbench.gate.${runId}.`;
    Object.keys(localStorage).filter((k) => k.startsWith(prefix)).forEach((k) => localStorage.removeItem(k));
  } catch { /* nothing to clean up if storage is unavailable */ }
}

// --- The case list, as it currently stands ----------------------------------

/**
 * The batch merged with the reviewer's drafts: model cases with their edits applied, then the
 * cases the reviewer wrote, with anything removed filtered out.
 *
 * `index` is the one number that matters. It is the position the server addresses this case by,
 * and it is deliberately the same index space `selectedIndexes` already used: model cases keep
 * their original position, and written cases follow at the end in the order they were added,
 * which is the order the server appends them in. Nothing is ever renumbered.
 */
function gateCases() {
  const out = [];
  currentBatch.forEach((base, i) => {
    if (gateDrafts.removed[i]) return;
    const edit = gateDrafts.edits[i] || {};
    const fields = Object.keys(edit);
    out.push({ index: i, c: { ...base, ...edit }, isAdded: false, isEdited: fields.length > 0 });
  });
  gateDrafts.added.forEach((a, j) => {
    out.push({ index: currentBatch.length + j, c: a, isAdded: true, isEdited: false });
  });
  return out;
}

/** The mutable draft object for one case: the patch for a model case, the case itself for one
 *  the reviewer wrote. */
function gateEditFor(index) {
  if (index >= currentBatch.length) return gateDrafts.added[index - currentBatch.length];
  if (!gateDrafts.edits[index]) gateDrafts.edits[index] = {};
  return gateDrafts.edits[index];
}

/** Steps as they stand for one case: the draft if it has been touched, the model's otherwise. */
function gateStepsFor(index) {
  const target = gateEditFor(index);
  if (target && Array.isArray(target.steps)) return target.steps;
  const base = currentBatch[index];
  return Array.isArray(base && base.steps) ? base.steps.slice() : [];
}

function setGateSteps(index, steps) {
  const target = gateEditFor(index);
  if (!target) return;
  target.steps = steps;
  saveGateDrafts();
}

/** Ticked state is a draft too, so it survives a repaint after a structural change and a refresh
 *  mid-round. Falls back to the rule the panel has always used: the primary case starts ticked. */
function gateIsChecked(entry) {
  const stored = gateDrafts.checked[entry.index];
  if (typeof stored === "boolean") return stored;
  return entry.isAdded || !!entry.c.fromPrompt;
}

function setGateChecked(index, value) {
  gateDrafts.checked[index] = value;
  saveGateDrafts();
}

// --- What's on the page -----------------------------------------------------
//
// A case at the gate has no IR: it is plain English, and both compilation and grounding happen
// only after the round is approved. So while a step is being typed, nothing can tell the reviewer
// whether the control they just named exists. `groundingError()` answers that later, minutes
// later, against the same application model these chips are built from.
//
// This closes the gap from the safe side. It deliberately does NOT check what was typed — deciding
// whether a sentence names a real element means pulling a target out of free English, a regex over
// model-authored prose, which is the TD-01 failure this project already has on record. A false
// warning on a correct step is worse than no warning at all. Showing what IS there carries no such
// risk, and clicking a chip puts the site's own wording into the sentence, which is the thing that
// actually makes a step ground cleanly.
let gatePageElements = null;      // [{ url, title, elements: [{role, name}] }] for the current run
let gatePageElementsRunId = null;
// The step input a chip should insert into: the last one the reviewer touched.
let gateLastStep = null;          // { index, step }

/** Origin + path, ignoring query and hash.
 *
 *  A deliberate duplicate of `pageKey()` in src/schema/appModel.ts. app.js is a classic script
 *  with no module surface and cannot import from src/, the same reason it carries its own copy of
 *  `formatIrStep`. `tests/gatePageElements.test.ts` evaluates this copy and asserts it agrees with
 *  the server's on the URL shapes that matter, so the two cannot drift silently. If you change one,
 *  change both — the test will tell you.
 */
function gatePageKey(url) {
  try {
    const u = new URL(url);
    return u.origin + (u.pathname.replace(/\/+$/, "") || "/");
  } catch { return url; }
}

/** Load the run's page elements once per round. Silent on failure: the panel is fully usable
 *  without them, and a missing application model must never block a round someone is waiting on. */
async function loadGatePageElements(runId) {
  if (gatePageElementsRunId === runId && gatePageElements) return;
  gatePageElementsRunId = runId;
  gatePageElements = null;
  try {
    const res = await fetch(`/api/runs/${runId}/page-elements`);
    if (!res.ok) return;
    const body = await res.json();
    gatePageElements = Array.isArray(body.pages) ? body.pages : null;
  } catch {
    // Offline, 404 before discovery wrote the artifact, or a corrupt model. Nothing to show.
  }
}

/** The page a case is about: its own targetUrl when it has one, otherwise every page. */
function gatePagesFor(testCase) {
  if (!gatePageElements || gatePageElements.length === 0) return [];
  const target = testCase && testCase.targetUrl;
  if (target) {
    const key = gatePageKey(target);
    const match = gatePageElements.filter((p) => gatePageKey(p.url) === key);
    if (match.length) return match;
  }
  return gatePageElements;   // no target, or a target that matches nothing discovered
}

// Roles grouped the way a person looks for them, rather than the way the accessibility tree
// reports them. Anything unrecognised still shows, under "Other", so a control is never hidden
// just because this list did not anticipate its role.
const GATE_ROLE_GROUPS = [
  { label: "Buttons", roles: ["button", "menuitem", "tab"] },
  { label: "Fields", roles: ["textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "spinbutton", "slider", "option"] },
  { label: "Links", roles: ["link"] },
  { label: "Headings", roles: ["heading"] },
];

function gateElementsHtml(index, testCase) {
  const pages = gatePagesFor(testCase);
  if (pages.length === 0) return "";

  const sections = pages.map((page) => {
    const grouped = GATE_ROLE_GROUPS.map((g) => ({
      label: g.label,
      items: page.elements.filter((e) => g.roles.includes(e.role)),
    }));
    const claimed = new Set(GATE_ROLE_GROUPS.flatMap((g) => g.roles));
    const other = page.elements.filter((e) => !claimed.has(e.role));
    if (other.length) grouped.push({ label: "Other", items: other });

    const rows = grouped.filter((g) => g.items.length).map((g) => `
      <div class="case-suites">
        <span class="case-suites-label">${escapeHtml(g.label)}</span>
        ${g.items.map((e) => `<button type="button" class="case-suite-chip" data-act="insert-el"
           data-index="${index}" data-name="${escapeHtml(e.name)}"
           title="${escapeHtml(e.role)} &mdash; click to put this wording in the step you are editing"
           >${escapeHtml(e.name)}</button>`).join("")}
      </div>`).join("");
    if (!rows) return "";
    const label = page.title ? `${page.title} (${page.url})` : page.url;
    return `${pages.length > 1 ? `<div class="cd-card-label">${escapeHtml(label)}</div>` : ""}${rows}`;
  }).join("");

  if (!sections.trim()) return "";
  return `
    <div class="cd-card">
      <div class="cd-card-label">What's on this page &mdash; click to use the site's own wording</div>
      ${sections}
    </div>`;
}

// --- Rendering --------------------------------------------------------------

function gateProposalHtml(index, p) {
  // The same LCS diff the saved-case editor shows, for the same reason: an inserted step must
  // shift nothing after it, or the reviewer cannot tell an insertion from a rewrite of the rest.
  const { left, right } = diffSteps(p.before, p.steps);
  const rows = [];
  left.forEach((l) => { if (l.k === "removed") rows.push({ k: "del", t: l.t }); });
  right.forEach((r) => rows.push({ k: r.k === "added" ? "add" : "same", t: r.t }));
  return `
    <div class="cd-proposal">
      <p class="cd-proposal-note">Proposed change &mdash; nothing is saved until you approve this round.</p>
      ${p.note ? `<p class="cd-proposal-note">${escapeHtml(p.note)}</p>` : ""}
      <div class="cd-diff">
        ${rows.map((r) => `<div class="cd-diff-line cd-diff-${r.k}">${escapeHtml(r.t)}</div>`).join("")}
      </div>
      <div class="cd-proposal-actions">
        <button type="button" class="dl-btn-inline" data-act="prop-apply" data-index="${index}">Apply to editor</button>
        <button type="button" class="dl-btn-inline" data-act="prop-discard" data-index="${index}">Discard</button>
      </div>
    </div>`;
}

function gateStepRowsHtml(index) {
  const steps = gateStepsFor(index);
  return steps.map((text, k) => `
    <div class="cd-line">
      <span class="cd-line-num">${k + 1}</span>
      <input type="text" class="cd-line-input" data-field="step" data-index="${index}" data-step="${k}"
             value="${escapeHtml(text)}" aria-label="Step ${k + 1}" />
      <button type="button" class="cd-line-btn" data-act="step-up" data-index="${index}" data-step="${k}"
              ${k === 0 ? "disabled" : ""} title="Move up" aria-label="Move step ${k + 1} up">&uarr;</button>
      <button type="button" class="cd-line-btn" data-act="step-down" data-index="${index}" data-step="${k}"
              ${k === steps.length - 1 ? "disabled" : ""} title="Move down" aria-label="Move step ${k + 1} down">&darr;</button>
      <button type="button" class="cd-line-del" data-act="step-del" data-index="${index}" data-step="${k}"
              title="Delete step" aria-label="Delete step ${k + 1}">&times;</button>
    </div>`).join("");
}

/**
 * One case as an editable card.
 *
 * The wrapper div exists for a layout reason worth stating, so nobody deletes it as redundant
 * markup. The list item is a flex ROW: the checkbox and every sibling after it divide the width
 * between them. Left as direct children, the step editor rendered as a ~300px column beside the
 * summary, giving a step sentence about 160px to be typed into. `case-narrative` is the existing
 * class for "the stacked content column of a case" (flex: 1, column, gap) — as the single flex
 * child it hands the editor the full row and stacks summary, actions and editor vertically, with
 * no CSS change and no new class. It also keeps the inner <label> a flex item, which is what
 * blockifies it and keeps the summary lines on separate rows.
 */
function gateCardHtml(entry) {
  const { index: i, c, isAdded, isEdited } = entry;
  const open = isAdded || isEdited;          // authoring or already changed: start expanded
  const primary = c.fromPrompt ? `<span class="case-primary-badge">Primary</span>` : "";
  const written = isAdded ? `<span class="case-badge">Your case</span>` : "";
  const edited = isEdited ? `<span class="case-badge" data-edited="${i}">Edited</span>` : "";
  const why = c.whyItMatters || c.intent || c.expected || "";
  const expected = c.expected || "";
  return `
    <li data-case="${i}">
      <input type="checkbox" id="case-pick-${i}" data-index="${i}" ${gateIsChecked(entry) ? "checked" : ""} />
      <div class="case-narrative">
      <label for="case-pick-${i}" class="case-label">
        <span class="case-label-row">
          <span class="case-title" data-title-for="${i}">${escapeHtml(c.title || `Case ${i + 1}`)}</span>${primary}${written}${edited}
        </span>
        ${why ? `<span class="case-intent">${escapeHtml(why)}</span>` : ""}
        ${expected && expected !== why ? `<span class="case-expected"><b>What should happen:</b> ${escapeHtml(expected)}</span>` : ""}
      </label>
      <div class="case-selection-bulk">
        <button type="button" class="case-selection-link" data-act="toggle-edit" data-index="${i}">${open ? "Hide steps" : "Edit steps"}</button>
        <button type="button" class="case-selection-link" data-act="remove-case" data-index="${i}">Remove case</button>
      </div>
      <div class="cd-card-inset ${open ? "" : "hidden"}" data-editor="${i}">
        <div class="cd-card-label">Title</div>
        <input type="text" class="cd-line-input" data-field="title" data-index="${i}"
               value="${escapeHtml(c.title || "")}" aria-label="Case title" />

        <div class="cd-card-label">Steps</div>
        <div class="cd-lines">${gateStepRowsHtml(i)}</div>
        <button type="button" class="cd-add" data-act="step-add" data-index="${i}">+ Add step</button>

        <div class="cd-card-label">Expected outcome</div>
        <input type="text" class="cd-line-input" data-field="expected" data-index="${i}"
               value="${escapeHtml(c.expected || "")}" aria-label="Expected outcome" />

        <div class="cd-card-label">Why it matters</div>
        <input type="text" class="cd-line-input" data-field="whyItMatters" data-index="${i}"
               value="${escapeHtml(c.whyItMatters || "")}" aria-label="Why it matters" />
        ${gateElementsHtml(i, c)}
        ${gateAiAvailable ? `
        <div class="cd-card">
          <div class="cd-card-label">Ask for a change</div>
          <textarea class="cd-ask-text" data-field="ask" data-index="${i}" rows="2"
                    placeholder="e.g. also check that the error message is visible"></textarea>
          <button type="button" class="cd-ask-btn" data-act="ask" data-index="${i}">Ask for a change</button>
        </div>` : ""}
        <div data-proposal="${i}">${gateProposals[i] ? gateProposalHtml(i, gateProposals[i]) : ""}</div>
      </div>
      </div>
    </li>`;
}

function renderCaseSelectionPanel(batch, attempt, acceptedCount, opts) {
  currentBatch = Array.isArray(batch) ? batch : [];
  acceptedSoFarCount = acceptedCount || 0;
  if (opts && typeof opts.ai === "boolean") gateAiAvailable = opts.ai;

  // Reload drafts only when the round actually changes. The poller replays this event, and
  // re-reading storage on every replay would stamp on whatever the reviewer is mid-way through
  // typing.
  if (attempt !== gateAttempt) {
    gateAttempt = attempt;
    loadGateDrafts(caseRunId, attempt);
    Object.keys(gateProposals).forEach((k) => delete gateProposals[k]);
  }

  caseRoundLabelEl.textContent = `Round ${attempt} — review the test cases`;
  // "2 of 5 cases accepted so far" read as progress toward a target of five, so people pressed
  // refine to "finish". Five is MAX_ACCUMULATED_CASES — a ceiling on what the pool will hold,
  // not a number to reach. The wording now says what you can do rather than how far along you are.
  casePoolCounterEl.textContent = acceptedSoFarCount === 0
    ? `Tick the cases you want to run. You can run as few as one — up to ${CASE_POOL_CAP} in total.`
    : `${acceptedSoFarCount} case${acceptedSoFarCount === 1 ? "" : "s"} accepted — enough to run now. ` +
      `${CASE_POOL_CAP} is the most this run will hold, not a target.`;

  repaintCaseList();
  // Fetched after the first paint, not before it: the round is reviewable immediately, and the
  // chips fill in a moment later if the run has an application model to offer.
  loadGatePageElements(caseRunId).then(() => {
    if (gatePageElements && !caseSelectionPanelEl.classList.contains("hidden")) repaintCaseList();
  });

  setRefineOpen(false);
  caseNewPromptInputEl.value = "";
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

/** Redraw the list. Ticked state comes from the drafts rather than the DOM, so a structural
 *  change (reordering a step, adding a case) cannot silently untick anything. Focus is put back
 *  where it was, because adding a step should leave the caret in the field you were using. */
function repaintCaseList() {
  const active = document.activeElement;
  const key = active && active.dataset && active.dataset.field
    ? { field: active.dataset.field, index: active.dataset.index, step: active.dataset.step,
        start: active.selectionStart }
    : null;

  caseSelectionListEl.innerHTML = gateCases().map(gateCardHtml).join("");

  if (key) {
    const sel = `[data-field="${key.field}"][data-index="${key.index}"]` +
                (key.step === undefined ? "" : `[data-step="${key.step}"]`);
    const again = caseSelectionListEl.querySelector(sel);
    if (again) {
      again.focus();
      if (key.start != null && again.setSelectionRange) {
        try { again.setSelectionRange(key.start, key.start); } catch { /* not a text input */ }
      }
    }
  }
  updateDoneButtonState();
}

function hideCaseSelectionPanel() {
  clearGateDrafts(caseRunId);
  caseRunId = null;
  currentBatch = [];
  acceptedSoFarCount = 0;
  gateAttempt = 0;
  gateDrafts = emptyGateDrafts();
  Object.keys(gateProposals).forEach((k) => delete gateProposals[k]);
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

  // A disabled button with no reason left "Not satisfied — refine" as the only control that
  // responded, which is how unintended extra rounds were being generated. Say why, next to it,
  // and say that refining is not the way out.
  refineHintEl().textContent = total === 0
    ? "Nothing is ticked, so there is nothing to run. Tick at least one case above — you do not need to refine."
    : "";
}

/** The inline reason under the final actions. Created once, in code, because this task may not
 *  add markup to index.html; `.case-regen-note` is the existing style for a line in this slot. */
function refineHintEl() {
  let el = document.getElementById("case-done-hint");
  if (!el) {
    el = document.createElement("p");
    el.id = "case-done-hint";
    el.className = "case-regen-note case-done-hint";
    el.setAttribute("role", "status");
    caseDoneBtnEl.closest(".case-selection-final-actions").insertAdjacentElement("beforebegin", el);
  }
  return el;
}

// --- Turning drafts into the request ----------------------------------------

/**
 * Build the two optional fields the decision route accepts, sending only what actually differs
 * from what the model proposed. A round nobody edited produces neither field, so the request is
 * byte-identical to the one this panel sent before any of this existed.
 */
function gateEditPayload() {
  const editedCases = [];
  Object.keys(gateDrafts.edits).forEach((key) => {
    const i = Number(key);
    const base = currentBatch[i];
    if (!base || gateDrafts.removed[i]) return;
    const edit = gateDrafts.edits[i];
    const patch = { index: i };
    const str = (v) => (typeof v === "string" ? v.trim() : "");
    if (str(edit.title) && str(edit.title) !== base.title) patch.title = str(edit.title);
    if (Array.isArray(edit.steps)) {
      const steps = edit.steps.map((t) => String(t).trim()).filter(Boolean);
      if (steps.length && steps.join("\n") !== (base.steps || []).join("\n")) patch.steps = steps;
    }
    if (str(edit.expected) && str(edit.expected) !== base.expected) patch.expected = str(edit.expected);
    if (str(edit.whyItMatters) && str(edit.whyItMatters) !== base.whyItMatters) {
      patch.whyItMatters = str(edit.whyItMatters);
    }
    if (Object.keys(patch).length > 1) editedCases.push(patch);
  });

  const addedCases = gateDrafts.added.map((a) => {
    const out = {
      title: String(a.title || "").trim(),
      steps: (a.steps || []).map((t) => String(t).trim()).filter(Boolean),
      expected: String(a.expected || "").trim(),
    };
    const why = String(a.whyItMatters || "").trim();
    if (why) out.whyItMatters = why;
    return out;
  });

  const payload = {};
  if (editedCases.length) payload.editedCases = editedCases;
  if (addedCases.length) payload.addedCases = addedCases;
  return payload;
}

/** What the server's schema would reject, said in the panel instead of coming back as a 400.
 *  Only checks cases the reviewer actually intends to run — an unfinished draft they left
 *  unticked is not an error. */
function gateValidationError(selectedIndexes) {
  const picked = new Set(selectedIndexes);
  for (const entry of gateCases()) {
    if (!picked.has(entry.index)) continue;
    const c = entry.c;
    const steps = gateStepsFor(entry.index).map((t) => String(t).trim()).filter(Boolean);
    if (!String(c.title || "").trim()) return `Case ${entry.index + 1} needs a title.`;
    if (steps.length === 0) return `"${c.title}" needs at least one step.`;
    if (!String(c.expected || "").trim()) return `"${c.title}" needs an expected outcome.`;
  }
  return null;
}

/**
 * The one door every gate decision goes through: pick, refine, edits and hand-written cases all
 * leave the browser here and nowhere else.
 */
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
  caseSelectionListEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = true;
    gateDrafts.checked[Number(cb.dataset.index)] = true;
  });
  saveGateDrafts();
  updateDoneButtonState();
});

caseSelectNoneBtnEl.addEventListener("click", () => {
  const primaryWasChecked = Array.from(caseSelectionListEl.querySelectorAll('input[type="checkbox"]'))
    .some((cb) => cb.checked && currentBatch[Number(cb.dataset.index)]?.fromPrompt);
  caseSelectionListEl.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = false;
    gateDrafts.checked[Number(cb.dataset.index)] = false;
  });
  saveGateDrafts();
  if (primaryWasChecked) {
    showNotice("Primary case unselected — if you refine again, the next round will generate a new primary case.");
  }
  updateDoneButtonState();
});

caseDoneBtnEl.addEventListener("click", async () => {
  if (!caseRunId) return;
  const selectedIndexes = getCheckedCaseIndexes();
  if (acceptedSoFarCount + selectedIndexes.length === 0) return;
  const problem = gateValidationError(selectedIndexes);
  if (problem) return showError(problem);
  const ok = await postCaseSelectionDecision(caseRunId, {
    action: "done", selectedIndexes, ...gateEditPayload(),
  });
  if (ok) hideCaseSelectionPanel();
});

/**
 * Open or close the refine box. Nothing here submits.
 *
 * The trigger used to be a two-click submit: the first click revealed the box, the second sent
 * the round. Clicking it twice — to look, then to dismiss — generated a refine nobody asked for.
 * The trigger is now a pure disclosure, and the only thing that submits is the confirm control
 * inside the box.
 *
 * `.hidden` ships on this element from index.html, which this change may not edit. Rather than
 * add another `.hidden` toggle outside showView(), the class is cleared once here and the
 * open/closed state is carried by `.case-refine-collapsed`, which belongs to this feature.
 */
function setRefineOpen(open) {
  caseRefineInputWrapEl.classList.remove("hidden");
  caseRefineInputWrapEl.classList.toggle("case-refine-collapsed", !open);
  caseNotSatisfiedBtnEl.textContent = open ? "Cancel refine" : "Not satisfied — refine";
  caseNotSatisfiedBtnEl.setAttribute("aria-expanded", String(open));
  if (open) {
    ensureRefineConfirmBtn();
    caseNewPromptInputEl.focus();
  }
}

/** The confirm control, inside the box so the trigger can never submit. Created once, in code,
 *  because this change may not add markup to index.html. */
function ensureRefineConfirmBtn() {
  let btn = document.getElementById("case-refine-confirm-btn");
  if (btn) return btn;
  btn = document.createElement("button");
  btn.type = "button";
  btn.id = "case-refine-confirm-btn";
  btn.className = "case-refine-confirm";
  btn.textContent = "Generate another round";
  caseRefineInputWrapEl.appendChild(btn);
  btn.addEventListener("click", submitRefine);
  return btn;
}

/** Send the refine. The only path that posts `not_satisfied`. */
async function submitRefine() {
  if (!caseRunId) return;
  const newPrompt = caseNewPromptInputEl.value.trim();
  if (!newPrompt) {
    showError("Describe what should change before refining.");
    caseNewPromptInputEl.focus();
    return;
  }
  const selectedIndexes = getCheckedCaseIndexes();
  const problem = gateValidationError(selectedIndexes);
  if (problem) return showError(problem);

  // Anything not ticked is recorded `rejected` by the history ledger, and getRejectedTitles()
  // then excludes it from every later round of this run. That is not obvious from the screen and
  // it cannot be undone, so it is stated before the round is spent rather than discovered after.
  const unticked = gateCases().filter((c) => !selectedIndexes.includes(c.index)).length;
  const warning = unticked === 0
    ? "Generate another round of cases?"
    : `Generate another round?

${unticked} case${unticked === 1 ? "" : "s"} you have not ` +
      `ticked will be recorded as rejected, and cannot be offered again in this run.`;
  if (!confirm(warning)) return;

  const ok = await postCaseSelectionDecision(caseRunId, {
    action: "not_satisfied", selectedIndexes, newPrompt, ...gateEditPayload(),
  });
  if (ok) hideCaseSelectionPanel();
}

// The trigger only discloses — open, or close again with nothing sent.
caseNotSatisfiedBtnEl.addEventListener("click", () => {
  if (!caseRunId) return;
  setRefineOpen(caseRefineInputWrapEl.classList.contains("case-refine-collapsed"));
});

caseSelectionListEl.addEventListener("change", (e) => {
  if (!e.target.matches('input[type="checkbox"]')) return;
  setGateChecked(Number(e.target.dataset.index), e.target.checked);
  updateDoneButtonState();
});

// Typing never re-renders: that would pull the caret out from under the reviewer. The draft is
// recorded and the summary line above the editor is nudged to match.
caseSelectionListEl.addEventListener("focusin", (e) => {
  const el = e.target;
  if (el && el.dataset && el.dataset.field === "step") {
    gateLastStep = { index: Number(el.dataset.index), step: Number(el.dataset.step) };
  }
});

caseSelectionListEl.addEventListener("input", (e) => {
  const el = e.target;
  const field = el.dataset && el.dataset.field;
  if (!field || field === "ask") return;
  const i = Number(el.dataset.index);
  const target = gateEditFor(i);
  if (!target) return;
  if (field === "step") {
    const steps = gateStepsFor(i).slice();
    steps[Number(el.dataset.step)] = el.value;
    target.steps = steps;
  } else {
    target[field] = el.value;
  }
  saveGateDrafts();
  if (field === "title") {
    const label = caseSelectionListEl.querySelector(`[data-title-for="${i}"]`);
    if (label) label.textContent = el.value || `Case ${i + 1}`;
  }
  markGateEdited(i);
});

/** Show the "Edited" badge the moment a model-written case diverges, without a full repaint. */
function markGateEdited(i) {
  if (i >= currentBatch.length) return;                 // a case you wrote is not an "edit"
  if (caseSelectionListEl.querySelector(`[data-edited="${i}"]`)) return;
  const title = caseSelectionListEl.querySelector(`[data-title-for="${i}"]`);
  if (!title || !title.parentElement) return;
  const badge = document.createElement("span");
  badge.className = "case-badge";
  badge.dataset.edited = String(i);
  badge.textContent = "Edited";
  title.parentElement.appendChild(badge);
}

caseSelectionListEl.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const i = Number(btn.dataset.index);
  const k = Number(btn.dataset.step);

  if (act === "insert-el") {
    // Insert only. Nothing here reads what the reviewer typed, so there is no prose to
    // misinterpret and no way to produce a wrong suggestion about a correct step.
    const name = btn.dataset.name || "";
    const target = gateLastStep && gateLastStep.index === i
      ? caseSelectionListEl.querySelector(`[data-field="step"][data-index="${i}"][data-step="${gateLastStep.step}"]`)
      : null;
    const rows = caseSelectionListEl.querySelectorAll(`[data-field="step"][data-index="${i}"]`);
    const input = target || rows[rows.length - 1];
    if (!input) return;
    const at = input.selectionStart == null ? input.value.length : input.selectionStart;
    const quoted = `"${name}"`;
    input.value = input.value.slice(0, at) + quoted + input.value.slice(at);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.focus();
    const caret = at + quoted.length;
    if (input.setSelectionRange) { try { input.setSelectionRange(caret, caret); } catch { /* not a text input */ } }
    return;
  }

  if (act === "toggle-edit") {
    const box = caseSelectionListEl.querySelector(`[data-editor="${i}"]`);
    if (!box) return;
    box.classList.toggle("hidden");
    btn.textContent = box.classList.contains("hidden") ? "Edit steps" : "Hide steps";
    return;
  }

  if (act === "remove-case") {
    // Removing a case you wrote drops it entirely. Removing one the model wrote only hides it,
    // and it reaches the server as "not selected" — deliberately, because splicing it out of the
    // batch would renumber every case after it, and those positions are exactly what
    // selectedIndexes means. Left in place it is recorded as rejected, which is also what stops
    // a later refine round proposing it straight back.
    if (i >= currentBatch.length) gateDrafts.added.splice(i - currentBatch.length, 1);
    else gateDrafts.removed[i] = true;
    delete gateDrafts.checked[i];
    delete gateProposals[i];
    saveGateDrafts();
    repaintCaseList();
    return;
  }

  if (act === "step-add") {
    setGateSteps(i, [...gateStepsFor(i), ""]);
    repaintCaseList();
    const rows = caseSelectionListEl.querySelectorAll(`[data-field="step"][data-index="${i}"]`);
    const last = rows[rows.length - 1];
    if (last) last.focus();
    return;
  }
  if (act === "step-del") {
    const steps = gateStepsFor(i).slice();
    steps.splice(k, 1);
    setGateSteps(i, steps);
    repaintCaseList();
    return;
  }
  if (act === "step-up" || act === "step-down") {
    const steps = gateStepsFor(i).slice();
    const to = act === "step-up" ? k - 1 : k + 1;
    if (to < 0 || to >= steps.length) return;
    const moved = steps[k];
    steps[k] = steps[to];
    steps[to] = moved;
    setGateSteps(i, steps);
    repaintCaseList();
    return;
  }

  if (act === "prop-apply") {
    // D-27, unchanged: applying fills the editor. It sends nothing and accepts nothing — the
    // round still has to be approved by a person afterwards.
    const p = gateProposals[i];
    if (!p) return;
    setGateSteps(i, p.steps.slice());
    delete gateProposals[i];
    repaintCaseList();
    showNotice("Applied to the editor — nothing is saved until you run or refine this round.");
    return;
  }
  if (act === "prop-discard") {
    delete gateProposals[i];
    repaintCaseList();
    return;
  }

  if (act === "ask") {
    const box = caseSelectionListEl.querySelector(`[data-field="ask"][data-index="${i}"]`);
    const instruction = ((box && box.value) || "").trim();
    if (!instruction) return showError("Say what you would like changed.");
    const entry = gateCases().find((x) => x.index === i);
    if (!entry) return;
    btn.disabled = true;
    btn.classList.add("ai-busy");
    btn.innerHTML = `${SPIN_ICON} Asking…`;
    try {
      const res = await fetch(`/api/runs/${caseRunId}/case-selection/rewrite`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // The steps come from the editor, not from the batch: the reviewer may already have
        // changed them by hand, and asking about the model's original wording would quietly
        // throw that away.
        body: JSON.stringify({ title: entry.c.title, steps: gateStepsFor(i), instruction }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(typeof body.error === "string" ? body.error : "Could not propose a change.");
        return;
      }
      gateProposals[i] = body;
      repaintCaseList();
    } catch {
      showError("Could not propose a change.");
    } finally {
      btn.disabled = false;
      btn.classList.remove("ai-busy");
      btn.textContent = "Ask for a change";
    }
  }
});

if (caseWriteOwnBtnEl) {
  caseWriteOwnBtnEl.addEventListener("click", () => {
    // The same field shape the model produces, so from here on a case a person wrote and a case
    // the model wrote are the same kind of thing. Pre-ticked: you did not type it out in order
    // to leave it behind.
    gateDrafts.added.push({ title: "", steps: [""], expected: "", whyItMatters: "" });
    saveGateDrafts();
    repaintCaseList();
    const idx = currentBatch.length + gateDrafts.added.length - 1;
    const field = caseSelectionListEl.querySelector(`[data-field="title"][data-index="${idx}"]`);
    if (field) {
      field.focus();
      field.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  });
}

function applyEvent(event, runId) {
  setPhaseFromStage(event.stage, event.status, event.data);

  // The first event of every run. Recorded, not rendered here: the results header is drawn later,
  // from renderSuiteResults, and by then this has been seen — on a live run and on a reload alike,
  // because the poller replays the whole stream through this function.
  if (event.stage === "input" && typeof event.data?.prompt === "string") {
    currentRunPrompt = event.data.prompt;
  }

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
    // `gateRewrite` rides on the round event rather than costing a second request: the browser
    // has no way of its own to know whether this server will answer an ask-for-a-change, and
    // drawing a button that always 404s is worse than not drawing one.
    const opts = { ai: event.data.gateRewrite === true };
    fetch(`/api/runs/${runId}/accepted-cases`)
      .then((res) => res.json())
      .then(({ count }) => renderCaseSelectionPanel(batch, attempt, count, opts))
      .catch(() => renderCaseSelectionPanel(batch, attempt, 0, opts));
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
    // Captured BEFORE renderSuiteResults runs — the header reads it.
    currentRunUsage = event.data?.llmUsage ?? null;
    currentRunIsReplay = !!event.data?.replay;
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
  // The PRIMARY case heals under its own "heal" StageName (orchestrator.ts), not through the
  // suite events — so without this a run where only the primary case healed would show no retry
  // count at all, and the cost line would understate what the run actually did.
  if (event.stage === "heal" && event.status === "started") {
    currentRunPrimaryHeals += 1;
  }

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
        // A heal re-runs the whole case in a real browser, so the user watches the tests run a
        // second time after the run looked finished. Say why, while it is happening — until now
        // the only trace was a "Fixed automatically" badge, and only when it worked. TD-83.
        if (event.data.healing) {
          // healsUsedInRun is the SUITE-WIDE count (how many cases have healed); healAttempt is
          // this case's own, and a heal is one-shot so it is always 1. Two different numbers —
          // the cost line wants the first, this row wants the second.
          currentRunSuiteHeals = Math.max(currentRunSuiteHeals, event.data.healsUsedInRun ?? 1);
          setSuiteRetryNote(item,
            `Attempt ${(event.data.healAttempt ?? 1) + 1} of ${(event.data.healMax ?? 1) + 1} — retrying with a fresh page snapshot`);
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
        // A retry that FAILED has to say so too. Reporting only the successes is how a silent
        // second browser run looked like the tool misbehaving rather than trying again.
        if (event.data.healAttempt) {
          const outcome = statusClass === "passed" || statusClass === "truncated" ? "passed" : "failed";
          setSuiteRetryNote(item, `Retry ${event.data.healAttempt}: ${outcome}`);
        } else {
          setSuiteRetryNote(item, null);
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
  // `currentRunId` is one of the four inputs to refreshNewRunState()'s `fresh` test, and this is
  // the only place it is set to a real id — so without this call the New Run button keeps whatever
  // disabled state it had before the run was opened.
  //
  // The bug that was: New Run correctly disables itself once the workspace is empty ("You're
  // already on a new chat"). Opening a run from history, or loading #/run/<id> directly, then
  // arrived here and set currentRunId without recomputing anything, so the button stayed disabled
  // while a run was plainly on screen. Its click handler early-returns on `btn.disabled`, so it
  // was dead on every path that reached a run without going through the composer — clicking it
  // did nothing at all, with no error.
  //
  // resetRunUI() is not the place for this: it is also called on the way OUT of a run (by the New
  // Run handler itself), where recomputing is already handled by the refreshComposerState() call
  // at the end of that handler.
  refreshNewRunState();
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
  if (!prompt) return;

  // Validation happens here and on blur only — never while typing, so a half-typed host is not
  // flagged as a mistake mid-keystroke.
  const problem = urlProblem();
  if (problem) {
    showUrlError(problem);
    urlEl.focus();
    return;
  }
  clearUrlError();

  // The scheme lives beside the field, so the absolute URL is assembled at the last moment. The
  // request body is byte-for-byte the shape it always was: { prompt, url, coverage, options }.
  const url = absoluteUrl();

  runInFlight = true;
  refreshNewRunState();
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
    runInFlight = false;
    navigate("#/run/" + runId);
  } catch (err) {
    // A failed POST previously left the button stuck on "Running\u2026" forever. Reset it and
    // surface the reason instead of silently swallowing the error.
    runInFlight = false;
    submitBtn.disabled = false;
    submitBtn.innerHTML = `${icon("play", { size: 14 })} <span class="run-btn-text">Run test</span>`;
    refreshComposerState();
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
document.getElementById("newRunBtn").addEventListener("click", (e) => {
  // No-op when it is not a real button (so aria-disabled is not the only thing stopping a click),
  // and when it is a button that is already disabled.
  const btn = e.currentTarget;
  if (typeof btn.disabled !== "boolean" || btn.disabled) return;
  pollGeneration++;
  currentRunId = null;
  runInFlight = false;
  promptEl.value = "";
  urlEl.value = "";
  clearUrlError();
  resetRunUI();
  navigate("#/");
  submitBtn.disabled = false;
  submitBtn.innerHTML = `${icon("play", { size: 14 })} <span class="run-btn-text">Run test</span>`;
  historyListEl.querySelectorAll(".history-item").forEach(i => i.classList.remove("active"));
  refreshComposerState();
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
const sidebarOpenEl = document.getElementById("sidebarOpen");
const sidebarCloseEl = document.getElementById("sidebarClose");
const scrimEl = document.getElementById("scrim");
const crumbsEl = document.getElementById("crumbs");
const crumbRootEl = document.getElementById("crumbRoot");
const historyBtnEl = document.getElementById("historyBtn");
const teamBtnEl = document.getElementById("teamBtn");
const allRunsBtnEl = document.getElementById("allRunsBtn");
const addProjectBtnEl = document.getElementById("addProjectBtn");
const addSuiteBtnEl = document.getElementById("addSuiteBtn");
const settingsBtnEl = document.getElementById("settingsBtn");
const settingsPopEl = document.getElementById("settingsPop");
const gateToggleEl = document.getElementById("gateToggle");
const healToggleEl = document.getElementById("healToggle");
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
  // The `!auth.required ||` half is not decoration. auth.role is null until GET /api/auth/me
  // fills it, so with AUTH_ENABLED=false these were both false and this toolbar rendered EMPTY —
  // no Add cases, no Rename, no Delete, and no Run all — while the server was granting that same
  // synthetic user `owner`. Flag-off has to exercise flag-on's code path (CLAUDE.md rule 7).
  const canAuthor = !auth.required || roleAtLeast(auth.role, "tester");
  const canDelete = !auth.required || roleAtLeast(auth.role, "admin");

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
      ${canAuthor
        ? `No cases in this suite yet. Use <b>+ Add cases</b> above to file saved ones here,
           or <b>Save case</b> on a finished run's result to make a new one.`
        : `No cases in this suite yet.`}</div>`;
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
   * so re-adding one is a guaranteed error, and offering it would be offering a mistake. This list
   * is safe to offer where the Team screen's account suggestions were not: it is scoped to one
   * project the caller can already see, rather than to every account on the instance.
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
        if (act === "open") return navigate(caseHash(suite.projectId, caseId));
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

// ------------------------------------------- case step editor (plain English)
//
// Steps are edited as the SAME English sentences formatIrStep() renders, and shipped back to the
// server as strings. The server owns BOTH directions (src/stages/stepText.ts) and parses each
// sentence *onto* the step it came from, so an untouched line returns the original step object —
// its grounding, its `${env:...}` value and its `nth` survive by construction rather than by this
// file remembering to copy them. Nothing here parses a sentence: a second parser is exactly the
// drift TD-07 records, and it would be worse here because it would show one sentence and save
// another.

let caseEditor = null;

/** The lines as the API wants them. */
const caseLinesPayload = () => caseEditor.lines.map((l) => l.text);

function caseEditorDirty() {
  return !!caseEditor && JSON.stringify(caseLinesPayload()) !== caseEditor.original;
}

/** The inline spinner shown inside a button waiting on an AI proposal. One definition so the
 *  three AI entry points cannot drift apart. Purely visual — the button's own label change is
 *  what a screen reader announces. */
const SPIN_ICON = icon("loader", { size: 13, cls: "ai-spin" });

/** A re-ground is in flight — steps are read-only and Save is replaced by Cancel. */
const caseEditorBusy = () => !!caseEditor?.job;

/** Stop following a job without cancelling it server-side. Used when the view is torn down;
 *  the job itself keeps going and simply finishes unobserved. */
function stopFollowingCaseJob() {
  if (caseEditor?.job?.timer) clearTimeout(caseEditor.job.timer);
  if (caseEditor?.job) caseEditor.job.timer = null;
}

/** A fresh line id that cannot collide. Ids are what failing-step reporting names, so a reused
 *  one would misattribute a failure to the wrong row. */
function nextLineId(lines) {
  const used = new Set(lines.map((l) => l.id));
  let n = lines.length + 1;
  while (used.has(`s${n}`)) n++;
  return `s${n}`;
}

// -------------------------------------------------------------------- estimate
//
// /estimate is pure arithmetic over the diff — no browser, no model, no write — so it is cheap
// enough to run live. It drives the Save button's own LABEL: the cost is stated on the control
// that spends it, not in a dialog after the fact.

function scheduleCaseEstimate(repaint) {
  if (!caseEditor) return;
  clearTimeout(caseEditor.estimateTimer);
  caseEditor.estimateTimer = setTimeout(() => runCaseEstimate(repaint), 400);
}

async function runCaseEstimate(repaint) {
  if (!caseEditor || caseEditorBusy()) return;
  const editor = caseEditor;
  const forLines = JSON.stringify(caseLinesPayload());

  if (!caseEditorDirty()) {
    editor.estimate = null;
    editor.estimateError = "";
    return refreshCaseSaveAffordance();
  }

  try {
    const est = await api(`/api/cases/${encodeURIComponent(editor.caseId)}/steps/estimate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps: JSON.parse(forLines), expectedVersion: editor.currentVersion }),
    });
    // The user kept typing while this was in flight — its answer is about older text.
    if (caseEditor !== editor || JSON.stringify(caseLinesPayload()) !== forLines) return;
    editor.estimate = est;
    editor.estimateError = "";
  } catch (err) {
    if (caseEditor !== editor) return;
    editor.estimate = null;
    // A malformed sentence fails here first, which is the cheapest possible place to learn it.
    editor.estimateError = err.message;
  }
  refreshCaseSaveAffordance();
}

/** Update just the Save label and the will-verify markers, WITHOUT a repaint — a repaint mid-typing
 *  would steal focus out of the input the user is still in. */
function refreshCaseSaveAffordance() {
  const btn = document.getElementById("cdSave");
  const hint = document.getElementById("cdSaveHint");
  if (!btn || !caseEditor) return;

  const dirty = caseEditorDirty();
  const est = caseEditor.estimate;
  btn.disabled = !dirty || caseEditorBusy();

  // Typing does not repaint (that would steal the caret), so the UNSAVED badge has to be
  // toggled here rather than re-rendered — otherwise it only ever appears after a structural
  // change, which is exactly when the user is least likely to be looking for it.
  const unsaved = document.getElementById("cdUnsaved");
  if (unsaved) unsaved.style.display = dirty ? "" : "none";

  if (!dirty) {
    btn.textContent = "Save";
    if (hint) hint.textContent = "";
  } else if (caseEditor.estimateError) {
    btn.textContent = "Save";
    if (hint) hint.textContent = "";
  } else if (!est) {
    btn.textContent = "Save";
    if (hint) hint.textContent = "Checking what this will cost…";
  } else if (est.instant) {
    btn.textContent = "Save";
    if (hint) hint.textContent = "No steps need re-checking.";
  } else {
    const s = est.stepsToVerify === 1 ? "step" : "steps";
    btn.textContent = `Save — re-checks ${est.stepsToVerify} ${s} (~${est.estimatedSeconds}s)`;
    // maxLlmCalls is a CEILING. Grounding is DOM-first and usually spends none, so promising
    // "N model calls" would make the common zero-cost save read as a bug.
    if (hint) {
      const cost = est.maxLlmCalls
        ? `Opens the site to re-check the marked ${s} · up to ${est.maxLlmCalls} model call${est.maxLlmCalls === 1 ? "" : "s"}.`
        : `Opens the site to re-check the marked ${s}.`;
      // Said BEFORE the click. A sign-in request that arrives unannounced mid-save is the kind of
      // thing people refuse on reflex — and refusing it here means the check simply cannot run.
      hint.textContent = est.needsCredentials
        ? `${cost} The step is behind a login, so this will sign in first.`
        : cost;
    }
  }

  const verify = new Set(est?.stepIdsToVerify ?? []);
  document.querySelectorAll("#cdLines .cd-line").forEach((row) => {
    row.classList.toggle("will-verify", !caseEditorBusy() && verify.has(row.dataset.sid));
  });

  const errEl = document.getElementById("cdEstimateError");
  if (!errEl) return;
  if (!caseEditor.estimateError) { errEl.innerHTML = ""; return; }

  // The estimate is the cheapest place a badly-worded line surfaces — it runs while the person is
  // still typing, before any browser or save. So it is also the right place to offer the way out.
  // Rendered HERE rather than in paintStepsTab because this function deliberately does not
  // repaint: a repaint mid-typing steals the caret out of the line being fixed.
  const offer = caseEditor.nlSteps && roleAtLeast(auth.role, "tester");
  errEl.innerHTML = `
    <p class="team-error">${escapeHtml(caseEditor.estimateError)}</p>
    ${offer ? `<button type="button" class="dl-btn-inline" id="cdTranslate">Write it for me</button>` : ""}`;
  const tb = document.getElementById("cdTranslate");
  if (tb) tb.addEventListener("click", () => doTranslateSteps(tb));
}

/**
 * Ask the server to say the unreadable line(s) in the vocabulary the parser accepts.
 *
 * Sends the CURRENT draft, gets back a proposal, and puts it in exactly the same `caseEditor
 * .proposal` slot the "Ask for a change" card uses — so it renders through the same diff, is
 * approved with the same Apply button, and Apply still only FILLS the editor. Nothing here is a
 * shortcut past Save: the sentences still get parsed, still get re-grounded, still mint a version.
 * A second approval path would be a second set of guarantees.
 */
async function doTranslateSteps(btn) {
  if (!caseEditor) return;
  const editor = caseEditor;
  btn.disabled = true;
  // Same direct-DOM approach, and here it is required rather than merely preferred: the
  // function that renders this button documents that it must NOT repaint, because a repaint
  // mid-typing steals the caret out of the line being fixed.
  btn.classList.add("ai-busy");
  btn.innerHTML = `${SPIN_ICON} Writing…`;
  try {
    const proposal = await api(`/api/cases/${encodeURIComponent(editor.caseId)}/steps/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps: caseLinesPayload() }),
    });
    if (caseEditor !== editor) return;
    editor.proposal = proposal;
    editor.notice = "";
  } catch (err) {
    if (caseEditor !== editor) return;
    editor.proposal = null;
    editor.estimateError = err.message;
  }
  editor.repaint?.();
}

// ------------------------------------------------------------------------ save

/**
 * @param confirmNoAssertion true only when the person answered the "this removes the last check"
 *        refusal by pressing "Save without a check". Never sent otherwise, so the server keeps
 *        refusing by default. TD-89.
 */
async function saveCaseSteps(c, repaint, confirmNoAssertion = false) {
  if (!caseEditor || !caseEditorDirty()) return;
  const editor = caseEditor;
  editor.errorAt = null;
  editor.errorMsg = "";
  editor.notice = "";
  editor.conflict = null;
  editor.needsConfirmation = "";

  const btn = document.getElementById("cdSave");
  if (btn) {
    btn.disabled = true;
    // Covers the POST window only. Once the server answers with a job, the `.cd-job` banner
    // and the per-row verifying states take over. Every exit from this function ends in a
    // repaint that rebuilds this button, so the spinner cannot get stuck.
    btn.classList.add("ai-busy");
    btn.innerHTML = `${SPIN_ICON} Saving…`;
  }

  let res;
  try {
    res = await fetch(`/api/cases/${encodeURIComponent(editor.caseId)}/steps`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        steps: caseLinesPayload(),
        // Held from the moment the case loaded. This is what turns a silent clobber into a
        // visible conflict.
        expectedVersion: editor.currentVersion,
        changeNote: "Edited steps",
        // Optional and absent unless the person explicitly confirmed — an additive request
        // field, so nothing that does not send it changes behaviour (rule 1).
        ...(confirmNoAssertion ? { confirmNoAssertion: true } : {}),
      }),
    });
  } catch (err) {
    editor.errorMsg = String(err.message ?? err);
    return repaint();
  }

  const body = await res.json().catch(() => ({}));

  if (res.status === 409) {
    editor.conflict = body;
    return repaint();
  }
  if (!res.ok) {
    editor.errorMsg = body.error || `That didn't work (${res.status}).`;
    // The server names the offending step, so the message lands on that row rather than
    // floating above a list of nine.
    editor.errorAt = typeof body.stepIndex === "number" ? body.stepIndex : null;
    // A refusal the person can answer rather than a broken row: no step is at fault, so there is
    // no `stepIndex`, and the message needs a button beside it instead of a row highlight.
    editor.needsConfirmation = typeof body.needsConfirmation === "string" ? body.needsConfirmation : "";
    return repaint();
  }

  // ---- fast path: nothing pointed anywhere new, so nothing had to be verified.
  if (res.status === 200) {
    return finishCaseSave(body, repaint);
  }

  // ---- job path
  editor.job = {
    jobId: body.jobId,
    total: body.stepsToVerify ?? 0,
    done: 0,
    states: {},
    seen: 0,
    timer: null,
    cancelling: false,
  };
  (body.stepIdsToVerify ?? []).forEach((id) => { editor.job.states[id] = "pending"; });
  repaint();
  pollCaseJob(c, repaint);
}

/** Shared tail of both save paths. */
function finishCaseSave(payload, repaint) {
  const steps = payload.steps ?? payload.case?.steps;
  const updated = payload.case ?? payload;
  caseEditor.job = null;
  caseEditor.lines = (steps ?? caseLinesPayload().map((t, i) => ({ id: `s${i + 1}`, text: t })))
    .map((s) => ({ id: s.id, text: s.text }));
  caseEditor.original = JSON.stringify(caseLinesPayload());
  caseEditor.currentVersion = updated.currentVersion ?? caseEditor.currentVersion;
  caseEditor.estimate = null;
  // A credential the person typed was swapped back to an ${env:...} reference before storing
  // (TECH_DEBT.md TD-67). Say so on the same line as the save confirmation — silently changing
  // what someone typed is worse than not accepting it, and they need to know the value will be
  // asked for at run time instead.
  const credNote = payload.credentialNote ?? payload.case?.credentialNote ?? "";
  caseEditor.notice = credNote
    ? `Saved as v${caseEditor.currentVersion}. ${credNote}`
    : `Saved as v${caseEditor.currentVersion}.`;
  toast(`Saved as v${caseEditor.currentVersion}.`);
  caseEditor.reloadNeeded = true;
  repaint();
}

/**
 * Follow a re-ground.
 *
 * Polls /state rather than opening an EventSource: this codebase already established that pattern
 * for runs (SSE buffers behind a Cloudflare tunnel and only flushes on close — see the comment on
 * /api/runs/:runId/events), and the same reasoning applies unchanged here. The route is offered as
 * SSE with /state as the poll fallback; this takes the fallback deliberately.
 */
async function pollCaseJob(c, repaint) {
  if (!caseEditor?.job) return;
  const editor = caseEditor;
  const job = editor.job;

  let events = [];
  try {
    events = await api(
      `/api/cases/${encodeURIComponent(editor.caseId)}/steps/jobs/${encodeURIComponent(job.jobId)}/state`);
  } catch (err) {
    // The server restarted, or the session expired. Job state is in memory, so the edit is simply
    // not saved — say that rather than spinning forever.
    if (caseEditor !== editor) return;
    editor.job = null;
    editor.errorMsg = `Lost track of this save (${err.message}). Nothing was saved — press Save to try again.`;
    return repaint();
  }
  if (caseEditor !== editor || editor.job !== job) return;

  let terminal = null;
  for (const ev of events.slice(job.seen)) {
    job.seen++;
    if (ev.stage === "ir" && ev.data?.stepId) {
      const { stepId, done, total, phase } = ev.data;
      if (phase === "walking" || phase === "grounding") {
        Object.keys(job.states).forEach((id) => {
          if (job.states[id] === "verifying") job.states[id] = "ok";
        });
        if (job.states[stepId] !== undefined) job.states[stepId] = "verifying";
        job.done = typeof done === "number" ? done : job.done;
        if (typeof total === "number" && total) job.total = total;
      }
    }
    // The walk is parked on a login it has no credentials for. Same modal a run uses — it posts
    // to the job instead of a run, which is the only difference between the two cases.
    if (ev.stage === "credentials") {
      if (ev.status === "started") {
        showCredentialPrompt(job.jobId, ev.data,
          `/api/cases/${encodeURIComponent(editor.caseId)}/steps/jobs/${encodeURIComponent(job.jobId)}/credentials`);
      } else {
        // Answered, skipped, or timed out server-side. Close it either way so a stale form can't
        // sit over a job that has already moved on.
        if (credRunId === job.jobId) hideCredentialPrompt();
      }
    }
    if (ev.stage === "done" || ev.stage === "error") terminal = ev;
  }

  if (!terminal) {
    job.timer = setTimeout(() => pollCaseJob(c, repaint), 800);
    paintCaseJobBanner();
    return;
  }

  // ---- terminal
  // However this ended — saved, failed, cancelled — a credential form still open belongs to a job
  // that no longer exists, and answering it would 409.
  if (credRunId === job.jobId) hideCredentialPrompt();

  const d = terminal.data ?? {};
  if (terminal.stage === "done" && d.saved) {
    return finishCaseSave(d, repaint);
  }

  editor.job = null;

  if (d.cancelled) {
    // Cancel is NOT an undo: nothing was written, so there is nothing to undo. Saying "reverted"
    // would send someone looking for a version that was never created.
    editor.notice = "Cancelled — nothing was saved. Your edits are still here.";
    return repaint();
  }
  if (d.conflict) {
    editor.errorMsg =
      `${terminal.error || "Someone else saved while this was verifying."} Reload to see their version.`;
    return repaint();
  }

  editor.errorMsg = terminal.error || "That save could not be verified.";
  editor.errorAt = typeof d.stepIndex === "number" ? d.stepIndex : null;
  // Two shapes, two remedies. "could not reach" means an EARLIER step is the real problem, so the
  // marker belongs on where the walk stopped — not on the step that was edited.
  editor.errorKind = /could not reach|never arrived|failed to reach/i.test(editor.errorMsg)
    ? "reach" : "ground";
  repaint();
}

/** Repaint only the banner, so progress updates don't tear down the right column. */
function paintCaseJobBanner() {
  const el = document.getElementById("cdJob");
  if (!el || !caseEditor?.job) return;
  const job = caseEditor.job;
  el.innerHTML = `
    <div class="cd-job">
      <span class="cd-job-text ai-busy">${SPIN_ICON}${job.cancelling
        ? "Cancelling… the page being checked has to finish first."
        : `Verifying ${Math.min(job.done + 1, job.total)} of ${job.total}…`}</span>
      <button type="button" class="dl-btn-inline" id="cdCancel"${job.cancelling ? " disabled" : ""}>Cancel</button>
    </div>`;
  const cancel = document.getElementById("cdCancel");
  if (cancel) cancel.addEventListener("click", cancelCaseJob);
  document.querySelectorAll("#cdLines .cd-line").forEach((row) => {
    const st = job.states[row.dataset.sid];
    row.classList.toggle("is-pending", st === "pending");
    row.classList.toggle("is-verifying", st === "verifying");
    row.classList.toggle("is-ok", st === "ok");
    const stateEl = row.querySelector(".cd-line-state");
    if (stateEl) stateEl.textContent = st === "verifying" ? "verifying…" : st === "ok" ? "ok" : st === "pending" ? "pending" : "";
  });
}

async function cancelCaseJob() {
  if (!caseEditor?.job || caseEditor.job.cancelling) return;
  caseEditor.job.cancelling = true;
  paintCaseJobBanner();
  try {
    await api(
      `/api/cases/${encodeURIComponent(caseEditor.caseId)}/steps/jobs/${encodeURIComponent(caseEditor.job.jobId)}/cancel`,
      { method: "POST" });
  } catch { /* the poll will report whatever actually happened */ }
}

// --------------------------------------------------------------------- the view

/** The canonical hash for a case. Falls back to the legacy shape when the caller has no project
 *  to hand — applyRoute resolves that one from the case and rewrites the URL in place, so the
 *  fallback is a working link rather than a dead one. */
const caseHash = (projectId, caseId) =>
  projectId
    ? `#/projects/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(caseId)}`
    : `#/case/${encodeURIComponent(caseId)}`;

async function renderCaseView(caseId, routeProjectId) {
  // An editor belongs to exactly one case. Rendering a different one drops it — the route guard
  // has already asked about unsaved work by this point, so anything still here was abandoned.
  if (caseEditor && caseEditor.caseId !== caseId) { stopFollowingCaseJob(); caseEditor = null; }

  const body = document.getElementById("caseViewBody");
  body.innerHTML = `<div class="tree-empty" style="padding:36px 16px;text-align:center">Loading…</div>`;

  let c, stepsDoc;
  try {
    [c, stepsDoc] = await Promise.all([
      api(`/api/cases/${encodeURIComponent(caseId)}`),
      api(`/api/cases/${encodeURIComponent(caseId)}/steps`),
    ]);
  } catch (err) {
    // Includes the 503 when there is no database configured — this screen reads library rows, so
    // it cannot degrade to anything useful. Say why rather than throwing into the console.
    body.innerHTML =
      `<div class="tree-empty" style="padding:36px 16px;text-align:center">${escapeHtml(err.message)}</div>`;
    return;
  }

  // The route may not carry a project (an old `#/case/:id` link). Resolve it from the case and
  // quietly make the URL canonical — replaceState fires no hashchange, so this cannot re-render.
  const projectId = c.projectId;
  if (routeProjectId !== projectId) {
    const want = caseHash(projectId, caseId);
    if (location.hash !== want) {
      history.replaceState(null, "", want);
      lastHash = want;
    }
  }

  // Same missing escape hatch as the Suite screen above, with the same effect under
  // AUTH_ENABLED=false. (The Team screen's own roleAtLeast gate is deliberately left alone: it is
  // only reachable when auth is on, so it has no flag-off path to get wrong.)
  const canAuthor = !auth.required || roleAtLeast(auth.role, "tester");
  const canDelete = !auth.required || roleAtLeast(auth.role, "admin");

  // Names for the breadcrumb. Both are best-effort: a missing one degrades to a quieter crumb
  // rather than blocking the screen the user asked for.
  let projectName = "", suiteName = "";
  try {
    const p = (projectsCache ?? []).find((x) => x.id === projectId);
    projectName = p?.name ?? "";
    if (c.suiteIds?.length) {
      const suites = (await api(`/api/suites?projectId=${encodeURIComponent(projectId)}`)).suites ?? [];
      suiteName = suites.find((s) => c.suiteIds.includes(s.id))?.name ?? "";
    }
  } catch { /* breadcrumb only */ }

  setCrumbs([projectName || "Case", c.title]);

  if (!caseEditor) {
    caseEditor = {
      caseId,
      lines: stepsDoc.steps.map((s) => ({ id: s.id, text: s.text })),
      original: JSON.stringify(stepsDoc.steps.map((s) => s.text)),
      currentVersion: c.currentVersion,
      expected: stepsDoc.expected ?? "",
      estimate: null, estimateTimer: null, estimateError: "",
      job: null, errorAt: null, errorMsg: "", errorKind: "",
      conflict: null, askText: "", proposal: null, notice: "", reloadNeeded: false,
      // Whether this server will translate loosely-typed lines. Comes from the server rather
      // than being assumed, because the browser has no parser and no Gemini key of its own —
      // guessing would mean offering a button that 404s.
      nlSteps: stepsDoc.nlSteps === true,
    };
  } else if (caseEditor.reloadNeeded) {
    // A save landed: adopt the server's canonical version/steps without losing the notice.
    caseEditor.reloadNeeded = false;
    caseEditor.currentVersion = c.currentVersion;
  }

  const repaint = () => {
    if (caseEditor?.reloadNeeded) return renderCaseView(caseId, projectId);
    paintCaseScreen();
  };
  // Module-scope helpers (refreshCaseSaveAffordance, doTranslateSteps) live outside this
  // closure and still need a way to redraw. They get the SAME `repaint` the rest of the screen
  // uses, so a reload-needed editor is honoured identically no matter who triggered the paint.
  caseEditor.repaint = repaint;

  function paintCaseScreen() {
    const dirty = caseEditorDirty();
    const busy = caseEditorBusy();

    body.innerHTML = `
      <div class="cd-head">
        <div class="cd-head-main">
          <div class="cd-crumb">${escapeHtml([projectName, suiteName].filter(Boolean).join(" / ") || "TEST CASE")}</div>
          <div class="cd-meta">
            <span class="case-badge ${caseBadgeClass(c.lastRunStatus)}">${escapeHtml(caseStatusLabel(c.lastRunStatus))}</span>
            <span class="cd-version">v${caseEditor.currentVersion} · ${c.versions.length} version${c.versions.length === 1 ? "" : "s"}</span>
            <span class="case-badge badge-truncated" id="cdUnsaved"${dirty ? "" : ` style="display:none"`}>UNSAVED</span>
            ${c.ir?.meta?.hasTerminalAssertion === false
              // A case that checks nothing runs to the end and reports Passed. Saying so on the
              // case itself is the whole point of TD-89 — the flag exists, it was simply never
              // recomputed on edit and never surfaced. Reuses `.case-badge badge-truncated`,
              // the existing "this is partial" pill (rule 3).
              ? `<span class="case-badge badge-truncated" title="This test runs to the end without verifying anything, so it can only report Passed.">NO CHECK</span>`
              : ""}
            ${c.scriptOverridden
              // The steps below are NOT what runs. Says so in the one place a reader always looks
              // before believing a case does what its title claims. Reuses the existing
              // "this is not the whole story" pill rather than minting a class (rule 3).
              ? `<span class="case-badge badge-truncated" title="A hand-written script replaces this case's generated one. The steps below no longer describe what runs.">SCRIPT OVERRIDE</span>`
              : ""}
          </div>
          <input class="cd-title" id="cdTitle" value="${escapeHtml(c.title)}"
                 ${canAuthor ? "" : "readonly"} aria-label="Case title" />
          <p class="cd-why">${escapeHtml(c.ir?.meta?.sourcePrompt || c.feature || "No description recorded for this case.")}</p>
        </div>
        <div class="cd-actions">
          ${canAuthor ? `<button type="button" class="dl-btn-inline cd-save" id="cdSave" disabled>Save</button>` : ""}
          ${canAuthor ? `<button type="button" class="dl-btn-inline" data-act="duplicate">Duplicate</button>` : ""}
          ${c.versions.length > 1 ? `<button type="button" class="dl-btn-inline" data-act="compare">Compare versions</button>` : ""}
          ${canDelete ? `<button type="button" class="dl-btn-inline" data-act="delete">Delete case</button>` : ""}
          ${canAuthor ? `<button type="button" class="run-btn lib-run-all" data-act="run">${icon("play", { size: 13 })} Run case</button>` : ""}
        </div>
      </div>

      <div id="caseFeedback">
        ${caseEditor.notice ? `<p class="team-ok">${escapeHtml(caseEditor.notice)}</p>` : ""}
        ${caseEditor.errorMsg && caseEditor.errorAt === null
          ? `<p class="team-error">${escapeHtml(caseEditor.errorMsg)}</p>` : ""}
        ${caseEditor.needsConfirmation === "noAssertion"
          // A refusal the person can answer, not a dead end. Re-submits the same steps with
          // `confirmNoAssertion`, which is the only thing the server is waiting for. Reuses the
          // existing button classes — no new CSS (rule 3). TD-89.
          ? `<button type="button" class="run-btn lib-run-all" data-act="save-no-assertion">Save without a check</button>`
          : ""}
      </div>
      <div id="cdConflict">${caseEditor.conflict ? conflictHtml(caseEditor.conflict) : ""}</div>
      <div id="caseSuites"></div>

      <div class="seg" id="caseTabs" role="group" aria-label="Case sections">
        <button type="button" class="seg-btn${caseTab === "steps" ? " active" : ""}" data-tab="steps">Steps</button>
        <button type="button" class="seg-btn${caseTab === "script" ? " active" : ""}" data-tab="script">Script</button>
        <button type="button" class="seg-btn${caseTab === "runs" ? " active" : ""}" data-tab="runs">Runs &amp; versions</button>
      </div>
      <div id="caseBody"></div>`;

    paintSuites();
    paintTabBody();
    wireHeader();
  }

  function conflictHtml(k) {
    const mine = caseLinesPayload();
    const theirs = (k.current?.steps ?? []).map((s) => s.text);
    return `
      <div class="cd-conflict">
        <div class="cd-conflict-head">${escapeHtml(k.error || "This case changed while you were editing it.")}</div>
        <div class="cd-conflict-cols">
          <div class="cd-conflict-col">
            <h4>Your steps</h4>
            <ol>${mine.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ol>
          </div>
          <div class="cd-conflict-col">
            <h4>Theirs — v${k.currentVersion}</h4>
            <ol>${theirs.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}</ol>
          </div>
        </div>
        <div class="cd-conflict-actions">
          <button type="button" class="dl-btn-inline" data-conflict="theirs">Discard mine, use theirs</button>
          <button type="button" class="dl-btn-inline" data-conflict="mine">Keep mine on top of theirs</button>
        </div>
      </div>`;
  }

  function paintTabBody() {
    const el = document.getElementById("caseBody");
    if (caseTab === "steps") return paintStepsTab(el);
    if (caseTab === "script") return paintScriptTab(el);
    return paintRunsTab(el);
  }

  // ---------------------------------------------------------------- steps tab

  function paintStepsTab(el) {
    const busy = caseEditorBusy();
    const verify = new Set(caseEditor.estimate?.stepIdsToVerify ?? []);

    el.innerHTML = `
      <div class="cd-cols">
        <div class="cd-left">
          <div class="cd-card">
            <div class="cd-card-head">Steps — edit in plain English</div>
            ${c.scriptOverridden ? `
              <p class="team-error">
                <strong>A script override is in effect. These steps do not describe what runs.</strong>
                This case runs a hand-written Playwright script instead of the one generated from the
                steps below. The script is not grounded: no locator in it is verified against a real
                discovered element, so when it breaks it fails silently rather than loudly. Editing
                these steps is recorded and versioned, but it will not change what this case does
                until the override is removed.
              </p>` : ""}
            <div id="cdJob"></div>
            <div id="cdEstimateError"></div>
            <div class="cd-lines" id="cdLines">
              ${caseEditor.lines.map((l, i) => lineHtml(l, i, verify, busy)).join("")}
            </div>
            ${canAuthor && !busy ? `<button type="button" class="cd-add" id="cdAdd">+ Add step</button>` : ""}
            <div class="cd-expected">
              <div class="cd-card-head">Expected outcome</div>
              <div class="cd-expected-value">${escapeHtml(caseEditor.expected || "Not recorded.")}</div>
            </div>
            ${canAuthor ? `<p class="hrow-meta" id="cdSaveHint" style="margin-top:10px"></p>` : ""}
            <p class="hrow-meta" style="margin-top:6px" title="${escapeHtml(c.ir?.meta?.baseUrl ?? "")}">Target: ${escapeHtml(displayUrl(c.ir?.meta?.baseUrl))}</p>
          </div>
        </div>
        <div class="cd-right">
          ${canAuthor && c.scriptOverridden ? `
            <div class="cd-card cd-card-inset">
              <div class="cd-card-label">Ask for a change</div>
              <p class="hrow-meta">Unavailable while a script override is in effect — a rewrite would
              change the steps, and the steps are not what runs.</p>
            </div>` : ""}
          ${canAuthor && !c.scriptOverridden ? `
            <div class="cd-card cd-card-inset">
              <div class="cd-card-label">Ask for a change</div>
              <textarea class="cd-ask-text" id="cdAsk" placeholder="also assert the order total is unchanged"
                        ${busy ? "disabled" : ""}>${escapeHtml(caseEditor.askText)}</textarea>
              <button type="button" class="cd-ask-btn" id="cdRewrite"${busy ? " disabled" : ""}>Rewrite steps</button>
              <div id="cdProposal">${caseEditor.proposal ? proposalHtml(caseEditor.proposal) : ""}</div>
            </div>` : ""}
          <div class="cd-card">
            <div class="cd-card-head">Latest result</div>
            <div class="cd-meta">
              <span class="case-badge ${caseBadgeClass(c.lastRunStatus)}">${escapeHtml(caseStatusLabel(c.lastRunStatus))}</span>
              <span class="hrow-meta" id="cdLastMeta">${c.lastRunAt ? escapeHtml(formatWhen(c.lastRunAt)) : "Never run"}</span>
            </div>
            <div id="cdShot">
              <div class="cd-shot"><span class="cd-shot-label">no screenshot yet</span></div>
            </div>
          </div>
        </div>
      </div>`;

    wireSteps();
    refreshCaseSaveAffordance();
    if (busy) paintCaseJobBanner();
    paintLatestResult();
  }

  function lineHtml(l, i, verify, busy) {
    const st = caseEditor.job?.states?.[l.id];
    const bad = caseEditor.errorAt === i;
    const cls = [
      "cd-line",
      !busy && verify.has(l.id) ? "will-verify" : "",
      st === "pending" ? "is-pending" : st === "verifying" ? "is-verifying" : st === "ok" ? "is-ok" : "",
      bad ? "is-bad" : "",
    ].filter(Boolean).join(" ");

    return `
      <div class="${cls}" data-sid="${escapeHtml(l.id)}">
        <span class="cd-line-num">${i + 1}</span>
        <input class="cd-line-input" type="text" data-i="${i}"
               value="${escapeHtml(l.text)}" ${canAuthor && !busy ? "" : "disabled"} />
        ${busy ? `<span class="cd-line-state">${st === "verifying" ? "verifying…" : st === "ok" ? "ok" : st === "pending" ? "pending" : ""}</span>` : ""}
        ${canAuthor && !busy ? `
          <button type="button" class="cd-line-btn" data-ed="up" data-i="${i}" title="Move up"${i === 0 ? " disabled" : ""}>↑</button>
          <button type="button" class="cd-line-btn" data-ed="down" data-i="${i}" title="Move down"${i === caseEditor.lines.length - 1 ? " disabled" : ""}>↓</button>
          <button type="button" class="cd-line-btn cd-line-del" data-ed="del" data-i="${i}" title="Remove">×</button>` : ""}
      </div>
      ${bad ? `<p class="cd-line-err">${escapeHtml(caseEditor.errorMsg)}${
        caseEditor.errorKind === "reach"
          ? " — an earlier step is the real problem; this is where the walk stopped."
          : ""}</p>` : ""}`;
  }

  function wireSteps() {
    // `input` updates state and re-estimates but does NOT repaint — a repaint mid-typing would
    // steal the caret. The full repaint happens on structural changes only.
    document.querySelectorAll("#cdLines .cd-line-input").forEach((input) => {
      input.addEventListener("input", () => {
        caseEditor.lines[Number(input.dataset.i)].text = input.value;
        caseEditor.errorAt = null;
        caseEditor.errorMsg = "";
        caseEditor.notice = "";
        scheduleCaseEstimate(repaint);
        refreshCaseSaveAffordance();
      });
    });

    document.querySelectorAll("#cdLines [data-ed]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const i = Number(btn.dataset.i);
        const act = btn.dataset.ed;
        const lines = caseEditor.lines;
        caseEditor.errorAt = null; caseEditor.errorMsg = ""; caseEditor.notice = "";
        if (act === "up") [lines[i - 1], lines[i]] = [lines[i], lines[i - 1]];
        if (act === "down") [lines[i + 1], lines[i]] = [lines[i], lines[i + 1]];
        if (act === "del") lines.splice(i, 1);
        scheduleCaseEstimate(repaint);
        paintTabBody();
      });
    });

    const add = document.getElementById("cdAdd");
    if (add) add.addEventListener("click", () => {
      caseEditor.lines.push({ id: nextLineId(caseEditor.lines), text: 'Click on button "Submit"' });
      caseEditor.notice = "";
      scheduleCaseEstimate(repaint);
      paintTabBody();
    });

    const ask = document.getElementById("cdAsk");
    if (ask) ask.addEventListener("input", () => { caseEditor.askText = ask.value; });

    const rewrite = document.getElementById("cdRewrite");
    if (rewrite) rewrite.addEventListener("click", () => doRewrite(rewrite));

    document.querySelectorAll("#cdProposal [data-prop]").forEach((b) => {
      b.addEventListener("click", () => {
        if (b.dataset.prop === "apply") {
          // Apply only FILLS the editor. The user still presses Save, still sees the estimate,
          // still gets the re-ground — one way into the library, whoever wrote the sentences.
          const proposed = caseEditor.proposal.steps;
          caseEditor.lines = proposed.map((text, i) => ({
            id: caseEditor.lines[i]?.id ?? `s${i + 1}`, text,
          }));
          caseEditor.notice = "Proposal applied to the editor — nothing is saved until you press Save.";
          // The line that failed to parse has just been replaced, so the message about it is
          // already wrong. Clearing it now rather than waiting for the next estimate keeps the
          // "Write it for me" button from sitting under a proposal the user just accepted.
          caseEditor.estimateError = "";
        }
        caseEditor.proposal = null;
        scheduleCaseEstimate(repaint);
        paintCaseScreen();
      });
    });
  }

  async function doRewrite(btn) {
    const instruction = (caseEditor.askText || "").trim();
    if (!instruction) { caseEditor.errorMsg = "Say what you would like changed."; return paintCaseScreen(); }
    btn.disabled = true;
    // Presentation only. Deliberately still a direct DOM write rather than a state flag +
    // repaint: paintCaseScreen() rebuilds this button from scratch when the request settles,
    // so the busy look cannot outlive the request, and a pre-request repaint would be a
    // behaviour change nobody asked for.
    btn.classList.add("ai-busy");
    btn.innerHTML = `${SPIN_ICON} Asking…`;
    try {
      caseEditor.proposal = await api(`/api/cases/${encodeURIComponent(caseId)}/rewrite`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction }),
      });
      caseEditor.errorMsg = "";
    } catch (err) {
      caseEditor.errorMsg = err.message;
      caseEditor.proposal = null;
    }
    paintCaseScreen();
  }

  function proposalHtml(p) {
    // Reuses the Compare screen's LCS diff so an inserted step shifts nothing after it.
    const { left, right } = diffSteps(p.before, p.steps);
    const rows = [];
    left.forEach((l) => { if (l.k === "removed") rows.push({ k: "del", t: l.t }); });
    right.forEach((r) => rows.push({ k: r.k === "added" ? "add" : "same", t: r.t }));
    // Both the rewrite and the translation land here. `translatedIndexes` is what distinguishes
    // them, and the heading matters: "we changed your test" and "we spelled your test properly"
    // deserve different amounts of scrutiny from the person about to approve the diff.
    const translated = Array.isArray(p.translatedIndexes);
    return `
      <div class="cd-proposal">
        <p class="cd-proposal-note">${translated
          ? `Re-worded line${p.translatedIndexes.length === 1 ? "" : "s"} ${
              p.translatedIndexes.map((i) => i + 1).join(", ")} — the rest is untouched.`
          : "Proposed change"}</p>
        ${p.note ? `<p class="cd-proposal-note">${escapeHtml(p.note)}</p>` : ""}
        <div class="cd-diff">
          ${rows.map((r) => `<div class="cd-diff-line cd-diff-${r.k}">${escapeHtml(r.t)}</div>`).join("")}
        </div>
        <div class="cd-proposal-actions">
          <button type="button" class="dl-btn-inline" data-prop="apply">Apply to editor</button>
          <button type="button" class="dl-btn-inline" data-prop="discard">Discard</button>
        </div>
      </div>`;
  }

  /** The last run's final screenshot, read from the artifact the run already wrote. */
  async function paintLatestResult() {
    const el = document.getElementById("cdShot");
    const metaEl = document.getElementById("cdLastMeta");
    if (!el) return;
    let runs = [];
    try { runs = (await api(`/api/cases/${encodeURIComponent(caseId)}/runs`)).runs ?? []; } catch { return; }
    const last = runs[0];
    if (!last) return;

    if (metaEl) {
      metaEl.textContent =
        `${last.ranAt ? formatWhen(last.ranAt) : ""} · v${caseEditor.currentVersion} · ${last.runId}`;
    }
    try {
      const result = await fetch(`/runs/${encodeURIComponent(last.runId)}/${last.resultPath}/05-result.json`)
        .then((r) => (r.ok ? r.json() : null));
      const shot = result?.screenshotUrl;
      if (!shot) return;
      el.innerHTML = `<img class="cd-shot-img" src="${escapeHtml(shot)}" alt="case ${last.caseIndex} · final screenshot" />`;
      el.querySelector("img").addEventListener("click", () =>
        openScreenshotModal(shot, `case ${last.caseIndex} · final screenshot`));
    } catch { /* the hatched placeholder is already correct */ }
  }

  // --------------------------------------------------------------- script tab

  /**
   * The URL of a run artifact that holds this case's executed spec, or "" if none survives.
   *
   * Only ever a SECONDARY link now. Run directories are deleted by `DELETE /api/runs/:runId`, by
   * retention, and simply by cloning the repo (`runs/` is gitignored) — which is exactly why the
   * tab itself no longer depends on one.
   *
   * Chain: newest `run_cases` row whose file actually responds 200, then the case's own source run.
   * The `run_cases` paths are exact (`cases/case-N` comes back with the row). The source run has no
   * stored case index, so it falls back to that run's run-level spec — which is this case's spec
   * when it was saved from a single-case run, and the run's primary case otherwise. That is why it
   * is offered as "the spec from run X" rather than silently rendered as this case's script.
   */
  async function findRunSpecUrl(runs) {
    const candidates = runs.map(
      (r) => `/runs/${encodeURIComponent(r.runId)}/${r.resultPath}/generated.spec.ts`);
    if (c.sourceRunId && !runs.some((r) => r.runId === c.sourceRunId)) {
      candidates.push(`/runs/${encodeURIComponent(c.sourceRunId)}/generated.spec.ts`);
    }
    for (const url of candidates) {
      const ok = await fetch(url, { method: "HEAD" }).then((r) => r.ok).catch(() => false);
      if (ok) return url;
    }
    return "";
  }

  async function paintScriptTab(el) {
    el.innerHTML = `<div class="panel"><div class="tree-empty" style="padding:28px 16px;text-align:center">Loading…</div></div>`;

    // The script belongs to the CASE, not to a run's artifact folder. `GET /api/cases/:id/script`
    // returns the spec stored with this version, or regenerates it from the same IR with the same
    // pure generator (DECISIONS.md D-06) when no stored copy exists. Deleting the run a case came
    // from used to empty this tab even though the case still reported "Passed v1" — TD-68.
    let doc = null;
    let loadError = "";
    try { doc = await api(`/api/cases/${encodeURIComponent(caseId)}/script`); }
    catch (err) { loadError = err.message; }

    let runs = [];
    try { runs = (await api(`/api/cases/${encodeURIComponent(caseId)}/runs`)).runs ?? []; } catch { /* optional */ }

    if (!doc || !doc.spec) {
      el.innerHTML = `
        <div class="panel"><div class="tree-empty" style="padding:34px 16px;text-align:center">
          ${escapeHtml(loadError || "This case has no readable test plan, so no script could be produced.")}
        </div></div>`;
      return;
    }

    const runSpecUrl = await findRunSpecUrl(runs);
    const last = runs[0];
    const provenance = doc.source === "stored"
      ? `Saved with v${doc.version}.`
      : `Generated from the steps of v${doc.version}.`;
    // `download`, not `target="_blank"`: the artifact route serves `.ts` through `res.sendFile`,
    // and Express's mime table maps that extension to `video/mp2t` — opening it in a tab hands the
    // browser a broken media file rather than showing the spec. The old code only ever used
    // `download=` on these links, which is why the mime type never surfaced as a problem before.
    const runLink = runSpecUrl
      ? ` <a class="dl-btn-inline" href="${escapeHtml(runSpecUrl)}" download="${escapeHtml(c.title)} (as run).spec.ts">download the spec from the last run${last && last.ranAt ? ` (${escapeHtml(formatWhen(last.ranAt))})` : ""}</a>`
      : "";

    el.innerHTML = `
      <div class="panel" style="padding:0;overflow:hidden">
        <div class="cd-script-head">
          <span class="cd-script-name">generated.spec.ts</span>
          <a class="dl-btn-inline" id="cdScriptDl" href="#" download="${escapeHtml(c.title)}.spec.ts">Download .spec.ts</a>
        </div>
        <pre class="cd-script-body">${escapeHtml(doc.spec)}</pre>
        <div class="cd-script-foot">${provenance} Edit the steps and press Save to cut a new version.${runLink}</div>
      </div>`;

    // A Blob rather than an href to the route: the endpoint answers JSON, and downloading that
    // under a .spec.ts name would hand the user a file that is not a spec. Revoked on click so a
    // tab left open for a long time is not holding the string alive indefinitely.
    const dl = el.querySelector("#cdScriptDl");
    if (dl) {
      dl.addEventListener("click", (e) => {
        e.preventDefault();
        const url = URL.createObjectURL(new Blob([doc.spec], { type: "text/plain" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = `${c.title || "test"}.spec.ts`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      });
    }
  }

  // ----------------------------------------------------------- runs & versions

  async function paintRunsTab(el) {
    el.innerHTML = `<div class="panel"><div class="tree-empty" style="padding:28px 16px;text-align:center">Loading…</div></div>`;
    let runs = [];
    let runsError = "";
    try { runs = (await api(`/api/cases/${encodeURIComponent(caseId)}/runs`)).runs ?? []; }
    catch (err) { runsError = err.message; }

    el.innerHTML = `
      <div class="cd-cols">
        <div class="cd-left" style="flex:1 1 320px">
          <div class="panel" style="padding:0;overflow:hidden">
            <div class="cd-script-head"><span class="cd-card-head" style="margin:0">Previous runs</span></div>
            <div id="cdRunRows"></div>
          </div>
        </div>
        <div class="cd-right" style="flex:1 1 300px">
          <div class="panel" style="padding:0;overflow:hidden">
            <div class="cd-script-head"><span class="cd-card-head" style="margin:0">Versions</span></div>
            <div id="cdVersionRows"></div>
          </div>
        </div>
      </div>`;

    const rowsEl = document.getElementById("cdRunRows");
    rowsEl.innerHTML = runsError
      ? `<div class="tree-empty" style="padding:24px 16px;text-align:center">${escapeHtml(runsError)}</div>`
      : runs.length
      ? runs.map((r) => `
          <div class="hrow">
            <span class="case-badge ${caseBadgeClass(r.status)}">${escapeHtml(caseStatusLabel(r.status))}</span>
            <div class="hrow-main">
              <div class="hrow-label">${escapeHtml(r.ranAt ? formatWhen(r.ranAt) : r.runId)}</div>
              <div class="hrow-meta">${escapeHtml(r.runId)} · ${escapeHtml(r.resultPath)}</div>
            </div>
            <div class="hrow-actions">
              <button type="button" class="dl-btn-inline" data-run="${escapeHtml(r.runId)}">Open run</button>
            </div>
          </div>`).join("")
      : `<div class="tree-empty" style="padding:28px 16px;text-align:center">
           No runs recorded for this case yet. Run history is indexed from the first replay after the
           case library shipped, so older runs will not appear here.
         </div>`;

    rowsEl.querySelectorAll("[data-run]").forEach((b) =>
      b.addEventListener("click", () => navigate("#/run/" + encodeURIComponent(b.dataset.run))));

    const vEl = document.getElementById("cdVersionRows");
    vEl.innerHTML = c.versions.length
      ? c.versions.map((v) => `
          <div class="hrow">
            <span class="case-badge badge-pending">v${v.version}</span>
            <div class="hrow-main">
              <div class="hrow-label">${escapeHtml(v.changeNote || "No note")}</div>
              <div class="hrow-meta">${escapeHtml(v.savedAt ? formatWhen(v.savedAt) : "")}</div>
            </div>
            <div class="hrow-actions">
              ${v.version !== caseEditor.currentVersion
                ? `<button type="button" class="dl-btn-inline" data-v="${v.version}">Compare with current</button>`
                : `<span class="hrow-meta">current</span>`}
            </div>
          </div>`).join("")
      : `<div class="tree-empty" style="padding:24px 16px;text-align:center">No version history yet.</div>`;

    vEl.querySelectorAll("[data-v]").forEach((b) =>
      b.addEventListener("click", () =>
        navigate(`#/compare/${encodeURIComponent(caseId)}?from=${b.dataset.v}&to=${caseEditor.currentVersion}`)));
  }

  // ------------------------------------------------------------------- wiring

  function wireHeader() {
    document.getElementById("caseTabs").addEventListener("click", (e) => {
      const btn = e.target.closest(".seg-btn");
      if (!btn) return;
      caseTab = btn.dataset.tab;
      document.querySelectorAll("#caseTabs .seg-btn").forEach((b) => b.classList.toggle("active", b === btn));
      paintTabBody();
    });

    const save = document.getElementById("cdSave");
    if (save) save.addEventListener("click", () => saveCaseSteps(c, repaint));

    // The "save it anyway" answer to the removed-last-check refusal. Delegated on the feedback
    // container because the button only exists while that refusal is showing, and this block runs
    // on every repaint. TD-89.
    const feedback = document.getElementById("caseFeedback");
    const confirmBtn = feedback?.querySelector('[data-act="save-no-assertion"]');
    if (confirmBtn) confirmBtn.addEventListener("click", () => saveCaseSteps(c, repaint, true));

    const title = document.getElementById("cdTitle");
    if (title && canAuthor) title.addEventListener("change", async () => {
      const next = title.value.trim();
      if (!next || next === c.title) { title.value = c.title; return; }
      try {
        await api(`/api/cases/${encodeURIComponent(caseId)}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: next }),
        });
        c.title = next;
        toast("Renamed.");
        setCrumbs([projectName || "Case", next]);
      } catch (err) {
        title.value = c.title;
        document.getElementById("caseFeedback").innerHTML = `<p class="team-error">${escapeHtml(err.message)}</p>`;
      }
    });

    document.querySelectorAll("#cdConflict [data-conflict]").forEach((b) => {
      b.addEventListener("click", () => {
        const theirs = (caseEditor.conflict.current?.steps ?? []).map((s) => ({ id: s.id, text: s.text }));
        const mine = caseEditor.lines;
        if (b.dataset.conflict === "theirs") {
          caseEditor.lines = theirs;
          caseEditor.original = JSON.stringify(theirs.map((l) => l.text));
          caseEditor.notice = "Using their version. Your edits are gone.";
        } else {
          // Re-apply your edits on top of theirs, then save against the version that actually won.
          caseEditor.lines = mine;
          caseEditor.original = JSON.stringify(theirs.map((l) => l.text));
          caseEditor.notice = "Your edits are on top of their version — press Save to write them.";
        }
        caseEditor.currentVersion = caseEditor.conflict.currentVersion;
        caseEditor.conflict = null;
        caseEditor.reloadNeeded = false;
        scheduleCaseEstimate(repaint);
        paintCaseScreen();
      });
    });

    body.querySelectorAll(".cd-actions [data-act]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const act = btn.dataset.act;
        try {
          if (act === "run") return startReplay({ caseIds: [caseId] }, `Replayed "${c.title}"`);
          if (act === "compare") {
            const prev = c.versions.find((v) => v.version !== caseEditor.currentVersion);
            return navigate(`#/compare/${encodeURIComponent(caseId)}?from=${prev?.version ?? 1}&to=${caseEditor.currentVersion}`);
          }
          if (act === "duplicate") {
            const copy = await api(`/api/cases/${encodeURIComponent(caseId)}/duplicate`, {
              method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
            });
            toast("Duplicated.");
            stopFollowingCaseJob();
            caseEditor = null;
            await loadProjects();
            return navigate(caseHash(copy.projectId ?? projectId, copy.id));
          }
          if (act === "delete") {
            if (!confirm(`Delete "${c.title}"? This removes it from every suite it is in.`)) return;
            await api(`/api/cases/${encodeURIComponent(caseId)}`, { method: "DELETE" });
            stopFollowingCaseJob();
            caseEditor = null;
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

  /**
   * Which suites this case is in, and a way into another one.
   *
   * `suite_cases` is a join table precisely so a case can live in several suites at once — a login
   * case belongs in both "Smoke" and "Auth". Without this the many-to-many is a schema detail
   * nobody can reach.
   */
  async function paintSuites() {
    const el = document.getElementById("caseSuites");
    if (!el) return;
    let all = [];
    try {
      all = ((await api(`/api/suites?projectId=${encodeURIComponent(projectId)}`)).suites ?? []);
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
        c.suiteIds = [...(c.suiteIds ?? []), suiteId];
        await loadProjects();
        paintSuites();
      } catch (err) {
        pick.disabled = false;
        document.getElementById("caseFeedback").innerHTML =
          `<p class="team-error">${escapeHtml(err.message)}</p>`;
      }
    });
  }

  paintCaseScreen();
  if (caseEditorDirty()) scheduleCaseEstimate(repaint);
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
    navigate(caseHash(c.projectId, caseId)));
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
  const parts = raw.split("/");
  const [head, id] = parts;

  // The case screen has a canonical project-scoped shape and a legacy one. Both land on the same
  // view — the legacy path learns its project from the case itself and rewrites the URL in place,
  // so old links and bookmarks keep working rather than 404ing.
  const caseRoute =
    head === "projects" && parts[2] === "cases" && parts[3]
      ? { caseId: parts[3].split("?")[0], projectId: decodeURIComponent(parts[1]) }
      : head === "case" && id
      ? { caseId: id.split("?")[0], projectId: null }
      : null;

  // Unsaved step edits. Leaving the case they belong to would discard them with no warning, and
  // the back button reaches here too — so the check lives in the router rather than on each link.
  if (restoringHash) { restoringHash = false; lastHash = location.hash; return; }
  const stayingOnCase = !!caseRoute && caseRoute.caseId === caseEditor?.caseId;
  if (caseEditorDirty() && !stayingOnCase) {
    if (!confirm("You have unsaved step changes. Leave and discard them?")) {
      // Guarded: if the hash is somehow already correct this would never fire hashchange, and
      // the flag would poison the next navigation instead.
      if (location.hash !== lastHash) { restoringHash = true; location.hash = lastHash; }
      return;
    }
    stopFollowingCaseJob();
    caseEditor = null;
  }
  // Left the case entirely with a clean editor — stop the progress poll so an abandoned screen
  // isn't still talking to the server.
  if (!stayingOnCase && caseEditor) { stopFollowingCaseJob(); caseEditor = null; }
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
  if (caseRoute) {
    showView("case");
    setCrumbs(["Case"]);
    renderCaseView(caseRoute.caseId, caseRoute.projectId);
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
// Both OFF unless the server says otherwise. /api/health overwrites these with the server's
// real configured defaults a moment later; hardcoding `selfHeal: true` here meant the toggle
// showed ON before the server had been asked, and disagreed with it whenever SELF_HEAL_DEFAULT
// was unset. TD-83.
const optionDefaults = { gateReview: false, selfHeal: false };

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

/**
 * Clear the cached browser walks the step editor uses to verify an edit.
 *
 * Reports the count back in the row's own description line rather than a toast: the popover is
 * already open and about to be dismissed, and a toast for a maintenance action nobody is watching
 * is worse than the number appearing where the button is. Reuses the existing `.settings-row`
 * markup — no new class (rule 3). TECH_DEBT.md TD-85.
 */
const clearWalkCacheBtnEl = document.getElementById("clearWalkCacheBtn");
const clearWalkCacheNoteEl = document.getElementById("clearWalkCacheNote");
const CLEAR_WALK_CACHE_IDLE = clearWalkCacheNoteEl?.textContent ?? "";
if (clearWalkCacheBtnEl) {
  clearWalkCacheBtnEl.addEventListener("click", async () => {
    clearWalkCacheBtnEl.disabled = true;
    clearWalkCacheNoteEl.textContent = "Clearing…";
    try {
      // `window.fetch` is wrapped at the top of this file to attach the bearer token to
      // same-origin requests, so this needs no header of its own.
      const res = await fetch("/api/cache/walks/clear", { method: "POST" });
      const body = await res.json().catch(() => null);
      clearWalkCacheNoteEl.textContent = res.ok
        ? (body?.message ?? "Cleared.")
        : (res.status === 403
          ? "Only an admin can clear the cache."
          : (body?.error ?? "Could not clear the cache."));
    } catch {
      clearWalkCacheNoteEl.textContent = "Could not reach the server.";
    } finally {
      clearWalkCacheBtnEl.disabled = false;
      // Put the description back, so reopening the popover doesn't show a stale result.
      setTimeout(() => { clearWalkCacheNoteEl.textContent = CLEAR_WALK_CACHE_IDLE; }, 6000);
    }
  });
}

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
// Header actions menu — the topbar hamburger
//
// History, Team, Settings, the session badge and Sign out are authored inline in
// index.html and wired up above. This block MOVES those exact nodes into a menu
// panel — appendChild relocates a live node, it does not clone it, so every id,
// every class and every listener bound earlier in this file is still on the same
// element. Nothing here rebinds or re-creates a control.
//
// Open/closed is a NEW class, .hdr-menu-open, and this block never touches
// .hidden: showView() owns .hidden, and the .hidden rules already on Team, the
// badge and Sign out (auth/role gating) must keep meaning exactly what they meant
// before — a menu that also toggled .hidden would fight them.
//
// The Settings popover moves in too, so it renders as an in-flow submenu under
// its own button instead of a second floating card overlapping this one. Its own
// toggle and outside-click handler above are unchanged: the popover sits inside
// the panel, so a click on it is a click inside the menu.
// -----------------------------------------------------------------------------

const topbarActionsEl = document.querySelector(".topbar-actions");

const hdrMenuWrapEl = document.createElement("div");
hdrMenuWrapEl.className = "hdr-menu-wrap";

const hdrMenuBtnEl = document.createElement("button");
hdrMenuBtnEl.type = "button";
hdrMenuBtnEl.id = "hdrMenuBtn";
hdrMenuBtnEl.className = "hdr-menu-btn";
hdrMenuBtnEl.setAttribute("aria-label", "Menu");
hdrMenuBtnEl.setAttribute("aria-haspopup", "true");
hdrMenuBtnEl.setAttribute("aria-expanded", "false");
hdrMenuBtnEl.setAttribute("aria-controls", "hdrMenu");
// Inlined rather than icon(): icons.js has no hamburger, and the three-bar mark is
// the one glyph this file needs that the shared set doesn't carry.
hdrMenuBtnEl.innerHTML =
  '<svg class="icon" width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
  'stroke="currentColor" stroke-width="1.75" stroke-linecap="round" ' +
  'stroke-linejoin="round" aria-hidden="true" focusable="false">' +
  '<path d="M4 6h16M4 12h16M4 18h16"/></svg>';

const hdrMenuEl = document.createElement("div");
hdrMenuEl.id = "hdrMenu";
hdrMenuEl.className = "hdr-menu";
hdrMenuEl.setAttribute("aria-label", "Header actions");

// Order is the order they read in the topbar today; settingsPop follows its own
// button so it opens as a submenu in place.
["historyBtn", "teamBtn", "settingsBtn", "settingsPop", "sessionBadge", "signOutBtn"]
  .forEach((id) => {
    const el = document.getElementById(id);
    if (el) hdrMenuEl.appendChild(el);
  });

hdrMenuWrapEl.appendChild(hdrMenuBtnEl);
hdrMenuWrapEl.appendChild(hdrMenuEl);
if (topbarActionsEl) topbarActionsEl.appendChild(hdrMenuWrapEl);

function hdrMenuIsOpen() { return hdrMenuEl.classList.contains("hdr-menu-open"); }

/** Every control the panel is currently offering, in DOM order. Filtered on
 *  offsetParent so a .hidden Team button or a closed Settings popover is skipped —
 *  arrow keys must not land on something the user cannot see. */
function hdrMenuItems() {
  return Array.from(hdrMenuEl.querySelectorAll("button"))
    .filter((el) => !el.disabled && el.offsetParent !== null);
}

function openHdrMenu(focusFirst) {
  hdrMenuEl.classList.add("hdr-menu-open");
  hdrMenuBtnEl.setAttribute("aria-expanded", "true");
  if (!focusFirst) return;
  const items = hdrMenuItems();
  if (items.length) items[0].focus();
}

function closeHdrMenu(refocus) {
  if (!hdrMenuIsOpen()) return;
  hdrMenuEl.classList.remove("hdr-menu-open");
  hdrMenuBtnEl.setAttribute("aria-expanded", "false");
  if (refocus) hdrMenuBtnEl.focus();
}

// detail === 0 means the click came from Enter/Space, not a pointer: a keyboard
// user gets focus moved into the panel, a mouse user does not have it stolen.
hdrMenuBtnEl.addEventListener("click", (e) => {
  if (hdrMenuIsOpen()) closeHdrMenu(false);
  else openHdrMenu(e.detail === 0);
});

hdrMenuBtnEl.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown") return;
  e.preventDefault();
  openHdrMenu(true);
});

// A chosen action closes the menu. Settings is the exception — its popover lives
// inside this panel, so opening it must leave the panel up.
hdrMenuEl.addEventListener("click", (e) => {
  if (settingsBtnEl.contains(e.target) || settingsPopEl.contains(e.target)) return;
  if (e.target.closest("button")) closeHdrMenu(false);
});

hdrMenuEl.addEventListener("keydown", (e) => {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  const items = hdrMenuItems();
  if (!items.length) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement);
  const next = e.key === "ArrowDown"
    ? (at + 1) % items.length
    : (at <= 0 ? items.length - 1 : at - 1);
  items[next].focus();
});

// Tab out of the last item closes the menu. relatedTarget null means focus went
// nowhere at all — a pointer landing on the panel's own padding — which must NOT
// count as leaving, or clicking inside the menu would dismiss it.
hdrMenuWrapEl.addEventListener("focusout", (e) => {
  if (!e.relatedTarget) return;
  if (hdrMenuWrapEl.contains(e.relatedTarget)) return;
  closeHdrMenu(false);
});

document.addEventListener("click", (e) => {
  if (!hdrMenuIsOpen()) return;
  if (hdrMenuWrapEl.contains(e.target)) return;
  closeHdrMenu(false);
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !hdrMenuIsOpen()) return;
  closeHdrMenu(true);
});

// -----------------------------------------------------------------------------
// Coverage
//
// The Minimal/Standard/Full segmented control was removed from the composer. The
// VALUE stays, pinned to the default the control shipped selected, because it is
// still part of the POST /api/runs body and the server still validates it and
// sizes the run from it (budgetFor() in src/stages/testCases.ts: minimal 2,
// standard 4, full 5 cases). Dropping the field would change an existing route's
// request shape; pinning it means every run behaves exactly as an untouched
// control did.
//
// .seg/.seg-btn stay in style.css on purpose — the case-detail tabs (Steps /
// Script / Runs & versions) reuse both classes.
// -----------------------------------------------------------------------------

const coverage = "standard";

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

/**
 * A URL as a person reads it: no scheme, no trailing slash.
 *
 * Display only. Deliberately NOT normalizeUrlKey() below — that one exists to match
 * normaliseUrlKey() in src/server/projects.ts so a run finds its project row, and it lowercases
 * for that reason. Borrowing it here would both mangle a case-sensitive path and couple a cosmetic
 * choice to a matching rule, so a later tweak to either would silently break the other.
 */
function displayUrl(url) {
  return (url || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
}

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

/**
 * The heading-level "New suite" form, rendered ABOVE the tree because it is not scoped to any one
 * project. A suite must belong to a project — createSuite() in src/server/library.ts takes a
 * required projectId — so the picker is what supplies it. The name and the picker are on separate
 * rows: the sidebar is ~244px wide and a name field plus a project select do not share one.
 */
function topLevelSuiteFormHtml(projects) {
  if (newSuiteFor !== NEW_SUITE_ANY || !canAuthorSuites()) return "";
  // Defensive: the button is already hidden when there are no projects, since there would be no
  // valid id to post against.
  if (!projects.length) return "";
  // Fall back to the first project when the remembered one has gone (deleted, or no longer
  // visible) so the form can never post an id that is not in the list it is showing.
  const chosen = projects.some((p) => p.id === newSuiteProject) ? newSuiteProject : projects[0].id;
  const options = projects
    .map((p) => `<option value="${escapeHtml(p.id)}"${p.id === chosen ? " selected" : ""}>${escapeHtml(p.name)}</option>`)
    .join("");
  return `
    <div class="tree-row tree-suite-new tree-suite-new-top">
      <input type="text" class="suite-new-input" id="newSuiteInput"
             placeholder="Suite name" value="${escapeHtml(newSuiteName)}"
             aria-label="Name for the new suite" />
    </div>
    <div class="tree-row tree-suite-new tree-suite-new-top">
      <select class="suite-new-input" id="newSuiteProject"
              aria-label="Project this suite belongs to">${options}</select>
      <button type="button" class="dl-btn-inline" data-suite-create-top="1">Add</button>
      <button type="button" class="dl-btn-inline" data-suite-cancel="1" title="Cancel">&times;</button>
    </div>
    ${newSuiteError ? `<div class="suite-new-err">${escapeHtml(newSuiteError)}</div>` : ""}`;
}

function renderProjectsTree(runs) {
  if (!sidebarTreeEl) return;

  // Belt-and-braces with `body.role-no-admin #addProjectBtn` in style.css: the class covers the
  // role, this covers the no-database case, where the sidebar is showing URL groupings rather
  // than project rows and there is nothing a create button could write to.
  if (addProjectBtnEl) addProjectBtnEl.classList.toggle("hidden", !canManageProjects());

  // Suites are `tester`+ while projects are `admin`+, so this is NOT the same gate. It also needs
  // at least one project, because a suite has to be created inside one and the form's picker would
  // otherwise have nothing to offer. Deliberately ABOVE the loading return below: `projectsCache`
  // is null on that frame, so the button stays hidden until we know, rather than flashing in.
  if (addSuiteBtnEl) {
    addSuiteBtnEl.classList.toggle("hidden", !canAuthorSuites() || !projectsCache?.length);
  }

  if (projectsCache === null && !projectsUnavailable) {
    sidebarTreeEl.innerHTML = `<div class="tree-empty">Loading projects…</div>`;
    return;
  }

  // No database configured: fall back to the client-side URL grouping this sidebar used before
  // projects were real rows, so that setup looks exactly as it did.
  const projects = projectsCache === null ? groupRunsByUrl(runs) : projectsCache;

  // The inline create/edit form, rendered wherever it is currently open. One markup path for both
  // modes — they differ only in which button label and which handler the Save carries.
  const projectFormHtml = () => `
    <div class="tree-row tree-project-form">
      <input type="text" class="project-form-input" id="projectFormName"
             placeholder="Project name" value="${escapeHtml(projectFormName)}"
             aria-label="Project name" />
      <input type="text" class="project-form-input" id="projectFormUrl"
             placeholder="Base URL (optional)" value="${escapeHtml(projectFormUrl)}"
             aria-label="Base URL, optional" />
      <div class="project-form-actions">
        <button type="button" class="dl-btn-inline" data-project-save="1">${projectFormId ? "Save" : "Create"}</button>
        <button type="button" class="dl-btn-inline" data-project-cancel="1" title="Cancel">×</button>
      </div>
    </div>
    ${projectFormError ? `<div class="suite-new-err">${escapeHtml(projectFormError)}</div>` : ""}`;

  const creating = projectFormOpen && !projectFormId;

  if (!projects.length) {
    // Two very different situations, and telling them apart matters: someone who just signed up
    // has been deliberately given no access yet and needs to know who to ask, whereas an admin
    // with an empty workspace just hasn't run anything. A bare "No projects yet" reads as a bug
    // to the first person.
    const needsAccess = auth.required && auth.role && !roleAtLeast(auth.role, "admin");
    const emptyMsg = needsAccess
      ? `<div class="tree-empty">You're not in any project yet. Ask an admin to add you to one.</div>`
      : `<div class="tree-empty">No projects yet. Use + above to add one.</div>`;
    // An admin with an empty workspace still needs the form — returning only the message here is
    // what would leave a brand-new organisation with no way in.
    sidebarTreeEl.innerHTML = (creating ? projectFormHtml() : "") + emptyMsg;
    if (creating) bindProjectForm();
    return;
  }

  // Bucket the visible runs under their project by URL key.
  const byKey = new Map();
  for (const r of runs || []) {
    const key = normalizeUrlKey(r.url);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(r);
  }

  const canManage = canManageProjects();

  sidebarTreeEl.innerHTML = (creating ? projectFormHtml() : "")
    + topLevelSuiteFormHtml(projects)
    + projects.map((p) => {
    const open = expandedProjects.has(p.id);
    const projectRuns = byKey.get(normalizeUrlKey(p.name) || p.name) || [];
    // The number on a project row is its SAVED CASE count, because the suite rows nested under it
    // show case counts in the same `.tree-count` position. It used to show runs, so a project with
    // 38 runs and 3 cases read as holding 38 cases — two units, one column.
    //
    // It counts EVERY case in the project, not the sum of its suites, so a case saved but filed in
    // no suite still appears in the total. That means this number can legitimately be larger than
    // its children add up to, and that is correct rather than a discrepancy.
    //
    // Defaults to 0, never blank: a project with no saved cases shows "0". The same default covers
    // the DB-off fallback below, where `groupRunsByUrl` synthesises pseudo-projects that have no
    // case count because there is no case library in that mode.
    const caseCount = typeof p.caseCount === "number" ? p.caseCount : 0;

    // The run count is not discarded — it moves into the row's tooltip where it can be LABELLED,
    // rather than sitting in the tree as a bare number in the wrong unit. The server's figure is
    // authoritative: it covers every run in the project, while the sidebar's own list is capped at
    // the newest 20 read off disk.
    const runCount = typeof p.runCount === "number" ? p.runCount : projectRuns.length;
    const rowTitle = [
      p.baseUrl || p.name,
      `${caseCount} saved case${caseCount === 1 ? "" : "s"}`,
      `${runCount} run${runCount === 1 ? "" : "s"}`,
    ].join(" · ");
    // Editing swaps the row for the form in place, so the project being renamed stays where the
    // eye already is rather than the form appearing somewhere else in the tree.
    const projectRow = projectFormId === p.id ? projectFormHtml() : `
      <div class="tree-row tree-project" data-toggle-key="${escapeHtml(p.id)}">
        <span class="tree-chevron">${icon(open ? "chevron-down" : "chevron-right", { size: 9 })}</span>
        <span class="tree-label" title="${escapeHtml(rowTitle)}">${escapeHtml(p.name)}</span>
        ${canManage ? `<button type="button" class="dl-btn-inline tree-project-edit" data-project-edit="${escapeHtml(p.id)}" title="Rename or set a base URL">Edit</button>` : ""}
        ${canManage ? `<button type="button" class="dl-btn-inline tree-project-del" data-project-delete="${escapeHtml(p.id)}" title="Delete this project">Delete</button>` : ""}
        <span class="tree-count">${caseCount}</span>
      </div>`;
    // Saved suites first, then recent runs. The suites are the reusable, zero-cost thing — a
    // project's library is more useful to reach than its scrollback, so it sits above.
    // Renaming swaps the row for the form in place, the same way editing a project does, so the
    // suite being renamed stays where the eye already is. Inline rather than prompt() for the same
    // reason the create form is inline (see below): a server refusal needs somewhere to land.
    const suiteRows = !open ? "" : (suitesCache
      .filter((s) => s.projectId === p.id)
      .map((s) => (renameSuiteId === s.id
      ? `<div class="tree-row tree-suite-new">
           <input type="text" class="suite-new-input" id="renameSuiteInput"
                  placeholder="Suite name" value="${escapeHtml(renameSuiteName)}"
                  aria-label="New name for this suite" />
           <button type="button" class="dl-btn-inline" data-suite-rename-save="${escapeHtml(s.id)}">Save</button>
           <button type="button" class="dl-btn-inline" data-suite-rename-cancel="1" title="Cancel">&times;</button>
         </div>
         ${renameSuiteError ? `<div class="suite-new-err">${escapeHtml(renameSuiteError)}</div>` : ""}`
      : `<div class="tree-row tree-suite" data-suite-id="${escapeHtml(s.id)}">
           <span class="tree-label" title="${escapeHtml(s.name)}">${escapeHtml(s.name)}</span>
           ${canAuthorSuites() ? `<button type="button" class="dl-btn-inline tree-suite-edit" data-suite-rename="${escapeHtml(s.id)}" title="Rename this suite">Rename</button>` : ""}
           ${canDeleteSuites() ? `<button type="button" class="dl-btn-inline tree-suite-del" data-suite-delete="${escapeHtml(s.id)}" title="Delete this suite">Delete</button>` : ""}
           <span class="tree-count">${s.caseCount}</span>
         </div>`)).join(""));

    // Creating a suite belongs where the suites already are — someone looking at a project's
    // suites and wanting another looks right here. Naming happens inline rather than through a
    // prompt() so the server's refusal (duplicate name, project you can't see) has somewhere to
    // land. `tester`+ only; the server enforces it regardless (POST /api/suites).
    const newSuiteRow = !open || !canAuthorSuites() ? "" : (newSuiteFor === p.id
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

  bindProjectForm();

  sidebarTreeEl.querySelectorAll("[data-project-edit]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      // The row itself toggles expand/collapse; without this the tree would open or close every
      // time someone reached for Edit.
      e.stopPropagation();
      const p = projects.find((x) => x.id === btn.dataset.projectEdit);
      if (!p) return;
      projectFormOpen = true;
      projectFormId = p.id;
      projectFormName = p.name || "";
      projectFormUrl = p.baseUrl || "";
      projectFormError = "";
      renderProjectsTree(allRunsCache);
      document.getElementById("projectFormName")?.focus();
    });
  });

  // Delete a project. The route (DELETE /api/projects/:id, admin+) and its rules already
  // existed; the sidebar simply never offered a way to reach them, so an owner had no control
  // to click. The server REFUSES with 409 while the project still holds runs and says how many
  // (deleteProject in src/server/projects.ts) — that refusal is deliberate, so this surfaces the
  // server's own sentence rather than second-guessing it or offering to cascade the runs away.
  sidebarTreeEl.querySelectorAll("[data-project-delete]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      // Same reason as Edit above: the row itself toggles expand/collapse.
      e.stopPropagation();
      const p = projects.find((x) => x.id === btn.dataset.projectDelete);
      if (!p) return;
      if (!confirm(`Delete the project "${p.name}"? Its saved suites and cases go with it.`)) return;
      try {
        await api(`/api/projects/${encodeURIComponent(p.id)}`, { method: "DELETE" });
        expandedProjects.delete(p.id);
        await loadProjects();
        toast(`Project "${p.name}" deleted.`);
      } catch (err) {
        toast(err.message);
      }
    });
  });

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
    // Only reachable from the heading form, and only if its picker somehow came back empty.
    if (!projectId) {
      newSuiteError = "Choose a project for this suite.";
      return renderProjectsTree(allRunsCache);
    }
    try {
      const created = await api("/api/suites", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, name }),
      });
      newSuiteFor = null; newSuiteName = ""; newSuiteError = ""; newSuiteProject = null;
      // Created from the heading, the project it landed in may well be collapsed — open it so the
      // new suite is where the eye goes when it comes back to the tree.
      expandedProjects.add(projectId);
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

  // Opened under a project, the project is `newSuiteFor`; opened from the heading it is whatever
  // the picker says. One function either way, so createSuite() did not have to change.
  const targetProjectId = () => (newSuiteFor === NEW_SUITE_ANY ? (newSuiteProject || "") : newSuiteFor);

  const projectSelect = document.getElementById("newSuiteProject");
  if (projectSelect) {
    // Sync state to what actually rendered — this is what makes the fallback above real rather
    // than only visual, since the render itself must not write state.
    newSuiteProject = projectSelect.value;
    projectSelect.addEventListener("change", () => { newSuiteProject = projectSelect.value; });
  }

  const nameInput = document.getElementById("newSuiteInput");
  if (nameInput) {
    nameInput.addEventListener("input", () => { newSuiteName = nameInput.value; });
    nameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); createSuite(targetProjectId()); }
      if (e.key === "Escape") {
        newSuiteFor = null; newSuiteName = ""; newSuiteError = "";
        renderProjectsTree(allRunsCache);
      }
    });
  }
  sidebarTreeEl.querySelectorAll("[data-suite-create]").forEach((btn) => {
    btn.addEventListener("click", () => createSuite(btn.dataset.suiteCreate));
  });
  sidebarTreeEl.querySelectorAll("[data-suite-create-top]").forEach((btn) => {
    btn.addEventListener("click", () => createSuite(targetProjectId()));
  });

  // Suite rename + delete. Every one of these calls stopPropagation() because the row they sit in
  // is itself a click target that opens the suite — without it, reaching for Rename would navigate
  // away before the form could render.
  sidebarTreeEl.querySelectorAll("[data-suite-rename]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const s = suitesCache.find((x) => x.id === btn.dataset.suiteRename);
      if (!s) return;
      // One suite form at a time: two open forms would mean two inputs competing for focus.
      newSuiteFor = null; newSuiteName = ""; newSuiteError = "";
      renameSuiteId = s.id;
      renameSuiteName = s.name || "";
      renameSuiteError = "";
      renderProjectsTree(allRunsCache);
      document.getElementById("renameSuiteInput")?.focus();
    });
  });

  const saveSuiteName = async (suiteId) => {
    const name = renameSuiteName.trim();
    if (!name) { renameSuiteError = "Give the suite a name."; return renderProjectsTree(allRunsCache); }
    // Unchanged name: just close. Mirrors the Suite screen's own rename, which returns early too.
    const current = suitesCache.find((x) => x.id === suiteId);
    if (current && name === current.name) {
      renameSuiteId = null; renameSuiteName = ""; renameSuiteError = "";
      return renderProjectsTree(allRunsCache);
    }
    try {
      await api(`/api/suites/${encodeURIComponent(suiteId)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      renameSuiteId = null; renameSuiteName = ""; renameSuiteError = "";
      await loadProjects();
      toast("Suite renamed.");
      // If that suite is the screen currently open, its heading and crumb still say the old name.
      // navigate() to the same hash re-runs applyRoute() rather than doing nothing (see :4310).
      const hash = "#/suite/" + encodeURIComponent(suiteId);
      if (location.hash === hash) navigate(hash);
    } catch (err) {
      renameSuiteError = err.message;
      renderProjectsTree(allRunsCache);
      document.getElementById("renameSuiteInput")?.focus();
    }
  };

  const renameInput = document.getElementById("renameSuiteInput");
  if (renameInput) {
    renameInput.addEventListener("input", () => { renameSuiteName = renameInput.value; });
    renameInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); saveSuiteName(renameSuiteId); }
      if (e.key === "Escape") {
        renameSuiteId = null; renameSuiteName = ""; renameSuiteError = "";
        renderProjectsTree(allRunsCache);
      }
    });
  }
  sidebarTreeEl.querySelectorAll("[data-suite-rename-save]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      saveSuiteName(btn.dataset.suiteRenameSave);
    });
  });
  sidebarTreeEl.querySelectorAll("[data-suite-rename-cancel]").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      renameSuiteId = null; renameSuiteName = ""; renameSuiteError = "";
      renderProjectsTree(allRunsCache);
    });
  });

  // Deleting a suite is unconditional server-side, unlike deleting a project (which refuses while
  // runs remain). A suite is a grouping: `suite_cases` cascades, `test_cases` does not, so the
  // authored cases survive. The confirm says so, in the Suite screen's own words.
  sidebarTreeEl.querySelectorAll("[data-suite-delete]").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      const s = suitesCache.find((x) => x.id === btn.dataset.suiteDelete);
      if (!s) return;
      if (!confirm(`Delete the suite "${s.name}"? The cases themselves are kept.`)) return;
      // Read the hash BEFORE the await: loadProjects() can re-render and navigate underneath us.
      const onThisSuite = location.hash.startsWith("#/suite/" + encodeURIComponent(s.id));
      if (renameSuiteId === s.id) { renameSuiteId = null; renameSuiteName = ""; renameSuiteError = ""; }
      try {
        await api(`/api/suites/${encodeURIComponent(s.id)}`, { method: "DELETE" });
        await loadProjects();
        toast("Suite deleted — its cases were kept.");
        // Don't leave someone standing on the screen of a suite that no longer exists.
        if (onThisSuite) navigate("#/");
      } catch (err) {
        toast(err.message);
      }
    });
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
      if (row.dataset.url) setUrlFieldValue(row.dataset.url);
      navigate("#/run/" + row.dataset.runId);
    });
  });
}

/**
 * Wire the inline project form, for both create and edit.
 *
 * Split out of renderProjectsTree() because the empty-workspace branch returns early and still
 * needs it — an admin whose organisation has no projects yet is exactly the person who most needs
 * the create form to work.
 *
 * A base URL is OPTIONAL by design: a project can be a bare name with nothing pointed at it yet,
 * and the server already stores "" for one. Only the name is required, and the server says so too
 * (POST /api/projects → 400 "name is required") — this doesn't restate that rule, it just avoids
 * a round-trip for the empty case.
 */
function bindProjectForm() {
  if (!projectFormOpen) return;

  const nameEl = document.getElementById("projectFormName");
  const urlEl2 = document.getElementById("projectFormUrl");
  if (!nameEl || !urlEl2) return;

  nameEl.addEventListener("input", () => { projectFormName = nameEl.value; });
  urlEl2.addEventListener("input", () => { projectFormUrl = urlEl2.value; });

  const submit = async () => {
    const name = projectFormName.trim();
    if (!name) {
      projectFormError = "Give the project a name.";
      renderProjectsTree(allRunsCache);
      document.getElementById("projectFormName")?.focus();
      return;
    }
    const editingId = projectFormId;
    try {
      if (editingId) {
        // baseUrl is sent even when blank — that is how a URL gets cleared, and updateProject()
        // distinguishes "" (set it empty) from undefined (leave it alone).
        await api(`/api/projects/${encodeURIComponent(editingId)}`, {
          method: "PATCH", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, baseUrl: projectFormUrl.trim() }),
        });
        closeProjectForm();
        await loadProjects();
        toast("Project updated.");
      } else {
        const created = await api("/api/projects", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name, baseUrl: projectFormUrl.trim() }),
        });
        closeProjectForm();
        await loadProjects();
        // Land in the new project: expand it so its "+ New suite" row is already on screen. There
        // is no project screen to navigate to, so this is what "in front of them" means here.
        if (created?.id) {
          expandedProjects.add(created.id);
          renderProjectsTree(allRunsCache);
          sidebarTreeEl.querySelector(`[data-toggle-key="${CSS.escape(created.id)}"]`)
            ?.scrollIntoView({ block: "nearest" });
        }
        toast(`Project "${name}" created.`);
      }
    } catch (err) {
      projectFormError = err.message;
      renderProjectsTree(allRunsCache);
      document.getElementById("projectFormName")?.focus();
    }
  };

  for (const el of [nameEl, urlEl2]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); submit(); }
      if (e.key === "Escape") { closeProjectForm(); renderProjectsTree(allRunsCache); }
    });
  }
  sidebarTreeEl.querySelector("[data-project-save]")?.addEventListener("click", submit);
  sidebarTreeEl.querySelector("[data-project-cancel]")?.addEventListener("click", () => {
    closeProjectForm();
    renderProjectsTree(allRunsCache);
  });
}

renderProjectsTree(allRunsCache);

// The "+" beside the PROJECTS heading has existed in the markup since the original template and
// did nothing until now — no handler referenced it at all.
addProjectBtnEl?.addEventListener("click", () => {
  if (!canManageProjects()) return;
  projectFormOpen = true;
  projectFormId = null;
  projectFormName = "";
  projectFormUrl = "";
  projectFormError = "";
  renderProjectsTree(allRunsCache);
  document.getElementById("projectFormName")?.focus();
});

// "New suite" from the Projects heading — creating a suite without first expanding the project it
// belongs to. The project is picked in the form; everything after that is the existing create path.
addSuiteBtnEl?.addEventListener("click", () => {
  if (!canAuthorSuites()) return;
  renameSuiteId = null; renameSuiteName = ""; renameSuiteError = "";   // one suite form at a time
  newSuiteFor = NEW_SUITE_ANY;
  newSuiteName = "";
  newSuiteError = "";
  renderProjectsTree(allRunsCache);
  document.getElementById("newSuiteInput")?.focus();
});

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
          setUrlFieldValue(src.url || "");
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
    <div class="panel"><div id="teamRows"></div></div>
    <div id="llmConfigWrap"></div>`;

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
          <!-- Plain free text, no suggestions. The endpoint that fed a datalist here returned
               every registered address on the instance to any admin, which across separate
               organisations is a customer list. Typing the full address is the cost of that. -->
          <input id="teamAddEmail" type="email" placeholder="someone@example.com"
            autocomplete="off" spellcheck="false" />
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

  }

  if (isAdmin) void renderLlmConfigPanel(orgId);

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

/**
 * The per-organisation LLM configuration panel — admin and owner only.
 *
 * THE KEY IS WRITE-ONLY, and this panel is built so that it could not reveal one even if it
 * wanted to: the server's GET returns `keySet` and a four-character hint, and there is no route
 * that returns a key. So the UI shows "Set ••••3f9a" with a Replace action, never a value in a
 * readable field. The input is `type="password"`, `autocomplete="off"`, and is cleared the moment
 * it has been sent.
 *
 * Absent entirely when the server has the feature off: the fetch 404s and the panel renders
 * nothing at all, rather than a control that cannot work.
 */
async function renderLlmConfigPanel(orgId) {
  const wrap = document.getElementById("llmConfigWrap");
  if (!wrap) return;

  let cfg;
  try {
    cfg = await api(`/api/organisations/${encodeURIComponent(orgId)}/llm-config`);
  } catch {
    // 404 (feature off) or 403 — either way there is nothing to offer here.
    wrap.innerHTML = "";
    return;
  }

  const modelOptions = (selected) => [
    `<option value=""${selected ? "" : " selected"}>Use the server's default</option>`,
    ...cfg.availableModels.map((m) =>
      `<option value="${escapeHtml(m)}"${m === selected ? " selected" : ""}>${escapeHtml(m)}</option>`),
  ].join("");

  wrap.innerHTML = `
    <div style="margin-top:28px">
      <div class="eyebrow">AI CONFIGURATION</div>
      <h1 class="page-head-title">This organisation's Gemini key and model</h1>
      <p class="tagline">Runs started by this organisation use the key set here and bill to its own
      quota. Leave it unset to use the server's shared configuration.</p>
    </div>
    <div id="llmFeedback"></div>
    <div class="panel">
      <div class="team-add">
        <label class="field">
          <span class="field-label">Gemini API key</span>
          ${cfg.keySet
            ? `<p class="hrow-meta" id="llmKeyState">Set — <strong>${escapeHtml(cfg.keyHint || "••••")}</strong>.
               A stored key is never shown again; you can replace or remove it.</p>`
            : `<p class="hrow-meta" id="llmKeyState">Not set — this organisation uses the server's key.</p>`}
          <input id="llmKeyInput" type="password" autocomplete="off" spellcheck="false"
                 placeholder="${cfg.keySet ? "Enter a new key to replace it" : "Paste this organisation's Gemini API key"}"
                 ${cfg.custodyConfigured ? "" : "disabled"} />
          ${cfg.custodyConfigured ? "" :
            `<p class="team-error">This server has no encryption key configured (LLM_KEY_FILE), so an
             API key cannot be stored safely. Ask an operator to set one.</p>`}
        </label>
        <label class="field" style="flex:0 0 200px">
          <span class="field-label">Model</span>
          <select id="llmModel" class="team-select">${modelOptions(cfg.model)}</select>
        </label>
        <label class="field" style="flex:0 0 200px">
          <span class="field-label">Cheap-call model</span>
          <select id="llmModelLite" class="team-select">${modelOptions(cfg.modelLite)}</select>
        </label>
        <label class="field" style="flex:0 0 150px">
          <span class="field-label">Max LLM calls per run</span>
          <input id="llmMaxCalls" type="number" min="1" placeholder="server default"
                 value="${cfg.maxCallsPerRun ?? ""}" />
        </label>
        <div class="team-add-actions">
          <button type="button" id="llmSaveBtn" class="dl-btn-inline">Save</button>
          ${cfg.keySet ? `<button type="button" id="llmRemoveKeyBtn" class="dl-btn-inline">Remove key</button>` : ""}
        </div>
      </div>
    </div>`;

  const feedback = (msg, isError) => {
    const el = document.getElementById("llmFeedback");
    if (el) el.innerHTML = `<p class="${isError ? "team-error" : "team-ok"}">${escapeHtml(msg)}</p>`;
  };

  const save = async (body, okMsg) => {
    const btn = document.getElementById("llmSaveBtn");
    if (btn) btn.disabled = true;
    try {
      await api(`/api/organisations/${encodeURIComponent(orgId)}/llm-config`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      // Re-render from the server rather than patching local state: the key hint and keySet must
      // come from what was actually stored, never from what we think we sent.
      await renderLlmConfigPanel(orgId);
      feedback(okMsg, false);
    } catch (err) {
      feedback(err.message || "Could not save the configuration.", true);
      if (btn) btn.disabled = false;
    }
  };

  document.getElementById("llmSaveBtn").addEventListener("click", () => {
    const keyEl = document.getElementById("llmKeyInput");
    const key = keyEl ? keyEl.value.trim() : "";
    const maxRaw = document.getElementById("llmMaxCalls").value.trim();
    const body = {
      model: document.getElementById("llmModel").value || null,
      modelLite: document.getElementById("llmModelLite").value || null,
      maxCallsPerRun: maxRaw === "" ? null : Number(maxRaw),
    };
    // Only send a key when one was typed — an untouched field must not clear the stored key.
    if (key) body.apiKey = key;
    // Cleared immediately, so it is not sitting in the DOM after the request.
    if (keyEl) keyEl.value = "";
    void save(body, key ? "Key and model saved. The key is stored encrypted and cannot be shown again." : "Model settings saved.");
  });

  const removeBtn = document.getElementById("llmRemoveKeyBtn");
  if (removeBtn) {
    removeBtn.addEventListener("click", () => {
      void save({ apiKey: null }, "Key removed — this organisation now uses the server's key.");
    });
  }
}

// -----------------------------------------------------------------------------
// Composer field wiring (URL scheme, validation, button states)
// -----------------------------------------------------------------------------
// Placed at the end of the file on purpose: refreshNewRunState() reads `currentRunId`, which is a
// `let` declared further down. Running this any earlier would hit its temporal dead zone.

// Typing never blocks or rejects: the value is only normalised (scheme split out, whitespace and
// leading slashes dropped) and any existing error is cleared.
urlEl.addEventListener("input", () => {
  normalizeUrlField(true);
  clearUrlError();
  refreshComposerState();
});

// Pasting is handled by the same input handler on the next tick, so a pasted scheme flips the
// prefix rather than landing in the value.
urlEl.addEventListener("paste", () => setTimeout(() => {
  normalizeUrlField(true);
  clearUrlError();
  refreshComposerState();
}, 0));

// Validate on blur — the first moment the person has finished a thought.
urlEl.addEventListener("blur", () => {
  normalizeUrlField(false);
  const problem = urlEl.value.trim() ? urlProblem() : "";
  if (problem) showUrlError(problem); else clearUrlError();
});

promptEl.addEventListener("input", refreshComposerState);

// The prefix toggles https:// <-> http://. preventDefault because it sits inside a <label>, which
// would otherwise just forward the click to the input.
urlSchemeEl.addEventListener("click", (e) => {
  e.preventDefault();
  setUrlScheme(urlScheme() === "https://" ? "http://" : "https://", true);
  urlEl.focus();
});
urlSchemeEl.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  setUrlScheme(urlScheme() === "https://" ? "http://" : "https://", true);
});

refreshComposerState();
