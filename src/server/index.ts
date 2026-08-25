import express from "express";
import path from "node:path";
import { rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runPipeline, makeRunId } from "../orchestrator.js";
import { record, subscribe, getEvents } from "./runRegistry.js";
import { listRuns } from "../runStore.js";
import { Semaphore } from "./concurrency.js";
import { askCredentials, settle } from "./pendingCredentials.js";
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
  findUserByEmail,
  listAddableUsers,
  listMembers,
  removeMember,
  roleOfMember,
} from "./organisations.js";
import {
  addProjectMember,
  assertProjectInOrg,
  assignmentsByUser,
  createProject,
  deleteProject,
  listProjectMembers,
  listVisibleProjects,
  removeProjectMember,
  resolveProjectForUrl,
  updateProject,
} from "./projects.js";
import { consumeSignupAttempt, createAccount, isSignupEnabled } from "./signup.js";
import {
  addCaseToSuite,
  createSuite,
  deleteCase,
  deleteSuite,
  getCase,
  getCaseVersion,
  listCases,
  listSuiteCases,
  listSuites,
  loadCasesForReplay,
  recordCaseOutcome,
  removeCaseFromSuite,
  renameSuite,
  reorderSuite,
  saveCaseFromRun,
  updateCase,
} from "./library.js";
import { runReplay } from "../stages/replay.js";
import { recordRunProject, recordRunStarted, recordRunStatus } from "../db.js";
import { summariseRun } from "../runStore.js";

import { isAllowedEntryUrl } from "../stages/hybridDiscovery.js";

/** runId shape from makeRunId(). No "/", "." or ".." so it can never escape runs/. */
const RUN_ID = /^[\dT-]+Z-[0-9a-f]{8}$/;

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

  // Only the two known booleans are forwarded — the body is untrusted input, and
  // spreading it straight into runPipeline would let a caller set anything.
  const runOptions = options && typeof options === "object"
    ? {
      ...(typeof options.gateReview === "boolean" ? { gateReview: options.gateReview } : {}),
      ...(typeof options.selfHeal === "boolean" ? { selfHeal: options.selfHeal } : {}),
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
        ? (await assertProjectInOrg(req.organisationId!, explicit).then((p) => p.id).catch(() => null))
        : await resolveProjectForUrl(req.organisationId!, primaryUrl);
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
  runLimit.run(() => runPipeline({ prompt, url, urls, coverage, options: runOptions }, onEvent, runId, askCredentials))
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
  const diskRuns = listRuns();
  try {
    res.json(await filterRunsForUser(req.user?.id ?? LOCAL_USER_ID, diskRuns));
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
      NODE_ENV:        check("NODE_ENV"),
      PORT:            check("PORT"),
    },
    // Server-side defaults for the two per-run options a client may override. The
    // UI reads these so its Settings toggles open in the state the server is
    // actually in, instead of a hardcoded guess that silently disagrees.
    defaults: {
      gateReview: process.env.ENABLE_CASE_SELECTION_GATE === "true",
      selfHeal: true,
    },
    // ADDITIVE field (Step 2.2) — appended, never reordering or replacing anything above, per
    // implentationplan.md Rule 2. The UI branches on this to decide whether a login view exists
    // at all; with auth off it's `false` and the frontend behaves exactly as it always has.
    authEnabled: isAuthEnabled(),
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

app.patch("/api/projects/:projectId", requireRole("admin"), async (req, res) => {
  const { name, baseUrl } = req.body ?? {};
  try {
    res.json(await updateProject(req.organisationId!, req.params.projectId, { name, baseUrl }));
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
app.get("/api/organisations/:orgId/assignments", requireOrgRole("admin"), async (req, res) => {
  try {
    const map = await assignmentsByUser(req.params.orgId);
    res.json({ assignments: Object.fromEntries(map) });
  } catch (err) {
    sendAccessError(res, err);
  }
});

app.get("/api/organisations/:orgId/members", requireOrgRole("viewer"), async (req, res) => {
  try {
    res.json({ members: await listMembers(req.params.orgId) });
  } catch (err) {
    sendAccessError(res, err);
  }
});

/**
 * Registered accounts that aren't in this organisation yet — suggestions for the add-member field.
 *
 * `admin`, matching POST .../members: the only thing you can do with this list is add someone, so
 * anyone who can't add shouldn't be able to enumerate. Enforced through the same
 * `requireOrgRole`/`assertOrgAccess` path as every other member route — no new permission concept.
 */
app.get("/api/organisations/:orgId/addable-users", requireOrgRole("admin"), async (req, res) => {
  try {
    res.json({ emails: await listAddableUsers(req.params.orgId) });
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
    res.json({ cases: await listCases(...libraryCtx(req), projectId) });
  } catch (err) { sendAccessError(res, err); }
});

app.get("/api/cases/:caseId", requireRole("viewer"), async (req, res) => {
  try {
    res.json(await getCase(...libraryCtx(req), req.params.caseId));
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
  const { title, ir, changeNote } = req.body ?? {};
  try {
    res.json(await updateCase(...libraryCtx(req), req.params.caseId, { title, ir, changeNote }));
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

    runLimit.run(() => runReplay({ runId, cases, label: runLabel }, onEvent))
      .then((outcome) => {
        // Surface each case's latest verdict on the library row, so the Suite screen can show a
        // status without joining through run history.
        for (let i = 0; i < cases.length; i++) {
          const result = outcome.results.find((r) => r.caseId === `case-${i}`);
          if (result) void recordCaseOutcome(cases[i].id, result.status);
        }
      })
      .catch(() => { /* already emitted as an "error" event */ });

    res.status(202).json({ runId, caseCount: cases.length });
  } catch (err) { sendAccessError(res, err); }
});

app.get("/", (_req, res) => {
  res.sendFile(path.resolve("public/index.html"));
});

const port = Number(process.env.PORT ?? 3000);

export { app };

// Only actually start listening (and run startup-only diagnostics/jobs) when this file is
// executed directly (`npm run serve`/`start`), not when a test imports `app` to exercise routes
// via supertest — importing must never bind a real port or spin up background timers.
const isMain = !!process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
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
}
