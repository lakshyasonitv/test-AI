/* eslint-disable @typescript-eslint/no-explicit-any */
import { session } from "../../api";
import { agoText } from "./text";
import { STATUS_ICON } from "./icons";

/**
 * The Run page's event fold — public/app.js's applyEvent / setPhaseFromStage / summarize, ported
 * so the same `/api/runs/:id/state` event list produces the same screen.
 *
 * Like the classic UI this is applied INCREMENTALLY (only new events, `seen` moves forward) to one
 * mutable model, and it is re-appliable from the start: after a failed poll the page throws the
 * model away and replays the whole stream (the classic "recovery replay"). React re-renders from
 * the model after each poll tick.
 */

/** fetch with the signed-in session's bearer token, as the classic UI's wrapped window.fetch. */
export function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const { token } = session();
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  return fetch(path, { ...init, headers });
}

export const PHASES = [
  { key: "understand", label: "1 · Understanding your request", desc: "Reading the prompt and forming a plan.", stages: ["plan"] },
  { key: "analyze", label: "2 · Analyzing the website", desc: "Mapping pages, forms and controls.", stages: ["discovery"] },
  { key: "build_run", label: "3 · Building & running tests", desc: "Writing Playwright scripts and executing them.", stages: ["testcases", "ir", "generate", "execute"] },
  { key: "results", label: "4 · Checking the results", desc: "Diagnosing failures and self-healing.", stages: ["failure_analysis", "heal"] },
];
const STAGE_TO_PHASE: Record<string, string> = Object.fromEntries(PHASES.flatMap((p) => p.stages.map((s) => [s, p.key])));

export type StageStatus = "pending" | "started" | "completed" | "failed";
export interface PhaseView { status: StageStatus; summary: string; details: string | null }
export interface ProgressItem { caseId?: string; cls: string; icon: string; label: string; title: string; note: string | null }
export interface Verdict { cls: string; ic: string; head: string; detail?: string }
export interface Terminal { data: any; stage: string; error?: string }
export interface Notice { kind: "notice" | "error"; text: string }
export interface GateRound {
  seq: number; batch: any[]; attempt: number; ai: boolean;
  /** false until the accepted-cases answer arrives (the classic panel is drawn then, not before). */
  visible: boolean; accepted: number; poolCap?: number;
}

export interface RunModel {
  phaseStageStatus: Record<string, Record<string, StageStatus>>;
  phases: Record<string, PhaseView>;
  prompt: string;
  metaBase: string;
  /** The open credential prompt (the `credentials` event's data), keyed by the event's position. */
  cred: { data: any; key: number } | null;
  gate: GateRound | null;
  gateSeq: number;
  gateNotice: Notice | null;
  progress: { visible: boolean; items: ProgressItem[] };
  terminal: Terminal | null;
  finalVisible: boolean;
  verdictOverride: Verdict | null;
  /** The failure_analysis line (#diagnosis's text before the enterprise card replaces it). */
  diagnosisText: string;
  usage: any;
  isReplay: boolean;
  finished: boolean;
  primaryHeals: number;
  suiteHeals: number;
  eventIndex: number;
}

export function newModel(): RunModel {
  const phases: Record<string, PhaseView> = {};
  for (const p of PHASES) phases[p.key] = { status: "pending", summary: "", details: null };
  return {
    phaseStageStatus: {}, phases, prompt: "", metaBase: "", cred: null, gate: null, gateSeq: 0, gateNotice: null,
    progress: { visible: false, items: [] }, terminal: null, finalVisible: false, verdictOverride: null,
    diagnosisText: "", usage: null, isReplay: false, finished: false, primaryHeals: 0, suiteHeals: 0, eventIndex: 0,
  };
}

