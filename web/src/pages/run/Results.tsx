/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { api, type Project, type Suite } from "../../api";
import { Busy, Icon, STATUS_ICON } from "./icons";
import { authFetch } from "./model";
import {
  BLOCKED_IMAGE_DESC, CASE_BADGE, CATEGORY_REASON, NARRATIVE_LEAD_IN, STATUS_LABEL, STEP_TRAIL_NOTE,
  buildStepNarrative, describeScreenshot, readableStep, reportStepsOf, runTokensOf, stepOutcomes,
} from "./text";

/**
 * The suite results area of the Run page (public/app.js renderSuiteResults / renderCaseCard /
 * loadCaseDetails / openSaveCasePanel / the screenshot modal), plus the save panel the single-run
 * "Save to library" slot shares.
 */

// ------------------------------------------------------------------ screenshot modal

export function ScreenshotModal({ src, label, onClose }: { src: string; label: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previously = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "Tab") { e.preventDefault(); closeRef.current?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      // Focus back to whatever opened the modal, so a keyboard user isn't dropped at the top.
      if (previously && typeof previously.focus === "function") previously.focus();
    };
  }, [onClose]);
  return (
    <div className="screenshot-modal" role="dialog" aria-modal="true" aria-label="Screenshot, full size"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <span className="screenshot-modal-label">{label}</span>
      <button ref={closeRef} className="screenshot-modal-close" type="button" aria-label="Close" onClick={onClose}>Close</button>
      <img className="screenshot-modal-img" src={src} alt={label || "Screenshot, full size"} />
    </div>
  );
}

// ------------------------------------------------------------------ save to library

