import { useEffect, useRef, useState } from "react";
import { loadIdentity, type Identity } from "./account/identity";
import { toggleRunOption, useRunOptions } from "./account/runOptions";
import { acctFetch, currentEmail, currentToken, ensureAuth } from "./account/session";
import { Icon } from "./account/Toast";
import { signOut } from "./Login";

/**
 * Settings (#/settings, D-80) and the topbar Settings popover â€” app.js buildSettingsView plus the
 * #gateToggle / #healToggle / #clearWalkCacheBtn handlers. Same ids, classes and requests.
 */

const CLEAR_IDLE = "Forget saved page snapshots used when editing steps";

/** The three "Run behaviour" rows, shared by the page and the popover. */
function RunBehaviourRows() {
  const value = useRunOptions();
  const [note, setNote] = useState(CLEAR_IDLE);
  const [clearing, setClearing] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (resetTimer.current) clearTimeout(resetTimer.current); }, []);

  const clearCache = async () => {
    setClearing(true);
    setNote("Clearingâ€¦");
    try {
      const res = await acctFetch("/api/cache/walks/clear", { method: "POST" });
      const body = await res.json().catch(() => null);
      setNote(res.ok
        ? (body?.message ?? "Cleared.")
        : (res.status === 403 ? "Only an admin can clear the cache." : (body?.error ?? "Could not clear the cache.")));
    } catch {
      setNote("Could not reach the server.");
    } finally {
      setClearing(false);
      if (resetTimer.current) clearTimeout(resetTimer.current);
      resetTimer.current = setTimeout(() => setNote(CLEAR_IDLE), 6000);
    }
  };

  return (
    <>
      <button type="button" className="settings-row" id="gateToggle" aria-pressed={value("gateReview")}
        onClick={() => toggleRunOption("gateReview")}>
        <span className="switch"><span className="switch-knob" /></span>
        <span className="settings-row-text">
          <b>Review cases before running</b>
          <span>Pause to approve the AI&rsquo;s test cases</span>
        </span>
      </button>
      <button type="button" className="settings-row" id="healToggle" aria-pressed={value("selfHeal")}
        onClick={() => toggleRunOption("selfHeal")}>
        <span className="switch"><span className="switch-knob" /></span>
        <span className="settings-row-text">
          <b>Self-heal broken selectors</b>
          <span>Retry once after re-reading the page</span>
        </span>
      </button>
      <button type="button" className="settings-row" id="clearWalkCacheBtn" disabled={clearing} onClick={clearCache}>
        <span className="settings-row-text">
          <b>Clear verification cache</b>
          <span id="clearWalkCacheNote">{note}</span>
        </span>
      </button>
    </>
  );
}

export function SettingsPage() {
  const [auth, setAuth] = useState<{ required: boolean; id: Identity | null }>({ required: false, id: null });

  useEffect(() => {
    let alive = true;
    ensureAuth()
      .then(async (cfg) => {
        const id = cfg.authEnabled && currentToken() ? await loadIdentity() : null;
        if (alive) setAuth({ required: !!cfg.authEnabled, id });
      })
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const signedIn = auth.required && !!currentToken();
  const role = auth.id?.role ?? null;
  const shownRole = auth.id?.platformAdmin ? "admin" : role;

  return (
    <section className="view view-active" data-view="settings" id="view-settings">
      <div className="wide" id="settingsViewBody">
        <div data-dash="head">
          <div>
            <div className="eyebrow">SETTINGS</div>
            <h1 className="page-head-title">Settings</h1>
            <p className="tagline">How your runs behave, and your account.</p>
          </div>
        </div>
        <div data-dash="row">
          <div data-dash="card">
            <div data-dash="card-head"><span data-dash="ico"><Icon name="zap" /></span><h2>Run behaviour</h2></div>
            <div data-set="run"><RunBehaviourRows /></div>
          </div>
          {signedIn && (
            <div data-dash="card" data-set="account">
              <div data-dash="card-head"><span data-dash="ico"><Icon name="key" /></span><h2>Account</h2></div>
              <div data-set="account-slot">
                <span id="sessionBadge" className={`session-badge${role ? "" : " hidden"}`}>
                  <span id="sessionEmail" className="session-email">{auth.id?.email || currentEmail() || ""}</span>
                  <span id="sessionRole" className="session-role">
                    {auth.id?.organisationName ? `${shownRole} Â· ${auth.id.organisationName}` : shownRole}
                  </span>
                </span>
                <button type="button" id="signOutBtn" className="topbar-btn"
                  onClick={async () => { await signOut(); location.reload(); }}>Sign out</button>
              </div>
            </div>
          )}
          {signedIn && !!role && (
            <div data-dash="card" data-set="team">
              <div data-dash="card-head"><span data-dash="ico"><Icon name="list" /></span><h2>Team</h2></div>
              <p className="tagline" style={{ margin: "0 0 12px" }}>Members of your organisation and their roles.</p>
              <div data-set="team-slot">
                <button type="button" id="teamBtn" className="topbar-btn" onClick={() => { location.hash = "#/team"; }}>Team</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}


/**
 * The topbar Settings button and its popover (app.js #settingsBtn / #settingsPop): toggles open,
 * closes on a click outside. The same three rows as the page.
 */
export function SettingsPopover() {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);
  return (
    <span ref={wrap} style={{ position: "relative", display: "inline-block" }}>
      <button type="button" id="settingsBtn" className="topbar-btn" aria-expanded={open} onClick={() => setOpen((o) => !o)}>Settings</button>
      <div id="settingsPop" className={`settings-pop${open ? "" : " hidden"}`}>
        <h2>Run behaviour</h2>
        <RunBehaviourRows />
      </div>
    </span>
  );
}
