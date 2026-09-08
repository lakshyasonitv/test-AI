import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { AppModel } from "../schema/appModel.js";
import type { IR, Step } from "../schema/ir.js";
import { groundingError } from "./ir.js";
import { refreshPageModelAt, WALK_CACHE_NS } from "./liveExtend.js";
import { LlmBudget, enterWithBudget } from "../llm/llmBudget.js";
import { siteHost } from "../text.js";
import { cacheNamespaceDir } from "../kb/llmCache.js";
import { redactCredentials, type Credentials } from "./credentials.js";

/**
 * Re-grounding an edited case — the half of case editing that costs money.
 *
 * A saved step is GROUNDED: its target carries the `css`/`testId` grounding copied from an element
 * discovery actually verified exists. `stepText.ts` renders that to English for editing and strips
 * exactly those fields when the sentence changes, so an edited step arrives here describing an
 * element by role+name alone, unverified.
 *
 * This module puts the verification back. It does NOT implement grounding:
 *
 *   - `groundingError()` (ir.ts) is the one grounder. It is both validator and mutator — it
 *     self-corrects `role`/`name` to the model's literal values and writes `css`/`testId` back
 *     onto the target from the matched element. Calling it is the entire grounding step here.
 *   - `refreshPageModel()` (liveExtend.ts) is the one live walker. It replays a step prefix in a
 *     real browser and merges a fresh snapshot of whatever page it lands on into the AppModel.
 *
 * Writing either again is TD-07 — targetResolver's locator logic restated in generator.ts and then
 * drifting — happening a third time. Both are called, neither is reimplemented.
 *
 * WHY A BROWSER IS UNAVOIDABLE. You cannot check that step 7 resolves without executing steps 1-6
 * to arrive at the page step 7 acts on. That is the walk below, and it is why an edit costs real
 * time and (when a page needs vision to model) real tokens, while a replay of an unedited case
 * costs nothing at all.
 */

/** Snapshots per save. `MAX_LIVE_EXTENSIONS` is the existing "browser replays allowed per case"
 *  budget — the same quantity, so it is reused rather than given a second name. */
const walkBudget = () => Number(process.env.MAX_LIVE_EXTENSIONS ?? 5);

/** Whole-save ceiling. A hung site must not hold a request open indefinitely; the browser itself
 *  is closed by `replayAndSnapshot`'s own `finally`, so this bounds the wait, not the cleanup. */
const REGROUND_TIMEOUT_MS = () => Number(process.env.REGROUND_TIMEOUT_MS ?? 180_000);

export type RegroundResult =
  | { ok: true; ir: IR; snapshots: number; usage: ReturnType<LlmBudget["snapshot"]> }
  | {
      ok: false;
      /** Index into `ir.steps` of the step that could not be resolved — what the editor
       *  attaches the message to, so a failure lands on the row that caused it. */
      stepIndex: number;
      stepId: string;
      message: string;
      snapshots: number;
      usage: ReturnType<LlmBudget["snapshot"]>;
      /** True when the caller stopped this deliberately, so the UI can say "cancelled" rather
       *  than reporting a failure the user did not cause. */
      cancelled?: boolean;
    };

/** Raised internally when `shouldCancel()` goes true. Never escapes as a failure. */
class CancelledError extends Error {
  constructor() { super("re-grounding was cancelled"); this.name = "CancelledError"; }
}

export interface RegroundHooks {
  sourceRunId?: string | null;
  creds?: Credentials;
  /**
   * Polled between snapshots. Returning true stops the walk before the next browser launch.
   *
   * Checked BETWEEN steps, not inside a Playwright call — an in-flight snapshot finishes, and
   * `replayAndSnapshot`'s own `finally` closes its browser either way. So a cancel can take up to
   * one snapshot to land, and no browser is ever left open. Nothing is written on this path: the
   * caller never reaches `updateCase`, so there is no version row and no `current_version` bump.
   */
  shouldCancel?: () => boolean;
  /** Per-step progress, for a UI that has to say "verifying step 4 of 9" while this runs. */
  onProgress?: (p: {
    phase: "walking" | "grounding";
    stepIndex: number;
    stepId: string;
    done: number;
    total: number;
  }) => void;
}