function summarize(stage: string, data: any): string {
  try {
    if (data && typeof data.skipped === "string") return data.skipped;
    switch (stage) {
      case "plan": return data.goal ? `AI Strategy: ${data.goal}` : "";
      case "discovery": {
        const pagesCount = data.pages?.length ?? 1;
        const concepts = [...new Set<string>((data.pages ?? []).flatMap((p: any) => p.concepts ?? []))];
        const shown = concepts.slice(0, 6).join(", ");
        const more = concepts.length > 6 ? ` and ${concepts.length - 6} more` : "";
        const conceptStr = concepts.length ? ` — ${shown}${more}` : "";
        const orgNote = data.orgWarning?.message ? `⚠ ${data.orgWarning.message} ` : "";
        const scan = data.savedScan;
        if (scan?.scope === "project") {
          return scan.reused
            ? `${orgNote}Used this project's saved discovery from ${agoText(scan.at)}, so the site was not explored again. `
              + `${pagesCount} page${pagesCount === 1 ? "" : "s"}${conceptStr}. Tick "Explore the site again" if it has changed`
            : `${orgNote}Discovered ${pagesCount} page${pagesCount === 1 ? "" : "s"}${conceptStr}. Saved for this project, so its next runs can skip this step`;
        }
        if (scan?.reused) {
          return `${orgNote}Used the saved scan of this org from ${agoText(scan.at)}: nothing in the org's setup has changed, `
            + `so it was not scanned again. ${pagesCount} page${pagesCount === 1 ? "" : "s"}${conceptStr}`;
        }
        const savedNote = scan ? ". Saved, so the next run on this org can skip the scan" : "";
        return `${orgNote}Discovered ${pagesCount} page${pagesCount === 1 ? "" : "s"}${conceptStr}${savedNote}`;
      }
      case "testcases": {
        if (data.selected !== undefined && data.generated !== undefined) {
          const reason = data.generated > data.selected
            ? ` — duplicates removed, capped at ${data.budget ?? data.selected} for coverage`
            : "";
          return `Generated ${data.generated} scenarios → selected ${data.selected} to run${reason}`;
        }
        if (data.action) return "Reviewing test cases...";
        const count = data.total ?? data.length ?? 0;
        const extra = data.reactive ? ` (${data.reactive} reactive)` : "";
        return `Generated ${count} test scenarios${extra}`;
      }
      case "ir": return `Worked out the exact steps: ${data.meta?.title ?? ""}`;
      case "generate": return "Test script ready";
      case "execute": return data.passed ? "The test ran and everything it checked was correct" : "The test ran and something didn’t match what was expected";
      case "heal": return data.healed
        ? data.deterministicHeal
          ? "An element had moved on the page — the test matched it against the crawled model (no model call) and carried on"
          : "An element had moved on the page — the test found it again and carried on"
        : "Tried to recover from a step that broke";
      case "suite": return data.summary ? `Suite Progress: ${data.summary.passed}/${data.summary.total} tests passed` : "";
      default: return "";
    }
  } catch { return ""; }
}

function computePhaseStatus(m: RunModel, phaseKey: string): StageStatus {
  const tracked = m.phaseStageStatus[phaseKey];
  if (!tracked) return "pending";
  const statuses = Object.values(tracked);
  if (statuses.length === 0) return "pending";
  if (statuses.some((s) => s === "failed")) return "failed";
  if (statuses.every((s) => s === "completed")) return "completed";
  if (statuses.some((s) => s === "started")) return "started";
  return "pending";
}

function applyPhase(m: RunModel, key: string, status: StageStatus, summary?: string) {
  const p = m.phases[key];
  p.status = status;
  if (summary !== undefined) p.summary = summary;
}

function setPhaseFromStage(m: RunModel, stage: string, status: string, data: any) {
  if (stage === "done" || stage === "error") {
    const interrupted = stage === "error";
    for (const p of PHASES) {
      const s = computePhaseStatus(m, p.key);
      if (s === "completed" || s === "failed") continue;
      if (s === "started") { applyPhase(m, p.key, "failed", "Interrupted — pipeline ended before this step finished"); continue; }
      applyPhase(m, p.key, interrupted ? "failed" : "completed",
        interrupted ? "Skipped — the run aborted before reaching this step" : "Nothing failed, so there was nothing to explain");
    }
    return;
  }
  const phaseKey = STAGE_TO_PHASE[stage];
  if (!phaseKey) return;
  if (!m.phaseStageStatus[phaseKey]) m.phaseStageStatus[phaseKey] = {};
  const tracked = m.phaseStageStatus[phaseKey];
  if (status === "started") {
    const phase = PHASES.find((p) => p.key === phaseKey);
    phase?.stages.forEach((s) => { if (!tracked[s]) tracked[s] = "pending"; });
    tracked[stage] = "started";
  } else if (status === "completed" || status === "failed") {
    tracked[stage] = status;
  }
  applyPhase(m, phaseKey, computePhaseStatus(m, phaseKey), data !== undefined ? summarize(stage, data) : undefined);
  if (data !== undefined) m.phases[phaseKey].details = JSON.stringify(data, null, 2);
}

