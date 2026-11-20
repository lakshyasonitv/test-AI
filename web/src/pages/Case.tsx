import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import {
  api, ApiError, classic, finalShotForRun, formatWhen,
  type CaseDetail, type CaseRun, type CaseSteps, type Project, type Suite,
} from "../api";
import { Badge, Empty, ErrorNote, Loading, Shot } from "../ui";
import {
  diffSteps, loadPermissions, nextLineId, postJson, rawJson, roleAtLeast, toast,
  type Conflict, type Estimate, type Job, type JobEvent, type Line, type Proposal,
} from "./case/lib";
import { CredentialPrompt, Spin, useLeaveGuard, type CredRequest } from "./case/parts";
import { ScriptTab } from "./case/ScriptTab";
import "./Case.css";

/**
 * A saved case — the classic case screen (public/app.js renderCaseView) in React, with the same
 * routes, request bodies and wording.
 *
 * Steps are edited as the SAME English sentences the server renders and are sent back as strings.
 * The server parses each line ONTO the step it came from (src/stages/stepText.ts — the format is
 * lossy by design), so nothing here parses a sentence. A model only ever PROPOSES (rule 6): a
 * rewrite or translation fills the editor after a person presses Apply, and still goes through
 * Save, the estimate and the re-ground like any typed edit.
 */

type Tab = "steps" | "script" | "runs";
/** Module-level like app.js's `caseTab`, so moving between cases keeps the reader's tab. */
let lastTab: Tab = "steps";

interface Editor {
  lines: Line[]; original: string; currentVersion: number; expected: string; nlSteps: boolean;
  estimate: Estimate | null; estimateError: string;
  job: Job | null; errorAt: number | null; errorMsg: string; errorKind: "" | "reach" | "ground";
  conflict: Conflict | null; askText: string; proposal: Proposal | null; notice: string;
  justSaved: boolean; needsConfirmation: string;
  saving: boolean; asking: boolean; translating: boolean;
}

interface Loaded {
  detail: CaseDetail; runs: CaseRun[]; projectName: string; suites: Suite[] | null;
  perm: { authRequired: boolean; role: string | null };
}