/**
 * The AppModel to start from.
 *
 * A case's source run already snapshotted the site, so its `02-appmodel.json` is a far better
 * starting point than an empty model — every page the flow touched is likely already in it, and a
 * step whose target did not change needs no fresh snapshot at all. Falls back to an empty model
 * (the run may have been pruned; `runs/` ages off disk) and lets the walk populate it.
 */
function baseModel(ir: IR, sourceRunId: string | null, runsDir = RUNS_DIR): AppModel {
  const baseUrl = ir.meta.baseUrl || "";
  if (sourceRunId) {
    const file = path.join(runsDir, sourceRunId, "02-appmodel.json");
    if (existsSync(file)) {
      try {
        const parsed = AppModel.safeParse(JSON.parse(readFileSync(file, "utf8")));
        if (parsed.success) return parsed.data;
      } catch {
        // A malformed or half-written snapshot is not worth failing an edit over — walk instead.
      }
    }
  }
  return { baseUrl, pages: [] };
}

/**
 * Where run artifacts live. A parameter with this default rather than a hardcoded literal, so a
 * test can point it at a temp directory: writing fixtures into the real `runs/` tree leaks into
 * whatever else is reading it, and vitest runs files in parallel. Production never passes it.
 */
const RUNS_DIR = "runs";

/** Roles a step can actually act on. A heading or a paragraph is not something to click. */
const ACTIONABLE_ROLES = new Set([
  "button", "link", "menuitem", "tab", "textbox", "searchbox", "combobox",
  "checkbox", "radio", "switch", "option",
]);

/** Same per-list bound the concept-labeling prompt uses (TD-73): one runaway element name must
 *  not be able to dominate a prompt, and neither must a page with thousands of them. */
const ELEMENT_NAME_MAX = 200;
const ELEMENT_LIST_MAX = () => {
  const raw = Number(process.env.REWRITE_ELEMENTS_MAX_CHARS ?? 4000);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 4000;
};

export interface CaseElementContext {
  /** `role "name"` lines, ready to paste into a prompt. Empty when nothing is known. */
  lines: string[];
  /** Where they came from, for the note shown above the diff. */
  source: "run" | "walks" | "none";
}

/**
 * The controls a rewrite is allowed to refer to, for the pages this case touches.
 *
 * WHY (TD-91). `proposeRewrite` was given the case title, the current steps and the instruction —
 * and nothing about the site. Asked to "navigate to the admin panel" it answered
 * `Click on button "Admin Panel"`, which is the page HEADING; the real control is
 * `button "Admin"`. The model had no way to know that, and no way to find out.
 *
 * Sources, best first:
 *   1. the case's own source run model — what discovery actually saw
 *   2. any cached browser walk for the same site — what a verification walk actually reached
 *   3. nothing, and the caller says so in the note rather than pretending
 *
 * (2) is possible because the walk cache is namespaced and its entries are `ReplayResult`s
 * carrying a `pageModel`. The keys are opaque hashes, so they cannot be looked up by case — the
 * directory is enumerated and entries are filtered by SITE, using the same `pageKey` host
 * comparison as everything else.
 */
