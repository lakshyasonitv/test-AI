/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Pure wording helpers for the Run page, ported line for line from public/app.js (formatIrStep,
 * readableStep, displayValue, runTokensOf, reportStepsOf, stepOutcomes, the narrative and
 * screenshot captions, the failure-category reasons, diffSteps).
 *
 * formatIrStep here is a THIRD copy of src/stages/stepText.ts's sentence format (app.js holds the
 * second). It is display-only on this page — nothing parses it back — but if the server's wording
 * changes, change this one too so the two UIs read the same.
 */

export const STATUS_LABEL: Record<string, string> = {
  passed: "Passed", failed: "Failed", error: "Error", incomplete: "Unconfirmed", truncated: "Partial",
  truncated_no_assertion: "Unconfirmed", blocked: "Blocked", no_cases_selected: "Nothing selected",
};

export const CASE_BADGE: Record<string, string> = {
  passed: "badge-passed", failed: "badge-failed", blocked: "badge-blocked",
  truncated: "badge-truncated", truncated_no_assertion: "badge-partial",
};

export const agoText = (iso: string): string => {
  const min = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  return min < 1 ? "just now" : min < 60 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
};

/** 1234 -> "1.2k". */
export function fmtTokens(n: number): string {
  if (!Number.isFinite(n)) return "0";
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

export function displayValue(value: any, tokens: any): any {
  if (typeof value !== "string") return value ?? "";
  return value
    .replace(/\$\x7Benv:([A-Za-z0-9_]+)\x7D/g, (_m, name: string) =>
      /PASSWORD|SECRET/i.test(name) ? "(saved password)"
        : /USER|EMAIL|LOGIN/i.test(name) ? "(saved username)"
        : `(saved ${name.toLowerCase().replace(/_/g, " ")})`)
    .replace(/\x7B\x7B(uid|phone|date:([+-]?\d+):([^\x7D]+))\x7D\x7D/g, (_m, kind: string, days: string, locale: string) => {
      if (kind === "uid") return tokens?.uid ?? "(unique code)";
      if (kind === "phone") return tokens?.phone ?? "(unique phone number)";
      const n = Number(days);
      if (!tokens?.now) return n ? `(today ${n > 0 ? "+" : "-"} ${Math.abs(n)} days)` : "(today)";
      const d = new Date(tokens.now + n * 86400000);
      try {
        return new Intl.DateTimeFormat(String(locale).replace("_", "-"), { year: "numeric", month: "numeric", day: "numeric" }).format(d);
      } catch { return d.toLocaleDateString(); }
    });
}

export function runTokensOf(results: any, title?: string): any {
  const tests: { title: string; t: any }[] = [];
  const visit = (s: any) => {
    for (const sp of s?.specs ?? []) for (const t of sp.tests ?? []) tests.push({ title: sp.title, t });
    for (const c of s?.suites ?? []) visit(c);
  };
  for (const s of results?.suites ?? []) visit(s);
  for (const { t } of tests.filter((x) => !title || x.title === title)) {
    const all = [...(t.annotations ?? []), ...(t.results ?? []).flatMap((r: any) => r.annotations ?? [])];
    const a = all.find((x: any) => x?.type === "run-tokens");
    if (a) { try { return JSON.parse(a.description); } catch { return null; } }
  }
  return null;
}

export function formatIrStep(step: any): string {
  if (!step || typeof step !== "object") return String(step);
  const action = step.action;
  const target = step.target;
  const targetDesc = target?.name
    ? `${target.role ? target.role + " " : ""}"${target.name}"`
    : target?.text
    ? `text "${target.text}"`
    : target?.url
    ? `"${target.url}"`
    : target?.role || target?.css || "element";
  switch (action) {
    case "navigate": return `Go to ${target?.url ? target.url : step.value ? step.value : '"/"'}`;
    case "fill": return `Type "${step.value ?? ""}" into ${targetDesc}`;
    case "click": return `Click on ${targetDesc}`;
    case "select": return `Choose "${step.value ?? ""}" from ${targetDesc}`;
    case "check": return `Check ${targetDesc}`;
    case "press": return `Press the ${step.value ?? ""} key`;
    case "wait": return `Wait briefly`;
    case "assert": {
      const assertion = step.assertion || "visible";
      if (assertion === "visible") return `Check that ${targetDesc} appears on the page`;
      if (assertion === "hidden") return `Check that ${targetDesc} is not shown`;
      if (assertion === "url_contains") return `Check the page address contains "${step.value || target?.url || ""}"`;
      if (target?.field && (assertion === "text_contains" || assertion === "text_equals")) return `Check that the "${target.field}" field shows "${step.value || ""}"`;
      if (assertion === "text_contains") return `Check that the text "${step.value || ""}" is displayed`;
      if (assertion === "text_equals") return `Check that the text "${step.value || ""}" is displayed`;
      if (assertion === "enabled") return `Check that ${targetDesc} is enabled`;
      if (assertion === "disabled") return `Check that ${targetDesc} is disabled`;
      return `Check ${assertion} on ${targetDesc}${step.value ? ` ("${step.value}")` : ""}`;
    }
    default: return `${action} ${targetDesc}`;
  }
}

export function readableStep(step: any, tokens?: any): string {
  if (!step || typeof step !== "object") return formatIrStep(step);
  const t = step.target;
  if (step.action === "navigate" && t?.url === "${env:SF_FRONTDOOR_URL}") return "Sign in to the org";
  const record = step.action === "navigate" && /^\$\x7Brecord:([A-Za-z][A-Za-z0-9_]*):([1-9][0-9]*)\x7D$/.exec(t?.url ?? "");
  if (record) return `Go back to the ${record[1]} record this test created${Number(record[2]) > 1 ? `, number ${record[2]}` : ""}`;
  const shown: any = { ...step, value: step.value === undefined ? undefined : displayValue(step.value, tokens) };
  if (t) {
    shown.target = { ...t };
    for (const k of ["name", "text", "url"]) if (t[k]) shown.target[k] = displayValue(t[k], tokens);
  }
  if (step.action === "select" && t?.lookup && !step.value) {
    return `Pick the first suggested record in ${formatIrStep({ action: "click", target: shown.target }).replace(/^Click on /, "")}`;
  }
  if (step.action === "assert" && (step.assertion ?? "visible") === "visible" && t?.text && !t.name && !t.role) {
    return `Check that "${shown.target.text}" appears on the page`;
  }
  return formatIrStep(shown);
}

export const CATEGORY_REASON: Record<string, string> = {
  selector_changed: "The page's layout changed since this test was written, so the element could no longer be found the same way.",
  element_missing: "The button, link, or field the test needed never appeared on the page.",
  element_not_interactable: "The element was there, but something (like being covered or disabled) stopped the test from using it.",
  element_hidden: "The element was on the page but stayed hidden, so the test couldn't do what it needed with it.",
  multiple_matches: "More than one element matched the description, and the test likely used the wrong one.",
  detached: "The element disappeared from the page while the test was still trying to use it.",
  timeout: "The page took longer to respond than the test was willing to wait.",
  assertion_failed: "The page did something different from what the test expected to see.",
  navigation_error: "The page failed to load, or went somewhere the test didn't expect.",
  network: "A network request the page needed failed or was blocked.",
  other: "This doesn't match a common failure pattern — see the technical details below.",
};

export function describeScreenshot(steps: any[] | undefined): string {
  if (!steps || !steps.length) return "The page as it looked when the test finished.";
  const last = steps[steps.length - 1];
  if (last.action !== "assert") return `The page right after the last step: ${readableStep(last).toLowerCase()}.`;
  const target = last.target;
  const targetDesc = target?.name ? `"${target.name}"` : target?.text ? `"${target.text}"` : "the expected element";
  const assertion = last.assertion || "visible";
  if (assertion === "visible") return `The page showing ${targetDesc}, confirming it appeared as expected.`;
  if (assertion === "hidden") return `The page after confirming ${targetDesc} was not shown.`;
  if (assertion === "url_contains") return "The page at the address the test expected to land on.";
  if (assertion === "text_contains" || assertion === "text_equals") return "The page showing the text the test was checking for.";
  return "The page in its final, confirmed state.";
}

export const NARRATIVE_LEAD_IN: Record<string, string> = {
  passed: "Here's what happened",
  truncated: "Here's the part of the test that actually ran",
  truncated_no_assertion: "Here's the part of the test that actually ran",
  blocked: "Here's what the test was doing when it was stopped",
};

export function buildStepNarrative(steps: any[], status: string, tokens: any): string {
  if (!steps || !steps.length) return "";
  const parts = steps.map((s) => {
    const d = readableStep(s, tokens);
    return d.charAt(0).toLowerCase() + d.slice(1);
  });
  const sentence = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")}, then ${parts[parts.length - 1]}`;
  return `${NARRATIVE_LEAD_IN[status] ?? NARRATIVE_LEAD_IN.passed}: ${sentence}.`;
}

export const BLOCKED_IMAGE_DESC = "The wall the test ran into — this is as far as it got, not the end of the test.";

export function reportStepsOf(raw: any, title?: string, strict = false): any[] | null {
  const tests: { title: string; t: any }[] = [];
  const visit = (suite: any) => {
    for (const child of suite?.suites ?? []) visit(child);
    for (const spec of suite?.specs ?? []) for (const t of spec?.tests ?? []) tests.push({ title: spec.title, t });
  };
  for (const s of raw?.suites ?? []) visit(s);
  if (!tests.length) return null;
  const hit = tests.find((x) => title && x.title === title) ?? (tests.length === 1 && !strict ? tests[0] : null);
  const results = hit?.t?.results ?? [];
  return results.length ? (results[results.length - 1].steps ?? []) : null;
}

export type StepOutcome = "ok" | "failed" | "skipped";

export function stepOutcomes(irSteps: any[], reportSteps: any[] | null, c: any, status: string): StepOutcome[] | null {
  if (reportSteps) {
    let failedAt = reportSteps.findIndex((s) => s?.error);
    if (failedAt < 0 && (status === "failed" || status === "blocked") && reportSteps.length < irSteps.length) failedAt = reportSteps.length;
    return irSteps.map((_, i) => failedAt >= 0
      ? (i < failedAt ? "ok" : i === failedAt ? "failed" : "skipped")
      : (i < reportSteps.length ? "ok" : status === "passed" ? "ok" : "skipped"));
  }
  if (status === "passed") return irSteps.map(() => "ok");
  if (typeof c?.failedStep === "number") {
    const f = c.failedStep - 1;
    return irSteps.map((_, i) => (i < f ? "ok" : i === f ? "failed" : "skipped"));
  }
  return null;
}

export const STEP_TRAIL_NOTE: Record<StepOutcome, string> = { ok: "Done", failed: "Failed here", skipped: "Not reached" };

/** Longest-common-subsequence diff over step lines, so an inserted step shifts nothing after it. */
export function diffSteps(a: string[], b: string[]) {
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const left: { t: string; k: string }[] = [], right: { t: string; k: string }[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { left.push({ t: a[i], k: "same" }); right.push({ t: b[j], k: "same" }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) { left.push({ t: a[i], k: "removed" }); i++; }
    else { right.push({ t: b[j], k: "added" }); j++; }
  }
  while (i < n) left.push({ t: a[i++], k: "removed" });
  while (j < m) right.push({ t: b[j++], k: "added" });
  return { left, right };
}
