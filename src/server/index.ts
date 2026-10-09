import express from "express";
import path from "node:path";
import { rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { buildRunReportHtml } from "../stages/htmlReport.js";
import { fileURLToPath } from "node:url";
import { runPipeline, makeRunId } from "../orchestrator.js";
import { record, subscribe, getEvents } from "./runRegistry.js";
import { allRunIds, listRuns, store, summariseMissingRun } from "../runStore.js";
import { warnIfNoVideo } from "../stages/executor.js";
import { selfHealDefault } from "../stages/heal.js";
import { llmCacheClear } from "../kb/llmCache.js";
import { isSupportedRunLocale, SUPPORTED_RUN_LOCALES } from "../browserLaunch.js";
import { hasTerminalAssertion } from "../stages/ir.js";
import { WALK_CACHE_NS } from "../stages/liveExtend.js";
import { Semaphore } from "./concurrency.js";
import { askCredentials, settle } from "./pendingCredentials.js";
import { ANSWER_LIMIT, askQuestion, pendingQuestionKind, settleQuestion } from "./pendingQuestions.js";
import { runQuestionsEnabled } from "../runSession.js";
import { CaseSelectionDecisionSchema } from "../schema/caseSelection.js";
import { resolveCaseSelection, getPendingSelection } from "./pendingCaseSelection.js";
import { getAllAcceptedCases, remainingCapacity } from "./caseAccumulator.js";
import { startRetentionJob } from "./retention.js";
import { requireAuth, resolveUser, isAuthEnabled, LOCAL_USER_ID } from "./auth.js";
import {
  AccessError,
  assertOrgAccess,
  canEnforceTenancy,
  canViewRun,
  filterRunsForUser,
  isRole,
  orgForRun,
  primaryOrgFor,
  requireOrgRole,
  requireRole,
  requireRunRole,
} from "./authz.js";
import {
  addMember,
  bootstrapUser,
  changeMemberRole,
  createOrganisation,
  findUserByEmail,
  listMembersVisibleTo,
  removeMember,
  roleOfMember,
} from "./organisations.js";
import {
  addProjectMember,
  assertProjectVisible,
  assignmentsVisibleTo,
  createProject,
  deleteProject,
  listProjectMembers,
  listVisibleProjects,
  projectDeletionImpact,
  removeProjectMember,
  resolveProjectForUrl,
  updateProject,
} from "./projects.js";
import { consumeSignupAttempt, createAccount, isSignupEnabled } from "./signup.js";
import {
  addCaseToSuite,
  assertCanAuthor,
  CaseConflictError,
  createSuite,
  deleteCase,
  deleteSuite,
  duplicateCase,
  getCase,
  getCaseScript,
  getCaseVersion,
  listCaseRuns,
  listCases,
  listSuiteCases,
  listSuites,
  loadCasesForReplay,
  parseIr,
  recordCaseOutcome,
  removeCaseFromSuite,
  renameSuite,
  reorderSuite,
  saveCaseFromRun,
  scriptOverrideEnabled,
  setScriptOverride,
  updateCase,
} from "./library.js";
import { runReplay, originOf } from "../stages/replay.js";
import {
  describeOrgLlmConfig, llmConfigForOrg, maxCallsForOrg, orgLlmConfigEnabled, setOrgLlmConfig,
} from "./orgLlmConfig.js";
import { estimateRegrounding, formatIrStep, parseIrSteps } from "../stages/stepText.js";
import { enterWithLlmConfig } from "../llm/llmContext.js";
import { regroundEditedIr } from "../stages/caseEdit.js";
import {
  credentialsFromEnv, credentialKindsNeeded, restoreCredentialRefs, isEnvValueRef,
  type Credentials,
} from "../stages/credentials.js";
import { resolveCredentialsVia } from "./resolveCredentials.js";
import { toElementIndex } from "../schema/appModel.js";
import { proposeRewrite, proposeStepTranslation, consumeRewriteAttempt, nlStepsEnabled,
         proposeGateRewrite, gateRewriteEnabled } from "./rewrite.js";
import {
  cancelJob, createJob, emitJobEvent, getJob, isCancelled, jobEvents, subscribeJob,
} from "./regroundJobs.js";
import { deleteRunRow, fetchRunsFromDb, isDbEnabled, recordRunCases, recordRunProject, recordRunStarted, recordRunStatus } from "../db.js";
import { summariseRun } from "../runStore.js";

import { isAllowedEntryUrl } from "../stages/hybridDiscovery.js";
import { isTargetApp, salesforceEnabled, TARGET_APPS, type TargetApp } from "../runTarget.js";

/** runId shape from makeRunId(). No "/", "." or ".." so it can never escape runs/. */
const RUN_ID = /^[\dT-]+Z-[0-9a-f]{8}$/;

/**
 * The two things a `:caseId` is ever allowed to be.
 *
 * `:caseId` names two different kinds of id depending on the route, and both must be validated
 * because Express decides a parameter's value AFTER matching, not before:
 *
 *   - LIBRARY_CASE_ID — `test_cases.id`, a uuid. Every `/api/cases/:caseId/...` route.
 *   - RUN_CASE_ID     — a run directory's `cases/case-N`. Only `/api/runs/:runId/cases/:caseId/save`,
 *                       which is the one place a caseId becomes a PATH SEGMENT (library.ts:549).
 *
 * That last one is why this exists. Express 4 matches `:caseId` against the raw, still-encoded
 * segment and only then decodes it, so `..%2F..%2F<otherRun>%2Fcases%2Fcase-0` arrives at the
 * handler as a single parameter containing separators — and `path.join()` then walks straight out
 * of the run directory into another organisation's run. Validating in the handler would work; a
 * `app.param` is used instead so the rule covers every current AND future `:caseId` route by
 * construction, which is the same reason `:runId` already has one.
 */
const LIBRARY_CASE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUN_CASE_ID = /^case-\d+$/;

// Bound concurrent runs (each launches Chromium). Tune via env as the box grows.
const runLimit = new Semaphore(Number(process.env.MAX_CONCURRENT_RUNS ?? 3));

const app = express();
app.use(express.json());
app.use(express.static("public"));

// Identity for every /api/* route (implentationplan.md Step 2.1). With AUTH_ENABLED off this is a
// pass-through that just attaches the synthetic LOCAL_USER, so behavior is unchanged — see
// auth.ts's header for why it attaches a user instead of skipping.
// Both of these must stay reachable without a credential, or login is unreachable by
// construction: the UI has to be able to ask "is auth even on, and where do I authenticate?"
// before it can possibly hold a token. Neither returns a secret — /api/health reports only
// whether each env var is set, /api/auth/config returns only browser-safe publishable values.
// /auth/signup joins them for the same reason: an account that does not exist yet cannot present
// a token, so requiring one would make sign-up unreachable by construction. It carries its own
// flag, rate limit and validation instead — see signup.ts.
const PUBLIC_API_PATHS = new Set(["/health", "/auth/config", "/auth/signup"]);

app.use("/api", (req, res, next) => {
  if (PUBLIC_API_PATHS.has(req.path)) return next();
  return void requireAuth(req, res, next);
});

// Access control for artifact files: authentication (Step 2.1) AND tenancy (Step 3.4).
//
// This guard matters more than the /api/* ones. Screenshots, videos and traces are the most
// sensitive thing this product stores — they are pictures of someone else's application, often
// mid-login — and they are fetched by <img>/<video> tags rather than by app.js, so they bypass
// every check the frontend does. If tenancy leaks anywhere, it leaks here first.
//
// With AUTH_ENABLED off, resolveUser always returns the synthetic user and canEnforceTenancy() is
// false, so this stays unconditionally true — identical to the blanket `express.static("runs")`
// mount this route replaced.
async function canAccessRun(req: express.Request, runId: string): Promise<boolean> {
  const user = await resolveUser(req);
  if (!user) return false;
  if (!canEnforceTenancy()) return true;

  // Step 5.1: the same two gates the history list applies — the run's organisation must be one of
  // yours, and unless you're an admin its project must be one you were added to. Deliberately the
  // identical function, not a parallel re-implementation: an artifact guard that is even slightly
  // weaker than the list guard is how a screenshot leaks after the row was already hidden.
  return canViewRun(user.id, runId);
}

const RUNS_DIR = path.resolve("runs");

// Serves screenshots/trace/spec/every stage-JSON snapshot directly by path — was
// `express.static("runs")`, replaced with an explicit route so a guard can sit in front of it
// (Phase 1, Step 1.1). The wildcard captures the full remainder of the path: artifact trees nest
// arbitrarily deep under a Playwright-generated slug directory
// (`cases/<caseId>/artifacts/<slug>/video.webm`), so this can't be a small set of fixed patterns —
// it must pass through anything under runs/<runId>/**, same as the static mount did.
app.get("/runs/:runId/*", async (req, res) => {
  // @types/express doesn't type the trailing "*" segment's capture group on req.params — it's
  // real at runtime (Express 4's wildcard route matching), just not reflected in the types.
  const rel = (req.params as Record<string, string>)[0] ?? "";
  const abs = path.resolve(RUNS_DIR, req.params.runId, rel);
  // Path traversal guard: the resolved path must stay inside RUNS_DIR.
  if (!abs.startsWith(RUNS_DIR + path.sep)) return res.sendStatus(403);
  if (!(await canAccessRun(req, req.params.runId))) return res.sendStatus(403); // no-op today
  res.sendFile(abs, (err) => {
    // sendFile already sent a response (or started one) on success; only translate a real miss
    // (nonexistent file, or a directory — sendFile can't serve those either) into a 404, matching
    // what the static mount effectively returned for the same cases.
    if (err && !res.headersSent) res.sendStatus(404);
  });
});

// Uniform validation middleware for any route parameter named :runId
app.param("runId", (_req, res, next, runId) => {
  if (!RUN_ID.test(runId)) return res.status(400).json({ error: "invalid runId" });
  next();
});

// Same, for :caseId. Neither accepted shape can contain "/", "\" or ".", so no value that reaches
// a handler can traverse out of the directory it is joined into — see the constants above.
app.param("caseId", (_req, res, next, caseId) => {
  if (!LIBRARY_CASE_ID.test(caseId) && !RUN_CASE_ID.test(caseId)) {
    return res.status(400).json({ error: "invalid caseId" });
  }
  next();
});

// Start a run: generate the runId up front so we can hand it back immediately,
// then let the pipeline run in the background, pushing events into the registry.
//
// `tester` — starting a run spends real money (Gemini calls) and drives a browser against
// someone's site, which is exactly the line a read-only `viewer` should not be able to cross.
app.post("/api/runs", requireRole("tester"), (req, res) => {
  const { prompt, url, urls, coverage, options, projectId } = req.body ?? {};
  if (!prompt || (!url && !urls?.length)) return res.status(400).json({ error: "prompt and url (or urls) are required" });

  const checkUrls = (urls && Array.isArray(urls) && urls.length ? urls : [url]) as unknown[];
  for (const u of checkUrls) {
    if (typeof u !== "string") {
      return res.status(400).json({ error: "URLs must be strings" });
    }
    const check = isAllowedEntryUrl(u);
    if (!check.ok) {
      return res.status(400).json({ error: check.reason });
    }
  }

  const VALID_COVERAGE = ["minimal", "standard", "full"];
  if (coverage && !VALID_COVERAGE.includes(coverage)) {
    return res.status(400).json({ error: `Invalid coverage "${coverage}". Use: minimal, standard, or full` });
  }

  // A locale is a string, so unlike the two booleans below it cannot be validated by its type
  // alone. Checked against the allow-list that browserLaunch.ts owns — the same shape as
  // VALID_COVERAGE above, and defined next to the helper that consumes it so the route and the
  // browser cannot disagree. Rejected rather than ignored: a caller who asked for "de-DE" and
  // silently got en-US would debug the wrong thing.
  if (options && typeof options === "object" && options.locale !== undefined
      && !isSupportedRunLocale(options.locale)) {
    return res.status(400).json({
      error: `Invalid locale "${options.locale}". Use one of: ${SUPPORTED_RUN_LOCALES.join(", ")}`,
    });
  }

  // `options.targetApp` (D-50): which enterprise application this URL belongs to — today only
  // "salesforce", from the run screen's "This URL is a Salesforce org" box. Checked against the
  // allow-list runTarget.ts owns, the same shape as VALID_COVERAGE and the locale check above, and
  // rejected rather than ignored for the same reason. With SALESFORCE_ENABLED off the field is
  // IGNORED, never rejected — a flag-off server must answer exactly as it did before the field
  // existed — and the value below is simply null, so the same code runs either way (rule 7).
  const targetAppOn = salesforceEnabled();
  const rawTargetApp = options && typeof options === "object" ? options.targetApp : undefined;
  if (targetAppOn && rawTargetApp !== undefined && rawTargetApp !== null && !isTargetApp(rawTargetApp)) {
    return res.status(400).json({
      error: `Invalid targetApp "${rawTargetApp}". Use one of: ${TARGET_APPS.join(", ")}`,
    });
  }
  const targetApp: TargetApp | null = targetAppOn && isTargetApp(rawTargetApp) ? rawTargetApp : null;

  // Only the known keys are forwarded — the body is untrusted input, and
  // spreading it straight into runPipeline would let a caller set anything.
  const runOptions = options && typeof options === "object"
    ? {
      ...(typeof options.gateReview === "boolean" ? { gateReview: options.gateReview } : {}),
      ...(typeof options.selfHeal === "boolean" ? { selfHeal: options.selfHeal } : {}),
      // Already validated above, so this forwards a known-good tag, never the raw body value.
      ...(isSupportedRunLocale(options.locale) ? { locale: options.locale } : {}),
    }
    : undefined;

  const runId = makeRunId();

  // Dual-write (Step 3.4's dependency). Authorization asks "which organisation owns this run?",
  // and without this row the answer for anything created after the one-off backfill is "nobody",
  // which the guards correctly treat as "denied". Fire-and-forget and non-fatal — a database
  // hiccup must never fail a run. Disk stays authoritative for reads; that is still Step 3.3.
  //
  // The organisation comes from `req.organisationId`, set by requireRole from the *session*.
  // Never from the request body: a caller naming its own org id is a caller choosing its own
  // tenancy.
  const primaryUrl = typeof url === "string" ? url : (Array.isArray(urls) ? urls[0] ?? null : null);

  recordRunStarted({
    id: runId,
    organisation_id: req.organisationId!,
    started_by: req.user?.id ?? LOCAL_USER_ID,
    prompt: typeof prompt === "string" ? prompt : null,
    url: primaryUrl,
    status: "incomplete",
    started_at: new Date().toISOString(),
  });

  // File the run under a project (Step 5.1). `projectId` in the body is OPTIONAL and additive —
  // absent behaves exactly as before — but it is still never trusted as authority: the caller's
  // organisation comes from the session, and a project id outside it simply doesn't resolve.
  //
  // With no explicit id the project is inferred from the URL using the same key the backfill used,
  // so a run lands in the project its own history is already in rather than creating a duplicate.
  // Fire-and-forget: a run must start even if its filing cabinet is unreachable.
  void (async () => {
    try {
      const explicit = typeof projectId === "string" && projectId ? projectId : null;
      const resolved = explicit
        // assertProjectVisible, not assertProjectInOrg: being in the caller's organisation is not
        // the same as being a project the caller may see, and filing a run into a project they
        // were never added to produces a run its own author is then refused (the same failure
        // resolveProjectForUrl now avoids). The two entry points must agree on what "your project"
        // means, or the guarantee only holds on one of them.
        ? (await assertProjectVisible(
            req.user?.id ?? LOCAL_USER_ID, req.organisationId!, req.organisationRole!, explicit,
          ).then((p) => p.id).catch(() => null))
        : await resolveProjectForUrl(req.organisationId!, primaryUrl, req.user?.id ?? LOCAL_USER_ID);
      if (resolved) recordRunProject(runId, resolved);
    } catch (err) {
      console.error(`[projects] could not file run ${runId}:`, (err as Error)?.message ?? err);
    }
  })();

  // Wrap the event sink so a terminal event also settles the run's stored status. The status is
  // re-derived with summariseRun() — the same function /api/runs serves from — rather than
  // reimplemented here, because two implementations of "what status is this run" is precisely the
  // divergence Step 3.2's shadow comparison exists to catch.
  const onEvent = (event: Parameters<typeof record>[0]) => {
    record(event);
    if (event.stage === "done" || event.stage === "error") {
      try {
        recordRunStatus(runId, summariseRun(runId).status);
      } catch (err) {
        console.error(`[db] could not derive final status for ${runId}:`, (err as Error)?.message ?? err);
      }
    }
  };

  // Hand back the runId immediately; the run waits for a free slot, then executes.
  // Over-cap runs sit queued (UI shows pending) until a slot frees — no dropped requests.
  // Resolve this organisation's own credentials/model/budget, if it has any and the feature is on.
  // Resolved HERE rather than inside the pipeline because it needs the database and the caller's
  // organisation, neither of which the CLI entry point has. Both calls degrade to null/undefined
  // for an unconfigured org, which is exactly the env-driven behaviour that predates this.
  runLimit.run(async () => {
    const orgId = req.organisationId ?? null;
    const [llmConfig, maxLlmCalls] = await Promise.all([
      llmConfigForOrg(orgId),
      maxCallsForOrg(orgId),
    ]);
    // The run record of its target application (D-50): runs/<id>/00-run-target.json, written only
    // for a run that has one, so an ordinary run's directory is byte-identical to before. Written
    // as the run starts rather than when it is queued, so a queued run still has no directory.
    // Non-fatal: a run must never fail because its label could not be written.
    if (targetApp) {
      try {
        const runDir = path.join("runs", runId);
        mkdirSync(runDir, { recursive: true });
        writeFileSync(path.join(runDir, "00-run-target.json"), JSON.stringify({ targetApp }, null, 2));
      } catch (err) {
        console.error(`[runs] could not record the target app for ${runId}:`, (err as Error)?.message ?? err);
      }
    }
    return runPipeline({
      prompt, url, urls, coverage,
      options: {
        ...runOptions,
        ...(llmConfig ? { llmConfig } : {}),
        ...(maxLlmCalls !== null ? { maxLlmCalls } : {}),
        ...(targetApp ? { targetApp } : {}),
      },
    // askQuestion only with RUN_QUESTIONS on (D-51): absent, the pipeline never pauses to ask.
    }, onEvent, runId, askCredentials, runQuestionsEnabled() ? askQuestion : undefined);
  })
    .catch(() => { /* failure already emitted as an "error" event */ });
  res.status(202).json({ runId });
});

// Answer a paused run's credential prompt. `{ skip: true }` (or empty values) means "carry on
// without them" — the same thing the wait timeout does.
//
// The body is never logged, never emitted as an event and never written to a run directory:
// it goes straight into the waiting promise and lives only in the pipeline's memory. The
// generated spec gets a process.env reference instead of the value (see credentials.ts).
app.post("/api/runs/:runId/credentials", requireRunRole("tester"), (req, res) => {
  const { runId } = req.params;
  if (!RUN_ID.test(runId)) return res.status(400).json({ error: "invalid runId" });

  const { username, password, skip } = req.body ?? {};
  const supplied = !skip && typeof username === "string" && typeof password === "string"
    && username.length > 0 && password.length > 0;

  // `secret: true` is what routes these away from the on-disk literal path.
  const answered = settle(runId, supplied ? { username, password, secret: true } : null);
  if (!answered) return res.status(409).json({ error: "this run is not waiting for credentials" });
  res.status(204).end();
});

// Answer a paused run's question (D-51, RUN_QUESTIONS): the one-time code a verification screen
// asked for during discovery, or the tester's instruction for drift recovery (D-52, DRIFT_RECOVERY).
// `{ questionId, answer }`, or `{ questionId, skip: true }`. A NEW route rather than a widened
// /credentials (platform rule 1). The body is never logged or emitted; it goes straight into the
// waiting promise. A code is never written anywhere; an instruction is kept, credential-redacted,
// in the run's recovered/drift-recovery.json as the record of what the tester asked for.
// `questionId` must match the question actually pending, so a stale modal cannot answer a newer one.
app.post("/api/runs/:runId/question", requireRunRole("tester"), (req, res) => {
  const { runId } = req.params;
  if (!RUN_ID.test(runId)) return res.status(400).json({ error: "invalid runId" });
  const { questionId, answer, skip } = req.body ?? {};
  if (typeof questionId !== "string" || !questionId) return res.status(400).json({ error: "questionId is required" });
  // Skip is null; an empty answer is "" — for an instruction those differ (stop vs. carry on
  // with no note), and for a code both mean "no code" (discovery ignores an empty one).
  const value = skip ? null : typeof answer === "string" ? answer.trim() : null;
  const kind = pendingQuestionKind(runId);
  if (value !== null && kind && value.length > ANSWER_LIMIT[kind]) {
    return res.status(400).json({ error: "answer is too long" });
  }
  if (!settleQuestion(runId, questionId, value)) {
    return res.status(409).json({ error: "this run is not waiting for an answer to that question" });
  }
  res.status(204).end();
});

// Submit the user's pick for a paused run's case-selection round. `done` with no picks is
// rejected when nothing was accumulated yet, so an accidental click can't end the round with
// an empty pool. Like the credential prompt, the decision goes straight into the waiting
// promise and lives only in the pipeline's memory.
app.post("/api/runs/:runId/case-selection", requireRunRole("tester"), express.json(), (req, res) => {
  const { runId } = req.params;
  if (!getPendingSelection(runId)) {
    return res.status(409).json({ error: "No case-selection round is pending for this run" });
  }
  const parsed = CaseSelectionDecisionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  if (parsed.data.action === "done") {
    const willHaveAny =
      getAllAcceptedCases(runId).length > 0 || parsed.data.selectedIndexes.length > 0;
    if (!willHaveAny) {
      return res.status(400).json({ error: "Select at least one case before clicking Done" });
    }
  }
  const resolved = resolveCaseSelection(runId, parsed.data);
  if (!resolved) {
    return res.status(409).json({ error: "This round was already resolved or timed out" });
  }
  res.status(200).json({ ok: true });
});

/**
 * "Ask for a change" for a case that is still only a proposal.
 *
 * The gate's counterpart to /api/cases/:caseId/rewrite, and separate from it because the two act
 * on different things. That route edits a SAVED case: it has an IR, its steps are grounded, and
 * every proposed line is re-checked by the real parser before anyone sees it. A case at the gate
 * has none of those -- it is plain English the model wrote minutes ago, and nothing has been
 * compiled or opened in a browser yet. Pointing the saved-case route at it would mean parsing
 * against an IR that does not exist.
 *
 * What survives from that route is the part that matters: this PROPOSES and never writes. The
 * reply fills the reviewer's editor; the case is persisted only when the round is approved
 * through POST /case-selection like any hand-typed edit. Nothing here reaches the pipeline
 * without passing back through that one door (D-27).
 *
 * The steps come from the REQUEST, not from the pending batch, because the reviewer may have
 * already edited them by hand -- asking the model to revise the batch's original wording would
 * silently discard those edits. Requiring a pending round is still the authorisation boundary:
 * no round parked, no proposal.
 *
 * Behind GATE_CASE_EDIT_AI, default OFF, for the same reason NL_STEPS_ENABLED exists -- it spends
 * a Gemini call per press. Editing cases by hand at the gate needs no flag and costs nothing.
 * Shares the rewrite rate limiter so a user cannot double their model spend by alternating
 * buttons between the two editors.
 */
app.post("/api/runs/:runId/case-selection/rewrite", requireRunRole("tester"), express.json(), async (req, res) => {
  if (!gateRewriteEnabled()) {
    return res.status(404).json({ error: "ask-for-a-change is not available here — this server has GATE_CASE_EDIT_AI off" });
  }
  if (!getPendingSelection(req.params.runId)) {
    return res.status(409).json({ error: "No case-selection round is pending for this run" });
  }
  const userId = req.user?.id ?? LOCAL_USER_ID;
  if (!consumeRewriteAttempt(userId)) {
    return res.status(429).json({ error: "too many rewrite requests — try again in a few minutes" });
  }
  const { title, steps, instruction } = req.body ?? {};
  if (!Array.isArray(steps)) {
    return res.status(400).json({ error: "steps must be an array of sentences" });
  }
  try {
    res.json(await proposeGateRewrite(
      typeof title === "string" ? title : "",
      steps,
      typeof instruction === "string" ? instruction : ""
    ));
  } catch (err) { sendAccessError(res, err); }
});

/**
 * What is actually on the discovered pages, by role and name.
 *
 * A case being reviewed at the gate has no IR yet -- it is plain English, and IR compilation and
 * grounding both happen after the round is approved. So while a reviewer edits a step, nothing
 * knows whether the control they are naming exists. `groundingError()` answers that later, against
 * the same application model this route reads.
 *
 * This closes the gap from the safe side: it does not judge what the reviewer wrote (that would
 * mean parsing a target out of free English, a regex over model-authored prose and the TD-01
 * failure this project already has on record). It shows them what is there to write about, and
 * lets them put the site's own wording into the step.
 *
 * Served from the run's saved `02-appmodel.json` rather than threaded through the gate: discovery
 * writes it before the gate parks, and the model is ~24KB on a real run, which would otherwise be
 * copied into `events.ndjson` on every single round.
 *
 * `requireRunRole("viewer")` -- it is read-only information about a run the caller can already
 * see, and `toElementIndex` emits only role and name, never a field's value.
 */
/**
 * A readable report for the WHOLE RUN — every case in one self-contained file.
 *
 * GENERATED ON DEMAND, not at execution time. Writing it during a run would mean touching the three
 * places that execute a case AND would still cover new runs only — the 200+ runs already on record
 * would keep handing out raw JSON. Reading artifacts already on disk costs one pass per request and
 * works for every run ever made, replays included.
 *
 * WHOLE RUN, NOT ONE CASE. The first version produced a page per case: four cases meant four
 * downloads, each with broken images once the file left the run folder. Screenshots are now
 * embedded as data URIs (~3MB for four cases) so the file can simply be sent to somebody.
 *
 * Every input except the result is optional — `04-ir.json` adds each step's action and target,
 * `06-diagnosis.json` exists only when a model call was made (never on a replay, TD-80), and the
 * artifacts listing decides whether a step can show its screenshot. A missing one degrades that
 * part rather than failing the page.
 */
app.get("/api/runs/:runId/report.html", requireRunRole("viewer"), (req, res) => {
  const { runId } = req.params;
  const runDir = path.join("runs", runId);
  const readJson = (...seg: string[]): any | null => {
    try { return JSON.parse(readFileSync(path.join(runDir, ...seg), "utf8")); } catch { return null; }
  };

  const summary = readJson("07-suite-summary.json");
  const input = readJson("00-input.json");
  const usage = readJson("08-llm-usage.json");

  // The suite summary is the only place that knows a case's HONEST status — blocked and
  // truncated_no_assertion cannot be expressed by 05-result.json's passed boolean. Falling back to
  // the primary case keeps single-case runs (and older runs with no summary) working.
  const entries: any[] = summary?.cases?.length
    ? summary.cases
    : [{ caseId: "case-0", title: readJson("04-ir.json")?.ir?.meta?.title ?? readJson("04-ir.json")?.meta?.title ?? "Test case",
         status: readJson("05-result.json")?.passed ? "passed" : "failed", resultPath: "" }];

  const cases = entries.map((e: any) => {
    // A suite case lives in cases/<id>/; the primary case's artifacts sit at the run root.
    const dir = e.resultPath ? path.join(runDir, "cases", e.caseId) : runDir;
    const rd = (name: string): any | null => {
      try { return JSON.parse(readFileSync(path.join(dir, name), "utf8")); } catch { return null; }
    };
    // 04-ir.json is a WRAPPER {ir, updatedAppModel} at the run root and a bare IR under cases/.
    const irRaw = rd("04-ir.json");
    let artifactFiles: string[] = [];
    const artifactsDir = path.join(dir, "artifacts");
    try { artifactFiles = readdirSync(artifactsDir); } catch { /* cleared or never written */ }

    return {
      caseId: e.caseId,
      title: e.title ?? e.caseId,
      status: e.status ?? "failed",
      whyItMatters: e.whyItMatters,
      expected: e.expected,
      saved: rd("05-result.json") ?? {},
      ir: irRaw?.ir ?? irRaw ?? null,
      diagnosis: rd("06-diagnosis.json"),
      artifactsDir,
      artifactFiles,
    };
  });

  if (!cases.length) return res.status(404).send("no cases recorded for this run");

  res.type("html").send(buildRunReportHtml({
    runId,
    prompt: input?.prompt,
    baseUrl: input?.url ?? cases[0]?.ir?.meta?.baseUrl,
    // A runId is makeRunId()'s ISO stamp with : and . swapped for -, e.g.
    // 2026-09-17T11-55-50-219Z-0a948aa9. Restore the separators rather than parsing the whole
    // thing; an unparseable id simply omits the date.
    startedAt: Date.parse(runId.replace(
      /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z.*$/, "$1T$2:$3:$4.$5Z")) || undefined,
    // Totals sit at the top level of 08-llm-usage.json, alongside byStage — not under a `totals` key.
    llmCalls: usage?.calls,
    llmTokens: usage?.totalTokens,
    cases,
  }));
});

app.get("/api/runs/:runId/page-elements", requireRunRole("viewer"), (req, res) => {
  const file = path.join("runs", req.params.runId, "02-appmodel.json");
  if (!existsSync(file)) {
    return res.status(404).json({ error: "no application model for this run yet" });
  }
  try {
    const model = JSON.parse(readFileSync(file, "utf8"));
    res.json({ pages: toElementIndex(model) });
  } catch {
    // A half-written or corrupt artifact must not fail a round a person is waiting on: the panel
    // treats this the same as "nothing to show" and stays fully usable without it.
    res.status(404).json({ error: "the application model for this run could not be read" });
  }
});

// Current accumulated pool state, for the frontend to render accepted cases and how much
// capacity remains before the pool's cap forces newer picks into overflow.
app.get("/api/runs/:runId/accepted-cases", requireRunRole("viewer"), (req, res) => {
  const cases = getAllAcceptedCases(req.params.runId);
  res.json({
    cases,
    count: cases.length,
    cap: Number(process.env.MAX_ACCUMULATED_CASES ?? 5),
    remainingCapacity: remainingCapacity(req.params.runId),
  });
});

// Snapshot of the currently-pending round, for polling (SSE buffers behind a Cloudflare
// tunnel, so the UI polls this instead). NOT a new event type — just what's parked right now.
app.get("/api/runs/:runId/case-selection-status", requireRunRole("viewer"), (req, res) => {
  const pending = getPendingSelection(req.params.runId);
  if (!pending) {
    return res.status(404).json({ error: "No case-selection round is pending" });
  }
  res.json({
    attempt: pending.attempt,
    batch: pending.batch,
    acceptedCount: getAllAcceptedCases(req.params.runId).length,
    cap: Number(process.env.MAX_ACCUMULATED_CASES ?? 5),
  });
});

// SSE stream of progress for one run. Fine locally; a Cloudflare Quick Tunnel buffers
// text/event-stream sent over GET and only flushes when the connection closes (which
// subscribe() never does), so the UI polls /state instead. See cloudflared#1449.
app.get("/api/runs/:runId/events", requireRunRole("viewer"), (req, res) => {
  subscribe(req.params.runId, res);
});

// Full event log as one JSON snapshot. Polling this can't be buffered by a proxy the way
// a stream can — the RunStore already persists every event, so this is just a read.
app.get("/api/runs/:runId/state", requireRunRole("viewer"), (req, res) => {
  res.json(getEvents(req.params.runId));
});

// History list: every run that has ever been executed, newest first.
//
// Step 3.4 scopes this to the caller's organisations. That FILTERS ROWS ONLY — every field, its
// type and its order are exactly as before, which is what keeps public/app.js and the Phase 0
// contract tests working untouched (Rule 1). Disk is still what's read; flipping authority to the
// database is Step 3.3.
app.get("/api/runs", requireRole("viewer"), async (req, res) => {
  try {
    // FILTER FIRST, THEN CAP. The other order looks equivalent and is not: filtering removes runs
    // whose ownership cannot be proved, so capping first let every unfiled directory on disk eat
    // one of the twenty visible slots. History then shrank as those accumulated and read, from the
    // outside, as "no runs happened" — measured at 20 directories on disk yielding 2 rows.
    //
    // Filtering ids is also the cheap half: it is one database lookup over the id list, whereas
    // summarising is a full event-log parse per run. So only the survivors are summarised, and
    // only the newest 20 of those.
    const userId = req.user?.id ?? LOCAL_USER_ID;
    const diskIds = allRunIds();
    const onDisk = new Set(diskIds);

    // Runs the DATABASE knows about whose directory is gone. Without these the run silently
    // disappears from History — which on ephemeral storage is most of them, and reads as "no runs
    // happened" rather than "the artifacts are gone". `diffRuns` has always detected this and only
    // ever logged it; this is the smallest change that puts it in front of the user.
    //
    // NOT Step 3.3. Disk remains authoritative for everything it still holds, and its soak gate is
    // untouched — these rows are appended, never substituted, and each is marked
    // artifactsAvailable:false rather than pretending to be a full summary.
    //
    // Non-fatal: fetchRunsFromDb returns null when the database is unreachable or disabled, and
    // History then behaves exactly as it did before. A history listing must not fail because a
    // supplementary lookup did.
    const dbRows = (await fetchRunsFromDb().catch(() => null)) ?? [];
    const orphans = dbRows.filter((r) => !onDisk.has(r.id));

    // FILTER FIRST, THEN CAP — and filter BOTH sources in one pass, so an orphan cannot skip the
    // tenancy check that every disk run goes through. Capping before filtering is TD-54.
    const visible = await filterRunsForUser(
      userId,
      [...diskIds, ...orphans.map((r) => r.id)].map((runId) => ({ runId })),
    );
    const visibleIds = new Set(visible.map((r) => r.runId));

    // Merge on recency and cap once, so the contract stays "the newest 20 you may see" rather than
    // "20 disk runs plus however many orphans".
    const merged = [
      ...listRuns(diskIds.filter((id) => visibleIds.has(id))),
      ...orphans.filter((r) => visibleIds.has(r.id)).map(summariseMissingRun),
    ]
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 20);

    res.json(merged);
  } catch (err) {
    console.error("[authz] run filtering failed:", (err as Error)?.message ?? err);
    res.status(500).json({ error: "could not list runs" });
  }
});

