import { useEffect, useRef, useState, type FormEvent } from "react";
import { CredRequest } from "../hooks/useLeaveGuard";

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
