import { useEffect, useState, type FormEvent } from "react";
import { clearIdentity, loadIdentity, SessionRejected } from "./account/identity";
import { ensureAuth, setSession, signOutSession, takeLoginMessage } from "./account/session";

/**
 * The Sign in / Create an account screens (view-login / view-signup) — app.js initAuth's two form
 * handlers. Sign-in goes straight to Supabase's REST token endpoint with the publishable key from
 * GET /api/auth/config (plain fetch, no supabase-js, as app.js); sign-up goes to this server's
 * POST /api/auth/signup. The session is stored by setSession exactly as app.js stores it.
 *
 * The password lives only in this component's state until the request is sent, and is cleared
 * straight after a successful sign-in. It is never logged or written anywhere.
 */

/** app.js afterSignInHash (dashboard on, as it always is since D-83). */
function afterSignInHash(): string {
  const h = location.hash;
  return h && h !== "#" && h !== "#/" ? h : "#/dashboard";
}

/** Sign out: clear the session and cookie, revoke at Supabase (best effort). The caller redraws. */
export async function signOut(): Promise<void> {
  clearIdentity();
  await signOutSession();
}

export function LoginPage({ mode, onSignedIn }: { mode: "login" | "signup"; onSignedIn: () => void }) {
  const [screen, setScreen] = useState<"login" | "signup">(mode);
  useEffect(() => { setScreen(mode); }, [mode]);

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(() => takeLoginMessage());
  const [busy, setBusy] = useState(false);

  const [suEmail, setSuEmail] = useState("");
  const [suPassword, setSuPassword] = useState("");
  const [suError, setSuError] = useState<string | null>(null);
  const [suBusy, setSuBusy] = useState(false);

  /** After either form: resolve who this is (bootstrap + me), then land where app.js lands. */
  const finish = async (): Promise<boolean> => {
    try {
      await loadIdentity(true);
    } catch (err) {
      if (err instanceof SessionRejected) {
        takeLoginMessage();
        setScreen("login");
        setError(err.message);
        return false;
      }
    }
    location.hash = afterSignInHash();
    onSignedIn();
    return true;
  };

  const onLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const cfg = await ensureAuth();
      const res = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: String(cfg.publishableKey ?? "") },
        body: JSON.stringify({ email, password }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.access_token) {
        throw new Error(body.error_description || body.msg || "Could not sign in.");
      }
      setSession(body.access_token, body.user && body.user.email,
        { refreshToken: body.refresh_token, expiresAt: body.expires_at });
      setPassword("");
      await finish();
    } catch (err) {
      setError((err instanceof Error && err.message) || "Could not sign in.");
    } finally {
      setBusy(false);
    }
  };

  const onSignup = async (e: FormEvent) => {
    e.preventDefault();
    setSuError(null);
    const addr = suEmail.trim();
    // Client-side checks are UX only — Supabase validates both again server-side.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) { setSuError("Enter a valid email address."); return; }
    if (suPassword.length < 8) { setSuError("Password must be at least 8 characters."); return; }
    setSuBusy(true);
    try {
      await ensureAuth();
      const res = await fetch("/api/auth/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: addr, password: suPassword }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.accessToken) throw new Error(body.error || "Could not create the account.");
      setSession(body.accessToken, (body.user && body.user.email) || addr, { refreshToken: body.refreshToken });
      setSuPassword("");
      await finish();
    } catch (err) {
      setSuError((err instanceof Error && err.message) || "Could not create the account.");
    } finally {
      setSuBusy(false);
    }
  };

  if (screen === "signup") {
    return (
      <section className="view view-active" data-view="signup" id="view-signup">
        <div className="col">
          <header className="page-head">
            <h1>Create an account</h1>
            <p className="tagline">You&rsquo;ll own a new workspace of your own.</p>
          </header>
          <form id="signupForm" className="auth-card" noValidate onSubmit={onSignup}>
            <label className="field">
              <span className="field-label">Email</span>
              <input id="signupEmail" type="email" autoComplete="username" placeholder="you@example.com" required
                value={suEmail} onChange={(e) => setSuEmail(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <input id="signupPassword" type="password" autoComplete="new-password" placeholder="At least 8 characters"
                minLength={8} required value={suPassword} onChange={(e) => setSuPassword(e.target.value)} />
            </label>
            <p id="signupError" className={`auth-error${suError ? "" : " hidden"}`} role="alert">{suError ?? ""}</p>
            <button type="submit" id="signupSubmit" className="run-btn" disabled={suBusy}>
              {suBusy ? "Creating account…" : "Create account"}
            </button>
            <p className="auth-switch">
              Already have an account?{" "}
              <button type="button" id="goLogin" className="auth-switch-btn"
                onClick={() => { setSuError(null); setScreen("login"); }}>Sign in</button>
            </p>
          </form>
        </div>
      </section>
    );
  }

  return (
    <section className="view view-active" data-view="login" id="view-login">
      <div className="col">
        <header className="page-head">
          <h1>Sign in</h1>
          <p className="tagline">This Testbench requires an account.</p>
        </header>
        <form id="loginForm" className="auth-card" onSubmit={onLogin}>
          <label className="field">
            <span className="field-label">Email</span>
            <input id="loginEmail" type="email" autoComplete="username" placeholder="you@example.com" required
              value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="field">
            <span className="field-label">Password</span>
            <input id="loginPassword" type="password" autoComplete="current-password" placeholder="Password" required
              value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <p id="loginError" className={`auth-error${error ? "" : " hidden"}`} role="alert">{error ?? ""}</p>
          <button type="submit" id="loginSubmit" className="run-btn" disabled={busy}>{busy ? "Signing in…" : "Sign in"}</button>
        </form>
      </div>
    </section>
  );
}