/** Drop the gate (classic hideCaseSelectionPanel), including that run's saved drafts. */
export function hideGate(m: RunModel, runId: string) {
  if (m.gate) clearGateDrafts(runId);
  m.gate = null;
}

export function gateDraftKey(runId: string, attempt: number) { return `testbench.gate.${runId}.${attempt}`; }

export function clearGateDrafts(runId: string) {
  try {
    const prefix = `testbench.gate.${runId}.`;
    Object.keys(localStorage).filter((k) => k.startsWith(prefix)).forEach((k) => localStorage.removeItem(k));
  } catch { /* storage unavailable */ }
}

export interface ApplyCtx {
  runId: string;
  /** True while this page is still showing this run (the classic pollGeneration check). */
  alive: () => boolean;
  /** Re-render after an asynchronous change to the model. */
  bump: () => void;
}

/** One event into the model. Returns true on the terminal event (stop polling). */
export function applyEvent(m: RunModel, event: any, ctx: ApplyCtx): boolean {
  const index = m.eventIndex++;
  const { runId } = ctx;
  setPhaseFromStage(m, event.stage, event.status, event.data);

  if (event.stage === "input" && typeof event.data?.prompt === "string") {
    m.prompt = event.data.prompt;
    let host = "";
    try { host = new URL(event.data.url).hostname; } catch { /* no URL */ }
    const when = event.ts ? new Date(event.ts).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }) : "";
    m.metaBase = [host, when].filter(Boolean).join(" · ");
  }

  if (event.stage === "credentials") {
    m.cred = event.status === "started" ? { data: event.data, key: index } : null;
    return false;
  }

  if (event.stage === "testcases" && event.data?.action === "case_round_requested") {
    const seq = ++m.gateSeq;
    const round: GateRound = {
      seq, batch: Array.isArray(event.data.batch) ? event.data.batch : [], attempt: event.data.attempt ?? 1,
      ai: event.data.gateRewrite === true, visible: false, accepted: 0,
    };
    m.gate = round;
    const stillOpen = () => ctx.alive() && m.gate === round && round.seq === m.gateSeq;
    authFetch(`/api/runs/${runId}/accepted-cases`)
      .then((res) => res.json())
      .then(({ count, remainingCapacity }) => {
        if (!stillOpen()) return;
        round.accepted = count || 0;
        round.poolCap = typeof remainingCapacity === "number" ? count + remainingCapacity : undefined;
        round.visible = true;
        m.gateNotice = null;
        ctx.bump();
      })
      .catch(() => {
        if (!stillOpen()) return;
        round.accepted = 0;
        round.visible = true;
        m.gateNotice = null;
        ctx.bump();
      });
    return false;
  }
  if (event.stage === "testcases" && event.data?.action === "case_pool_cap_warning") {
    const cap = event.data.poolCap ?? 5;
    m.gateNotice = { kind: "notice", text: `The case pool is full — ${cap} of ${cap} cases already accepted. The run will continue with what's been picked.` };
    return false;
  }
  if (event.stage === "testcases" && event.data?.action === "case_regen_limit_reached") {
    const rounds = event.data.attempt ?? 3;
    m.gateNotice = { kind: "notice", text: `That was the last refine — ${rounds} rounds is the limit for one run. The run will continue with the cases you've picked.` };
    return false;
  }
  if (event.stage === "testcases" && event.data?.action === "case_end_of_capacity") {
    m.gateNotice = { kind: "notice", text: "No new test cases could be generated — everything the model produced repeats a case you already saw. The run will continue with the cases you've picked." };
    return false;
  }
  if (event.stage === "testcases" && event.data?.action === "case_selection_finalized") {
    hideGate(m, runId);
    return false;
  }

  if (event.stage === "done" || event.stage === "error") {
    m.finalVisible = true;
    m.usage = event.data?.llmUsage ?? null;
    m.isReplay = !!event.data?.replay;
    m.finished = event.stage === "done";
    m.terminal = { data: event.data, stage: event.stage, error: event.error };
    m.verdictOverride = null;
    m.progress.visible = false;
    hideGate(m, runId);
    return true;
  }

  if (event.stage === "heal" && event.status === "started") m.primaryHeals += 1;

  if (event.stage === "suite" && event.status === "started" && event.data) {
    const caseId = event.data.caseId;
    if (event.data.total && !caseId) {
      m.progress.visible = true;
      m.progress.items = Array.from({ length: event.data.total }, (_, i) => ({
        cls: "pending", icon: "circle", label: `Case ${i + 1} / ${event.data.total}`, title: "Waiting…", note: null,
      }));
    } else if (caseId) {
      const items = m.progress.items;
      let item = items.find((x) => x.caseId === caseId);
      if (!item && items.length > 0) item = items.find((x) => x.cls === "pending" && !x.caseId);
      if (item) {
        item.caseId = caseId;
        item.cls = "running";
        item.icon = "loader";
        if (event.data.title) item.title = event.data.title;
        if (event.data.healing) {
          m.suiteHeals = Math.max(m.suiteHeals, event.data.healsUsedInRun ?? 1);
          item.note = `Attempt ${(event.data.healAttempt ?? 1) + 1} of ${(event.data.healMax ?? 1) + 1} — retrying with a fresh page snapshot`;
        }
      }
    }
  }

  if (event.stage === "suite" && event.status === "completed" && event.data && !event.data.summary) {
    const caseId = event.data.caseId;
    const item = caseId ? m.progress.items.find((x) => x.caseId === caseId) : undefined;
    if (item) {
      const cls = event.data.status || "passed";
      item.cls = cls;
      item.icon = STATUS_ICON[cls] ?? "check";
      if (event.data.healAttempt) {
        const outcome = cls === "passed" || cls === "truncated" ? "passed" : "failed";
        item.note = `Retry ${event.data.healAttempt}: ${outcome}`;
      } else {
        item.note = null;
      }
    }
  }

  if (event.stage === "suite" && event.status === "completed" && event.data?.summary?.cases) {
    const summary = event.data.summary;
    m.progress.visible = true;
    m.progress.items = summary.cases.map((c: any, i: number) => ({
      cls: c.status, icon: STATUS_ICON[c.status] ?? "circle",
      label: `Case ${i + 1} / ${summary.cases.length}`, title: c.title, note: null,
    }));
  }

  if (event.stage === "failure_analysis" && event.status === "completed") {
    m.diagnosisText = event.data?.explanation ? `${event.data.explanation} — ${event.data.suggestedFix}` : "";
  }
  return false;
}

