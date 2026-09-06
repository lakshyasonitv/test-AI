import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getServiceClient } from "../db.js";
import { IR } from "../schema/ir.js";
import { generateSpec } from "../stages/generator.js";
import { AccessError, roleAtLeast, visibleProjectIds, type Role } from "./authz.js";
import { assertProjectVisible } from "./projects.js";

/**
 * The test-case library — implentationplan.md Steps 5.2 and 5.5.
 *
 * A saved case is an IR plus a title, filed under a project. That is the whole idea: the IR is
 * already the pipeline's final, deterministic answer ("click this role+name, assert this text"),
 * and `generator.ts`/`executor.ts` are pure code by design (DECISIONS.md D-06). So a stored IR can
 * be re-run for zero LLM spend — which is what replay.ts does with what this module persists.
 *
 * ACCESS: nothing here invents a permission concept. A case or suite is reachable exactly when its
 * PROJECT is, via `assertProjectVisible` — the Step 5.1 axis. Every function that takes a suite or
 * case id resolves it to its project first and re-checks, so naming someone else's id can only ever
 * 404, never leak.
 *
 * THE IR SCHEMA IS IMPORTED, NEVER RESTATED. The plan calls this out by name: "The IR schema must
 * be the *same* schema, not a copy that drifts. Import the Zod schema from src/schema/ir.ts and
 * validate on save." A second, hand-maintained copy of that shape is DECISIONS.md D-01's
 * documentation-drift failure reappearing as code, so every write below parses through `IR`.
 */

function requireClient() {
  const client = getServiceClient();
  if (!client) {
    throw new AccessError(
      503,
      "the database is not configured — set DB_ENABLED=true and SUPABASE_SERVICE_ROLE_KEY",
    );
  }
  return client;
}

/**
 * Screenshot directory baked into a library spec.
 *
 * A real run passes its own per-run path so concurrent runs cannot overwrite each other's frames;
 * a library spec belongs to no run yet, so it takes the generator's own default. This is a named
 * constant rather than three string literals because the STORED spec and the REGENERATED fallback
 * must come out byte-identical — if those call sites drift, a case's script would appear to change
 * the day its version row is missing a spec, which is precisely the kind of silent difference the
 * "no script yet" bug taught us to distrust.
 */
const LIBRARY_SHOT_DIR = "artifacts";

/**
 * The spec for a stored IR, never throwing.
 *
 * `generateSpec` is pure code with no LLM and no I/O (DECISIONS.md D-06), so this is deterministic
 * and instant. It is wrapped anyway: this sits on the *write* path of saving a case, and a case
 * that cannot be saved because its script could not be pre-rendered would be a far worse bug than
 * the missing script this whole change exists to fix. A null simply means "regenerate on read".
 */
function specForStorage(ir: IR): string | null {
  try {
    return generateSpec(ir, LIBRARY_SHOT_DIR);
  } catch (err) {
    console.error(`[library] could not pre-render spec, storing null: ${(err as Error)?.message}`);
    return null;
  }
}

export interface SuiteRow {
  id: string;
  projectId: string;
  name: string;
  caseCount: number;
}

export interface CaseRow {
  id: string;
  projectId: string;
  title: string;
  feature: string | null;
  currentVersion: number;
  sourceRunId: string | null;
  lastRunStatus: string | null;
  lastRunAt: string | null;
  updatedAt: string | null;
}

export interface CaseVersionRow {
  version: number;
  changeNote: string | null;
  savedBy: string | null;
  savedAt: string | null;
}

