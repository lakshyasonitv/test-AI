import { useEffect, useRef, useState, type FormEvent } from "react";
import { parseRoute } from "../../router";

/** The rotating loader the AI buttons use (`.ai-busy` lays it out, `.ai-spin` turns it). */
export function Spin({ size = 13 }: { size?: number }) {
  return (
    <svg className="ai-spin" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
      <path d="M12 3a9 9 0 1 0 9 9" strokeLinecap="round" />
    </svg>
  );
}

export interface CredRequest { jobId: string; data: { url?: string; caseEdit?: boolean } | undefined; postUrl: string }

/**
 * The credential modal a re-ground parks on (same markup and classes as the classic
 * #credentialPrompt). The username and password live only in this component's state for the
 * moment it is open, are POSTed to the job, and are cleared on close — never stored anywhere.
 */
export function CredentialPrompt({ req, onClose }: { req: CredRequest; onClose: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [sending, setSending] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);
  useEffect(() => { userRef.current?.focus(); }, []);

  const host = (() => { try { return new URL(String(req.data?.url)).host; } catch { return req.data?.url ?? "this site"; } })();
  const why = req.data?.caseEdit
    ? `Checking this edit means signing in to ${host} first — the step you changed is behind the login. ` +
      `Add credentials to verify it, or skip and the check will stop at the login.`
    : `The tests for ${host} need to sign in, and there's no built-in account for it. ` +
      `Add credentials to test the flow past the login, or skip to test only what's reachable without one.`;

  const submit = async (body: object) => {
    setSending(true);
    try {
      await fetch(req.postUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    } catch { /* the server's own wait timeout is the backstop */ }
    setUsername(""); setPassword("");
    onClose();
  };
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const u = username.trim();
    // Both or neither: half a login can't authenticate.
    if (!u || !password) return void submit({ skip: true });
    void submit({ username: u, password });
  };

  return (
    <section className="cred" aria-live="polite" role="dialog" aria-modal="true" aria-label="This site needs a login">
      <div className="cred-card">
        <div className="cred-head"><div><h2>This site needs a login</h2></div></div>
        <p className="cred-why">{why}</p>
        <form className="cred-form" onSubmit={onSubmit}>
          <div className="cred-fields">
            <label className="field">
              <span className="field-label">Username or email</span>
              <input ref={userRef} type="text" placeholder="Username or email" autoComplete="off" spellCheck={false}
                value={username} disabled={sending} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <input type="password" placeholder="Password" autoComplete="off"
                value={password} disabled={sending} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </div>
          <p className="cred-note">Used for this run only. Never written to the run folder or the results history.</p>
          <div className="cred-actions">
            <button type="button" className="cred-skip" disabled={sending} onClick={() => void submit({ skip: true })}>Skip — test without logging in</button>
            <button type="submit" disabled={sending}>Use these</button>
          </div>
        </form>
      </div>
    </section>
  );
}

/**
 * The classic applyRoute guard: leaving this case with unsaved step edits asks first, and saying
 * no puts the previous hash back. Listens in the CAPTURE phase so it runs before the app router's
 * own hashchange listener and can stop it — otherwise the page would unmount (losing the edits)
 * before the answer. Also the browser's beforeunload guard for reload / close / external links.
 * `bypass` lets Duplicate and Delete leave without asking, as app.js drops its editor first.
 */
export function useLeaveGuard(caseId: string, dirty: () => boolean, bypass: { current: boolean }) {
  useEffect(() => {
    let last = location.hash;
    let restoring = false;
    const staysOnCase = (hash: string) => { const r = parseRoute(hash); return r.name === "case" && r.caseId === caseId; };
    const onHash = (e: HashChangeEvent) => {
      if (restoring) { restoring = false; last = location.hash; return; }
      if (!bypass.current && dirty() && !staysOnCase(location.hash)) {
        if (!confirm("You have unsaved step changes. Leave and discard them?")) {
          e.stopImmediatePropagation();
          if (location.hash !== last) { restoring = true; location.hash = last; }
          return;
        }
      }
      last = location.hash;
    };
    const onUnload = (e: BeforeUnloadEvent) => {
      if (bypass.current || !dirty()) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("hashchange", onHash, true);
    window.addEventListener("beforeunload", onUnload);
    return () => {
      window.removeEventListener("hashchange", onHash, true);
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [caseId, dirty, bypass]);
}