/** Same panel for a suite card ({runId, caseId, title}) and the single run ("case-0"). Same POST. */
export function SaveCasePanel({ runId, caseId, title }: { runId: string; caseId: string; title: string }) {
  const [state, setState] = useState<{ loading: boolean; error?: string; projects: Project[]; suites: Suite[] }>({ loading: true, projects: [], suites: [] });
  const [projectId, setProjectId] = useState("");
  const [suiteId, setSuiteId] = useState("");
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string; caseId?: string; projectId?: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api<{ projects?: Project[] }>("/api/projects").then((r) => r.projects ?? []),
      api<{ suites?: Suite[] }>("/api/suites").then((r) => r.suites ?? []),
    ]).then(([projects, suites]) => {
      if (!alive) return;
      setState({ loading: false, projects, suites });
      setProjectId(projects[0]?.id ?? "");
    }).catch((err) => alive && setState({ loading: false, error: err instanceof Error ? err.message : String(err), projects: [], suites: [] }));
    return () => { alive = false; };
  }, []);

  if (state.loading) return <div className="case-save-panel"><p className="hrow-meta"><Busy text="Loading projects…" /></p></div>;
  if (state.error) return <div className="case-save-panel"><p className="team-error">{state.error}</p></div>;
  if (!state.projects.length) return <div className="case-save-panel"><p className="team-error">You're not in any project yet, so there's nowhere to save this.</p></div>;

  // Only suites of the chosen project: the server refuses a cross-project pair.
  const suitesHere = state.suites.filter((s) => s.projectId === projectId);
  const effectiveSuite = suiteId && suiteId !== "__new" && !suitesHere.some((s) => s.id === suiteId) ? "" : suiteId;

  const createSuite = async () => {
    const name = newName.trim();
    if (!name) { nameRef.current?.focus(); return; }
    setCreating(true);
    try {
      const created = await api<Suite>("/api/suites", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectId, name }),
      });
      setState((s) => ({ ...s, suites: [...s.suites, created] }));
      setSuiteId(created.id);
      setNewName("");
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setCreating(false);
    }
  };

  const save = async () => {
    setSaving(true);
    try {
      const saved = await api<{ id: string }>(`/api/runs/${encodeURIComponent(runId)}/cases/${encodeURIComponent(caseId)}/save`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectId, title, ...(effectiveSuite ? { suiteId: effectiveSuite } : {}) }),
      });
      setFeedback({ ok: true, text: "Saved.", caseId: saved.id, projectId });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      // Re-enabled on success too, so saving into the wrong project can be retried.
      setSaving(false);
    }
  };

  return (
    <div className="case-save-panel">
      <div className="case-save-form">
        <label className="field">
          <span className="field-label">Project</span>
          <select className="team-select" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {state.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Suite</span>
          <select className="team-select" value={effectiveSuite} onChange={(e) => setSuiteId(e.target.value)}>
            <option value="">Choose a suite…</option>
            {suitesHere.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            <option value="__new">+ New suite</option>
          </select>
        </label>
        <div className="field" hidden={effectiveSuite !== "__new"}>
          <input ref={nameRef} type="text" className="team-select" placeholder="Suite name" aria-label="Name for the new suite"
            value={newName} onChange={(e) => setNewName(e.target.value)} />
          <button type="button" className="dl-btn-inline" disabled={creating} onClick={createSuite}>Create</button>
        </div>
        <button type="button" className="dl-btn" disabled={saving || !effectiveSuite || effectiveSuite === "__new"} onClick={save}>Save to library</button>
      </div>
      <p className="hrow-meta">Saved cases re-run with no AI calls at all.</p>
      <div>
        {feedback && (feedback.ok
          ? <p className="team-ok">Saved. <a href={`#/projects/${encodeURIComponent(feedback.projectId!)}/cases/${encodeURIComponent(feedback.caseId!)}`}>Open the case</a></p>
          : <p className="team-error">{feedback.text}</p>)}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ suite results

export interface SuiteSummary {
  total: number; passed: number; failed: number; truncated?: number; truncated_no_assertion?: number; blocked?: number;
  cases: any[];
}

export function SuiteResults({ suite, runId, prompt, usageLine, canSave, onZoom }: {
  suite: SuiteSummary; runId: string; prompt: string; usageLine: ReactNode; canSave: boolean;
  onZoom: (src: string, label: string) => void;
}) {
  const [gridOpen, setGridOpen] = useState(false);
  const withShots = suite.cases.filter((c) => c.screenshotUrl);
  const firstOpenRef = useRef<HTMLDivElement>(null);
  const firstOpenIdx = suite.cases.findIndex((c) => c.status === "failed" || c.status === "blocked");

  // Scroll only the first auto-expanded (failed/blocked) card into view.
  useEffect(() => { firstOpenRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, []);

  return (
    <section className="suite-results">
      <div className="suite-summary-header">
        {prompt && <p className="case-narrative-line"><b>You asked:</b> {prompt}</p>}
        <div className="suite-summary-stats">
          <span className="suite-stat">{suite.total} checks</span>
          <span className="suite-stat suite-stat-passed"><Icon name="check" size={13} /> {suite.passed} passed</span>
          <span className="suite-stat suite-stat-failed"><Icon name="x" size={13} /> {suite.failed} failed</span>
          {!!suite.truncated && <span className="suite-stat suite-stat-truncated"><Icon name="alert-triangle" size={13} /> {suite.truncated} partial</span>}
          {!!suite.truncated_no_assertion && <span className="suite-stat suite-stat-partial"><Icon name="minus-circle" size={13} /> {suite.truncated_no_assertion} unconfirmed</span>}
          {!!suite.blocked && <span className="suite-stat suite-stat-blocked"><Icon name="slash-circle" size={13} /> {suite.blocked} blocked</span>}
        </div>
        {usageLine}
      </div>
      {withShots.length > 0 && (
        <button className="screenshot-toggle" type="button" onClick={() => setGridOpen((o) => !o)}>
          {gridOpen ? <><Icon name="chevron-down" size={14} /> Hide screenshots</> : <><Icon name="image" size={14} /> View all screenshots</>}
        </button>
      )}
      {withShots.length > 0 && gridOpen && (
        <div className="screenshot-grid">
          {withShots.map((c, i) => {
            const badge = c.status === "passed" ? "badge-passed" : c.status === "failed" ? "badge-failed" : "badge-pending";
            return (
              <div className="screenshot-tile" key={c.caseId ?? i}>
                <img src={c.screenshotUrl} alt={`Case ${i + 1}`} loading="lazy" />
                <span className={`screenshot-tile-label ${badge}`}>{c.title}</span>
              </div>
            );
          })}
        </div>
      )}
      <div className="suite-case-list">
        {suite.cases.map((c, i) => (
          <CaseCard key={c.caseId ?? i} c={c} index={i} runId={runId} suite={suite} canSave={canSave} onZoom={onZoom}
            cardRef={i === firstOpenIdx ? firstOpenRef : undefined} />
        ))}
      </div>
    </section>
  );
}

interface Details { ir: any; irText: string; spec: string; diagnosis: any; results: any; raw: any; strict: boolean }

function CaseCard({ c, index, runId, suite, canSave, onZoom, cardRef }: {
  c: any; index: number; runId: string; suite: SuiteSummary; canSave: boolean;
  onZoom: (src: string, label: string) => void; cardRef?: Ref<HTMLDivElement>;
}) {
  const autoExpand = c.status === "failed" || c.status === "blocked";
  const [open, setOpen] = useState(autoExpand);
  const [details, setDetails] = useState<Details | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [shotOk, setShotOk] = useState(true);
  const [videoOk, setVideoOk] = useState(true);
  const requested = useRef(false);

  const status: string = c.status;
  const statusBadge = CASE_BADGE[status] ?? "badge-pending";
  const whyItMatters = c.whyItMatters || c.intent || c.expected || "";
  const expected = c.expected || "";
  const caseDir = `/runs/${runId}/${c.resultPath}`;
  const screenshotUrl: string = c.screenshotUrl || "";
  const specUrl = `${caseDir}/generated.spec.ts`;
  const irUrl = `${caseDir}/04-ir.json`;
  const resultUrl = `${caseDir}/05-result.json`;
  const reportUrl = `/api/runs/${encodeURIComponent(runId)}/report.html`;
  const traceUrl = `${caseDir}/artifacts`;
  const fileName = `${c.title || "test"}.spec.ts`;

  // Technical details load on first open (lazy) — including for a card that rendered open.
  useEffect(() => {
    if (!open || requested.current) return;
    requested.current = true;
    let alive = true;
    const dir = `/runs/${runId}/cases/${c.caseId}`;
    const getJson = (url: string) => authFetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    (async () => {
      try {
        const [irRes, spec, diagnosis, results] = await Promise.all([
          getJson(`${dir}/04-ir.json`),
          authFetch(`${dir}/generated.spec.ts`).then((r) => (r.ok ? r.text() : "Not found")),
          status === "failed" ? getJson(`${dir}/06-diagnosis.json`) : Promise.resolve(null),
          getJson(`${dir}/results.json`).then((r) => r ?? getJson(`/runs/${runId}/results.json`)),
        ]);
        const ir = irRes?.ir ?? irRes;
        const own = await getJson(`${dir}/05-result.json`);
        const raw = own?.raw ?? (await getJson(`/runs/${runId}/05-result.json`))?.raw ?? results;
        if (alive) setDetails({ ir, irText: ir ? JSON.stringify(ir, null, 2) : "Not found", spec, diagnosis, results, raw, strict: !own?.raw });
      } catch {
        // Details stay as "Loading…" — non-critical.
      }
    })();
    return () => { alive = false; };
  }, [open, runId, c.caseId, status]);

  const toggle = () => setOpen((o) => !o);
  const onHeaderKey = (e: KeyboardEvent) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } };
  const zoom = () => onZoom(screenshotUrl, `screenshot for case ${index + 1}`);
  const caseFromSuite = suite.cases.find((x) => x.caseId === c.caseId);
  const tokens = details ? runTokensOf(details.results, details.ir?.meta?.title) : null;

  return (
    <div className={`case-card${open ? " open" : ""}`} data-case-id={c.caseId} data-status={status} ref={cardRef}>
      <div className="case-card-header" role="button" tabIndex={0} aria-expanded={open} onClick={toggle} onKeyDown={onHeaderKey}>
        <span className={`case-status-icon ${statusBadge}`}><Icon name={STATUS_ICON[status] ?? "circle"} size={16} /></span>
        <span className="case-heading">
          <span className="case-title">{c.title}</span>
          {whyItMatters && <p className="case-intent">{whyItMatters}</p>}
          {expected && expected !== whyItMatters && <p className="case-expected"><span>What should happen:</span> {expected}</p>}
        </span>
        <span className={`case-badge ${statusBadge}`}>{STATUS_LABEL[status] ?? status}</span>
        {c.healed && status === "passed" && (
          <span className="case-badge case-badge-healed"
            title={`This failed on the first attempt; the system automatically found a fix and re-ran it, and it passed.${c.deterministicHeal ? " This fix was found deterministically, without a model call." : ""}`}>
            <Icon name="refresh" size={11} /> Fixed automatically{c.deterministicHeal && <> <Icon name="zap" size={10} /></>}
          </span>
        )}
        {c.deterministicHeal && (
          <span className="case-badge case-badge-deterministic" title="The fix was found by matching the element's structure in the crawled page model — no model call, essentially free.">
            <Icon name="zap" size={10} /> Healed deterministically
          </span>
        )}
        <span className="case-expand-icon"><Icon name="chevron-down" size={14} /></span>
      </div>
      <div className="case-card-body">
        {c.blockedBy && <p className="blocked-note">Couldn't finish: {c.blockedBy}. The screenshot below is where it stopped.</p>}
        <CaseErrorBlock c={c} screenshotUrl={screenshotUrl} />
        {details && <StepTrail c={caseFromSuite} ir={details.ir} status={status} raw={details.raw} tokens={tokens} strict={details.strict} />}
        {details && NARRATIVE_LEAD_IN[status] && caseFromSuite && <CaseNarrative c={caseFromSuite} ir={details.ir} status={status} tokens={tokens} />}
        {details && status === "failed" && details.diagnosis && <DiagnosisBlock diagnosis={details.diagnosis} />}
        {screenshotUrl && shotOk && (
          <figure className="case-screenshot">
            <img src={screenshotUrl} alt={`screenshot for case ${index + 1}`} loading="lazy" tabIndex={0} role="button"
              aria-label="View full-size screenshot" onError={() => setShotOk(false)} onClick={zoom}
              onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); zoom(); } }} />
            <figcaption>Final state — click to zoom in</figcaption>
          </figure>
        )}
        {c.videoUrl && videoOk && (
          <figure className="case-video">
            {/* keyed by URL: a <video> never re-reads a changed <source> on its own (the classic reload fix) */}
            <video key={c.videoUrl} controls preload="none" poster={screenshotUrl || undefined} onError={() => setVideoOk(false)}>
              <source src={c.videoUrl} type="video/webm" />
            </video>
            <figcaption>Recording of the run — nothing downloads until you press play</figcaption>
          </figure>
        )}
        <div className="case-downloads">
          <a href={specUrl} download={fileName} className="dl-btn"><Icon name="file-text" size={13} /> Download test script</a>
          <a href={reportUrl.replace(/\.html$/, ".pdf")} download={`test-report-${runId}.pdf`} className="dl-btn"><Icon name="file-text" size={13} /> Download report (PDF)</a>
          <a href={reportUrl} download={`test-report-${runId}.html`} className="dl-btn"><Icon name="file-text" size={13} /> Download report (HTML)</a>
          <a href={resultUrl} download="result.json" className="dl-btn"><Icon name="download" size={13} /> Raw result (JSON)</a>
          {canSave && (
            <button type="button" className="dl-btn case-save-btn" onClick={(e) => { e.stopPropagation(); setSaveOpen((o) => !o); }}>
              <Icon name="plus" size={13} /> Save case
            </button>
          )}
        </div>
        {saveOpen && <SaveCasePanel runId={runId} caseId={c.caseId} title={c.title ?? ""} />}
        <details className="case-details">
          <summary><Icon name="code" size={13} /> Technical details (for developers)</summary>
          <div className="case-details-content">
            {c.intent && <><h4>QA reasoning</h4><pre>{c.intent}</pre></>}
            {!!c.llmCalls && <><h4>Cost</h4><pre>{c.llmCalls} AI call(s), {c.llmTokens ?? 0} tokens</pre></>}
            <h4>Step-by-step test plan (JSON) <a href={irUrl} download="ir.json" className="dl-btn dl-btn-inline"><Icon name="download" size={12} /> download</a></h4>
            <pre className="case-ir">{details ? details.irText : <Busy />}</pre>
            <h4>Full test code <a href={specUrl} download={fileName} className="dl-btn dl-btn-inline"><Icon name="download" size={12} /> download</a></h4>
            <pre className="case-spec">{details ? details.spec : <Busy />}</pre>
            <h4>All files (screenshots, trace, video) <a href={traceUrl} className="dl-btn dl-btn-inline" target="_blank" rel="noreferrer"><Icon name="external-link" size={12} /> open</a></h4>
          </div>
        </details>
      </div>
    </div>
  );
}