const linesPayload = (ed: Editor) => ed.lines.map((l) => l.text);
const isDirty = (ed: Editor | null) => !!ed && JSON.stringify(linesPayload(ed)) !== ed.original;
const displayUrl = (url?: string) => (url || "").trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
const msg = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function CasePage({ caseId }: { caseId: string }) {
  const q = encodeURIComponent(caseId);
  const [, repaint] = useReducer((x: number) => x + 1, 0);
  const [data, setData] = useState<Loaded | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [tab, setTabState] = useState<Tab>(lastTab);
  const [title, setTitle] = useState("");
  const [actionError, setActionError] = useState("");
  const [cred, setCredState] = useState<CredRequest | null>(null);

  // The editor is mutable state held in a ref (as app.js's `caseEditor`), so async callbacks —
  // the estimate, the job poll — always see the current draft, never a stale closure. Every
  // change ends in repaint().
  const edRef = useRef<Editor | null>(null);
  const credRef = useRef<CredRequest | null>(null);
  const alive = useRef(true);
  const bypass = useRef(false);
  const estimateTimer = useRef<ReturnType<typeof setTimeout>>();
  const jobTimer = useRef<ReturnType<typeof setTimeout>>();

  const setCred = (c: CredRequest | null) => { credRef.current = c; setCredState(c); };
  const setTab = (t: Tab) => { lastTab = t; setTabState(t); };

  const fetchAll = useCallback(async (): Promise<Loaded & { steps?: CaseSteps }> => {
    const [detail, steps, runs, perm] = await Promise.all([
      api<CaseDetail>(`/api/cases/${q}`),
      api<CaseSteps & { nlSteps?: boolean }>(`/api/cases/${q}/steps`),
      api<{ runs: CaseRun[] }>(`/api/cases/${q}/runs`).then((r) => r.runs ?? []).catch(() => [] as CaseRun[]),
      loadPermissions(),
    ]);
    const [projects, suites] = await Promise.all([
      api<{ projects: Project[] }>("/api/projects").then((r) => r.projects ?? []).catch(() => [] as Project[]),
      api<{ suites: Suite[] }>(`/api/suites?projectId=${encodeURIComponent(detail.projectId)}`)
        .then((r) => r.suites ?? []).catch(() => null),
    ]);
    const projectName = projects.find((p) => p.id === detail.projectId)?.name ?? "";
    return { detail, steps, runs, perm, projectName, suites };
  }, [q]);

  // ------------------------------------------------------------------ load / reload

  useEffect(() => {
    alive.current = true;
    fetchAll().then((d) => {
      if (!alive.current) return;
      const steps = d.steps as CaseSteps & { nlSteps?: boolean };
      edRef.current = {
        lines: steps.steps.map((s) => ({ id: s.id, text: s.text })),
        original: JSON.stringify(steps.steps.map((s) => s.text)),
        currentVersion: d.detail.currentVersion, expected: steps.expected ?? "",
        // Whether this server will translate loosely-typed lines — from the server, not assumed.
        nlSteps: steps.nlSteps === true,
        estimate: null, estimateError: "", job: null, errorAt: null, errorMsg: "", errorKind: "",
        conflict: null, askText: "", proposal: null, notice: "", justSaved: false, needsConfirmation: "",
        saving: false, asking: false, translating: false,
      };
      setTitle(d.detail.title);
      setData(d);
    }).catch((err) => alive.current && setLoadError(err));
    return () => {
      // Stop following a job without cancelling it server-side (app.js stopFollowingCaseJob).
      alive.current = false;
      clearTimeout(estimateTimer.current);
      clearTimeout(jobTimer.current);
    };
  }, [fetchAll]);

  /** After a save: adopt the server's canonical version and refresh the case, runs and suites. */
  const reload = useCallback(async () => {
    try {
      const d = await fetchAll();
      if (!alive.current) return;
      if (edRef.current) edRef.current.currentVersion = d.detail.currentVersion;
      setTitle(d.detail.title);
      setData(d);
    } catch { /* the screen keeps what it has */ }
  }, [fetchAll]);

  const dirty = useCallback(() => isDirty(edRef.current), []);
  useLeaveGuard(caseId, dirty, bypass);

  // ------------------------------------------------------------------ estimate

  const runEstimate = async () => {
    const ed = edRef.current;
    if (!ed || ed.job) return;
    const forLines = JSON.stringify(linesPayload(ed));
    if (!isDirty(ed)) { ed.estimate = null; ed.estimateError = ""; return repaint(); }
    try {
      const est = await postJson<Estimate>(`/api/cases/${q}/steps/estimate`,
        { steps: JSON.parse(forLines), expectedVersion: ed.currentVersion });
      // The user kept typing while this was in flight — its answer is about older text.
      if (edRef.current !== ed || JSON.stringify(linesPayload(ed)) !== forLines) return;
      ed.estimate = est;
      ed.estimateError = "";
    } catch (err) {
      if (edRef.current !== ed) return;
      ed.estimate = null;
      // A malformed sentence fails here first, the cheapest place to learn it.
      ed.estimateError = msg(err);
    }
    if (alive.current) repaint();
  };
  const scheduleEstimate = () => {
    clearTimeout(estimateTimer.current);
    estimateTimer.current = setTimeout(() => void runEstimate(), 400);
  };

  // ------------------------------------------------------------------ save

  const finishSave = (payload: any) => {
    const ed = edRef.current!;
    const steps: { id: string; text: string }[] | undefined = payload.steps ?? payload.case?.steps;
    const updated = payload.case ?? payload;
    ed.job = null;
    ed.saving = false;
    ed.lines = (steps ?? linesPayload(ed).map((t, i) => ({ id: `s${i + 1}`, text: t }))).map((s) => ({ id: s.id, text: s.text }));
    ed.original = JSON.stringify(linesPayload(ed));
    ed.currentVersion = updated.currentVersion ?? ed.currentVersion;
    ed.estimate = null;
    // A typed credential was swapped back to an ${env:...} reference before storing (TD-67).
    const credNote = payload.credentialNote ?? payload.case?.credentialNote ?? "";
    ed.notice = credNote ? `Saved as v${ed.currentVersion}. ${credNote}` : `Saved as v${ed.currentVersion}.`;
    ed.justSaved = true;
    toast(`Saved as v${ed.currentVersion}.`);
    repaint();
    void reload();
  };

  /** @param confirmNoAssertion only when the person pressed "Save without a check" (TD-89). */
  const saveSteps = async (confirmNoAssertion = false) => {
    const ed = edRef.current;
    if (!ed || !isDirty(ed)) return;
    ed.errorAt = null; ed.errorMsg = ""; ed.notice = ""; ed.conflict = null; ed.needsConfirmation = "";
    ed.saving = true;
    repaint();

    let res: { status: number; ok: boolean; body: any };
    try {
      res = await rawJson(`/api/cases/${q}/steps`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          steps: linesPayload(ed),
          // Held from the moment the case loaded: turns a silent clobber into a visible conflict.
          expectedVersion: ed.currentVersion,
          changeNote: "Edited steps",
          ...(confirmNoAssertion ? { confirmNoAssertion: true } : {}),
        }),
      });
    } catch (err) {
      ed.saving = false;
      ed.errorMsg = msg(err);
      return repaint();
    }
    if (!alive.current || edRef.current !== ed) return;
    const body = res.body ?? {};
    ed.saving = false;
    if (res.status === 409) { ed.conflict = body; return repaint(); }
    if (!res.ok) {
      ed.errorMsg = body.error || `That didn't work (${res.status}).`;
      // The server names the offending step, so the message lands on that row.
      ed.errorAt = typeof body.stepIndex === "number" ? body.stepIndex : null;
      ed.needsConfirmation = typeof body.needsConfirmation === "string" ? body.needsConfirmation : "";
      return repaint();
    }
    // Fast path: nothing pointed anywhere new, so nothing had to be verified.
    if (res.status === 200) return finishSave(body);

    // Job path (202).
    ed.job = { jobId: body.jobId, total: body.stepsToVerify ?? 0, done: 0, states: {}, seen: 0, cancelling: false };
    (body.stepIdsToVerify ?? []).forEach((id: string) => { ed.job!.states[id] = "pending"; });
    repaint();
    void pollJob();
  };

  /**
   * Follow a re-ground by polling /state every 800 ms (app.js pollCaseJob) — the SSE route exists
   * but buffers behind a tunnel, so the classic UI deliberately polls and so does this.
   */
  const pollJob = async () => {
    const ed = edRef.current;
    const job = ed?.job;
    if (!ed || !job) return;
    const base = `/api/cases/${q}/steps/jobs/${encodeURIComponent(job.jobId)}`;
    let events: JobEvent[] = [];
    try {
      events = await api<JobEvent[]>(`${base}/state`);
    } catch (err) {
      if (!alive.current || edRef.current !== ed) return;
      // Job state is in memory: a restart or expired session means nothing was saved.
      ed.job = null;
      ed.errorMsg = `Lost track of this save (${msg(err)}). Nothing was saved — press Save to try again.`;
      return repaint();
    }
    if (!alive.current || edRef.current !== ed || ed.job !== job) return;

    let terminal: JobEvent | null = null;
    for (const ev of events.slice(job.seen)) {
      job.seen++;
      if (ev.stage === "ir" && ev.data?.stepId) {
        const { stepId, done, total, phase } = ev.data as { stepId: string; done?: number; total?: number; phase?: string };
        if (phase === "walking" || phase === "grounding") {
          Object.keys(job.states).forEach((id) => { if (job.states[id] === "verifying") job.states[id] = "ok"; });
          if (job.states[stepId] !== undefined) job.states[stepId] = "verifying";
          job.done = typeof done === "number" ? done : job.done;
          if (typeof total === "number" && total) job.total = total;
        }
      }
      // The walk is parked on a login it has no credentials for — same prompt a run uses, posting
      // to the job instead of a run.
      if (ev.stage === "credentials") {
        if (ev.status === "started") {
          setCred({ jobId: job.jobId, data: ev.data as CredRequest["data"], postUrl: `${base}/credentials` });
        } else if (credRef.current?.jobId === job.jobId) {
          setCred(null);
        }
      }
      if (ev.stage === "done" || ev.stage === "error") terminal = ev;
    }

    if (!terminal) {
      jobTimer.current = setTimeout(() => void pollJob(), 800);
      return repaint();
    }

    // However it ended, an open credential form belongs to a job that no longer exists.
    if (credRef.current?.jobId === job.jobId) setCred(null);

    const d = (terminal.data ?? {}) as { saved?: boolean; cancelled?: boolean; conflict?: boolean; stepIndex?: number };
    if (terminal.stage === "done" && d.saved) return finishSave(d);

    ed.job = null;
    if (d.cancelled) {
      // Cancel is NOT an undo: nothing was written.
      ed.notice = "Cancelled — nothing was saved. Your edits are still here.";
      return repaint();
    }
    if (d.conflict) {
      ed.errorMsg = `${terminal.error || "Someone else saved while this was verifying."} Reload to see their version.`;
      return repaint();
    }
    ed.errorMsg = terminal.error || "That save could not be verified.";
    ed.errorAt = typeof d.stepIndex === "number" ? d.stepIndex : null;
    // "could not reach" means an EARLIER step is the real problem.
    ed.errorKind = /could not reach|never arrived|failed to reach/i.test(ed.errorMsg) ? "reach" : "ground";
    repaint();
  };

  const cancelJob = async () => {
    const ed = edRef.current;
    if (!ed?.job || ed.job.cancelling) return;
    ed.job.cancelling = true;
    repaint();
    try {
      await api(`/api/cases/${q}/steps/jobs/${encodeURIComponent(ed.job.jobId)}/cancel`, { method: "POST" });
    } catch { /* the poll reports whatever actually happened */ }
  };

  // ------------------------------------------------------------------ model proposals

  const translate = async () => {
    const ed = edRef.current;
    if (!ed) return;
    ed.translating = true;
    repaint();
    try {
      const proposal = await postJson<Proposal>(`/api/cases/${q}/steps/translate`, { steps: linesPayload(ed) });
      if (edRef.current !== ed) return;
      ed.proposal = proposal;
      ed.notice = "";
    } catch (err) {
      if (edRef.current !== ed) return;
      ed.proposal = null;
      ed.estimateError = msg(err);
    }
    ed.translating = false;
    if (alive.current) repaint();
  };

  const rewrite = async () => {
    const ed = edRef.current;
    if (!ed) return;
    const instruction = (ed.askText || "").trim();
    if (!instruction) { ed.errorMsg = "Say what you would like changed."; return repaint(); }
    ed.asking = true;
    repaint();
    try {
      ed.proposal = await postJson<Proposal>(`/api/cases/${q}/rewrite`, { instruction });
      ed.errorMsg = "";
    } catch (err) {
      ed.errorMsg = msg(err);
      ed.proposal = null;
    }
    ed.asking = false;
    if (alive.current) repaint();
  };

  const answerProposal = (apply: boolean) => {
    const ed = edRef.current!;
    if (apply && ed.proposal) {
      // Apply only FILLS the editor. Save, the estimate and the re-ground still follow.
      const proposed = ed.proposal.steps;
      ed.lines = proposed.map((text, i) => ({ id: ed.lines[i]?.id ?? `s${i + 1}`, text }));
      ed.notice = "Proposal applied to the editor — nothing is saved until you press Save.";
      ed.estimateError = "";
    }
    ed.proposal = null;
    scheduleEstimate();
    repaint();
  };

  // ------------------------------------------------------------------ line editing

  const editLine = (i: number, text: string) => {
    const ed = edRef.current!;
    ed.lines[i] = { ...ed.lines[i], text };
    ed.errorAt = null; ed.errorMsg = ""; ed.notice = "";
    scheduleEstimate();
    repaint();
  };
  const moveLine = (i: number, act: "up" | "down" | "del") => {
    const ed = edRef.current!;
    const lines = [...ed.lines];
    ed.errorAt = null; ed.errorMsg = ""; ed.notice = "";
    if (act === "up") [lines[i - 1], lines[i]] = [lines[i], lines[i - 1]];
    if (act === "down") [lines[i + 1], lines[i]] = [lines[i], lines[i + 1]];
    if (act === "del") lines.splice(i, 1);
    ed.lines = lines;
    scheduleEstimate();
    repaint();
  };
  const addLine = () => {
    const ed = edRef.current!;
    ed.lines = [...ed.lines, { id: nextLineId(ed.lines), text: 'Click on button "Submit"' }];
    ed.notice = "";
    scheduleEstimate();
    repaint();
  };

  const resolveConflict = (which: "theirs" | "mine") => {
    const ed = edRef.current!;
    const k = ed.conflict!;
    const theirs = (k.current?.steps ?? []).map((s) => ({ id: s.id, text: s.text }));
    if (which === "theirs") {
      ed.lines = theirs;
      ed.original = JSON.stringify(theirs.map((l) => l.text));
      ed.notice = "Using their version. Your edits are gone.";
    } else {
      // Your edits on top of theirs, saved against the version that actually won.
      ed.original = JSON.stringify(theirs.map((l) => l.text));
      ed.notice = "Your edits are on top of their version — press Save to write them.";
    }
    ed.currentVersion = k.currentVersion;
    ed.conflict = null;
    scheduleEstimate();
    repaint();
  };

  // ------------------------------------------------------------------ render

  if (loadError) return <div className="wide"><ErrorNote error={loadError} /></div>;
  const ed = edRef.current;
  if (!data || !ed) return <div className="wide"><Loading /></div>;
  const { detail, runs, projectName, suites, perm } = data;

  const canAuthor = !perm.authRequired || roleAtLeast(perm.role, "tester");
  const canDelete = !perm.authRequired || roleAtLeast(perm.role, "admin");
  const isDirtyNow = isDirty(ed);
  const busy = !!ed.job;
  const meta = (detail.ir?.meta ?? {}) as CaseDetail["ir"]["meta"] & { hasTerminalAssertion?: boolean };
  const suiteName = suites?.find((s) => detail.suiteIds?.includes(s.id))?.name ?? "";

  const renameTo = async (next: string) => {
    next = next.trim();
    if (!next || next === detail.title) { setTitle(detail.title); return; }
    try {
      await postJson(`/api/cases/${q}`, { title: next }, "PATCH");
      detail.title = next;
      toast("Renamed.");
    } catch (err) {
      setTitle(detail.title);
      setActionError(msg(err));
    }
  };

  const act = async (what: "run" | "duplicate" | "delete") => {
    setActionError("");
    try {
      if (what === "run") {
        const { runId } = await postJson<{ runId: string }>("/api/replay", { caseIds: [caseId], label: `Replayed "${detail.title}"` });
        toast("Replaying — this costs nothing, the steps are already saved.");
        location.hash = "#/run/" + runId;
        return;
      }
      if (what === "duplicate") {
        const copy = await postJson<{ id: string; projectId?: string }>(`/api/cases/${q}/duplicate`, {});
        toast("Duplicated.");
        bypass.current = true; // app.js drops its editor before navigating — no unsaved-edits prompt
        location.hash = `#/projects/${encodeURIComponent(copy.projectId ?? detail.projectId)}/cases/${encodeURIComponent(copy.id)}`;
        return;
      }
      // Says what actually goes: versions and run links cascade from the case.
      if (!confirm(
        `Delete "${detail.title}"?\n\n` +
        `This permanently deletes the case and every saved version of it, and removes it ` +
        `from every suite it is in. Past run artifacts are kept, but stop being linked to ` +
        `this case.\n\nThis cannot be undone.`
      )) return;
      await api(`/api/cases/${q}`, { method: "DELETE" });
      toast("Case deleted.");
      bypass.current = true;
      location.hash = `#/projects/${encodeURIComponent(detail.projectId)}`;
    } catch (err) {
      if (err instanceof ApiError && err.code === "sf-connection-expired") {
        setActionError(`${err.message} Run it from the classic UI, where the org connection is chosen.`);
      } else setActionError(msg(err));
    }
  };

  const addToSuite = async (suiteId: string) => {
    if (!suiteId) return;
    try {
      await postJson(`/api/suites/${encodeURIComponent(suiteId)}/cases`, { caseId });
      toast("Added to the suite.");
      detail.suiteIds = [...(detail.suiteIds ?? []), suiteId];
      repaint();
    } catch (err) { setActionError(msg(err)); }
  };

  const prevVersion = detail.versions.find((v) => v.version !== ed.currentVersion)?.version ?? 1;

  return (
    <div className="wide rx-case">
      <div className="rx-case-top">
        <a className="dl-btn-inline" href={`#/projects/${encodeURIComponent(detail.projectId)}`}>← Project</a>
        <a className="dl-btn-inline" href={classic(`#/projects/${detail.projectId}/cases/${caseId}`)}>Open in classic UI</a>
      </div>

      <div className="cd-head">
        <div className="cd-head-main">
          <div className="cd-crumb">{[projectName, suiteName].filter(Boolean).join(" / ") || "TEST CASE"}</div>
          <div className="cd-meta">
            <Badge status={detail.lastRunStatus} />
            <span className="cd-version">v{ed.currentVersion} · {detail.versions.length} version{detail.versions.length === 1 ? "" : "s"}</span>
            {isDirtyNow && <span className="case-badge badge-truncated">UNSAVED</span>}
            {meta.hasTerminalAssertion === false && (
              <span className="case-badge badge-truncated" title="This test runs to the end without verifying anything, so it can only report Passed.">NO CHECK</span>
            )}
            {detail.scriptOverridden && (
              <span className="case-badge badge-truncated" title="A hand-written script replaces this case's generated one. The steps below no longer describe what runs.">SCRIPT OVERRIDE</span>
            )}
          </div>
          <input className="cd-title" value={title} readOnly={!canAuthor} aria-label="Case title"
            onChange={(e) => setTitle(e.target.value)}
            onBlur={() => canAuthor && void renameTo(title)}
            onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
          <p className="cd-why">{meta.sourcePrompt || detail.feature || "No description recorded for this case."}</p>
        </div>
        <div className="cd-actions">
          {canAuthor && <SaveButton ed={ed} dirty={isDirtyNow} onSave={() => void saveSteps()} />}
          {canAuthor && <button type="button" className="dl-btn-inline" onClick={() => void act("duplicate")}>Duplicate</button>}
          {detail.versions.length > 1 && (
            <a className="dl-btn-inline" href={`#/compare/${encodeURIComponent(caseId)}?from=${prevVersion}&to=${ed.currentVersion}`}>Compare versions</a>
          )}
          {canDelete && <button type="button" className="dl-btn-inline" onClick={() => void act("delete")}>Delete case</button>}
          {canAuthor && <button type="button" className="run-btn lib-run-all" onClick={() => void act("run")}>▶ Run case</button>}
        </div>
      </div>

      <div>
        {ed.notice && <p className="team-ok">{ed.notice}</p>}
        {ed.errorMsg && ed.errorAt === null && <p className="team-error">{ed.errorMsg}</p>}
        {actionError && <p className="team-error">{actionError}</p>}
        {ed.needsConfirmation === "noAssertion" && (
          <button type="button" className="run-btn lib-run-all" onClick={() => void saveSteps(true)}>Save without a check</button>
        )}
      </div>

      {ed.conflict && (
        <div className="cd-conflict">
          <div className="cd-conflict-head">{ed.conflict.error || "This case changed while you were editing it."}</div>
          <div className="cd-conflict-cols">
            <div className="cd-conflict-col"><h4>Your steps</h4><ol>{linesPayload(ed).map((t, i) => <li key={i}>{t}</li>)}</ol></div>
            <div className="cd-conflict-col">
              <h4>Theirs — v{ed.conflict.currentVersion}</h4>
              <ol>{(ed.conflict.current?.steps ?? []).map((s, i) => <li key={i}>{s.text}</li>)}</ol>
            </div>
          </div>
          <div className="cd-conflict-actions">
            <button type="button" className="dl-btn-inline" onClick={() => resolveConflict("theirs")}>Discard mine, use theirs</button>
            <button type="button" className="dl-btn-inline" onClick={() => resolveConflict("mine")}>Keep mine on top of theirs</button>
          </div>
        </div>
      )}

      {suites && (
        <div className="case-suites">
          <span className="case-suites-label">Suites</span>
          {suites.filter((s) => detail.suiteIds?.includes(s.id)).map((s) => (
            <a key={s.id} className="case-suite-chip" href={`#/suite/${encodeURIComponent(s.id)}`} title={`Open ${s.name}`}>{s.name}</a>
          ))}
          {!suites.some((s) => detail.suiteIds?.includes(s.id)) && <span className="hrow-meta">Not in any suite yet.</span>}
          {canAuthor && suites.some((s) => !detail.suiteIds?.includes(s.id)) && (
            <select className="case-suite-pick" aria-label="Add this case to a suite" value=""
              onChange={(e) => void addToSuite(e.target.value)}>
              <option value="">Add to suite…</option>
              {suites.filter((s) => !detail.suiteIds?.includes(s.id)).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          )}
        </div>
      )}

      <div className="seg rx-case-tabs" role="group" aria-label="Case sections">
        <button type="button" className={`seg-btn${tab === "steps" ? " active" : ""}`} onClick={() => setTab("steps")}>Steps</button>
        <button type="button" className={`seg-btn${tab === "script" ? " active" : ""}`} onClick={() => setTab("script")}>Script</button>
        <button type="button" className={`seg-btn${tab === "runs" ? " active" : ""}`} onClick={() => setTab("runs")}>Runs &amp; versions</button>
      </div>

      {tab === "steps" && (
        <div className="cd-cols">
          <div className="cd-left">
            <div className="cd-card">
              <div className="cd-card-head">Steps — edit in plain English</div>
              {detail.scriptOverridden && (
                <p className="team-error">
                  <strong>A script override is in effect. These steps do not describe what runs.</strong>{" "}
                  This case runs a hand-written Playwright script instead of the one generated from the
                  steps below. The script is not grounded: no locator in it is verified against a real
                  discovered element, so when it breaks it fails silently rather than loudly. Editing
                  these steps is recorded and versioned, but it will not change what this case does
                  until the override is removed.
                </p>
              )}
              {ed.job && (
                <div className="cd-job">
                  <span className="cd-job-text ai-busy"><Spin />{ed.job.cancelling
                    ? "Cancelling… the page being checked has to finish first."
                    : `Verifying ${Math.min(ed.job.done + 1, ed.job.total)} of ${ed.job.total}…`}</span>
                  <button type="button" className="dl-btn-inline" disabled={ed.job.cancelling} onClick={() => void cancelJob()}>Cancel</button>
                </div>
              )}
              {ed.estimateError && (
                <div>
                  <p className="team-error">{ed.estimateError}</p>
                  {ed.nlSteps && canAuthor && (
                    <button type="button" className={`dl-btn-inline${ed.translating ? " ai-busy" : ""}`} disabled={ed.translating}
                      onClick={() => void translate()}>{ed.translating ? <><Spin /> Writing…</> : "Write it for me"}</button>
                  )}
                </div>
              )}
              <div className="cd-lines">
                {ed.lines.map((l, i) => {
                  const st = ed.job?.states?.[l.id];
                  const bad = ed.errorAt === i;
                  const verify = !busy && (ed.estimate?.stepIdsToVerify ?? []).includes(l.id);
                  const cls = ["cd-line", verify ? "will-verify" : "",
                    st === "pending" ? "is-pending" : st === "verifying" ? "is-verifying" : st === "ok" ? "is-ok" : "",
                    bad ? "is-bad" : ""].filter(Boolean).join(" ");
                  return (
                    <div key={i}>
                      <div className={cls} data-sid={l.id}>
                        <span className="cd-line-num">{i + 1}</span>
                        <input className="cd-line-input" type="text" value={l.text} disabled={!canAuthor || busy}
                          onChange={(e) => editLine(i, e.target.value)} />
                        {busy && <span className="cd-line-state">{st === "verifying" ? "verifying…" : st === "ok" ? "ok" : st === "pending" ? "pending" : ""}</span>}
                        {canAuthor && !busy && <>
                          <button type="button" className="cd-line-btn" title="Move up" disabled={i === 0} onClick={() => moveLine(i, "up")}>↑</button>
                          <button type="button" className="cd-line-btn" title="Move down" disabled={i === ed.lines.length - 1} onClick={() => moveLine(i, "down")}>↓</button>
                          <button type="button" className="cd-line-btn cd-line-del" title="Remove" onClick={() => moveLine(i, "del")}>×</button>
                        </>}
                      </div>
                      {bad && <p className="cd-line-err">{ed.errorMsg}{ed.errorKind === "reach"
                        ? " — an earlier step is the real problem; this is where the walk stopped." : ""}</p>}
                    </div>
                  );
                })}
              </div>
              {canAuthor && !busy && <button type="button" className="cd-add" onClick={addLine}>+ Add step</button>}
              <div className="cd-expected">
                <div className="cd-card-head">Expected outcome</div>
                <div className="cd-expected-value">{ed.expected || "Not recorded."}</div>
              </div>
              {canAuthor && <p className="hrow-meta" style={{ marginTop: 10 }}>{saveHint(ed, isDirtyNow)}</p>}
              <p className="hrow-meta" style={{ marginTop: 6 }} title={meta.baseUrl ?? ""}>Target: {displayUrl(meta.baseUrl)}</p>
            </div>
          </div>
          <div className="cd-right">
            {canAuthor && detail.scriptOverridden && (
              <div className="cd-card cd-card-inset">
                <div className="cd-card-label">Ask for a change</div>
                <p className="hrow-meta">Unavailable while a script override is in effect — a rewrite would
                  change the steps, and the steps are not what runs.</p>
              </div>
            )}
            {canAuthor && !detail.scriptOverridden && (
              <div className="cd-card cd-card-inset">
                <div className="cd-card-label">Ask for a change</div>
                <textarea className="cd-ask-text" placeholder="also assert the order total is unchanged" disabled={busy}
                  value={ed.askText} onChange={(e) => { ed.askText = e.target.value; repaint(); }} />
                <button type="button" className={`cd-ask-btn${ed.asking ? " ai-busy" : ""}`} disabled={busy || ed.asking}
                  onClick={() => void rewrite()}>{ed.asking ? <><Spin /> Asking…</> : "Rewrite steps"}</button>
                {ed.proposal && <ProposalView p={ed.proposal} onAnswer={answerProposal} />}
              </div>
            )}
            <LatestResult runs={runs} status={detail.lastRunStatus} lastRunAt={detail.lastRunAt} version={ed.currentVersion} />
          </div>
        </div>
      )}

      {tab === "script" && (
        <ScriptTab detail={detail} runs={runs} canAuthor={canAuthor} currentVersion={ed.currentVersion} onChanged={() => void reload()} />
      )}

      {tab === "runs" && <RunsTab detail={detail} runs={runs} caseId={caseId} currentVersion={ed.currentVersion} />}

      {cred && <CredentialPrompt key={cred.jobId} req={cred} onClose={() => setCred(null)} />}
    </div>
  );
}

