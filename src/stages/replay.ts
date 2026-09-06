import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { generateSpec } from "./generator.js";
import { runSpec, findScreenshot, findVideo, detectBlocked } from "./executor.js";
import { credentialEnvVars, type Credentials } from "./credentials.js";
import { regroundEditedIr } from "./caseEdit.js";
import { buildSuiteSummary, type CaseRunResult } from "./suiteRunner.js";
import { store } from "../runStore.js";
import type { IR } from "../schema/ir.js";
import type { OnEvent, StageEvent, StageName } from "../orchestrator.js";

/**
 * The replay path — implentationplan.md Step 5.3.
 *
 * A second entry point into the pipeline that starts from a STORED IR instead of building one:
 *
 *     saved IR -> generateSpec() -> runSpec()
 *
 * It skips planning, discovery, case generation and IR compilation entirely — every stage that
 * calls a model. `generator.ts` and `executor.ts` are pure code by design (DECISIONS.md D-06), so
 * this whole module makes **zero LLM calls** and a suite of ten cases costs nothing to re-run.
 * That is the entire economic point, and `08-llm-usage.json` is written here with explicit zeroes
 * so the claim is checkable on disk rather than merely asserted.
 *
 * It emits the SAME StageEvent contract as a normal run, just a shorter sequence, so the existing
 * Run view renders a replay with no frontend changes.
 *
 * THE TRAP, and it is the one the plan calls out by name: `public/app.js` maps stages to four
 * phase cards via PHASES/STAGE_TO_PHASE, and `computePhaseStatus` only reports a phase complete
 * when EVERY stage it tracks has completed. A replay that emitted only `generate`/`execute` would
 * leave cards 1 and 2 stuck on "pending" forever and the run would look hung. So the skipped
 * stages are emitted as immediately-completed, carrying a `skipped` note the UI surfaces verbatim
 * — the plan's "less invasive" option, and the reason this needs no change to the phase logic.
 */

/** A stored case about to be replayed. */
export interface ReplayCase {
  /** The library id (test_cases.id) — used to record the outcome afterwards, not by the runner. */
  id: string;
  title: string;
  ir: IR;
}

export interface ReplayOutcome {
  runId: string;
  runDir: string;
  results: CaseRunResult[];
  summary: ReturnType<typeof buildSuiteSummary>;
}

/** What a replay spends. Written to disk verbatim — the shape LlmBudget.snapshot() produces. */
const ZERO_USAGE = {
  calls: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  exhausted: false,
  byStage: {} as Record<string, never>,
};

/** Scheme + host + port, or undefined for anything unparseable. Exported because the replay
 *  ROUTE needs the same answer this module does, and a second URL-parsing helper is exactly the
 *  drift TD-07 records. */
export function originOf(url: string): string | undefined {
  try { return new URL(url).origin; } catch { return undefined; }
}

/**
 * Re-ground the steps that were never grounded, against the page as it is right now.
 *
 * WHY A SAVED CASE CAN HAVE UNGROUNDED STEPS AT ALL. Grounding writes `css`/`testId` onto a target
 * from the discovered model. Anything revealed by a click — a modal, a tab, an accordion, the next
 * page of a wizard — was never in that model, so its steps carry a role and a name and nothing
 * else. At run time they fall back to name and geometry, which is how the New User modal's "Email"
 * step resolved onto the Full Name input on run `2026-09-06T13-05-36-248Z-db2c0b4c`
 * (`TECH_DEBT.md` TD-72). Better resolution helps; having the real selector helps more.
 *
 * This walks the prefix in a real browser, snapshots what is actually on screen, and grounds those
 * targets against it — the same deterministic role/name matching `groundingError` uses. **Zero LLM
 * calls**, which is the property a replay exists to have.
 *
 * OFF BY DEFAULT (`REPLAY_REGROUND`, platform rule 2). It costs a browser walk before the run, so
 * a replay that does not need it should not pay for it. With the flag unset this function returns
 * its input untouched and a replay is byte-for-byte what it was.
 *
 * **It does not write back to the library** (rule 6, `DECISIONS.md` D-27). The grounded targets are
 * used for THIS execution and recorded in the run's own `cases/case-N/04-ir.json` with
 * `groundedAt: "replay"`, so a person can see what it found and choose to save it. The stored case
 * is untouched.
 */
export function replayRegroundEnabled(): boolean {
  return process.env.REPLAY_REGROUND === "true";
}

