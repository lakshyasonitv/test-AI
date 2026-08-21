// ---------------------------------------------------------------------------
// Dev-only state preview:  http://localhost:3000/?preview=states
//
// The frontend has no automated coverage, and most of its states cannot be produced on
// demand — "blocked" needs a site with an emailed OTP, "unconfirmed" needs a truncated IR,
// "lost contact" needs the server to die mid-run. Verifying a UI change by running the real
// pipeline costs LLM spend and still can't reach half of them.
//
// So this feeds applyEvent() a fixture sequence covering every state. The event shapes are
// copied from a real runs/<id>/events.ndjson (2026-07-30T17-01-59-013Z-979dbd01, a blocked
// run) rather than written from memory, so the UI is verified against events the orchestrator
// actually emits.
//
// Inert unless the query param is present.
// ---------------------------------------------------------------------------

(function () {
  const params = new URLSearchParams(location.search);
  if (params.get("preview") !== "states") return;

  const RUN = "2026-08-02T18-24-02-358Z-20b0ba3d";
  const SHOT = `/runs/${RUN}/artifacts/step-7.png`;

  const suite = {
    total: 6, passed: 2, failed: 1, truncated: 1, truncated_no_assertion: 1, blocked: 1,
    cases: [
      { caseId: "case-0", title: "Log in with valid credentials", status: "passed",
        resultPath: "cases/case-0", screenshotUrl: SHOT,
        whyItMatters: "If this breaks, real customers can't get into their accounts at all.",
        intent: "proves a real user can sign in and reach their account",
        expected: "The account page is shown after signing in",
        llmCalls: 2, llmTokens: 6790 },
      { caseId: "case-1", title: "Log in with the wrong password", status: "passed",
        resultPath: "cases/case-1", screenshotUrl: SHOT,
        whyItMatters: "If this breaks, someone else's guess at a password could get into an account it doesn't belong to.",
        intent: "proves a wrong password is rejected rather than quietly accepted",
        expected: "An error message is shown and the user stays on the login page" },
      { caseId: "case-2", title: "Sign up for a new account", status: "blocked",
        resultPath: "cases/case-2", screenshotUrl: SHOT,
        whyItMatters: "If this breaks, new visitors can never become customers in the first place.",
        intent: "proves a new visitor can create an account",
        blockedBy: "the flow reached a verification step that needs a code sent to a real inbox or phone, which an automated test can't read" },
      { caseId: "case-3", title: "Submit the form with nothing filled in", status: "failed",
        resultPath: "cases/case-3", screenshotUrl: SHOT,
        whyItMatters: "If this breaks, blank submissions could reach you with no way to reply to whoever sent them.",
        expected: "A validation message appears and nothing is submitted" },
      { caseId: "case-4", title: "Search for a product", status: "truncated",
        resultPath: "cases/case-4",
        whyItMatters: "If this breaks, visitors looking for something specific find nothing and leave.",
        intent: "proves search returns relevant results" },
      { caseId: "case-5", title: "Add an item to the cart", status: "truncated_no_assertion",
        resultPath: "cases/case-5",
        whyItMatters: "If this breaks, nobody can actually buy anything.",
        intent: "proves the cart updates when an item is added" },
    ],
  };

  // Shapes lifted from the real event log.
  const SCENES = {
    running: [
      { stage: "plan", status: "started" },
      { stage: "plan", status: "completed", data: { goal: "Verify a user can sign in and reach their account." } },
      { stage: "discovery", status: "started" },
      { stage: "discovery", status: "completed", data: { pages: [{ url: "https://example.com/", concepts: ["Authentication"] }] } },
      { stage: "testcases", status: "started" },
      { stage: "testcases", status: "completed", data: { generated: 15, reactive: 5, selected: 4, budget: 5, total: 4 } },
      { stage: "ir", status: "started" },
    ],
    credentials: [{ stage: "credentials", status: "started", data: { fields: ["username", "password"], url: "https://example.com/" } }],
    passed: [{ stage: "done", status: "completed", data: {
      passed: true, partial: false, healed: false, screenshotUrl: SHOT,
      test: { title: "Log in with valid credentials", expected: "The account page is shown",
              steps: ["Open the login page", "Enter the email and password", "Press Sign in"] },
      suite } }],
    healed: [{ stage: "done", status: "completed", data: { passed: true, healed: true, screenshotUrl: SHOT, suite } }],
    failed: [{ stage: "done", status: "completed", data: { passed: false, screenshotUrl: SHOT, suite } }],
    blocked: [{ stage: "done", status: "completed", data: {
      passed: false, status: "blocked", screenshotUrl: SHOT,
      blockedBy: "the flow reached a verification step that needs a code sent to a real inbox or phone, which an automated test can't read",
      suite } }],
    unconfirmed: [{ stage: "done", status: "completed", data: { passed: true, status: "truncated_no_assertion", screenshotUrl: SHOT, suite } }],
    error: [{ stage: "error", status: "failed", error: "IR failed schema validation after retry" }],
    // Case-selection gate: the round-requested event alone, so the panel stays open for
    // manual interaction. Resolution events are omitted on purpose — the point of the scene
    // is to exercise Select all / none, the Done state, and the two-click refine, not to
    // watch the panel close itself.
    caseSelection: [{ stage: "testcases", status: "started", data: {
      action: "case_round_requested", attempt: 1,
      batch: [
        { title: "Log in with valid credentials", fromPrompt: true,
          whyItMatters: "If this breaks, real customers can't get into their accounts at all.",
          expected: "The account page is shown after signing in" },
        { title: "Log in with the wrong password", fromPrompt: false,
          whyItMatters: "If this breaks, someone else's guess at a password could get into an account it doesn't belong to.",
          expected: "An error message is shown and the user stays on the login page" },
        { title: "Submit the form with nothing filled in", fromPrompt: false,
          whyItMatters: "If this breaks, blank submissions could reach you with no way to reply to whoever sent them.",
          expected: "A validation message appears and nothing is submitted" },
      ],
    } }],
  };

  function play(name) {
    renderPhases();
    hideSingleTestResult();
    hideSuiteResults();
    hideSuiteProgress();
    hideCredentialPrompt();
    // Every scene builds on the pipeline reaching the same point first.
    const seq = name === "running" ? SCENES.running : [...SCENES.running, ...SCENES[name]];
    for (const e of seq) applyEvent({ runId: RUN, ts: Date.now(), ...e }, RUN);
    history.replaceState(null, "", `?preview=states&scene=${name}`);
  }

  // Scene switcher, styled inline so it can never be confused for part of the real UI.
  const bar = document.createElement("div");
  bar.style.cssText =
    "position:fixed;bottom:16px;left:50%;transform:translateX(-50%);z-index:99;display:flex;" +
    "gap:6px;flex-wrap:wrap;justify-content:center;background:#1d2128;border:1px solid #2e333d;" +
    "border-radius:999px;padding:8px 12px;box-shadow:0 8px 28px rgba(0,0,0,.5);max-width:92vw";
  bar.innerHTML =
    `<span style="font:600 11px system-ui;color:#7d8492;align-self:center;padding-right:4px">PREVIEW</span>` +
    Object.keys(SCENES)
      .map(k => `<button data-scene="${k}" style="font:500 12px system-ui;background:#121419;color:#a3a9b5;` +
                `border:1px solid #23272f;border-radius:999px;padding:4px 11px;cursor:pointer">${k}</button>`)
      .join("");
  document.body.appendChild(bar);
  bar.addEventListener("click", (e) => {
    const scene = e.target.closest("[data-scene]")?.dataset.scene;
    if (scene) play(scene);
  });

  play(params.get("scene") && SCENES[params.get("scene")] ? params.get("scene") : "passed");
})();
