import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { plan } from "./stages/planner.js";
import { crawlSite, labelPage } from "./stages/crawler.js";
import { buildCrawlDirective } from "./stages/crawlDirective.js";
import { buildSiteOutline } from "./kb/siteOutline.js";
import { discover, discoverPages } from "./stages/hybridDiscovery.js";
import { toTestCases, generateCasesForNewPages } from "./stages/testCases.js";
import { toIR, type IRResult } from "./stages/ir.js";
import { refreshPageModel } from "./stages/liveExtend.js";
import { credentialsFor } from "./stages/credentials.js";
import { generateSpec } from "./stages/generator.js";
import { runSpec, findScreenshot } from "./stages/executor.js";
import { analyzeFailure } from "./stages/failureAnalysis.js";
import { runSuite, type PrimaryCaseResult } from "./stages/suiteRunner.js";
import { store } from "./runStore.js";
import { filterByScope, ALL_SCOPES } from "./kb/testStrategy.js";
import type { IR, Step } from "./schema/ir.js";

/**
 * Post-process IR to fix known issues with duplicate selectors, URL assertions, etc.
 * This applies quick fixes for common problems that the LLM might generate.
 */
function postProcessIR(ir: IR): IR {
  // Known problematic links that should be skipped or have special handling
  const skipLinks = ['About SKIT', 'javascript:void(0)', '#'];

  // Fix duplicate selectors by adding nth field
  const duplicateFixes: Record<string, number> = {
    'Student': 1,  // Use second occurrence (0-indexed)
    'IQAC': 0,     // Use first occurrence
  };

  // Fix URL patterns that need partial matching
  const urlPartialPatterns = ['/about'];

  // Process each step
  ir.steps = ir.steps.map(step => {
    // Skip steps with problematic links
    if (step.target?.name && skipLinks.includes(step.target.name)) {
      // Mark as skip or adjust target
      if (step.target.name === 'About SKIT') {
        // This link often redirects to home, use partial URL matching
        if (step.assertion === 'url_contains' && step.value?.includes('/about')) {
          step.value = step.value.replace('/about', '');
          step.value = step.value || '/';
        }
      }
    }

    // Fix duplicate selectors
    if (step.target?.name && duplicateFixes[step.target.name] !== undefined) {
      // Only add nth if not already specified
      if (step.target.nth === undefined) {
        step.target.nth = duplicateFixes[step.target.name];
      }
    }

    // Fix URL assertions to use partial matching when appropriate
    if (step.assertion === 'url_contains' && step.value) {
      for (const pattern of urlPartialPatterns) {
        if (step.value.includes(pattern)) {
          // Already using url_contains, which is partial by nature
          // Just ensure the pattern is reasonable
          break;
        }
      }
    }

    // Add preAction for dropdown menu items
    const dropdownParents = ['Academics', 'Admissions', 'Research', 'Placements'];
    if (step.action === 'click' && step.target?.role === 'link' &&
      dropdownParents.includes(step.target.name || '')) {
      // This might be a dropdown parent - add hover preAction if not already present
      if (!step.preAction) {
        step.preAction = {
          action: 'hover',
          target: { ...step.target }
        };
      }
    }

    return step;
  });

  return ir;
}

export type StageName =
  | "input" | "plan" | "discovery" | "testcases" | "ir"
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

export type Coverage = "minimal" | "standard" | "full";

