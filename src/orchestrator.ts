import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { plan, type Plan } from "./stages/planner.js";
import { discover, discoverPages } from "./stages/discovery.js";
import { crawlSite, labelPage } from "./stages/crawler.js";
import { buildCrawlDirective } from "./stages/crawlDirective.js";
import { buildSiteOutline } from "./kb/siteOutline.js";
import { toTestCases, generateCasesForNewPages, type TestCase } from "./stages/testCases.js";
import { toIR } from "./stages/ir.js";
import { refreshPageModel } from "./stages/liveExtend.js";
import { credentialsFor, type Credentials } from "./stages/credentials.js";
import { generateSpec } from "./stages/generator.js";
import { runSpec, findScreenshot } from "./stages/executor.js";
import { analyzeFailure } from "./stages/failureAnalysis.js";
import { runSuite, type PrimaryCaseResult } from "./stages/suiteRunner.js";
import { store } from "./runStore.js";
import { filterByScope, ALL_SCOPES } from "./kb/testStrategy.js";
import type { AppModel } from "./schema/appModel.js";

export type StageName =
  | "input" | "plan" | "discovery" | "testcases" | "ir"
  | "generate" | "execute" | "failure_analysis" | "heal"
  | "suite" | "done" | "error"
  | "needs_input";

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

interface RunContext {
  runId: string;
  runDir: string;
  onEvent: OnEvent;
  save: (name: string, data: unknown) => void;
  emit: (stage: StageName, status: StageEvent["status"], data?: unknown, error?: string) => void;
  step: <T>(stage: StageName, filename: string | null, fn: () => Promise<T>) => Promise<T>;
}

function makeContext(runId: string, onEvent: OnEvent): RunContext {
  const runDir = path.join("runs", runId);
  mkdirSync(runDir, { recursive: true });

  const save = (name: string, data: unknown) =>
    writeFileSync(path.join(runDir, name), JSON.stringify(data, null, 2));

  const emit = (stage: StageName, status: StageEvent["status"], data?: unknown, error?: string) => {
    const event: StageEvent = { runId, stage, status, data, error, ts: Date.now() };
    store.append(event);
    onEvent(event);
  };

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

  return { runId, runDir, onEvent, save, emit, step };
}

/**
 * Classify whether a discovered page needs login or signup data — based on the actual
 * FIELDS present, not the page's free-text "concept" label. Concepts come from an LLM
 * (see discovery.ts's labelConcepts) and are unpredictable ("Login", "Authentication",
 * "Account Access", "Member Sign In", ...) — regex-matching that label is a losing game
 * of whack-a-mole. A password-shaped textbox is a hard, unambiguous signal regardless of
 * what the page happens to be labeled: any page with one needs credentials to fill it.
 *
 * "login" vs "signup" is distinguished by the presence of a confirm-password field — the
 * same signal credentials.ts's credentialForTarget already uses for substitution, so
 * detection and substitution now agree on one rule instead of two independent ones.
 */
function classifyAuthNeed(appModel: AppModel): "login" | "signup" | null {
  const textboxes = appModel.pages.flatMap(p => p.elements).filter(e => e.role === "textbox");

  const looksLikePassword = (e: { name?: string; containerName?: string }) => {
    const name = (e.name ?? "").toLowerCase();
    const container = (e.containerName ?? "").toLowerCase();
    if (/pass(word)?|pwd/.test(name) || /pass(word)?|pwd/.test(container)) return true;
    // Masked placeholder heuristic: password-type inputs with no real label often get
    // their displayed dot/asterisk mask captured as "name" by discovery instead of a
    // semantic label (seen in practice: name === "*********").
    if (/^[*•●]{4,}$/.test(e.name ?? "")) return true;
    return false;
  };

  const hasPasswordField = textboxes.some(looksLikePassword);
  if (!hasPasswordField) return null;

  const hasConfirmPasswordField = textboxes.some(e => {
    const name = (e.name ?? "").toLowerCase();
    const container = (e.containerName ?? "").toLowerCase();
    return /confirm/.test(name + " " + container) && looksLikePassword(e);
  });
  return hasConfirmPasswordField ? "signup" : "login";
}

