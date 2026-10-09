import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { llm } from "../llm/client.js";
import { parseJson } from "../llm/json.js";
import { toIR } from "./ir.js";
import { generateSpec } from "./generator.js";
import { runSpec, type ExecResult } from "./executor.js";
import { refreshPageModelAt } from "./liveExtend.js";
import { analyzeFailure, type Diagnosis } from "./failureAnalysis.js";
import {
  credentialPolicyFor, promptCarriesCredentials, credentialEnvVars, redactCredentials, type Credentials,
} from "./credentials.js";
import { LLMTestCase, type TestCase } from "./testCases.js";
import { toLiteModel, pageKey, type AppModel } from "../schema/appModel.js";
import type { IR } from "../schema/ir.js";
import type { LlmBudget } from "../llm/llmBudget.js";

/**
 * Drift recovery — when the page changed under a test: wait, re-discover, rebuild, re-run, and
 * talk to the tester while doing it (DECISIONS.md D-52, `DRIFT_RECOVERY`, default off).
 *
 * Self-heal (heal.ts) is the cheap, silent, one-shot answer: re-snapshot, regenerate the IR from
 * the SAME test case, accept only a pass. It cannot help when the case itself no longer describes
 * the page — a button renamed, a field removed, a step that now needs a different path — and it
 * never asks anyone. This is the next rung, for the primary case of a run only:
 *
 *   1. WAIT `DRIFT_SETTLE_MS`. A page caught mid-deploy, or still hydrating, is the commonest
 *      "changed DOM"; waiting is cheaper than rebuilding against a half-rendered page.
 *   2. RE-DISCOVER the page where the case broke: replay the steps before the failing one in a
 *      real browser and re-snapshot where they land (`refreshPageModelAt`, the walk heal and the
 *      case editor already use).
 *   3. ASK the tester. They see what failed and on which page, and can say what changed ("Save
 *      is now called Submit", "the filter moved into a menu"), say nothing, or stop.
 *   4. REBUILD the test case — its title, steps and expected result — against the fresh page and
 *      their note (one model call), then compile it to IR, generate the spec and RUN it.
 *   5. If it still fails on a page-change category, go round again, telling them why — up to
 *      `DRIFT_MAX_ROUNDS`. Anything else (a real assertion failure, a network error) stops: that
 *      is a finding about the app, not drift, and rebuilding the test to make it pass would hide it.
 *
 * A MODEL PROPOSES, A RUN PROVES (D-27's spirit, CLAUDE.md's central rule). The revised case is
 * the model's proposal; it is accepted only when its spec actually passes, exactly as a heal is.
 * Nothing here touches the library: the revised case and IR are run artifacts under
 * `runs/<id>/recovered/`, and saving one is the same deliberate click it always was.
 *
 * WHAT COUNTS AS DRIFT is decided by the diagnosis CATEGORY (classify.ts structure first, the
 * vision model second), never by reading the error text here.
 */

/** Diagnosis categories that mean "the page is not shaped the way the test expects". */
const DRIFT_CATEGORIES = new Set([
  "selector_changed", "element_missing", "multiple_matches", "detached",
]);

export function driftRecoveryEnabled(): boolean {
  return process.env.DRIFT_RECOVERY === "true";
}

function settleMs(): number {
  const raw = Number(process.env.DRIFT_SETTLE_MS ?? 15_000);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15_000;
}

function maxRounds(): number {
  const raw = Number(process.env.DRIFT_MAX_ROUNDS ?? 2);
  return Number.isInteger(raw) && raw >= 1 ? Math.min(raw, 5) : 2;
}

/**
 * True when this failure looks like the page changed under the test. Needs a failing step that
 * is not the first one: with nothing before it there is no page to walk to and re-snapshot.
 */
export function isDrift(diagnosis: Diagnosis | null, ir: IR): boolean {
  if (!diagnosis || !DRIFT_CATEGORIES.has(diagnosis.category)) return false;
  const failIdx = ir.steps.findIndex((s) => s.id === diagnosis.failingStepId);
  return failIdx > 0;
}

