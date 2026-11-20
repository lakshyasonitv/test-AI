import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { api, ApiError, type Project } from "../../lib/api";
import { go } from "../../lib/router";
import { JiraRow } from "./components/JiraRow";
import { proRunWarnings, usePro } from "./hooks/usePro";
import { useSalesforce } from "./hooks/useSalesforce";
import { runOptions as sharedRunOptions, useRunOptions } from "../../lib/runOptions";
import { call, iconSvg, jsonPost, pastedScheme, shortProjectName, stripScheme, TEMPLATES, urlProblem, wantsHttp, type Health, type Scheme } from "./shared";
import { ProBlock } from "./components/ProBlock";
import { ProToggle } from "./components/ProToggle";
import { SalesforceControls } from "./components/SalesforceControls";

/**
 * New test (the classic home view, `#/`): describe a test in plain English, point it at a URL,
 * Run. Ported from public/app.js with the same request bodies, the same validation wording and the
 * same server-flag-driven extras (Salesforce org box and "Sign in as" card, Pro document intake,
 * Jira story fill, "Explore the site again", the Project picker). Every extra exists only when
 * /api/health says its flag is on, exactly as in the classic UI.
 *
 * `const coverage = "standard"` is load-bearing (CLAUDE.md): its control was removed, but the
 * field still ships in POST /api/runs because dropping it would change that route's request shape.
 */
const coverage = "standard";


/** An optional prefill from the address: #/...?url=<url>&prompt=<text> (nothing is stored). */
function hashQuery(): URLSearchParams {
  const i = location.hash.indexOf("?");
  return new URLSearchParams(i >= 0 ? location.hash.slice(i + 1) : "");
}

