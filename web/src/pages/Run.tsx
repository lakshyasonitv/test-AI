/* eslint-disable @typescript-eslint/no-explicit-any */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, classic } from "../api";
import { CredentialPrompt } from "./run/Credentials";
import { GatePanel } from "./run/Gate";
import { Icon } from "./run/icons";
import {
  PHASES, applyEvent, authFetch, enterpriseDiagnostic, hideGate, newModel, verdictFor,
  type RunModel, type StageStatus, type Verdict,
} from "./run/model";
import { SaveCasePanel, ScreenshotModal, SuiteResults, type SuiteSummary } from "./run/Results";
import { fmtTokens, readableStep, runTokensOf } from "./run/text";

/**
 * One run, live: the classic UI's #/run/<runId> view (public/app.js connectToRun + applyEvent +
 * index.html's view-run section), with the same routes, request bodies and wording.
 *
 * It polls GET /api/runs/:id/state once a second — the UI polls, it never streams — and folds the
 * event list into the phase cards, the credential prompt, the case-selection gate, live suite
 * progress and, on the terminal `done`/`error` event, the verdict and results. Polling stops on
 * that terminal event, on a 401/403/404 (retrying cannot fix those), and when the page unmounts.
 * After a failed poll the next good read replays the whole stream from zero, as the classic one does.
 *
 * Not ported (needs state only the classic tab has): the Pro spec-warnings panel, which exists only
 * for a run the same classic tab started in Pro mode (an in-memory map there) — a link to the
 * classic page is shown instead.
 */
export function RunPage({ runId }: { runId: string }) {
  // A new run id is a new page: every piece of run-scoped state starts again (classic resetRunUI).
  return <RunView key={runId} runId={runId} />;
}

const PHASE_LOOK: Record<StageStatus, { cls: string; text: string; ic: string }> = {
  started: { cls: "running", text: "WORKING", ic: "loader" },
  completed: { cls: "done", text: "DONE", ic: "check" },
  failed: { cls: "failed", text: "FAILED", ic: "x" },
  pending: { cls: "pending", text: "PENDING", ic: "clock" },
};

const ROLE_RANK: Record<string, number> = { viewer: 1, tester: 2, admin: 3, owner: 4 };

/** Save case is offered to testers and above (the server refuses anyone lower regardless).
 *  Sign-in off, or the role not known yet: nothing is restricted — as the classic UI. */
function useCanSaveCase(): boolean {
  const [ok, setOk] = useState(true);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const cfg = await api<{ authEnabled?: boolean }>("/api/auth/config");
        if (!cfg?.authEnabled) return;
        const me = await api<{ role?: string }>("/api/auth/me");
        if (alive && me?.role && (ROLE_RANK[me.role] || 0) < ROLE_RANK.tester) setOk(false);
      } catch { /* unknown role restricts nothing; the server enforces */ }
    })();
    return () => { alive = false; };
  }, []);
  return ok;
}

