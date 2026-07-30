import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { plan } from "./stages/planner.js";
import { discover, discoverPages } from "./stages/hybridDiscovery.js";
import { toTestCases, generateCasesForNewPages } from "./stages/testCases.js";
import { toIR, type IRResult } from "./stages/ir.js";
import { GroqBudget } from "./llm/groqBudget.js";
import { refreshPageModel } from "./stages/liveExtend.js";
import {
  credentialsFor, credentialFieldsNeeded, promptCarriesCredentials, credentialEnvVars,
  type Credentials, type CredentialKind,
} from "./stages/credentials.js";
import { generateSpec } from "./stages/generator.js";
import { runSpec, findScreenshot } from "./stages/executor.js";
import { analyzeFailure } from "./stages/failureAnalysis.js";
import { runSuite, type PrimaryCaseResult } from "./stages/suiteRunner.js";
import { store } from "./runStore.js";
import { filterByScope, ALL_SCOPES } from "./kb/testStrategy.js";
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

export async function runPipeline(
  { prompt, url, urls, coverage }: { prompt: string; url?: string; urls?: string[]; coverage?: Coverage },
  onEvent: OnEvent = () => { },
  presetRunId?: string,
  askCredentials?: AskCredentials
) {
  // Normalize: single `url` becomes `urls: [url]`; both provided means `urls` wins.
  const resolvedUrls = urls?.length ? urls : url ? [url] : [];
  if (!resolvedUrls.length) throw new Error("Either url or urls must be provided");
  const runId = presetRunId ?? makeRunId();
  const runDir = path.join("runs", runId);
  mkdirSync(runDir, { recursive: true });

  // One budget per run, shared across the primary case, self-heal, and every suite case
  // below — never a module-level singleton (MAX_CONCURRENT_RUNS lets several runs share
  // one process).
  const groqBudget = new GroqBudget();

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
    save("00-input.json", { prompt, url: resolvedUrls[0], urls: resolvedUrls, coverage });
    emit("input", "completed", { prompt, url: resolvedUrls[0], urls: resolvedUrls, coverage });

    const thePlan = await step("plan", "01-plan.json", () => plan(prompt, resolvedUrls[0], coverage));

    const appModel = await step("discovery", "02-appmodel.json", async () =>
      resolvedUrls.length === 1 ? discover(resolvedUrls[0]) : discoverPages(resolvedUrls)
    );
    console.log("1. Discovery completed");

    console.log("2. Generating test cases...");
    const cases = await step("testcases", "03-cases.json", () => toTestCases(thePlan, appModel));
    console.log("✓ Test cases:", cases.length);

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
    let runCreds: Credentials | undefined = credentialsFor(resolvedUrls[0]);
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
    const { ir, updatedAppModel } = await step("ir", "04-ir.json", () => toIR(primary, appModel, prompt, resolvedUrls[0], groqBudget, runCreds));
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

    if (!result.passed) {
      diagnosis = await step("failure_analysis", "06-diagnosis.json", () => analyzeFailure(ir, result as any));

      const healable = diagnosis.category === "selector_changed" || diagnosis.category === "element_missing";
      const failIdx = diagnosis.failingStepId ? ir.steps.findIndex((s) => s.id === diagnosis!.failingStepId) : -1;

      // A step with no real prefix (first step, or an id toIR never emitted) has nothing to
      // replay from — skip healing. Capped at exactly one attempt total, no loop: this only
      // runs once, only on an already-failed run with a matching diagnosis category.
      if (healable && failIdx > 0) {
        try {
          emit("heal", "started");
          const prefix = ir.steps.slice(0, failIdx);
          const freshModel = await refreshPageModel(appModel, prefix, runCreds);
          console.log("Calling toIR (heal)...");
          const { ir: healedIr } = await toIR(primary, freshModel, prompt, resolvedUrls[0], groqBudget, runCreds);
          console.log("Returned from toIR (heal)");

          // A heal that truncates isn't a heal: it means the failing step still can't be
          // grounded even against a fresh snapshot (genuinely gone, not just renamed), and
          // toIR silently fell back to the safe prefix. Running just that prefix would
          // "pass" without ever exercising the thing that broke — a false positive of
          // exactly the kind this project has hit before. Only accept a heal that still
          // covers the full, originally-intended test case.
          if (!healedIr.meta.truncated) {
            const healedDir = path.join(runDir, "healed");
            mkdirSync(healedDir, { recursive: true });
            const healedSpec = generateSpec(healedIr, path.join(healedDir, "artifacts"));
            const healedRun = await runSpec(healedSpec, healedDir, credentialEnvVars(runCreds));
            if (healedRun.passed) {
              writeFileSync(path.join(healedDir, "generated.spec.ts"), healedSpec);
              writeFileSync(path.join(healedDir, "ir.json"), JSON.stringify(healedIr, null, 2));
              finalResult = {
                passed: true, exitCode: healedRun.exitCode,
                artifactsDir: healedRun.artifactsDir, resultsJsonPath: healedRun.resultsJsonPath, raw: healedRun.raw,
              };
              finalIr = healedIr;
              finalSpecCode = healedSpec;
              healed = true;
            }
          }
          emit("heal", "completed", { healed });
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
    if (newPages.length > 0) {
      emit("testcases", "started", { newPages: newPages.map(p => p.url) });
      const reactiveCases = await generateCasesForNewPages(updatedAppModel, resolvedUrls, thePlan, prompt);
      if (reactiveCases.length > 0) {
        allCases = [...allCases, ...reactiveCases];
        // Persist updated cases list
        save("03-cases.json", allCases);
        emit("testcases", "completed", { total: allCases.length, reactive: reactiveCases.length });
      }
    }

    const scopedCases = filterByScope(allCases, scope);
    const primaryCaseResult: PrimaryCaseResult = {
      testCase: primary,
      ir: finalIr,
      result: { passed: finalResult.passed, exitCode: finalResult.exitCode, artifactsDir: finalResult.artifactsDir, resultsJsonPath: finalResult.resultsJsonPath, raw: finalResult.raw },
      specCode: finalSpecCode,
      healed,
    };
    console.log("3. Running suite...");
    await runSuite(scopedCases, updatedAppModel, runDir, prompt, resolvedUrls[0], onEvent, primaryCaseResult, groqBudget, runCreds);
    console.log("✓ Suite finished");

    console.log("Pipeline finished");

    // Playwright captures a screenshot for every test (screenshot: "on" in the config), so
    // there's one on success too. Surface its public /runs URL to the UI. The IR may be a
    // truncated (partial) test — tell the UI so it can label the verdict honestly.
    const shot = findScreenshot(finalResult.artifactsDir);
    const screenshotUrl = shot ? "/" + path.relative(".", shot).replace(/\\/g, "/") : undefined;

    // Read suite summary if it exists (produced by runSuite)
    let suite = undefined;
    const summaryPath = path.join(runDir, "07-suite-summary.json");
    if (existsSync(summaryPath)) {
      try { suite = JSON.parse(readFileSync(summaryPath, "utf8")); } catch { }
    }

    // Real Groq spend for this run — visible on disk and in the completion event so a
    // regression (retry storm, model change) shows up immediately instead of being
    // discovered later via a drained account.
    const groqUsage = groqBudget.snapshot();
    save("08-groq-usage.json", groqUsage);

    emit("done", "completed", {
      passed: finalResult.passed, screenshotUrl, partial: finalIr.meta.truncated ?? false, healed,
      status: (finalResult as any).status,
      truncationNote: finalIr.meta.truncationNote,
      // Plain-English record of what was actually tested, for the results panel — the IR/spec
      // are role+name/code, not something an end user should have to read to know what ran.
      test: { title: primary.title, steps: primary.steps, expected: primary.expected },
      suite,
      groqUsage,
    });
    return { runId, runDir, result: finalResult, diagnosis };
  } catch (err: any) {
    // Failed/truncated runs are exactly the ones most likely to have burned the most
    // budget retrying — record usage here too instead of only on the happy path.
    const groqUsage = groqBudget.snapshot();
    try { save("08-groq-usage.json", groqUsage); } catch { }
    emit("error", "failed", { groqUsage }, err?.message ?? String(err));
    throw err;
  }
}

const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const byPriority = (a: { priority: string }, b: { priority: string }) => rank[a.priority] - rank[b.priority];

/** Shared run-id format so the server can generate one before starting the pipeline. */
export function makeRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
}