// Delete one run's directory. runId comes from the URL, so validate it against the exact
// makeRunId() shape before building a path (see RUN_ID above — it also won't match "_cache").
// rmSync with force so an already-gone run is a no-op.
//
// `admin` — destroying evidence (screenshots, traces, the generated spec) is irreversible and
// there is no undo, so it sits a rung above the ability to create runs.
app.delete("/api/runs/:runId", requireRunRole("admin"), (req, res) => {
  const { runId } = req.params;
  if (!RUN_ID.test(runId)) return res.status(400).json({ error: "invalid runId" });
  try {
    rmSync(path.join("runs", runId), { recursive: true, force: true });
    // Symmetry: the row goes with the files. Without this every deletion left an orphan row that
    // showed up in the startup shadow report forever. Fire-and-forget by design — the 204 below
    // reports the file deletion, which has already succeeded.
    deleteRunRow(runId);
    res.status(204).end();
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "delete failed" });
  }
});

// Health-check / diagnostic endpoint — never exposes secret values, only reports
// whether each critical env var is present so deployment problems surface fast.
app.get("/api/health", (_req, res) => {
  const check = (name: string) => {
    const val = process.env[name];
    return { set: !!val, length: val?.length ?? 0 };
  };
  res.json({
    status: "ok",
    env: {
      GEMINI_API_KEYS: check("GEMINI_API_KEYS"),
      GEMINI_API_KEY:  check("GEMINI_API_KEY"),
      GEMINI_MODEL:    check("GEMINI_MODEL"),
      GEMINI_MODEL_LITE: check("GEMINI_MODEL_LITE"),
      LLM_PROVIDER:    check("LLM_PROVIDER"),
      LLM_PROVIDER_LITE: check("LLM_PROVIDER_LITE"),
      AZURE_OPENAI_ENDPOINT: check("AZURE_OPENAI_ENDPOINT"),
      AZURE_OPENAI_API_KEY: check("AZURE_OPENAI_API_KEY"),
      AZURE_OPENAI_DEPLOYMENT: check("AZURE_OPENAI_DEPLOYMENT"),
      AZURE_OPENAI_DEPLOYMENT_LITE: check("AZURE_OPENAI_DEPLOYMENT_LITE"),
      LLM_CACHE_VERSION: check("LLM_CACHE_VERSION"),
      NODE_ENV:        check("NODE_ENV"),
      PORT:            check("PORT"),
      // ADDITIVE — appended, nothing above reordered or replaced (platform rule 1).
      //
      // Why these two specifically: this route is the ONLY remote window into a deployed
      // instance's configuration, and these were the two capability flags it could not see.
      // `defaults.gateReview` already exposes ENABLE_CASE_SELECTION_GATE, so a gate that was
      // simply off on a Container App was diagnosable from here; NL_STEPS_ENABLED and
      // GATE_CASE_EDIT_AI were not, and a run of "the feature is missing" reports cost real time
      // because an absent variable and a broken feature look identical from outside.
      //
      // Reported through the same `check()` as everything else rather than as a resolved boolean:
      // the failure this is built to catch is an ABSENT variable (`set: false`), which `check()`
      // already distinguishes, and a second reporting shape in one object is its own trap. Note
      // the values are never exposed — name, presence and length only — which is what makes this
      // route safe to leave public.
      NL_STEPS_ENABLED:  check("NL_STEPS_ENABLED"),
      GATE_CASE_EDIT_AI: check("GATE_CASE_EDIT_AI"),
    },
    // Server-side defaults for the two per-run options a client may override. The
    // UI reads these so its Settings toggles open in the state the server is
    // actually in, instead of a hardcoded guess that silently disagrees.
    defaults: {
      gateReview: process.env.ENABLE_CASE_SELECTION_GATE === "true",
      selfHeal: selfHealDefault(),
    },
    // ADDITIVE field (Step 2.2) — appended, never reordering or replacing anything above, per
    // implentationplan.md Rule 2. The UI branches on this to decide whether a login view exists
    // at all; with auth off it's `false` and the frontend behaves exactly as it always has.
    authEnabled: isAuthEnabled(),
    // ADDITIVE field — appended, nothing above reordered or replaced. Exists because the
    // "run created, all four phases PENDING, no work starts" report is indistinguishable from
    // a hung server without it: a queued run emits no stage events, so the UI has nothing to
    // show and the logs say nothing. `inFlight === max` with `queued > 0` names it outright.
    // Slots are held for the duration of the work, so a run in LLM backoff or parked on a
    // credential/case-selection prompt is holding one legitimately.
    concurrency: {
      inFlight: runLimit.inFlight,
      queued: runLimit.queued,
      max: runLimit.capacity,
    },
    // ADDITIVE, appended, and present ONLY when SALESFORCE_ENABLED=true (D-50) — the values
    // `options.targetApp` accepts. The run screen renders "This URL is a Salesforce org" only when
    // this lists "salesforce"; with the flag off the body is byte-identical to before.
    ...(salesforceEnabled() ? { targetApps: [...TARGET_APPS] } : {}),
  });
});