function requiredFieldsFor(authType: "login" | "signup"): string[] {
  return authType === "signup"
    ? ["username", "password", "confirmPassword"]
    : ["username_or_email", "password"];
}

export async function runPipeline(
  { prompt, url, urls, coverage, mode, credentials }:
    { prompt: string; url?: string; urls?: string[]; coverage?: Coverage; mode?: "crawl"; credentials?: Credentials },
  onEvent: OnEvent = () => {},
  presetRunId?: string
) {
  const resolvedUrls = urls?.length ? urls : url ? [url] : [];
  if (!resolvedUrls.length) throw new Error("Either url or urls must be provided");
  const runId = presetRunId ?? makeRunId();
  const ctx = makeContext(runId, onEvent);
  const { save, emit, step, runDir } = ctx;

  try {
    save("00-input.json", { prompt, url: resolvedUrls[0], urls: resolvedUrls, coverage, mode });
    emit("input", "completed", { prompt, url: resolvedUrls[0], urls: resolvedUrls, coverage });

    const thePlan = await step("plan", "01-plan.json", () => plan(prompt, resolvedUrls[0], coverage));

    let siteGraph: import("./schema/siteGraph.js").SiteGraph | undefined;
    let siteOutline: string | undefined;

    const appModel = await step("discovery", "02-appmodel.json", async () => {
      if (mode === "crawl") {
        const directive = buildCrawlDirective(thePlan, resolvedUrls[0]);
        siteGraph = await crawlSite(directive);
        siteOutline = buildSiteOutline(siteGraph);
        save("02-sitegraph.json", siteGraph);
        save("02-siteoutline.txt", siteOutline);
        const entryPage = siteGraph.pages[resolvedUrls[0]];
        if (!entryPage) throw new Error(`Entry URL ${resolvedUrls[0]} not found in crawl results`);
        return labelPage(entryPage, resolvedUrls[0], siteOutline);
      }
      return resolvedUrls.length === 1 ? discover(resolvedUrls[0]) : discoverPages(resolvedUrls);
    });

    // ---------------------------------------------------------------------
    // CHECKPOINT 1: does the ENTRY page itself have a password field we
    // have no credentials for? Cheap — catches the common case (login IS
    // the entry page) before spending an LLM call on test-case generation.
    // Does NOT catch "homepage -> click Login -> real login page", since
    // that page hasn't been discovered yet at this point — checkpoint 2
    // (below, after toIR) handles that case once live-extend has reached it.
    // ---------------------------------------------------------------------
    const authNeed1 = classifyAuthNeed(appModel);
    const creds = credentials ?? credentialsFor(resolvedUrls[0]);
    if (authNeed1 && !creds) {
      emit("needs_input", "completed", {
        reason: authNeed1 === "signup"
          ? "This page requires signup details, and none were provided."
          : "This site requires login credentials, and none are on file for this URL.",
        requiredFields: requiredFieldsFor(authNeed1),
        authType: authNeed1,
        url: resolvedUrls[0],
      });
      return { runId, runDir, status: "needs_input" as const, authType: authNeed1 };
    }

    return await continuePipeline(ctx, { prompt, resolvedUrls, thePlan, appModel, credentials: creds });
  } catch (err: any) {
    emit("error", "failed", undefined, err?.message ?? String(err));
    throw err;
  }
}

/**
 * Resume a paused run. Two possible pause points, distinguished by whether
 * 03-cases.json already exists on disk:
 *   - Missing  -> paused at checkpoint 1 (before testCases ran). Resume via
 *                 continuePipeline, which regenerates cases then proceeds.
 *   - Present  -> paused at checkpoint 2 (during/after IR generation, once
 *                 live-extend reached the real login/signup page). Cases
 *                 were already generated and saved — skip straight to
 *                 runFromIR with the now-provided credentials.
 */