/** What a failed case says for itself with no model call (classic renderCaseErrorBlock, TD-80). */
function CaseErrorBlock({ c, screenshotUrl }: { c: any; screenshotUrl: string }) {
  if (c.status !== "failed" && c.status !== "blocked") return null;
  if (!c.error && c.failedStep === undefined) return null;
  const where = c.failedStep !== undefined
    ? `Step ${c.failedStep}${c.failedStepTitle ? ` — ${c.failedStepTitle}` : ""}`
    : "The test stopped here";
  return (
    <div className="diag-card">
      <div className="diag-card-header">
        <span className="diag-badge">Where it stopped</span>
        <h4>{where}</h4>
      </div>
      <div className="diag-card-body">
        {c.error && <div className="diag-item"><p className="diag-text">{c.error}</p></div>}
        {screenshotUrl && <div className="diag-item"><p className="diag-text"><a href={screenshotUrl} target="_blank" rel="noopener noreferrer">Screenshot at the point it stopped</a></p></div>}
        {c.errorDetail && c.errorDetail !== c.error && (
          <details className="diag-tech-details">
            <summary>Full error (for developers)</summary>
            <code>{c.errorDetail}</code>
          </details>
        )}
      </div>
    </div>
  );
}

function CaseNarrative({ c, ir, status, tokens }: { c: any; ir: any; status: string; tokens: any }) {
  const steps = ir?.steps;
  const whatHappened = steps?.length ? buildStepNarrative(steps, status, tokens) : (c.whyItMatters || c.intent || "");
  if (!whatHappened) return null;
  const whatImage = !c.screenshotUrl ? "" : status === "blocked" ? BLOCKED_IMAGE_DESC : describeScreenshot(steps);
  return (
    <div className="case-narrative">
      <p className="case-narrative-line"><b>What happened:</b> {whatHappened}</p>
      {whatImage && <p className="case-narrative-line"><b>What the image shows:</b> {whatImage}</p>}
    </div>
  );
}

