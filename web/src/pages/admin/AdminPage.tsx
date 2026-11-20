import { useCallback, useEffect, useState } from "react";
import { loadIdentity, plural, type Identity } from "../../lib/identity";
import { acctFetch, jsonBody } from "../../lib/session";
import { switchAdminOrg, type Org } from "../../components/OrgPicker";
import { useToast } from "../../components/Toast";
import { Loading } from "../../components/ui";
import { AdminPeople } from "./components/AdminPeople";

/**
 * Admin (#/admin, D-84, PLATFORM_ADMIN_ENABLED) — app.js renderAdminView / renderAdminPeople /
 * renderAdminChrome. Platform admins only: drawn only when GET /api/health reports
 * `platformAdmins: true` and /api/auth/me reports `platformAdmin`; anyone else is sent to the
 * dashboard, as app.js does. Every action is a route the server checks on its own.
 * The topbar organisation picker lives in components/OrgPicker.
 */

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