/** Parse an unknown value as an IR, refusing loudly rather than storing something unrunnable. */
export function parseIr(value: unknown, context: string): IR {
  const parsed = IR.safeParse(value);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new AccessError(
      400,
      `${context} is not a valid test plan: ${first?.path.join(".") || "(root)"} ${first?.message ?? "failed validation"}`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------
// Resolving an id back to the project that governs it
// ---------------------------------------------------------------------------

/** The project a suite belongs to, proven to be visible to this caller. */
async function projectOfSuite(
  userId: string, orgId: string, role: Role, suiteId: string,
): Promise<string> {
  const client = requireClient();
  const { data, error } = await client
    .from("suites").select("project_id").eq("id", suiteId).maybeSingle();
  if (error) throw new AccessError(500, `could not read suite: ${error.message}`);
  const row = data as { project_id: string } | null;
  if (!row) throw new AccessError(404, "no such suite");
  await assertProjectVisible(userId, orgId, role, row.project_id);
  return row.project_id;
}

/** The project a case belongs to, proven to be visible to this caller. */
async function projectOfCase(
  userId: string, orgId: string, role: Role, caseId: string,
): Promise<string> {
  const client = requireClient();
  const { data, error } = await client
    .from("test_cases").select("project_id").eq("id", caseId).maybeSingle();
  if (error) throw new AccessError(500, `could not read case: ${error.message}`);
  const row = data as { project_id: string } | null;
  if (!row) throw new AccessError(404, "no such case");
  await assertProjectVisible(userId, orgId, role, row.project_id);
  return row.project_id;
}

/** Project ids in this org the caller may see — the `in` list for any cross-project listing. */
async function scopeProjectIds(userId: string, orgId: string, role: Role): Promise<string[] | null> {
  const allowed = await visibleProjectIds(userId, orgId, role);
  if (allowed === null) {
    const client = requireClient();
    const { data, error } = await client.from("projects").select("id").eq("organisation_id", orgId);
    if (error) throw new AccessError(500, `could not list projects: ${error.message}`);
    return (data ?? []).map((r) => (r as { id: string }).id);
  }
  return [...allowed];
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

/** Suites the caller may see, optionally narrowed to one project, each with its case count. */
export async function listSuites(
  userId: string, orgId: string, role: Role, projectId?: string,
): Promise<SuiteRow[]> {
  const client = requireClient();
  let projectIds: string[];
  if (projectId) {
    await assertProjectVisible(userId, orgId, role, projectId);
    projectIds = [projectId];
  } else {
    projectIds = (await scopeProjectIds(userId, orgId, role)) ?? [];
  }
  if (projectIds.length === 0) return [];

  const { data, error } = await client
    .from("suites").select("id, project_id, name").in("project_id", projectIds);
  if (error) throw new AccessError(500, `could not list suites: ${error.message}`);
  const rows = (data ?? []) as { id: string; project_id: string; name: string }[];
  if (rows.length === 0) return [];

  // One grouped count rather than a query per suite.
  const { data: links } = await client
    .from("suite_cases").select("suite_id").in("suite_id", rows.map((r) => r.id));
  const counts = new Map<string, number>();
  for (const l of (links ?? []) as { suite_id: string }[]) {
    counts.set(l.suite_id, (counts.get(l.suite_id) ?? 0) + 1);
  }

  return rows
    .map((r) => ({ id: r.id, projectId: r.project_id, name: r.name, caseCount: counts.get(r.id) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createSuite(
  userId: string, orgId: string, role: Role, projectId: string, name: string,
): Promise<SuiteRow> {
  await assertProjectVisible(userId, orgId, role, projectId);
  const trimmed = name.trim();
  if (!trimmed) throw new AccessError(400, "a suite needs a name");

  const client = requireClient();
  const { data, error } = await client
    .from("suites")
    .insert({ project_id: projectId, name: trimmed, created_by: userId })
    .select("id, project_id, name")
    .single();
  if (error || !data) throw new AccessError(500, `could not create suite: ${error?.message}`);
  return { id: data.id, projectId: data.project_id, name: data.name, caseCount: 0 };
}

export async function renameSuite(
  userId: string, orgId: string, role: Role, suiteId: string, name: string,
): Promise<SuiteRow> {
  const projectId = await projectOfSuite(userId, orgId, role, suiteId);
  const trimmed = name.trim();
  if (!trimmed) throw new AccessError(400, "a suite needs a name");

  const client = requireClient();
  const { data, error } = await client
    .from("suites").update({ name: trimmed }).eq("id", suiteId)
    .select("id, project_id, name").single();
  if (error || !data) throw new AccessError(500, `could not rename suite: ${error?.message}`);
  return { id: data.id, projectId, name: data.name, caseCount: 0 };
}

/**
 * Delete a suite. The cases themselves survive — `suite_cases` cascades, `test_cases` does not.
 * A suite is a *grouping*, so deleting one must not destroy authored work that other suites may
 * also reference.
 */
export async function deleteSuite(
  userId: string, orgId: string, role: Role, suiteId: string,
): Promise<void> {
  await projectOfSuite(userId, orgId, role, suiteId);
  const client = requireClient();
  const { error } = await client.from("suites").delete().eq("id", suiteId);
  if (error) throw new AccessError(500, `could not delete suite: ${error.message}`);
}

// ---------------------------------------------------------------------------
// Suite membership — the "club cases into suites" half
// ---------------------------------------------------------------------------

/** A suite's cases, in the order they will execute. */
export async function listSuiteCases(
  userId: string, orgId: string, role: Role, suiteId: string,
): Promise<CaseRow[]> {
  await projectOfSuite(userId, orgId, role, suiteId);
  const client = requireClient();

  const { data, error } = await client
    .from("suite_cases").select("test_case_id, position").eq("suite_id", suiteId);
  if (error) throw new AccessError(500, `could not read suite: ${error.message}`);
  const links = (data ?? []) as { test_case_id: string; position: number }[];
  if (links.length === 0) return [];

  const order = new Map(links.map((l) => [l.test_case_id, l.position ?? 0]));
  const cases = await casesByIds(links.map((l) => l.test_case_id));
  return cases.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/**
 * Add a case to a suite.
 *
 * A case may belong to several suites — that is why `suite_cases` is a join table and not a column
 * on `test_cases`. A login case genuinely belongs in both "Smoke" and "Auth", and discovering that
 * after the data exists is an expensive migration.
 */
export async function addCaseToSuite(
  userId: string, orgId: string, role: Role, suiteId: string, caseId: string,
): Promise<void> {
  const suiteProject = await projectOfSuite(userId, orgId, role, suiteId);
  const caseProject = await projectOfCase(userId, orgId, role, caseId);
  if (suiteProject !== caseProject) {
    // A case belongs to exactly one project (hard ownership). Letting a suite reach across
    // projects would make "which project governs this case's visibility" ambiguous, which is the
    // one question the whole access model rests on.
    throw new AccessError(400, "that case belongs to a different project");
  }

  const client = requireClient();
  // Append: next free position, so a newly added case runs last rather than silently displacing
  // whatever already sat at 0.
  const { data: existing } = await client
    .from("suite_cases").select("position").eq("suite_id", suiteId);
  const next = ((existing ?? []) as { position: number }[])
    .reduce((max, r) => Math.max(max, r.position ?? 0), -1) + 1;

  const { error } = await client
    .from("suite_cases")
    .upsert({ suite_id: suiteId, test_case_id: caseId, position: next },
      { onConflict: "suite_id,test_case_id", ignoreDuplicates: true });
  if (error) throw new AccessError(500, `could not add to suite: ${error.message}`);
}

export async function removeCaseFromSuite(
  userId: string, orgId: string, role: Role, suiteId: string, caseId: string,
): Promise<void> {
  await projectOfSuite(userId, orgId, role, suiteId);
  const client = requireClient();
  const { error } = await client
    .from("suite_cases").delete().eq("suite_id", suiteId).eq("test_case_id", caseId);
  if (error) throw new AccessError(500, `could not remove from suite: ${error.message}`);
}

/** Rewrite a suite's execution order from a full list of its case ids. */
export async function reorderSuite(
  userId: string, orgId: string, role: Role, suiteId: string, orderedCaseIds: string[],
): Promise<void> {
  await projectOfSuite(userId, orgId, role, suiteId);
  const client = requireClient();

  const { data, error } = await client
    .from("suite_cases").select("test_case_id").eq("suite_id", suiteId);
  if (error) throw new AccessError(500, `could not read suite: ${error.message}`);
  const present = new Set(((data ?? []) as { test_case_id: string }[]).map((r) => r.test_case_id));

  // Only reposition rows that are actually in this suite. An id that isn't gets ignored rather
  // than inserted — reorder is not a back door for adding.
  let position = 0;
  for (const caseId of orderedCaseIds) {
    if (!present.has(caseId)) continue;
    const { error: upErr } = await client
      .from("suite_cases").update({ position: position++ })
      .eq("suite_id", suiteId).eq("test_case_id", caseId);
    if (upErr) throw new AccessError(500, `could not reorder suite: ${upErr.message}`);
  }
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

function toCaseRow(r: any): CaseRow {
  return {
    id: r.id,
    projectId: r.project_id,
    title: r.title,
    feature: r.feature ?? null,
    currentVersion: r.current_version ?? 1,
    sourceRunId: r.source_run_id ?? null,
    lastRunStatus: r.last_run_status ?? null,
    lastRunAt: r.last_run_at ?? null,
    updatedAt: r.updated_at ?? null,
  };
}

async function casesByIds(ids: string[]): Promise<CaseRow[]> {
  if (ids.length === 0) return [];
  const client = requireClient();
  const { data, error } = await client
    .from("test_cases")
    .select("id, project_id, title, feature, current_version, source_run_id, last_run_status, last_run_at, updated_at")
    .in("id", ids);
  if (error) throw new AccessError(500, `could not read cases: ${error.message}`);
  return ((data ?? []) as any[]).map(toCaseRow);
}

/**
 * How many saved cases each project holds — the ONE source for that number.
 *
 * The sidebar tree renders `.tree-count` on a project row and on each of its suite rows, in the
 * same position. Those used to be different units: the project showed its RUN count while its
 * children showed CASE counts, so a project with 38 runs and 3 cases read as holding 38 cases.
 * This is the number that fixes it, and it lives here because `library.ts` owns the case library —
 * counting rows client-side by fetching every case just to take `.length` does not scale and
 * drifts from what the server thinks.
 *
 * COUNTS EVERY CASE IN THE PROJECT, NOT THE SUM OF ITS SUITES. `project_id` is on the case itself,
 * so a case that is saved but filed in no suite is still counted — without that it would vanish
 * from the tree entirely, present in the library and invisible in the only place that lists it.
 * A project's number can therefore legitimately exceed the sum of its suite numbers, and that is
 * correct rather than a discrepancy to reconcile.
 *
 * That property falls out of the schema rather than being enforced here: the count is over
 * `test_cases`, never through the `suite_cases` join. `deleteCase` is a hard delete, so there is
 * no soft-deleted state to exclude either.
 *
 * One grouped query for every project, matching `listSuites`' own count — never one per project.
 */
export async function countCasesByProject(projectIds: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (projectIds.length === 0) return counts;

  const client = requireClient();
  const { data, error } = await client
    .from("test_cases").select("project_id").in("project_id", projectIds);
  if (error) throw new AccessError(500, `could not count cases: ${error.message}`);

  for (const r of (data ?? []) as { project_id: string | null }[]) {
    if (r.project_id) counts.set(r.project_id, (counts.get(r.project_id) ?? 0) + 1);
  }
  return counts;
}

/** Cases the caller may see, optionally narrowed to one project. */
export async function listCases(
  userId: string, orgId: string, role: Role, projectId?: string,
): Promise<CaseRow[]> {
  const client = requireClient();
  let projectIds: string[];
  if (projectId) {
    await assertProjectVisible(userId, orgId, role, projectId);
    projectIds = [projectId];
  } else {
    projectIds = (await scopeProjectIds(userId, orgId, role)) ?? [];
  }
  if (projectIds.length === 0) return [];

  const { data, error } = await client
    .from("test_cases")
    .select("id, project_id, title, feature, current_version, source_run_id, last_run_status, last_run_at, updated_at")
    .in("project_id", projectIds);
  if (error) throw new AccessError(500, `could not list cases: ${error.message}`);
  return ((data ?? []) as any[]).map(toCaseRow).sort((a, b) => a.title.localeCompare(b.title));
}

/** One case with its IR, its version history, and which suites it sits in. */
export async function getCase(
  userId: string, orgId: string, role: Role, caseId: string,
): Promise<CaseRow & { ir: IR; versions: CaseVersionRow[]; suiteIds: string[] }> {
  await projectOfCase(userId, orgId, role, caseId);
  const client = requireClient();

  const { data, error } = await client
    .from("test_cases")
    .select("id, project_id, title, feature, ir, current_version, source_run_id, last_run_status, last_run_at, updated_at")
    .eq("id", caseId).single();
  if (error || !data) throw new AccessError(404, "no such case");

  const { data: vRows } = await client
    .from("test_case_versions")
    .select("version, change_note, saved_by, saved_at")
    .eq("test_case_id", caseId).order("version", { ascending: false });

  const { data: sRows } = await client
    .from("suite_cases").select("suite_id").eq("test_case_id", caseId);

  return {
    ...toCaseRow(data),
    ir: parseIr((data as any).ir, "the stored test plan"),
    versions: ((vRows ?? []) as any[]).map((v) => ({
      version: v.version,
      changeNote: v.change_note ?? null,
      savedBy: v.saved_by ?? null,
      savedAt: v.saved_at ?? null,
    })),
    suiteIds: ((sRows ?? []) as { suite_id: string }[]).map((r) => r.suite_id),
  };
}

/** One specific stored version's IR — what the Compare screen diffs. */
export async function getCaseVersion(
  userId: string, orgId: string, role: Role, caseId: string, version: number,
): Promise<{ version: number; ir: IR; changeNote: string | null; savedAt: string | null }> {
  await projectOfCase(userId, orgId, role, caseId);
  const client = requireClient();
  const { data, error } = await client
    .from("test_case_versions")
    .select("version, ir, change_note, saved_at")
    .eq("test_case_id", caseId).eq("version", version).maybeSingle();
  if (error) throw new AccessError(500, `could not read version: ${error.message}`);
  if (!data) throw new AccessError(404, "no such version of this case");
  return {
    version: (data as any).version,
    ir: parseIr((data as any).ir, `version ${version}`),
    changeNote: (data as any).change_note ?? null,
    savedAt: (data as any).saved_at ?? null,
  };
}

export interface CaseScript {
  /** The Playwright spec. Never empty for a case that exists. */
  spec: string;
  /** `stored` — read back from the version row. `generated` — re-derived from the IR just now. */
  source: "stored" | "generated";
  /** Which version this spec belongs to. */
  version: number;
}

/**
 * The Playwright script for a saved case — always, for any case that exists.
 *
 * THE BUG THIS EXISTS TO FIX: the `.spec.ts` used to live only inside the originating run's
 * artifact folder. `DELETE /api/runs/:runId` does an `rmSync` of that folder, and retention does
 * the same on a timer, so a case could truthfully report "Passed v1" while its Script tab said
 * "No script yet" — the evidence had been deleted out from under it. Cloning the repo onto another
 * machine had the same effect, since `runs/` is gitignored. See `TECH_DEBT.md` TD-68.
 *
 * Two sources, in order:
 *   1. the `spec` stored alongside the version's IR at save time — the exact bytes that version
 *      was saved with;
 *   2. failing that, `generateSpec(ir)` right now.
 *
 * (2) is not a degraded mode. The generator is pure code with no LLM (DECISIONS.md D-06), so it is
 * deterministic: the same IR yields the same spec every time. `source` is returned so the UI can
 * be honest about which one the reader is looking at, not because one of them is untrustworthy.
 *
 * **This never throws for a valid, visible case.** A missing `spec` column, an unreadable version
 * row, a database that has not been migrated yet — all fall through to (2). The only errors it
 * raises are the access ones every other function here raises: 404 for a case you cannot see.
 */
export async function getCaseScript(
  userId: string, orgId: string, role: Role, caseId: string, version?: number,
): Promise<CaseScript> {
  const found = await getCase(userId, orgId, role, caseId);
  const wanted = version ?? found.currentVersion;

  // A version explicitly asked for must be the one returned, so its IR comes from the version row.
  // getCaseVersion 404s for a version that does not exist, which is the right answer to `?version=`
  // naming one — but the CURRENT version is never allowed to fail that way (see the fallback below).
  let ir = found.ir;
  if (version !== undefined && version !== found.currentVersion) {
    ir = (await getCaseVersion(userId, orgId, role, caseId, version)).ir;
  }

  // Deliberately its own narrow query rather than a new field on getCase/getCaseVersion: those two
  // back `GET /api/cases/:id` and `GET /api/cases/:id/versions/:v`, and widening their return would
  // ship the whole spec text on every Compare-screen fetch that has no use for it.
  let stored: string | null = null;
  try {
    const client = requireClient();
    const { data } = await client
      .from("test_case_versions")
      .select("spec")
      .eq("test_case_id", caseId).eq("version", wanted).maybeSingle();
    const raw = (data as { spec?: unknown } | null)?.spec;
    if (typeof raw === "string" && raw.trim()) stored = raw;
  } catch {
    // Swallowed on purpose — a script must always come back. Before the column existed this threw
    // on every read, and the whole point of this function is that it cannot leave a case scriptless.
  }

  return stored
    ? { spec: stored, source: "stored", version: wanted }
    : { spec: generateSpec(ir, LIBRARY_SHOT_DIR), source: "generated", version: wanted };
}

/**
 * Save a case out of a finished run — the bridge from authoring to library (Step 5.2).
 *
 * Reads the IR the pipeline already wrote for that case and validates it through the imported
 * schema before storing. A run's own artifacts are the source of truth here: re-deriving the IR
 * would mean a second implementation of what the case *is*.
 */
export async function saveCaseFromRun(
  userId: string, orgId: string, role: Role,
  runId: string, caseId: string, projectId: string,
  opts: { title?: string; suiteId?: string } = {},
): Promise<CaseRow> {
  await assertProjectVisible(userId, orgId, role, projectId);

  // Per-case IR first (a suite run), then the run-level one (a single-case run). The run-level
  // file wraps the IR as { ir, updatedAppModel }; the per-case file does not.
  const perCase = path.join("runs", runId, "cases", caseId, "04-ir.json");
  const runLevel = path.join("runs", runId, "04-ir.json");
  const file = existsSync(perCase) ? perCase : existsSync(runLevel) ? runLevel : null;
  if (!file) throw new AccessError(404, "that run has no saved test plan for this case");

  let raw: unknown;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    raw = parsed?.ir ?? parsed;
  } catch (err) {
    throw new AccessError(500, `could not read that run's test plan: ${(err as Error)?.message}`);
  }
  const ir = parseIr(raw, "that run's test plan");

  const title = (opts.title ?? ir.meta.title ?? "Untitled case").trim() || "Untitled case";
  const client = requireClient();
  const now = new Date().toISOString();

  const { data, error } = await client
    .from("test_cases")
    .insert({
      project_id: projectId,
      title,
      feature: ir.meta.feature ?? null,
      ir,
      current_version: 1,
      source_run_id: runId,
      updated_at: now,
      updated_by: userId,
    })
    .select("id, project_id, title, feature, current_version, source_run_id, last_run_status, last_run_at, updated_at")
    .single();
  if (error || !data) throw new AccessError(500, `could not save case: ${error?.message}`);

  // Version 1 is written in the same breath as the case. Without it the Compare screen has
  // nothing to compare against for a case that is later edited once — the original would simply
  // not exist, and version history that starts at "the second edit" is worse than none.
  await client.from("test_case_versions").insert({
    test_case_id: data.id,
    version: 1,
    ir,
    spec: specForStorage(ir),
    change_note: `Saved from run ${runId}`,
    saved_by: userId,
  });

  if (opts.suiteId) {
    await addCaseToSuite(userId, orgId, role, opts.suiteId, data.id);
  }
  return toCaseRow(data);
}

/**
 * Raised when a case moved on under an editor's feet. Carries the current server-side state so the
 * caller can show what changed instead of a bare refusal.
 */
export class CaseConflictError extends Error {
  readonly status = 409;
  constructor(
    readonly expectedVersion: number,
    readonly currentVersion: number,
    readonly current: CaseRow & { ir: IR; versions: CaseVersionRow[]; suiteIds: string[] },
  ) {
    super(
      `this case has changed since you opened it — you have v${expectedVersion}, it is now ` +
      `v${currentVersion}. Review the newer version before saving over it.`,
    );
    this.name = "CaseConflictError";
  }
}

/** Edit a case's steps or title. Every IR change mints a new version. */
export async function updateCase(
  userId: string, orgId: string, role: Role, caseId: string,
  patch: { title?: string; ir?: unknown; changeNote?: string; expectedVersion?: number },
): Promise<CaseRow> {
  await projectOfCase(userId, orgId, role, caseId);
  const client = requireClient();

  const { data: current, error: readErr } = await client
    .from("test_cases").select("current_version").eq("id", caseId).single();
  if (readErr || !current) throw new AccessError(404, "no such case");

  // Optimistic concurrency (plan Step 5.4). OPTIONAL: a request that sends no `expectedVersion`
  // behaves exactly as it always did, so this is additive and no existing caller changes. When it
  // IS sent and is stale, refuse with the current state rather than silently overwriting — the
  // loser of a race otherwise never learns their colleague's edit is gone.
  const currentVersion = (current as { current_version: number }).current_version;
  if (typeof patch.expectedVersion === "number" && patch.expectedVersion !== currentVersion) {
    throw new CaseConflictError(
      patch.expectedVersion,
      currentVersion,
      await getCase(userId, orgId, role, caseId),
    );
  }

  const update: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: userId };
  let nextVersion = currentVersion;

  if (typeof patch.title === "string" && patch.title.trim()) update.title = patch.title.trim();

  if (patch.ir !== undefined) {
    const ir = parseIr(patch.ir, "the edited test plan");
    nextVersion += 1;
    update.ir = ir;
    update.current_version = nextVersion;
    const { error: vErr } = await client.from("test_case_versions").insert({
      test_case_id: caseId,
      version: nextVersion,
      ir,
      spec: specForStorage(ir),
      change_note: patch.changeNote?.trim() || "Edited",
      saved_by: userId,
    });
    if (vErr) throw new AccessError(500, `could not record the new version: ${vErr.message}`);
  }

  if (Object.keys(update).length === 2) {
    throw new AccessError(400, "nothing to update — send a title or steps");
  }

  const { data, error } = await client
    .from("test_cases").update(update).eq("id", caseId)
    .select("id, project_id, title, feature, current_version, source_run_id, last_run_status, last_run_at, updated_at")
    .single();
  if (error || !data) throw new AccessError(500, `could not update case: ${error?.message}`);
  return toCaseRow(data);
}

/**
 * Copy a case into an independent one.
 *
 * The copy starts a FRESH history at v1 rather than cloning the original's versions or runs. A
 * duplicate is a new piece of authored work that happens to start from the same steps — carrying
 * over "edited by Priya three weeks ago" would attribute history to a case that did not exist yet,
 * and carrying over run results would claim outcomes it never produced.
 */
export async function duplicateCase(
  userId: string, orgId: string, role: Role, caseId: string, title?: string,
): Promise<CaseRow> {
  const projectId = await projectOfCase(userId, orgId, role, caseId);
  const client = requireClient();

  const { data: src, error } = await client
    .from("test_cases").select("title, feature, ir").eq("id", caseId).single();
  if (error || !src) throw new AccessError(404, "no such case");

  const ir = parseIr((src as any).ir, "the case being duplicated");
  const copyTitle = (title ?? `${(src as any).title} (copy)`).trim() || "Untitled case";
  const now = new Date().toISOString();

  const { data, error: insErr } = await client
    .from("test_cases")
    .insert({
      project_id: projectId,
      title: copyTitle,
      feature: (src as any).feature ?? null,
      ir,
      current_version: 1,
      // Deliberately null: this case did not come out of a run, it came out of another case.
      source_run_id: null,
      updated_at: now,
      updated_by: userId,
    })
    .select("id, project_id, title, feature, current_version, source_run_id, last_run_status, last_run_at, updated_at")
    .single();
  if (insErr || !data) throw new AccessError(500, `could not duplicate case: ${insErr?.message}`);

  await client.from("test_case_versions").insert({
    test_case_id: data.id,
    version: 1,
    ir,
    spec: specForStorage(ir),
    change_note: `Duplicated from "${(src as any).title}"`,
    saved_by: userId,
  });

  return toCaseRow(data);
}

export interface CaseRunRow {
  runId: string;
  caseIndex: number;
  status: string | null;
  ranAt: string | null;
  /** Where this case's artifacts live inside that run — `cases/case-N`. */
  resultPath: string;
}

/** A case's own run history, newest first — what the "Runs & versions" tab lists. */
export async function listCaseRuns(
  userId: string, orgId: string, role: Role, caseId: string, limit = 20,
): Promise<CaseRunRow[]> {
  await projectOfCase(userId, orgId, role, caseId);
  const client = requireClient();

  const { data, error } = await client
    .from("run_cases")
    .select("run_id, case_index, status, created_at")
    .eq("test_case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(Math.min(Math.max(limit, 1), 100));
  if (error) throw new AccessError(500, `could not read run history: ${error.message}`);

  return ((data ?? []) as any[]).map((r) => ({
    runId: r.run_id,
    caseIndex: r.case_index,
    status: r.status ?? null,
    ranAt: r.created_at ?? null,
    resultPath: `cases/case-${r.case_index}`,
  }));
}

export async function deleteCase(
  userId: string, orgId: string, role: Role, caseId: string,
): Promise<void> {
  await projectOfCase(userId, orgId, role, caseId);
  const client = requireClient();
  const { error } = await client.from("test_cases").delete().eq("id", caseId);
  if (error) throw new AccessError(500, `could not delete case: ${error.message}`);
}

/** Record how a case's most recent replay went, so the library shows a status without a join. */
export async function recordCaseOutcome(caseId: string, status: string): Promise<void> {
  const client = getServiceClient();
  if (!client) return;
  try {
    await client
      .from("test_cases")
      .update({ last_run_status: status, last_run_at: new Date().toISOString() })
      .eq("id", caseId);
  } catch (err) {
    // Never fatal: the replay itself already succeeded and its artifacts are on disk.
    console.error(`[library] could not record outcome for case ${caseId}:`, (err as Error)?.message ?? err);
  }
}

/**
 * Load the cases a replay will execute, in order, proving every one is visible to the caller.
 *
 * Returns them with their IRs parsed. Used by all three execution paths (whole suite, a chosen
 * subset, a single case) so the access check and the ordering rule exist once.
 */
export async function loadCasesForReplay(
  userId: string, orgId: string, role: Role,
  sel: { suiteId?: string; caseIds?: string[] },
): Promise<{ id: string; title: string; ir: IR; projectId: string }[]> {
  const client = requireClient();

  let ids: string[];
  const order = new Map<string, number>();
  if (sel.suiteId) {
    await projectOfSuite(userId, orgId, role, sel.suiteId);
    const { data, error } = await client
      .from("suite_cases").select("test_case_id, position").eq("suite_id", sel.suiteId);
    if (error) throw new AccessError(500, `could not read suite: ${error.message}`);
    const links = (data ?? []) as { test_case_id: string; position: number }[];
    for (const l of links) order.set(l.test_case_id, l.position ?? 0);
    // A subset within a suite: intersect, so "run 3 selected" honours the suite's order.
    ids = sel.caseIds?.length
      ? links.filter((l) => sel.caseIds!.includes(l.test_case_id)).map((l) => l.test_case_id)
      : links.map((l) => l.test_case_id);
  } else {
    ids = sel.caseIds ?? [];
    ids.forEach((id, i) => order.set(id, i));
  }
  if (ids.length === 0) throw new AccessError(400, "no cases selected to run");

  const { data, error } = await client
    .from("test_cases").select("id, project_id, title, ir").in("id", ids);
  if (error) throw new AccessError(500, `could not load cases: ${error.message}`);
  const rows = (data ?? []) as { id: string; project_id: string; title: string; ir: unknown }[];
  if (rows.length === 0) throw new AccessError(404, "none of those cases exist");

  // Every case is re-checked individually. Selecting by id must never be a way to reach a project
  // you were not added to, even when the ids arrive in one list.
  const checked = new Set<string>();
  for (const r of rows) {
    if (checked.has(r.project_id)) continue;
    await assertProjectVisible(userId, orgId, role, r.project_id);
    checked.add(r.project_id);
  }

  return rows
    .map((r) => ({
      id: r.id,
      title: r.title,
      projectId: r.project_id,
      ir: parseIr(r.ir, `case "${r.title}"`),
    }))
    .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

/** Composing the library is authoring, not administration — `tester` and above. */
export function assertCanAuthor(role: Role): void {
  if (!roleAtLeast(role, "tester")) {
    throw new AccessError(403, "this action requires the tester role or higher");
  }
}