export async function resumePipeline(
  runId: string,
  credentials: Credentials,
  onEvent: OnEvent = () => {}
) {
  const runDir = path.join("runs", runId);
  const inputPath = path.join(runDir, "00-input.json");
  const planPath = path.join(runDir, "01-plan.json");
  const appModelPath = path.join(runDir, "02-appmodel.json");
  const casesPath = path.join(runDir, "03-cases.json");

  if (!existsSync(inputPath) || !existsSync(planPath) || !existsSync(appModelPath)) {
    throw new Error(`Run ${runId} has no saved state to resume from (missing plan/appModel/input).`);
  }

  const input = JSON.parse(readFileSync(inputPath, "utf-8"));
  const thePlan: Plan = JSON.parse(readFileSync(planPath, "utf-8"));
  const appModel: AppModel = JSON.parse(readFileSync(appModelPath, "utf-8"));
  const resolvedUrls: string[] = input.urls;
  const prompt: string = input.prompt;

  const ctx = makeContext(runId, onEvent);
  try {
    if (existsSync(casesPath)) {
      // Checkpoint 2: cases already exist — skip straight to IR onward.
      const cases: TestCase[] = JSON.parse(readFileSync(casesPath, "utf-8"));
      return await runFromIR(ctx, { prompt, resolvedUrls, thePlan, appModel, cases, credentials });
    }
    // Checkpoint 1: resume the full flow from testCases onward.
    return await continuePipeline(ctx, { prompt, resolvedUrls, thePlan, appModel, credentials });
  } catch (err: any) {
    ctx.emit("error", "failed", undefined, err?.message ?? String(err));
    throw err;
  }
}

/** From testCases through done. Generates cases, then delegates to runFromIR. */
async function continuePipeline(
  ctx: RunContext,
  { prompt, resolvedUrls, thePlan, appModel, credentials }:
    { prompt: string; resolvedUrls: string[]; thePlan: Plan; appModel: AppModel; credentials?: Credentials | null }
) {
  const { step } = ctx;
  const cases = await step("testcases", "03-cases.json", () => toTestCases(thePlan, appModel, prompt));
  return await runFromIR(ctx, { prompt, resolvedUrls, thePlan, appModel, cases, credentials });
}

/**
 * From IR generation through done. Shared by a fresh run, a checkpoint-1 resume
 * (via continuePipeline), and a checkpoint-2 resume (direct from resumePipeline).
 * Contains CHECKPOINT 2: after toIR() resolves the actual page the primary case
 * reaches (via live-extend, which may go several clicks past the entry page —
 * e.g. homepage -> Login button -> real login form), check whether THAT page
 * has a password field we still have no credentials for. This is what catches
 * login/signup pages that aren't the entry page itself.
 */
