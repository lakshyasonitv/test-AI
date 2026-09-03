import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { plan } from "./stages/planner.js";
import { discoverSiteHybrid, discoverPagesHybrid } from "./stages/hybridDiscovery.js";
import { toTestCases, generateCasesForNewPages, finalizeCaseSelection, budgetFor } from "./stages/testCases.js";
import { toIR, type IRResult } from "./stages/ir.js";
import { LlmBudget, enterWithBudget } from "./llm/llmBudget.js";
import {
  credentialFieldsNeeded, promptCarriesCredentials, credentialEnvVars, redactCredentials,
  extractCredentialsFromPrompt,
  type Credentials, type CredentialKind,
} from "./stages/credentials.js";
import { generateSpec } from "./stages/generator.js";
import { runSpec, findScreenshot, findVideo, detectBlocked } from "./stages/executor.js";
import { analyzeFailure } from "./stages/failureAnalysis.js";
import { attemptHeal, isHealable } from "./stages/heal.js";
import { runSuite, type PrimaryCaseResult } from "./stages/suiteRunner.js";
import { store } from "./runStore.js";
import { ALL_SCOPES } from "./kb/testStrategy.js";
import type { IR, Step } from "./schema/ir.js";

export type StageName =
  | "input" | "plan" | "discovery" | "testcases" | "credentials" | "ir"
  | "generate" | "execute" | "failure_analysis" | "heal"
  | "suite" | "done" | "error";

export interface StageEvent {
  runId: string;
  stage: StageName;
  status: "started" | "completed" | "failed";
  data?: unknown;
  error?: string;
  ts: number;
}

export type OnEvent = (e: StageEvent) => void;

/** What the pipeline needs from whoever is driving it when a run hits a login it has no
 *  credentials for. Resolve with the values, or null to carry on without them. The server
 *  backs this with a UI prompt; the CLI passes nothing, so a CLI run never blocks. */
export interface CredentialRequest {
  runId: string;
  url: string;
  fields: CredentialKind[];
}
export type AskCredentials = (req: CredentialRequest) => Promise<Credentials | null>;

export type Coverage = "minimal" | "standard" | "full";

/**
 * Per-run overrides for behaviour that is otherwise env-configured. The UI has a
 * Settings popover for these two; a toggle that did not actually reach the
 * pipeline would be a decorative control, so it reaches it. Both default to the
 * existing env behaviour when a caller omits them (the CLI does).
 */
export interface RunOptions {
  /** Pause after generating cases so a human can accept/reject them. */
  gateReview?: boolean;
  /** Allow one re-snapshot + regenerate + re-run on a selector-drift failure. */
  selfHeal?: boolean;
}