export function caseElementContext(
  ir: IR, sourceRunId: string | null, runsDir = RUNS_DIR,
): CaseElementContext {
  const wanted = siteHost(ir.meta.baseUrl || "");
  const fromModel = (model: AppModel): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const page of model.pages) {
      for (const el of page.elements ?? []) {
        const role = (el.role ?? "").toLowerCase();
        if (!ACTIONABLE_ROLES.has(role)) continue;
        const name = (el.name ?? "").replace(/\s+/g, " ").trim();
        if (!name || name.length > ELEMENT_NAME_MAX) continue;
        const key = `${role}|${name.toLowerCase()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(`${role} "${name}"`);
      }
    }
    return out;
  };

  const model = baseModel(ir, sourceRunId, runsDir);
  if (model.pages.length > 0) {
    const lines = cap(fromModel(model));
    if (lines.length) return { lines, source: "run" };
  }

  // Fall back to whatever a previous verification walk saw on this site.
  if (wanted) {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const entry of readWalkSnapshots()) {
      if (siteHost(entry.reachedUrl ?? "") !== wanted) continue;
      for (const line of fromModel({ baseUrl: ir.meta.baseUrl, pages: [entry.pageModel] } as AppModel)) {
        if (seen.has(line)) continue;
        seen.add(line);
        out.push(line);
      }
    }
    const lines = cap(out);
    if (lines.length) return { lines, source: "walks" };
  }
  return { lines: [], source: "none" };
}

/** Trim the list to the char budget, dropping from the END like every other prompt-fitting
 *  helper here, so a page's primary chrome survives. */
function cap(lines: string[]): string[] {
  const max = ELEMENT_LIST_MAX();
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length + 1 > max) break;
    kept.push(l);
    used += l.length + 1;
  }
  return kept;
}

/** Every cached walk result on disk. Best-effort: an unreadable or half-written entry is skipped,
 *  never fatal — this is an optional enrichment, not a dependency. */
function readWalkSnapshots(): { reachedUrl?: string; pageModel: AppModel["pages"][number] }[] {
  // The CACHE root, not the runs directory a caller may have redirected: a cached walk is not a
  // run artifact, and `llmCache` owns where it lives.
  const dir = cacheNamespaceDir(WALK_CACHE_NS);
  if (!existsSync(dir)) return [];
  const out: { reachedUrl?: string; pageModel: AppModel["pages"][number] }[] = [];
  try {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const parsed = JSON.parse(readFileSync(path.join(dir, f), "utf8"));
        if (parsed?.pageModel?.elements) out.push(parsed);
      } catch { /* skip this one */ }
    }
  } catch { /* no cache directory, or unreadable */ }
  return out;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)}s`)), ms);
    }),
  ]);
}

/**
 * Verify an edited IR against the live site, filling grounding back in.
 *
 * `changedIndexes` is what `parseIrSteps` reported. **An empty list means no browser work at
 * all** — re-rendering and re-parsing an untouched case is free, and a save that only renamed the
 * case must not launch Chromium.
 *
 * What is re-grounded, precisely: `groundingError` walks EVERY step, but only steps whose target
 * lost its `css`/`testId` (i.e. the ones the user actually edited) have anything to re-derive —
 * an untouched step still carries its grounding and passes on the identity it already had. What
 * the walk buys is the page models those edited steps have to resolve against, which is why the
 * snapshot prefixes are keyed on the changed indexes and not on all of them.
 */
