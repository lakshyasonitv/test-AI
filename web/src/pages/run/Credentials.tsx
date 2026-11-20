/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Icon } from "./icons";
import { authFetch } from "./model";

/**
 * The credential prompt (public/app.js showCredentialPrompt / submitCredentials): a modal, because
 * the run is parked waiting on it. POSTs {username, password} or {skip: true} to
 * /api/runs/:runId/credentials — exactly the classic bodies.
 *
 * Platform rule 5: the password lives ONLY in this component's state, for the one request. It is
 * never logged, never put in a URL or in storage, and both fields are cleared the moment the request
 * has been sent (and when the prompt closes for any other reason, since unmounting drops the state).
 */
export function CredentialPrompt({ runId, data, onAnswered }: { runId: string; data: any; onAnswered: () => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => { userRef.current?.focus(); }, []);

  const host = (() => { try { return new URL(data?.url).host; } catch { return data?.url ?? "this site"; } })();
  const why = data?.caseEdit
    ? `Checking this edit means signing in to ${host} first — the step you changed is behind the login. ` +
      `Add credentials to verify it, or skip and the check will stop at the login.`
    : `The tests for ${host} need to sign in, and there's no built-in account for it. ` +
      `Add credentials to test the flow past the login, or skip to test only what's reachable without one.`;

  const send = async (body: { username: string; password: string } | { skip: true }) => {
    setBusy(true);
    try {
      await authFetch(`/api/runs/${encodeURIComponent(runId)}/credentials`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
    } catch {
      // The pipeline's own wait timeout is the backstop, so a lost request can't wedge the run.
    }
    // Don't leave the password sitting in state once it's been handed over.
    setUsername("");
    setPassword("");
    setBusy(false);
    onAnswered();
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const u = username.trim();
    // Both or neither: half a login can't authenticate.
    if (!u || !password) return void send({ skip: true });
    void send({ username: u, password });
  };

  return (
    <section className="cred" aria-live="polite" role="dialog" aria-modal="true" aria-label="This site needs a login">
      <div className="cred-card">
        <div className="cred-head">
          <span className="cred-key"><Icon name="key" size={18} /></span>
          <div><h2>This site needs a login</h2></div>
        </div>
        <p className="cred-why">{why}</p>
        <form className="cred-form" onSubmit={onSubmit}>
          <div className="cred-fields">
            <label className="field">
              <span className="field-label">Username or email</span>
              <input ref={userRef} type="text" placeholder="Username or email" autoComplete="off" spellCheck={false}
                value={username} disabled={busy} onChange={(e) => setUsername(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <input type="password" placeholder="Password" autoComplete="off"
                value={password} disabled={busy} onChange={(e) => setPassword(e.target.value)} />
            </label>
          </div>
          <p className="cred-note">Used for this run only. Never written to the run folder or the results history.</p>
          <div className="cred-actions">
            <button type="button" className="cred-skip" disabled={busy} onClick={() => void send({ skip: true })}>Skip — test without logging in</button>
            <button type="submit" disabled={busy}>Use these</button>
          </div>
        </form>
      </div>
    </section>
  );
}