export async function runPipeline(
  { prompt, url, urls, coverage, options }: { prompt: string; url?: string; urls?: string[]; coverage?: Coverage; options?: RunOptions },
  onEvent: OnEvent = () => { },
  presetRunId?: string,
  askCredentials?: AskCredentials
) {
  // Normalize: single `url` becomes `urls: [url]`; both provided means `urls` wins.
  const resolvedUrls = urls?.length ? urls : url ? [url] : [];
  if (!resolvedUrls.length) throw new Error("Either url or urls must be provided");
  const selfHealEnabled = options?.selfHeal ?? true;
  const runId = presetRunId ?? makeRunId();
  const runDir = path.join("runs", runId);
  mkdirSync(runDir, { recursive: true });

  // One budget per run, shared across every LLM-calling stage (plan, discovery, test-case
  // generation, IR, failure diagnosis, self-heal, and every suite case) — never a
  // module-level singleton (MAX_CONCURRENT_RUNS lets several runs share one process).
  const llmBudget = new LlmBudget();
  // Makes llmBudget ambiently available to every gemini() call for the rest of this run,
  // however many layers deep (discovery's labelConceptsWithDOM in particular) — see
  // llmBudget.ts's own doc comment for why this is `enterWith`, not a wrapping callback, and
  // why it's still safe across MAX_CONCURRENT_RUNS. ir.ts/heal.ts/suiteRunner.ts still take
  // `llmBudget` as an explicit parameter below — this is additive, not a replacement.
  enterWithBudget(llmBudget);

  const save = (name: string, data: unknown) =>
    writeFileSync(path.join(runDir, name), JSON.stringify(data, null, 2));

  const emit = (stage: StageName, status: StageEvent["status"], data?: unknown, error?: string) => {
    const event: StageEvent = { runId, stage, status, data, error, ts: Date.now() };
    store.append(event); // durable log first, so a crash mid-callback still records the event
    onEvent(event);
  };

  /** Wrap a stage: emit started -> run -> save -> emit completed (or failed). */
  async function step<T>(stage: StageName, filename: string | null, fn: () => Promise<T>): Promise<T> {
    emit(stage, "started");
    try {
      const result = await fn();
      if (filename) save(filename, result);
      emit(stage, "completed", result);
      return result;
    } catch (err: any) {
      emit(stage, "failed", undefined, err?.message ?? String(err));
      throw err;
    }
  }

  try {
    // Credentials the user typed into the prompt are real credentials. 00-input.json lives under
    // runs/, which the server exposes as static files (TD-14) — writing the prompt verbatim put
    // plaintext passwords on a public path. The redacted copy goes to disk and to the event; the
    // original stays in memory for the stages that need it.
    const promptCreds = extractCredentialsFromPrompt(prompt);
    const safePrompt = redactCredentials(prompt, promptCreds);
    save("00-input.json", { prompt: safePrompt, url: resolvedUrls[0], urls: resolvedUrls, coverage });
    emit("input", "completed", { prompt: safePrompt, url: resolvedUrls[0], urls: resolvedUrls, coverage });

    const thePlan = await step("plan", "01-plan.json", () => plan(prompt, resolvedUrls[0], coverage));

    // Discovery needs credentials BEFORE it crawls: an app behind a login is otherwise modelled
    // as its own login page and every generated case becomes a login case. The prompt is one
    // source; the other is asking the user, which discovery triggers itself the moment it finds
    // a real password field. That ask cannot live where the one below does — that one is driven
    // by credentialFieldsNeeded(appModel, cases), which needs discovery's own output.
    //
    // Pre-bound because discoverSiteHybrid has neither runId nor the CredentialRequest shape.
    //
    // The emit pair is NOT optional. askCredentials only parks a promise server-side; it is the
    // `credentials`/`started` EVENT that makes the frontend render the form (app.js ->
    // showCredentialPrompt). Calling askCredentials without emitting leaves the run parked for
    // the full CREDENTIAL_WAIT_MS against a UI that never offered anywhere to type — which is
    // exactly what "stuck on asking for credentials, but there is no option to provide them"
    // looks like. `completed` clears the form again, on every path including a skip.
    let discoveredCreds: Credentials | undefined = promptCreds;
    const askForDiscovery = askCredentials
      ? async (): Promise<Credentials | null> => {
        const fields: CredentialKind[] = ["username", "password"];
        emit("credentials", "started", { fields, url: resolvedUrls[0] });
        // Never emitted, never saved: the answer would land in events.ndjson and 00-input.json,
        // both under runs/, which the server serves as static files.
        const supplied = await askCredentials({ runId, url: resolvedUrls[0], fields });
        emit("credentials", "completed", { provided: !!supplied });
        discoveredCreds = supplied ?? undefined;
        return supplied;
      }
      : undefined;

    const appModel = await step("discovery", "02-appmodel.json", async () =>
      resolvedUrls.length === 1
        ? discoverSiteHybrid(resolvedUrls[0], promptCreds, askForDiscovery)
        : discoverPagesHybrid(resolvedUrls)
    );
    console.log("1. Discovery completed");
    if (appModel.auth) {
      console.log(`[orchestrator] discovery auth outcome: ${appModel.auth.status}${appModel.auth.detail ? ` — ${appModel.auth.detail}` : ""}`);
    }

    console.log("2. Generating test cases...");
    // The case-selection gate pauses here: it generates a batch, parks the run on a selection
    // prompt, and regenerates on "not satisfied" — while the flag is off or no interactive
    // responder is supplied (CLI mode), the gate is never even imported.
    // A per-run override wins over the env default; omitted, the env decides as before.
    // The interactive-responder check is not overridable — with no way to answer, the gate
    // would park the run until CASE_SELECTION_WAIT_MS expires with nothing to show for it.
    const gateRequested = options?.gateReview ?? (process.env.ENABLE_CASE_SELECTION_GATE === "true");
    const gateUsed = gateRequested && !!askCredentials;
    const cases = await step("testcases", "03-cases.json", async () => {
      if (gateUsed) {
        const { runCaseSelectionGate } = await import("./stages/caseSelectionGate.js");
        const { finalCases } = await runCaseSelectionGate({ runId, plan: thePlan, appModel, sourcePrompt: prompt });
        return finalCases;
      }
      return toTestCases(thePlan, appModel, undefined, { sourcePrompt: prompt });
    });
    console.log("✓ Test cases:", cases.length);

    // The case-selection gate can legitimately end with nothing accepted (a round timed out on
    // CASE_SELECTION_WAIT_MS before anything was ever picked) — a clean, honest outcome, not a
    // pipeline error. Report it and stop here rather than cascading into "No test cases
    // produced" a few lines below, which would surface as a scary generic crash instead of
    // "nothing was selected."
    if (cases.length === 0) {
      const llmUsage = llmBudget.snapshot();
      save("08-llm-usage.json", llmUsage);
      emit("done", "completed", {
        passed: false,
        status: "no_cases_selected",
        llmUsage,
      });
      return { runId, runDir, result: null, diagnosis: null };
    }

    // Prefer the case tagged as the direct translation of the user's own request over pure
    // severity ranking — "priority" orders coverage cases for an eventual multi-case run, but
    // at a single execution slot the highest-severity taxonomy case (e.g. SQL injection,
    // always "critical") was silently outranking and replacing whatever the user actually
    // asked to test. Fall back to priority if the model didn't tag one (never crash on it).
    const primary = cases.find((c) => c.fromPrompt) ?? [...cases].sort(byPriority)[0];
    if (!primary) throw new Error("No test cases produced");

    // Pause for credentials — once per run, here, because this is the first point where both
    // halves of the question are known: what the site looks like (discovery) and what the
    // tests intend to do (cases). Everything downstream that needs a real login (toIR's
    // live-extend replay, the generated spec, every suite case) is still ahead of us.
    //
    // Only asks when it genuinely can't proceed: no built-in demo account for this host, the
    // prompt didn't already carry credentials, and a login is actually in scope. Anything
    // else would interrupt the user for nothing. A caller with no askCredentials (the CLI)
    // never blocks at all.
    // Whatever discovery ended up with — from the prompt, or from the ask it triggered itself.
    // Carrying it here is what stops the user being prompted a second time: the guard below is
    // `!runCreds`, so a credential already supplied during discovery suppresses the ask.
    let runCreds: Credentials | undefined = discoveredCreds;
    if (askCredentials && !runCreds && !promptCarriesCredentials(prompt)) {
      const fields = credentialFieldsNeeded(appModel, cases);
      if (fields.length) {
        emit("credentials", "started", { fields, url: resolvedUrls[0] });
        // Never emitted, never saved: the answer would land in events.ndjson and 00-input.json,
        // both under runs/, which the server serves as static files.
        const supplied = await askCredentials({ runId, url: resolvedUrls[0], fields });
        runCreds = supplied ?? undefined;
        emit("credentials", "completed", { provided: !!runCreds });
      }
    }

    console.log("Generating IR for primary case:", primary.title);
    const { ir, updatedAppModel } = await step("ir", "04-ir.json", () => toIR(primary, appModel, prompt, resolvedUrls[0], llmBudget, runCreds));
    console.log("IR generated");

    console.log("Generating spec...");
    // Per-step screenshots must land inside THIS run's directory. A shared relative path
    // meant concurrent runs overwrote each other's step images.
    const stepShots = path.join(runDir, "artifacts");
    const spec = await step("generate", null, async () => generateSpec(ir, stepShots));
    console.log("Spec generated");
    writeFileSync(path.join(runDir, "generated.spec.ts"), spec);

    let finalSpecCode = spec;

    console.log("Running Playwright for primary case...");
    const result = await step("execute", "05-result.json", async () => {
      const r = await runSpec(spec, runDir, credentialEnvVars(runCreds));
      return { passed: r.passed, exitCode: r.exitCode, artifactsDir: r.artifactsDir, resultsJsonPath: r.resultsJsonPath, raw: r.raw };
    });
    console.log("Playwright finished:", result.passed ? "PASSED" : "FAILED");

    // A truncated IR whose surviving prefix has no terminal assertion cannot report
    // "passed" — the dropped tail may have contained the only assertion, so Playwright's
    // passing verdict is a false positive. This check is independent of the real-failure
    // diagnosis path below (which only triggers on actual Playwright failures).
    const truncatedNoAssertion = !!(ir.meta.truncated && !ir.meta.hasTerminalAssertion);

    let diagnosis = null;
    let finalResult = result;
    let finalIr = ir;
    let healed = false;
    let deterministicHeal = false;

    if (!result.passed) {
      diagnosis = await step("failure_analysis", "06-diagnosis.json", () => analyzeFailure(ir, result as any, appModel.auth?.loginUrl));

      // Capped at exactly one attempt total, no loop: attemptHeal only runs once, only on an
      // already-failed run with a matching diagnosis category. Logic lives in stages/heal.ts —
      // shared with suiteRunner.ts's non-primary cases, see that module's own doc comment.
      // isHealable is the same gate attemptHeal applies internally — checked here too only so
      // "heal started" isn't emitted for a category that was never going to attempt anything.
      if (selfHealEnabled && isHealable(diagnosis, ir)) {
        try {
          emit("heal", "started");
          const healedOutcome = await attemptHeal({
            testCase: primary, ir, appModel, diagnosis,
            sourcePrompt: prompt, entryUrl: resolvedUrls[0], llmBudget, runCreds,
            outDir: runDir,
          });
          if (healedOutcome) {
            finalResult = {
              passed: true, exitCode: healedOutcome.result.exitCode,
              artifactsDir: healedOutcome.result.artifactsDir, resultsJsonPath: healedOutcome.result.resultsJsonPath,
              raw: healedOutcome.result.raw,
            };
            finalIr = healedOutcome.ir;
            finalSpecCode = healedOutcome.specCode;
            healed = true;
            deterministicHeal = healedOutcome.deterministic === true;
          }
          emit("heal", "completed", { healed, deterministicHeal });
        } catch (err: any) {
          // Original diagnosis stands unchanged — a failed heal attempt never masks the
          // real failure with a different error, and never retries.
          emit("heal", "failed", undefined, err?.message ?? String(err));
        }
      }
    }

    // If the IR was truncated without a terminal assertion, override the result to
    // prevent a false pass. The diagnosis/heal path above is for real Playwright failures;
    // this handles the case where Playwright itself passed but the test verified nothing.
    if (truncatedNoAssertion && !healed) {
      finalResult = { ...result, passed: false, status: "truncated_no_assertion" } as typeof finalResult;
      save("05-result.json", finalResult);
    }

    // Run every case in the suite through the full per-case pipeline, persisting per-case
    // artifacts under cases/<caseId>/. The primary case was already executed above (and may
    // have been self-healed) — pass its result so runSuite reuses it instead of re-running.
    const scope = (thePlan.testTypeScope ?? ALL_SCOPES) as typeof ALL_SCOPES;

    // Check if primary-case execution discovered new pages via live-extend
    const originalUrlsSet = new Set(resolvedUrls);
    const newPages = updatedAppModel.pages.filter(page => !originalUrlsSet.has(page.url));

    // Merge upfront cases with any reactive cases generated for new pages
    let allCases = [...cases];
    let reactiveCount = 0;
    if (newPages.length > 0) {
      emit("testcases", "started", { newPages: newPages.map(p => p.url) });
      const reactiveCases = await generateCasesForNewPages(
        updatedAppModel, resolvedUrls, thePlan, prompt, cases.map(c => c.title));
      if (reactiveCases.length > 0) {
        if (gateUsed) {
          // The gate's whole premise is "nothing runs without being shown to you first" — that
          // has to hold for reactive cases too, not just the upfront batch. Offer them as one
          // more review round instead of silently merging them into what's already final.
          const { runReactiveCaseRound } = await import("./stages/caseSelectionGate.js");
          const accepted = await runReactiveCaseRound(runId, reactiveCases);
          allCases = [...allCases, ...accepted];
          reactiveCount = accepted.length;
        } else {
          allCases = [...allCases, ...reactiveCases];
          reactiveCount = reactiveCases.length;
        }
      }
    }

    // Single selection authority over the merged list — see finalizeCaseSelection's own doc
    // comment for why this branches on gateUsed.
    const scopedCases = finalizeCaseSelection(allCases, scope, thePlan.coverage, gateUsed, appModel.auth?.loginUrl);
    console.log(`Cases: ${allCases.length} generated -> ${scopedCases.length} selected`,
      scopedCases.map(c => `${c.category}:${c.title}`));
    save("03-cases.json", scopedCases);

    // Announce the counts only AFTER selection. Emitting them before meant the UI reported
    // "Generated 15 test scenarios" and then ran 4, with nothing connecting the two numbers.
    emit("testcases", "completed", {
      generated: allCases.length,
      reactive: reactiveCount,
      selected: scopedCases.length,
      budget: budgetFor(thePlan.coverage),
      // Kept so anything reading the old shape still sees a sane count — but it is now the
      // number that actually RUNS, which is what "total" should always have meant here.
      total: scopedCases.length,
    });
    const primaryCaseResult: PrimaryCaseResult = {
      testCase: primary,
      ir: finalIr,
      result: { passed: finalResult.passed, exitCode: finalResult.exitCode, artifactsDir: finalResult.artifactsDir, resultsJsonPath: finalResult.resultsJsonPath, raw: finalResult.raw },
      specCode: finalSpecCode,
      healed,
      ...(deterministicHeal ? { deterministicHeal: true } : {}),
    };
    console.log("3. Running suite...");
    await runSuite(scopedCases, updatedAppModel, runDir, prompt, resolvedUrls[0], onEvent, primaryCaseResult, llmBudget, runCreds, selfHealEnabled);
    console.log("✓ Suite finished");

    console.log("Pipeline finished");

    // Playwright captures a screenshot for every test (screenshot: "on" in the config), so
    // there's one on success too. Surface its public /runs URL to the UI. The IR may be a
    // truncated (partial) test — tell the UI so it can label the verdict honestly.
    const shot = findScreenshot(finalResult.artifactsDir);
    const screenshotUrl = shot ? "/" + path.relative(".", shot).replace(/\\/g, "/") : undefined;

    // video: "retain-on-failure" in playwright.config.ts — a video only exists for a run that
    // actually failed, so check the ORIGINAL attempt's directory (`result`, not `finalResult`):
    // a heal only "counts" once its retry passes, and a passing Playwright run never keeps one.
    const video = findVideo(result.artifactsDir);
    const videoUrl = video ? "/" + path.relative(".", video).replace(/\\/g, "/") : undefined;

    // Read suite summary if it exists (produced by runSuite)
    let suite = undefined;
    const summaryPath = path.join(runDir, "07-suite-summary.json");
    if (existsSync(summaryPath)) {
      try { suite = JSON.parse(readFileSync(summaryPath, "utf8")); } catch { }
    }

    // Real LLM spend for this run, across every stage — visible on disk and in the completion
    // event so a regression (retry storm, model change) shows up immediately instead of being
    // discovered later via a drained account.
    const llmUsage = llmBudget.snapshot();
    save("08-llm-usage.json", llmUsage);

    // Did the primary case end at a wall automation can't pass? That outranks pass/fail: the
    // app isn't broken and the test didn't succeed, and the user needs to see the proof frame.
    const blocked = detectBlocked(path.join(runDir, "artifacts"), originOf(resolvedUrls[0]));
    const blockedScreenshotUrl = blocked?.screenshot
      ? "/" + path.relative(".", blocked.screenshot).replace(/\\/g, "/")
      : undefined;

    emit("done", "completed", {
      passed: blocked ? false : finalResult.passed,
      screenshotUrl: blockedScreenshotUrl ?? screenshotUrl,
      videoUrl,
      partial: finalIr.meta.truncated ?? false, healed,
      deterministicHeal,
      status: blocked ? "blocked" : (finalResult as any).status,
      blockedBy: blocked?.reason,
      truncationNote: finalIr.meta.truncationNote,
      // Plain-English record of what was actually tested, for the results panel — the IR/spec
      // are role+name/code, not something an end user should have to read to know what ran.
      test: { title: primary.title, steps: primary.steps, expected: primary.expected },
      ir: finalIr,
      suite,
      llmUsage,
    });
    return { runId, runDir, result: finalResult, diagnosis };
  } catch (err: any) {
    // Failed/truncated runs are exactly the ones most likely to have burned the most
    // budget retrying — record usage here too instead of only on the happy path.
    const llmUsage = llmBudget.snapshot();
    try { save("08-llm-usage.json", llmUsage); } catch { }
    emit("error", "failed", { llmUsage }, err?.message ?? String(err));
    throw err;
  }
}

const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const byPriority = (a: { priority: string }, b: { priority: string }) => rank[a.priority] - rank[b.priority];

/** Shared run-id format so the server can generate one before starting the pipeline. */
/** Origin of a url, for deciding whether a flow left the application. */
function originOf(url: string): string | undefined {
  try { return new URL(url).origin; } catch { return undefined; }
}

export function makeRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
}