function RunView({ runId }: { runId: string }) {
  const model = useRef<RunModel>(newModel());
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);
  const [stopped, setStopped] = useState<401 | 403 | 404 | null>(null);
  const [credAnswered, setCredAnswered] = useState<number | null>(null);
  const [zoom, setZoom] = useState<{ src: string; label: string } | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const canSaveCase = useCanSaveCase();

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let seen = 0;
    let fails = 0;
    model.current = newModel();
    const ctx = { runId, alive: () => alive, bump };

    const tick = async () => {
      let done = false;
      try {
        const res = await authFetch(`/api/runs/${runId}/state`);
        if (!alive) return;
        // The answers retrying cannot fix: stop, and say which (classic stopRunPolling).
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          const m = model.current;
          m.finalVisible = true;
          m.verdictOverride = res.status === 401
            ? { cls: "incomplete", ic: "alert-triangle", head: "Your session expired", detail: "Sign in again to pick this run back up where it left off." }
            : { cls: "incomplete", ic: "alert-triangle", head: "This run is no longer available", detail: "It may have been deleted, or your account may not have access to it." };
          setStopped(res.status);
          bump();
          return;
        }
        const events = await res.json();
        if (!alive) return;
        if (!Array.isArray(events)) throw new Error("bad payload");
        // Recovery replay: after any failed read, throw the view away and re-apply from zero.
        if (fails > 0) { model.current = newModel(); seen = 0; }
        for (const event of events.slice(seen)) {
          if (applyEvent(model.current, event, ctx)) done = true;
        }
        seen = events.length;
        fails = 0;
      } catch {
        if (!alive) return;
        if (++fails >= 5) {
          model.current.finalVisible = true;
          model.current.verdictOverride = { cls: "incomplete", ic: "alert-triangle", head: "Lost contact with the server",
            detail: "Still trying to reconnect — the run may still be going." };
        }
      }
      bump();
      if (!alive || done) return;
      timer = setTimeout(tick, 1000);
    };
    void tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [runId, bump]);

  const m = model.current;
  const t = m.terminal;
  const suite: SuiteSummary | null = t?.data?.suite?.cases?.length ? t.data.suite : null;
  const healed = suite ? suite.cases.filter((c) => c.healed).length : 0;
  const meta = suite
    ? [m.metaBase, `${suite.passed ?? 0} of ${suite.total ?? suite.cases.length} passed`, healed ? `${healed} healed` : ""].filter(Boolean).join(" · ")
    : m.metaBase;
  const verdict: Verdict | null = m.verdictOverride ?? (t ? verdictFor(t.data, t.stage, t.error) : null);
  const credOpen = m.cred && m.cred.key !== credAnswered ? m.cred : null;
  const canSaveRun = m.finished && !m.isReplay && !suite;
  const test = t?.data?.test;
  const ir = t?.data?.ir;
  const testTitle = test?.title || ir?.meta?.title || "";

  return (
    <div className="wide">
      <div>
        <div className="eyebrow">RUN</div>
        <h1 className="run-title">{m.prompt}</h1>
        <div className="eyebrow">{meta}</div>
        {/* The Pro spec-warnings panel is kept in the classic tab that started the run (an
            in-memory map there), so it can only ever show on the classic page. */}
        <p className="hrow-meta" style={{ margin: "6px 0 0" }}>
          <a href={classic(`#/run/${runId}`)}>Open this run in the classic UI</a> (shows the Pro requirements-check panel, for a Pro run started there).
        </p>
      </div>

      <ol id="stages" className="stages">
        {PHASES.map((p) => {
          const v = m.phases[p.key];
          const look = PHASE_LOOK[v.status];
          return (
            <li key={p.key} data-phase={p.key} className={v.status}>
              <div className="phase-header">
                <span className="dot"><Icon name={look.ic} size={look.ic === "check" ? 12 : 11} /></span>
                <span className="label">{p.label}</span>
                <span className={`phase-badge ${look.cls}`}>{look.text}</span>
              </div>
              <p className="phase-desc">{p.desc}</p>
              <p className="summary-text">{v.summary}</p>
              <details className={`output${v.details ? "" : " hidden"}`}>
                <summary><Icon name="code" size={12} /> Technical details</summary>
                <pre>{v.details}</pre>
              </details>
            </li>
          );
        })}
      </ol>

      {m.gate?.visible && (
        <GatePanel key={`${runId}:${m.gate.attempt}`} runId={runId} round={m.gate} notice={m.gateNotice}
          setNotice={(n) => { m.gateNotice = n; bump(); }}
          onDecided={() => { hideGate(m, runId); bump(); }} />
      )}

      {m.progress.visible && (
        <section className="panel suite-progress">
          <h2>Running checks</h2>
          <div className="suite-progress-list">
            {m.progress.items.map((it, i) => (
              <div key={i} className={`suite-progress-item ${it.cls}`} data-case-id={it.caseId}>
                <span className="suite-progress-icon"><Icon name={it.icon} size={14} /></span>
                <span className="suite-progress-label">{it.label}</span>
                <span className="suite-progress-title">{it.title}</span>
                {it.note && <span className="hrow-meta">{it.note}</span>}
              </div>
            ))}
          </div>
        </section>
      )}

      {m.finalVisible && (
        <section id="finalResult">
          {verdict && (
            <h2 id="verdict" className={verdict.cls}>
              <Icon name={verdict.ic} size={20} />
              <span>{verdict.head}{verdict.detail && <span className="verdict-detail">{verdict.detail}</span>}</span>
            </h2>
          )}
          {stopped === 401 && (
            <p className="hrow-meta">
              <a href={classic(`#/run/${runId}`)}>Sign in on the classic UI</a>, then open this run again — both UIs use the same session.
            </p>
          )}
          {t && (test || ir) && (
            <div className="test-summary">
              <h3>{testTitle}</h3>
              <TestSteps runId={runId} test={test} ir={ir} />
              <p>{test?.expected ? `Expected: ${test.expected}` : ""}</p>
            </div>
          )}
          {t && <ResultMedia key={`${t.data?.screenshotUrl ?? ""}|${t.data?.videoUrl ?? ""}`} data={t.data} />}
          <Diagnosis m={m} />
          {t && <a id="traceLink" target="_blank" rel="noreferrer" href={`/runs/${runId}/generated.spec.ts`}>View the test code &amp; files</a>}
          {canSaveRun && (
            <div id="runSaveSlot">
              <button type="button" className="dl-btn" onClick={() => setSaveOpen((o) => !o)}>Save to library</button>
              {saveOpen && <SaveCasePanel runId={runId} caseId="case-0" title={testTitle.trim() || m.prompt || ""} />}
            </div>
          )}
        </section>
      )}

      {suite && (
        <SuiteResults suite={suite} runId={runId} prompt={m.prompt} usageLine={<UsageLine m={m} />}
          canSave={canSaveCase} onZoom={(src, label) => setZoom({ src, label })} />
      )}

      {credOpen && (
        <CredentialPrompt key={credOpen.key} runId={runId} data={credOpen.data}
          onAnswered={() => setCredAnswered(credOpen.key)} />
      )}

      {zoom && <ScreenshotModal src={zoom.src} label={zoom.label} onClose={() => setZoom(null)} />}
    </div>
  );
}