// What the browser needs to talk to Supabase Auth directly (Step 2.2). A NEW route rather than
// more fields on /api/health, because health's contract is "whether each env var is set, never a
// value" and this genuinely returns values.
//
// Nothing secret is exposed: the publishable key is designed to ship in client code (it grants
// only what RLS allows). The service-role key is never read here. With auth off, the URL and key
// aren't sent at all — there's nothing for the client to do with them.
app.get("/api/auth/config", (_req, res) => {
  if (!isAuthEnabled()) return res.json({ authEnabled: false });
  res.json({
    authEnabled: true,
    url: process.env.SUPABASE_URL ?? null,
    publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY ?? null,
    // ADDITIVE, and present ONLY when AUTH_TOKEN_REFRESH=true (TD-108). With the flag off the
    // body is byte-identical to before, and app.js never renews a token — the hour-long access
    // token expires exactly as it always has.
    ...(process.env.AUTH_TOKEN_REFRESH === "true" ? { tokenRefresh: true } : {}),
  });
});

/**
 * Create an account and return a session for it.
 *
 * Public by necessity (see PUBLIC_API_PATHS) and therefore the most exposed route in this server:
 * it is the only unauthenticated endpoint that *writes*, and it writes with an admin key. The
 * ordering below is deliberate — flag, then rate limit, then validation — so a disabled or
 * flooded endpoint costs nothing and never reaches Supabase.
 *
 * Why this exists at all rather than the browser calling Supabase directly: signup.ts's header.
 */
