import { api, type CaseRow, type Project, type RunSummary, type Suite } from "../../api";

/**
 * The project library as the classic Projects screen reads it (app.js loadProjects + loadHistory):
 * /api/projects, /api/suites, /api/cases?unfiled=1 and /api/runs, each with the same soft-failure
 * rule. A FAILED /api/projects means "no database", not "no projects": the page then falls back to
 * recent runs grouped by address, read-only (`unavailable`).
 */
export interface LibProject {
  id: string; name: string; baseUrl?: string; runCount?: number; caseCount?: number;
}
export interface LibRun extends RunSummary { artifactsAvailable?: boolean }
export interface Library {
  projects: LibProject[]; unavailable: boolean; suites: Suite[]; unfiled: CaseRow[]; runs: LibRun[];
}

export async function loadLibrary(): Promise<Library> {
  const [projects, suites, unfiled, runs] = await Promise.all([
    api<{ projects?: Project[] }>("/api/projects")
      .then((d) => (Array.isArray(d?.projects) ? d.projects : null)).catch(() => null),
    api<{ suites?: Suite[] }>("/api/suites")
      .then((d) => (Array.isArray(d?.suites) ? d.suites : [])).catch(() => [] as Suite[]),
    api<{ cases?: CaseRow[] }>("/api/cases?unfiled=1")
      .then((d) => (Array.isArray(d?.cases) ? d.cases : [])).catch(() => [] as CaseRow[]),
    api<LibRun[]>("/api/runs").then((d) => (Array.isArray(d) ? d : [])).catch(() => [] as LibRun[]),
  ]);
  return {
    projects: projects ?? groupRunsByUrl(runs),
    unavailable: projects === null,
    suites, unfiled, runs,
  };
}

/** MUST match app.js normalizeUrlKey (and src/server/projects.ts normaliseUrlKey). */
export const normalizeUrlKey = (url?: string | null): string =>
  (url || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "").toLowerCase();

/** app.js groupRunsByUrl: the no-database fallback's pseudo-projects. */
export function groupRunsByUrl(runs: LibRun[]): LibProject[] {
  const groups = new Map<string, LibProject>();
  for (const r of runs) {
    const key = normalizeUrlKey(r.url) || "(no url)";
    if (!groups.has(key)) groups.set(key, { id: key, name: r.url || "(no url)", runCount: 0 });
    groups.get(key)!.runCount! += 1;
  }
  return [...groups.values()];
}

/** app.js pvRunsFor: recent runs at a project's address. */
export function runsFor(p: LibProject, runs: LibRun[]): LibRun[] {
  const keys = new Set([normalizeUrlKey(p.name) || p.name, normalizeUrlKey(p.baseUrl)].filter(Boolean));
  return runs.filter((r) => keys.has(normalizeUrlKey(r.url)));
}

export const displayUrl = (url?: string | null): string =>
  (url || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");

/** app.js shortProjectName, verbatim. */
export function shortProjectName(name?: string | null): string {
  const n = String(name ?? "").trim().replace(/^https?:\/\//i, "").replace(/^www\./i, "").replace(/\/+$/, "");
  const sf = /^([a-z0-9-]+?)(?:-dev-ed)?\.(?:(scratch|sandbox|develop|trailblaze)\.)?(my\.salesforce(?:-setup)?\.com|lightning\.force\.com|my\.site\.com)$/i.exec(n);
  if (!sf) return n || String(name ?? "");
  if (/^my\.site\.com$/i.test(sf[3])) return `${sf[1]} (site)`;
  const kind = ({ scratch: "scratch org", sandbox: "sandbox", develop: "dev org", trailblaze: "playground" } as Record<string, string>)[(sf[2] ?? "").toLowerCase()];
  return kind ? `${sf[1]} (${kind})` : sf[1];
}

/** app.js RUN_STATUS / statusKey / statusText (the run badges, not the case badges). */
const RUN_STATUS: Record<string, { key: string; label: string }> = {
  passed: { key: "passed", label: "Passed" },
  failed: { key: "failed", label: "Failed" },
  blocked: { key: "blocked", label: "Blocked" },
  error: { key: "blocked", label: "Couldn't run" },
  truncated: { key: "unconfirmed", label: "Unconfirmed" },
  truncated_no_assertion: { key: "unconfirmed", label: "Unconfirmed" },
  incomplete: { key: "unconfirmed", label: "Unconfirmed" },
  no_cases_selected: { key: "blocked", label: "Nothing selected" },
  running: { key: "running", label: "Running" },
  pending: { key: "pending", label: "Queued" },
  draft: { key: "draft", label: "Not run yet" },
};
export const runStatusKey = (s?: string | null): string => (RUN_STATUS[s ?? ""] || RUN_STATUS.pending).key;
export const runStatusText = (s?: string | null): string => (RUN_STATUS[s ?? ""] || { label: s ?? "" }).label;

/** app.js caseHash. */
export const caseHash = (projectId: string | null | undefined, caseId: string): string =>
  projectId
    ? `#/projects/${encodeURIComponent(projectId)}/cases/${encodeURIComponent(caseId)}`
    : `#/case/${encodeURIComponent(caseId)}`;

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** app.js pvMatcher: every typed word must appear, case-insensitively. */
export function matcher(q: string): (text?: string | null) => boolean {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return (text) => {
    const t = String(text || "").toLowerCase();
    return words.every((w) => t.includes(w));
  };
}

/**
 * app.js confirmProjectDelete: the deletion-impact counts, then the type-the-name gate. A failed
 * impact call still offers the delete, saying the impact is unknown.
 */
export async function confirmProjectDelete(p: LibProject): Promise<boolean> {
  let impact: { suites: number; cases: number; runs: number } | null = null;
  try {
    impact = await api(`/api/projects/${encodeURIComponent(p.id)}/deletion-impact`);
  } catch { /* non-fatal on purpose */ }
  const n = (x: number, one: string, many: string) => `${x} ${x === 1 ? one : many}`;
  const lines = impact
    ? [
        impact.suites || impact.cases
          ? `This permanently deletes ${n(impact.suites, "suite", "suites")} and ` +
            `${n(impact.cases, "saved case", "saved cases")}, including every stored version.`
          : `This project has no suites or saved cases.`,
        impact.runs
          ? `${n(impact.runs, "run", "runs")} will be kept but unfiled — the artifacts stay, ` +
            `but only admins and owners will still see them.`
          : `It holds no runs.`,
      ]
    : ["Could not read what this project holds, so this may delete suites and saved cases."];
  const typed = prompt(
    `Delete the project "${p.name}"?\n\n${lines.join("\n\n")}\n\n` +
    `This cannot be undone. Type the project name to confirm:`,
  );
  return typed !== null && typed.trim() === p.name;
}

export const JSON_HEADERS = { "Content-Type": "application/json" };