/** The "what ran" list: placeholders at once, then the run's own typed values once results.json
 *  says them (only when a step carries a placeholder). */
function TestSteps({ runId, test, ir }: { runId: string; test: any; ir: any }) {
  const [tokens, setTokens] = useState<any>(null);
  useEffect(() => {
    const hasToken = ir?.steps?.some((s: any) => /\{\{/.test(`${s.value ?? ""}${s.target?.text ?? ""}${s.target?.name ?? ""}`));
    if (!hasToken) return;
    let alive = true;
    authFetch(`/runs/${encodeURIComponent(runId)}/results.json`)
      .then((r) => (r.ok ? r.json() : null))
      .then((res) => { const tk = runTokensOf(res, ir.meta?.title); if (tk && alive) setTokens(tk); })
      .catch(() => {});
    return () => { alive = false; };
  }, [runId, ir]);
  const lines: string[] = ir?.steps?.length ? ir.steps.map((s: any) => readableStep(s, tokens)) : (test?.steps ?? []);
  return <ol>{lines.map((s, i) => <li key={i}>{s}</li>)}</ol>;
}

/** Final screenshot, recording, and the "no video" reason. Keyed by URL by the parent, so a new
 *  run's media is a new element — a <video> never re-reads a changed <source> by itself. */
function ResultMedia({ data }: { data: any }) {
  const [shotOk, setShotOk] = useState(true);
  const shot: string | undefined = data?.screenshotUrl;
  const vid: string | undefined = data?.videoUrl;
  return (
    <>
      {shot && shotOk && (
        <figure>
          <img src={shot} alt="Final state of the page at the end of the test" onError={() => setShotOk(false)} />
          <figcaption>Final state at the end of the test</figcaption>
        </figure>
      )}
      {vid && (
        <figure className="case-video">
          <video controls preload="none" poster={shot || undefined}>
            <source src={vid} type="video/webm" />
          </video>
          <figcaption>Recording of the run — nothing downloads until you press play</figcaption>
        </figure>
      )}
      {!vid && data?.videoUnavailable && <p className="tree-empty">{data.videoUnavailable}</p>}
    </>
  );
}

/** #diagnosis: the enterprise card on a finished run, else the failure_analysis line. */
function Diagnosis({ m }: { m: RunModel }) {
  const t = m.terminal;
  const card = t ? enterpriseDiagnostic(t.data, t.stage, t.error) : null;
  if (card === "clear") return null;
  if (!card) return m.diagnosisText ? <div id="diagnosis">{m.diagnosisText}</div> : null;
  return (
    <div id="diagnosis">
      <div className="diag-card">
        <div className="diag-card-header">
          <span className="diag-badge">What happened</span>
          <h4>{card.headline}</h4>
        </div>
        <div className="diag-card-body">
          <div className="diag-item"><p className="diag-text">{card.description}</p></div>
          {card.fixPrompt && (
            <div className="diag-item diag-fix-box">
              <span className="diag-label fix-label">💡 Try this next time</span>
              <pre className="diag-fix-code">{card.fixPrompt}</pre>
            </div>
          )}
          {card.techDetails && (
            <details className="diag-tech-details">
              <summary>Technical details (for developers)</summary>
              <code>{card.techDetails}</code>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

/** What this run cost, from the terminal event's llmUsage (classic renderUsageLine). */
function UsageLine({ m }: { m: RunModel }) {
  if (m.isReplay) return <div className="hrow-meta">Replayed from saved steps — <b>0 AI calls</b>, no tokens spent.</div>;
  const u = m.usage;
  if (!u || !u.calls) return null;
  const stages = Object.entries<any>(u.byStage ?? {}).sort((a, b) => (b[1].totalTokens ?? 0) - (a[1].totalTokens ?? 0));
  const top = stages[0];
  const healCount = m.primaryHeals + m.suiteHeals;
  return (
    <div className="hrow-meta">
      {u.calls} AI call{u.calls === 1 ? "" : "s"} · {fmtTokens(u.totalTokens ?? 0)} tokens
      {healCount > 0 && <> · <b>{healCount} self-heal retr{healCount === 1 ? "y" : "ies"}</b></>}
      {top && <> · most of it in <b>{top[0]}</b> ({top[1].calls} call{top[1].calls === 1 ? "" : "s"}, {fmtTokens(top[1].totalTokens ?? 0)})</>}
      {u.exhausted && <> · <b>budget exhausted</b></>}
    </div>
  );
}