app.post("/api/auth/signup", async (req, res) => {
  if (!isAuthEnabled()) {
    // With auth off there is no sign-up screen and no login, so an account would be unusable.
    // Refuse plainly rather than creating something nobody can sign in as.
    return res.status(404).json({ error: "sign-up is not available — this server has AUTH_ENABLED off" });
  }
  if (!isSignupEnabled()) {
    return res.status(403).json({ error: "sign-up is closed on this server" });
  }

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  if (!consumeSignupAttempt(ip)) {
    return res.status(429).json({ error: "too many sign-up attempts — wait a few minutes and try again" });
  }

  const { email, password } = req.body ?? {};
  if (typeof email !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "email and password are required" });
  }

  try {
    const result = await createAccount(email, password);
    // Give the new account its own organisation before replying, so the session the client
    // receives is immediately usable. Doing it here rather than leaving it to the client's
    // bootstrap call means there is no window where a signed-in user belongs nowhere.
    try {
      await bootstrapUser(result.user.id, result.user.email);
    } catch (err) {
      // The account and session are real; only the workspace is missing, and the client's own
      // refreshIdentity() calls bootstrap again on every sign-in. Log and continue rather than
      // failing a sign-up that actually succeeded.
      console.error("[signup] bootstrap after sign-up failed:", (err as Error)?.message ?? err);
    }
    res.status(201).json(result);
  } catch (err) {
    sendAccessError(res, err);
  }
});

// --------------------------------------------------------------------------
// Identity & membership (Step 3.4, plus Step 5.4's role management)
//
// All NEW routes — no existing route's shape changes anywhere in this phase.
// --------------------------------------------------------------------------