async function runFromIR(
  ctx: RunContext,
  { prompt, resolvedUrls, thePlan, appModel, cases, credentials }:
    { prompt: string; resolvedUrls: string[]; thePlan: Plan; appModel: AppModel; cases: TestCase[]; credentials?: Credentials | null }
) {
  const { save, emit, step, runDir, runId } = ctx;

  const primary = cases.find((c) => c.fromPrompt) ?? [...cases].sort(byPriority)[0];
  if (!primary) throw new Error("No test cases produced");

  const { ir, updatedAppModel } = await step("ir", "04-ir.json", () =>
    toIR(primary, appModel, prompt, resolvedUrls[0], credentials ?? undefined)
  );

  // ---------------------------------------------------------------------
  // CHECKPOINT 2: toIR's live-extend may have replayed several steps past
  // the entry page (e.g. clicked through a homepage to a real login form)
  // and appended that page to updatedAppModel. Check THAT page for a
  // password field now that we actually know what it looks like. If it
  // needs auth and we still have no credentials, pause here — cases are
  // already saved on disk, so resumePipeline can skip straight back here.
  // ---------------------------------------------------------------------
  const authNeed2 = classifyAuthNeed(updatedAppModel);
  if (authNeed2 && !credentials) {
    emit("needs_input", "completed", {
      reason: authNeed2 === "signup"
        ? "A signup page was found while building the test, and no signup details were provided."
        : "A login page was found while building the test, and no credentials were provided.",
      requiredFields: requiredFieldsFor(authNeed2),
      authType: authNeed2,
      url: resolvedUrls[0],
    });
    return { runId, runDir, status: "needs_input" as const, authType: authNeed2 };
  }

  const spec = await step("generate", null, async () => generateSpec(ir));
  writeFileSync(path.join(runDir, "generated.spec.ts"), spec);

  let finalSpecCode = spec;

  const result = await step("execute", "05-result.json", async () => {
    const r = await runSpec(spec, runDir);
    return { passed: r.passed, exitCode: r.exitCode, artifactsDir: r.artifactsDir, resultsJsonPath: r.resultsJsonPath, raw: r.raw };
  });

  const truncatedNoAssertion = !!(ir.meta.truncated && !ir.meta.hasTerminalAssertion);

  let diagnosis = null;
  let finalResult = result;
  let finalIr = ir;
  let healed = false;

  if (!result.passed) {
    diagnosis = await step("failure_analysis", "06-diagnosis.json", () => analyzeFailure(ir, result as any));
    const healable = diagnosis.category === "selector_changed" || diagnosis.category === "element_missing";
    const failIdx = diagnosis.failingStepId ? ir.steps.findIndex((s) => s.id === diagnosis!.failingStepId) : -1;

    if (healable && failIdx > 0) {
      try {
        emit("heal", "started");
        const prefix = ir.steps.slice(0, failIdx);
        const freshModel = await refreshPageModel(appModel, prefix, credentials ?? credentialsFor(resolvedUrls[0]));
        const { ir: healedIr } = await toIR(primary, freshModel, prompt, resolvedUrls[0], credentials ?? undefined);

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
        emit("heal", "failed", undefined, err?.message ?? String(err));
      }
    }
  }

  if (truncatedNoAssertion && !healed) {
    finalResult = { ...result, passed: false, status: "truncated_no_assertion" } as typeof finalResult;
    save("05-result.json", finalResult);
  }

  const scope = (thePlan.testTypeScope ?? ALL_SCOPES) as typeof ALL_SCOPES;
  const originalUrlsSet = new Set(resolvedUrls);
  const newPages = updatedAppModel.pages.filter(page => !originalUrlsSet.has(page.url));

  let allCases = [...cases];
  if (newPages.length > 0) {
    emit("testcases", "started", { newPages: newPages.map(p => p.url) });
    const reactiveCases = await generateCasesForNewPages(updatedAppModel, resolvedUrls, thePlan, prompt);
    if (reactiveCases.length > 0) {
      allCases = [...allCases, ...reactiveCases];
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
  await runSuite(scopedCases, updatedAppModel, runDir, prompt, resolvedUrls[0], ctx.onEvent, primaryCaseResult, credentials ?? undefined);

  const shot = findScreenshot(finalResult.artifactsDir);
  const screenshotUrl = shot ? "/" + path.relative(".", shot).replace(/\\/g, "/") : undefined;
  emit("done", "completed", {
    passed: finalResult.passed, screenshotUrl, partial: finalIr.meta.truncated ?? false, healed,
    status: (finalResult as any).status,
    truncationNote: finalIr.meta.truncationNote,
    test: { title: primary.title, steps: primary.steps, expected: primary.expected },
  });
  return { runId, runDir, result: finalResult, diagnosis };
}

const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const byPriority = (a: { priority: string }, b: { priority: string }) => rank[a.priority] - rank[b.priority];

export function makeRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 8);
}