import { useCallback, useEffect, useState } from "react";
import { loadHealth, loadIdentity, plural, type Identity } from "./account/identity";
import { acctFetch, jsonBody, setAdminOrgId } from "./account/session";
import { useToast } from "./account/Toast";
import { Loading } from "../ui";

/**
 * Admin (#/admin, D-84, PLATFORM_ADMIN_ENABLED) — app.js renderAdminView / renderAdminPeople /
 * renderAdminChrome / switchAdminOrg. Platform admins only: drawn only when GET /api/health reports
 * `platformAdmins: true` and /api/auth/me reports `platformAdmin`; anyone else is sent to the
 * dashboard, as app.js does. Every action is a route the server checks on its own.
 */

interface Org { id: string; name: string; members: number; projects: number }
interface Member { userId: string; email?: string | null; role: string }

/** app.js switchAdminOrg: remember the organisation for this tab, then load everything again. */
export function switchAdminOrg(orgId: string | null): void {
  setAdminOrgId(orgId || null);
  location.hash = "#/dashboard";
  location.reload();
}

/**
 * The topbar organisation picker (app.js #orgPicker), platform admins only; renders nothing for
 * anyone else, while the platform-admin model is off, or when there are no organisations.
 */
export function OrgPicker() {
  const [state, setState] = useState<{ orgs: Org[]; current: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const [health, me] = await Promise.all([loadHealth(), loadIdentity().catch(() => null)]);
      if (!health.platformAdmins || !me?.platformAdmin) return;
      const res = await acctFetch("/api/admin/organisations").then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const orgs: Org[] = res && Array.isArray(res.organisations) ? res.organisations : [];
      if (alive && orgs.length) setState({ orgs, current: me.organisationId });
    })();
    return () => { alive = false; };
  }, []);
  if (!state) return null;
  return (
    <select id="orgPicker" className="team-select" aria-label="Organisation you are working in" title="Organisation you are working in"
      defaultValue={state.current ?? undefined} onChange={(e) => switchAdminOrg(e.target.value)}>
      {state.orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
    </select>
  );
}

export function AdminPage() {
  const [me, setMe] = useState<Identity | null>(null);
  const [orgs, setOrgs] = useState<Org[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [openOrg, setOpenOrg] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [orgMsg, setOrgMsg] = useState("");
  const [gen, setGen] = useState(0);
  const [toast, toastEl] = useToast();

  const render = useCallback(async () => {
    setOrgs(null);
    const res = await acctFetch("/api/admin/organisations").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    setFailed(!res);
    setOrgs(res && Array.isArray(res.organisations) ? res.organisations : []);
    setGen((g) => g + 1);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      const id = await loadIdentity().catch(() => null);
      if (!alive) return;
      // As app.js: only once who-you-are is known, a non-admin goes to the dashboard. The server
      // refuses anyone else regardless (with the model off, the list simply fails to load).
      if (id?.role && !id.platformAdmin) { location.hash = "#/dashboard"; return; }
      setMe(id);
      await render();
    })();
    return () => { alive = false; };
  }, [render]);

  const create = async () => {
    const n = name.trim();
    if (!n) { setOrgMsg("Enter the company's name."); return; }
    const r = await acctFetch("/api/admin/organisations", jsonBody("POST", { name: n }));
    const out = await r.json().catch(() => ({}));
    if (!r.ok) { setOrgMsg(out.error || "That didn't work."); return; }
    setOpenOrg(out.id);
    toast(`${out.name} created. Add its first owner below.`);
    setName("");
    setOrgMsg("");
    await render();
  };

  return (
    <section className="view view-active" data-view="admin" id="view-admin">
      <div className="wide" id="adminViewBody">
        {orgs === null ? (
          <div className="tree-empty" style={{ padding: "24px 4px" }}><Loading /></div>
        ) : (
          <>
            <div data-dash="head">
              <div>
                <div className="eyebrow">ADMIN</div>
                <h1 className="page-head-title">Organisations</h1>
                <p className="tagline">Every company on this Testbench. Create one, add its people, or work inside it.</p>
              </div>
            </div>
            <div data-dash="card">
              <div data-dash="card-head"><h2>New organisation</h2></div>
              <div data-dash="form">
                <input type="text" className="project-form-input" data-adm="org-name" placeholder="Company name" aria-label="Company name"
                  value={name} onChange={(e) => setName(e.target.value)} />
                <button type="button" className="run-btn" data-adm-act="org-create" onClick={() => void create()}>Create</button>
              </div>
              <div className="hrow-meta" data-adm="org-msg" aria-live="polite">{orgMsg}</div>
            </div>
            <div data-dash="card">
              <div data-dash="card-head"><h2>{plural(orgs.length, "organisation")}</h2></div>
              {orgs.length ? orgs.map((o) => (
                <div key={o.id}>
                  <div className="hrow" data-adm-org={o.id}>
                    <div className="hrow-main">
                      <div className="hrow-label">{o.name}
                        {o.id === me?.organisationId && <> <span className="case-badge badge-passed">working in</span></>}</div>
                      <div className="hrow-meta">{`${plural(o.members, "user")} · ${plural(o.projects, "project")}`}</div>
                    </div>
                    <div className="hrow-actions">
                      <button type="button" className="dl-btn-inline" data-adm-act="people"
                        onClick={() => setOpenOrg((cur) => (cur === o.id ? null : o.id))}>People</button>
                      <button type="button" className="dl-btn-inline" data-adm-act="open" onClick={() => switchAdminOrg(o.id)}>Work in this</button>
                    </div>
                  </div>
                  {openOrg === o.id && (
                    <AdminPeople key={`${o.id}:${gen}`} orgId={o.id} toast={toast} onChanged={() => void render()} />
                  )}
                </div>
              )) : (
                <div className="tree-empty" style={{ padding: "22px 16px", textAlign: "center" }}>
                  {failed ? "Couldn't load the organisations." : "No organisations yet. Create the first one above."}
                </div>
              )}
            </div>
          </>
        )}
      </div>
      {toastEl}
    </section>
  );
}