// ------------------------------------------------------------------ save button + hint

/** The Save button's label states the cost on the control that spends it (app.js refreshCaseSaveAffordance). */
function SaveButton({ ed, dirty, onSave }: { ed: Editor; dirty: boolean; onSave: () => void }) {
  if (ed.saving) {
    return <button type="button" className="dl-btn-inline cd-save ai-busy" disabled><Spin /> Saving…</button>;
  }
  const verb = ed.justSaved ? "Save again" : "Save";
  const est = ed.estimate;
  let label: string;
  if (!dirty) label = ed.justSaved ? "Saved ✓" : "Save";
  else if (ed.estimateError || !est || est.instant) label = verb;
  else label = `${verb} — re-checks ${est.stepsToVerify} ${est.stepsToVerify === 1 ? "step" : "steps"} (~${est.estimatedSeconds}s)`;
  return <button type="button" className="dl-btn-inline cd-save" disabled={!dirty || !!ed.job} onClick={onSave}>{label}</button>;
}

function saveHint(ed: Editor, dirty: boolean): string {
  const est = ed.estimate;
  if (!dirty) return ed.justSaved ? "All changes saved." : "";
  if (ed.estimateError) return "";
  if (!est) return "Checking what this will cost…";
  if (est.instant) return "No steps need re-checking.";
  const s = est.stepsToVerify === 1 ? "step" : "steps";
  // maxLlmCalls is a CEILING; grounding is DOM-first and usually spends none.
  const cost = est.maxLlmCalls
    ? `Opens the site to re-check the marked ${s} · up to ${est.maxLlmCalls} model call${est.maxLlmCalls === 1 ? "" : "s"}.`
    : `Opens the site to re-check the marked ${s}.`;
  return est.needsCredentials ? `${cost} The step is behind a login, so this will sign in first.` : cost;
}