/** Indexes of steps carrying a target that grounding never resolved to a real element. */
export function ungroundedStepIndexes(ir: IR): number[] {
  const out: number[] = [];
  ir.steps.forEach((s, i) => {
    const t = s.target;
    if (!t) return;                                   // wait / page-level assertion
    if (t.url && !t.role && !t.name) return;          // navigate
    if (t.css || t.testId) return;                    // already grounded
    if (t.role || t.name || t.text || t.label || t.placeholder) out.push(i);
  });
  return out;
}

async function maybeRegroundForReplay(
  ir: IR,
  creds: Credentials | undefined,
  onProgress: (p: Record<string, unknown>) => void,
): Promise<{ ir: IR; regrounded: number }> {
  if (!replayRegroundEnabled()) return { ir, regrounded: 0 };

  const indexes = ungroundedStepIndexes(ir);
  if (indexes.length === 0) return { ir, regrounded: 0 };

  try {
    // No sourceRunId: a replay grounds against what the walk finds, not against a stored model.
    const res = await regroundEditedIr(ir, indexes, { creds, onProgress });
    if (!res.ok) {
      console.warn(`[replay] re-ground did not complete (${res.message}) — running the saved steps as they are`);
      return { ir, regrounded: 0 };
    }
    // Marked, never silently merged: the person decides whether this becomes the saved case.
    const annotated: IR = {
      ...res.ir,
      steps: res.ir.steps.map((s, i) =>
        indexes.includes(i) && (s.target?.css || s.target?.testId)
          ? { ...s, target: { ...s.target, groundedAt: "replay" as const } }
          : s),
    };
    const fixed = indexes.filter((i) => annotated.steps[i]?.target?.css || annotated.steps[i]?.target?.testId).length;
    console.log(`[replay] re-grounded ${fixed}/${indexes.length} previously-ungrounded step(s) against the live page`);
    return { ir: annotated, regrounded: fixed };
  } catch (err: any) {
    // A replay must still run. Re-grounding is an improvement, never a precondition.
    console.warn(`[replay] re-ground failed (${err?.message ?? err}) — running the saved steps as they are`);
    return { ir, regrounded: 0 };
  }
}

