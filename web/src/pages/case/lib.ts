import { api, session } from "../../api";

/**
 * Helpers for the Case page's editor. Nothing here parses a step sentence: the server owns both
 * directions of the English format (src/stages/stepText.ts) and parses each line ONTO the step it
 * came from. A second parser here would show one sentence and save another (TD-07).
 */

export interface Line { id: string; text: string }

export interface Estimate {
  instant?: boolean; stepsToVerify?: number; estimatedSeconds?: number; maxLlmCalls?: number;
  needsCredentials?: boolean; stepIdsToVerify?: string[];
}

export interface Proposal { before: string[]; steps: string[]; note?: string; translatedIndexes?: number[] }

export interface Conflict { error?: string; currentVersion: number; current?: { steps?: { id: string; text: string }[] } }

export interface Job {
  jobId: string; total: number; done: number; states: Record<string, "pending" | "verifying" | "ok">;
  seen: number; cancelling: boolean;
}

export interface JobEvent { stage: string; status?: string; error?: string; data?: Record<string, unknown> & { stepId?: string } }

/**
 * A request whose non-2xx body matters (409 conflict, 400 with stepIndex, 202 job). `api()` throws
 * those away, so the save path reads the response itself — with the same Bearer header `api()` adds.
 */
export async function rawJson(path: string, init: RequestInit = {}): Promise<{ status: number; ok: boolean; body: any }> {
  const headers = new Headers(init.headers);
  const { token } = session();
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  const res = await fetch(path, { ...init, headers });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, body };
}

export const postJson = <T,>(path: string, body: unknown, method = "POST") =>
  api<T>(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** A fresh line id that cannot collide — ids are what failing-step reporting names. (app.js nextLineId) */
export function nextLineId(lines: Line[]): string {
  const used = new Set(lines.map((l) => l.id));
  let n = lines.length + 1;
  while (used.has(`s${n}`)) n++;
  return `s${n}`;
}

/** Longest-common-subsequence diff over step lines (app.js diffSteps), so an insert shifts nothing. */
export function diffSteps(a: string[], b: string[]) {
  const n = a.length, m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const left: { t: string; k: "same" | "removed" }[] = [];
  const right: { t: string; k: "same" | "added" }[] = [];
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

/** The classic UI's toast (same `.toast` element and timing). Survives a navigation away. */
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function toast(message: string): void {
  let el = document.getElementById("rx-case-toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "rx-case-toast";
    el.className = "toast hidden";
    el.setAttribute("role", "status");
    el.setAttribute("aria-live", "polite");
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el!.classList.add("hidden"), 3200);
}

const ROLE_RANK: Record<string, number> = { viewer: 1, tester: 2, admin: 3, owner: 4 };
export const roleAtLeast = (actual: string | null | undefined, required: string) =>
  (ROLE_RANK[actual ?? ""] || 0) >= (ROLE_RANK[required] || 0);

/**
 * What the UI draws for this person — app.js's `canAuthor` / `canDelete`. With auth off every
 * control shows (the server substitutes a local owner); with it on, the role from /api/auth/me.
 * Hiding a button is a courtesy: every action is enforced server-side.
 */
export async function loadPermissions(): Promise<{ authRequired: boolean; role: string | null }> {
  const cfg = await api<{ authEnabled?: boolean }>("/api/auth/config").catch(() => ({ authEnabled: false }));
  if (!cfg.authEnabled) return { authRequired: false, role: null };
  const me = await api<{ role?: string }>("/api/auth/me").catch(() => null);
  return { authRequired: true, role: me?.role ?? null };
}