function DiagnosisBlock({ diagnosis }: { diagnosis: any }) {
  const whatWrong = diagnosis.explanation || "The test hit a problem it couldn't get past.";
  const why = CATEGORY_REASON[diagnosis.category] || CATEGORY_REASON.other;
  const bullets: string[] = diagnosis.suggestedFix
    ? [diagnosis.suggestedFix, "Run the whole test again — if this was a timing hiccup (a slow page, a flaky request), it may pass next time."]
    : ["Try re-running with a more specific prompt, or check if the site has changed since the last discovery."];
  return (
    <div className="case-diagnosis-block">
      <div className="diag-card">
        <div className="diag-card-header">
          <span className="diag-badge">What happened</span>
          <h4>{whatWrong}</h4>
        </div>
        <div className="diag-card-body">
          <div className="diag-item"><p className="diag-text"><b>Why it happened:</b> {why}</p></div>
          <div className="diag-item diag-fix-box">
            <span className="diag-label fix-label">💡 What you can do</span>
            <ul className="diag-fix-list">{bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
          </div>
          <details className="diag-tech-details">
            <summary>Technical details (for developers)</summary>
            <code>Category: {diagnosis.category || "unknown"} · Failing step: {diagnosis.failingStepId || "unknown"}</code>
          </details>
        </div>
      </div>
    </div>
  );
}

/** The step trail (D-81): green up to where the run got, red from the step it failed on. */
function StepTrail({ c, ir, status, raw, tokens, strict }: { c: any; ir: any; status: string; raw: any; tokens: any; strict: boolean }) {
  const steps: any[] | undefined = ir?.steps;
  if (!steps?.length) return null;
  const reportSteps = reportStepsOf(raw, ir?.meta?.title, strict);
  const outcomes = stepOutcomes(steps, reportSteps, c, status);
  if (!outcomes) return null;
  const failedIdx = outcomes.indexOf("failed");
  const errLine = failedIdx >= 0
    ? String(reportSteps?.[failedIdx]?.error?.message ?? c?.error ?? "")
      // eslint-disable-next-line no-control-regex
      .replace(/\u001b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? ""
    : "";
  const cut = (status === "truncated" || status === "truncated_no_assertion") && failedIdx < 0;
  const ran = outcomes.filter((o) => o === "ok").length;
  return (
    <div data-step-trail="">
      <p data-step-head=""><b>Steps</b> <span>{ran} of {steps.length} done{failedIdx >= 0 ? `, failed at step ${failedIdx + 1}` : cut ? ", then stopped" : ""}</span></p>
      <ol>
        {steps.map((s, i) => (
          <li key={i} data-step={outcomes[i]}>
            <span data-step-n="">{i + 1}</span>
            <span data-step-text="">{readableStep(s, tokens)}{outcomes[i] === "failed" && errLine && <small>{errLine}</small>}</span>
            <span data-step-note="">{STEP_TRAIL_NOTE[outcomes[i]]}</span>
          </li>
        ))}
        {cut && (
          <li data-step="failed">
            <span data-step-n="">{steps.length + 1}</span>
            <span data-step-text="">The rest of the test could not be built, so it never ran{ir?.meta?.truncationNote && <small>{ir.meta.truncationNote}</small>}</span>
            <span data-step-note="">Stopped here</span>
          </li>
        )}
      </ol>
    </div>
  );
}