/** Translate an AccessError into its status; anything else is a 500 we shouldn't leak details of. */
function sendAccessError(res: express.Response, err: unknown): void {
  // A stale edit is not an access failure — it carries the winning state so the loser of the race
  // can see what they would have overwritten, which is the entire point of refusing.
  if (err instanceof CaseConflictError) {
    res.status(409).json({
      error: err.message,
      expectedVersion: err.expectedVersion,
      currentVersion: err.currentVersion,
      current: {
        title: err.current.title,
        currentVersion: err.current.currentVersion,
        steps: err.current.ir.steps.map((s) => ({ id: s.id, text: formatIrStep(s) })),
      },
    });
    return;
  }
  if (err instanceof AccessError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  console.error("[api]", (err as Error)?.message ?? err);
  res.status(500).json({ error: "request failed" });
}

/**
 * Who am I, and what may I do? The UI reads this to label the session and to hide actions the
 * caller's role forbids.
 *
 * Hiding a button is a courtesy, never a control — every action this reports on is independently
 * enforced server-side by the middleware above. This endpoint being wrong (or lied to) changes
 * what the UI draws and nothing else.
 */
app.get("/api/auth/me", async (req, res) => {
  const userId = req.user?.id ?? LOCAL_USER_ID;
  try {
    const organisationId = await primaryOrgFor(userId);
    const role = organisationId ? await assertOrgAccess(userId, organisationId, "viewer") : null;
    res.json({
      userId,
      email: req.user?.email ?? null,
      synthetic: req.user?.synthetic ?? true,
      organisationId,
      role,
      tenancyEnforced: canEnforceTenancy(),
    });
  } catch (err) {
    sendAccessError(res, err);
  }
});

/**
 * Give a signed-in account somewhere to belong, creating an organisation it owns if it has none.
 *
 * Idempotent, and called after every sign-in rather than only after sign-up: an account created
 * straight in the Supabase dashboard never touches this server, and without this would have a
 * working login that could do nothing at all.
 */
app.post("/api/auth/bootstrap", async (req, res) => {
  try {
    const result = await bootstrapUser(req.user?.id ?? LOCAL_USER_ID, req.user?.email ?? null);
    res.json(result);
  } catch (err) {
    sendAccessError(res, err);
  }
});

/**
 * Create a new organisation, with the caller as its owner.
 *
 * NO ROLE GATE, DELIBERATELY. Every other route in this file asks "what may you do *within* an
 * organisation", and this one is the only thing that happens outside every organisation — there is
 * no org to check a role against, and requiring one would mean only an existing tenant could create
 * a tenant. The gate that does apply is `requireAuth` on `/api/*`: you must be a real signed-in
 * account. A caller only ever gains an organisation of their own here, never any access to anyone
 * else's, so this widens nothing.
 *
 * It is therefore also the self-serve tenant-creation endpoint, and it inherits sign-up's exposure:
 * with `SIGNUP_ENABLED` on and this port reachable, strangers can create tenants. See
 * bootstrapUser's header.
 */
app.post("/api/organisations", async (req, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  try {
    res.status(201).json(await createOrganisation(req.user?.id ?? LOCAL_USER_ID, name));
  } catch (err) {
    sendAccessError(res, err);
  }
});

// --------------------------------------------------------------------------
// Projects (Step 5.1) — the second axis of access.
//
// Org role says what you may DO; project membership says what you may SEE. Admins and owners see
// every project in their organisation by role; a tester or viewer sees only what they've been
// added to, and a brand-new account has been added to nothing.
//
// All NEW routes. Every one takes its organisation from `req.organisationId`, which requireRole
// derives from the *session* — never from the body or the query, per the plan's rule.
// --------------------------------------------------------------------------

app.get("/api/projects", requireRole("viewer"), async (req, res) => {
  try {
    const userId = req.user?.id ?? LOCAL_USER_ID;
    res.json({ projects: await listVisibleProjects(userId, req.organisationId!, req.organisationRole!) });
  } catch (err) {
    sendAccessError(res, err);
  }
});

app.post("/api/projects", requireRole("admin"), async (req, res) => {
  const { name, baseUrl } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  try {
    res.status(201).json(await createProject(
      req.organisationId!,
      name,
      typeof baseUrl === "string" ? baseUrl : "",
    ));
  } catch (err) {
    sendAccessError(res, err);
  }
});

/**
 * Drop every cached browser walk.
 *
 * A NEW route, not a change to an existing one (`CLAUDE.md` rule 1). It exists because a walk's
 * result can go stale in ways its cache key cannot express — most sharply, a walk whose sign-in
 * failed used to be cached under a key identical to a successful one, and the disk half of that
 * cache never expires, so one bad sign-in pinned a login-page snapshot for that case forever
 * (`TECH_DEBT.md` TD-85). The key now includes a credential fingerprint and a failed sign-in is
 * no longer cached at all, so this is the escape hatch for entries written before that — and for
 * the ordinary case of a site that changed under a cache that has no reason to know.
 *
 * Admin, because it throws away work that other people in the organisation may be relying on
 * mid-edit. It touches only the `walks` namespace: the LLM answers alongside it cost real money
 * and have nothing to do with this failure.
 */
app.post("/api/cache/walks/clear", requireRole("admin"), (_req, res) => {
  const removed = llmCacheClear(WALK_CACHE_NS);
  res.json({
    removed,
    message: removed === 1
      ? "Cleared 1 cached page verification."
      : `Cleared ${removed} cached page verifications.`,
  });
});

app.patch("/api/projects/:projectId", requireRole("admin"), async (req, res) => {
  const { name, baseUrl } = req.body ?? {};
  try {
    res.json(await updateProject(req.organisationId!, req.params.projectId, { name, baseUrl }));
  } catch (err) {
    sendAccessError(res, err);
  }
});

/**
 * What deleting this project would destroy or unfile — counts only, nothing is changed.
 *
 * A NEW route rather than a field on an existing one (platform rule 1). The delete itself is
 * unchanged in shape: it still takes no body and still answers 204. This exists because the
 * cascade is invisible from the client — `projects → suites` and `projects → test_cases` are both
 * ON DELETE CASCADE — so the UI can state exactly what is about to go before asking for
 * confirmation.
 */
app.get("/api/projects/:projectId/deletion-impact", requireRole("admin"), async (req, res) => {
  try {
    res.json(await projectDeletionImpact(req.organisationId!, req.params.projectId));
  } catch (err) {
    sendAccessError(res, err);
  }
});

app.delete("/api/projects/:projectId", requireRole("admin"), async (req, res) => {
  try {
    await deleteProject(req.organisationId!, req.params.projectId);
    res.status(204).end();
  } catch (err) {
    sendAccessError(res, err);
  }
});

app.get("/api/projects/:projectId/members", requireRole("admin"), async (req, res) => {
  try {
    res.json({ members: await listProjectMembers(req.organisationId!, req.params.projectId) });
  } catch (err) {
    sendAccessError(res, err);
  }
});

app.post("/api/projects/:projectId/members", requireRole("admin"), async (req, res) => {
  const { email, userId } = req.body ?? {};
  try {
    // Accept either an id (the Team screen has one already) or an address (typed by hand).
    let targetId: string | null = typeof userId === "string" && userId ? userId : null;
    if (!targetId) {
      if (typeof email !== "string" || !email.trim()) {
        return res.status(400).json({ error: "email or userId is required" });
      }
      const found = await findUserByEmail(email);
      if (!found) return res.status(404).json({ error: "no account with that email" });
      targetId = found.id;
    }
    const isOrgMember = !!(await roleOfMember(req.organisationId!, targetId));
    await addProjectMember(req.organisationId!, req.params.projectId, targetId, isOrgMember);
    res.status(201).json({ ok: true, userId: targetId });
  } catch (err) {
    sendAccessError(res, err);
  }
});

app.delete("/api/projects/:projectId/members/:userId", requireRole("admin"), async (req, res) => {
  try {
    await removeProjectMember(req.organisationId!, req.params.projectId, req.params.userId);
    res.status(204).end();
  } catch (err) {
    sendAccessError(res, err);
  }
});

/** Every project assignment in the org — one call so the Team screen renders in one pass. */
/**
 * Per-organisation LLM configuration — the admin panel's read and write.
 *
 * TENANCY. `requireOrgRole("admin")` proves the caller is an admin OF THE ORGANISATION IN THE
 * PATH, not merely an admin somewhere; `describeOrgLlmConfig`/`setOrgLlmConfig` then re-assert it
 * with `assertOrgAccess` before touching a row. An admin of org A naming org B is refused by both.
 *
 * THE KEY IS WRITE-ONLY. The GET returns `keySet` and a four-character hint and nothing else —
 * there is no shape in `OrgLlmConfigView` that could carry a key, and no route that reveals one.
 * The only decryption in the codebase happens in `llmConfigForOrg`, straight into an in-memory
 * KeyPool for one run.
 *
 * Additive: new paths, no existing route's request or response shape changes (rule 1).
 */
app.get("/api/organisations/:orgId/llm-config", requireOrgRole("admin"), async (req, res) => {
  if (!orgLlmConfigEnabled()) {
    return res.status(404).json({ error: "per-organisation LLM configuration is not available — this server has ORG_LLM_CONFIG_ENABLED off" });
  }
  try {
    res.json(await describeOrgLlmConfig(req.user?.id ?? LOCAL_USER_ID, req.params.orgId));
  } catch (err) { sendAccessError(res, err); }
});

app.put("/api/organisations/:orgId/llm-config", requireOrgRole("admin"), async (req, res) => {
  if (!orgLlmConfigEnabled()) {
    return res.status(404).json({ error: "per-organisation LLM configuration is not available — this server has ORG_LLM_CONFIG_ENABLED off" });
  }
  const { apiKey, model, modelLite, maxCallsPerRun } = req.body ?? {};
  try {
    // `apiKey` is read here and never again: it goes into setOrgLlmConfig, is encrypted, and the
    // view that comes back cannot express it. It is deliberately not logged, not echoed in an
    // error, and not included in any event.
    res.json(await setOrgLlmConfig(req.user?.id ?? LOCAL_USER_ID, req.params.orgId, {
      ...(apiKey === undefined ? {} : { apiKey: apiKey === null ? null : String(apiKey) }),
      ...(model === undefined ? {} : { model: model === null ? null : String(model) }),
      ...(modelLite === undefined ? {} : { modelLite: modelLite === null ? null : String(modelLite) }),
      ...(maxCallsPerRun === undefined ? {} : {
        maxCallsPerRun: maxCallsPerRun === null ? null : Number(maxCallsPerRun),
      }),
    }));
  } catch (err) { sendAccessError(res, err); }
});

// D-36: open to every member, but SCOPED. Admin/owner get the whole map exactly as before; anyone
// else gets only the projects they are in themselves, and only the people who share one — the
// same visible set the roster below is cut to. The response shape is unchanged (rule 1).
app.get("/api/organisations/:orgId/assignments", requireOrgRole("viewer"), async (req, res) => {
  try {
    const map = await assignmentsVisibleTo(
      req.params.orgId,
      req.user?.id ?? LOCAL_USER_ID,
      req.organisationRole!,
    );
    res.json({ assignments: Object.fromEntries(map) });
  } catch (err) {
    sendAccessError(res, err);
  }
});

app.get("/api/organisations/:orgId/members", requireOrgRole("viewer"), async (req, res) => {
  try {
    // D-36: below admin, the roster is yourself plus whoever shares a project with you in this
    // organisation. Enforced here, in the query — not by the Team screen hiding rows.
    res.json({
      members: await listMembersVisibleTo(req.params.orgId, req.user?.id ?? LOCAL_USER_ID, req.organisationRole!),
    });
  } catch (err) {
    sendAccessError(res, err);
  }
});

app.post("/api/organisations/:orgId/members", requireOrgRole("admin"), async (req, res) => {
  const { email, role } = req.body ?? {};
  if (typeof email !== "string" || !email.trim()) {
    return res.status(400).json({ error: "email is required" });
  }
  if (!isRole(role)) {
    return res.status(400).json({ error: "role must be one of: owner, admin, tester, viewer" });
  }
  try {
    res.status(201).json(await addMember(req.params.orgId, req.organisationRole!, email, role));
  } catch (err) {
    sendAccessError(res, err);
  }
});

app.patch("/api/organisations/:orgId/members/:userId", requireOrgRole("admin"), async (req, res) => {
  const { role } = req.body ?? {};
  if (!isRole(role)) {
    return res.status(400).json({ error: "role must be one of: owner, admin, tester, viewer" });
  }
  try {
    res.json(await changeMemberRole(
      req.params.orgId,
      req.organisationRole!,
      req.user?.id ?? LOCAL_USER_ID,
      req.params.userId,
      role,
    ));
  } catch (err) {
    sendAccessError(res, err);
  }
});

app.delete("/api/organisations/:orgId/members/:userId", requireOrgRole("admin"), async (req, res) => {
  try {
    await removeMember(req.params.orgId, req.organisationRole!, req.params.userId);
    res.status(204).end();
  } catch (err) {
    sendAccessError(res, err);
  }
});

// --------------------------------------------------------------------------
// The test-case library (Steps 5.2, 5.3, 5.5)
//
// All NEW routes. Everything is scoped by PROJECT — the Step 5.1 visibility axis — rather than by
// a new permission concept: a case is reachable exactly when its project is, and library.ts
// re-derives that from the id on every call rather than trusting one supplied by the caller.
//
// Role gating, matching the rest of the server: composing the library is authoring (`tester`),
// destroying authored work is administration (`admin`), and reading is `viewer` — but a viewer
// still only ever sees projects they were added to.
// --------------------------------------------------------------------------

const libraryCtx = (req: express.Request) =>
  [req.user?.id ?? LOCAL_USER_ID, req.organisationId!, req.organisationRole!] as const;

app.get("/api/suites", requireRole("viewer"), async (req, res) => {
  try {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    res.json({ suites: await listSuites(...libraryCtx(req), projectId) });
  } catch (err) { sendAccessError(res, err); }
});

app.post("/api/suites", requireRole("tester"), async (req, res) => {
  const { projectId, name } = req.body ?? {};
  if (typeof projectId !== "string" || !projectId) {
    return res.status(400).json({ error: "projectId is required" });
  }
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  try {
    res.status(201).json(await createSuite(...libraryCtx(req), projectId, name));
  } catch (err) { sendAccessError(res, err); }
});

app.patch("/api/suites/:suiteId", requireRole("tester"), async (req, res) => {
  const { name } = req.body ?? {};
  if (typeof name !== "string" || !name.trim()) {
    return res.status(400).json({ error: "name is required" });
  }
  try {
    res.json(await renameSuite(...libraryCtx(req), req.params.suiteId, name));
  } catch (err) { sendAccessError(res, err); }
});

// `admin` — same rung as deleting a run. A suite is a grouping, so the cases survive, but
// rebuilding a curated ordering by hand is real lost work.
app.delete("/api/suites/:suiteId", requireRole("admin"), async (req, res) => {
  try {
    await deleteSuite(...libraryCtx(req), req.params.suiteId);
    res.status(204).end();
  } catch (err) { sendAccessError(res, err); }
});

app.get("/api/suites/:suiteId/cases", requireRole("viewer"), async (req, res) => {
  try {
    res.json({ cases: await listSuiteCases(...libraryCtx(req), req.params.suiteId) });
  } catch (err) { sendAccessError(res, err); }
});

app.post("/api/suites/:suiteId/cases", requireRole("tester"), async (req, res) => {
  const { caseId } = req.body ?? {};
  if (typeof caseId !== "string" || !caseId) {
    return res.status(400).json({ error: "caseId is required" });
  }
  try {
    await addCaseToSuite(...libraryCtx(req), req.params.suiteId, caseId);
    res.status(201).json({ ok: true });
  } catch (err) { sendAccessError(res, err); }
});

app.delete("/api/suites/:suiteId/cases/:caseId", requireRole("tester"), async (req, res) => {
  try {
    await removeCaseFromSuite(...libraryCtx(req), req.params.suiteId, req.params.caseId);
    res.status(204).end();
  } catch (err) { sendAccessError(res, err); }
});

/** Rewrite execution order. The body is the full ordered list of the suite's case ids. */
app.patch("/api/suites/:suiteId/order", requireRole("tester"), async (req, res) => {
  const { caseIds } = req.body ?? {};
  if (!Array.isArray(caseIds) || caseIds.some((c) => typeof c !== "string")) {
    return res.status(400).json({ error: "caseIds must be an array of case ids" });
  }
  try {
    await reorderSuite(...libraryCtx(req), req.params.suiteId, caseIds);
    res.status(204).end();
  } catch (err) { sendAccessError(res, err); }
});

app.get("/api/cases", requireRole("viewer"), async (req, res) => {
  try {
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : undefined;
    // Optional additive filter (rule 1): only the loader asks for unfiled, and only when it wants
    // the "Not in a suite" group. Anyone else keeps the exact response they get today.
    const unfiled = req.query.unfiled === "1" || req.query.unfiled === "true";
    res.json({ cases: await listCases(...libraryCtx(req), projectId, unfiled) });
  } catch (err) { sendAccessError(res, err); }
});

app.get("/api/cases/:caseId", requireRole("viewer"), async (req, res) => {
  try {
    res.json(await getCase(...libraryCtx(req), req.params.caseId));
  } catch (err) { sendAccessError(res, err); }
});

/**
 * The Playwright script for a saved case — the Script tab's source of truth.
 *
 * NEW route rather than a field on `GET /api/cases/:caseId`, per platform rule 1: that response is
 * read in many places and the spec is large, so it does not belong on every case fetch.
 *
 * Optional `?version=N` returns that version's script instead of the current one. Answers for any
 * case the caller can already read — a script is a rendering of the IR they can see anyway, so it
 * needs no permission beyond `viewer`, the same gate as `GET /api/cases/:caseId`.
 *
 * The Script tab used to read the originating run's artifact folder directly, which meant deleting
 * a run silently emptied the tab of every case saved from it (`TECH_DEBT.md` TD-68).
 */
app.get("/api/cases/:caseId/script", requireRole("viewer"), async (req, res) => {
  const raw = req.query.version;
  let version: number | undefined;
  if (typeof raw === "string" && raw !== "") {
    version = Number(raw);
    if (!Number.isInteger(version) || version < 1) {
      return res.status(400).json({ error: "version must be a positive integer" });
    }
  }
  try {
    res.json(await getCaseScript(...libraryCtx(req), req.params.caseId, version));
  } catch (err) { sendAccessError(res, err); }
});

/** One stored version's steps — what the Compare screen reads for each side. */
app.get("/api/cases/:caseId/versions/:version", requireRole("viewer"), async (req, res) => {
  const version = Number(req.params.version);
  if (!Number.isInteger(version) || version < 1) {
    return res.status(400).json({ error: "version must be a positive integer" });
  }
  try {
    res.json(await getCaseVersion(...libraryCtx(req), req.params.caseId, version));
  } catch (err) { sendAccessError(res, err); }
});

app.patch("/api/cases/:caseId", requireRole("tester"), async (req, res) => {
  const { title, ir, changeNote, expectedVersion } = req.body ?? {};
  try {
    res.json(await updateCase(...libraryCtx(req), req.params.caseId, {
      title, ir, changeNote,
      expectedVersion: typeof expectedVersion === "number" ? expectedVersion : undefined,
    }));
  } catch (err) { sendAccessError(res, err); }
});

/**
 * A case's steps as the sentences the editor shows — the read side of English editing.
 *
 * Rendered SERVER-side from the same `formatIrStep` the parser is paired with, so the text a
 * person edits is provably the text `parseIrSteps` expects back. The browser has its own copy for
 * display; `tests/stepText.test.ts` pins the two identical so this can never disagree with what is
 * already on screen.
 */
app.get("/api/cases/:caseId/steps", requireRole("viewer"), async (req, res) => {
  try {
    const found = await getCase(...libraryCtx(req), req.params.caseId);
    res.json({
      caseId: found.id,
      currentVersion: found.currentVersion,
      expected: found.ir.meta.title,
      steps: found.ir.steps.map((s) => ({ id: s.id, text: formatIrStep(s) })),
      // ADDITIVE, OPTIONAL. Tells the editor whether to offer "Write it for me" on an
      // unreadable line. A capability the server does not have must not be advertised as a
      // button that 404s, and the editor has no parser of its own to decide this locally.
      nlSteps: nlStepsEnabled(),
    });
  } catch (err) { sendAccessError(res, err); }
});

/**
 * Save edited steps written in plain English — the write side, and the expensive one.
 *
 * Three things happen, in this order, and none of them can be skipped:
 *   1. PARSE each sentence back to a step, merged onto the one it was rendered from. An untouched
 *      line returns its original object byte-for-byte, `${env:...}` and grounding intact.
 *   2. RE-GROUND whatever changed against the live site — walking the earlier steps to arrive at
 *      the right page, because step 7 cannot be checked without executing steps 1-6.
 *   3. WRITE, minting a version.
 *
 * A failure in 1 or 2 returns the offending step's index and id so the editor can attach the
 * message to that row. Nothing is stored unless all three succeed: a case whose steps no longer
 * resolve is worse than an unsaved edit, because it looks fine until it runs.
 */
/**
 * Shared prelude for the estimate and the save: read the case, refuse a stale edit, parse.
 *
 * The staleness check happens HERE, before any browser work. Refusing an edit after spending 90
 * seconds and a browser launch on it would charge the user for work that was never going to be
 * saved.
 */
async function prepareEdit(req: express.Request, res: express.Response) {
  const { steps, expectedVersion } = req.body ?? {};
  if (!Array.isArray(steps) || steps.length === 0) {
    res.status(400).json({ error: "send the edited steps as a non-empty array of strings" });
    return null;
  }
  const ctx = libraryCtx(req);
  const found = await getCase(...ctx, req.params.caseId);

  if (typeof expectedVersion === "number" && expectedVersion !== found.currentVersion) {
    res.status(409).json({
      error:
        `this case has changed since you opened it — you have v${expectedVersion}, it is now ` +
        `v${found.currentVersion}. Review the newer version before saving over it.`,
      expectedVersion,
      currentVersion: found.currentVersion,
      current: {
        title: found.title,
        currentVersion: found.currentVersion,
        steps: found.ir.steps.map((s) => ({ id: s.id, text: formatIrStep(s) })),
      },
    });
    return null;
  }

  const parsed = parseIrSteps(steps.map((s: unknown) => String(s ?? "")), found.ir.steps);
  if (!parsed.ok) {
    res.status(400).json({
      error: parsed.error,
      stepIndex: parsed.index,
      stepId: found.ir.steps[parsed.index]?.id ?? null,
    });
    return null;
  }

  // A credential the person typed must never be what gets STORED. `restoreCredentialRefs` puts
  // recognised values back behind `${env:...}` and hands the literals back separately, in memory,
  // for this save's own walk only (CLAUDE.md rule 5, TECH_DEBT.md TD-67). Applied here rather than
  // in either branch below, so the fast path and the job path cannot diverge on it.
  const safe = restoreCredentialRefs(parsed.result.steps, found.ir.steps);

  // Does this edit leave the test checking anything?
  //
  // `meta.hasTerminalAssertion` is what tells a run whether a truncated case may report "passed"
  // — nothing recomputed it on the edit path, so removing the last `Check ...` row saved happily,
  // kept the stale `true`, and the case reported Passed forever while verifying nothing. A test
  // that cannot fail is worse than no test: it is a green tick someone will trust. TD-89.
  //
  // Recomputed on EVERY save (below), and refused when the edit is what removed it — unless the
  // person says they meant it. `confirmNoAssertion` is a new OPTIONAL request field, so every
  // existing client is unaffected (rule 1).
  // From the STORED STEPS, not from `meta.hasTerminalAssertion` — that flag is precisely the
  // thing this defect proves untrustworthy (nothing recomputed it on edit, and it is optional so
  // it is often simply absent). Deriving "did it have one?" from the flag also refuses every edit
  // to a case that never had an assertion at all, which caught six existing tests: a login case
  // is navigate/fill/fill/click and asserts nothing, and editing its email should stay instant.
  //
  // The refusal is for the edit that REMOVES the last check — not for a case that never had one.
  const hadAssertion = hasTerminalAssertion(found.ir.steps);
  const stillAsserts = hasTerminalAssertion(safe.steps);
  if (hadAssertion && !stillAsserts && req.body?.confirmNoAssertion !== true) {
    res.status(400).json({
      error:
        "this edit removes the last check, so the test would run to the end and report Passed " +
        "without verifying anything. Save it anyway only if you meant to.",
      // Named so the client can offer "Save anyway" instead of treating it as a broken row.
      // Deliberately NOT a `stepIndex`: no single row is at fault.
      needsConfirmation: "noAssertion",
    });
    return null;
  }

  // Structurally valid before it is ever checked against a live site — a malformed plan should
  // fail in milliseconds, not after a browser walk.
  const validated = parseIr(
    { ...found.ir, steps: safe.steps, meta: { ...found.ir.meta, hasTerminalAssertion: stillAsserts } },
    "the edited test plan",
  );
  // Same IR with the typed literals still in place. NEVER written, never serialised to a client.
  const liveIr = parseIr(
    { ...found.ir, steps: safe.live, meta: { ...found.ir.meta, hasTerminalAssertion: stillAsserts } },
    "the edited test plan",
  );
  return { ctx, found, parsed: parsed.result, validated, liveIr, credentialNote: safe.note, typedCreds: safe.creds };
}

/**
 * The credentials the re-ground walk will need, or undefined if it needs none.
 *
 * Resolved BEFORE the walk starts, not lazily inside it, for two reasons: the steps already say
 * whether a credential is needed (`credentialKindsNeeded` reads the `${env:...}` values
 * `applyCredentials` wrote when the case was authored), and asking first means a prompt the user
 * ignores costs no browser time at all — there is nothing running to leak.
 *
 * ENV FIRST, PROMPT SECOND. `TEST_USERNAME`/`TEST_PASSWORD` are the same pair the generated spec
 * references and the executor injects, so an operator who has already set them for their runs gets
 * a silent save. Only when they are absent does this park the job and ask, through the SAME
 * `askCredentials` mechanism a run uses — one waiter table, one timeout, one set of guarantees.
 *
 * Never returned to a caller that writes: the value lives in this promise and in the walk, and
 * `regroundEditedIr` redacts it out of anything it reports.
 */
async function resolveWalkCredentials(
  jobId: string,
  ir: { meta?: { baseUrl?: string }; steps: { value?: string }[] },
  needsCredentials: boolean,
): Promise<Credentials | undefined> {
  if (!needsCredentials) return undefined;
  // ENV FIRST for the re-ground walk, unchanged: this runs inside a save the person already
  // asked for, so an operator who configured the environment should not be interrupted by it.
  return resolveCredentialsVia(
    jobId,
    ir.meta?.baseUrl ?? "",
    credentialKindsNeeded(ir.steps),
    // `caseEdit: true` on the STARTED event only, exactly as before: app.js reads it to choose the
    // editor's wording, and adding it to the completed event would change a shape the UI reads.
    (status, data) => emitJobEvent(jobId, "credentials", status,
      status === "started" ? { ...data, caseEdit: true } : data),
    "env-first",
  );
}

/**
 * What would saving this cost? Answers WITHOUT doing any of it.
 *
 * Pure arithmetic over the diff — no browser, no model, no write. This is what lets the editor say
 * "this will re-check 2 steps, about 40 seconds" *before* Save is clicked, so a save that spends
 * real time is never a surprise. Call it on every edit; it is cheap enough to be live.
 */
app.post("/api/cases/:caseId/steps/estimate", requireRole("tester"), async (req, res) => {
  try {
    const prep = await prepareEdit(req, res);
    if (!prep) return;
    res.json({
      ...estimateRegrounding(prep.parsed),
      currentVersion: prep.found.currentVersion,
    });
  } catch (err) { sendAccessError(res, err); }
});

/**
 * Save edited steps written in plain English.
 *
 * TWO PATHS, and the client branches on which it got back:
 *
 *  - **Fast path (200).** Nothing points at a different element — a retyped fill value, a
 *    reordered-but-identical list, a rename. No browser, no job, no waiting: the parse already
 *    proved the steps still carry the grounding they always had. Saved synchronously.
 *
 *  - **Job path (202 `{jobId}`).** At least one step points somewhere new and must be verified
 *    against the live site. Returns immediately; progress arrives as `StageEvent`s on
 *    `/api/cases/:caseId/steps/jobs/:jobId/events` (SSE) or `/state` (poll), and the job can be
 *    cancelled. Nothing is written until it succeeds.
 *
 * The line between them is `regroundIndexes` — the steps whose TARGET changed. That is the same
 * number `/estimate` reports, so what the UI promised is exactly what it gets.
 */
app.post("/api/cases/:caseId/steps", requireRole("tester"), async (req, res) => {
  const { changeNote, expectedVersion } = req.body ?? {};
  try {
    const prep = await prepareEdit(req, res);
    if (!prep) return;
    const { ctx, found, parsed, validated, liveIr, credentialNote, typedCreds } = prep;
    const caseId = req.params.caseId;
    const userId = req.user?.id ?? LOCAL_USER_ID;

    const writeIt = async (ir: typeof validated) => updateCase(...ctx, caseId, {
      ir,
      changeNote: typeof changeNote === "string" ? changeNote : undefined,
      // Re-checked inside updateCase against the row it is about to write, closing the window
      // between the check in prepareEdit and this write.
      expectedVersion: typeof expectedVersion === "number" ? expectedVersion : undefined,
    });

    // ---- fast path ------------------------------------------------------
    if (parsed.regroundIndexes.length === 0) {
      const updated = await writeIt(validated);
      return res.json({
        ...updated,
        mode: "instant",
        regrounded: 0,
        snapshots: 0,
        steps: validated.steps.map((s) => ({ id: s.id, text: formatIrStep(s) })),
        // Optional and absent unless something was rewritten.
        ...(credentialNote ? { credentialNote } : {}),
      });
    }

    // ---- job path -------------------------------------------------------
    const jobId = makeRunId();
    createJob(jobId, userId, caseId);
    const estimate = estimateRegrounding(parsed);
    res.status(202).json({ jobId, mode: "verifying", ...estimate, ...(credentialNote ? { credentialNote } : {}) });

    // Deliberately not awaited: the response is already sent. Every outcome ends in a `done` or
    // `error` event, which is what closes the stream.
    void (async () => {
      emitJobEvent(jobId, "ir", "started", { ...estimate, caseId });
      try {
        // Prefer what the person just typed — they are demonstrably the right credentials for the
        // steps being saved. Falls back to the usual env-or-prompt resolution otherwise.
        const creds = typedCreds
          ?? await resolveWalkCredentials(jobId, validated, estimate.needsCredentials);
        // Cancelled while the prompt was open, or the prompt timed out into a cancel. Return
        // before any browser launches — there is nothing to close and nothing to write.
        if (isCancelled(jobId)) {
          emitJobEvent(jobId, "done", "completed", { cancelled: true, saved: false, snapshots: 0 },
            "cancelled before saving — nothing was written, and the case is exactly as it was");
          return;
        }

        // liveIr, not validated: the walk has to actually sign in, so it needs the real values.
        // Only `validated` — which carries `${env:...}` — is ever written by writeIt() below.
        const grounded = await regroundEditedIr(liveIr, parsed.regroundIndexes, {
          sourceRunId: found.sourceRunId,
          creds,
          shouldCancel: () => isCancelled(jobId),
          onProgress: (p) => emitJobEvent(jobId, "ir", "started", p),
        });

        if (!grounded.ok) {
          // Cancelled and failed are different outcomes and the UI says different things about
          // them, but neither writes: this branch never reaches writeIt().
          emitJobEvent(jobId, grounded.cancelled ? "done" : "error", grounded.cancelled ? "completed" : "failed", {
            cancelled: !!grounded.cancelled,
            saved: false,
            stepIndex: grounded.stepIndex,
            stepId: grounded.stepId,
            snapshots: grounded.snapshots,
            usage: grounded.usage,
          }, grounded.message);
          return;
        }

        // The walk ran against liveIr, so grounded.ir still holds the typed literals. Grounding
        // only ever rewrites TARGETS (css/testId/nth), never values, so putting the `${env:...}`
        // references back is a straight per-step restore — and it is what stops the secret being
        // written one line below. Restored only where the safe IR actually held a reference, so a
        // non-credential value the walk saw is left exactly as it is.
        const safeIr = {
          ...grounded.ir,
          steps: grounded.ir.steps.map((st, i) => {
            const ref = validated.steps[i]?.value;
            return isEnvValueRef(ref) ? { ...st, value: ref } : st;
          }),
        };

        const updated = await writeIt(safeIr);
        emitJobEvent(jobId, "done", "completed", {
          saved: true,
          cancelled: false,
          case: updated,
          regrounded: parsed.regroundIndexes.length,
          snapshots: grounded.snapshots,
          usage: grounded.usage,
          steps: safeIr.steps.map((s) => ({ id: s.id, text: formatIrStep(s) })),
          ...(credentialNote ? { credentialNote } : {}),
        });
      } catch (err: any) {
        // Includes the 409 raised by updateCase if someone else saved during the walk.
        emitJobEvent(jobId, "error", "failed", {
          saved: false,
          conflict: err instanceof CaseConflictError,
          currentVersion: err instanceof CaseConflictError ? err.currentVersion : undefined,
        }, err?.message ?? String(err));
      }
    })();
  } catch (err) { sendAccessError(res, err); }
});

/** Live progress for a re-ground. SSE, same contract as a run's event stream. */
app.get("/api/cases/:caseId/steps/jobs/:jobId/events", requireRole("tester"), (req, res) => {
  const job = getJob(req.params.jobId, req.user?.id ?? LOCAL_USER_ID);
  if (!job) return res.status(404).json({ error: "no such editing session" });
  subscribeJob(job, res);
});

/** Poll fallback — SSE buffers behind a Cloudflare tunnel, the same reason runs have one. */
app.get("/api/cases/:caseId/steps/jobs/:jobId/state", requireRole("tester"), (req, res) => {
  const job = getJob(req.params.jobId, req.user?.id ?? LOCAL_USER_ID);
  if (!job) return res.status(404).json({ error: "no such editing session" });
  res.json(jobEvents(job));
});

/**
 * Stop a re-ground in flight.
 *
 * Read between snapshots, so it lands before the next browser launch; an in-flight snapshot
 * finishes and closes its own browser either way. **Nothing is written** — a cancelled job never
 * reaches the update, so there is no version row, no `current_version` bump, and the stored case
 * is byte-identical to before it started.
 */
app.post("/api/cases/:caseId/steps/jobs/:jobId/cancel", requireRole("tester"), (req, res) => {
  const job = getJob(req.params.jobId, req.user?.id ?? LOCAL_USER_ID);
  if (!job) return res.status(404).json({ error: "no such editing session" });
  cancelJob(job);
  // A job parked on the credential prompt is not inside the walk, so `shouldCancel` will never be
  // polled — without this it would sit until CREDENTIAL_WAIT_MS regardless of the cancel. Settling
  // with null releases it immediately; the `isCancelled` check straight after the await then ends
  // the job before any browser launches. Harmless when nothing is waiting (returns false).
  settle(req.params.jobId, null);
  res.status(202).json({ cancelling: true });
});

/**
 * Answer a re-ground's credential prompt. Deliberately the same shape as the run's
 * `/api/runs/:runId/credentials` — same body, same `secret: true`, same settle() — because it IS
 * the same mechanism, keyed on the job id instead of a run id.
 *
 * The values go straight into the waiting promise and live only in the walk's memory. Nothing here
 * writes them anywhere: not to the job's event log, not to `runs/`, not to the database.
 */
app.post("/api/cases/:caseId/steps/jobs/:jobId/credentials", requireRole("tester"), (req, res) => {
  const job = getJob(req.params.jobId, req.user?.id ?? LOCAL_USER_ID);
  if (!job) return res.status(404).json({ error: "no such editing session" });

  const { username, password, skip } = req.body ?? {};
  const supplied = !skip && typeof username === "string" && typeof password === "string"
    && username.length > 0 && password.length > 0;

  const answered = settle(req.params.jobId, supplied ? { username, password, secret: true } : null);
  if (!answered) return res.status(409).json({ error: "this editing session is not waiting for credentials" });
  res.status(204).end();
});

/** Copy a case. Fresh history at v1 — see library.ts for why the original's is not carried over. */
app.post("/api/cases/:caseId/duplicate", requireRole("tester"), async (req, res) => {
  const { title } = req.body ?? {};
  try {
    res.status(201).json(await duplicateCase(
      ...libraryCtx(req), req.params.caseId,
      typeof title === "string" && title.trim() ? title : undefined,
    ));
  } catch (err) { sendAccessError(res, err); }
});

/** This case's own run history, newest first — what the "Runs & versions" tab lists. */
app.get("/api/cases/:caseId/runs", requireRole("viewer"), async (req, res) => {
  const limit = Number(req.query.limit ?? 20);
  try {
    res.json({
      runs: await listCaseRuns(
        ...libraryCtx(req), req.params.caseId,
        Number.isFinite(limit) ? limit : 20,
      ),
    });
  } catch (err) { sendAccessError(res, err); }
});

/**
 * What a caller must be told before overriding a case's script, and what the UI's confirmation
 * repeats back. Served so the wording lives next to the rule it describes rather than only in
 * `app.js`, where it would drift from the behaviour it warns about.
 */
const SCRIPT_OVERRIDE_WARNING =
  "An overridden script is not grounded. No locator in it is verified against a real discovered " +
  "element, so nothing checks that the things it clicks and fills actually exist on the page. " +
  "When it breaks it will not fail the way a generated test fails — it will fail silently rather " +
  "than loudly, often several steps later and blaming the wrong thing. The steps panel will keep " +
  "showing this case's steps, but they will no longer describe what runs.";

/**
 * Replace a case's generated script with a hand-written one, or remove that override.
 *
 * **Permission: tester or above**, via the same `assertCanAuthor` that gates every other authoring
 * action in the library — composing tests is authoring, not administration. `requireRole("tester")`
 * is the route-level gate; `assertCanAuthor` is re-asserted inside the handler so the rule holds
 * for any future caller that does not come through this route.
 *
 * PUT with `{ script }` sets it; PUT with `{ script: null }` clears it. Both mint a version with
 * author and timestamp, so an override is as revertible as any other change and shows up in the
 * same history. New route, new fields only — no existing route's shape changes (rule 1).
 *
 * `confirm: true` is required in the body. The point is not security — the role check is the
 * security — but that a client cannot set an override without having been handed
 * `SCRIPT_OVERRIDE_WARNING` to show, which is what makes "the person was told" true rather than
 * assumed.
 */
/**
 * Deliberately NOT mounted under `/api/cases/:caseId`. The warning is a fixed statement of policy
 * — it names no case, reads no row, and is identical for every caller. Hanging it off a case id
 * would make it *look* tenant-scoped while returning 200 to anyone, which is a worse lie than
 * having no route at all.
 */
app.get("/api/script-override/warning", requireRole("viewer"), (_req, res) => {
  if (!scriptOverrideEnabled()) {
    return res.status(404).json({ error: "script overrides are not available — this server has SCRIPT_OVERRIDE_ENABLED off" });
  }
  res.json({ warning: SCRIPT_OVERRIDE_WARNING });
});

app.put("/api/cases/:caseId/script-override", requireRole("tester"), async (req, res) => {
  if (!scriptOverrideEnabled()) {
    return res.status(404).json({ error: "script overrides are not available — this server has SCRIPT_OVERRIDE_ENABLED off" });
  }
  const { script, changeNote, expectedVersion, confirm } = req.body ?? {};
  try {
    const [userId, orgId, role] = libraryCtx(req);
    // Authoring-level check, stated again at the point of effect. Redundant with the route guard
    // today, and deliberately so: this is the rule, not the routing table.
    assertCanAuthor(role);

    const clearing = script === null;
    if (!clearing && typeof script !== "string") {
      return res.status(400).json({ error: "send a script string to override, or null to remove the override" });
    }
    // Setting an override needs the acknowledgement; removing one restores the grounded path and
    // therefore needs no warning.
    if (!clearing && confirm !== true) {
      return res.status(400).json({
        error: "an override must be confirmed — resend with confirm: true",
        warning: SCRIPT_OVERRIDE_WARNING,
      });
    }

    const row = await setScriptOverride(userId, orgId, role, req.params.caseId, {
      script: clearing ? null : (script as string),
      changeNote: typeof changeNote === "string" ? changeNote : undefined,
      expectedVersion: typeof expectedVersion === "number" ? expectedVersion : undefined,
    });
    res.json({ case: row, overridden: !clearing, warning: clearing ? null : SCRIPT_OVERRIDE_WARNING });
  } catch (err) { sendAccessError(res, err); }
});

/**
 * "Ask for a change" — a model PROPOSES an edit. It never saves.
 *
 * Approving a proposal sends it back through POST /steps like any hand-typed edit, so it is
 * parsed, re-grounded and versioned on exactly the same path. That is deliberate: one way into
 * the library, one set of guarantees, regardless of who wrote the sentences.
 */
app.post("/api/cases/:caseId/rewrite", requireRole("tester"), async (req, res) => {
  const { instruction } = req.body ?? {};
  const userId = req.user?.id ?? LOCAL_USER_ID;
  if (!consumeRewriteAttempt(userId)) {
    return res.status(429).json({ error: "too many rewrite requests — try again in a few minutes" });
  }
  try {
    const found = await getCase(...libraryCtx(req), req.params.caseId);
    // Refused rather than answered for an overridden case. The proposal itself would be perfectly
    // valid — and perfectly inert: approving it fills the editor, saving mints a new IR version,
    // and the hand-written script still runs. The user would get a diff, an approval and a version
    // bump with no change in behaviour, which is indistinguishable from it having worked.
    if (found.scriptOverridden && scriptOverrideEnabled()) {
      return res.status(409).json({
        error: "this case runs a script override, so editing its steps would not change what runs — " +
          "remove the override first if you want the steps to take effect",
      });
    }
    // The source run is where the case's own page snapshot lives — without it the model is
    // guessing element names from the instruction's wording (TD-91).
    res.json(await proposeRewrite(
      found.ir, typeof instruction === "string" ? instruction : "", found.sourceRunId ?? null));
  } catch (err) { sendAccessError(res, err); }
});

/**
 * "Write it for me" — translate loosely-typed step lines into the vocabulary the parser reads.
 *
 * The sibling of /rewrite, and gated the same way: it PROPOSES, it never saves. Approving a
 * translation drops the sentences into the editor, and saving them goes back through POST /steps
 * like any hand-typed edit — one parser, one grounder, one version history, whoever wrote the
 * words.
 *
 * Behind NL_STEPS_ENABLED, default OFF. A server with no Gemini key, or an operator who does not
 * want a model touching step text at all, gets a 404 and an editor that never shows the button.
 *
 * Shares the rewrite rate limiter on purpose: both spend one Gemini call per press on behalf of
 * one signed-in person, so one allowance covering both is the honest ceiling. Two separate
 * budgets would let a user double their model spend by alternating buttons.
 */
app.post("/api/cases/:caseId/steps/translate", requireRole("tester"), async (req, res) => {
  if (!nlStepsEnabled()) {
    return res.status(404).json({ error: "plain-language steps are not available — this server has NL_STEPS_ENABLED off" });
  }
  const userId = req.user?.id ?? LOCAL_USER_ID;
  if (!consumeRewriteAttempt(userId)) {
    return res.status(429).json({ error: "too many rewrite requests — try again in a few minutes" });
  }
  try {
    const found = await getCase(...libraryCtx(req), req.params.caseId);
    res.json(await proposeStepTranslation(found.ir, req.body?.steps));
  } catch (err) { sendAccessError(res, err); }
});

app.delete("/api/cases/:caseId", requireRole("admin"), async (req, res) => {
  try {
    await deleteCase(...libraryCtx(req), req.params.caseId);
    res.status(204).end();
  } catch (err) { sendAccessError(res, err); }
});

/**
 * Save a finished run's case into the library — the bridge from authoring to reuse (Step 5.2).
 *
 * `requireRunRole("tester")` is the gate on the SOURCE run (you must be able to see it), and
 * library.ts independently checks the DESTINATION project. Both matter: they can differ.
 */
app.post("/api/runs/:runId/cases/:caseId/save", requireRunRole("tester"), async (req, res) => {
  const { projectId, title, suiteId } = req.body ?? {};
  // Narrower than the app.param above, which has to admit a library uuid too: on THIS route the
  // id is a run directory name, so only `case-N` is meaningful. Belt-and-braces in the same shape
  // the runId checks in this file already use — the param layer is what actually stops traversal.
  if (!RUN_CASE_ID.test(req.params.caseId)) {
    return res.status(400).json({ error: "invalid caseId" });
  }
  if (typeof projectId !== "string" || !projectId) {
    return res.status(400).json({ error: "projectId is required" });
  }
  try {
    const userId = req.user?.id ?? LOCAL_USER_ID;
    const role = await assertOrgAccess(userId, req.organisationId!, "tester");
    res.status(201).json(await saveCaseFromRun(
      userId, req.organisationId!, role,
      req.params.runId, req.params.caseId, projectId,
      { title: typeof title === "string" ? title : undefined,
        suiteId: typeof suiteId === "string" && suiteId ? suiteId : undefined },
    ));
  } catch (err) { sendAccessError(res, err); }
});

/**
 * Replay saved cases — Step 5.3, and the reason the library exists.
 *
 * Three selections, one route: a whole suite (`suiteId`), a chosen subset (`suiteId` + `caseIds`,
 * which honours the suite's order), or individual cases (`caseIds` alone). All three are the same
 * zero-LLM path — stored IR straight to generateSpec/runSpec — so re-running a ten-case suite
 * costs nothing.
 *
 * `tester`, matching POST /api/runs: a replay drives a real browser against someone's site, which
 * is the line a read-only viewer should not cross. It spends no tokens, but it is not free of
 * consequence.
 */
app.post("/api/replay", requireRole("tester"), async (req, res) => {
  const { suiteId, caseIds, label } = req.body ?? {};
  if (typeof suiteId !== "string" && !Array.isArray(caseIds)) {
    return res.status(400).json({ error: "send a suiteId, caseIds, or both" });
  }

  try {
    const userId = req.user?.id ?? LOCAL_USER_ID;
    // Loading is where authorization happens: every case is proven visible before anything runs.
    const cases = await loadCasesForReplay(userId, req.organisationId!, req.organisationRole!, {
      suiteId: typeof suiteId === "string" ? suiteId : undefined,
      caseIds: Array.isArray(caseIds) ? caseIds.filter((c) => typeof c === "string") : undefined,
    });

    // A replay is scoped to a PROJECT, not a site, and one credential prompt covers the whole
    // replay: it shows `cases[0]`'s baseUrl and hands what you type to every case via
    // `credentialEnvVars`. So a project holding two sites would mean being shown site A, typing
    // site A's password, and having it typed into site B's login form with nothing saying so.
    // D-30 made replay prompt-first, so that credential is now usually a real one, freshly typed.
    //
    // Refused HERE, before makeRunId/recordRunStarted, so a rejected replay leaves no run row, no
    // directory and no artifacts behind — the request simply does not start.
    //
    // Order matters for cost: a replay with no login has nothing to misdirect, so it is allowed
    // across as many sites as it likes and never pays for the origin scan.
    const credentialFields = credentialKindsNeeded(cases.flatMap((c) => c.ir.steps));
    if (credentialFields.length > 0) {
      // Origins, not raw baseUrls: two cases on the same host with different paths are the same
      // site and must not be refused.
      const origins = [...new Set(
        cases.map((c) => originOf(c.ir.meta.baseUrl ?? "")).filter((o): o is string => !!o)
      )];
      if (origins.length > 1) {
        return res.status(400).json({
          error:
            `This selection signs in, and its cases span ${origins.length} sites ` +
            `(${origins.join(", ")}). One replay collects one set of credentials and uses it for ` +
            `every case, so running these together would send the same login to all of them. ` +
            `Replay each site separately.`,
          origins,
        });
      }
    }

    const runId = makeRunId();
    const runLabel = typeof label === "string" && label.trim()
      ? label.trim()
      : `Replayed ${cases.length} saved case${cases.length === 1 ? "" : "s"}`;

    // Same dual-write as a normal run, so the replay is a first-class run: it appears in history,
    // is scoped to its organisation, and its artifacts are guarded exactly like any other.
    recordRunStarted({
      id: runId,
      organisation_id: req.organisationId!,
      started_by: userId,
      prompt: runLabel,
      url: cases[0]?.ir.meta.baseUrl ?? null,
      status: "incomplete",
      started_at: new Date().toISOString(),
    });
    // Every case in a replay shares one project (loadCasesForReplay proves it), so the run files
    // under that project rather than being inferred from a URL.
    if (cases[0]) recordRunProject(runId, cases[0].projectId);

    const onEvent = (event: Parameters<typeof record>[0]) => {
      record(event);
      if (event.stage === "done" || event.stage === "error") {
        try {
          recordRunStatus(runId, summariseRun(runId).status);
        } catch (err) {
          console.error(`[db] could not derive final status for ${runId}:`, (err as Error)?.message ?? err);
        }
      }
    };

    // A saved case's login steps carry ${env:TEST_USERNAME} / ${env:TEST_PASSWORD} rather than
    // literals, and NOTHING used to resolve them on this path: `runReplay` accepts `creds`, but
    // this - its only caller - never passed any. `credentialEnvVars(undefined)` is `{}`, so the
    // generated spec's `process.env.TEST_USERNAME ?? ""` typed an EMPTY STRING into the login
    // form, the sign-in silently failed, and the case died several steps later on whatever
    // assertion first noticed it was still logged out. A fresh run never had this problem because
    // the orchestrator asks. Confirmed on run 2026-08-31T06-30-26-597Z-1c2a719e, which failed at
    // `expect(Sign In).toBeHidden()` with an edit three steps further down that never ran.
    //
    // Resolved INSIDE the scheduled work, after the 202 below: the browser needs the runId in
    // hand before it can render the prompt or post an answer to it.
    runLimit.run(async () => {
      const fields = credentialFields;   // computed above, with the same input
      const creds = fields.length === 0
        // No case in this replay signs in. Nothing is asked, no event is emitted, and the run is
        // byte-for-byte the one that ran before this change.
        ? undefined
        : await resolveCredentialsVia(runId, cases[0]?.ir.meta.baseUrl ?? "", fields,
          // The same event shape a run emits, so app.js draws the same prompt with no change:
          // its postUrl already defaults to /api/runs/<runId>/credentials, and a replay's runId
          // is a real run id that the existing route settles.
          (status, data) => {
            const ev = {
              runId, stage: "credentials", status,
              data: status === "started"
                ? { url: data.url, fields: data.fields }
                : { provided: !!data.supplied },
              ts: Date.now(),
            } as Parameters<typeof record>[0];
            // APPEND FIRST, exactly as orchestrator.ts and replay.ts do. `record()` is live SSE
            // fan-out ONLY — it persists nothing — and no browser has ever consumed the SSE
            // route; the UI polls `/api/runs/:runId/state`, which reads the store. So an event
            // that is only recorded is an event the person waiting for the prompt never sees:
            // the run parks for the full CREDENTIAL_WAIT_MS against a screen with nowhere to
            // type, which is the exact trap resolveCredentials.ts's own header warns about.
            // These two events do not travel through runReplay, so nothing else appends them.
            // TECH_DEBT.md TD-66.
            store.append(ev);
            onEvent(ev);
          },
          // PROMPT FIRST for a replay. A replay is started by a person, on a server whose
          // TEST_USERNAME/TEST_PASSWORD may belong to someone else entirely, so what they type
          // must win. The environment is the fallback for a skipped or timed-out prompt.
          "prompt-first");
      // A replay can spend real LLM calls (REPLAY_REGROUND), so it bills to the same organisation
      // a fresh run would. Entered here because runReplay is not runPipeline and has no options
      // object of its own; the ambient config covers everything downstream of this point.
      const replayConfig = await llmConfigForOrg(req.organisationId ?? null);
      if (replayConfig) enterWithLlmConfig(replayConfig);
      return runReplay({ runId, cases, label: runLabel, creds }, onEvent);
    })
      .then((outcome) => {
        // Surface each case's latest verdict on the library row, so the Suite screen can show a
        // status without joining through run history.
        for (let i = 0; i < cases.length; i++) {
          const result = outcome.results.find((r) => r.caseId === `case-${i}`);
          if (result) void recordCaseOutcome(cases[i].id, result.status);
        }
        // Index which cases this run executed, so each case can list its OWN history. Written
        // after the fact so each row carries its real verdict rather than "incomplete".
        recordRunCases(runId, cases.map((c, i) => ({
          testCaseId: c.id,
          caseIndex: i,
          status: outcome.results.find((r) => r.caseId === `case-${i}`)?.status ?? null,
        })));
      })
      .catch(() => { /* already emitted as an "error" event */ });

    res.status(202).json({ runId, caseCount: cases.length });
  } catch (err) { sendAccessError(res, err); }
});

app.get("/", (_req, res) => {
  res.sendFile(path.resolve("public/index.html"));
});

const port = Number(process.env.PORT ?? 3000);

/**
 * Every env var the code compares against the string `"true"` or `"false"`.
 *
 * Kept as data, not scattered `if`s, so that adding a flag without adding it here is the only way
 * to get an unchecked flag — and `.env.example` can be diffed against this list.
 */
export const BOOLEAN_ENV_FLAGS = [
  "AUTH_ENABLED",
  "AUTH_TOKEN_REFRESH",
  "DB_ENABLED",
  // TD-100: read as `process.env.DETERMINISTIC_HEAL === "true"` in heal.ts and absent from this
  // list, which is the one thing the comment above says cannot happen. `=1`/`=True` booted clean,
  // read false, and silently skipped the cheap structural heal so every heal paid for a full LLM
  // IR regeneration — invisible, because the expensive path produces a correct-looking result.
  "DETERMINISTIC_HEAL",
  "DISCOVERY_LIVE_DOM",
  "DRIFT_RECOVERY",
  "ENABLE_CASE_SELECTION_GATE",
  "NL_STEPS_ENABLED",
  "ORG_LLM_CONFIG_ENABLED",
  "REPLAY_REGROUND",
  "RUN_QUESTIONS",
  "SALESFORCE_ENABLED",
  "SCRIPT_OVERRIDE_ENABLED",
  "SELF_HEAL_DEFAULT",
  "SIGNUP_ENABLED",
] as const;

/** One malformed flag: the variable, and the value actually found (quoted, so empty is visible). */
export interface InvalidBooleanFlag {
  name: string;
  found: string;
}

/**
 * Find every boolean flag that is SET to something other than exactly `"true"` or `"false"`.
 *
 * Why this exists: every one of these flags is read as `x === "true"` (or, for `SIGNUP_ENABLED`,
 * `x !== "false"`). That is a silent coercion — `AUTH_ENABLED=truebro` shipped in a real `.env`
 * and read as `false`, so the server booted with authentication off, resolved every visitor as
 * the synthetic local owner, and said nothing. A typo in a security flag must not be survivable.
 *
 * **An ABSENT variable is not an error**: unset is the documented default-OFF contract that
 * `CLAUDE.md` rule 2 depends on ("every new capability ships behind an env flag defaulting to
 * OFF"), and `.env.example` documents it. What is rejected is a variable that is *present and
 * malformed* — including present-but-empty (`FLAG=`), which is the case that most looks
 * deliberate and reads as false. Case matters too: `TRUE`, `1` and `yes` are all rejected rather
 * than guessed at, because guessing is how a flag ends up meaning the opposite of what was typed.
 *
 * Pure and exported so each flag can be tested without booting a server; the process-killing
 * call lives inside `isMain` below.
 */
export function findInvalidBooleanFlags(env: NodeJS.ProcessEnv = process.env): InvalidBooleanFlag[] {
  const bad: InvalidBooleanFlag[] = [];
  for (const name of BOOLEAN_ENV_FLAGS) {
    const raw = env[name];
    if (raw === undefined) continue; // absent = documented default, not a misconfiguration
    if (raw !== "true" && raw !== "false") bad.push({ name, found: raw });
  }
  return bad;
}

/** The fatal message for `findInvalidBooleanFlags()` output — names each variable and its value. */
export function formatInvalidBooleanFlags(bad: InvalidBooleanFlag[]): string {
  return [
    `[startup] FATAL: boolean environment flag(s) set to a value that is neither "true" nor "false".`,
    ...bad.map((b) => `  ${b.name}=${JSON.stringify(b.found)} — expected exactly "true" or "false"`),
    `  These flags are compared against the literal string "true", so any other value is silently`,
    `  read as false — which is how a server ships with AUTH_ENABLED=truebro and no authentication.`,
    `  Set each to exactly "true" or "false", or remove it entirely to take its documented default.`,
  ].join("\n");
}

export { app };

/**
 * Every env var that names an LLM provider ("gemini" or "azure").
 *
 * The same shape as `BOOLEAN_ENV_FLAGS` for the same reason: `LLM_PROVIDER=azureEE` would be
 * silently read as `gemini` (the fallback default) if a typo ever shipped, and a server running
 * gemini when the operator believes it is on Azure is expensive to discover — wrong-billion
 * tokens, wrong endpoint, wrong tenancy. Unset is the documented default (gemini); a present value
 * must be exactly "gemini" or "azure".
 */
export const LLM_PROVIDER_ENV_VARS = ["LLM_PROVIDER", "LLM_PROVIDER_LITE"] as const;

/** One malformed LLM provider variable: the name, and the value actually found. */
export interface InvalidProviderEnv {
  name: string;
  found: string;
}

/** Find every LLM provider variable that is set to something other than exactly "gemini" or
 *  "azure". Pure and exported so it can be tested without booting a server, exactly like
 *  `findInvalidBooleanFlags`. An ABSENT variable is not an error. Case matters; a present-but-empty
 *  value is rejected (it reads as gemini while looking deliberate). */
export function findInvalidProviderEnv(env: NodeJS.ProcessEnv = process.env): InvalidProviderEnv[] {
  const bad: InvalidProviderEnv[] = [];
  for (const name of LLM_PROVIDER_ENV_VARS) {
    const raw = env[name];
    if (raw === undefined) continue;
    // No trimming, exactly like findInvalidBooleanFlags: " azure"/"azure " read as gemini at the
    // call site (resolvedProvider does no trimming either), so they must be fatal here.
    if (raw !== "gemini" && raw !== "azure") bad.push({ name, found: raw });
  }
  return bad;
}

/** The fatal message for `findInvalidProviderEnv()` output — names each variable and its value. */
export function formatInvalidProviderEnv(bad: InvalidProviderEnv[]): string {
  return [
    `[startup] FATAL: LLM provider environment variable(s) set to a value that is neither "gemini" nor "azure".`,
    ...bad.map((b) => `  ${b.name}=${JSON.stringify(b.found)} — expected exactly "gemini" or "azure"`),
    `  These variables select which provider a role ('main'/'lite') calls; any other value is read`,
    `  as gemini, so a stale typos would silently run Google's endpoints while the operator believes`,
    `  Azure is configured. Set each to exactly "gemini" or "azure", or remove it entirely to take`,
    `  its documented default (gemini).`,
  ].join("\n");
}

/**
 * The browser-pinning pair — `TECH_DEBT.md` TD-104.
 *
 * `browserContextOptions()` hands both straight to Chromium. `SUPPORTED_RUN_LOCALES` exists and is
 * enforced, but ONLY on `options.locale` in `POST /api/runs`; the environment path had no check at
 * all, and `RUN_TIMEZONE` had none anywhere.
 *
 * WHY THIS IS FATAL RATHER THAN A WARNING. Measured in a real Chromium on the pinned 1.49.0:
 *
 *     RUN_TIMEZONE=Asia/Kolkata   -> context OK
 *     RUN_TIMEZONE=Asia/Kolkatta  -> browserContext.newPage: Invalid timezone ID: Asia/Kolkatta
 *     RUN_LOCALE=en_US            -> context OK, silently pinned to the wrong thing
 *
 * The timezone case is TD-71 again, down to the same function in the same error string: pinning
 * happens when the CONTEXT is created, so it does not degrade to "unpinned" — every case in every
 * run dies before a single `page.goto`, `screenshot: "on"` photographs a page that never
 * navigated, and the product reports the site under test as broken. A container that starts
 * happily and then blames a working site is strictly worse than one that refuses to start.
 *
 * `RUN_LOCALE=""` stays legal: it is the documented rollback switch that turns pinning off
 * entirely (`browserLaunch.ts`), and unlike the boolean flags an empty value here is deliberate,
 * not a typo that reads as false. Absent is legal for both, as everywhere else in this file.
 */
export interface InvalidBrowserEnv { name: string; found: string; hint: string }

export function findInvalidBrowserEnv(env: NodeJS.ProcessEnv = process.env): InvalidBrowserEnv[] {
  const bad: InvalidBrowserEnv[] = [];

  const locale = env.RUN_LOCALE;
  // Empty is the rollback switch, not a mistake — see the docblock. Anything else present must be
  // a tag the allow-list already names, the same list the route enforces.
  if (locale !== undefined && locale.trim() !== "" && !isSupportedRunLocale(locale)) {
    bad.push({ name: "RUN_LOCALE", found: locale, hint: `expected one of: ${SUPPORTED_RUN_LOCALES.join(", ")}` });
  }

  const tz = env.RUN_TIMEZONE;
  if (tz !== undefined && tz.trim() !== "") {
    // ASK THE RUNTIME, DO NOT MATCH AGAINST A LIST. The obvious implementation —
    // `Intl.supportedValuesOf("timeZone").includes(tz)` — is wrong in a way that only a test
    // catches: that list is CANONICAL names only. Measured on this Node: 418 zones, containing
    // `Asia/Calcutta` but not the modern alias `Asia/Kolkata`, and **not `UTC` at all** — which is
    // this project's own DEFAULT_TIMEZONE. An allow-list check would therefore refuse to boot on
    // `RUN_TIMEZONE=UTC`, turning a guard against a broken config into a guard against a correct
    // one.
    //
    // `Intl.DateTimeFormat` throws RangeError for exactly the values Chromium rejects and accepts
    // every alias it accepts, verified against both:
    //     UTC / Asia/Kolkata / Asia/Calcutta / Europe/London  -> accepted
    //     Asia/Kolkatta / Mars/Olympus                        -> RangeError
    let valid = true;
    try { new Intl.DateTimeFormat("en-US", { timeZone: tz.trim() }); } catch { valid = false; }
    if (!valid) {
      bad.push({ name: "RUN_TIMEZONE", found: tz, hint: "expected an IANA timezone, e.g. UTC or Asia/Kolkata" });
    }
  }

  return bad;
}

/** The fatal message for `findInvalidBrowserEnv()` — names each variable, its value, and the fix. */
export function formatInvalidBrowserEnv(bad: InvalidBrowserEnv[]): string {
  return [
    `[startup] FATAL: browser locale/timezone environment variable(s) are not valid.`,
    ...bad.map((b) => `  ${b.name}=${JSON.stringify(b.found)} — ${b.hint}`),
    `  These are passed straight to Chromium when a browser context is created. An invalid`,
    `  timezone does not degrade to "unpinned" — it throws at browserContext.newPage(), so EVERY`,
    `  case in EVERY run would die before navigating and the product would report the site under`,
    `  test as broken (TECH_DEBT.md TD-71 is the same failure).`,
    `  Fix the value, or remove the variable to take its default (en-US / UTC).`,
    `  RUN_LOCALE="" is still valid and means "do not pin at all".`,
  ].join("\n");
}

// Only actually start listening (and run startup-only diagnostics/jobs) when this file is
// executed directly (`npm run serve`/`start`), not when a test imports `app` to exercise routes
// via supertest — importing must never bind a real port or spin up background timers.
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  /**
   * Runs BEFORE the AUTH/DB combination check below, and that order is load-bearing: the M-3
   * check reads `isAuthEnabled()`, which resolves a malformed value to `false`. Validating the
   * combination first would mean reasoning about a value nobody actually typed.
   */
  const invalidFlags = findInvalidBooleanFlags();
  if (invalidFlags.length > 0) {
    console.error(formatInvalidBooleanFlags(invalidFlags));
    process.exit(1);
  }
  // The sibling guard for the LLM provider selector — same rationale, same placement, run with the
  // boolean-flag check, before any route can serve a request on a misconfigured provider.
  const invalidProviders = findInvalidProviderEnv();
  if (invalidProviders.length > 0) {
    console.error(formatInvalidProviderEnv(invalidProviders));
    process.exit(1);
  }
  // Third sibling, same rationale and same placement (TD-104). Before any route can serve a
  // request, because the failure this prevents is a browser context that cannot be created at all
  // — which surfaces as "every test failed" rather than as a configuration error.
  const invalidBrowserEnv = findInvalidBrowserEnv();
  if (invalidBrowserEnv.length > 0) {
    console.error(formatInvalidBrowserEnv(invalidBrowserEnv));
    process.exit(1);
  }

  /**
   * Refuse to start in the one combination that looks configured and isn't.
   *
   * Membership lives in the database and nowhere else, so `canEnforceTenancy()` returns false when
   * `DB_ENABLED` is off — every role check passes and every organisation boundary disappears. With
   * `AUTH_ENABLED` also off that is correct and intended: one synthetic local owner, nothing to
   * isolate. With `AUTH_ENABLED` ON it is the worst of both: a login screen, real accounts, and a
   * server where every signed-in user sees and does everything.
   *
   * It used to log an error and carry on, which made it survivable — and therefore survivable in
   * production. The library, projects and team surfaces do NOT consult `DB_ENABLED` at all (they
   * go straight to the service client), so the app keeps working and looking correct while the
   * isolation it appears to enforce is switched off. Nothing about the running system says so
   * except one line that scrolled past at boot.
   *
   * Deliberately inside `isMain`: importing `app` for tests must never throw, and several test
   * files legitimately set one flag without the other.
   */
  if (isAuthEnabled() && !isDbEnabled()) {
    console.error(
      "[startup] FATAL: AUTH_ENABLED=true with DB_ENABLED unset or false.\n" +
      "  Membership and roles live in the database, so organisation isolation cannot be enforced\n" +
      "  in this combination — every signed-in user would see and do everything, while the team,\n" +
      "  project and library screens carried on working as if they were scoped.\n" +
      "  Set DB_ENABLED=true (with SUPABASE_SERVICE_ROLE_KEY) to run with authentication,\n" +
      "  or AUTH_ENABLED=false to run single-user with the synthetic local owner.",
    );
    process.exit(1);
  }

  // Startup diagnostic — log which key env vars are detected so Render's deploy
  // log immediately shows whether secrets were injected.
  console.log("[startup] Environment variable check:");
  for (const v of ["GEMINI_API_KEYS", "GEMINI_API_KEY", "GEMINI_MODEL", "GEMINI_MODEL_LITE", "NODE_ENV", "PORT"]) {
    const val = process.env[v];
    console.log(`  ${v}: ${val ? `SET (${val.length} chars)` : "NOT SET"}`);
  }

  app.listen(port, () => console.log(`AI Test Platform UI: http://localhost:${port}`));

  // No-op unless RUN_RETENTION_DAYS is set (TECH_DEBT.md TD-16) — see src/server/retention.ts.
  startRetentionJob();

  // Silent unless Playwright's ffmpeg is missing, in which case say so ONCE at startup rather
  // than letting every run discover it as a mystery "test failure" (TECH_DEBT.md TD-71).
  warnIfNoVideo();
}