/** What the tester answered. `stop` ends recovery; `note` (possibly empty) steers the rebuild. */
export type TesterReply = { stop: true } | { stop: false; note: string };

export interface DriftRound {
  round: number;
  category: string;
  failingStep: string;
  explanation: string;
  pageUrl: string;
}

export interface DriftArgs {
  testCase: TestCase;
  ir: IR;
  appModel: AppModel;
  diagnosis: Diagnosis;
  sourcePrompt: string;
  entryUrl: string;
  llmBudget?: LlmBudget;
  runCreds?: Credentials;
  /** The run's directory; rounds write under `recovered/round-N/`. */
  outDir: string;
  /** Ask the tester about this round. Resolves with their reply; a timeout counts as an empty
   *  note (carry on), so a run nobody watches still gets one unsteered rebuild per round. */
  ask: (round: DriftRound) => Promise<TesterReply>;
  /** Progress, for the run's event stream. Never carries the tester's note. */
  onProgress: (status: "waiting" | "rediscovering" | "rebuilding" | "running", round: number) => void;
}

export interface DriftResult {
  testCase: TestCase;
  ir: IR;
  result: ExecResult;
  specCode: string;
  model: AppModel;
  rounds: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Returns the passing rebuild, or null when every round failed, the tester stopped, or the
 *  failure stopped looking like drift. Never throws for a failed round — a round that cannot
 *  rebuild (model refusal, unparseable answer, truncated IR) ends recovery and keeps the original
 *  failure, which is what the run reports. */
export async function recoverFromDrift(args: DriftArgs): Promise<DriftResult | null> {
  const { sourcePrompt, entryUrl, llmBudget, runCreds, outDir } = args;
  let testCase = args.testCase;
  let ir = args.ir;
  let model = args.appModel;
  let diagnosis = args.diagnosis;
  const log: Array<Record<string, unknown>> = [];
  const logPath = path.join(outDir, "recovered", "drift-recovery.json");
  const writeLog = () => {
    mkdirSync(path.dirname(logPath), { recursive: true });
    // The tester's note is not a secret, but it is free text typed next to a login: scrubbed the
    // same way every other run artifact is (rule 5).
    writeFileSync(logPath, JSON.stringify(redactCredentials(log, runCreds), null, 2));
  };

  for (let round = 1; round <= maxRounds(); round++) {
    if (!isDrift(diagnosis, ir)) break;
    const failIdx = ir.steps.findIndex((s) => s.id === diagnosis.failingStepId);
    const failing = ir.steps[failIdx];

    args.onProgress("waiting", round);
    await sleep(settleMs());

    args.onProgress("rediscovering", round);
    const credPolicy = credentialPolicyFor(testCase, promptCarriesCredentials(sourcePrompt));
    const fresh = await refreshPageModelAt(model, ir.steps.slice(0, failIdx), runCreds, credPolicy);
    model = fresh.model;

    const reply = await args.ask({
      round,
      category: diagnosis.category,
      failingStep: describeStep(failing),
      explanation: diagnosis.explanation,
      pageUrl: fresh.reachedUrl,
    });
    if (reply.stop) {
      log.push({ round, outcome: "stopped by tester" });
      writeLog();
      return null;
    }

    args.onProgress("rebuilding", round);
    const revised = await reviseTestCase(testCase, model, fresh.reachedUrl, diagnosis, failing, reply.note);
    if (!revised) {
      log.push({ round, outcome: "the model did not return a usable revised case", note: reply.note });
      writeLog();
      return null;
    }
    const { ir: newIr } = await toIR(revised, model, sourcePrompt, entryUrl, llmBudget, runCreds);
    // Same rule as heal: a rebuild that truncates never exercises the part that broke, so its
    // "pass" would be a false positive.
    if (newIr.meta.truncated) {
      log.push({ round, outcome: "the rebuilt case could not be grounded on the fresh page", note: reply.note, revised });
      writeLog();
      return null;
    }

    // The prompt says "never weaken the expected result"; that is a preference (CLAUDE.md). This
    // is the check behind it, on IR STRUCTURE: a rebuild that asserts fewer things than the test
    // it replaces checks less, and its pass would overstate what was verified (TD-116).
    if (assertionCount(newIr) < assertionCount(args.ir)) {
      log.push({ round, outcome: "the rebuilt case checks less than the original", note: reply.note, revised });
      writeLog();
      return null;
    }

    args.onProgress("running", round);
    const roundDir = path.join(outDir, "recovered", `round-${round}`);
    mkdirSync(roundDir, { recursive: true });
    const specCode = generateSpec(newIr, path.join(roundDir, "artifacts"));
    const result = await runSpec(specCode, roundDir, credentialEnvVars(runCreds));
    writeFileSync(path.join(roundDir, "generated.spec.ts"), specCode);
    writeFileSync(path.join(roundDir, "ir.json"), JSON.stringify(newIr, null, 2));
    writeFileSync(path.join(roundDir, "testcase.json"), JSON.stringify(redactCredentials(revised, runCreds), null, 2));

    if (result.passed) {
      log.push({ round, outcome: "passed", note: reply.note, revisedTitle: revised.title });
      writeLog();
      return { testCase: revised, ir: newIr, result, specCode, model, rounds: round };
    }
    testCase = revised;
    ir = newIr;
    diagnosis = await analyzeFailure(newIr, result, model.auth?.loginUrl);
    log.push({ round, outcome: "failed", note: reply.note, revisedTitle: revised.title, category: diagnosis.category });
    writeLog();
  }
  return null;
}

/** How many things a test actually checks. */
function assertionCount(ir: IR): number {
  return ir.steps.filter((s) => s.action === "assert").length;
}

/** One line a tester can read: what the step does and to what. */
export function describeStep(step: IR["steps"][number]): string {
  const t = step.target ?? {};
  const what = t.name ? `"${t.name}"${t.role ? ` (${t.role})` : ""}` : t.text ? `"${t.text}"` : t.url ?? t.css ?? "";
  return `${step.action}${what ? " " + what : ""}`;
}

/**
 * Ask the model to rewrite the case for the page as it is NOW. The fresh page (lite model, only
 * the page the walk reached) is the ground truth; the tester's note is the strongest steer; the
 * case's intent must survive — the point is to keep testing the same behaviour on a changed page,
 * not to quietly test something easier. Whatever comes back is parsed by the same schema every
 * generated case passes, and is accepted later only if it runs green.
 */
async function reviseTestCase(
  testCase: TestCase, model: AppModel, reachedUrl: string, diagnosis: Diagnosis,
  failing: IR["steps"][number], note: string,
): Promise<TestCase | null> {
  const lite = toLiteModel(model);
  const page = lite.pages.find((p) => pageKey(p.url) === pageKey(reachedUrl)) ?? lite.pages[lite.pages.length - 1];
  const system = [
    "You repair an automated UI test case after the web page it tests has changed.",
    "You are given the current test case, the step that failed and why, a fresh snapshot of the page",
    "where it failed, and optionally a note from the human tester. Return the test case rewritten so",
    "every step refers ONLY to elements that exist in the fresh snapshot, using their exact names.",
    "Keep the case's intent and its expected outcome: test the same behaviour on the changed page.",
    "Never weaken the expected result to make the test easier to pass.",
    "When the tester's note conflicts with your own reading of the page, follow the note.",
    "Return ONE JSON object with the same fields as the input test case.",
  ].join(" ");
  const user = JSON.stringify({
    testCase: { ...testCase, generatedFrom: undefined },
    failedStep: { step: describeStep(failing), category: diagnosis.category, explanation: diagnosis.explanation },
    freshPage: page,
    testerNote: note || null,
  });
  try {
    const { content } = await llm(user, { systemInstruction: system, json: true, role: "main", stage: "drift_recovery" });
    const parsed = LLMTestCase.safeParse(parseJson(content));
    if (!parsed.success) return null;
    // Stamped in code, never taken from the model: the primary stays the primary, on its page.
    return {
      ...parsed.data,
      fromPrompt: testCase.fromPrompt,
      targetUrl: testCase.targetUrl,
      generatedFrom: testCase.generatedFrom,
    };
  } catch {
    return null;
  }
}