export async function runReplay(
  opts: {
    runId: string;
    cases: ReplayCase[];
    /** Shown as the run's prompt line — "Replayed 4 cases from Smoke", etc. */
    label: string;
    creds?: Credentials;
  },
  onEvent: OnEvent = () => { },
): Promise<ReplayOutcome> {
  const { runId, cases, label, creds } = opts;
  const runDir = path.join("runs", runId);
  mkdirSync(runDir, { recursive: true });

  const save = (name: string, data: unknown) =>
    writeFileSync(path.join(runDir, name), JSON.stringify(data, null, 2));

  const emit = (stage: StageName, status: StageEvent["status"], data?: unknown, error?: string) => {
    const event: StageEvent = { runId, stage, status, data, error, ts: Date.now() };
    store.append(event); // durable log first, exactly as orchestrator.ts does
    onEvent(event);
  };

  const entryUrl = cases[0]?.ir.meta.baseUrl ?? "";

  try {
    save("00-input.json", { prompt: label, url: entryUrl, replay: true, caseCount: cases.length });
    emit("input", "completed", { prompt: label, url: entryUrl, replay: true });

    // The two stages a replay genuinely does not perform. Emitted completed-with-a-reason rather
    // than omitted — see this module's header for why omitting them hangs the phase cards.
    emit("plan", "started");
    emit("plan", "completed", { skipped: "Skipped — replaying saved cases, so there is nothing to plan." });
    emit("discovery", "started");
    emit("discovery", "completed", { skipped: "Skipped — the saved steps already say what to click." });

    // Honest, not decorative: these ARE the cases about to run.
    emit("testcases", "started");
    emit("testcases", "completed", {
      generated: cases.length,
      selected: cases.length,
      total: cases.length,
      skipped: `Replaying ${cases.length} saved case${cases.length === 1 ? "" : "s"} — no cases were generated.`,
    });
    emit("ir", "started");
    emit("ir", "completed", { skipped: "Skipped — the steps were loaded from the saved case." });

    emit("suite", "started", { total: cases.length });

    const results: CaseRunResult[] = [];
    let firstArtifactsDir: string | null = null;

    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      // `case-N`, matching what runSuite writes: buildSuiteSummary and the frontend both address
      // artifacts as `cases/<caseId>/...`, so a different id here would break both.
      const caseId = `case-${i}`;
      const caseDir = path.join(runDir, "cases", caseId);
      mkdirSync(caseDir, { recursive: true });

      emit("suite", "started", { caseId, title: c.title });

      try {
        // Optional pre-pass: ground the steps discovery never saw against the live page.
        const { ir: irToRun, regrounded } = await maybeRegroundForReplay(c.ir, creds, (p) =>
          emit("ir", "started", { caseId, title: c.title, ...p }));
        if (regrounded > 0) {
          emit("ir", "completed", {
            caseId, title: c.title, regrounded,
            skipped: `Re-checked ${regrounded} step${regrounded === 1 ? "" : "s"} against the live page before running.`,
          });
        }

        const irPath = path.join(caseDir, "04-ir.json");
        writeFileSync(irPath, JSON.stringify(irToRun, null, 2));

        emit("generate", "started");
        const spec = generateSpec(irToRun, path.join(caseDir, "artifacts"));
        const specPath = path.join(caseDir, "generated.spec.ts");
        writeFileSync(specPath, spec);
        if (i === 0) writeFileSync(path.join(runDir, "generated.spec.ts"), spec);
        emit("generate", "completed", { caseId, title: c.title });

        emit("execute", "started", { caseId, title: c.title });
        const result = await runSpec(spec, caseDir, credentialEnvVars(creds));
        emit("execute", "completed", { caseId, title: c.title, passed: result.passed });

        const resultPath = path.join(caseDir, "05-result.json");
        writeFileSync(resultPath, JSON.stringify({
          passed: result.passed, exitCode: result.exitCode,
          artifactsDir: result.artifactsDir, resultsJsonPath: result.resultsJsonPath, raw: result.raw,
        }, null, 2));

        if (firstArtifactsDir === null) firstArtifactsDir = result.artifactsDir;

        // Same verdict rules the suite runner applies, in the same order — a wall automation
        // cannot pass outranks pass/fail, and a truncated plan with no terminal assertion cannot
        // report "passed" because the dropped tail may have held the only assertion.
        const blocked = detectBlocked(path.join(caseDir, "artifacts"), originOf(entryUrl));
        const status: CaseRunResult["status"] =
          blocked ? "blocked"
            : c.ir.meta.truncated && !c.ir.meta.hasTerminalAssertion ? "truncated_no_assertion"
              : c.ir.meta.truncated ? "truncated"
                : result.passed ? "passed" : "failed";

        results.push({
          caseId,
          title: c.title,
          status,
          blockedBy: blocked?.reason,
          blockedScreenshot: blocked?.screenshot ?? undefined,
          irPath,
          resultPath,
          expected: c.ir.meta.title,
          // No diagnosis and no self-heal on a replay: both call a model, and a replay that
          // quietly spent tokens to recover would defeat the one property this path exists for.
          // A failing replay reports the failure and the evidence, which is the honest outcome.
        });

        emit("suite", "completed", { caseId, title: c.title, status });
      } catch (err: any) {
        results.push({
          caseId, title: c.title, status: "failed",
          irPath: path.join(caseDir, "04-ir.json"),
          resultPath: path.join(caseDir, "05-result.json"),
        });
        emit("suite", "failed", { caseId, title: c.title }, err?.message ?? String(err));
      }
    }

    const summary = buildSuiteSummary(results, runDir);
    save("07-suite-summary.json", summary);
    emit("suite", "completed", { summary });

    // The proof. Written unconditionally so it can be inspected for any replay, ever.
    save("08-llm-usage.json", ZERO_USAGE);

    const shot = firstArtifactsDir ? findScreenshot(firstArtifactsDir) : null;
    const video = firstArtifactsDir ? findVideo(firstArtifactsDir) : null;
    const passedAll = results.length > 0 && results.every((r) => r.status === "passed");

    emit("done", "completed", {
      passed: passedAll,
      replay: true,
      screenshotUrl: shot ? "/" + path.relative(".", shot).replace(/\\/g, "/") : undefined,
      videoUrl: video ? "/" + path.relative(".", video).replace(/\\/g, "/") : undefined,
      test: { title: label, steps: [], expected: "" },
      suite: summary,
      llmUsage: ZERO_USAGE,
    });

    return { runId, runDir, results, summary };
  } catch (err: any) {
    try { save("08-llm-usage.json", ZERO_USAGE); } catch { /* best effort */ }
    emit("error", "failed", { llmUsage: ZERO_USAGE }, err?.message ?? String(err));
    throw err;
  }
}
