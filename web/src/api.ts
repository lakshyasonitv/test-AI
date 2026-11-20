/**
 * Talking to the Testbench server — the same routes and the same session as the classic UI.
 *
 * The classic UI keeps the signed-in session in localStorage under "testbench.session" and sends
 * it as a Bearer token; it also writes the sb-access-token cookie that <img> requests carry. This
 * app is served from the same origin, so it reads that same session: signing in once (in either
 * UI) signs in both. Nothing here changes a route's request or response.
 */

const SESSION_KEY = "testbench.session";

interface StoredSession { token?: string; email?: string }

export function session(): StoredSession {
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) ?? "{}") ?? {}; } catch { return {}; }
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) { super(message); }
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  const { token } = session();
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  if (res.status === 204) return null as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error || `That didn't work (${res.status}).`, res.status, body.code);
  return body as T;
}

// ------------------------------------------------------------------ shapes the server returns

export interface Project { id: string; name: string; baseUrl: string; runCount: number; caseCount: number }
export interface Suite { id: string; projectId: string; name: string; caseCount: number }
export interface CaseRow {
  id: string; projectId: string; title: string; feature?: string; currentVersion: number;
  sourceRunId?: string | null; lastRunStatus?: string | null; lastRunAt?: string | null; updatedAt?: string;
}
export interface CaseVersion { version: number; changeNote?: string; savedBy?: string; savedAt?: string }
export interface CaseDetail extends CaseRow {
  ir: { meta: { title?: string; sourcePrompt?: string; baseUrl?: string; feature?: string }; steps: unknown[] };
  versions: CaseVersion[]; suiteIds: string[]; scriptOverridden?: boolean;
}
export interface CaseSteps { caseId: string; currentVersion: number; expected: string; steps: { id: string; text: string }[] }
export interface CaseRun { runId: string; caseIndex: number; status: string | null; ranAt: string | null; resultPath: string }
export interface SuiteOverview {
  cases: { caseId: string; lastRun: { runId: string; ranAt: string | null; status: string | null; screenshotUrl: string } | null }[];
  runs: { runId: string; ranAt: string | null; total: number; passed: number }[];
}
export interface RunSummary {
  runId: string; url?: string; prompt?: string; status: string; startedAt?: number;
  suite?: { total: number; passed: number; failed: number } | null;
}

// ------------------------------------------------------------------ small helpers shared by pages

const STATUS_LABEL: Record<string, string> = {
  passed: "Passed", failed: "Failed", error: "Error", incomplete: "Unconfirmed",
  truncated: "Partial", truncated_no_assertion: "Unconfirmed", blocked: "Blocked",
};
const CASE_BADGE: Record<string, string> = {
  passed: "badge-passed", failed: "badge-failed", blocked: "badge-blocked",
  truncated: "badge-truncated", truncated_no_assertion: "badge-partial",
};
/** Same class names and words as the classic UI's caseBadgeClass / caseStatusLabel. */
export const badgeClass = (s?: string | null): string => (s && CASE_BADGE[s]) || "badge-pending";
export const statusLabel = (s?: string | null): string => (s ? STATUS_LABEL[s] ?? s : "Not run yet");
export const formatWhen = (ts?: string | number | null): string => {
  if (ts == null || ts === "") return "";
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? String(ts) : d.toLocaleString();
};

/**
 * One run's final screenshot for a case, or "" — the classic UI's finalShotForRun: the case's own
 * 05-result.json first, then the run's 07-suite-summary.json row for that case's index.
 */
export async function finalShotForRun(run: CaseRun): Promise<string> {
  const base = `/runs/${encodeURIComponent(run.runId)}`;
  const json = (u: string) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const result = await json(`${base}/${run.resultPath}/05-result.json`);
  if (result?.screenshotUrl) return String(result.screenshotUrl);
  const summary = await json(`${base}/07-suite-summary.json`);
  const row = summary?.cases?.find?.((x: { caseId?: string }) => x.caseId === `case-${run.caseIndex}`);
  return row?.screenshotUrl ? String(row.screenshotUrl) : "";
}

/** A link into the classic UI, for anything not built in React yet. */
export const classic = (hash: string): string => `/${hash.startsWith("#") ? hash : "#" + hash}`;