export function NewTestPage() {
  // ---------------------------------------------------------------- composer fields
  const [prompt, setPrompt] = useState(() => hashQuery().get("prompt") ?? "");
  const [scheme, setSchemeState] = useState<Scheme>("https://");
  const schemeChosen = useRef(false);
  const [url, setUrl] = useState("");
  const [urlError, setUrlError] = useState("");
  const [runError, setRunError] = useState("");
  const [inFlight, setInFlight] = useState(false);
  const urlRef = useRef<HTMLInputElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const pendingCaret = useRef<number | null>(null);

  // ---------------------------------------------------------------- server-driven extras
  const [health, setHealth] = useState<Health | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState("");
  const [projectFresh, setProjectFresh] = useState(false);
  // The header's Settings toggles (one shared store, like the classic popover). Only keys the person
  // toggled are sent; untouched, the server keeps its own configured default.
  useRunOptions();
  const runOptions = sharedRunOptions();

  const setScheme = (s: Scheme, byUser: boolean) => { setSchemeState(s); if (byUser) schemeChosen.current = true; };

  /** Normalise a raw value: split a pasted scheme out to the prefix, strip, auto-http for localhost. */
  const normalize = (raw: string): string => {
    const s = pastedScheme(raw);
    if (s) setScheme(s, true); // an explicit scheme in what they typed or pasted counts as their choice
    const after = stripScheme(raw);
    if (!schemeChosen.current && wantsHttp(after)) setScheme("http://", false);
    return after;
  };
  const absoluteUrl = scheme + stripScheme(url);

  // Prefill from the address, as a project's "New test" button would.
  useEffect(() => {
    const u = hashQuery().get("url");
    if (u) setUrl(normalize(u));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api<Health>("/api/health").then((h) => setHealth(h ?? {})).catch(() => setHealth({}));
    api<{ authEnabled?: boolean }>("/api/auth/config").then((c) => setAuthRequired(!!c?.authEnabled)).catch(() => {});
  }, []);

  const platformModel = health?.platformAdmins === true;
  const showPicker = platformModel && authRequired;
  useEffect(() => {
    if (!showPicker) return;
    call<{ projects?: Project[] }>("/api/projects")
      .then((d) => setProjects(Array.isArray(d?.projects) ? d.projects : []))
      .catch(() => setProjects([]));
  }, [showPicker]);

  const sf = useSalesforce({
    targetApp: Array.isArray(health?.targetApps) && health!.targetApps!.includes("salesforce"),
    oauth: health?.salesforceOAuth === true,
    approvals: health?.sfApprovals === true,
    discoveryCache: health?.sfDiscoveryCache === true,
  }, url, absoluteUrl);
  const pro = usePro(prompt, setPrompt);

  // Keep the caret where the person left it after the scheme is stripped out of the value.
  useLayoutEffect(() => {
    const pos = pendingCaret.current;
    pendingCaret.current = null;
    const el = urlRef.current;
    if (pos != null && el && document.activeElement === el) el.setSelectionRange(pos, pos);
  }, [url]);

  // ---------------------------------------------------------------- URL field events

  // Typing never blocks or rejects: the value is only normalised and any error is cleared.
  const onUrlChange = (e: ChangeEvent<HTMLInputElement>) => {
    const before = e.target.value;
    const caret = e.target.selectionStart ?? before.length;
    const after = normalize(before);
    if (after !== before) pendingCaret.current = Math.min(stripScheme(before.slice(0, caret)).length, after.length);
    setUrl(after);
    setUrlError("");
  };

  // Validate on blur, the first moment the person has finished a thought — never while typing.
  const onUrlBlur = () => {
    const v = normalize(url);
    if (v !== url) setUrl(v);
    setUrlError(v.trim() ? urlProblem(v) : "");
  };

  const toggleScheme = () => setScheme(scheme === "https://" ? "http://" : "https://", true);

  const pickProject = (id: string) => {
    setProjectId(id);
    const p = projects.find((x) => x.id === id);
    if (p?.baseUrl) { setUrl(normalize(p.baseUrl.replace(/^https?:\/\//i, ""))); setUrlError(""); }
  };

  // ---------------------------------------------------------------- submit

  const ready = prompt.trim().length > 0 && url.trim().length > 0;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const text = prompt.trim();
    if (!text || inFlight) return;
    const problem = urlProblem(url);
    if (problem) { setUrlError(problem); urlRef.current?.focus(); return; }
    setUrlError("");

    // Pro on with nothing confirmed: not started, and the Pro block says why. Pro off: null.
    const proOptions = pro.runOptions();
    if (proOptions === false) return;

    setRunError("");
    setInFlight(true);
    const conn = sf.conn;
    const sfOn = sf.flags.targetApp && sf.targetChecked;
    const baseOptions0 = sfOn
      ? {
        ...runOptions, targetApp: "salesforce",
        ...(conn ? { sfConnectionId: conn.id } : {}),
        ...(conn && sf.flags.approvals && sf.approverId && sf.approverId !== conn.id ? { sfApproverConnectionId: sf.approverId } : {}),
        ...(conn && sf.flags.discoveryCache && sf.flags.oauth ? { freshDiscovery: sf.freshDiscovery } : {}),
      }
      : runOptions;
    // D-72: "Explore the site again" adds `freshDiscovery` for this run only, never on an org-connection run.
    const freshBox = health?.projectDiscovery === true;
    const baseOptions = freshBox && projectFresh && !(sfOn && conn) ? { ...baseOptions0, freshDiscovery: true } : baseOptions0;
    if (freshBox) setProjectFresh(false);

    try {
      const { runId } = await call<{ runId?: string }>("/api/runs", jsonPost({
        prompt: text, url: absoluteUrl, coverage,
        options: proOptions ? { ...baseOptions, ...proOptions } : baseOptions,
        // D-84: the project picked on New test; POST /api/runs already accepts an optional projectId.
        ...(platformModel && projectId ? { projectId } : {}),
      }));
      if (!runId) throw new Error("Server didn't return a run id");
      // The run screen's warnings panel starts with everything intake already said.
      if (proOptions) proRunWarnings.set(runId, { warnings: [...pro.warnings], done: false });
      setInFlight(false);
      go("#/run/" + runId);
    } catch (err) {
      // TD-166: the server forgot the org connection (it restarted), so stop showing "Connected".
      if (err instanceof ApiError && err.code === "sf-connection-expired" && sf.flags.oauth) sf.expired();
      setInFlight(false);
      setRunError(err instanceof Error ? err.message : "The server didn't accept the request. Try again.");
    }
  };

  // ---------------------------------------------------------------- view

  return (
    <section className="view view-active" data-view="home" id="view-home">
      <div className="col">
        <header className="page-head">
          <h1>What should we test today?</h1>
          <p className="tagline">
            Describe it in plain English and point it at a URL — or run the cases this project already has.
          </p>
        </header>

        <>
          {health?.jira === true && <JiraRow setPrompt={setPrompt} />}

          <form id="runForm" className="composer" onSubmit={submit}>
            <textarea id="prompt" rows={3} ref={promptRef} value={prompt} onChange={(e) => setPrompt(e.target.value)}
              placeholder="Check that a guest can add a product to the cart, apply the promo code SPRING24, and reach the payment step without signing in." />

            <div className="composer-foot">
              {showPicker && (
                <label className="field" id="projectPickerWrap">
                  <span className="field-label">Project</span>
                  <select id="projectPicker" className="team-select" aria-label="Project to test in" value={projectId}
                    onChange={(e) => pickProject(e.target.value)}>
                    <option value="">Choose a project…</option>
                    {projects.map((p) => <option key={p.id} value={p.id}>{shortProjectName(p.name)}</option>)}
                  </select>
                </label>
              )}

              <label className="field field-url">
                {/* preventDefault: it sits inside a <label>, which would otherwise forward the click to the input. */}
                <span className="field-label" id="urlScheme" role="button" tabIndex={0}
                  title="Click to switch between https:// and http://"
                  onClick={(e) => { e.preventDefault(); toggleScheme(); urlRef.current?.focus(); }}
                  onKeyDown={(e) => { if (e.key !== "Enter" && e.key !== " ") return; e.preventDefault(); toggleScheme(); }}>
                  {scheme}
                </span>
                <span className="input-wrap">
                  <input id="url" type="text" placeholder="example.com/page" ref={urlRef} value={url}
                    aria-describedby="urlError" aria-invalid={urlError ? true : undefined}
                    autoComplete="off" spellCheck={false} onChange={onUrlChange} onBlur={onUrlBlur} />
                </span>
              </label>

              <button type="submit" className="run-btn" disabled={!ready || inFlight}>
                <span id="runIcon" dangerouslySetInnerHTML={{ __html: iconSvg(inFlight ? "loader" : "play") }} />{" "}
                <span className="run-btn-text">{inFlight ? "Running…" : "Run test"}</span>
              </button>
            </div>

            <SalesforceControls sf={sf} />
            {health?.specIntake === true && <ProToggle pro={pro} />}
            {health?.projectDiscovery === true && (
              <label className="field-label" style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 10, cursor: "pointer" }}>
                <input type="checkbox" className="lib-check" id="projectFreshDiscovery" checked={projectFresh}
                  onChange={(e) => setProjectFresh(e.target.checked)} /> Explore the site again{" "}
                <span style={{ opacity: 0.7 }}>(ignore this project's saved discovery, for the next run only)</span>
              </label>
            )}

            <p id="urlError" className={`team-error${urlError ? "" : " hidden"}`} role="alert" aria-live="polite">{urlError}</p>
          </form>

          {health?.specIntake === true && pro.on && <ProBlock pro={pro} />}
        </>

        {runError && (
          <p className="team-error" role="alert"><b>Couldn't start the run.</b> {runError}</p>
        )}

        <div className="templates-row">
          <span className="templates-label">Try one of these</span>
          <div id="templates" className="templates">
            {TEMPLATES.map((t) => (
              <button type="button" className="template-btn" key={t.label} onClick={() => setPrompt(t.prompt)}>{t.label}</button>
            ))}
          </div>
        </div>

      </div>
    </section>
  );
}