export async function regroundEditedIr(
  ir: IR,
  regroundIndexes: number[],
  opts: RegroundHooks = {},
): Promise<RegroundResult> {
  const budget = new LlmBudget();
  enterWithBudget(budget);

  // Nothing needs verifying: the stored grounding is still exactly as valid as it was, and
  // spending a browser launch to re-confirm it would make every trivial save cost money. This is
  // the fast path — retyping a fill's value, or renaming the case, lands here.
  if (regroundIndexes.length === 0) {
    return { ok: true, ir, snapshots: 0, usage: budget.snapshot() };
  }

  let model = baseModel(ir, opts.sourceRunId ?? null);
  let snapshots = 0;
  /** Which URL the walk reached for each step index it walked to. Handed to `groundingError` so
   *  an edited step resolves against the page actually reached, not against every page. TD-86. */
  const reachedUrlAt = new Map<number, string>();
  let cancelled = false;

  try {
    await withTimeout((async () => {
      const cap = walkBudget();
      // One snapshot per step needing verification, at the prefix that arrives at it. Deduped by
      // arrival point: two edits on the same page share a walk. `refreshPageModel` replaces the
      // page at whatever URL it reaches, and `replayAndSnapshot` caches on the prefix, so a
      // repeated prefix is free.
      const prefixes = [...new Set(regroundIndexes.map((i) => Math.max(0, i)))].sort((a, b) => a - b);
      const walkable = prefixes.filter((i) => i > 0);

      for (const index of prefixes) {
        if (opts.shouldCancel?.()) { cancelled = true; throw new CancelledError(); }
        if (snapshots >= cap) {
          console.log(`[caseEdit] walk budget (${cap}) reached — grounding the rest against what is already modelled`);
          break;
        }
        const prefix = ir.steps.slice(0, index);
        // Nothing to walk to: step 0 acts on the entry page, which the base model already has (or
        // which groundingError's navigate handling covers).
        if (prefix.length === 0) continue;

        opts.onProgress?.({
          phase: "walking",
          stepIndex: index,
          stepId: ir.steps[index]?.id ?? String(index + 1),
          done: snapshots,
          total: walkable.length,
        });

        try {
          // refreshPageModelAt, not refreshPageModel: the URL the walk landed on is recorded per
          // step index and handed to the grounder, so an edited step is checked against the page
          // that was actually reached rather than against every page at once. TD-86.
          const walked = await refreshPageModelAt(model, prefix, opts.creds);
          model = walked.model;
          reachedUrlAt.set(index, walked.reachedUrl);
          snapshots++;
        } catch (err: any) {
          // A prefix that will not replay is itself the finding, and it is attributable: the
          // walk stopped at this step, so this is the step to blame.
          const failing = ir.steps[index];
          throw Object.assign(
            new Error(
              `could not reach step ${failing?.id ?? index + 1} to check it: ${err?.message ?? err}. ` +
              `The steps before it did not run through — one of them may be the real problem.`,
            ),
            { stepIndex: index, stepId: failing?.id ?? String(index + 1) },
          );
        }
      }
      if (opts.shouldCancel?.()) { cancelled = true; throw new CancelledError(); }
    })(), REGROUND_TIMEOUT_MS(), "checking the edited steps against the site");
  } catch (err: any) {
    const stepIndex = typeof err?.stepIndex === "number" ? err.stepIndex : (regroundIndexes[0] ?? 0);
    return {
      ok: false,
      stepIndex,
      stepId: err?.stepId ?? ir.steps[stepIndex]?.id ?? String(stepIndex + 1),
      // Redacted because this message is emitted as a job event and rendered in the editor, and
      // the walk types REAL credentials into a real browser. A Playwright failure on the fill
      // itself quotes what it was filling, so an unredacted message is a live password on its way
      // to the client. `replayAndSnapshot` already redacts the model and page text it returns;
      // this closes the one path out of here that it does not cover.
      message: cancelled
        ? "cancelled before saving — nothing was written, and the case is exactly as it was"
        : redactCredentials(err?.message ?? String(err), opts.creds),
      snapshots,
      usage: budget.snapshot(),
      ...(cancelled ? { cancelled: true } : {}),
    };
  }

  opts.onProgress?.({
    phase: "grounding",
    stepIndex: regroundIndexes[0] ?? 0,
    stepId: ir.steps[regroundIndexes[0] ?? 0]?.id ?? "",
    done: snapshots,
    total: snapshots,
  });

  // The single grounder. Mutates `ir.steps[*].target` in place: corrects role/name to the model's
  // literal values and writes back the css/testId the edit stripped.
  const grounded: IR = { ...ir, steps: ir.steps.map((s) => ({ ...s, target: s.target ? { ...s.target } : s.target })) };
  // Scoped to the steps this save is actually verifying (TD-86). An untouched step that already
  // carries css/testId is skipped outright: it was grounded against a real page once, the user
  // did not touch it, and re-matching it by name against whatever the walk could reach is how a
  // modal step or a login field gets reported as "not present on the page" for an edit somewhere
  // else entirely. The fresh-run compile path in ir.ts passes no scope and is unaffected.
  const failure = groundingError(grounded, model, { onlyIndexes: regroundIndexes, reachedUrlAt });
  if (failure) {
    const step: Step | undefined = grounded.steps[failure.index];
    return {
      ok: false,
      stepIndex: failure.index,
      stepId: step?.id ?? String(failure.index + 1),
      // The model this grounds against was already redacted by replayAndSnapshot, so this is
      // belt-and-braces — but it costs nothing and it means every message leaving this function
      // is scrubbed on the same line, rather than one being safe by inheritance.
      message: redactCredentials(failure.message, opts.creds),
      snapshots,
      usage: budget.snapshot(),
    };
  }

  return { ok: true, ir: grounded, snapshots, usage: budget.snapshot() };
}