// ------------------------------------------------------------------ verdict + diagnosis wording

export function verdictFor(data: any, stage: string, error?: string): Verdict {
  const status = data?.status;
  if (stage === "error") {
    if (data?.orgRefused && error) return { cls: "blocked", ic: "alert-circle", head: "Couldn’t run this", detail: error };
    return { cls: "blocked", ic: "alert-circle", head: "Couldn’t run this",
      detail: error
        ? error + " This is a problem on our side, not a result about your site."
        : "The run stopped before it could test anything. This is a problem on our side, not a result about your site." };
  }
  if (status === "blocked") {
    return { cls: "blocked", ic: "slash-circle", head: "Couldn’t finish — the site needs something a test can’t provide",
      detail: `${data?.blockedBy ?? "The flow hit a step automation can’t pass."} The screenshot below is where it stopped.` };
  }
  if (status === "truncated_no_assertion") {
    return { cls: "incomplete", ic: "minus-circle", head: "Ran, but couldn’t confirm everything",
      detail: "One or more cases finished without a conclusive assertion — usually a step the test could not reach. That is neither a pass nor a failure." };
  }
  if (status === "no_cases_selected") {
    return { cls: "incomplete", ic: "minus-circle", head: "No test cases were selected",
      detail: "The review round timed out before anything was picked, so nothing ran. Start a new run and pick at least one case before it times out." };
  }
  if (data?.passed && data?.healed) {
    return { cls: "passed", ic: "check", head: "Passed",
      detail: data?.deterministicHeal
        ? "One element had moved on the page — the test matched it against the crawled model deterministically (no model call) and carried on."
        : "One element had moved on the page — the test found it again and carried on." };
  }
  if (data?.passed && data?.partial) {
    return { cls: "passed", ic: "check", head: "Passed, as far as it could go", detail: "Everything it was able to reach behaved correctly." };
  }
  if (data?.passed) {
    return { cls: "passed", ic: "check", head: "Passed", detail: "Everything checked out. Every selected case reached its expected outcome." };
  }
  return { cls: "failed", ic: "x", head: "Failed",
    detail: "The site did not do what at least one test expected. Open the failing case below for the diagnosis." };
}