const ADMIN_ROLES = ["owner", "tester", "viewer"];

/** One organisation's people: who is in it, New user, and Move an existing account here. */
function AdminPeople({ orgId, toast, onChanged }: { orgId: string; toast: (m: string) => void; onChanged: () => void }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [msg, setMsg] = useState("");
  const [uEmail, setUEmail] = useState("");
  const [uPass, setUPass] = useState("");
  const [uRole, setURole] = useState("owner");
  const [mEmail, setMEmail] = useState("");
  const [mRole, setMRole] = useState("tester");
  const q = encodeURIComponent(orgId);

  useEffect(() => {
    let alive = true;
    acctFetch(`/api/organisations/${q}/members`).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      .then((res) => { if (alive) setMembers(res && Array.isArray(res.members) ? res.members : []); });
    return () => { alive = false; };
  }, [q]);

  const call = async (url: string, payload: unknown, ok: (o: { email?: string; role?: string }) => string) => {
    const r = await acctFetch(url, jsonBody("POST", payload));
    const out = await r.json().catch(() => ({}));
    if (!r.ok) { setMsg(out.error || "That didn't work."); return; }
    toast(ok(out));
    onChanged();
  };

  const remove = async (m: Member) => {
    const who = m.email || "this person";
    if (!confirm(`Remove ${who} from this organisation? They will no longer see anything in it.`)) return;
    const r = await acctFetch(`/api/organisations/${q}/members/${encodeURIComponent(m.userId)}`, { method: "DELETE" });
    if (!r.ok) { const out = await r.json().catch(() => ({})); setMsg(out.error || "That didn't work."); return; }
    toast(`${who} removed.`);
    onChanged();
  };

  const createUser = () => {
    const email = uEmail.trim();
    if (!email) { setMsg("Enter the new user's email."); return; }
    if (uPass.length < 8) { setMsg("The password needs at least 8 characters."); return; }
    void call(`/api/organisations/${q}/users`, { email, password: uPass, role: uRole },
      (o) => `${o.email} created as ${o.role}. Give them their email and password to sign in.`);
  };

  const moveUser = () => {
    const email = mEmail.trim();
    if (!email) { setMsg("Enter the account's email."); return; }
    if (!confirm(`Move ${email} into this organisation as ${mRole}? They leave any other organisation.`)) return;
    void call(`/api/admin/organisations/${q}/move-user`, { email, role: mRole }, (o) => `${o.email} moved here as ${o.role}.`);
  };

  return (
    <div data-adm-people={orgId} style={{ margin: "0 0 10px 14px" }}>
      {members === null ? (
        <div className="tree-empty" style={{ padding: "12px 4px" }}><Loading /></div>
      ) : (
        <>
          {members.length ? members.map((m) => (
            <div className="hrow" key={m.userId}>
              <div className="hrow-main"><div className="hrow-label">{m.email || "(unknown address)"}</div></div>
              <span className="case-badge badge-pending">{m.role === "admin" ? "owner" : m.role}</span>
              <div className="hrow-actions">
                <button type="button" className="dl-btn-inline hrow-del" onClick={() => void remove(m)}>Remove</button>
              </div>
            </div>
          )) : <div className="hrow-meta" style={{ padding: "6px 0" }}>Nobody here yet.</div>}
          <div className="hrow-meta" style={{ margin: "12px 0 4px" }}>New user in this organisation</div>
          <div data-dash="form">
            <input type="email" className="project-form-input" data-adm="u-email" placeholder="name@company.com" aria-label="New user's email"
              autoComplete="off" value={uEmail} onChange={(e) => setUEmail(e.target.value)} />
            <input type="password" className="project-form-input" data-adm="u-pass" placeholder="Password (8+ characters)" aria-label="New user's password"
              autoComplete="new-password" value={uPass} onChange={(e) => setUPass(e.target.value)} />
            <select className="team-select" data-adm="u-role" aria-label="New user's role" value={uRole} onChange={(e) => setURole(e.target.value)}>
              {ADMIN_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button type="button" className="dl-btn" data-adm-act="u-create" onClick={createUser}>Create user</button>
          </div>
          <div className="hrow-meta" style={{ margin: "12px 0 4px" }}>Move an existing account here (takes it out of any other organisation)</div>
          <div data-dash="form">
            <input type="email" className="project-form-input" data-adm="m-email" placeholder="their@email.com" aria-label="Account to move"
              autoComplete="off" value={mEmail} onChange={(e) => setMEmail(e.target.value)} />
            <select className="team-select" data-adm="m-role" aria-label="Role after the move" value={mRole} onChange={(e) => setMRole(e.target.value)}>
              {ADMIN_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
            <button type="button" className="dl-btn" data-adm-act="u-move" onClick={moveUser}>Move here</button>
          </div>
          <div className="hrow-meta" data-adm="p-msg" aria-live="polite" style={{ marginTop: 6 }}>{msg}</div>
        </>
      )}
    </div>
  );
}
