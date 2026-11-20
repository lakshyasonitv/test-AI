import { useEffect, useState } from "react";
import { loadIdentity, signOut, type Identity } from "../../lib/identity";
import { currentEmail, currentToken, ensureAuth } from "../../lib/session";
import { RunBehaviourRows } from "../../components/SettingsPopover";
import { Icon } from "../../components/Toast";

/**
 * Settings (#/settings, D-80) — app.js buildSettingsView. The "Run behaviour" rows are shared with
 * the topbar popover (components/SettingsPopover). Same ids, classes and requests.
 */

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
                    {auth.id?.organisationName ? `${shownRole} · ${auth.id.organisationName}` : shownRole}
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