export interface DiagCard { headline: string; description: string; fixPrompt: string; techDetails: string }

/**
 * classic renderEnterpriseDiagnostic: "clear" empties #diagnosis, a card replaces it, and null
 * leaves whatever was there (the failure_analysis line).
 */
export function enterpriseDiagnostic(data: any, stage: string, error?: string): DiagCard | "clear" | null {
  if (data?.passed && !data?.partial) return "clear";
  const status = data?.status;
  const note = data?.truncationNote || data?.ir?.meta?.truncationNote;
  const diagnosis = data?.diagnosis;
  const blockedBy = data?.blockedBy;
  if (status === "truncated_no_assertion" || status === "truncated" || note) {
    const kind = data?.truncationKind || data?.ir?.meta?.truncationKind;
    let description: string, fixPrompt: string;
    if (kind === "navigate-url") {
      description = "It tried to open a page address that isn't part of this site.";
      fixPrompt = "Name the link or button that leads there, rather than the address — for example \"click Checkout\" instead of \"go to /checkout\".";
    } else if (kind === "text-target") {
      description = "It looked for wording that wasn't on the page.";
      fixPrompt = "Check that any text you asked it to look for matches the page exactly, including capitalisation.";
    } else if (kind === "incomplete-coverage") {
      description = "It couldn't carry out every step your request described, so it ran the part it could verify.";
      fixPrompt = "Try describing fewer steps in one go, or split the request into separate tests.";
    } else if (kind === "error-assertion") {
      description = "The form showed its own error message, so the flow never reached a success screen.";
      fixPrompt = "Check the values in your request — for example a real-looking email address or phone number — so the form accepts them, and describe every step up to the final confirmation.";
    } else {
      description = "It couldn't find a button, link, or field it needed on the page.";
      fixPrompt = "Check that the wording in your request (button or link names) matches what actually appears on the website.";
    }
    return { headline: "The test stopped partway through", description, fixPrompt, techDetails: note || "" };
  }
  if (status === "blocked") {
    return {
      headline: "The site stopped the test",
      description: blockedBy || "The test hit something automation can't get past on its own — like a code sent to a phone or email, or a \"prove you're not a robot\" check.",
      fixPrompt: "Try a test version of the site with that extra step turned off, or point the test at a page that's already logged in.",
      techDetails: blockedBy || "",
    };
  }
  if (diagnosis) {
    return {
      headline: "Something didn't work as expected",
      description: diagnosis.explanation || "The test hit a problem partway through and couldn't continue.",
      fixPrompt: diagnosis.suggestedFix || "Check that the button or field the test needs is visible and available on the page.",
      techDetails: `Category: ${diagnosis.category || "unknown"} · Failing step: ${diagnosis.failingStepId || "unknown"}`,
    };
  }
  if (error || stage === "error") {
    return {
      headline: "Something went wrong on our end",
      description: error || "We hit an unexpected problem while running this test.",
      fixPrompt: "Check that the website address is correct and reachable, then try again.",
      techDetails: error || "",
    };
  }
  return null;
}