// ------------------------------------------------------------------ proposal

function ProposalView({ p, onAnswer }: { p: Proposal; onAnswer: (apply: boolean) => void }) {
  const { left, right } = diffSteps(p.before ?? [], p.steps ?? []);
  const rows: { k: "del" | "add" | "same"; t: string }[] = [];
  left.forEach((l) => { if (l.k === "removed") rows.push({ k: "del", t: l.t }); });
  right.forEach((r) => rows.push({ k: r.k === "added" ? "add" : "same", t: r.t }));
  // A translation and a rewrite deserve different scrutiny, so the heading says which this is.
  const translated = Array.isArray(p.translatedIndexes);
  return (
    <div className="cd-proposal">
      <p className="cd-proposal-note">{translated
        ? `Re-worded line${p.translatedIndexes!.length === 1 ? "" : "s"} ${p.translatedIndexes!.map((i) => i + 1).join(", ")} — the rest is untouched.`
        : "Proposed change"}</p>
      {p.note && <p className="cd-proposal-note">{p.note}</p>}
      <div className="cd-diff">
        {rows.map((r, i) => <div key={i} className={`cd-diff-line cd-diff-${r.k}`}>{r.t}</div>)}
      </div>
      <div className="cd-proposal-actions">
        <button type="button" className="dl-btn-inline" onClick={() => onAnswer(true)}>Apply to editor</button>
        <button type="button" className="dl-btn-inline" onClick={() => onAnswer(false)}>Discard</button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ latest result

/** The newest run whose screenshot still exists (up to 5 back), labelled when it is an older one. */
function LatestResult({ runs, status, lastRunAt, version }: { runs: CaseRun[]; status?: string | null; lastRunAt?: string | null; version: number }) {
  const [state, setState] = useState<{ shot: string; run: CaseRun | null; done: boolean }>({ shot: "", run: null, done: false });
  useEffect(() => {
    let alive = true;
    (async () => {
      for (const r of runs.slice(0, 5)) {
        const shot = await finalShotForRun(r).catch(() => "");
        if (shot) { if (alive) setState({ shot, run: r, done: true }); return; }
      }
      if (alive) setState({ shot: "", run: null, done: true });
    })();
    return () => { alive = false; };
  }, [runs]);
  const last = runs[0];
  const label = state.run && state.run === last
    ? `case ${state.run.caseIndex} · final screenshot`
    : `from an earlier run, ${state.run?.ranAt ? formatWhen(state.run.ranAt) : state.run?.runId} · final screenshot`;
  return (
    <div className="cd-card">
      <div className="cd-card-head">Latest result</div>
      <div className="cd-meta">
        <Badge status={status} />
        <span className="hrow-meta">{last
          ? `${last.ranAt ? formatWhen(last.ranAt) : ""} · v${version} · ${last.runId}`
          : lastRunAt ? formatWhen(lastRunAt) : "Never run"}</span>
      </div>
      {!last && <div className="cd-shot"><span className="cd-shot-label">no screenshot yet</span></div>}
      {last && !state.done && <Loading text="Loading screenshot…" />}
      {last && state.done && state.shot && state.run && (
        <>
          <Shot src={state.shot} label={label} maxWidth={520} />
          {state.run !== last && <p className="hrow-meta" style={{ margin: "6px 0 0" }}>
            The latest run's screenshot was not kept; this one is from {state.run.ranAt ? formatWhen(state.run.ranAt) : state.run.runId}.</p>}
        </>
      )}
      {last && state.done && !state.shot && (
        <div className="cd-shot"><span className="cd-shot-label">No screenshot kept for this run (it ran before screenshots were stored). Run the case again to get one.</span></div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ runs & versions

function RunsTab({ detail, runs, caseId, currentVersion }: { detail: CaseDetail; runs: CaseRun[]; caseId: string; currentVersion: number }) {
  // The case version a run executed: the newest version saved at or before the run started.
  const versionAt = (ranAt: string | null): number | null => {
    const t = ranAt ? Date.parse(ranAt) : NaN;
    if (!Number.isFinite(t)) return null;
    let best: number | null = null;
    for (const v of detail.versions) {
      const s = v.savedAt ? Date.parse(v.savedAt) : NaN;
      if (Number.isFinite(s) && s <= t && (best == null || v.version > best)) best = v.version;
    }
    return best;
  };
  return (
    <div className="cd-cols">
      <div className="cd-left" style={{ flex: "1 1 320px" }}>
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="cd-script-head"><span className="cd-card-head" style={{ margin: 0 }}>Previous runs</span></div>
          {!runs.length && <Empty>No runs recorded for this case yet. Run history is indexed from the first replay after the
            case library shipped, so older runs will not appear here.</Empty>}
          {runs.map((r) => <RunRow key={`${r.runId}:${r.caseIndex}`} run={r} version={versionAt(r.ranAt)} />)}
        </div>
      </div>
      <div className="cd-right" style={{ flex: "1 1 300px" }}>
        <div className="panel" style={{ padding: 0, overflow: "hidden" }}>
          <div className="cd-script-head"><span className="cd-card-head" style={{ margin: 0 }}>Versions</span></div>
          {!detail.versions.length && <Empty>No version history yet.</Empty>}
          {detail.versions.map((v) => (
            <div className="hrow" key={v.version}>
              <span className="case-badge badge-pending">v{v.version}</span>
              <div className="hrow-main">
                <div className="hrow-label">{v.changeNote || "No note"}</div>
                <div className="hrow-meta">{formatWhen(v.savedAt)}</div>
              </div>
              <div className="hrow-actions">
                {v.version === currentVersion
                  ? <span className="hrow-meta">current</span>
                  : <a className="dl-btn-inline" href={`#/compare/${encodeURIComponent(caseId)}?from=${v.version}&to=${currentVersion}`}>Compare with current</a>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function RunRow({ run, version }: { run: CaseRun; version: number | null }) {
  const [shot, setShot] = useState("");
  const [exists, setExists] = useState(false);
  useEffect(() => {
    let alive = true;
    // The report is built from the run's files, so it is offered only while they still exist.
    fetch(`/runs/${encodeURIComponent(run.runId)}/${run.resultPath}/05-result.json`, { method: "HEAD" })
      .then((x) => alive && setExists(x.ok)).catch(() => {});
    finalShotForRun(run).then((s) => alive && setShot(s)).catch(() => {});
    return () => { alive = false; };
  }, [run]);
  const id = encodeURIComponent(run.runId);
  return (
    <div className="hrow">
      <Badge status={run.status} />
      <div className="hrow-main">
        <div className="hrow-label">{formatWhen(run.ranAt) || run.runId}{version ? ` · v${version}` : ""}</div>
        <div className="hrow-meta">{run.runId} · {run.resultPath}</div>
        {shot && <Shot src={shot} label={`${formatWhen(run.ranAt) || run.runId} · final screenshot`} maxWidth={240} />}
      </div>
      <div className="hrow-actions">
        <a className="dl-btn-inline" href={`#/run/${id}`}>Open run</a>
        {exists && <a className="dl-btn-inline" href={`/api/runs/${id}/report.pdf?view=1`} target="_blank" rel="noopener">Report (PDF)</a>}
        {exists && <a className="dl-btn-inline" href={`/api/runs/${id}/report.xlsx`} download={`test-report-${run.runId}${version ? `-v${version}` : ""}.xlsx`}>Report (Excel)</a>}
      </div>
    </div>
  );
}