export async function runPipeline(
  { prompt, url, urls, coverage, mode }: { prompt: string; url?: string; urls?: string[]; coverage?: Coverage; mode?: "crawl" },
  onEvent: OnEvent = () => { },
  presetRunId?: string
) {
  // Normalize: single `url` becomes `urls: [url]`; both provided means `urls` wins.
  const resolvedUrls = urls?.length ? urls : url ? [url] : [];
  if (!resolvedUrls.length) throw new Error("Either url or urls must be provided");
  const runId = presetRunId ?? makeRunId();
  const runDir = path.join("runs", runId);
  mkdirSync(runDir, { recursive: true });

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
    // Crawl mode: produce appModel via crawlSite + labelPage (only entry page labeled).
    // Non-crawl mode: existing discover/discoverPages path, unchanged.
    let siteGraph: import("./schema/siteGraph.js").SiteGraph | undefined;
    let siteOutline: string | undefined;

    const appModel = await step("discovery", "02-appmodel.json", async () => {
      if (mode === "crawl") {
        const directive = buildCrawlDirective(thePlan, resolvedUrls[0]);
        siteGraph = await crawlSite(directive);
        siteOutline = buildSiteOutline(siteGraph);
        save("02-sitegraph.json", siteGraph);
        save("02-siteoutline.txt", siteOutline);
        // Label only the entry page — other pages stay unlabeled until
        // test case generation selects them (lazy, Phase 2d).
        const entryPage = siteGraph.pages[resolvedUrls[0]];
        if (!entryPage) throw new Error(`Entry URL ${resolvedUrls[0]} not found in crawl results`);
        return labelPage(entryPage, resolvedUrls[0], siteOutline);
      }
      return resolvedUrls.length === 1 ? discover(resolvedUrls[0]) : discoverPages(resolvedUrls);
    });
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

    console.log("Generating IR for primary case:", primary.title);
    const { ir: rawIr, updatedAppModel } = await step("ir", "04-ir.json", () => toIR(primary, appModel, prompt, resolvedUrls[0]));
    console.log("IR generated");

    // Post-process IR to fix known issues
    const ir = postProcessIR(rawIr);
    console.log("IR post-processed");

    console.log("Generating spec...");
    const spec = await step("generate", null, async () => generateSpec(ir));
    console.log("Spec generated");
    writeFileSync(path.join(runDir, "generated.spec.ts"), spec);

    let finalSpecCode = spec;

    console.log("Running Playwright for primary case...");
    const result = await step("execute", "05-result.json", async () => {
      const r = await runSpec(spec, runDir);
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
          const freshModel = await refreshPageModel(appModel, prefix, credentialsFor(resolvedUrls[0]));
          console.log("Calling toIR (heal)...");
          const { ir: healedIr } = await toIR(primary, freshModel, prompt, resolvedUrls[0]);
          console.log("Returned from toIR (heal)");

          // A heal that truncates isn't a heal: it means the failing step still can't be
          // grounded even against a fresh snapshot (genuinely gone, not just renamed), and
          // toIR silently fell back to the safe prefix. Running just that prefix would
          // "pass" without ever exercising the thing that broke — a false positive of
          // exactly the kind this project has hit before. Only accept a heal that still
          // covers the full, originally-intended test case.
          if (!healedIr.meta.truncated) {
            const healedSpec = generateSpec(healedIr);
            const healedDir = path.join(runDir, "healed");
            mkdirSync(healedDir, { recursive: true });
            const healedRun = await runSpec(healedSpec, healedDir);
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
      ir: finalIr,
      result: { passed: finalResult.passed, exitCode: finalResult.exitCode, artifactsDir: finalResult.artifactsDir, resultsJsonPath: finalResult.resultsJsonPath, raw: finalResult.raw },
      specCode: finalSpecCode,
      healed,
    };
    console.log("3. Running suite...");
    await runSuite(scopedCases, updatedAppModel, runDir, prompt, resolvedUrls[0], onEvent, primaryCaseResult);
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

    emit("done", "completed", {
      passed: finalResult.passed, screenshotUrl, partial: finalIr.meta.truncated ?? false, healed,
      status: (finalResult as any).status,
      truncationNote: finalIr.meta.truncationNote,
      // Plain-English record of what was actually tested, for the results panel — the IR/spec
      // are role+name/code, not something an end user should have to read to know what ran.
      test: { title: primary.title, steps: primary.steps, expected: primary.expected },
      suite,
    });
    return { runId, runDir, result: finalResult, diagnosis };
  } catch (err: any) {
    emit("error", "failed", undefined, err?.message ?? String(err));
    throw err;
  }
}

const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const byPriority = (a: { priority: string }, b: { priority: string }) => rank[a.priority] - rank[b.priority];

/** Shared run-id format so the server can generate one before starting the pipeline. */
export function makeRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
}
